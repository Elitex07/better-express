import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, Router, serveStatic } from '../src/index.js';
import { parseRange } from '../src/response.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

describe('Live sub-router mounting', () => {
  it('picks up routes and middleware added to a router after it was mounted', async () => {
    const app = createApp();
    const api = new Router();
    app.use('/api', api);
    app.use((req, res, next) => {
      req.log.push('late-global');
      next();
    });
    app.use((req, res, next) => {
      req.log = [];
      next();
    });

    // Registered after mounting: must still run, at the mount position
    api.use((req, res, next) => {
      req.log = ['sub-mw'];
      next();
    });
    api.get('/items/:id', (req, res) => res.json({ log: [...req.log, 'route'], id: req.params.id, baseUrl: req.baseUrl }));

    const server = await listen(app);
    try {
      const data = await (await fetch(`http://127.0.0.1:${server.address().port}/api/items/7`)).json();
      assert.deepStrictEqual(data, { log: ['sub-mw', 'route'], id: '7', baseUrl: '' });
    } finally {
      await new Promise((r) => app.close(r));
    }
  });

  it('propagates late registrations through nested routers and sub-apps', () => {
    const app = createApp();
    const v1 = new Router();
    const users = new Router();
    const subApp = createApp();

    app.use('/api', v1);
    v1.use('/users', users);
    app.use('/admin', subApp);

    users.get('/:id', () => 'user');
    subApp.get('/stats', () => 'stats');

    assert.strictEqual(app.router.find('GET', '/api/users/42').params.id, '42');
    assert.ok(app.router.find('GET', '/admin/stats'));
    assert.deepStrictEqual(
      app.router.routes.map((r) => `${r.method} ${r.path}`),
      ['GET /api/users/:id', 'GET /admin/stats']
    );
  });

  it('rejects mounting a router into itself or its descendants', () => {
    const a = new Router();
    const b = new Router();
    a.use('/b', b);
    assert.throws(() => a.use('/self', a), /Cannot mount a router into itself/);
    assert.throws(() => b.use('/a', a), /Cannot mount a router into itself/);
  });

  it('reports cross-router route collisions at mount time and leaves the parent unchanged', () => {
    const parent = new Router();
    parent.get('/files/*foo', () => 'parent');
    const child = new Router();
    child.get('/*bar', () => 'child');

    assert.throws(() => parent.use('/files', child), /Route collision/);
    assert.strictEqual(parent.stack.length, 1);
    assert.strictEqual(parent.find('GET', '/files/x').params.foo, 'x');
  });
});

