import { Trie } from './trie.js';

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS', 'HEAD'];

const EMPTY_METHODS = Object.freeze([]);
const EMPTY_PARAMS = Object.freeze({});

function prefixMatches(prefix, pathname) {
  if (prefix === '/') return true;
  if (!pathname.startsWith(prefix)) return false;
  return pathname.length === prefix.length || pathname.charCodeAt(prefix.length) === 47 /* / */;
}

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

    /**
     * Bumped on every registration; cached per-node plans compare against it so a
     * route/middleware added after the first request is still picked up.
     */
    this._version = 0;
    this._unmatchedPlan = null;
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
        this._version++;
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
        this._version++;
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
    this._version++;

    return this;
  }

  /**
   * Resolve execution pipeline (middleware, route handlers, error handlers) in unified registration order.
   *
   * The registration-order interleaving of middleware and the routes terminating at a trie node
   * is fixed for that node, so it is computed once per node (see _planFor) and only the
   * per-request pieces - middleware prefix filtering and route params - are done here.
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

    const pipeline = [];
    const errorHandlers = [];

    if (match === null) {
      // No route for this method: find which methods *do* match so the caller can send 405 / OPTIONS
      const plan = this._unmatchedPlanFor();
      this._applyMiddleware(plan.items, pathname, pipeline, errorHandlers);
      return {
        isRouteMatched: false,
        params: EMPTY_PARAMS,
        pipeline,
        errorHandlers,
        allowedMethods: this.allowedMethodsFor(pathname)
      };
    }

    const { node, segments } = match;
    const plan = this._planFor(node);

    // Per-route params (routes sharing a node may declare different param names)
    const routes = node.routes;
    let params;
    let routeParams;
    if (routes.length === 1) {
      params = routeParams = Trie.extractParams(routes[0], segments, {});
    } else {
      params = {};
      routeParams = new Array(routes.length);
      for (let i = 0; i < routes.length; i++) {
        routeParams[i] = Trie.extractParams(routes[i], segments, {});
        Object.assign(params, routeParams[i]);
      }
    }

    const items = plan.items;
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.routeIdx === -1) {
        if (!prefixMatches(item.prefix, pathname)) continue;
        (item.isErrorHandler ? errorHandlers : pipeline).push(item);
      } else {
        const p = routes.length === 1 ? routeParams : routeParams[item.routeIdx];
        (item.isErrorHandler ? errorHandlers : pipeline).push({ prefix: '', handler: item.handler, params: p });
      }
    }

    return {
      isRouteMatched: true,
      params,
      pipeline,
      errorHandlers,
      allowedMethods: EMPTY_METHODS
    };
  }

  /**
   * Push middleware items whose prefix matches the pathname (used on the unmatched path).
   */
  _applyMiddleware(items, pathname, pipeline, errorHandlers) {
    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (!prefixMatches(item.prefix, pathname)) continue;
      (item.isErrorHandler ? errorHandlers : pipeline).push(item);
    }
  }

  /**
   * Build (or fetch the cached) ordered plan for a trie node: every middleware entry plus the
   * handlers of each route terminating at the node, in registration order. Middleware items are
   * shared, immutable objects reused across requests; route items record which route's params apply.
   * @param {import('./trie.js').TrieNode} node
   */
  _planFor(node) {
    const cached = node.plan;
    if (cached !== null && cached.version === this._version) return cached;

    const routeIndex = new Map();
    for (let i = 0; i < node.routes.length; i++) {
      routeIndex.set(node.routes[i].routeEntry, i);
    }

    const items = [];
    for (const entry of this.stack) {
      if (entry.type === 'middleware') {
        items.push({ prefix: entry.prefix, handler: entry.handler, params: null, isErrorHandler: entry.isErrorHandler, routeIdx: -1 });
      } else {
        const idx = routeIndex.get(entry);
        if (idx === undefined) continue;
        for (const handler of entry.handlers) {
          items.push({ prefix: '', handler, params: null, isErrorHandler: handler.length === 4, routeIdx: idx });
        }
      }
    }

    const plan = { version: this._version, items };
    node.plan = plan;
    return plan;
  }

  _unmatchedPlanFor() {
    const cached = this._unmatchedPlan;
    if (cached !== null && cached.version === this._version) return cached;

    const items = [];
    for (const entry of this.stack) {
      if (entry.type === 'middleware') {
        items.push({ prefix: entry.prefix, handler: entry.handler, params: null, isErrorHandler: entry.isErrorHandler, routeIdx: -1 });
      }
    }
    const plan = { version: this._version, items };
    this._unmatchedPlan = plan;
    return plan;
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
