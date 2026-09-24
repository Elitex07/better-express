# BareWeb (better-express) ⚡

> A high-performance, optimized, and lightweight web server framework for Node.js built with a Radix Tree router and zero runtime dependencies.

BareWeb is designed to fulfill the core capabilities of standard web frameworks like Express.js, but with superior performance, a minimal memory footprint, and modern asynchronous ergonomics.

---

## ✨ Features

- 🌲 **Radix Tree / Trie Router**: $O(K)$ path matching (where $K$ is path segment depth) for unambiguous routes, avoiding slow linear regex evaluation. Backtracking is bounded to protect against CPU exhaustion on ambiguous static/parameter siblings.
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
const app = createApp({ trustProxy: true });
```

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

### Notes

- `HEAD` requests fall back to the matching `GET` route.
- `next('route')` skips the remaining handlers of the current route and continues with the next
  route registered for the same path pattern (e.g. `app.get('/user/:id', ...)` twice). Routes
  are matched by specificity, so it does not fall back from `/users/me` to `/users/:id`. If
  every matching route bails out, the response is a 404.
- Mounting is live: routes and middleware added to a `Router` after `app.use('/x', router)` are
  picked up, and run at the position where the router was mounted.
- When a path exists under other methods, BareWeb answers `405 Method Not Allowed` with an
  `Allow` header, and answers `OPTIONS` automatically (`createApp({ methodNotAllowed: false })`
  restores plain 404s).
- `serveStatic()` / `res.sendFile()` send `ETag` + `Last-Modified`, answer conditional requests
  with `304`, and serve single byte ranges (`206`, `416` when unsatisfiable, `If-Range` aware).

---

## 🧪 Testing

BareWeb uses Node.js native test runner (`node:test`) requiring zero third-party testing dependencies:

```bash
npm test
```

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
