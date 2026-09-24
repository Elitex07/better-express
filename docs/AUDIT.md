# BareWeb code audit & performance review

_Audit date: 2026-09-24 · Node.js v22 · 4 vCPU sandbox_

## 1. What BareWeb is and how it works

BareWeb is a zero-dependency, Express-style HTTP framework on top of `node:http`.

| Layer | File | Role |
| --- | --- | --- |
| App | `src/app.js` | `createApp()`, `use()`, method helpers, `handle(req, res)` dispatcher, `listen()` |
| Router | `src/router.js` | Keeps a registration-ordered `stack` of middlewares + routes, one `Trie` per HTTP method, sub-router mounting |
| Trie | `src/trie.js` | Segment trie: static > `:param` > `*wildcard`, backtracking visits each node at most once |
| Request | `src/request.js` | `req.params/query/cookies/ip/...`, streaming body readers with size limits |
| Response | `src/response.js` | `res.status/json/send/html/redirect/cookie/sendFile` |
| Middleware | `src/middleware.js` | Pipeline runner, default error handler, `cors`, `serveStatic`, `json`, `urlencoded` |

Request flow: `handle()` → parse URL → `router.resolve(method, path)` builds the ordered
pipeline (matching middlewares + matched route handlers, plus error handlers) →
`runPipeline()` walks it with `next()`; errors go to 4-arity handlers, then
`defaultErrorHandler`; if nothing matched, a JSON 404 is sent.

## 2. Findings (before this change)

### Performance

| # | Finding | Impact |
| --- | --- | --- |
| P1 | `decorateRequest`/`decorateResponse` attached ~25 fresh closures plus an `Object.defineProperty` to **every** request/response | Allocation + GC churn, unstable hidden classes; the single biggest cost |
| P2 | `new URL(req.url, 'http://' + host)` on every request, and eager `URLSearchParams` + query object even when unused | WHATWG URL parsing is expensive on the hot path |
| P3 | `router.resolve()` scanned the **whole** stack (every middleware *and every route of every method*) per request, and allocated a `Set` | O(total routes) per request — defeats the trie |
| P4 | `next` was `async`, so every hop allocated a promise; `req.params` was re-spread per pipeline item | Extra microtasks and objects |
| P5 | Eager `x-forwarded-for` split, `ip`/`protocol`/`xhr` computed even when never read | Wasted work |
| P6 | Benchmark ran autocannon **in the same process** as both servers | Load generator and servers shared one event loop — results unreliable |

### Correctness & security

| # | Finding | Severity |
| --- | --- | --- |
| S1 | `req.ip` / `req.protocol` trusted `X-Forwarded-For` / `X-Forwarded-Proto` unconditionally | **High** — any client can spoof its IP (breaks rate limiting / audit logs) and fake HTTPS |
| S2 | `Trie.search()` wrote per-request params onto the shared route object (`routeEntry.params = ...`) | Medium — shared mutable state across requests; only safe by accident of synchronous reads |
| S3 | `defaultErrorHandler` used `err.status` blindly (`'abc'`/`200` → `RangeError` or bogus status) and leaked 5xx messages in production | Medium |
| S4 | `sendFile` used `stream.pipe(res)`: a client disconnect left the file stream open | Medium — file-descriptor leak under aborted downloads |
| S5 | `sendFile` 404 body contained the absolute server path | Low — information disclosure |
| S6 | `cors({ credentials: true })` sent `Access-Control-Allow-Origin: *` (browsers reject that combination); no allow-list or `Vary: Origin` | Medium — feature did not work, caching hazards |
| S7 | `parseQuery` accepted a `__proto__` key | Low — prototype-shaped keys on `req.query` |
| S8 | `serveStatic` could not serve percent-encoded names (`my%20file.txt`) and rejected any URL containing `..` anywhere (e.g. `a..b.txt`) | Low — functional bugs |
| S9 | No `HEAD` → `GET` fallback (Express does this automatically) | Low |
| S10 | `json()` only matched `application/json`, not `application/*+json`; it keyed off the method instead of body presence | Low |
| S11 | `listen()` forced `0.0.0.0` (IPv4 only) | Low |
| S12 | `//evil` request targets were parsed by `new URL()` as a *host*, turning the path into `/` | Low — surprising routing |
| S13 | `MiddlewareStack` duplicated the whole dispatch loop but was unused by the app | Maintainability |
| S14 | README linked to a local Windows path and a non-existent `ROADMAP.md` | Docs |

## 3. What changed

- **Prototype-based req/res (P1, P5).** `BareRequest extends http.IncomingMessage` and
  `BareResponse extends http.ServerResponse`; `listen()` passes them to
  `http.createServer({ IncomingMessage, ServerResponse })`, so helpers cost nothing per
  request. `query`, `searchParams`, `cookies`, `ip`, `protocol`, `hostname`, `xhr` are lazy
  getters (still assignable). Foreign req/res (e.g. `http.createServer(app.handle)`) get a
  one-time prototype swap, as Express does.
