import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_BODY_LIMIT } from './request.js';

/**
 * Execute a resolved pipeline of middlewares and route handlers in registration order.
 *
 * `next()` is a plain function (not async): synchronous handlers run without any
 * promise allocation, while async handlers get their rejection routed to the error
 * chain. `next()` returns the downstream handler's promise (if any), so
 * `await next()` still waits for async downstream work (Koa-style timing).
 *
 * @param {object} req
 * @param {object} res
 * @param {Array<{ prefix: string, handler: Function }>} pipeline
 * @param {Array<{ prefix: string, handler: Function }>} errorHandlers
 * @param {boolean} isRouteMatched When false and the pipeline runs out, `onNoMatch` is called
 * @param {(req: object, res: object) => void} [onNoMatch] Defaults to a JSON 404
 * @returns {Promise<void>|undefined}
 */
export function runPipeline(req, res, pipeline = [], errorHandlers = [], isRouteMatched = false, onNoMatch = notFound) {
  let index = 0;
  let errIndex = 0;
  // Most recent async step. Middleware may call next() without returning it, so the
  // pipeline's own promise has to follow these instead of the first handler's result.
  let tail = null;
  const track = (promise) => {
    tail = promise;
    return promise;
  };

  const handleError = (err) => {
    if (errIndex >= errorHandlers.length) {
      defaultErrorHandler(err, req, res);
      return;
    }
    const item = errorHandlers[errIndex++];
    req.baseUrl = item.prefix === '/' ? '' : item.prefix;
    // Calling next() without an argument keeps propagating the original error
    const nextErr = (e) => handleError(e || err);
    try {
      const result = item.handler(err, req, res, nextErr);
      if (result && typeof result.then === 'function') {
        return track(result.then(undefined, (unexpected) => defaultErrorHandler(unexpected, req, res)));
      }
    } catch (unexpected) {
      defaultErrorHandler(unexpected, req, res);
    }
  };

  const next = (err) => {
    if (err) return handleError(err);

    if (index >= pipeline.length) {
      if (!isRouteMatched) onNoMatch(req, res);
      return;
    }

    const item = pipeline[index++];
    req.baseUrl = item.prefix === '/' ? '' : item.prefix;

    let result;
    try {
      result = item.handler(req, res, next);
    } catch (thrown) {
      return handleError(thrown);
    }
    if (result && typeof result.then === 'function') {
      return track(result.then(undefined, (rejected) => handleError(rejected ?? new Error('Handler rejected'))));
    }
  };

  const first = next();
  // Fully synchronous pipelines stay promise-free
  if (tail === null) return first;

  // Settle only once no newer async step was started while waiting
  const drain = () => {
    const current = tail;
    return current.then(() => (tail === current ? undefined : drain()));
  };
  return drain();
}

export function notFound(req, res) {
  if (res.headersSent) return;
  const payload = JSON.stringify({
    error: { message: `Cannot ${req.method} ${req.path}`, statusCode: 404 }
  });
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(payload));
  res.end(payload);
}

/**
 * Middleware runner supporting standard middleware and path prefix filtering.
 * Standalone utility; applications dispatch through Router + runPipeline directly.
 */
export class MiddlewareStack {
  constructor() {
    this.entries = []; // Array of { prefix: string, handler: Function, isErrorHandler: boolean }
  }

  /**
   * Register a middleware function with an optional path prefix.
   * @param {string|Function} prefixOrFn
   * @param  {...Function} fns
   */
  use(prefixOrFn, ...fns) {
    let prefix = '/';
    let handlers = [];

    if (typeof prefixOrFn === 'string') {
      prefix = prefixOrFn.endsWith('/') && prefixOrFn.length > 1
        ? prefixOrFn.slice(0, -1)
        : prefixOrFn;
      handlers = fns;
    } else if (typeof prefixOrFn === 'function') {
      handlers = [prefixOrFn, ...fns];
    } else if (Array.isArray(prefixOrFn)) {
      handlers = prefixOrFn.concat(fns);
    }

    for (const fn of handlers.flat()) {
      if (typeof fn === 'function') {
        this.entries.push({ prefix, handler: fn, isErrorHandler: fn.length === 4 });
      }
    }
  }

  /**
   * Run middleware entries matching the pathname, followed by matched route handlers.
   * @param {object} req
   * @param {object} res
   * @param {Function[]} routeHandlers
   * @param {boolean} isRouteMatched
   */
  async run(req, res, routeHandlers = [], isRouteMatched = false) {
    const pathname = req.path;
    const pipeline = [];
    const errorHandlers = [];

    for (const entry of this.entries) {
      const matchesPrefix = entry.prefix === '/' || pathname === entry.prefix || pathname.startsWith(entry.prefix + '/');
      if (!matchesPrefix) continue;
      (entry.isErrorHandler ? errorHandlers : pipeline).push({ prefix: entry.prefix, handler: entry.handler });
    }

    for (const handler of routeHandlers) {
      (handler.length === 4 ? errorHandlers : pipeline).push({ prefix: '', handler });
    }

    await runPipeline(req, res, pipeline, errorHandlers, isRouteMatched);
  }

