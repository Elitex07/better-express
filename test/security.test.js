import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { startApp, withEnv } from './helpers.js';

describe('Error handler hardening', () => {
  it('masks 5xx messages and omits stack in production', async () => {
    const ctx = await startApp((app) => {
      app.get('/boom', () => { throw new Error('secret db connection string leaked'); });
      app.get('/teapot', () => {
        const err = new Error('I am a teapot');
        err.statusCode = 418;
        throw err;
      });
      app.get('/exposed', () => {
        const err = new Error('maintenance window until 03:00');
        err.statusCode = 503;
        err.expose = true;
        throw err;
      });
    });
    try {
      await withEnv('NODE_ENV', 'production', async () => {
        let res = await fetch(`${ctx.baseUrl}/boom`);
        let body = await res.json();
        assert.equal(res.status, 500);
        assert.equal(body.error.message, 'Internal Server Error');
        assert.equal(body.error.stack, undefined);

        // 4xx messages are client-facing by default
        res = await fetch(`${ctx.baseUrl}/teapot`);
        body = await res.json();
        assert.equal(res.status, 418);
        assert.equal(body.error.message, 'I am a teapot');

        // explicit expose opt-in keeps message on 5xx
        res = await fetch(`${ctx.baseUrl}/exposed`);
        body = await res.json();
        assert.equal(res.status, 503);
        assert.equal(body.error.message, 'maintenance window until 03:00');
      });

      // outside production the message + stack are present (dev ergonomics)
      await withEnv('NODE_ENV', 'test', async () => {
        const res = await fetch(`${ctx.baseUrl}/boom`);
        const body = await res.json();
        assert.equal(res.status, 500);
        assert.equal(body.error.message, 'secret db connection string leaked');
        assert.ok(body.error.stack);
      });
    } finally {
      await ctx.close();
    }
  });

  it('coerces out-of-range status codes to 500', async () => {
    const ctx = await startApp((app) => {
      app.get('/weird', () => {
        const err = new Error('bad status');
        err.statusCode = 999;
        throw err;
      });
    });
    try {
      const res = await fetch(`${ctx.baseUrl}/weird`);
      assert.equal(res.status, 500);
    } finally {
      await ctx.close();
    }
  });
});
