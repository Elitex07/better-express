import http from 'node:http';
import { Router } from './router.js';
import { runPipeline, defaultErrorHandler, notFound } from './middleware.js';
import { BareRequest, decorateRequest, parseUrl, isValidHost, compileTrustProxy } from './request.js';
import { BareResponse, decorateResponse } from './response.js';

export class BareWeb {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks] Deprecated and ignored: route search needs no cap
   * @param {boolean|string|string[]|Function} [options.trustProxy=false] Trust X-Forwarded-For /
   *   -Proto / -Host for req.ip, req.protocol and req.hostname: `true`, peer addresses
   *   ('loopback', '10.0.0.2', ...) or `(remoteAddress) => boolean`. Enable only behind a proxy.
   * @param {boolean} [options.methodNotAllowed=true] Answer 405 (with an Allow header) when the
   *   path exists under other methods, and answer OPTIONS automatically. `false` sends 404 instead.
   * @param {number} [options.keepAliveTimeout] ms an idle keep-alive socket stays open
   *   (Node default 5000). Set above your load balancer's idle timeout.
   * @param {number} [options.headersTimeout] ms allowed to receive the full request headers
   *   (Node default 60000).
   * @param {number} [options.requestTimeout] ms allowed to receive the full request
   *   (Node default 300000). `0` disables it.
   */
  constructor(options = {}) {
    this.settings = options;
    this.router = new Router(options);
    this.server = null;
    this._closing = false;
    this._trustProxySource = undefined;
    this._trustProxyFn = undefined;
    this.middleware = {
      use: (...args) => this.use(...args),
      get entries() {
        return this.router ? this.router.middlewares : [];
      }
    };

    // Bind handlers so they can be passed directly as callbacks
    this.handle = this.handle.bind(this);
    this._noMatch = this._noMatch.bind(this);
    this._nextRoute = this._nextRoute.bind(this);
  }

  /**
   * Register middleware with an optional path prefix, or mount a sub-router/sub-app.
   * Preserves exact registration sequence between middlewares and route handlers.
   * @param {string|Function|Router|BareWeb} prefixOrFn 
   * @param  {...Function|Router|BareWeb} fns 
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
        this.router.mount(prefix, item);
      } else if (item instanceof BareWeb) {
        this.router.mount(prefix, item.router);
      } else if (typeof item === 'function') {
        this.router.use(prefix, item);
      }
    }

    return this;
  }

  // HTTP Method helpers
  get(path, ...handlers) { this.router.get(path, ...handlers); return this; }
  post(path, ...handlers) { this.router.post(path, ...handlers); return this; }
  put(path, ...handlers) { this.router.put(path, ...handlers); return this; }
  delete(path, ...handlers) { this.router.delete(path, ...handlers); return this; }
  patch(path, ...handlers) { this.router.patch(path, ...handlers); return this; }
  options(path, ...handlers) { this.router.options(path, ...handlers); return this; }
  head(path, ...handlers) { this.router.head(path, ...handlers); return this; }
  all(path, ...handlers) { this.router.all(path, ...handlers); return this; }

  /**
   * Master request handler that processes incoming HTTP requests.
   * Rejects malformed hosts/targets with 400 and dispatches in registration order.
   * Usable directly as a `node:http` request listener.
   * @param {http.IncomingMessage} req
   * @param {http.ServerResponse} res
   * @returns {Promise<void>|undefined}
   */
  handle(req, res) {
    decorateResponse(res);

    const parsed = isValidHost(req.headers.host) ? parseUrl(req.url || '/') : null;
    if (parsed === null) {
      decorateRequest(req, {}, { pathname: '/', search: '' });
      defaultErrorHandler(
        Object.assign(new Error('Bad Request: Malformed Host or URL'), { statusCode: 400, stack: undefined }),
        req,
        res
      );
      return;
    }

    try {
      const { isRouteMatched, params, pipeline, errorHandlers } = this.router.resolve(req.method, parsed.pathname);
      decorateRequest(req, params, parsed);
      req.app = this;
      return runPipeline(req, res, pipeline, errorHandlers, isRouteMatched, this._noMatch, this._nextRoute);
    } catch (err) {
      // e.g. a route collision introduced by a sub-router registration after startup
      if (!req.path) decorateRequest(req, {}, parsed);
      defaultErrorHandler(err, req, res);
    }
  }

  /**
   * next('route') fallback: the next less specific route for this request, if any.
   * The trie nodes already tried are kept on the request.
   */
  _nextRoute(req) {
    if (req._routeSkip === undefined) req._routeSkip = new Set();
    return this.router.resolveNext(req.method, req.path, req._routeSkip);
  }

  /**
   * Whether X-Forwarded-* from this peer may be trusted. The predicate is recompiled only
   * when `settings.trustProxy` changes.
   * @param {string} remoteAddress
   */
  _trustsProxy(remoteAddress) {
    const option = this.settings.trustProxy;
    if (option !== this._trustProxySource || this._trustProxyFn === undefined) {
      this._trustProxySource = option;
      this._trustProxyFn = compileTrustProxy(option);
    }
    return this._trustProxyFn(remoteAddress);
  }

  /**
   * Called when the pipeline ends without a matching route: automatic OPTIONS,
   * 405 Method Not Allowed when the path exists under other methods, else 404.
   */
  _noMatch(req, res) {
    if (res.headersSent) return;
    if (this.settings.methodNotAllowed !== false) {
      const allowed = this.router.allowedMethods(req.path);
      // The method has routes here but all of them passed with next('route'): plain 404
      if (allowed.length > 0 && !allowed.includes(req.method)) {
        if (!allowed.includes('OPTIONS')) allowed.push('OPTIONS');
        res.setHeader('Allow', allowed.join(', '));
        if (req.method === 'OPTIONS') {
          res.statusCode = 204;
          res.end();
          return;
        }
        const err = new Error(`Method ${req.method} Not Allowed on ${req.path}`);
        err.statusCode = 405;
        err.stack = undefined;
        defaultErrorHandler(err, req, res);
        return;
      }
    }
    notFound(req, res);
  }

  /**
   * Start listening for connections.
   * @param {number} port 
   * @param {string|Function} [hostOrCallback] 
   * @param {Function} [callback] 
   * @returns {http.Server}
   */
  listen(port, hostOrCallback, callback) {
    let host;
    let cb = callback;

    if (typeof hostOrCallback === 'function') {
      cb = hostOrCallback;
    } else if (typeof hostOrCallback === 'string') {
      host = hostOrCallback;
    }

    // Flatten routes now so registration errors (e.g. route collisions) surface at startup
    this.router._ensureCompiled();

    // Build req/res from BareWeb's classes directly, so helpers come from the
    // prototype chain instead of being attached per request.
    this.server = http.createServer(
      { IncomingMessage: BareRequest, ServerResponse: BareResponse },
      this.handle
    );
    for (const key of ['keepAliveTimeout', 'headersTimeout', 'requestTimeout']) {
      if (this.settings[key] !== undefined) this.server[key] = this.settings[key];
    }
    this._closing = false;
    // Without a host, Node listens on :: (IPv4 + IPv6) when available
    return host === undefined
      ? this.server.listen(port, cb)
      : this.server.listen(port, host, cb);
  }

  /**
   * Gracefully close the running HTTP server: stop accepting connections, drop idle
   * keep-alive sockets, and let in-flight requests finish (their responses are sent with
   * `Connection: close`). After `timeout` ms any remaining connections are destroyed.
   *
   * With a callback, errors (e.g. server not running) go to it and the promise resolves;
   * without one, the promise rejects.
   * @param {{ timeout?: number }|Function} [optionsOrCb]
   * @param {Function} [cb]
   * @returns {Promise<void>}
   */
  close(optionsOrCb, cb) {
    let options = {};
    if (typeof optionsOrCb === 'function') {
      cb = optionsOrCb;
    } else if (optionsOrCb) {
      options = optionsOrCb;
    }

    const server = this.server;
    if (!server) {
      if (cb) cb();
      return Promise.resolve();
    }

    this._closing = true;
    return new Promise((resolve, reject) => {
      let timer;
      server.close((err) => {
        clearTimeout(timer);
        if (this.server === server) {
          this.server = null;
          this._closing = false;
        }
        if (cb) {
          cb(err);
          resolve();
        } else if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
      // Node >= 19 does this inside close(); older versions keep idle sockets open
      if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();

      if (options.timeout !== undefined && typeof server.closeAllConnections === 'function') {
        timer = setTimeout(() => server.closeAllConnections(), options.timeout);
        timer.unref();
      }
    });
  }
}

/**
 * Factory function to create a new BareWeb application instance.
 * @param {object} [options]
 */
export function createApp(options) {
  return new BareWeb(options);
}