- **No `new URL()` on the hot path (P2, S12).** `parseUrl()` splits on `?`; it only falls back
  to `URL` for targets that need normalization (`/.`, `\`, absolute-form). Host is validated with
  a cheap RFC 3986 regex, keeping the existing `400 Malformed Host or URL` behaviour.
- **Router resolution is O(segments + middlewares) (P3, S2).** Middlewares are kept in their own
  list; the trie returns the matched routes (with their own, per-request params) and the two are
  merged by registration id — registration order is preserved exactly. Fully static routes are
  also indexed in a `Map` for a single hash lookup. `HEAD` falls back to `GET` (S9).
- **Leaner pipeline (P4).** Shared `runPipeline()` with a synchronous `next()` that returns the
  downstream promise, so `await next()` still waits for async handlers. `MiddlewareStack` now
  delegates to it (S13).
- **Security/correctness fixes.** `trustProxy` app option, default **off** (S1); validated status
  codes + production-safe messages, and a socket abort when headers were already sent (S3);
  `stream.pipeline` in `sendFile`, `Last-Modified`, HEAD support, no path in 404 body (S4, S5);
  CORS allow-list / RegExp / function / reflect, `Vary: Origin`, credentials-safe (S6);
  `__proto__` query and cookie keys dropped (S7); `serveStatic` decodes the path, rejects `..`
  *segments* after decoding and answers `If-Modified-Since` with 304 (S8); `+json` types and
  body-presence detection in parsers, early 413 from `Content-Length` (S10); dual-stack
  `listen()` by default (S11).
- **Benchmark harness (P6).** Each server runs in its own child process; six scenarios; raw
  `node:http` baseline; optional Next.js target via `NEXT_URL`; `BENCH_WORKERS` for
  multi-threaded load generation.

Tests: 40 existing tests pass unchanged; `test/hardening.test.js` adds 14 tests for the new
behaviour.

## 4. Benchmarks

`npm run benchmark` — 3 trials × 5 s, 2 s warm-up, 50 connections, single autocannon thread,
every server in its own process. Requests/second (mean).

| Scenario | node:http (ref.) | Express 4.21 | BareWeb **before** | BareWeb **after** | Next.js 16 route handler |
| --- | ---: | ---: | ---: | ---: | ---: |
| Static route `GET /test` | ~60,400 | 12,677 | 23,715 | **41,855** | 1,527 |
| Param route `GET /users/:id` | ~65,300 | 11,733 | 23,045 | **40,775** | 1,397 |
| 5 middlewares + route | ~63,600\* | 11,403 | 22,202 | **40,453** | – |
| Last of 500 routes | ~59,400\* | 5,281 | 23,647 | **47,212** | – |
| 404 | ~64,600\* | 5,192 | 23,099 | **43,933** | – |
| POST JSON echo | ~34,400\* | 3,980 | 17,754 | **28,305** | – |

\* Measured in an isolated run: in the combined run this 4-vCPU sandbox throttled after
sustained load, depressing whichever server ran late, so treat the `node:http` column as an
upper bound. p99 latency: BareWeb 2–3 ms, Express 7–21 ms, Next.js 50–63 ms.

**Takeaways**

- BareWeb is now **~1.6–2× faster than before**, **3.3–3.6× faster than Express** on simple
  routes and **7–9× faster** where Express's linear layer scan hurts (large route tables, 404,
  body parsing).
- It runs at roughly **60–80 % of raw `node:http`**. A CPU profile under load shows BareWeb's own
  code at ~3 % of samples; the rest is Node's HTTP/socket layer — further framework-level
  gains are small.
- **Next.js is not a like-for-like competitor.** Its route handlers go through the full
  App Router server (request adaptation to Web `Request`/`Response`, async-storage contexts,
  caching layers). It is built for rendering React apps, not for raw API throughput, and lands
  at ~1.4–1.5 k req/s here — ~27–29× below BareWeb. Pick Next.js for full-stack React; pick
  BareWeb/Express/Fastify-class frameworks for API services.

## 5. Plan / remaining work

Done in the first change: all P- and S-findings above.

Recommended next steps, in priority order:

_Done in the follow-up change:_
- ~~**Live sub-router mounting.**~~ Routers are stored as a `mount` entry and flattened lazily
  into the tries on the next request after any registration (anywhere in the tree), so late
  registrations are picked up at the mount position. Cycles are rejected; cross-router route
  collisions are reported at `mount()` / `listen()` time.
- ~~**405 / automatic `OPTIONS` + `Allow`.**~~ A combined all-methods trie keeps true 404s at a
  single lookup; only real 405s check each method.
- ~~**Static files: `ETag`, `Range`.**~~ Strong `"size-mtime-ctime"` ETag (ctime so same-size
  replacements with a restored mtime still change it), `If-None-Match` /
  `If-Modified-Since` → 304, single `bytes=` ranges → 206, 416 with `Content-Range: bytes */size`,
  `If-Range`. Multi-range requests get the full file (allowed by RFC 9110). Precompressed
  `.br/.gz` variants remain open.
- ~~**Server lifecycle.**~~ `keepAliveTimeout` / `headersTimeout` / `requestTimeout` app
  options are applied to the server. `close()` is graceful: it closes idle keep-alive sockets,
  lets in-flight requests finish with `Connection: close` (checked in `BareResponse.writeHead`),
  optionally force-closes after `{ timeout }`, and returns a promise.
- ~~**`next('route')`.**~~ Route handlers in the resolved pipeline carry their route id;
  `next('route')` skips to the first item of another route or middleware. Previously the
  string was treated as an error. When the last route entered bails out and nothing responds,
  the request gets a 404 (not a 405). It only moves between routes at the matched trie node
  (same path pattern), not to less specific patterns.
- ~~**TypeScript declarations.**~~ Hand-written `src/index.d.ts`, wired through `types` and the
  `exports` `types` condition, with `req.params` inferred from route path literals.
  `npm run typecheck` compiles `test/types/usage.ts` (including `@ts-expect-error` negative
  cases). Inline 4-argument error handlers need annotations, as with Express's types.
- ~~**Trie backtracking bound.**~~ The `maxBacktracks` cap is gone (the option is accepted and
  ignored). The trie is a tree and each node sits at a fixed depth, so a search visits every
  node at most once: a miss is bounded by the trie size (≈6 ms for an adversarial
  65,536-route table), never exponential in the request path. With the cap, a valid route
  behind more than 500 failed static branches returned 404; a regression test covers that.
  (The cap had been removed once before, in `35e10fb`, and came back with the `f489113` rewrite.)
- ~~**`app.options()` / `router.options()`.**~~ Both threw "options is not a function": the
  constructor's `this.options = options` shadowed the route method. Constructor options now
  live on **`app.settings` / `router.settings`** (breaking for code that read `app.options`).
  This was also fixed once before (`7fcbc2c`) and regressed in `f489113`.
- ~~**CI.**~~ `.github/workflows/ci.yml`: `npm test` on Node 18/20/22/24 (Ubuntu) plus Node 24
  on Windows and macOS, and a job running `npm run typecheck` and checking that
  `src/index.d.ts` is in the packed tarball. `.github/workflows/benchmark.yml`: manual
  benchmark run with the output in the job summary and as an artifact.

- ~~**Optional/regex params.**~~ Express 4 `:name?` and `:name(regex)`. Optional params are
  expanded into one trie route per variant at registration (variants that meet on one node
  count once); regex constraints are anchored, per segment, tested on the raw segment and
  checked only on nodes that hold constrained routes. A rejected constraint backtracks.
- ~~**`next('route')` to less specific routes.**~~ When every route at the matched node bails,
  `Router.resolveNext()` searches again skipping the nodes already used (`/users/me` →
  `/users/:id` → `/users/*`), appending only route handlers. Normal requests don't pay for
  it; an in-process A/B of `app.handle()` measured +2–6 % (≤ ~100 ns), within run-to-run noise.
- ~~**Precompressed static files.**~~ `serveStatic({ precompressed: true | ['br', 'gzip'] })`
  serves `file.br` / `file.gz` per `Accept-Encoding` (q-values, `*`), with the original
  `Content-Type`, its own ETag and `Vary: Accept-Encoding`. `res.sendFile()` gained a
  `headers` option.
- ~~**Lost fixes from before `f489113`.**~~ Running the pre-rewrite test suite (`551c303`)
  against the current code found features the rewrite had dropped, now restored with
  tests in `test/restored.test.js`: `res.location()`, `redirect('back')` and redirect
  text bodies; cookie `priority` / `partitioned` and the `sameSite: 'none'` ⇒ `secure`
  check; `err.expose`; `trustProxy` peer lists / `'loopback'` / predicates; RegExps in
  `cors()` origin lists and reflected `Access-Control-Request-Headers`; `req.search`.
  It also exposed two bugs: `/echo//` 404'd (only one trailing empty segment was
  stripped) and URL fragments leaked into the path and query. Remaining differences from the
  old suite are deliberate (`Allow` lists `OPTIONS`; `Vary: Origin` for a fixed origin, as
  Express's `cors` does; `settings` naming; error wording).

Still open:

1. **Benchmarks on dedicated hardware:** the manual Benchmark workflow runs on shared GitHub
   runners, fine for relative comparisons within one run; published absolute numbers should
   still come from a dedicated machine.
