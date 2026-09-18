import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { cors } from '../src/index.js';
import { startApp } from './helpers.js';

describe('cors() middleware', () => {
  let ctx;

  before(async () => {
    ctx = await startApp((app) => {
      app.use('/list', cors({
        origin: ['https://a.example', /\.b\.example$/],
        credentials: true,
        exposedHeaders: ['X-Total-Count', 'X-Page'],
        maxAge: 600
      }));
      app.get('/list/data', (req, res) => res.json({ ok: true }));

      app.use('/fn', cors({ origin: (o) => o === 'https://fn.example' }));
      app.get('/fn/data', (req, res) => res.json({ ok: true }));

      app.use('/fixed', cors({ origin: 'https://fixed.example', headers: 'X-Custom' }));
      app.get('/fixed/data', (req, res) => res.json({ ok: true }));

      app.use('/continue', cors({ preflightContinue: true }));
      app.options('/continue/data', (req, res) => res.status(200).send('custom-preflight'));
    });
  });

  after(() => ctx.close());

  it('reflects a matching origin from a list and sets Vary: Origin', async () => {
    let res = await fetch(`${ctx.baseUrl}/list/data`, { headers: { origin: 'https://a.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://a.example');
    assert.equal(res.headers.get('access-control-allow-credentials'), 'true');
    assert.equal(res.headers.get('access-control-expose-headers'), 'X-Total-Count,X-Page');
    assert.match(res.headers.get('vary'), /Origin/);

    res = await fetch(`${ctx.baseUrl}/list/data`, { headers: { origin: 'https://api.b.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://api.b.example');
  });

  it('omits CORS headers for a non-matching origin but still serves the request', async () => {
    const res = await fetch(`${ctx.baseUrl}/list/data`, { headers: { origin: 'https://evil.example' } });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
    assert.equal(res.headers.get('access-control-allow-credentials'), null);
  });

  it('supports an origin predicate function', async () => {
    let res = await fetch(`${ctx.baseUrl}/fn/data`, { headers: { origin: 'https://fn.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), 'https://fn.example');
    res = await fetch(`${ctx.baseUrl}/fn/data`, { headers: { origin: 'https://other.example' } });
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  });

  it('reflects Access-Control-Request-Headers on preflight when headers are not configured', async () => {
    const res = await fetch(`${ctx.baseUrl}/list/data`, {
      method: 'OPTIONS',
      headers: {
        origin: 'https://a.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'X-Trace-Id, Content-Type'
      }
    });
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-headers'), 'X-Trace-Id, Content-Type');
    assert.equal(res.headers.get('access-control-max-age'), '600');
    assert.match(res.headers.get('vary'), /Access-Control-Request-Headers/);
  });

  it('uses the configured header list instead of reflecting when provided', async () => {
    const res = await fetch(`${ctx.baseUrl}/fixed/data`, {
      method: 'OPTIONS',
      headers: { origin: 'https://fixed.example', 'access-control-request-headers': 'X-Other' }
    });
    assert.equal(res.headers.get('access-control-allow-headers'), 'X-Custom');
    assert.equal(res.headers.get('vary'), null);
  });

  it('preflightContinue hands OPTIONS to the next handler', async () => {
    const res = await fetch(`${ctx.baseUrl}/continue/data`, { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'custom-preflight');
  });

  it('refuses credentials with wildcard origin at construction time', () => {
    assert.throws(() => cors({ credentials: true }), /credentials: true cannot be combined/);
    assert.throws(() => cors({ origin: '*', credentials: true }), /credentials: true cannot be combined/);
  });
});
