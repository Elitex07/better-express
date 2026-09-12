import http from 'node:http';
import { Router, HTTP_METHODS, joinPaths } from './router.js';
import { MiddlewareStack } from './middleware.js';
import { decorateRequest } from './request.js';
import { decorateResponse } from './response.js';

export class BareWeb {
  constructor() {
    this.router = new Router();
    this.middleware = new MiddlewareStack();
    this.server = null;

    // Bind handler so it can be passed directly as a callback
    this.handle = this.handle.bind(this);
  }

  /**
   * Register middleware with an optional path prefix, or mount a sub-router/sub-app.
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
        for (const mw of item.middlewares) {
          const fullPrefix = joinPaths(prefix, mw.prefix);
          this.middleware.use(fullPrefix, mw.handler);
        }
        for (const route of item.routes) {
          const fullPath = joinPaths(prefix, route.path);
          this.router.add(route.method, fullPath, ...route.handlers);
        }
      } else if (item instanceof BareWeb) {
        for (const mw of item.middleware.entries) {
          const fullPrefix = joinPaths(prefix, mw.prefix);
          this.middleware.use(fullPrefix, mw.handler);
        }
        for (const route of item.router.routes) {
          const fullPath = joinPaths(prefix, route.path);
          this.router.add(route.method, fullPath, ...route.handlers);
        }
      } else if (typeof item === 'function') {
        this.middleware.use(prefix, item);
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
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  async handle(req, res) {
    const host = req.headers.host || 'localhost';
    const parsedUrl = new URL(req.url, `http://${host}`);
    const pathname = parsedUrl.pathname;

    // Find route in Radix Tree
    const match = this.router.find(req.method, pathname);
    const params = match ? match.params : {};
    const routeHandlers = match ? match.handlers : [];

    // Decorate request and response objects
    decorateRequest(req, params, parsedUrl);
    decorateResponse(res);

    try {
      // Execute middleware and matched route handlers
      await this.middleware.run(req, res, routeHandlers, Boolean(match));
    } catch (err) {
      if (!res.writableEnded) {
        const statusCode = err.statusCode || err.status || 500;
        res.status(statusCode).json({
          error: {
            message: err.message || 'Internal Server Error',
            statusCode
          }
        });
      }
    }
  }

  /**
   * Start listening for connections.
   * @param {number} port 
   * @param {string|Function} [hostOrCallback] 
   * @param {Function} [callback] 
   * @returns {http.Server}
   */
  listen(port, hostOrCallback, callback) {
    let host = '0.0.0.0';
    let cb = callback;

    if (typeof hostOrCallback === 'function') {
      cb = hostOrCallback;
    } else if (typeof hostOrCallback === 'string') {
      host = hostOrCallback;
    }

    this.server = http.createServer(this.handle);
    return this.server.listen(port, host, cb);
  }

  /**
   * Close the running HTTP server.
   * @param {Function} [cb] 
   */
  close(cb) {
    if (this.server) {
      this.server.close(cb);
    } else if (cb) {
      cb();
    }
  }
}

/**
 * Factory function to create a new BareWeb application instance.
 */
export function createApp() {
  return new BareWeb();
}
