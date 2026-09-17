import http from 'node:http';
import { Router, HTTP_METHODS, joinPaths } from './router.js';
import { MiddlewareStack, defaultErrorHandler } from './middleware.js';
import { decorateRequest } from './request.js';
import { decorateResponse } from './response.js';

export class BareWeb {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks=500] Maximum backtrack steps for Trie route resolution
   */
  constructor(options = {}) {
    this.options = options;
    this.router = new Router(options);
    this.server = null;
    this.middleware = {
      use: (...args) => this.use(...args),
      get entries() {
        return this.router ? this.router.middlewares : [];
      }
    };

    // Bind handler so it can be passed directly as a callback
    this.handle = this.handle.bind(this);
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
   * Safely parses URLs, handles malformed hosts, and dispatches in registration order.
   * @param {http.IncomingMessage} req 
   * @param {http.ServerResponse} res 
   */
  async handle(req, res) {
    decorateResponse(res);

    let parsedUrl;
    try {
      const host = req.headers.host || 'localhost';
      parsedUrl = new URL(req.url, `http://${host}`);
    } catch {
      if (!res.writableEnded) {
        res.status(400).json({
          error: {
            message: 'Bad Request: Malformed Host or URL',
            statusCode: 400
          }
        });
      }
      return;
    }

    const pathname = parsedUrl.pathname;
    const { isRouteMatched, params, pipeline, errorHandlers } = this.router.resolve(req.method, pathname);

    // Decorate request object
    decorateRequest(req, params, parsedUrl);

    let index = 0;

    const next = async (err) => {
      if (err) {
        return handleErrors(err);
      }

      if (index >= pipeline.length) {
        // Reached end of pipeline
        if (!isRouteMatched && !res.writableEnded) {
          res.status(404).json({
            error: {
              message: `Cannot ${req.method} ${pathname}`,
              statusCode: 404
            }
          });
        }
        return;
      }

      const item = pipeline[index++];
      req.baseUrl = item.prefix === '/' ? '' : item.prefix;
      const fn = item.handler;

      try {
        const result = fn(req, res, next);
        if (result && typeof result.then === 'function') {
          await result;
        }
      } catch (catchedErr) {
        await handleErrors(catchedErr);
      }
    };

    const handleErrors = async (err) => {
      if (errorHandlers.length > 0) {
        let errIdx = 0;
        const nextErr = async (e) => {
          if (errIdx >= errorHandlers.length) {
            defaultErrorHandler(e || err, req, res);
            return;
          }
          const item = errorHandlers[errIdx++];
          req.baseUrl = item.prefix === '/' ? '' : item.prefix;
          try {
            const resVal = item.handler(e || err, req, res, nextErr);
            if (resVal && typeof resVal.then === 'function') {
              await resVal;
            }
          } catch (unexpected) {
            defaultErrorHandler(unexpected, req, res);
          }
        };
        await nextErr(err);
      } else {
        defaultErrorHandler(err, req, res);
      }
    };

    try {
      await next();
    } catch (err) {
      if (!res.writableEnded) {
        defaultErrorHandler(err, req, res);
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
 * @param {object} [options]
 */
export function createApp(options) {
  return new BareWeb(options);
}
