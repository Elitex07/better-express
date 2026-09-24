/**
 * Benchmark target server. Run as a child process so the load generator does not
 * share an event loop (or a CPU core) with the server under test.
 *
 *   node benchmarks/server.js <bareweb|express|node> <port>
 *
 * Every framework exposes the same scenarios:
 *   GET  /test            static route, JSON response
 *   GET  /users/:id       parameterized route
 *   GET  /mw/test         route behind 5 no-op middlewares (prefix /mw)
 *   GET  /r499            last route of a 500-route table
 *   GET  /nope            unmatched route (404)
 *   POST /echo            JSON body parse + echo
 */
const [, , framework = 'bareweb', portArg = '4000'] = process.argv;
const PORT = Number(portArg);
const ROUTE_TABLE_SIZE = 500;

const payload = () => ({ message: 'Hello from benchmark', timestamp: Date.now() });
const noop = (req, res, next) => next();

async function bareweb() {
  const { createApp, Router, json } = await import('../src/index.js');
  const app = createApp();
  const mw = new Router();
  for (let i = 0; i < 5; i++) mw.use(noop);
  mw.get('/test', (req, res) => res.json(payload()));
  app.get('/test', (req, res) => res.json(payload()));
  app.get('/users/:id', (req, res) => res.json({ userId: req.params.id }));
  app.use('/mw', mw);
  for (let i = 0; i < ROUTE_TABLE_SIZE; i++) {
    app.get(`/r${i}`, (req, res) => res.json({ route: i }));
  }
  app.post('/echo', json(), (req, res) => res.json(req.body));
  return app.listen(PORT, '127.0.0.1');
}

async function express() {
  const { default: expressFn } = await import('express');
  const app = expressFn();
  app.disable('x-powered-by');
  app.disable('etag');
  const mw = expressFn.Router();
  for (let i = 0; i < 5; i++) mw.use(noop);
  mw.get('/test', (req, res) => res.json(payload()));
  app.get('/test', (req, res) => res.json(payload()));
  app.get('/users/:id', (req, res) => res.json({ userId: req.params.id }));
  app.use('/mw', mw);
  for (let i = 0; i < ROUTE_TABLE_SIZE; i++) {
    app.get(`/r${i}`, (req, res) => res.json({ route: i }));
  }
  app.post('/echo', expressFn.json(), (req, res) => res.json(req.body));
  return app.listen(PORT, '127.0.0.1');
}

async function node() {
  const http = await import('node:http');
  const send = (res, status, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(status, {
      'Content-Type': 'application/json; charset=utf-8',
      'Content-Length': Buffer.byteLength(body)
    });
    res.end(body);
  };
  const server = http.createServer((req, res) => {
    const q = req.url.indexOf('?');
    const path = q === -1 ? req.url : req.url.slice(0, q);
    if (req.method === 'POST' && path === '/echo') {
      const chunks = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => send(res, 200, JSON.parse(Buffer.concat(chunks).toString())));
      return;
    }
    if (path === '/test' || path === '/mw/test') return send(res, 200, payload());
    if (path.startsWith('/users/')) return send(res, 200, { userId: path.slice(7) });
    if (path.startsWith('/r')) return send(res, 200, { route: Number(path.slice(2)) });
    send(res, 404, { error: 'not found' });
  });
  return server.listen(PORT, '127.0.0.1');
}

const targets = { bareweb, express, node };
if (!targets[framework]) {
  console.error(`Unknown framework "${framework}". Use one of: ${Object.keys(targets).join(', ')}`);
  process.exit(1);
}

const server = await targets[framework]();
server.on('listening', () => process.send?.('ready'));
