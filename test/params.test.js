import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { Trie } from '../src/trie.js';
import { createApp, Router } from '../src/index.js';

const handler = (name) => Object.assign(() => name, { label: name });
const labels = (match) => (match ? match.handlers.map((h) => h.label) : null);

describe('Express 4 parameter syntax (trie)', () => {
  it('optional params match with and without the segment', () => {
    const trie = new Trie();
    trie.insert('/users/:id?', [handler('users')]);

    let match = trie.search('/users');
    assert.deepEqual(labels(match), ['users']);
    assert.ok('id' in match.params);
    assert.equal(match.params.id, undefined);

    match = trie.search('/users/42');
    assert.deepEqual(labels(match), ['users']);
    assert.equal(match.params.id, '42');

    assert.equal(trie.search('/users/42/extra'), null);
  });

  it('optional params in the middle of a path', () => {
    const trie = new Trie();
    trie.insert('/files/:dir?/raw', [handler('raw')]);
    assert.equal(trie.search('/files/raw').params.dir, undefined);
    assert.equal(trie.search('/files/docs/raw').params.dir, 'docs');
  });

  it('variants landing on one node count once', () => {
    const trie = new Trie();
    trie.insert('/:a?/:b?', [handler('ab')]);
    // "/x" is reachable as either :a or :b; the first variant (:a) wins, handlers run once
    const match = trie.search('/x');
    assert.deepEqual(labels(match), ['ab']);
    assert.equal(match.params.a, 'x');
    assert.equal(match.params.b, undefined);
    assert.deepEqual(labels(trie.search('/')), ['ab']);
    assert.deepEqual(trie.search('/x/y').params, { a: 'x', b: 'y' });
  });

  it('regex constraints filter matches and backtrack to other routes', () => {
    const trie = new Trie();
    trie.insert('/items/:id(\\d+)', [handler('numeric')]);
    trie.insert('/items/:slug([a-z-]+)', [handler('slug')]);
    trie.insert('/items/:any', [handler('any')]);

    assert.deepEqual(labels(trie.search('/items/42')), ['numeric', 'any']);
    assert.deepEqual(labels(trie.search('/items/hello-world')), ['slug', 'any']);
    assert.deepEqual(labels(trie.search('/items/ABC')), ['any']);
  });

  it('a rejected constraint backtracks into sibling branches', () => {
    const trie = new Trie();
    trie.insert('/v/:id(\\d+)/x', [handler('param')]);
    trie.insert('/v/*rest', [handler('wild')]);
    assert.deepEqual(labels(trie.search('/v/12/x')), ['param']);
    const wild = trie.search('/v/ab/x');
    assert.deepEqual(labels(wild), ['wild']);
    assert.equal(wild.params.rest, 'ab/x');
  });

  it('regexes are anchored, may contain "/" in the definition, and test the raw segment', () => {
    const trie = new Trie();
    trie.insert('/a/:id(\\d+)', [handler('anchored')]);
    assert.equal(trie.search('/a/12x'), null);

    trie.insert('/b/:path(x/y|z)', [handler('slash')]);
    assert.deepEqual(labels(trie.search('/b/z')), ['slash']);

    trie.insert('/c/:name(hello%20world)', [handler('raw')]);
    const match = trie.search('/c/hello%20world');
    assert.deepEqual(labels(match), ['raw']);
    assert.equal(match.params.name, 'hello world'); // params are still decoded
  });

  it('optional + regex combined', () => {
    const trie = new Trie();
    trie.insert('/page/:n(\\d+)?', [handler('page')]);
    assert.equal(trie.search('/page').params.n, undefined);
    assert.equal(trie.search('/page/3').params.n, '3');
    assert.equal(trie.search('/page/x'), null);
  });

  it('invalid regexes fail at registration', () => {
    const trie = new Trie();
    assert.throws(() => trie.insert('/x/:id([)', [handler('bad')]), /Invalid pattern for parameter ":id"/);
  });

  it('keeps optional-param expansion linear for runs of optional segments', () => {
    const trie = new Trie();
    const names = Array.from({ length: 20 }, (_, i) => `p${i}`);
    const start = performance.now();
    trie.insert('/' + names.map((n) => `:${n}?`).join('/'), [handler('many')]);
    assert.ok(performance.now() - start < 100);

    let records = 0;
    (function count(node) {
      records += node.routes.length;
      for (const child of node.staticChildren.values()) count(child);
      if (node.paramChild) count(node.paramChild);
    })(trie.root);
    assert.equal(records, 21); // one per length, not 2^20

    const match = trie.search('/a/b');
    assert.deepEqual(labels(match), ['many']);
    assert.equal(match.params.p0, 'a');
    assert.equal(match.params.p1, 'b');
    assert.ok('p19' in match.params);
  });

  it('keeps variants whose constraints differ, and caps independent optionals', () => {
    const trie = new Trie();
    trie.insert('/:n(\\d+)?/:w([a-z]+)?', [handler('mixed')]);
    assert.equal(trie.search('/42').params.n, '42');
    assert.equal(trie.search('/abc').params.w, 'abc');

    const independent = (count) => '/' + Array.from({ length: count }, (_, i) => `s${i}/:q${i}?`).join('/');
    assert.doesNotThrow(() => trie.insert(independent(8), [handler('eight')]));
    assert.throws(() => trie.insert(independent(9), [handler('nine')]), /more than 256 optional-parameter variants/);
  });

  it('rejects constraints with nested repetition (ReDoS) at registration', () => {
    const trie = new Trie();
    for (const pattern of ['(a+)+', '(a*)*', '(\\d+)*', '(?:x+){2,}', '((ab)+)+', '(a{1,})+', '([a-z]+)*', '(a+|b)+', '(?:\\w+\\s?)+']) {
      assert.throws(() => trie.insert(`/x/:id(${pattern})`, [handler('bad')]), /Unsafe pattern for parameter ":id"/, pattern);
    }
    for (const pattern of ['\\d+', '[a-z-]+', '(foo|bar)+', '\\d{4}', '(a)+', '(a{2})+', '(a?)+', '[(+)]+', '\\(a+\\)+', '(?:x{0,1})+', 'a+b+', '\\d{4}-\\d{2}']) {
      assert.doesNotThrow(() => trie.insert(`/y/:id(${pattern})`, [handler('ok')]), pattern);
    }
  });

  it('the rejected shape really is catastrophic, the accepted flat form is not', () => {
    const nested = /^(?:(a+)+)$/;
    const flat = /^(?:a+)$/;
    const input = 'a'.repeat(22) + '!';
    let start = performance.now();
    flat.test(input);
    const flatMs = performance.now() - start;
    start = performance.now();
    nested.test(input);
    const nestedMs = performance.now() - start;
    assert.ok(nestedMs > flatMs * 50, `nested ${nestedMs.toFixed(2)}ms vs flat ${flatMs.toFixed(3)}ms`);
  });

  it('keeps legacy param names that are not identifiers', () => {
    const trie = new Trie();
    trie.insert('/f/:file.ext', [handler('legacy')]);
    assert.equal(trie.search('/f/readme').params['file.ext'], 'readme');
  });
});

