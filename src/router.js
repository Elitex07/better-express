import { Trie } from './trie.js';

const EMPTY = [];

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

export function joinPaths(p1 = '', p2 = '') {
  if (!p1 || p1 === '/') return p2.startsWith('/') ? p2 : `/${p2}`;
  if (!p2 || p2 === '/') return p1.startsWith('/') ? p1 : `/${p1}`;
  const cleanP1 = p1.endsWith('/') ? p1.slice(0, -1) : p1;
  const cleanP2 = p2.startsWith('/') ? p2.slice(1) : p2;
  const joined = `${cleanP1}/${cleanP2}`;
  return joined.startsWith('/') ? joined : `/${joined}`;
}

function normalizePrefix(prefix) {
  return prefix.endsWith('/') && prefix.length > 1 ? prefix.slice(0, -1) : prefix;
}

export class Router {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks=500] Maximum backtrack steps for Trie route resolution
   */
  constructor(options = {}) {
    this.options = options;

    /**
     * This router's own registrations, in order. Mounted routers appear as a single
     * `mount` entry, so routes added to them later are still picked up (live mounting).
     * @type {Array<
     *   { type: 'middleware', prefix: string, handler: Function, isErrorHandler: boolean } |
     *   { type: 'route', method: string, path: string, handlers: Function[] } |
     *   { type: 'mount', prefix: string, router: Router }
     * >}
     */
    this.stack = [];

    /** @type {Set<Router>} Routers this one is mounted into */
    this._parents = new Set();

    /** Per-method tries of this router's own routes, used to report route collisions eagerly. */
    this._ownTrees = new Map();

    // Compiled (flattened) view used for request resolution. Rebuilt lazily after any
    // registration here or in a mounted sub-router.
    this._dirty = true;
    this._trees = null;
    this._middlewareEntries = EMPTY;
    this._routes = EMPTY;
    this._middlewares = EMPTY;
  }

  /** Per-method route tries, including mounted sub-routers. */
  get trees() {
    this._ensureCompiled();
    return this._trees;
  }

  /** @type {Array<{ method: string, path: string, handlers: Function[] }>} Flattened routes, including mounted ones */
  get routes() {
    this._ensureCompiled();
    return this._routes;
  }

  /** @type {Array<{ prefix: string, handler: Function, isErrorHandler: boolean }>} Flattened middlewares */
  get middlewares() {
    this._ensureCompiled();
    return this._middlewares;
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
      prefix = normalizePrefix(prefixOrFn);
      items = fns;
    } else {
      items = [prefixOrFn, ...fns];
    }

    for (const item of items.flat()) {
      if (!item) continue;

      if (item instanceof Router) {
        this.mount(prefix, item);
      } else if (item && item.router instanceof Router) {
        // BareWeb sub-application
        this.mount(prefix, item.router);
      } else if (typeof item === 'function') {
        this.stack.push({ type: 'middleware', prefix, handler: item, isErrorHandler: item.length === 4 });
        this._invalidate();
      }
    }

    return this;
  }

  /**
   * Mount another Router under a path prefix. The sub-router runs at this position in the
   * registration order, and routes/middlewares added to it later are picked up too.
   * @param {string} prefix
   * @param {Router} subRouter
   */
  mount(prefix, subRouter) {
    if (subRouter === this || subRouter._contains(this)) {
      throw new Error('Cannot mount a router into itself or one of its own sub-routers');
    }

    const entry = { type: 'mount', prefix: normalizePrefix(prefix), router: subRouter };
    this.stack.push(entry);
    subRouter._parents.add(this);
    this._invalidate();

    // Compile now so route collisions across routers surface at registration time
    try {
      this._compile();
    } catch (err) {
      this.stack.pop();
      if (!this.stack.some((e) => e.type === 'mount' && e.router === subRouter)) {
        subRouter._parents.delete(this);
      }
      this._invalidate();
      throw err;
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
    const flatHandlers = handlers.flat();
    if (flatHandlers.length === 0) {
      throw new TypeError(`Route "${upperMethod} ${path}" requires at least one handler function`);
    }

    let ownTrie = this._ownTrees.get(upperMethod);
    if (!ownTrie) {
      ownTrie = new Trie(this.options);
      this._ownTrees.set(upperMethod, ownTrie);
    }
    ownTrie.insert(path, flatHandlers);

    this.stack.push({ type: 'route', method: upperMethod, path, handlers: flatHandlers });
    this._invalidate();
    return this;
  }

  _invalidate(seen = new Set()) {
    if (seen.has(this)) return;
    seen.add(this);
    this._dirty = true;
    for (const parent of this._parents) parent._invalidate(seen);
  }

  _contains(target) {
    for (const entry of this.stack) {
      if (entry.type === 'mount' && (entry.router === target || entry.router._contains(target))) {
        return true;
      }
    }
    return false;
  }

  _ensureCompiled() {
    if (this._dirty) this._compile();
  }

  /**
   * Flatten this router and all mounted sub-routers into per-method tries plus an
   * ordered middleware list. Entries get increasing ids in registration order, which
   * `resolve()` uses to interleave middlewares and routes.
   */
  _compile() {
    const trees = new Map();
    for (const method of HTTP_METHODS) trees.set(method, new Trie(this.options));
    // Every route regardless of method: lets allowedMethods() rule out a path in one lookup
    const anyMethod = new Trie(this.options);
    const middlewareEntries = [];
    const routes = [];
    const middlewares = [];
    let seq = 0;

    const walk = (router, base) => {
      for (const entry of router.stack) {
        if (entry.type === 'middleware') {
          const prefix = joinPaths(base, entry.prefix);
          middlewareEntries.push({
            type: 'middleware',
            id: ++seq,
            prefix,
            prefixSlash: prefix === '/' ? '/' : prefix + '/',
            handler: entry.handler,
            isErrorHandler: entry.isErrorHandler
          });
          middlewares.push({ prefix, handler: entry.handler, isErrorHandler: entry.isErrorHandler });
        } else if (entry.type === 'route') {
          const path = joinPaths(base, entry.path);
          let trie = trees.get(entry.method);
          if (!trie) {
            trie = new Trie(this.options);
            trees.set(entry.method, trie);
          }
          const routeEntry = { type: 'route', id: ++seq, method: entry.method, path, handlers: entry.handlers };
          trie.insert(path, entry.handlers, routeEntry);
          // Wildcard names may differ between methods; only the path shape matters here
          anyMethod.insert(path.replace(/\/\*.*$/, '/*'), entry.handlers);
          routes.push({ method: entry.method, path, handlers: entry.handlers });
        } else {
          walk(entry.router, joinPaths(base, entry.prefix));
        }
      }
    };
    walk(this, '/');

    this._trees = trees;
    this._anyMethodTrie = anyMethod;
    this._middlewareEntries = middlewareEntries;
    this._routes = routes;
    this._middlewares = middlewares;
    this._dirty = false;
  }

  /**
   * Resolve execution pipeline (middleware, route handlers, error handlers) in unified registration order.
   *
   * Cost is O(path segments + middlewares), independent of how many routes are registered:
   * the trie finds the matching routes, which are then merged with the middleware list by
   * registration id.
   * @param {string} method
   * @param {string} pathname
   */
  resolve(method, pathname) {
    if (this._dirty) this._compile();

    const upperMethod = method ? method.toUpperCase() : 'GET';
    const trie = this._trees.get(upperMethod);
    let match = trie ? trie.search(pathname) : null;
    // HEAD falls back to GET routes (Node omits the body for HEAD responses)
    if (!match && upperMethod === 'HEAD') {
      match = this._trees.get('GET').search(pathname);
    }

    const pipeline = [];
    const errorHandlers = [];
    const middlewares = this._middlewareEntries;
    const matches = match ? match.matches : EMPTY;
    let m = 0;
    let r = 0;

    while (m < middlewares.length || r < matches.length) {
      const mw = middlewares[m];
      const route = matches[r];

      if (route === undefined || (mw !== undefined && mw.id < route.routeEntry.id)) {
        m++;
        if (
          mw.prefix === '/' ||
          pathname === mw.prefix ||
          pathname.startsWith(mw.prefixSlash)
        ) {
          (mw.isErrorHandler ? errorHandlers : pipeline).push({ prefix: mw.prefix, handler: mw.handler });
        }
      } else {
        r++;
        for (const handler of route.handlers) {
          (handler.length === 4 ? errorHandlers : pipeline).push({ prefix: '', handler, params: route.params });
        }
      }
    }

    return {
      isRouteMatched: match !== null,
      params: match ? match.params : {},
      pipeline,
      errorHandlers
    };
  }

  /**
   * HTTP methods that have a route matching `pathname` (HEAD is implied by GET).
   * Used to answer 405 Method Not Allowed and automatic OPTIONS responses.
   * @param {string} pathname
   * @returns {string[]}
   */
  allowedMethods(pathname) {
    if (this._dirty) this._compile();
    if (!this._anyMethodTrie.search(pathname)) return [];
    const allowed = [];
    for (const [method, trie] of this._trees) {
      if (trie.search(pathname)) allowed.push(method);
    }
    if (allowed.includes('GET') && !allowed.includes('HEAD')) allowed.push('HEAD');
    return allowed;
  }

  /**
   * Find matching handlers and route params for an incoming request.
   * Preserves unified registration order between router middlewares and route handlers.
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
