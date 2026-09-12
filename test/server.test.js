import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/index.js';

describe('BareWeb Server Integration Tests', () => {
  let app;
  let server;
  let baseUrl;

  before(async () => {
    app = createApp();

    // Global middleware to add custom header
    app.use((req, res, next) => {
      res.setHeader('X-Powered-By', 'BareWeb');
      next();
    });

    // Root GET
    app.get('/', (req, res) => {
      res.json({ message: 'Welcome to BareWeb' });
    });

    // Param route
    app.get('/users/:id', (req, res) => {
      res.json({ userId: req.params.id });
    });

    // Query string route
    app.get('/search', (req, res) => {
      res.json({ query: req.query });
    });

    // POST with JSON body parsing
    app.post('/echo', async (req, res) => {
      const body = await req.json();
      res.status(201).json({ received: body });
    });

    // Error route
    app.get('/crash', () => {
      throw new Error('Simulated Crash');
    });

    // Start server on dynamic port (0)
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
  });

  it('should serve GET / with JSON and custom middleware headers', async () => {
    const res = await fetch(`${baseUrl}/`);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(res.headers.get('x-powered-by'), 'BareWeb');
    assert.strictEqual(res.headers.get('content-type'), 'application/json; charset=utf-8');

    const data = await res.json();
    assert.deepStrictEqual(data, { message: 'Welcome to BareWeb' });
  });

  it('should extract dynamic route params', async () => {
    const res = await fetch(`${baseUrl}/users/superstar123`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data, { userId: 'superstar123' });
  });

  it('should parse URL query parameters', async () => {
    const res = await fetch(`${baseUrl}/search?category=books&limit=10`);
    assert.strictEqual(res.status, 200);
    const data = await res.json();
    assert.deepStrictEqual(data.query, { category: 'books', limit: '10' });
  });

  it('should parse JSON body on POST requests', async () => {
    const payload = { title: 'Mini Project', stars: 5 };
    const res = await fetch(`${baseUrl}/echo`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });

    assert.strictEqual(res.status, 201);
    const data = await res.json();
    assert.deepStrictEqual(data, { received: payload });
  });

  it('should return 404 for unhandled routes', async () => {
    const res = await fetch(`${baseUrl}/non-existent`);
    assert.strictEqual(res.status, 404);
    const data = await res.json();
    assert.strictEqual(data.error.statusCode, 404);
  });

  it('should handle unhandled exceptions gracefully with 500 status', async () => {
    const res = await fetch(`${baseUrl}/crash`);
    assert.strictEqual(res.status, 500);
    const data = await res.json();
    assert.strictEqual(data.error.message, 'Simulated Crash');
    assert.strictEqual(data.error.statusCode, 500);
  });
});
