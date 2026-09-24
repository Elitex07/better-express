import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, Router } from '../src/index.js';

describe("next('route')", () => {
  let app;
  let baseUrl;
  const calls = [];

  before(async () => {
    app = createApp();

    // Express docs example: skip the rest of this route for id 0
    app.get('/user/:id', (req, res, next) => {
      if (req.params.id === '0') return next('route');
      next();
    }, (req, res) => res.send('regular'));
    app.get('/user/:id', (req, res) => res.send('special'));

    // Middleware registered between the two routes still runs
    app.get('/between', (req, res, next) => next('route'), () => { throw new Error('skipped handler ran'); });
    app.use('/between', (req, res, next) => { calls.push('mw'); next(); });
    app.get('/between', (req, res) => res.send('second'));

    // Every matching route bails out -> 404, not 405 and not a hang
    app.get('/all-bail', (req, res, next) => next('route'));
    app.get('/all-bail', (req, res, next) => next('route'));

    // A route that just calls next() then one that bails -> 404, as Express does
    app.get('/pass-then-bail', (req, res, next) => next());
    app.get('/pass-then-bail', (req, res, next) => next('route'));

    // Async handler bailing after an await
    app.get('/async', async (req, res, next) => {
      await new Promise((r) => setTimeout(r, 5));
      next('route');
    }, () => { throw new Error('skipped handler ran'); });
    app.get('/async', (req, res) => res.send('async-second'));

    // Same param position, different names: both routes live on one trie node
    app.get('/item/:id', (req, res, next) => (/^\d+$/.test(req.params.id) ? res.send(`id ${req.params.id}`) : next('route')));
    app.get('/item/:slug', (req, res) => res.send(`slug ${req.params.slug}`));

    // Inside a mounted router
    const router = new Router();
    router.get('/x', (req, res, next) => next('route'));
    router.get('/x', (req, res) => res.send('router-second'));
    app.use('/r', router);

    // Plain middleware calling next('route') acts like next()
    app.use('/mw-route', (req, res, next) => next('route'));
    app.get('/mw-route', (req, res) => res.send('reached'));

    // Error handler still works after a bail
    app.get('/bail-then-throw', (req, res, next) => next('route'));
    app.get('/bail-then-throw', () => { throw Object.assign(new Error('teapot'), { statusCode: 418 }); });

    // Other methods on the path: bailing GET must not turn into 405
    app.post('/multi', (req, res) => res.send('post'));
    app.get('/multi', (req, res, next) => next('route'));

    // Fallback to less specific patterns: static -> :param -> *wildcard
    app.get('/people/:id', (req, res) => res.send(`param ${req.params.id}`));
    app.get('/people/me', (req, res, next) => (req.headers['x-anon'] ? next('route') : res.send('me')));
    app.get('/deep/:a/:b', (req, res, next) => (req.params.b === 'skip' ? next('route') : res.send('ab')));
    app.get('/deep/*rest', (req, res) => res.send(`rest ${req.params.rest}`));
    app.get('/chain/x', (req, res, next) => next('route'));
    app.get('/chain/:p', (req, res, next) => next('route'));
    app.get('/chain/*', (req, res, next) => next('route'));
    // Fallback honours regex constraints
    app.get('/num/latest', (req, res, next) => next('route'));
    app.get('/num/:n(\\d+)', (req, res) => res.send('digits'));
    app.get('/num/:word', (req, res) => res.send(`word ${req.params.word}`));
    // HEAD falls back through GET routes too
    app.get('/h/fixed', (req, res, next) => next('route'));
    app.get('/h/:x', (req, res) => res.set('X-Route', 'param').send('ok'));

    await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => app.close());

  const get = async (path, init) => {
    const res = await fetch(baseUrl + path, init);
    return { status: res.status, body: await res.text() };
  };

  it('skips the remaining handlers of the current route', async () => {
    assert.deepEqual(await get('/user/0'), { status: 200, body: 'special' });
    assert.deepEqual(await get('/user/5'), { status: 200, body: 'regular' });
  });

  it('continues with middleware registered after the route', async () => {
    calls.length = 0;
    assert.deepEqual(await get('/between'), { status: 200, body: 'second' });
    assert.deepEqual(calls, ['mw']);
  });

  it('answers 404 when every matching route bails out', async () => {
    const res = await get('/all-bail');
    assert.equal(res.status, 404);
    assert.equal((await get('/pass-then-bail')).status, 404);
  });

  it('works from async handlers', async () => {
    assert.deepEqual(await get('/async'), { status: 200, body: 'async-second' });
  });

  it('falls through to a route with differently named params', async () => {
    assert.deepEqual(await get('/item/42'), { status: 200, body: 'id 42' });
    assert.deepEqual(await get('/item/hello'), { status: 200, body: 'slug hello' });
  });

  it('works inside mounted routers', async () => {
    assert.deepEqual(await get('/r/x'), { status: 200, body: 'router-second' });
  });

  it('behaves like next() when called from plain middleware', async () => {
    assert.deepEqual(await get('/mw-route'), { status: 200, body: 'reached' });
  });

  it('is not treated as an error, and later errors still reach the error chain', async () => {
    assert.equal((await get('/bail-then-throw')).status, 418);
  });

  it('gives 404 (not 405) when the method has routes that all bailed', async () => {
    assert.equal((await get('/multi')).status, 404);
    assert.deepEqual(await get('/multi', { method: 'POST' }), { status: 200, body: 'post' });
  });

  it('falls back from a static route to a less specific :param route', async () => {
    assert.deepEqual(await get('/people/me'), { status: 200, body: 'me' });
    assert.deepEqual(await get('/people/me', { headers: { 'x-anon': '1' } }), { status: 200, body: 'param me' });
  });

  it('falls back from :param routes to a wildcard, with fresh params', async () => {
    assert.deepEqual(await get('/deep/a/b'), { status: 200, body: 'ab' });
    assert.deepEqual(await get('/deep/a/skip'), { status: 200, body: 'rest a/skip' });
  });

  it('answers 404 once every candidate bails', async () => {
    assert.equal((await get('/chain/x')).status, 404);
  });

  it('respects regex constraints while falling back', async () => {
    assert.deepEqual(await get('/num/latest'), { status: 200, body: 'word latest' });
    assert.deepEqual(await get('/num/42'), { status: 200, body: 'digits' });
  });

  it('works for HEAD through GET routes', async () => {
    const res = await fetch(`${baseUrl}/h/fixed`, { method: 'HEAD' });
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-route'), 'param');
  });
});
