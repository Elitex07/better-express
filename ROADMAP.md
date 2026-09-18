# BareWeb Roadmap

What has shipped, and what is planned next. Items are grouped by tier; within a tier the order is a
rough priority. Contributions welcome — open an issue before starting anything large so we can
agree on the shape.

## Shipped

### Core (PR #1)
- Radix-tree router with static, `:param` and `*wildcard` segments, sub-router mounting, unified
  registration order between middleware and routes.
- Express-shaped `req`/`res` helpers, async middleware (`await next()`), built-in `cors()`,
  `serveStatic()`, `json()`, `urlencoded()`, cookie helpers, body limits with 413.
- Zero runtime dependencies, `node:test` suite, Dockerfile.

### Hardening & performance pass
- **Security**: 5xx messages masked in production unless `err.expose`; `X-Forwarded-*` only trusted
  with `createApp({ trustProxy })`; `serveStatic` percent-decodes and rejects only real `..`
  segments; `res.cookie` rejects `SameSite=None` without `Secure`; `cors()` refuses
  `credentials: true` with `origin: '*'`.
- **HTTP semantics**: `HEAD` falls back to `GET`; `405 Method Not Allowed` with `Allow`; automatic
  `OPTIONS` answers; `res.redirect(status, url)` overload and `res.location()`.
- **cors()**: origin lists / RegExp / predicate with `Vary: Origin`, reflected request headers,
  `exposedHeaders`, `preflightContinue`.
- **Performance**: `BareWebRequest`/`BareWebResponse` classes handed to `http.createServer` (no
  per-request decoration), hand-rolled request-target split with lazy `query`/`hostname`/`cookies`,
  per-node cached execution plans in `Router.resolve`, slimmer trie lookups. Roughly +25% req/s on
  the reference routes; see [BENCHMARKS.md](./BENCHMARKS.md).
- **Bugs**: `app.options()` was shadowed by the constructor's options property; trie backtrack cap
  could 404 valid deep routes; `/path//` empty trailing segment.

## Tier 3 — Feature gaps vs Express

1. **TypeScript definitions** (`types/index.d.ts`, `"types"` in package.json). Biggest DX gap.
2. **Route path features**: optional params `:id?`, per-segment regex constraints `:id(\d+)`,
   `router.route('/x').get().post()`, `app.param()`.
3. **Request helpers**: `req.is(type)`, `req.accepts(types)`, `req.fresh` / `req.stale`
   (ETag / If-None-Match).
4. **Response helpers**: `res.append()`, `res.vary()`, `res.attachment()` / `res.download()`,
   `res.format()`, `res.locals`, `res.sse()` (Server-Sent Events).
5. **`sendFile` / `serveStatic` HTTP semantics**: `ETag` + `Last-Modified` + 304, `Range` requests
   (206), `maxAge` / `Cache-Control` option, `dotfiles` policy, directory → trailing-slash redirect,
   a `root` option for `sendFile` so user-derived paths cannot escape.
6. **Server lifecycle**: `https` / `http2` via a `createServer` option, `app.close()` returning a
   Promise and draining with `closeIdleConnections()` / `closeAllConnections()`, request timeouts.
   (`createApp({ server })` already forwards `http.createServer` options.)
7. **Body parsing**: `strict` JSON option, `raw()` / `text()` middlewares, multipart
   (`req.formData()`) or an explicit "bring your own" recommendation.
8. **Routing options**: `caseSensitive`, `strict` trailing-slash handling.
9. **Express middleware interop**: a devDependency-only test that `helmet`, `morgan`, `compression`
   run unchanged.

## Tier 4 — Repo hygiene & tooling

1. GitHub Actions CI: `npm test` on Node 20/22/24 with `--experimental-test-coverage` threshold.
2. ESLint (flat config) + Prettier, `npm run lint`.
3. Fold `test/review_fixes.test.js` into topical files; add concurrency test for param isolation,
   `app.use(subApp)` mounting, `app.all()`, error-handler `next()` chaining, `close()`.
4. `package.json`: `engines.node >= 20`, `types`, `repository`, `sideEffects: false`; decide on the
   package name (`bareweb` vs repo `better-express`).
5. `CHANGELOG.md`, `CONTRIBUTING.md`, `SECURITY.md`; API reference (`docs/API.md` or generated from
   JSDoc).

## Non-goals (for now)

- Template engines / `res.render` — use any engine and `res.html()`.
- WebSockets — attach `ws` to `app.createServer()` directly.
- Plugin system / dependency injection — plain modules and sub-routers cover it.
