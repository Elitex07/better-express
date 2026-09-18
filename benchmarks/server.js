/**
 * Benchmark target server. Started by compare.js in a child process so the autocannon
 * client and the server under test never share an event loop.
 *
 *   node benchmarks/server.js <framework> <port>
 */
import http from 'node:http';
import express from 'express';
import Fastify from 'fastify';
import Koa from 'koa';
import KoaRouter from '@koa/router';
import koaBodyParser from 'koa-bodyparser';
import { createApp } from '../src/index.js';

const [, , name, portArg] = process.argv;
const PORT = Number(portArg) || 4100;

function listen(server) {
  return new Promise((resolve) => server.listen(PORT, '127.0.0.1', () => resolve(server)));
}

const passthrough = (req, res, next) => next();
const koaPassthrough = (ctx, next) => next();

// ---------------------------------------------------------------------------
// Framework factories: each returns a node http.Server listening on PORT
// ---------------------------------------------------------------------------
const FRAMEWORKS = {
  'node:http': () => {
    const server = http.createServer((req, res) => {
      const url = req.url;
      const send = (obj) => {
        const payload = JSON.stringify(obj);
        res.setHeader('Content-Type', 'application/json; charset=utf-8');
        res.setHeader('Content-Length', Buffer.byteLength(payload));
        res.end(payload);
      };
      if (req.method === 'GET' && url === '/test') return send({ message: 'Hello from benchmark', timestamp: Date.now() });
      if (req.method === 'GET' && url === '/chain') return send({ ok: true });
      if (req.method === 'GET' && url.startsWith('/users/')) return send({ userId: url.slice(7) });
      if (req.method === 'POST' && url === '/echo') {
        const chunks = [];
        req.on('data', (c) => chunks.push(c));
        req.on('end', () => { res.statusCode = 201; send({ received: JSON.parse(Buffer.concat(chunks).toString()) }); });
        return;
      }
      res.statusCode = 404;
      res.end();
    });
    return listen(server);
  },

  bareweb: () => {
    const app = createApp();
    app.get('/test', (req, res) => res.json({ message: 'Hello from benchmark', timestamp: Date.now() }));
    app.get('/users/:id', (req, res) => res.json({ userId: req.params.id }));
    app.post('/echo', async (req, res) => res.status(201).json({ received: await req.json() }));
    app.get('/chain', passthrough, passthrough, passthrough, passthrough, passthrough, (req, res) => res.json({ ok: true }));
    return listen(app.createServer());
  },

  express: () => {
    const app = express();
    app.get('/test', (req, res) => res.json({ message: 'Hello from benchmark', timestamp: Date.now() }));
    app.get('/users/:id', (req, res) => res.json({ userId: req.params.id }));
    app.post('/echo', express.json(), (req, res) => res.status(201).json({ received: req.body }));
    app.get('/chain', passthrough, passthrough, passthrough, passthrough, passthrough, (req, res) => res.json({ ok: true }));
    return listen(http.createServer(app));
  },

  fastify: async () => {
    const app = Fastify({ logger: false });
    app.get('/test', async () => ({ message: 'Hello from benchmark', timestamp: Date.now() }));
    app.get('/users/:id', async (req) => ({ userId: req.params.id }));
    app.post('/echo', async (req, reply) => { reply.code(201); return { received: req.body }; });
    const hook = async () => {};
    app.get('/chain', { preHandler: [hook, hook, hook, hook, hook] }, async () => ({ ok: true }));
    await app.listen({ port: PORT, host: '127.0.0.1' });
    return app.server;
  },

  koa: () => {
    const app = new Koa();
    const router = new KoaRouter();
    router.get('/test', (ctx) => { ctx.body = { message: 'Hello from benchmark', timestamp: Date.now() }; });
    router.get('/users/:id', (ctx) => { ctx.body = { userId: ctx.params.id }; });
    router.post('/echo', koaBodyParser(), (ctx) => { ctx.status = 201; ctx.body = { received: ctx.request.body }; });
    router.get('/chain', koaPassthrough, koaPassthrough, koaPassthrough, koaPassthrough, koaPassthrough, (ctx) => { ctx.body = { ok: true }; });
    app.use(router.routes());
    return listen(http.createServer(app.callback()));
  }
};


export { FRAMEWORKS };

if (!FRAMEWORKS[name]) {
  console.error(`Unknown framework "${name}". Known: ${Object.keys(FRAMEWORKS).join(', ')}`);
  process.exit(1);
}

const server = await FRAMEWORKS[name]();
process.send?.({ ready: true, port: server.address().port });

process.on('message', (msg) => {
  if (msg === 'close') {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
    server.close(() => process.exit(0));
  }
});
