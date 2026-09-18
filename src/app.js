import http from 'node:http';
import { Router } from './router.js';
import { runPipeline } from './middleware.js';
import { BareWebRequest, decorateRequest, compileTrustProxy } from './request.js';
import { BareWebResponse, decorateResponse } from './response.js';

// host[:port] or [ipv6][:port]; anything else (spaces, unbalanced brackets, slashes) is a 400
const HOST_RE = /^(?:\[[0-9A-Fa-f:.]+\]|[A-Za-z0-9._~%!$&'()*+,;=-]*)(?::\d*)?$/;

export class BareWeb {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks] Deprecated, ignored (see Trie)
   * @param {object} [options.server] Extra options forwarded to http.createServer (keepAliveTimeout, requestTimeout, ...)
   * @param {boolean|Function|string|string[]} [options.trustProxy=false] Whether to honour
   *   X-Forwarded-For / -Proto / -Host headers (req.ip, req.protocol, req.hostname).
   *   Off by default: a client can set these headers freely, so only enable behind a proxy you control.
   */
  constructor(options = {}) {
    this.config = options;
    this.router = new Router(options);
    this._requestOptions = { trustProxy: compileTrustProxy(options.trustProxy) };
    this.server = null;

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

    const host = req.headers.host;
    if (host !== undefined && !HOST_RE.test(host)) {
      return sendBadUrl(res);
    }

    // Fast path: split the raw request-target ourselves instead of running the WHATWG URL
    // parser on every request. Fall back to `new URL()` for anything unusual so semantics
    // (dot-segment removal, absolute-form targets, fragments) stay identical to before.
    const rawUrl = req.url || '/';
    let pathname;
    let search;
    const q = rawUrl.indexOf('?');
    if (q === -1) {
      pathname = rawUrl;
      search = '';
    } else {
      pathname = rawUrl.slice(0, q);
      search = rawUrl.slice(q + 1);
    }

    if (
      pathname.charCodeAt(0) !== 47 /* / */ ||
      pathname.indexOf('/.') !== -1 ||
      pathname.indexOf('//') !== -1 ||
      pathname.indexOf('\\') !== -1 ||
      rawUrl.indexOf('#') !== -1
    ) {
      let parsed;
      try {
        parsed = new URL(rawUrl, `http://${host || 'localhost'}`);
      } catch {
        return sendBadUrl(res);
      }
      pathname = parsed.pathname;
      search = parsed.search ? parsed.search.slice(1) : '';
    }

    const { isRouteMatched, params, pipeline, errorHandlers, allowedMethods } = this.router.resolve(req.method, pathname);

    decorateRequest(req, params, pathname, search, this._requestOptions);

    await runPipeline(req, res, pipeline, errorHandlers, isRouteMatched, allowedMethods);
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

    this.server = this.createServer();
    return this.server.listen(port, host, cb);
  }

  /**
   * Create (but do not start) an http.Server wired to this app. Requests and responses are
   * instantiated directly as BareWebRequest / BareWebResponse so no per-request decoration is needed.
   * Extra node:http server options can be passed via createApp({ server: { keepAliveTimeout, ... } }).
   * @returns {http.Server}
   */
  createServer() {
    return http.createServer(
      { ...(this.config.server || {}), IncomingMessage: BareWebRequest, ServerResponse: BareWebResponse },
      this.handle
    );
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

function sendBadUrl(res) {
  if (!res.writableEnded) {
    res.status(400).json({
      error: {
        message: 'Bad Request: Malformed Host or URL',
        statusCode: 400
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
