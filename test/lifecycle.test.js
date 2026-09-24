import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/index.js';

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function get(port, agent, path = '/') {
  return new Promise((resolve, reject) => {
    const req = http.get({ host: '127.0.0.1', port, path, agent }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
  });
}

describe('Server lifecycle', () => {
  it('applies keepAliveTimeout / headersTimeout / requestTimeout options', async () => {
    const app = createApp({ keepAliveTimeout: 1234, headersTimeout: 2345, requestTimeout: 3456 });
    const server = await listen(app);
    assert.equal(server.keepAliveTimeout, 1234);
    assert.equal(server.headersTimeout, 2345);
    assert.equal(server.requestTimeout, 3456);
    await app.close();
  });

  it('leaves Node defaults alone when options are not given', async () => {
    const app = createApp();
    const server = await listen(app);
    const plain = http.createServer();
    assert.equal(server.keepAliveTimeout, plain.keepAliveTimeout);
    assert.equal(server.headersTimeout, plain.headersTimeout);
    assert.equal(server.requestTimeout, plain.requestTimeout);
    await app.close();
  });

  it('close() returns a promise, supports callbacks, and is safe when not listening', async () => {
    const app = createApp();
    await app.close(); // never listened
    await new Promise((resolve) => app.close(resolve));

    await listen(app);
    await app.close();
    assert.equal(app.server, null);
  });

  it('does not wait for idle keep-alive connections', async () => {
    const app = createApp({ keepAliveTimeout: 60_000 });
    app.get('/', (req, res) => res.send('ok'));
    const server = await listen(app);
    const agent = new http.Agent({ keepAlive: true });
    const res = await get(server.address().port, agent);
    assert.equal(res.status, 200);

    const start = Date.now();
    await app.close();
    assert.ok(Date.now() - start < 1000, 'idle socket should not delay close');
    agent.destroy();
  });

  it('lets in-flight requests finish and sends Connection: close', async () => {
    const app = createApp();
    let arrived;
    const reached = new Promise((r) => { arrived = r; });
    app.get('/slow', async (req, res) => {
      arrived();
      await new Promise((r) => setTimeout(r, 150));
      res.send('done');
    });
    app.get('/late', (req, res) => res.send('late'));
    const server = await listen(app);
    const port = server.address().port;
    const agent = new http.Agent({ keepAlive: true });

    const pending = get(port, agent, '/slow');
    await reached;
    let closed = false;
    const closing = app.close().then(() => { closed = true; });

    const res = await pending;
    assert.equal(res.status, 200);
    assert.equal(res.body, 'done');
    assert.equal(res.headers.connection, 'close');
    await closing;
    assert.ok(closed);
    agent.destroy();
  });

  it('closes keep-alive sockets whose response had already started when close() was called', async () => {
    const app = createApp({ keepAliveTimeout: 60_000 });
    let arrived;
    const reached = new Promise((r) => { arrived = r; });
    let finish;
    app.get('/stream', (req, res) => {
      res.setHeader('Content-Length', 4);
      res.write('ab'); // headers are out: too late for Connection: close
      arrived();
      finish = () => res.end('cd');
    });
    const server = await listen(app);
    const agent = new http.Agent({ keepAlive: true });

    const pending = get(server.address().port, agent, '/stream');
    await reached;
    const closing = app.close();
    finish();
    const res = await pending;
    assert.equal(res.body, 'abcd');
    assert.equal(res.headers.connection, 'keep-alive');

    const start = Date.now();
    await closing;
    assert.ok(Date.now() - start < 1000, `close() waited ${Date.now() - start}ms for an idle socket`);
    agent.destroy();
  });

  it('force-closes hung connections after the timeout', async () => {
    const app = createApp();
    let arrived;
    const reached = new Promise((r) => { arrived = r; });
    app.get('/hang', () => { arrived(); /* never responds */ });
    const server = await listen(app);

    const pending = get(server.address().port, undefined, '/hang').then(
      () => 'responded',
      (err) => err.code
    );
    await reached;
    const start = Date.now();
    await app.close({ timeout: 100 });
    assert.ok(Date.now() - start < 1000);
    assert.equal(await pending, 'ECONNRESET');
  });

  it('can listen again after close', async () => {
    const app = createApp();
    app.get('/', (req, res) => res.send('again'));
    await listen(app);
    await app.close();
    const server = await listen(app);
    const res = await get(server.address().port);
    assert.equal(res.body, 'again');
    await app.close();
  });
});
