import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startApp } from './helpers.js';

describe('Response helpers', () => {
  let ctx;

  before(async () => {
    ctx = await startApp((app) => {
      app.get('/r1', (req, res) => res.redirect('/target'));
      app.get('/r2', (req, res) => res.redirect('/target', 301));
      app.get('/r3', (req, res) => res.redirect(307, '/target'));
      app.get('/back', (req, res) => res.redirect('back'));
      app.get('/loc', (req, res) => res.location('/elsewhere').status(200).end());
      app.get('/cookie-none-ok', (req, res) => {
        res.cookie('sid', 'abc', { sameSite: 'none', secure: true, priority: 'high', partitioned: true });
        res.end();
      });
      app.get('/cookie-none-bad', (req, res) => {
        res.cookie('sid', 'abc', { sameSite: 'none' });
        res.end();
      });
      app.get('/cookie-bad-samesite', (req, res) => {
        res.cookie('sid', 'abc', { sameSite: 'sideways' });
        res.end();
      });
    });
  });

  after(() => ctx.close());

  it('redirect(url) defaults to 302 with a text body', async () => {
    const res = await fetch(`${ctx.baseUrl}/r1`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    assert.equal(res.headers.get('location'), '/target');
    assert.match(await res.text(), /Redirecting to \/target/);
  });

  it('supports redirect(url, status) and redirect(status, url)', async () => {
    let res = await fetch(`${ctx.baseUrl}/r2`, { redirect: 'manual' });
    assert.equal(res.status, 301);
    assert.equal(res.headers.get('location'), '/target');

    res = await fetch(`${ctx.baseUrl}/r3`, { redirect: 'manual' });
    assert.equal(res.status, 307);
    assert.equal(res.headers.get('location'), '/target');
  });

  it('redirect("back") uses the Referer and falls back to "/"', async () => {
    let res = await fetch(`${ctx.baseUrl}/back`, { redirect: 'manual', headers: { referer: '/came-from' } });
    assert.equal(res.headers.get('location'), '/came-from');

    res = await fetch(`${ctx.baseUrl}/back`, { redirect: 'manual' });
    assert.equal(res.headers.get('location'), '/');
  });

  it('res.location() sets the header without ending the response', async () => {
    const res = await fetch(`${ctx.baseUrl}/loc`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('location'), '/elsewhere');
  });

  it('cookie supports SameSite=None with Secure, Priority and Partitioned', async () => {
    const res = await fetch(`${ctx.baseUrl}/cookie-none-ok`);
    const cookie = res.headers.get('set-cookie');
    assert.match(cookie, /SameSite=None/);
    assert.match(cookie, /Secure/);
    assert.match(cookie, /Priority=High/);
    assert.match(cookie, /Partitioned/);
  });

  it('cookie rejects SameSite=None without Secure and unknown SameSite values', async () => {
    let res = await fetch(`${ctx.baseUrl}/cookie-none-bad`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /secure: true/);

    res = await fetch(`${ctx.baseUrl}/cookie-bad-samesite`);
    assert.equal(res.status, 500);
    assert.match((await res.json()).error.message, /Invalid sameSite/);
  });
});
