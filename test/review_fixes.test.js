import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, Router, Trie, serveStatic } from '../src/index.js';

describe('PR Review Findings Fixes & Security Verification', () => {
  let app;
  let server;
  let baseUrl;
  let serverPort;
  const fixtureDir = path.resolve('test', 'fixtures_security');
  const outsideFile = path.resolve('test', 'outside_secret.txt');
  const insideSymlink = path.join(fixtureDir, 'secret_symlink.txt');
  const insideNormal = path.join(fixtureDir, 'public_normal.txt');
  let symlinkCreated = false;

  before(async () => {
    // Setup test directory and files
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    fs.writeFileSync(outsideFile, 'TOP_SECRET_OUTSIDE_ROOT');
    fs.writeFileSync(insideNormal, 'PUBLIC_NORMAL_CONTENT');

    try {
      if (fs.existsSync(insideSymlink)) {
        fs.unlinkSync(insideSymlink);
      }
      fs.symlinkSync(outsideFile, insideSymlink, 'file');
      symlinkCreated = true;
    } catch {
      // Windows without Developer Mode or unprivileged user might reject symlink creation
      symlinkCreated = false;
    }

    app = createApp();

    // 1. Static file serving via serveStatic
    app.use('/static-test', serveStatic(fixtureDir));

    // 2. Registration Order test routes
    const orderLog = [];
    app.get('/order-test/first', (req, res) => {
      orderLog.push('first-route');
      res.json({ log: [...orderLog] });
    });

    app.use((req, res, next) => {
      orderLog.push('mw-after-first');
      next();
    });

    app.get('/order-test/second', (req, res) => {
      orderLog.push('second-route');
      res.json({ log: [...orderLog] });
    });

    // 3. sendFile rejection behavior test route
    app.get('/sendfile-missing-unhandled', (req, res) => {
      // Calling sendFile without await or onError on a nonexistent file
      res.sendFile(path.join(fixtureDir, 'missing_file_xyz.txt'));
    });

    app.get('/sendfile-callback-check', (req, res) => {
      res.sendFile(path.join(fixtureDir, 'missing_file_xyz.txt'), (err) => {
        if (err) {
          res.status(404).json({ handledViaCallback: true, msg: err.message });
        }
      });
    });

    // 4. Cached body limit enforcement route
    app.post('/cached-body-limit', async (req, res) => {
      // First read body with large limit (e.g. 1MB)
      const body = await req.json(1024 * 1024);
      // Attempt second read with tiny limit (10 bytes) - must throw 413
      await req.json(10);
      res.json({ body });
    });

    // 5. Parameter names collision test
    app.get('/param-collision/:id', (req, res, next) => {
      req._firstParam = req.params.id;
      next();
    });
    app.get('/param-collision/:name', (req, res) => {
      res.json({
        id: req._firstParam,
        name: req.params.name,
        allParams: req.params
      });
    });

    // Start server
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        serverPort = server.address().port;
        baseUrl = `http://127.0.0.1:${serverPort}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => app.close(resolve));
    if (fs.existsSync(insideSymlink)) {
      try { fs.unlinkSync(insideSymlink); } catch {}
    }
    if (fs.existsSync(insideNormal)) {
      try { fs.unlinkSync(insideNormal); } catch {}
    }
    if (fs.existsSync(outsideFile)) {
      try { fs.unlinkSync(outsideFile); } catch {}
    }
    if (fs.existsSync(fixtureDir)) {
      try { fs.rmdirSync(fixtureDir); } catch {}
    }
  });

  it('Finding 1: Symlinks Escape Static Root - should block symlinks pointing outside static root with 403', async () => {
    if (!symlinkCreated) {
      // If OS environment prevented symlink creation, test the containment logic directly
      const mw = serveStatic(fixtureDir);
      let statusCode = null;
      let sentBody = null;
      const mockRes = {
        status(c) { statusCode = c; return this; },
        send(b) { sentBody = b; return this; }
      };
      // Direct traversal attempt
      await mw({ method: 'GET', url: '/static-test/../outside_secret.txt', path: '/../outside_secret.txt' }, mockRes, () => {});
      assert.strictEqual(statusCode, 403);
      assert.strictEqual(sentBody, 'Forbidden');
      return;
    }

    // Normal file inside root should be 200
    const normalRes = await fetch(`${baseUrl}/static-test/public_normal.txt`);
    assert.strictEqual(normalRes.status, 200);
    const normalText = await normalRes.text();
    assert.strictEqual(normalText, 'PUBLIC_NORMAL_CONTENT');

    // Symlink pointing outside root MUST be 403 Forbidden
    const symlinkRes = await fetch(`${baseUrl}/static-test/secret_symlink.txt`);
    assert.strictEqual(symlinkRes.status, 403);
    const symlinkText = await symlinkRes.text();
    assert.strictEqual(symlinkText, 'Forbidden');
  });

  it('Finding 2: Malformed Hosts Bypass Handling - should return 400 Bad Request for malformed Host header', async () => {
    // Send raw HTTP request with invalid host header that would cause new URL() to throw
    const rawResponse = await new Promise((resolve, reject) => {
      const client = net.createConnection({ host: '127.0.0.1', port: serverPort }, () => {
        client.write('GET / HTTP/1.1\r\nHost: [invalid:host:\r\nConnection: close\r\n\r\n');
      });

      let data = '';
      client.on('data', (chunk) => { data += chunk.toString(); });
      client.on('end', () => resolve(data));
      client.on('error', reject);
    });

    assert.ok(rawResponse.startsWith('HTTP/1.1 400 Bad Request'), `Expected HTTP 400 Bad Request but got:\n${rawResponse}`);
    assert.ok(rawResponse.includes('Malformed Host or URL'));
  });

  it('Finding 3: Registration Order Is Lost - middleware registered after a route must not run before that route', async () => {
    // Request /order-test/first (registered before the middleware)
    const res1 = await fetch(`${baseUrl}/order-test/first`);
    assert.strictEqual(res1.status, 200);
    const data1 = await res1.json();
    assert.deepStrictEqual(data1.log, ['first-route']);

    // Request /order-test/second (registered after the middleware)
    const res2 = await fetch(`${baseUrl}/order-test/second`);
    assert.strictEqual(res2.status, 200);
    const data2 = await res2.json();
    assert.ok(data2.log.includes('mw-after-first'));
    assert.strictEqual(data2.log[data2.log.length - 1], 'second-route');
  });

  it('Finding 4: Missing Files Reject Unhandled - sendFile should not trigger unhandled promise rejection on missing file', async () => {
    let unhandledRejectionCaught = false;
    const onUnhandled = () => { unhandledRejectionCaught = true; };
    process.on('unhandledRejection', onUnhandled);

    try {
      const res = await fetch(`${baseUrl}/sendfile-missing-unhandled`);
      assert.strictEqual(res.status, 404);
      const data = await res.json();
      assert.strictEqual(data.error.statusCode, 404);

      // Wait a tick to ensure no asynchronous rejection occurred
      await new Promise((r) => setTimeout(r, 50));
      assert.strictEqual(unhandledRejectionCaught, false, 'Expected no unhandledRejection event');
    } finally {
      process.removeListener('unhandledRejection', onUnhandled);
    }

    // Also verify callback-compatible error path
    const cbRes = await fetch(`${baseUrl}/sendfile-callback-check`);
    assert.strictEqual(cbRes.status, 404);
    const cbData = await cbRes.json();
    assert.strictEqual(cbData.handledViaCallback, true);
  });

  it('Finding 5: Cached Bodies Bypass Limits - cached body reads must enforce smaller requested limits', async () => {
    const payload = JSON.stringify({ message: 'A'.repeat(50) }); // ~65 bytes
    const res = await fetch(`${baseUrl}/cached-body-limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: payload
    });

    // Should return HTTP 413 because the second read requested a 10-byte limit
    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error.statusCode, 413);
    assert.ok(data.error.message.includes('Payload Too Large'));
  });

  it('Finding 6: Parameter Names Are Discarded - multiple routes sharing trie node must preserve both parameter names', async () => {
    // 1. Direct Trie test
    const trie = new Trie();
    const h1 = () => 'h1';
    const h2 = () => 'h2';

    trie.insert('/items/:id', [h1]);
    trie.insert('/items/:name', [h2]);

    const match = trie.search('/items/99');
    assert.ok(match);
    assert.strictEqual(match.params.id, '99');
    assert.strictEqual(match.params.name, '99');

    // 2. Integration test through server dispatch
    const res = await fetch(`${baseUrl}/param-collision/superstar`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.id, 'superstar');
    assert.strictEqual(data.name, 'superstar');
    assert.strictEqual(data.allParams.id, 'superstar');
    assert.strictEqual(data.allParams.name, 'superstar');
  });
});
