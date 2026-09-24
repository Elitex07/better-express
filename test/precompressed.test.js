import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import zlib from 'node:zlib';
import { createApp, serveStatic } from '../src/index.js';

const source = 'console.log("hello from a precompressed file");\n'.repeat(20);

function get(port, target, headers = {}, method = 'GET') {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: target, method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on('error', reject);
    req.end();
  });
}

describe('serveStatic({ precompressed })', () => {
  let dir;
  let app;
  let port;

  before(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bareweb-precompressed-'));
    fs.writeFileSync(path.join(dir, 'app.js'), source);
    fs.writeFileSync(path.join(dir, 'app.js.br'), zlib.brotliCompressSync(source));
    fs.writeFileSync(path.join(dir, 'app.js.gz'), zlib.gzipSync(source));
    fs.writeFileSync(path.join(dir, 'only-gz.css'), 'body{}');
    fs.writeFileSync(path.join(dir, 'only-gz.css.gz'), zlib.gzipSync('body{}'));
    fs.writeFileSync(path.join(dir, 'plain.txt'), 'plain');

    app = createApp();
    app.use('/pre', serveStatic(dir, { precompressed: true }));
    app.use('/gz-first', serveStatic(dir, { precompressed: ['gzip', 'br'] }));
    app.use('/off', serveStatic(dir));
    await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        port = server.address().port;
        resolve();
      });
    });
  });

  after(async () => {
    await app.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('serves the .br variant when the client accepts br', async () => {
    const res = await get(port, '/pre/app.js', { 'accept-encoding': 'gzip, deflate, br' });
    assert.equal(res.status, 200);
    assert.equal(res.headers['content-encoding'], 'br');
    assert.equal(res.headers['content-type'], 'application/javascript; charset=utf-8');
    assert.match(res.headers.vary, /Accept-Encoding/);
    assert.equal(zlib.brotliDecompressSync(res.body).toString(), source);
    assert.equal(Number(res.headers['content-length']), res.body.length);
  });

  it('falls back to gzip when br is not acceptable', async () => {
    let res = await get(port, '/pre/app.js', { 'accept-encoding': 'gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
    assert.equal(zlib.gunzipSync(res.body).toString(), source);

    res = await get(port, '/pre/app.js', { 'accept-encoding': 'br;q=0, gzip;q=0.5' });
    assert.equal(res.headers['content-encoding'], 'gzip');
  });

  it('follows the configured server preference order', async () => {
    const res = await get(port, '/gz-first/app.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(res.headers['content-encoding'], 'gzip');
  });

  it('accepts * as a wildcard', async () => {
    const res = await get(port, '/pre/app.js', { 'accept-encoding': '*' });
    assert.equal(res.headers['content-encoding'], 'br');
  });

  it('serves the original without Accept-Encoding, still with Vary', async () => {
    const res = await get(port, '/pre/app.js');
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), source);
    assert.match(res.headers.vary, /Accept-Encoding/);
  });

  it('serves the original when no acceptable variant exists', async () => {
    let res = await get(port, '/pre/only-gz.css', { 'accept-encoding': 'br' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), 'body{}');

    res = await get(port, '/pre/plain.txt', { 'accept-encoding': 'br, gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.body.toString(), 'plain');
  });

  it('gives variants their own ETag and supports HEAD', async () => {
    const identity = await get(port, '/pre/app.js');
    const br = await get(port, '/pre/app.js', { 'accept-encoding': 'br' });
    assert.notEqual(identity.headers.etag, br.headers.etag);

    const notModified = await get(port, '/pre/app.js', { 'accept-encoding': 'br', 'if-none-match': br.headers.etag });
    assert.equal(notModified.status, 304);

    const head = await get(port, '/pre/app.js', { 'accept-encoding': 'br' }, 'HEAD');
    assert.equal(head.status, 200);
    assert.equal(head.headers['content-encoding'], 'br');
    assert.equal(head.body.length, 0);
  });

  it('is off by default', async () => {
    const res = await get(port, '/off/app.js', { 'accept-encoding': 'br, gzip' });
    assert.equal(res.headers['content-encoding'], undefined);
    assert.equal(res.headers.vary, undefined);
  });

  it('rejects unknown encodings at setup', () => {
    assert.throws(() => serveStatic(dir, { precompressed: ['zstd'] }), /unsupported precompressed encoding "zstd"/);
  });
});
