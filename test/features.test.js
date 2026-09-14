import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { createApp, Router, cors, serveStatic, json, urlencoded } from '../src/index.js';

describe('BareWeb Advanced Features Integration Tests', () => {
  let app;
  let server;
  let baseUrl;
  const fixtureDir = path.resolve('test', 'fixtures');
  const fixtureFile = path.join(fixtureDir, 'sample.txt');

  before(async () => {
    // Setup test fixtures
    if (!fs.existsSync(fixtureDir)) {
      fs.mkdirSync(fixtureDir, { recursive: true });
    }
    fs.writeFileSync(fixtureFile, 'Hello BareWeb Static Files!');

    app = createApp();

    // 1. CORS middleware
    app.use(cors({ origin: 'https://example.com' }));

    // 2. Cookie route
    app.get('/set-cookie', (req, res) => {
      res.cookie('token', 'secret123', { httpOnly: true, sameSite: 'strict' });
      res.json({ success: true });
    });

    app.get('/read-cookie', (req, res) => {
      res.json({ cookies: req.cookies });
    });

    // 3. Array & multi-value query strings
    app.get('/multi-query', (req, res) => {
      res.json({ query: req.query });
    });

    // 4. Object headers & sendStatus
    app.get('/multi-headers', (req, res) => {
      res.set({
        'X-Header-One': '1',
        'X-Header-Two': '2'
      }).sendStatus(200);
    });

    // 5. URL-encoded form parsing
    app.post('/form', async (req, res) => {
      const data = await req.urlencoded();
      res.json({ form: data });
    });

    // 6. Payload size limit (413)
    app.post('/small-limit', async (req, res) => {
      // 10 bytes limit
      const body = await req.json(10);
      res.json({ body });
    });

    // 7. Sub-router with scoped middleware
    const apiRouter = new Router();
    apiRouter.use((req, res, next) => {
      res.setHeader('X-Subrouter-Ran', 'true');
      next();
    });
    apiRouter.get('/hello', (req, res) => {
      res.json({ msg: 'from sub-router' });
    });
    apiRouter.get('/user/:name', (req, res) => {
      res.json({ name: req.params.name });
    });
    app.use('/api/v2', apiRouter);

    // 8. Static file serving via serveStatic
    app.use('/public', serveStatic(fixtureDir));

    // 9. res.sendFile
    app.get('/download', (req, res) => {
      res.sendFile(fixtureFile);
    });

    // 10. Scoped error handlers & route isolation
    app.use('/scoped-api', (err, req, res, next) => {
      res.status(500).json({ scopedToApi: true, msg: err.message });
    });
    app.get('/scoped-api/fail', () => {
      throw new Error('error inside scoped api');
    });
    app.get('/admin/fail', () => {
      throw new Error('error inside admin');
    });

    // 11. Sub-router with router-scoped error handler
    const subRouter = new Router();
    subRouter.get('/trigger-err', () => {
      throw new Error('sub-router exception');
    });
    subRouter.use((err, req, res, next) => {
      res.status(502).json({ caughtBySubRouter: true, detail: err.message });
    });
    app.use('/sub-err', subRouter);

    // Start server
    await new Promise((resolve) => {
      server = app.listen(0, '127.0.0.1', () => {
        const port = server.address().port;
        baseUrl = `http://127.0.0.1:${port}`;
        resolve();
      });
    });
  });

  after(async () => {
    await new Promise((resolve) => app.close(resolve));
    // Cleanup fixture
    if (fs.existsSync(fixtureFile)) {
      fs.unlinkSync(fixtureFile);
    }
    if (fs.existsSync(fixtureDir)) {
      fs.rmdirSync(fixtureDir);
    }
  });

  it('should apply CORS headers and handle OPTIONS preflight', async () => {
    const preflight = await fetch(`${baseUrl}/multi-headers`, {
      method: 'OPTIONS'
    });
    assert.strictEqual(preflight.status, 204);
    assert.strictEqual(preflight.headers.get('access-control-allow-origin'), 'https://example.com');
  });

  it('should set and parse cookies properly', async () => {
    // Set cookie
    const setRes = await fetch(`${baseUrl}/set-cookie`);
    assert.strictEqual(setRes.status, 200);
    const cookieHeader = setRes.headers.get('set-cookie');
    assert.ok(cookieHeader.includes('token=secret123'));
    assert.ok(cookieHeader.includes('HttpOnly'));
    assert.ok(cookieHeader.includes('SameSite=Strict'));

    // Read cookie
    const readRes = await fetch(`${baseUrl}/read-cookie`, {
      headers: { Cookie: 'token=secret123; user=alice' }
    });
    const data = await readRes.json();
    assert.deepStrictEqual(data.cookies, { token: 'secret123', user: 'alice' });
  });

  it('should parse multi-value and array query strings into arrays', async () => {
    const res = await fetch(`${baseUrl}/multi-query?filter=books&filter=games&tags[]=js&tags[]=node`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.query.filter, ['books', 'games']);
    assert.deepStrictEqual(data.query.tags, ['js', 'node']);
  });

  it('should set multiple headers using an object and send status with sendStatus()', async () => {
    const res = await fetch(`${baseUrl}/multi-headers`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-header-one'), '1');
    assert.strictEqual(res.headers.get('x-header-two'), '2');
    const text = await res.text();
    assert.strictEqual(text, 'OK');
  });

  it('should parse URL-encoded form submissions', async () => {
    const res = await fetch(`${baseUrl}/form`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'username=prateek&role=engineer&hobbies[]=coding&hobbies[]=hiking'
    });
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.strictEqual(data.form.username, 'prateek');
    assert.strictEqual(data.form.role, 'engineer');
    assert.deepStrictEqual(data.form.hobbies, ['coding', 'hiking']);
  });

  it('should return HTTP 413 when request payload exceeds limit', async () => {
    const bigPayload = JSON.stringify({ message: 'this exceeds 10 bytes limit' });
    const res = await fetch(`${baseUrl}/small-limit`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: bigPayload
    });
    assert.strictEqual(res.status, 413);
    const data = await res.json();
    assert.strictEqual(data.error.statusCode, 413);
    assert.ok(data.error.message.includes('Payload Too Large'));
  });

  it('should route requests to mounted sub-routers with prefix and scoped middleware', async () => {
    const res = await fetch(`${baseUrl}/api/v2/hello`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-subrouter-ran'), 'true');
    const data = await res.json();
    assert.deepStrictEqual(data, { msg: 'from sub-router' });

    // Parameter in sub-router
    const paramRes = await fetch(`${baseUrl}/api/v2/user/Grace%20Hopper`);
    assert.strictEqual(paramRes.status, 200);
    const paramData = await paramRes.json();
    assert.deepStrictEqual(paramData, { name: 'Grace Hopper' });
  });

  it('should serve static files using serveStatic middleware', async () => {
    const res = await fetch(`${baseUrl}/public/sample.txt`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    const content = await res.text();
    assert.strictEqual(content, 'Hello BareWeb Static Files!');
  });

  it('should block directory traversal attacks in serveStatic', async () => {
    const mw = serveStatic(fixtureDir);
    let statusCode;
    const mockRes = {
      status(code) {
        statusCode = code;
        return this;
      },
      send() {
        return this;
      }
    };
    await mw({ method: 'GET', url: '/public/../package.json', path: '/../package.json' }, mockRes, () => {});
    assert.strictEqual(statusCode, 403);
  });

  it('should send files with res.sendFile()', async () => {
    const res = await fetch(`${baseUrl}/download`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('content-type'), 'text/plain; charset=utf-8');
    const content = await res.text();
    assert.strictEqual(content, 'Hello BareWeb Static Files!');
  });

  it('should not invoke error-handling middleware scoped to a different prefix', async () => {
    // GET /admin/fail should not trigger error handler scoped to /scoped-api
    const res = await fetch(`${baseUrl}/admin/fail`);
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.scopedToApi, undefined);
    assert.strictEqual(data.error.message, 'error inside admin');
  });

  it('should invoke error-handling middleware when matching its scoped prefix', async () => {
    // GET /scoped-api/fail should trigger error handler scoped to /scoped-api
    const res = await fetch(`${baseUrl}/scoped-api/fail`);
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.scopedToApi, true);
    assert.strictEqual(data.msg, 'error inside scoped api');
  });

  it('should properly invoke error handlers registered on mounted sub-routers', async () => {
    // GET /sub-err/trigger-err should trigger sub-router's scoped error handler
    const res = await fetch(`${baseUrl}/sub-err/trigger-err`);
    assert.strictEqual(res.status, 502);
    const data = await res.json();
    assert.strictEqual(data.caughtBySubRouter, true);
    assert.strictEqual(data.detail, 'sub-router exception');
  });
});