  /**
   * Execute an already resolved pipeline.
   */
  async runPipeline(req, res, pipeline = [], errorHandlers = [], isRouteMatched = false) {
    const normalize = (list) => list.map((item) => (typeof item === 'function' ? { prefix: '', handler: item } : item));
    await runPipeline(req, res, normalize(pipeline), normalize(errorHandlers), isRouteMatched);
  }
}

/**
 * Final error handler. Uses `err.statusCode`/`err.status` when it is a valid 4xx/5xx
 * code, otherwise 500. In production, 5xx messages and stack traces are not exposed.
 */
export function defaultErrorHandler(err, req, res) {
  if (res.writableEnded) return;
  if (res.headersSent) {
    // Too late to send an error response: abort so the client sees a failure
    res.destroy(err instanceof Error ? err : undefined);
    return;
  }

  const error = err instanceof Error ? err : new Error(String(err ?? 'Unknown error'));
  const rawStatus = Number(error.statusCode ?? error.status);
  const statusCode = Number.isInteger(rawStatus) && rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const isProduction = process.env.NODE_ENV === 'production';

  const responsePayload = {
    error: {
      message: isProduction && statusCode >= 500
        ? http.STATUS_CODES[statusCode] || 'Internal Server Error'
        : error.message || 'Internal Server Error',
      statusCode
    }
  };

  if (!isProduction && error.stack) {
    responsePayload.error.stack = error.stack;
  }

  const body = JSON.stringify(responsePayload);
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Length', Buffer.byteLength(body));
  res.end(body);
}

/**
 * Add a field to the Vary header without dropping values set by earlier middleware.
 * @param {object} res
 * @param {string} field
 */
export function appendVary(res, field) {
  const current = res.getHeader('Vary');
  if (!current) {
    res.setHeader('Vary', field);
    return;
  }
  const value = Array.isArray(current) ? current.join(', ') : String(current);
  const fields = value.split(',').map((f) => f.trim().toLowerCase());
  if (fields.includes('*') || fields.includes(field.toLowerCase())) return;
  res.setHeader('Vary', `${value}, ${field}`);
}

/**
 * Built-in zero-dependency CORS middleware.
 * @param {object} [options]
 * @param {string|string[]|RegExp|boolean|Function} [options.origin='*']
 *   '*', a fixed origin, an allow-list, a RegExp, `true` (reflect request origin),
 *   or `(origin) => boolean|string`.
 * @param {string|string[]} [options.methods]
 * @param {string|string[]} [options.headers] Allowed request headers
 * @param {string|string[]} [options.exposedHeaders]
 * @param {boolean} [options.credentials]
 * @param {number} [options.maxAge] Preflight cache in seconds
 * @param {boolean} [options.preflightContinue=false] Pass OPTIONS requests on instead of answering 204
 */
export function cors(options = {}) {
  const list = (v) => (Array.isArray(v) ? v.join(',') : v);
  const origin = options.origin ?? '*';
  const methods = list(options.methods) || 'GET,HEAD,PUT,PATCH,POST,DELETE';
  const headers = list(options.headers || options.allowedHeaders) || 'Content-Type,Authorization';
  const exposed = list(options.exposedHeaders) || null;
  const credentials = Boolean(options.credentials);
  const maxAge = options.maxAge !== undefined ? String(options.maxAge) : null;
  const allowList = Array.isArray(origin) ? new Set(origin) : null;
  if (credentials && origin === '*') {
    // Reflecting every origin with credentials would let any site read authenticated responses
    throw new TypeError('cors({ credentials: true }) requires an explicit origin (string, array, RegExp, function, or true to reflect)');
  }

  const resolveOrigin = (requestOrigin) => {
    if (origin === '*') return '*';
    if (!requestOrigin) return typeof origin === 'string' ? origin : null;
    if (origin === true) return requestOrigin;
    if (typeof origin === 'string') return origin;
    if (allowList) return allowList.has(requestOrigin) ? requestOrigin : null;
    if (origin instanceof RegExp) {
      // g/y flags make test() stateful across requests
      origin.lastIndex = 0;
      return origin.test(requestOrigin) ? requestOrigin : null;
    }
    if (typeof origin === 'function') {
      const result = origin(requestOrigin);
      if (result === true) return requestOrigin;
      return typeof result === 'string' ? result : null;
    }
    return null;
  };

  return (req, res, next) => {
    const allowedOrigin = resolveOrigin(req.headers.origin);
    if (origin !== '*') appendVary(res, 'Origin');
    if (allowedOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (exposed) res.setHeader('Access-Control-Expose-Headers', exposed);
    }

    if (req.method === 'OPTIONS' && !options.preflightContinue) {
      if (allowedOrigin) {
        res.setHeader('Access-Control-Allow-Methods', methods);
        res.setHeader('Access-Control-Allow-Headers', headers);
        if (maxAge) res.setHeader('Access-Control-Max-Age', maxAge);
      }
      res.statusCode = 204;
      res.setHeader('Content-Length', '0');
      return res.end();
    }

    next();
  };
}

