import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

describe('HTTP method semantics', () => {
  let ctx;

  before(async () => {
    ctx = await startApp((app) => {
      app.get('/items', (req, res) => res.json({ items: [1, 2, 3] }));
      app.post('/items', (req, res) => res.status(201).json({ ok: true }));
      app.head('/explicit-head', (req, res) => { res.setHeader('X-Head', 'explicit'); res.end(); });
      app.get('/explicit-head', (req, res) => { res.setHeader('X-Head', 'get'); res.end('body'); });
    });
  });

  after(() => ctx.close());

  it('HEAD falls back to the GET route and sends headers without a body', async () => {
    const res = await fetch(`${ctx.baseUrl}/items`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/json; charset=utf-8');
    assert.equal(res.headers.get('content-length'), String(Buffer.byteLength(JSON.stringify({ items: [1, 2, 3] }))));
    assert.equal(await res.text(), '');
  });

  it('an explicit HEAD route takes precedence over GET fallback', async () => {
    const res = await fetch(`${ctx.baseUrl}/explicit-head`, { method: 'HEAD' });
    assert.equal(res.headers.get('x-head'), 'explicit');
  });

  it('returns 405 with Allow when the path exists under other methods', async () => {
    const res = await fetch(`${ctx.baseUrl}/items`, { method: 'DELETE' });
    assert.equal(res.status, 405);
    const allow = res.headers.get('allow').split(', ').sort();
    assert.deepEqual(allow, ['GET', 'HEAD', 'POST']);
    const body = await res.json();
    assert.equal(body.error.statusCode, 405);
  });

  it('answers OPTIONS automatically with Allow when no OPTIONS route exists', async () => {
    const res = await fetch(`${ctx.baseUrl}/items`, { method: 'OPTIONS' });
    assert.equal(res.status, 204);
    assert.ok(res.headers.get('allow').includes('POST'));
  });

  it('still returns 404 for completely unknown paths', async () => {
    const res = await fetch(`${ctx.baseUrl}/nope`, { method: 'DELETE' });
    assert.equal(res.status, 404);
    assert.equal(res.headers.get('allow'), null);
  });
});

describe('app.options() / router.options() registration', () => {
  it('is callable (constructor option storage must not shadow the route method)', async () => {
    const ctx = await startApp((app) => {
      app.options('/thing', (req, res) => res.status(200).send('opts'));
    }, { maxBacktracks: 10 });
    try {
      const res = await fetch(`${ctx.baseUrl}/thing`, { method: 'OPTIONS' });
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'opts');
      assert.equal(ctx.app.config.maxBacktracks, 10);
    } finally {
      await ctx.close();
    }
  });
});
