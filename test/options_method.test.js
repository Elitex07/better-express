import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, Router } from '../src/index.js';

describe('options() route method', () => {
  let app;
  let baseUrl;

  before(async () => {
    app = createApp({ trustProxy: true });
    app.options('/app-opts', (req, res) => res.status(200).send('app-options'));
    app.get('/app-opts', (req, res) => res.send('get'));

    const router = new Router({ maxBacktracks: 50 });
    router.options('/:id', (req, res) => res.status(200).send(`router-options ${req.params.id}`));
    app.use('/r', router);

    await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => app.close());

  it('app.options() registers an OPTIONS route instead of the automatic answer', async () => {
    const res = await fetch(`${baseUrl}/app-opts`, { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'app-options');
  });

  it('router.options() registers an OPTIONS route', async () => {
    const res = await fetch(`${baseUrl}/r/42`, { method: 'OPTIONS' });
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'router-options 42');
  });

  it('constructor options live on settings', () => {
    assert.equal(typeof app.options, 'function');
    assert.equal(app.settings.trustProxy, true);
    const router = new Router({ maxBacktracks: 7 });
    assert.equal(typeof router.options, 'function');
    assert.equal(router.settings.maxBacktracks, 7);
  });
});
