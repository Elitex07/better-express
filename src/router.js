import { Trie } from './trie.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

export function joinPaths(p1 = '', p2 = '') {
  if (!p1 || p1 === '/') return p2.startsWith('/') ? p2 : `/${p2}`;
  if (!p2 || p2 === '/') return p1.startsWith('/') ? p1 : `/${p1}`;
  const cleanP1 = p1.endsWith('/') ? p1.slice(0, -1) : p1;
  const cleanP2 = p2.startsWith('/') ? p2.slice(1) : p2;
  const joined = `${cleanP1}/${cleanP2}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export class Router {
  constructor() {
    /** @type {Map<string, Trie>} */
    this.trees = new Map();
    for (const method of HTTP_METHODS) {
      this.trees.set(method, new Trie());
    }

    /** @type {Array<{ method: string, path: string, handlers: Function[] }>} */
    this.routes = [];

    /** @type {Array<{ prefix: string, handler: Function, isErrorHandler: boolean }>} */
    this.middlewares = [];
  }

  /**
   * Register middleware with an optional path prefix, or mount a sub-router.
   * @param {string|Function|Router} prefixOrFn 
   * @param  {...Function} fns 
   */
  use(prefixOrFn, ...fns) {
    let prefix = '/';
    let items = [];

    if (typeof prefixOrFn === 'string') {
      prefix = prefixOrFn.endsWith('/') && prefixOrFn.length > 1 
        ? prefixOrFn.slice(0, -1) 
        : prefixOrFn;
      items = fns;
    } else {
      items = [prefixOrFn, ...fns];
    }

    for (const item of items.flat()) {
      if (!item) continue;

      if (item instanceof Router) {
        // Mount sub-router
        this.mount(prefix, item);
      } else if (typeof item === 'function') {
        const isErrorHandler = item.length === 4;
        this.middlewares.push({ prefix, handler: item, isErrorHandler });
      }
    }

    return this;
  }

  /**
   * Mount another Router instance under a path prefix.
   * @param {string} prefix 
   * @param {Router} subRouter 
   */
  mount(prefix, subRouter) {
    // 1. Inherit sub-router middlewares with prefixed path
    for (const mw of subRouter.middlewares) {
      const fullPrefix = joinPaths(prefix, mw.prefix);
      this.middlewares.push({
        prefix: fullPrefix,
        handler: mw.handler,
        isErrorHandler: mw.isErrorHandler
      });
    }

    // 2. Inherit sub-router routes with prefixed path
    for (const route of subRouter.routes) {
      const fullPath = joinPaths(prefix, route.path);
      this.add(route.method, fullPath, ...route.handlers);
    }

    return this;
  }

  /**
   * Register a route handler for a given HTTP method and path.
   * @param {string} method 
   * @param {string} path 
   * @param  {...Function} handlers 
   */
  add(method, path, ...handlers) {
    const upperMethod = method.toUpperCase();
    if (!this.trees.has(upperMethod)) {
      this.trees.set(upperMethod, new Trie());
    }

    const flatHandlers = handlers.flat();
    const trie = this.trees.get(upperMethod);
    trie.insert(path, flatHandlers);

    this.routes.push({
      method: upperMethod,
      path,
      handlers: flatHandlers
    });

    return this;
  }

  /**
   * Find matching handlers and route params for an incoming request.
   * Includes router-scoped middlewares matching the path.
   * @param {string} method 
   * @param {string} pathname 
   * @returns {{ handlers: Function[], params: Record<string, string> } | null}
   */
  find(method, pathname) {
    const upperMethod = (method || 'GET').toUpperCase();
    const trie = this.trees.get(upperMethod);
    if (!trie) return null;

    const match = trie.search(pathname);
    if (!match) return null;

    // Collect matching router middlewares
    const routerMw = [];
    for (const mw of this.middlewares) {
      if (!mw.isErrorHandler) {
        if (mw.prefix === '/' || pathname === mw.prefix || pathname.startsWith(mw.prefix + '/')) {
          routerMw.push(mw.handler);
        }
      }
    }

    return {
      handlers: [...routerMw, ...match.handlers],
      params: match.params
    };
  }

  // Shorthand registration helpers
  get(path, ...handlers) { return this.add('GET', path, ...handlers); }
  post(path, ...handlers) { return this.add('POST', path, ...handlers); }
  put(path, ...handlers) { return this.add('PUT', path, ...handlers); }
  delete(path, ...handlers) { return this.add('DELETE', path, ...handlers); }
  patch(path, ...handlers) { return this.add('PATCH', path, ...handlers); }
  options(path, ...handlers) { return this.add('OPTIONS', path, ...handlers); }
  head(path, ...handlers) { return this.add('HEAD', path, ...handlers); }

  /**
   * Register handler for all standard HTTP methods.
   * @param {string} path 
   * @param  {...Function} handlers 
   */
  all(path, ...handlers) {
    for (const method of HTTP_METHODS) {
      this.add(method, path, ...handlers);
    }
    return this;
  }
}
