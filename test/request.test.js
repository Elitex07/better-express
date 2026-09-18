import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import { createApp, BareWebRequest, BareWebResponse } from '../src/index.js';
import { startApp } from './helpers.js';

function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port }, () => {
      client.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    client.on('data', (c) => { data += c.toString(); });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
}

describe('Request parsing & decoration', () => {
  let ctx;
  const setup = (app) => {
    app.get('/echo', (req, res) => {
      res.json({
        path: req.path,
        search: req.search,
        query: req.query,
        hostname: req.hostname,
        referrer: req.get('referrer'),
        isBareWebRequest: req instanceof BareWebRequest,
        isBareWebResponse: res instanceof BareWebResponse
      });
    });
    app.get('/secret', (req, res) => res.json({ path: req.path }));
    app.get('/.well-known/x', (req, res) => res.json({ path: req.path }));
  };

  before(async () => { ctx = await startApp(setup); });
  after(() => ctx.close());

  it('uses native BareWebRequest/BareWebResponse instances (no per-request prototype swap)', async () => {
    const res = await fetch(`${ctx.baseUrl}/echo`);
    const body = await res.json();
    assert.equal(body.isBareWebRequest, true);
    assert.equal(body.isBareWebResponse, true);
  });

  it('exposes path, search, lazy query and hostname', async () => {
    const res = await fetch(`${ctx.baseUrl}/echo?a=1&a=2&b[]=x&c=hello%20world`, { headers: { referer: '/from' } });
    const body = await res.json();
    assert.equal(body.path, '/echo');
    assert.equal(body.search, 'a=1&a=2&b[]=x&c=hello%20world');
    assert.deepEqual(body.query, { a: ['1', '2'], b: ['x'], c: 'hello world' });
    assert.equal(body.hostname, '127.0.0.1');
    assert.equal(body.referrer, '/from');
  });

  it('normalises dot segments and duplicate slashes exactly like the WHATWG URL parser', async () => {
    const port = ctx.server.address().port;
    let raw = await rawRequest(port, '/foo/../secret');
    assert.match(raw, /HTTP\/1.1 200/);
    assert.match(raw, /"path":"\/secret"/);

    raw = await rawRequest(port, '/echo//?x=1');
    assert.match(raw, /"path":"\/echo\/\/"/); // URL keeps "//" - and the trie ignores empty segments
    assert.match(raw, /HTTP\/1.1 200/);

    raw = await rawRequest(port, '/echo?x=1#frag');
    assert.match(raw, /"search":"x=1"/);

    // A leading-dot directory is not a dot segment and still routes normally
    raw = await rawRequest(port, '/.well-known/x');
    assert.match(raw, /"path":"\/.well-known\/x"/);
  });

  it('accepts absolute-form request targets', async () => {
    const port = ctx.server.address().port;
    const raw = await rawRequest(port, 'http://localhost/echo?z=9');
    assert.match(raw, /HTTP\/1.1 200/);
    assert.match(raw, /"path":"\/echo"/);
    assert.match(raw, /"search":"z=9"/);
  });

  it('works with a foreign http.Server via app.handle (prototype swapped in)', async () => {
    const app = createApp();
    setup(app);
    const server = http.createServer(app.handle);
    await new Promise((r) => server.listen(0, '127.0.0.1', r));
    try {
      const res = await fetch(`http://127.0.0.1:${server.address().port}/echo?k=v`);
      const body = await res.json();
      assert.equal(body.isBareWebRequest, true);
      assert.equal(body.isBareWebResponse, true);
      assert.deepEqual(body.query, { k: 'v' });
    } finally {
      await new Promise((r) => server.close(r));
    }
  });

  it('query/hostname setters override the lazy values', async () => {
    const c = await startApp((app) => {
      app.use((req, res, next) => { req.query = { forced: true }; req.hostname = 'override'; next(); });
      app.get('/x', (req, res) => res.json({ query: req.query, hostname: req.hostname }));
    });
    try {
      const body = await (await fetch(`${c.baseUrl}/x?a=1`)).json();
      assert.deepEqual(body, { query: { forced: true }, hostname: 'override' });
    } finally {
      await c.close();
    }
  });
});
