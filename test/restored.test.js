// Behaviour that existed before the f489113 rewrite and was restored afterwards.
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import { createApp, cors } from '../src/index.js';

function rawRequest(port, target) {
  return new Promise((resolve, reject) => {
    const client = net.createConnection({ host: '127.0.0.1', port }, () => {
      client.write(`GET ${target} HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let data = '';
    client.on('data', (chunk) => { data += chunk; });
    client.on('end', () => resolve(data));
    client.on('error', reject);
  });
}

function listen(app) {
  return new Promise((resolve) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
  });
}

describe('Restored behaviour', () => {
  let app;
  let baseUrl;

  before(async () => {
    app = createApp();
    const cookieRoute = (options) => (req, res) => {
      try {
        res.cookie('sid', 'abc', options).send('ok');
      } catch (err) {
        res.status(500).send(err.message);
      }
    };
    app.get('/cookie/none-insecure', cookieRoute({ sameSite: 'none' }));
    app.get('/cookie/none-secure', cookieRoute({ sameSite: 'none', secure: true, priority: 'high', partitioned: true }));
    app.get('/cookie/partitioned-insecure', cookieRoute({ partitioned: true }));
    app.get('/cookie/bad-priority', cookieRoute({ priority: 'urgent' }));

    app.get('/location', (req, res) => res.location('/next').send('body'));
    app.get('/redirect', (req, res) => res.redirect('/target'));
    app.get('/back', (req, res) => res.redirect('back'));
    app.get('/redirect-bad', (req, res) => {
      try {
        res.redirect(301);
      } catch (err) {
        res.status(500).send(err.message);
      }
    });

    app.get('/echo', (req, res) => res.json({ path: req.path, search: req.search, query: req.query }));

    app.get('/expose', () => {
      throw Object.assign(new Error('maintenance until 03:00'), { statusCode: 503, expose: true });
    });
    app.get('/hide', () => {
      throw Object.assign(new Error('db password wrong'), { statusCode: 400, expose: false });
    });

    app.use('/cors', cors({ origin: ['https://a.example', /\.b\.example$/], maxAge: 600 }));
    app.get('/cors/data', (req, res) => res.json({ ok: true }));
    app.use('/cors-fixed', cors({ origin: 'https://fixed.example', headers: 'X-Custom' }));
    app.get('/cors-fixed/data', (req, res) => res.json({ ok: true }));

    baseUrl = await listen(app);
  });

  after(() => app.close());

  describe('cookies', () => {
    it('rejects SameSite=None without Secure', async () => {
      const res = await fetch(`${baseUrl}/cookie/none-insecure`);
      assert.equal(res.status, 500);
      assert.match(await res.text(), /must also set secure/);
    });

    it('supports SameSite=None with Secure, Priority and Partitioned', async () => {
      const res = await fetch(`${baseUrl}/cookie/none-secure`);
      assert.equal(res.headers.get('set-cookie'), 'sid=abc; Path=/; Secure; SameSite=None; Priority=High; Partitioned');
    });

    it('rejects Partitioned without Secure and unknown priorities', async () => {
      assert.match(await (await fetch(`${baseUrl}/cookie/partitioned-insecure`)).text(), /Partitioned cookies/);
      assert.match(await (await fetch(`${baseUrl}/cookie/bad-priority`)).text(), /Invalid priority/);
    });
  });

  describe('redirects', () => {
    it('res.location() sets the header without ending the response', async () => {
      const res = await fetch(`${baseUrl}/location`, { redirect: 'manual' });
      assert.equal(res.status, 200);
      assert.equal(res.headers.get('location'), '/next');
      assert.equal(await res.text(), 'body');
    });

    it('redirect(url) defaults to 302 with a text body', async () => {
      const res = await fetch(`${baseUrl}/redirect`, { redirect: 'manual' });
      assert.equal(res.status, 302);
      assert.equal(res.headers.get('location'), '/target');
      assert.equal(await res.text(), 'Found. Redirecting to /target');
    });

    it('redirect("back") uses the Referer and falls back to "/"', async () => {
      let res = await fetch(`${baseUrl}/back`, { redirect: 'manual', headers: { referer: '/came-from' } });
      assert.equal(res.headers.get('location'), '/came-from');
      res = await fetch(`${baseUrl}/back`, { redirect: 'manual' });
      assert.equal(res.headers.get('location'), '/');
    });

    it('redirect() without a URL throws', async () => {
      assert.match(await (await fetch(`${baseUrl}/redirect-bad`)).text(), /requires a URL string/);
    });
  });

  describe('request targets', () => {
    it('ignores empty segments at either end of the path', async () => {
      for (const target of ['/echo//?x=1', '//echo', '/echo///']) {
        const raw = await rawRequest(new URL(baseUrl).port, target);
        assert.match(raw, /HTTP\/1.1 200/, target);
      }
    });

    it('drops fragments and exposes req.search without "?"', async () => {
      const raw = await rawRequest(new URL(baseUrl).port, '/echo?x=1#frag');
      assert.match(raw, /"search":"x=1"/);
      assert.match(raw, /"query":\{"x":"1"\}/);
      const res = await fetch(`${baseUrl}/echo`);
      assert.equal((await res.json()).search, '');
    });
  });

  describe('error exposure', () => {
    it('honours err.expose in production', async () => {
      const previous = process.env.NODE_ENV;
      process.env.NODE_ENV = 'production';
      try {
        let body = await (await fetch(`${baseUrl}/expose`)).json();
        assert.equal(body.error.message, 'maintenance until 03:00');
        body = await (await fetch(`${baseUrl}/hide`)).json();
        assert.equal(body.error.message, 'Bad Request');
      } finally {
        process.env.NODE_ENV = previous;
      }
    });
  });

  describe('cors', () => {
    it('matches RegExps inside an origin list', async () => {
      const res = await fetch(`${baseUrl}/cors/data`, { headers: { origin: 'https://api.b.example' } });
      assert.equal(res.headers.get('access-control-allow-origin'), 'https://api.b.example');
      const denied = await fetch(`${baseUrl}/cors/data`, { headers: { origin: 'https://evil.example' } });
      assert.equal(denied.headers.get('access-control-allow-origin'), null);
    });

    it('reflects requested headers on preflight when none are configured', async () => {
      const res = await fetch(`${baseUrl}/cors/data`, {
        method: 'OPTIONS',
        headers: {
          origin: 'https://a.example',
          'access-control-request-method': 'PUT',
          'access-control-request-headers': 'X-Trace-Id, Content-Type'
        }
      });
      assert.equal(res.status, 204);
      assert.equal(res.headers.get('access-control-allow-headers'), 'X-Trace-Id, Content-Type');
      assert.match(res.headers.get('vary'), /Access-Control-Request-Headers/);
    });

    it('uses the configured header list instead of reflecting', async () => {
      const res = await fetch(`${baseUrl}/cors-fixed/data`, {
        method: 'OPTIONS',
        headers: { origin: 'https://fixed.example', 'access-control-request-headers': 'X-Other' }
      });
      assert.equal(res.headers.get('access-control-allow-headers'), 'X-Custom');
      assert.doesNotMatch(res.headers.get('vary') || '', /Access-Control-Request-Headers/);
    });
  });
});

describe('trustProxy peer lists and predicates', () => {
  const echo = (app) => app.get('/ip', (req, res) => res.json({ ip: req.ip, protocol: req.protocol }));
  const forwarded = { 'x-forwarded-for': '203.0.113.9', 'x-forwarded-proto': 'https' };

  async function ipWith(trustProxy) {
    const app = createApp({ trustProxy });
    echo(app);
    const url = await listen(app);
    try {
      return await (await fetch(`${url}/ip`, { headers: forwarded })).json();
    } finally {
      await app.close();
    }
  }

  it("'loopback' trusts local proxies", async () => {
    assert.deepEqual(await ipWith('loopback'), { ip: '203.0.113.9', protocol: 'https' });
  });

  it('address lists only trust listed peers', async () => {
    assert.equal((await ipWith(['10.0.0.1', '127.0.0.1'])).ip, '203.0.113.9');
    assert.equal((await ipWith('10.0.0.1, 10.0.0.2')).ip, '127.0.0.1');
  });

  it('predicates receive the peer address', async () => {
    const seen = [];
    const result = await ipWith((addr) => { seen.push(addr); return false; });
    assert.equal(result.ip, '127.0.0.1');
    assert.ok(seen.includes('127.0.0.1'));
  });

  it('picks up changes to app.settings.trustProxy', async () => {
    const app = createApp();
    echo(app);
    const url = await listen(app);
    try {
      assert.equal((await (await fetch(`${url}/ip`, { headers: forwarded })).json()).ip, '127.0.0.1');
      app.settings.trustProxy = 'loopback';
      assert.equal((await (await fetch(`${url}/ip`, { headers: forwarded })).json()).ip, '203.0.113.9');
    } finally {
      await app.close();
    }
  });
});