describe('405 Method Not Allowed & automatic OPTIONS', () => {
  let app;
  let strictApp;
  let baseUrl;
  let strictUrl;

  before(async () => {
    app = createApp();
    app.get('/things', (req, res) => res.json([]));
    app.post('/things', (req, res) => res.status(201).json({}));
    app.get('/files/*', (req, res) => res.send('file'));
    baseUrl = `http://127.0.0.1:${(await listen(app)).address().port}`;

    strictApp = createApp({ methodNotAllowed: false });
    strictApp.get('/things', (req, res) => res.json([]));
    strictUrl = `http://127.0.0.1:${(await listen(strictApp)).address().port}`;
  });

  after(async () => {
    await new Promise((r) => app.close(r));
    await new Promise((r) => strictApp.close(r));
  });

  it('answers 405 with an Allow header when the path exists under other methods', async () => {
    const res = await fetch(`${baseUrl}/things`, { method: 'DELETE' });
    assert.strictEqual(res.status, 405);
    assert.strictEqual(res.headers.get('allow'), 'GET, POST, HEAD, OPTIONS');
    const data = await res.json();
    assert.strictEqual(data.error.statusCode, 405);

    const wildcard = await fetch(`${baseUrl}/files/a/b.txt`, { method: 'PUT' });
    assert.strictEqual(wildcard.status, 405);
  });

  it('answers OPTIONS automatically', async () => {
    const res = await fetch(`${baseUrl}/things`, { method: 'OPTIONS' });
    assert.strictEqual(res.status, 204);
    assert.strictEqual(res.headers.get('allow'), 'GET, POST, HEAD, OPTIONS');
  });

  it('allows differently named wildcards under different methods', () => {
    const wild = createApp();
    wild.get('/w/*a', (req, res) => res.send(req.params.a));
    wild.post('/w/*b', (req, res) => res.send(req.params.b));
    assert.deepStrictEqual(wild.router.allowedMethods('/w/x/y'), ['GET', 'POST', 'HEAD']);
  });

  it('still answers 404 for unknown paths', async () => {
    const res = await fetch(`${baseUrl}/nothing-here`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
  });

  it('can be disabled with methodNotAllowed: false', async () => {
    const res = await fetch(`${strictUrl}/things`, { method: 'DELETE' });
    assert.strictEqual(res.status, 404);
  });
});

describe('Static files: ETag & Range', () => {
  let app;
  let baseUrl;
  let port;
  const fixtureDir = path.resolve('test', 'fixtures_ranges');
  const content = '0123456789abcdefghij'; // 20 bytes

  const raw = (headers = {}, method = 'GET', file = '/static/data.txt') => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: file, method, headers }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });

  before(async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, 'data.txt'), content);
    app = createApp();
    app.use('/static', serveStatic(fixtureDir));
    app.get('/custom-404', (req, res) => res.status(404).sendFile(path.join(fixtureDir, 'data.txt')));
    app.get('/no-etag', (req, res) => res.sendFile(path.join(fixtureDir, 'data.txt'), { etag: false }));
    const server = await listen(app);
    port = server.address().port;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((r) => app.close(r));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('sends an ETag and answers If-None-Match with 304', async () => {
    const first = await raw();
    assert.strictEqual(first.status, 200);
    assert.strictEqual(first.body, content);
    assert.match(first.headers.etag, /^"[0-9a-f]+-[0-9a-f]+-[0-9a-f]+"$/);
    assert.strictEqual(first.headers['accept-ranges'], 'bytes');

    const cached = await raw({ 'if-none-match': `"other", W/${first.headers.etag}` });
    assert.strictEqual(cached.status, 304);
    assert.strictEqual(cached.body, '');

    const stale = await raw({ 'if-none-match': '"other"' });
    assert.strictEqual(stale.status, 200);
  });

  it('changes the ETag when content is replaced with the same size and mtime', async () => {
    const file = path.join(fixtureDir, 'data.txt');
    const before = await raw();
    const { mtime } = fs.statSync(file);
    await new Promise((r) => setTimeout(r, 5));
    fs.writeFileSync(file, content.toUpperCase()); // same length
    fs.utimesSync(file, mtime, mtime); // what rsync -t / cp -p do
    try {
      const after = await raw({ 'if-none-match': before.headers.etag });
      assert.strictEqual(after.status, 200);
      assert.strictEqual(after.body, content.toUpperCase());
      assert.notStrictEqual(after.headers.etag, before.headers.etag);

      const staleRange = await raw({ range: 'bytes=0-1', 'if-range': before.headers.etag });
      assert.strictEqual(staleRange.status, 200);
    } finally {
      fs.writeFileSync(file, content);
    }
  });

  it('answers If-None-Match: * with 304 even when ETags are disabled', async () => {
    const res = await fetch(`${baseUrl}/no-etag`, { headers: { 'if-none-match': '*' } });
    assert.strictEqual(res.status, 304);
    assert.strictEqual(res.headers.get('etag'), null);
  });

  it('serves byte ranges with 206', async () => {
    const res = await raw({ range: 'bytes=0-4' });
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.body, '01234');
    assert.strictEqual(res.headers['content-range'], 'bytes 0-4/20');
    assert.strictEqual(res.headers['content-length'], '5');

    assert.strictEqual((await raw({ range: 'bytes=-3' })).body, 'hij');
    assert.strictEqual((await raw({ range: 'bytes=15-' })).body, 'fghij');
    assert.strictEqual((await raw({ range: 'bytes=18-100' })).body, 'ij');
  });

  it('answers unsatisfiable ranges with 416 and ignores unsupported ones', async () => {
    const res = await raw({ range: 'bytes=20-' });
    assert.strictEqual(res.status, 416);
    assert.strictEqual(res.headers['content-range'], 'bytes */20');

    const multi = await raw({ range: 'bytes=0-1,5-6' });
    assert.strictEqual(multi.status, 200);
    assert.strictEqual(multi.body, content);
  });

  it('honors If-Range', async () => {
    const { headers } = await raw();
    assert.strictEqual((await raw({ range: 'bytes=0-1', 'if-range': headers.etag })).status, 206);
    const stale = await raw({ range: 'bytes=0-1', 'if-range': '"stale"' });
    assert.strictEqual(stale.status, 200);
    assert.strictEqual(stale.body, content);
  });

  it('supports HEAD with ranges', async () => {
    const res = await raw({ range: 'bytes=0-9' }, 'HEAD');
    assert.strictEqual(res.status, 206);
    assert.strictEqual(res.headers['content-length'], '10');
    assert.strictEqual(res.body, '');
  });

  it('ignores validators and ranges on non-200 responses', async () => {
    const res = await fetch(`${baseUrl}/custom-404`, { headers: { range: 'bytes=0-1' } });
    assert.strictEqual(res.status, 404);
    assert.strictEqual(await res.text(), content);
  });

  it('parseRange handles edge cases', () => {
    assert.deepStrictEqual(parseRange('bytes=0-0', 10), { start: 0, end: 0 });
    assert.deepStrictEqual(parseRange('bytes=-20', 10), { start: 0, end: 9 });
    assert.strictEqual(parseRange('bytes=-0', 10), -1);
    assert.strictEqual(parseRange('bytes=0-', 0), -1);
    assert.strictEqual(parseRange('bytes=5-2', 10), null);
    assert.strictEqual(parseRange('items=0-1', 10), null);
    assert.strictEqual(parseRange('bytes=a-b', 10), null);
  });
});
