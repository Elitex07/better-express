import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { Router, joinPaths } from '../src/router.js';
import { Trie } from '../src/trie.js';

describe('Trie Route Matching', () => {
  it('should match static routes correctly', () => {
    const trie = new Trie();
    const handler = () => 'root';
    const apiHandler = () => 'api';

    trie.insert('/', [handler]);
    trie.insert('/api/v1/health', [apiHandler]);

    const rootMatch = trie.search('/');
    assert.ok(rootMatch);
    assert.strictEqual(rootMatch.handlers[0], handler);
    assert.deepStrictEqual(rootMatch.params, {});

    const apiMatch = trie.search('/api/v1/health');
    assert.ok(apiMatch);
    assert.strictEqual(apiMatch.handlers[0], apiHandler);

    const notFound = trie.search('/api/v1/unknown');
    assert.strictEqual(notFound, null);
  });

  it('should extract single and multiple parameters', () => {
    const trie = new Trie();
    const userHandler = () => 'user';
    const postHandler = () => 'post';

    trie.insert('/users/:id', [userHandler]);
    trie.insert('/users/:userId/posts/:postId', [postHandler]);

    const match1 = trie.search('/users/42');
    assert.ok(match1);
    assert.strictEqual(match1.handlers[0], userHandler);
    assert.strictEqual(match1.params.id, '42');

    const match2 = trie.search('/users/99/posts/abc-123');
    assert.ok(match2);
    assert.strictEqual(match2.handlers[0], postHandler);
    assert.strictEqual(match2.params.userId, '99');
    assert.strictEqual(match2.params.postId, 'abc-123');
  });

  it('should safely decode URL encoded parameter values', () => {
    const trie = new Trie();
    const handler = () => 'user';
    trie.insert('/users/:name', [handler]);

    const match = trie.search('/users/John%20Doe');
    assert.ok(match);
    assert.strictEqual(match.params.name, 'John Doe');
  });

  it('should prioritize static routes over param routes', () => {
    const trie = new Trie();
    const staticHandler = () => 'static';
    const paramHandler = () => 'param';

    trie.insert('/users/me', [staticHandler]);
    trie.insert('/users/:id', [paramHandler]);

    const meMatch = trie.search('/users/me');
    assert.ok(meMatch);
    assert.strictEqual(meMatch.handlers[0], staticHandler);

    const otherMatch = trie.search('/users/someone');
    assert.ok(otherMatch);
    assert.strictEqual(otherMatch.handlers[0], paramHandler);
    assert.strictEqual(otherMatch.params.id, 'someone');
  });

  it('should handle wildcard routes', () => {
    const trie = new Trie();
    const staticFilesHandler = () => 'files';

    trie.insert('/static/*', [staticFilesHandler]);

    const match = trie.search('/static/images/logo.png');
    assert.ok(match);
    assert.strictEqual(match.handlers[0], staticFilesHandler);
    assert.strictEqual(match.params['*'], 'images/logo.png');
  });

  it('should append handlers when registering multiple times on same route', () => {
    const trie = new Trie();
    const h1 = () => 1;
    const h2 = () => 2;

    trie.insert('/items', [h1]);
    trie.insert('/items', [h2]);

    const match = trie.search('/items');
    assert.ok(match);
    assert.strictEqual(match.handlers.length, 2);
    assert.strictEqual(match.handlers[0], h1);
    assert.strictEqual(match.handlers[1], h2);
  });
});

describe('Router Method Dispatching & Sub-Routers', () => {
  it('should distinguish between different HTTP methods on the same path', () => {
    const router = new Router();
    const getHandler = () => 'get';
    const postHandler = () => 'post';

    router.get('/items', getHandler);
    router.post('/items', postHandler);

    const getMatch = router.find('GET', '/items');
    assert.ok(getMatch);
    assert.strictEqual(getMatch.handlers[0], getHandler);

    const postMatch = router.find('POST', '/items');
    assert.ok(postMatch);
    assert.strictEqual(postMatch.handlers[0], postHandler);

    const deleteMatch = router.find('DELETE', '/items');
    assert.strictEqual(deleteMatch, null);
  });

  it('should support mounting sub-routers under a path prefix', () => {
    const parentRouter = new Router();
    const apiRouter = new Router();
    const listUsers = () => 'users';
    const getUser = () => 'user';

    apiRouter.get('/users', listUsers);
    apiRouter.get('/users/:id', getUser);

    parentRouter.use('/api/v1', apiRouter);

    const matchUsers = parentRouter.find('GET', '/api/v1/users');
    assert.ok(matchUsers);
    assert.strictEqual(matchUsers.handlers[0], listUsers);

    const matchUser = parentRouter.find('GET', '/api/v1/users/42');
    assert.ok(matchUser);
    assert.strictEqual(matchUser.params.id, '42');
  });

  it('should prepend router-scoped middleware to matched route handlers', () => {
    const router = new Router();
    const authMw = () => 'auth';
    const handler = () => 'data';

    router.use(authMw);
    router.get('/secure', handler);

    const match = router.find('GET', '/secure');
    assert.ok(match);
    assert.strictEqual(match.handlers.length, 2);
    assert.strictEqual(match.handlers[0], authMw);
    assert.strictEqual(match.handlers[1], handler);
  });

  it('should properly join paths with joinPaths helper', () => {
    assert.strictEqual(joinPaths('/api', '/users'), '/api/users');
    assert.strictEqual(joinPaths('/api/', '/users'), '/api/users');
    assert.strictEqual(joinPaths('/api', 'users'), '/api/users');
    assert.strictEqual(joinPaths('/', '/test'), '/test');
    assert.strictEqual(joinPaths('/api', '/'), '/api');
    assert.strictEqual(joinPaths('', '/test'), '/test');
  });
});
