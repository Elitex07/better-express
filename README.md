# BareWeb (better-express) ⚡

> A high-performance, optimized, and lightweight web server framework for Node.js built with a Radix Tree router and zero runtime dependencies.

BareWeb is designed to fulfill the core capabilities of standard web frameworks like Express.js, but with superior performance, a minimal memory footprint, and modern asynchronous ergonomics.

---

## ✨ Features

- 🌲 **Radix Tree / Trie Router**: $O(K)$ path matching (where $K$ is path segment depth) for unambiguous routes, avoiding slow linear regex evaluation. When static and `:param` siblings overlap, a miss falls back to the sibling branch; since the trie is a tree each node is visited at most once, so the worst case is bounded by the size of *your* route table, never by request input, and a valid route is always found.
- 🪶 **Zero Runtime Dependencies**: The core server framework runs natively on Node.js standard libraries (`node:http`, `node:fs`, `node:path`).
- ⚡ **High Throughput & Low Latency**: Consistently higher throughput and lower tail latency than Express.js across typical micro-benchmarks.
- 🔀 **Sub-Router Support**: Full modular routing with `Router`, sub-router prefix mounting (`app.use('/api', apiRouter)`), and router-scoped middleware.
- 🔄 **Async Middleware Pipeline**: Modern middleware engine supporting `await next()` and Express-style `(req, res, next)` signatures with `req.baseUrl`.
- 📦 **Built-in Async Parsers**: Native `await req.json()`, `await req.text()`, and `await req.urlencoded()` streaming parsers with safe HTTP 413 limit enforcement.
- 🍪 **Built-in Cookie Support**: Automated cookie reading via `req.cookies` and chainable `res.cookie()` / `res.clearCookie()` helpers.
- 🛡️ **Zero-Dependency Middlewares**: Built-in `cors()` (origin lists / RegExp / predicates, `Vary: Origin`), `serveStatic()` with traversal + symlink containment, `json()` and `urlencoded()`.
- 🛠️ **Express-Compatible Ergonomics**: Familiar chainable response helpers (`res.status()`, `res.json()`, `res.send()`, `res.html()`, `res.redirect()`, `res.location()`, `res.sendStatus()`, `res.sendFile()`).
- 🧭 **Correct HTTP semantics out of the box**: `HEAD` falls back to `GET`, unknown methods on a known path get `405` + `Allow`, `OPTIONS` is answered automatically.
- 🔒 **Safe defaults**: `X-Forwarded-*` headers are ignored until you opt in with `trustProxy`; 5xx error messages are masked in production; `SameSite=None` cookies must be `Secure`.

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
│   ├── router.test.js    # Trie matching, params, sub-routers, plan caching
│   ├── server.test.js    # Server lifecycle, endpoints, middleware
│   ├── features.test.js  # CORS, static serving, cookies, forms, body limits
│   ├── methods.test.js   # HEAD fallback, 405/Allow, automatic OPTIONS
│   ├── request.test.js   # URL parsing fast/slow paths, lazy getters, foreign servers
│   ├── response.test.js  # redirect/location/cookie helpers
│   ├── cors.test.js      # cors() origin matching, preflight, Vary
│   ├── security.test.js  # production error masking, trustProxy
│   └── review_fixes.test.js
├── benchmarks/
│   ├── compare.js        # Benchmark driver (node:http, BareWeb, Express, Fastify, Koa)
│   └── server.js         # Per-framework target servers, run in child processes
├── BENCHMARKS.md         # Latest recorded results + methodology
├── ROADMAP.md            # What shipped, what is next
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

### 3. Options

```javascript
const app = createApp({
  // Honour X-Forwarded-For / -Proto / -Host for req.ip, req.protocol, req.hostname.
  // Off by default because any client can send these headers. Accepts true, an address list
  // ('loopback', '10.0.0.1', ...), or a predicate (remoteAddress) => boolean.
  trustProxy: 'loopback',

  // Extra options forwarded to http.createServer
  server: { keepAliveTimeout: 65_000, requestTimeout: 30_000 }
});

// Attach to your own server (HTTPS, ws upgrades, serverless adapters):
import https from 'node:https';
https.createServer(tlsOptions, app.handle).listen(443);
```

Error handling: throw (or `next(err)`) with `err.statusCode` to control the status. Messages of
4xx errors are sent to the client; 5xx messages are replaced with the generic status text when
`NODE_ENV=production` unless you set `err.expose = true`. Stack traces are never sent in production.

### 4. Modular Sub-Routers & Built-in Middlewares

```javascript
import createApp, { Router, cors, serveStatic } from './src/index.js';

const app = createApp();

// Built-in CORS: string, RegExp, array or predicate origins; reflects the request Origin and
// sets `Vary: Origin` for the non-static forms.
app.use(cors({ origin: ['https://app.example', /\.example\.org$/], credentials: true }));

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

---

## 🧪 Testing

BareWeb uses Node.js native test runner (`node:test`) requiring zero third-party testing dependencies:

```bash
npm test
```

---

## 📊 Benchmarks

`npm run benchmark` compares BareWeb with a raw `node:http` baseline, Express, Fastify and Koa on
four scenarios (static route, param route, JSON POST echo, 5-middleware chain). Every server runs in
its own process, every `autocannon` run is a fresh process, and trials are interleaved across
frameworks so CPU frequency drift affects them equally; medians are reported.

```bash
npm run benchmark            # full run (~8 minutes)
npm run benchmark -- --quick # short sanity run
```

Latest recorded results and methodology notes: [BENCHMARKS.md](./BENCHMARKS.md).

---

## 🗺️ Roadmap

See [ROADMAP.md](./ROADMAP.md) for what has shipped and what is planned: TypeScript definitions,
route regex/optional params, ETag/Range support in `serveStatic`, Server-Sent Events, CI and more.
