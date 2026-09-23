import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, Router, cors, serveStatic, json } from '../src/index.js';
import { defaultErrorHandler } from '../src/middleware.js';

function defaultErrorHandlerForTests(err) {
  const out = { statusCode: 200, headers: {}, body: '' };
  const res = {
    writableEnded: false,
    headersSent: false,
    set statusCode(v) { out.statusCode = v; },
    setHeader(k, v) { out.headers[k.toLowerCase()] = v; },
    end(body) { out.body = body; }
  };
  defaultErrorHandler(err, {}, res);
  return out;
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Performance refactor & hardening', () => {
  let app;
  let proxyApp;
  let server;
  let proxyServer;
  let baseUrl;
  let proxyUrl;
  const fixtureDir = path.resolve('test', 'fixtures_hardening');

  before(async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'my file.txt'), 'SPACED');

    app = createApp();
    app.use('/files', serveStatic(fixtureDir));
    app.use('/cors-list', cors({ origin: ['https://a.example', 'https://b.example'] }));
    app.use('/cors-creds', cors({ origin: true, credentials: true }));

    app.get('/whoami', (req, res) => res.json({ ip: req.ip, protocol: req.protocol, hostname: req.hostname }));
    app.get('/only-get', (req, res) => res.set('X-Handled', 'get').send('body'));
    app.get('/async-param/:id', async (req, res) => {
      const { id } = req.params;
      await new Promise((r) => setTimeout(r, Number(id) % 2 === 0 ? 20 : 1));
      res.json({ id, now: req.params.id });
    });
    app.get('/bad-status', () => {
      const err = new Error('weird');
      err.status = 'teapot';
      throw err;
    });
    app.get('/query', (req, res) => res.json({ query: req.query, polluted: {}.polluted === undefined }));
    app.post('/vendor-json', json(), (req, res) => res.json({ body: req.body }));
    app.get('/redirect-express-style', (req, res) => res.redirect(301, '/target'));
    app.get('/override-ip', (req, res) => {
      req.ip = '10.0.0.1';
      res.json({ ip: req.ip });
    });

    // `await next()` must wait for async downstream handlers
    const timing = new Router();
    timing.use(async (req, res, next) => {
      await next();
      res.end(JSON.stringify({ downstreamDone: req.downstreamDone === true }));
    });
    timing.get('/wait', async (req) => {
      await new Promise((r) => setTimeout(r, 10));
      req.downstreamDone = true;
    });
    app.use('/timing', timing);

    // Registered after 500 routes: order must still be respected
    for (let i = 0; i < 500; i++) app.get(`/bulk/${i}`, (req, res) => res.json({ i, mw: req.lateMw === true }));
    app.use((req, res, next) => {
      req.lateMw = true;
      next();
    });
    app.get('/bulk-late', (req, res) => res.json({ mw: req.lateMw === true }));

    server = await listen(app);
    baseUrl = `http://127.0.0.1:${server.address().port}`;

    proxyApp = createApp({ trustProxy: true });
    proxyApp.get('/whoami', (req, res) => res.json({ ip: req.ip, protocol: req.protocol, hostname: req.hostname, secure: req.secure }));
    proxyServer = await listen(proxyApp);
    proxyUrl = `http://127.0.0.1:${proxyServer.address().port}`;
  });

  after(async () => {
    await new Promise((r) => app.close(r));
    await new Promise((r) => proxyApp.close(r));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('ignores X-Forwarded-* headers unless trustProxy is enabled', async () => {
    const headers = { 'x-forwarded-for': '6.6.6.6, 10.0.0.1', 'x-forwarded-proto': 'https', 'x-forwarded-host': 'evil.example' };

    const untrusted = await (await fetch(`${baseUrl}/whoami`, { headers })).json();
    assert.notStrictEqual(untrusted.ip, '6.6.6.6');
    assert.strictEqual(untrusted.protocol, 'http');
    assert.strictEqual(untrusted.hostname, '127.0.0.1');

    const trusted = await (await fetch(`${proxyUrl}/whoami`, { headers })).json();
    assert.strictEqual(trusted.ip, '6.6.6.6');
    assert.strictEqual(trusted.protocol, 'https');
    assert.strictEqual(trusted.secure, true);
    assert.strictEqual(trusted.hostname, 'evil.example');
  });

  it('lets middleware override derived request getters', async () => {
    const data = await (await fetch(`${baseUrl}/override-ip`)).json();
    assert.strictEqual(data.ip, '10.0.0.1');
  });

  it('answers HEAD requests using GET routes', async () => {
    const res = await fetch(`${baseUrl}/only-get`, { method: 'HEAD' });
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-handled'), 'get');
    assert.strictEqual(await res.text(), '');
  });

  it('keeps route params isolated between concurrent requests', async () => {
    const ids = ['2', '3', '4', '5', '6', '7'];
    const results = await Promise.all(ids.map((id) => fetch(`${baseUrl}/async-param/${id}`).then((r) => r.json())));
    results.forEach((data, i) => {
      assert.strictEqual(data.id, ids[i]);
      assert.strictEqual(data.now, ids[i]);
    });
  });

  it('keeps registration order with large route tables', async () => {
    assert.deepStrictEqual(await (await fetch(`${baseUrl}/bulk/499`)).json(), { i: 499, mw: false });
    assert.deepStrictEqual(await (await fetch(`${baseUrl}/bulk-late`)).json(), { mw: true });
  });

  it('makes `await next()` wait for async downstream handlers', async () => {
    const data = await (await fetch(`${baseUrl}/timing/wait`)).json();
    assert.strictEqual(data.downstreamDone, true);
  });

  it('falls back to 500 for invalid error status codes', async () => {
    const res = await fetch(`${baseUrl}/bad-status`);
    assert.strictEqual(res.status, 500);
    assert.strictEqual((await res.json()).error.message, 'weird');
  });

  it('hides 5xx error details in production', () => {
    const prev = process.env.NODE_ENV;
    process.env.NODE_ENV = 'production';
    try {
      const out = defaultErrorHandlerForTests(new Error('db password is hunter2'));
      assert.strictEqual(out.statusCode, 500);
      assert.deepStrictEqual(JSON.parse(out.body), { error: { message: 'Internal Server Error', statusCode: 500 } });
    } finally {
      process.env.NODE_ENV = prev;
    }
  });

  it('parses query strings lazily and never pollutes Object.prototype', async () => {
    const data = await (await fetch(`${baseUrl}/query?a=1&__proto__=x&__proto__[polluted]=1&b[]=2`)).json();
    assert.deepStrictEqual(data.query, { a: '1', '__proto__[polluted]': '1', b: ['2'] });
    assert.strictEqual(data.polluted, true);
  });

  it('serves percent-encoded file names and blocks encoded traversal', async () => {
    const ok = await fetch(`${baseUrl}/files/my%20file.txt`);
    assert.strictEqual(ok.status, 200);
    assert.strictEqual(await ok.text(), 'SPACED');
    assert.ok(ok.headers.get('last-modified'));

    const notModified = await fetch(`${baseUrl}/files/my%20file.txt`, {
      headers: { 'if-modified-since': ok.headers.get('last-modified') }
    });
    assert.strictEqual(notModified.status, 304);

    // fetch() and URL strings normalize %2e%2e client-side, so send the raw path
    const traversalStatus = await new Promise((resolve, reject) => {
      http.get({ host: '127.0.0.1', port: server.address().port, path: '/files/%2e%2e/%2e%2e/package.json' }, (res) => {
        res.resume();
        resolve(res.statusCode);
      }).on('error', reject);
    });
    assert.strictEqual(traversalStatus, 403);
  });

  it('supports CORS origin allow-lists and credentials without wildcard', async () => {
    const allowed = await fetch(`${baseUrl}/cors-list`, { method: 'OPTIONS', headers: { origin: 'https://b.example' } });
    assert.strictEqual(allowed.status, 204);
    assert.strictEqual(allowed.headers.get('access-control-allow-origin'), 'https://b.example');
    assert.match(allowed.headers.get('vary'), /Origin/);

    const denied = await fetch(`${baseUrl}/cors-list`, { method: 'OPTIONS', headers: { origin: 'https://evil.example' } });
    assert.strictEqual(denied.headers.get('access-control-allow-origin'), null);

    const creds = await fetch(`${baseUrl}/cors-creds`, { method: 'OPTIONS', headers: { origin: 'https://app.example' } });
    assert.strictEqual(creds.headers.get('access-control-allow-origin'), 'https://app.example');
    assert.strictEqual(creds.headers.get('access-control-allow-credentials'), 'true');
  });

  it('json() accepts structured +json content types', async () => {
    const res = await fetch(`${baseUrl}/vendor-json`, {
      method: 'POST',
      headers: { 'content-type': 'application/vnd.api+json' },
      body: JSON.stringify({ ok: 1 })
    });
    assert.deepStrictEqual(await res.json(), { body: { ok: 1 } });
  });

  it('supports Express-style redirect(status, url)', async () => {
    const res = await fetch(`${baseUrl}/redirect-express-style`, { redirect: 'manual' });
    assert.strictEqual(res.status, 301);
    assert.strictEqual(res.headers.get('location'), '/target');
  });

  it('works as a plain node:http request listener', async () => {
    const plainApp = createApp();
    plainApp.get('/plain/:id', (req, res) => res.status(201).json({ id: req.params.id, q: req.query.x }));
    const plain = http.createServer(plainApp.handle);
    await new Promise((r) => plain.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${plain.address().port}/plain/7?x=y`);
      assert.strictEqual(res.status, 201);
      assert.deepStrictEqual(await res.json(), { id: '7', q: 'y' });
    } finally {
      await new Promise((r) => plain.close(r));
    }
  });
});
