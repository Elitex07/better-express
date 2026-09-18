import { Trie } from './trie.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

const EMPTY_METHODS = Object.freeze([]);
const EMPTY_PARAMS = Object.freeze({});

export function joinPaths(p1 = '', p2 = '') {
  if (!p1 || p1 === '/') return p2.startsWith('/') ? p2 : `/${p2}`;
  if (!p2 || p2 === '/') return p1.startsWith('/') ? p1 : `/${p1}`;
  const cleanP1 = p1.endsWith('/') ? p1.slice(0, -1) : p1;
  const cleanP2 = p2.startsWith('/') ? p2.slice(1) : p2;
  const joined = `${cleanP1}/${cleanP2}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

export class Router {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks] Deprecated, ignored (see Trie)
   */
  constructor(options = {}) {
    this.config = options;

    /** @type {Map<string, Trie>} */
    this.trees = new Map();
    for (const method of HTTP_METHODS) {
      this.trees.set(method, new Trie(options));
    }

    /**
     * Unified registration sequence of all middlewares and routes.
     * @type {Array<object>}
     */
    this.stack = [];
    this._seq = 0;
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
        // Mount sub-router preserving its internal registration sequence
        this.mount(prefix, item);
      } else if (item && item.router instanceof Router) {
        // Mount BareWeb sub-application preserving its internal registration sequence
        this.mount(prefix, item.router);
      } else if (typeof item === 'function') {
        const isErrorHandler = item.length === 4;
        const entry = {
          type: 'middleware',
          id: ++this._seq,
          prefix,
          handler: item,
          isErrorHandler
        };
        this.stack.push(entry);
      }
    }

    return this;
  }

  /**
   * Mount another Router instance under a path prefix, preserving its exact registration order.
   * @param {string} prefix 
   * @param {Router} subRouter 
   */
  mount(prefix, subRouter) {
    for (const entry of subRouter.stack) {
      if (entry.type === 'middleware') {
        const fullPrefix = joinPaths(prefix, entry.prefix);
        const mwEntry = {
          type: 'middleware',
          id: ++this._seq,
          prefix: fullPrefix,
          handler: entry.handler,
          isErrorHandler: entry.isErrorHandler
        };
        this.stack.push(mwEntry);
      } else if (entry.type === 'route') {
        const fullPath = joinPaths(prefix, entry.path);
        this.add(entry.method, fullPath, ...entry.handlers);
      }
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
      this.trees.set(upperMethod, new Trie(this.config));
    }

    const flatHandlers = handlers.flat();
    if (flatHandlers.length === 0) {
      throw new TypeError(`Route "${upperMethod} ${path}" requires at least one handler function`);
    }

    const routeEntry = {
      type: 'route',
      id: ++this._seq,
      method: upperMethod,
      path,
      handlers: flatHandlers
    };

    const trie = this.trees.get(upperMethod);
    trie.insert(path, flatHandlers, routeEntry);

    this.stack.push(routeEntry);

    return this;
  }

  /**
   * Resolve execution pipeline (middleware, route handlers, error handlers) in unified registration order.
   * @param {string} method 
   * @param {string} pathname 
   */
  resolve(method, pathname) {
    const upperMethod = (method || 'GET').toUpperCase();
    let trie = this.trees.get(upperMethod);
    let match = trie ? trie.lookup(pathname) : null;

    // HEAD falls back to GET (Node discards the body on HEAD automatically)
    if (!match && upperMethod === 'HEAD') {
      trie = this.trees.get('GET');
      match = trie ? trie.lookup(pathname) : null;
    }

    // No route for this method: find which methods *do* match so the caller can send 405 / OPTIONS
    let allowedMethods = EMPTY_METHODS;
    if (!match) {
      allowedMethods = this.allowedMethodsFor(pathname);
    }

    // routeEntry -> params for every route definition terminating at the matched node
    let matchedParams = null;
    let params = EMPTY_PARAMS;
    if (match) {
      matchedParams = new Map();
      params = {};
      for (const route of match.node.routes) {
        const routeParams = Trie.extractParams(route, match.segments, {});
        Object.assign(params, routeParams);
        matchedParams.set(route.routeEntry, routeParams);
      }
    }

    const pipeline = [];
    const errorHandlers = [];

    for (const entry of this.stack) {
      if (entry.type === 'middleware') {
        const matchesPrefix = entry.prefix === '/' || pathname === entry.prefix || pathname.startsWith(entry.prefix + '/');
        if (!matchesPrefix) continue;

        if (entry.isErrorHandler) {
          errorHandlers.push({ prefix: entry.prefix, handler: entry.handler });
        } else {
          pipeline.push({ prefix: entry.prefix, handler: entry.handler });
        }
      } else if (entry.type === 'route' && matchedParams !== null) {
        const routeParams = matchedParams.get(entry);
        if (routeParams !== undefined) {
          for (const handler of entry.handlers) {
            if (handler.length === 4) {
              errorHandlers.push({ prefix: '', handler, params: routeParams });
            } else {
              pipeline.push({ prefix: '', handler, params: routeParams });
            }
          }
        }
      }
    }

    return {
      isRouteMatched: match !== null,
      params,
      pipeline,
      errorHandlers,
      allowedMethods
    };
  }

  /**
   * List HTTP methods that have a route matching `pathname` (used for 405 Allow / automatic OPTIONS).
   * Only called on the miss path, so the extra trie walks never touch matched requests.
   * @param {string} pathname
   * @returns {string[]}
   */
  allowedMethodsFor(pathname) {
    const allowed = [];
    for (const [m, tree] of this.trees) {
      if (tree.lookup(pathname)) allowed.push(m);
    }
    if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD');
    return allowed;
  }

  /**
   * Convenience wrapper over resolve(): flat handler list + params, or null when no route matches.
   * Mainly useful for tests and introspection.
   * @param {string} method 
   * @param {string} pathname 
   * @returns {{ handlers: Function[], params: Record<string, string> } | null}
   */
  find(method, pathname) {
    const { isRouteMatched, params, pipeline } = this.resolve(method, pathname);
    if (!isRouteMatched) return null;

    return {
      handlers: pipeline.map(item => item.handler),
      params
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