describe('Express 4 parameter syntax (HTTP)', () => {
  let app;
  let baseUrl;

  before(async () => {
    app = createApp();
    app.get('/users/:id?', (req, res) => res.json({ id: req.params.id ?? null }));
    app.get('/orders/:id(\\d+)', (req, res) => res.send(`order ${req.params.id}`));
    app.post('/orders/:id(\\d+)', (req, res) => res.send('created'));
    const router = new Router();
    router.get('/:year(\\d{4})/:slug?', (req, res) => res.json(req.params));
    app.use('/blog', router);
    await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => {
        baseUrl = `http://127.0.0.1:${server.address().port}`;
        resolve();
      });
    });
  });

  after(() => app.close());

  it('serves optional params', async () => {
    assert.deepEqual(await (await fetch(`${baseUrl}/users`)).json(), { id: null });
    assert.deepEqual(await (await fetch(`${baseUrl}/users/7`)).json(), { id: '7' });
  });

  it('404s (not 405) when a constraint rejects the path', async () => {
    assert.equal(await (await fetch(`${baseUrl}/orders/12`)).text(), 'order 12');
    const res = await fetch(`${baseUrl}/orders/abc`);
    assert.equal(res.status, 404);
    const put = await fetch(`${baseUrl}/orders/12`, { method: 'PUT' });
    assert.equal(put.status, 405);
    assert.match(put.headers.get('allow'), /GET/);
  });

  it('works in mounted routers', async () => {
    assert.deepEqual(await (await fetch(`${baseUrl}/blog/2026`)).json(), { year: '2026' });
    assert.deepEqual(await (await fetch(`${baseUrl}/blog/2026/hello`)).json(), { year: '2026', slug: 'hello' });
    assert.equal((await fetch(`${baseUrl}/blog/26/hello`)).status, 404);
  });
});
