# BareWeb (better-express) ⚡

> A high-performance, optimized, and lightweight web server framework for Node.js built with a Radix Tree router and zero runtime dependencies.

BareWeb is designed to fulfill the core capabilities of standard web frameworks like Express.js, but with superior performance, a minimal memory footprint, and modern asynchronous ergonomics.

---

## ✨ Features

- 🌲 **Radix Tree / Trie Router**: $O(K)$ path matching (where $K$ is path segment depth) for unambiguous routes, avoiding slow linear regex evaluation. Backtracking visits each trie node at most once, so even ambiguous tables cost no more than one pass over the routes. Express 4 `:optional?` and `:param(regex)` syntax.
- 🪶 **Zero Runtime Dependencies**: The core server framework runs natively on Node.js standard libraries (`node:http`, `node:fs`, `node:path`).
- ⚡ **High Throughput & Low Latency**: ~3.5× Express.js on simple routes and 7–9× on large route tables, 404s and JSON bodies, at 60–80 % of raw `node:http` (see [Benchmarks](#-benchmarks)).
- 🔀 **Sub-Router Support**: Full modular routing with `Router`, sub-router prefix mounting (`app.use('/api', apiRouter)`), and router-scoped middleware.
- 🔄 **Async Middleware Pipeline**: Modern middleware engine supporting `await next()` and Express-style `(req, res, next)` signatures with `req.baseUrl`.
- 📦 **Built-in Async Parsers**: Native `await req.json()`, `await req.text()`, and `await req.urlencoded()` streaming parsers with safe HTTP 413 limit enforcement.
- 🍪 **Built-in Cookie Support**: Automated cookie reading via `req.cookies` and chainable `res.cookie()` / `res.clearCookie()` helpers.
- 🛡️ **Zero-Dependency Middlewares**: Built-in `cors()`, `serveStatic()`, `json()`, and `urlencoded()` utilities with directory traversal security.
- 🛠️ **Express-Compatible Ergonomics**: Familiar chainable response helpers (`res.status()`, `res.json()`, `res.send()`, `res.html()`, `res.sendStatus()`, `res.sendFile()`).

---

## 📁 Architecture Overview

```
BareWeb /
├── src/
│   ├── index.js          # Main library exports and factory functions
│   ├── app.js            # BareWeb application instance & server lifecycle
│   ├── trie.js           # Radix Tree node and route matching engine
│   ├── router.js         # HTTP method router, path joining & sub-router mounting
│   ├── request.js        # Request decorations (params, query, async body, cookies, ip)
│   ├── response.js       # Chainable response helpers (json, html, cookies, sendFile)
│   └── middleware.js     # Middleware runner, error handling, cors, serveStatic, body parsers
├── examples/
│   └── basic-server.js   # Interactive demo server with sub-routers & cookies
├── test/
│   ├── router.test.js    # Unit tests for route matching, parameters, and sub-routers
│   ├── server.test.js    # Integration tests for server lifecycle, endpoints, and middleware
│   ├── features.test.js  # Integration tests for CORS, static serving, cookies, forms, limits
│   └── hardening.test.js # Proxy trust, HEAD fallback, param isolation, error/CORS/static hardening
├── benchmarks/
│   ├── compare.js        # Benchmark runner (node:http vs Express vs BareWeb, optional Next.js)
│   └── server.js         # Benchmark target servers, one child process each
├── docs/
│   └── AUDIT.md          # Code audit, performance comparison and roadmap
└── package.json
```

---

## 🚀 Quick Start

### 1. Running the Example Server

```bash
# Start the demo server
npm start
```

Visit [http://localhost:3000](http://localhost:3000) in your browser.

### 2. Basic Example

```javascript
import createApp from './src/index.js';

const app = createApp();

// Global middleware
app.use(async (req, res, next) => {
  console.log(`${req.method} ${req.path}`);
  await next();
});

// Static route
app.get('/', (req, res) => {
  res.json({ message: 'Hello from BareWeb!' });
});

// Parameterized route with URL decoding
app.get('/users/:id', (req, res) => {
  res.json({ userId: req.params.id });
});

// JSON POST request
app.post('/api/items', async (req, res) => {
  const data = await req.json();
  res.status(201).json({ created: data });
});

// Start listening
app.listen(3000, () => {
  console.log('Server running on http://localhost:3000');
});
```

### 3. Modular Sub-Routers & Built-in Middlewares

```javascript
import createApp, { Router, cors, serveStatic } from './src/index.js';

const app = createApp();

// Built-in CORS
app.use(cors());

// Static file serving
app.use('/static', serveStatic('./public'));

// Create sub-router
const api = new Router();

// Sub-router scoped middleware
api.use((req, res, next) => {
  res.setHeader('X-API-Version', '2.0');
  next();
});

api.get('/users', (req, res) => {
  res.json({ users: ['Alice', 'Bob'] });
});

// Mount sub-router under prefix
app.use('/api/v2', api);
```

### 4. Behind a Reverse Proxy

`req.ip`, `req.protocol`, `req.secure` and `req.hostname` ignore `X-Forwarded-*` headers by
default, because any client can send them. Enable `trustProxy` only when the app runs behind a
proxy (nginx, a load balancer) that sets them:

```javascript
const app = createApp({ trustProxy: true });          // trust every peer
createApp({ trustProxy: 'loopback' });                  // only a proxy on this machine
createApp({ trustProxy: ['10.0.0.2', '10.0.0.3'] });    // only these peer addresses
createApp({ trustProxy: (addr) => addr.startsWith('10.') });
```

Addresses match whether the peer shows up as IPv4 or IPv4-mapped IPv6 (`::ffff:10.0.0.2`, as on
a dual-stack listener). The setting lives on `app.settings.trustProxy` and can be changed at runtime.

### 5. Timeouts & Graceful Shutdown

`keepAliveTimeout`, `headersTimeout` and `requestTimeout` (ms) are applied to the underlying
`http.Server`; unset ones keep Node's defaults. Behind a load balancer, set `keepAliveTimeout`
above the balancer's idle timeout to avoid sporadic 502s.

`app.close()` stops accepting connections, closes idle keep-alive sockets right away, and lets
in-flight requests finish (their responses carry `Connection: close`). Pass `timeout` to
destroy whatever is still open after that many ms. It returns a promise and also accepts a
callback.

```javascript
const app = createApp({ keepAliveTimeout: 65_000, headersTimeout: 66_000 });
app.listen(3000);

process.on('SIGTERM', async () => {
  await app.close({ timeout: 10_000 });
  process.exit(0);
});
```

### 6. TypeScript

Type declarations ship with the package (`src/index.d.ts`); they need `@types/node` in your
project. Route parameters are inferred from the path:

```typescript
import createApp, { type ErrorRequestHandler } from 'bareweb';

const app = createApp();
app.get('/users/:id/files/*path', (req, res) => {
  res.json({ id: req.params.id, file: req.params.path }); // both typed as string
});

// TypeScript can't infer inline 4-argument error handlers through overloads: type them
const onError: ErrorRequestHandler = (err, req, res, next) => res.status(500).json({ error: String(err) });
app.use(onError);
```

### 7. Route Parameters

Express 4 syntax:

```javascript
app.get('/users/:id', ...);              // required
app.get('/posts/:page?', ...);           // optional: /posts and /posts/2 (req.params.page undefined)
app.get('/orders/:id(\\d+)', ...);      // constrained: /orders/42 only
app.get('/files/*path', ...);            // rest of the path: req.params.path and req.params['*']
```

Constraints are anchored regexes tested against a single raw (percent-encoded) segment;
params are still decoded. When a constraint rejects a segment, matching backtracks to other
routes. Static segments beat `:params`, which beat `*wildcards`, regardless of registration order.

Patterns with nested repetition such as `(a+)+` are rejected at registration, because a crafted
segment could make them backtrack exponentially and block the event loop (the check is a
heuristic; overlapping alternations like `(a|a)*` are not detected, so keep patterns simple).
A route may have at most 8 *independent* optional segments (256 variants); runs of adjacent
optional params like `/:a?/:b?/:c?` are cheap.

### 8. Precompressed Static Files

```javascript
app.use(serveStatic('./dist', { precompressed: true })); // or ['gzip', 'br'] to prefer gzip
```

For `app.js`, BareWeb serves `app.js.br` or `app.js.gz` (built ahead of time, e.g. by your
bundler) when the client's `Accept-Encoding` allows it, with the original `Content-Type`, a
`Content-Encoding` header, its own `ETag` and `Vary: Accept-Encoding`. Without a matching
variant the original file is sent.

### Notes

- Constructor options are available as `app.settings` / `router.settings`.
- `HEAD` requests fall back to the matching `GET` route.
- `next('route')` skips the remaining handlers of the current route. The request continues with
  other routes for the same path, then falls back to less specific ones (`/users/me` →
  `/users/:id` → `/users/*`). Middleware isn't re-run. If every matching route bails out, the
  response is a 404.
- Mounting is live: routes and middleware added to a `Router` after `app.use('/x', router)` are
  picked up, and run at the position where the router was mounted.
- When a path exists under other methods, BareWeb answers `405 Method Not Allowed` with an
  `Allow` header, and answers `OPTIONS` automatically (`createApp({ methodNotAllowed: false })`
  restores plain 404s).
- `serveStatic()` / `res.sendFile()` send `ETag` + `Last-Modified`, answer conditional requests
  with `304`, and serve single byte ranges (`206`, `416` when unsatisfiable, `If-Range` aware).
- `res.redirect(url | 'back', status?)` sends a short text body; `res.location()` only sets the
  header. `res.cookie()` supports `priority` and `partitioned`, and rejects `sameSite: 'none'`
  or `partitioned` without `secure`.
- Errors with `expose: true` show their message even in production (http-errors convention).
- `cors()` origin lists may mix strings and RegExps; without `headers` it reflects the
  preflight's `Access-Control-Request-Headers`.

---

## 🧪 Testing

BareWeb uses Node.js native test runner (`node:test`) requiring zero third-party testing dependencies:

```bash
npm test
```

`npm run typecheck` compiles `test/types/usage.ts` against the type declarations.

GitHub Actions ([`.github/workflows/ci.yml`](.github/workflows/ci.yml)) runs the tests on
Node 18, 20, 22 and 24 (Linux) plus Node 24 on Windows and macOS, and type-checks the
declarations, on every push to `main` and every pull request. The **Benchmark** workflow
runs `npm run benchmark` on demand (Actions → Benchmark → Run workflow) and attaches the
results to the run; hosted runners are noisy, so compare frameworks within one run.

---

## 📊 Benchmarks

Each framework runs in its own child process and is hit by `autocannon` with identical routes
(static, param, 5 middlewares, 500-route table, 404, JSON POST):

```bash
npm run benchmark
# knobs: BENCH_DURATION, BENCH_TRIALS, BENCH_CONNECTIONS, BENCH_WORKERS, BENCH_ONLY=bareweb,express
# add a running Next.js app (GET /test, GET /users/[id] route handlers): NEXT_URL=http://127.0.0.1:3000
```

Sample run (Node 22, 4 vCPU, 50 connections, req/s):

| Scenario | node:http | Express 4 | BareWeb | Next.js 16 |
| --- | ---: | ---: | ---: | ---: |
| Static route | ~60,400 | 12,677 | 41,855 | 1,527 |
| Param route | ~65,300 | 11,733 | 40,775 | 1,397 |
| 500-route table | ~59,400 | 5,281 | 47,212 | – |
| POST JSON | ~34,400 | 3,980 | 28,305 | – |

Full methodology, findings and roadmap: [docs/AUDIT.md](docs/AUDIT.md).