/**
 * Built-in zero-dependency static file server middleware.
 * @param {string} rootPath Directory path to serve files from
 * @param {object} [options]
 * @param {string|false} [options.index='index.html']
 * @param {string} [options.cacheControl] Cache-Control header value
 * @param {boolean} [options.etag=true] Send ETag and answer If-None-Match
 * @param {boolean} [options.lastModified=true] Send Last-Modified and answer If-Modified-Since
 * @param {boolean} [options.acceptRanges=true] Serve byte ranges (206 / 416)
 */
export function serveStatic(rootPath, options = {}) {
  const resolvedRoot = path.resolve(rootPath);
  let realRoot;
  try {
    realRoot = fs.realpathSync(resolvedRoot);
  } catch {
    realRoot = resolvedRoot;
  }
  const indexFile = options.index === false ? null : (options.index || 'index.html');

  const isInsideRoot = (realPath) => {
    const rel = path.relative(realRoot, realPath);
    // Only a real parent-directory component escapes; names like "..notes" are fine
    return rel !== '..' && !rel.startsWith('..' + path.sep) && !path.isAbsolute(rel);
  };

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    // Strip mount prefix (baseUrl)
    let subPath = req.path;
    if (req.baseUrl && subPath.startsWith(req.baseUrl)) {
      subPath = subPath.slice(req.baseUrl.length);
    }

    try {
      subPath = decodeURIComponent(subPath);
    } catch {
      return res.status(400).send('Bad Request');
    }
    if (subPath.includes('\0')) {
      return res.status(400).send('Bad Request');
    }
    // Reject any ".." path segment (checked after decoding, so %2e%2e is caught too)
    if (subPath.split(/[\\/]/).includes('..')) {
      return res.status(403).send('Forbidden');
    }

    const filePath = path.resolve(resolvedRoot, '.' + (subPath.startsWith('/') ? subPath : '/' + subPath));

    // Lexical check
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
      return res.status(403).send('Forbidden');
    }

    let fileToServe;
    let stats;
    try {
      // Real path check: symlinks inside the root must not escape it
      fileToServe = await fs.promises.realpath(filePath);
      if (!isInsideRoot(fileToServe)) return res.status(403).send('Forbidden');
      stats = await fs.promises.stat(fileToServe);

      if (stats.isDirectory()) {
        if (!indexFile) return next();
        fileToServe = await fs.promises.realpath(path.join(fileToServe, indexFile));
        if (!isInsideRoot(fileToServe)) return res.status(403).send('Forbidden');
        stats = await fs.promises.stat(fileToServe);
      }
    } catch {
      return next();
    }
    if (!stats.isFile()) return next();

    await res.sendFile(fileToServe, { ...options, onError: () => next() });
  };
}

const JSON_TYPE_RE = /^application\/(?:[\w.+-]+\+)?json\b/i;
const URLENCODED_TYPE_RE = /^application\/x-www-form-urlencoded\b/i;

function hasBody(req) {
  return req.headers['transfer-encoding'] !== undefined ||
    (req.headers['content-length'] !== undefined && req.headers['content-length'] !== '0');
}

function bodyParser(typeRe, parse, options) {
  const limit = options.limit || DEFAULT_BODY_LIMIT;
  return async (req, res, next) => {
    if (req.body === undefined && hasBody(req) && typeRe.test(req.headers['content-type'] || '')) {
      try {
        await parse(req, limit);
      } catch (err) {
        return next(err);
      }
    }
    return next();
  };
}

/**
 * Express-compatible JSON body parser middleware (also accepts `application/*+json`).
 * @param {object} [options]
 * @param {number} [options.limit] Maximum body size in bytes
 */
export function json(options = {}) {
  return bodyParser(JSON_TYPE_RE, (req, limit) => req.json(limit), options);
}

/**
 * Express-compatible URL-encoded form body parser middleware.
 * @param {object} [options]
 * @param {number} [options.limit] Maximum body size in bytes
 */
export function urlencoded(options = {}) {
  return bodyParser(URLENCODED_TYPE_RE, (req, limit) => req.urlencoded(limit), options);
}
