import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, cors, serveStatic } from '../src/index.js';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

function rawRequest(port, head) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: '127.0.0.1', port }, () => socket.write(head));
    let data = '';
    socket.on('data', (c) => { data += c; });
    socket.on('end', () => resolve(data));
    socket.on('error', reject);
  });
}

describe('Review round 2 fixes', () => {
  let app;
  let server;
  let port;
  let baseUrl;
  const fixtureDir = path.resolve('test', 'fixtures_round2');

  before(async () => {
    fs.mkdirSync(fixtureDir, { recursive: true });
    fs.writeFileSync(path.join(fixtureDir, '..notes'), 'DOTDOT_NAME');

    app = createApp();
    app.use('/static', serveStatic(fixtureDir));
    app.use('/regex', cors({ origin: /^https:\/\/ok\.example$/g }));
    app.use('/vary', (req, res, next) => {
      res.setHeader('Vary', 'Accept-Encoding');
      next();
    }, cors({ origin: 'https://a.example' }));
    app.get('/regex', (req, res) => res.send('ok'));
    app.get('/vary', (req, res) => res.send('ok'));
    app.get('/inherited', (req, res) => res.json({ cookies: req.cookies, query: req.query }));
    app.get('/host', (req, res) => res.send('reached'));

    server = http.createServer(app.handle);
    port = await listen(server);
    baseUrl = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    await new Promise((r) => server.close(r));
    fs.rmSync(fixtureDir, { recursive: true, force: true });
  });

  it('handle() settles only after async downstream work, even if middleware does not return next()', async () => {
    const local = createApp();
    local.use((req, res, next) => {
      next(); // not returned, not awaited
    });
    local.get('/slow', async (req, res) => {
      await new Promise((r) => setTimeout(r, 30));
      res.json({ ok: true });
    });
    let endedWhenSettled;
    const s = http.createServer(async (req, res) => {
      await local.handle(req, res);
      endedWhenSettled = res.writableEnded;
    });
    const p = await listen(s);
    try {
      await fetch(`http://127.0.0.1:${p}/slow`);
      await new Promise((r) => setImmediate(r));
      assert.strictEqual(endedWhenSettled, true);
    } finally {
      await new Promise((r) => s.close(r));
    }
  });

  it('refuses credentialed CORS without an explicit origin policy', () => {
    assert.throws(() => cors({ credentials: true }), /requires an explicit origin/);
    assert.doesNotThrow(() => cors({ credentials: true, origin: ['https://a.example'] }));
  });

  it('evaluates global/sticky RegExp origins the same way on every request', async () => {
    for (let i = 0; i < 3; i++) {
      const res = await fetch(`${baseUrl}/regex`, { headers: { origin: 'https://ok.example' } });
      assert.strictEqual(res.headers.get('access-control-allow-origin'), 'https://ok.example');
    }
  });

  it('keeps existing Vary values when adding Origin', async () => {
    const res = await fetch(`${baseUrl}/vary`, { headers: { origin: 'https://a.example' } });
    assert.strictEqual(res.headers.get('vary'), 'Accept-Encoding, Origin');
  });

  it('keeps cookies and query keys named like Object.prototype members', async () => {
    const res = await fetch(`${baseUrl}/inherited?constructor=c&toString=t`, {
      headers: { cookie: 'constructor=1; toString=2' }
    });
    const data = await res.json();
    assert.deepStrictEqual(data.cookies, { constructor: '1', toString: '2' });
    assert.deepStrictEqual(data.query, { constructor: 'c', toString: 't' });
  });

  it('rejects Host headers with an empty name or an out-of-range port', async () => {
    for (const host of [':80', 'example.com:99999', 'a b']) {
      const raw = await rawRequest(port, `GET /host HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.ok(raw.startsWith('HTTP/1.1 400'), `Host "${host}" should be rejected, got: ${raw.split('\r\n')[0]}`);
    }
    for (const host of ['example.com:65535', '[::1]:8080', '127.0.0.1']) {
      const raw = await rawRequest(port, `GET /host HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`);
      assert.ok(raw.startsWith('HTTP/1.1 200'), `Host "${host}" should be accepted, got: ${raw.split('\r\n')[0]}`);
    }
  });

  it('serves files whose names start with two dots', async () => {
    const res = await fetch(`${baseUrl}/static/..notes`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(await res.text(), 'DOTDOT_NAME');
  });
});
