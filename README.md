# BareWeb (better-express) ⚡

> A high-performance, optimized, and lightweight web server framework for Node.js built with a Radix Tree router and zero runtime dependencies.

BareWeb is designed to fulfill the core capabilities of standard web frameworks like Express.js, but with superior performance, a minimal memory footprint, and modern asynchronous ergonomics.

---

## ✨ Features

- 🌲 **Radix Tree / Trie Router**: $O(K)$ path matching (where $K$ is path segment depth) for unambiguous routes, avoiding slow linear regex evaluation. Backtracking is bounded to protect against CPU exhaustion on ambiguous static/parameter siblings.
- 🪶 **Zero Runtime Dependencies**: The core server framework runs natively on Node.js standard libraries (`node:http`, `node:fs`, `node:path`).
- ⚡ **High Throughput & Low Latency**: Consistently higher throughput and lower tail latency than Express.js across typical micro-benchmarks.
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
│   └── features.test.js  # Integration tests for CORS, static serving, cookies, forms, limits
├── benchmarks/
│   └── compare.js        # Automated benchmark suite vs Express.js
├── ROADMAP.md            # Strategic architecture roadmap & feature tiers
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

---

## 🧪 Testing

BareWeb uses Node.js native test runner (`node:test`) requiring zero third-party testing dependencies:

```bash
npm test
```

---

## 📊 Benchmarks (BareWeb vs Express.js)

Run the automated benchmark suite comparing BareWeb with Express.js under identical load using `autocannon`. The suite runs a warm-up phase for V8 JIT optimization followed by multiple trials to calculate mean throughput, standard deviation, and p99 latency:

```bash
npm run benchmark
```

---

## 🗺️ Roadmap & Future Architecture

Looking to contribute or explore upcoming features? Check out our [Development Roadmap](file:///c:/Users/prate/Bareweb/BareWeb/ROADMAP.md) detailing TypeScript definitions, native Server-Sent Events (SSE), response compression, and Express middleware interoperability.
