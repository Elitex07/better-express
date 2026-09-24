import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_BODY_LIMIT } from './request.js';
import { MIME_TYPES } from './response.js';

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
 * @param {(req: object) => ({ params: object, pipeline: object[], errorHandlers: object[] } | null)} [onRouteBail]
 *   Supplies the next-best route when the last route entered bailed with next('route')
 * @returns {Promise<void>|undefined}
 */
export function runPipeline(req, res, pipeline = [], errorHandlers = [], isRouteMatched = false, onNoMatch = notFound, onRouteBail) {
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

  // next('route') support: items of one route share a non-zero `route` id. If the last
  // route entered bailed out with next('route') and the pipeline ran out, onRouteBail may
  // supply a less specific route (appended to this request's own pipeline arrays);
  // otherwise the request falls through to onNoMatch like an unmatched one.
  let current = null;
  let routeBailed = false;

  const next = (err) => {
    if (err === 'route') {
      const route = current !== null ? current.route : 0;
      if (route) {
        while (index < pipeline.length && pipeline[index].route === route) index++;
        routeBailed = true;
      }
      // Outside a route handler next('route') behaves like next(), as in Express
    } else if (err) {
      return handleError(err);
    }

    if (index >= pipeline.length) {
      if (routeBailed && onRouteBail !== undefined) {
        const fallback = onRouteBail(req);
        if (fallback !== null) {
          for (const item of fallback.pipeline) pipeline.push(item);
          for (const item of fallback.errorHandlers) errorHandlers.push(item);
          req.params = fallback.params;
          return next();
        }
      }
      if (!isRouteMatched || routeBailed) onNoMatch(req, res);
      return;
    }

    const item = pipeline[index++];
    if (item.route) routeBailed = false;
    current = item;
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
      (handler.length === 4 ? errorHandlers : pipeline).push({ prefix: '', handler, route: 1 });
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
  // http-errors convention: `expose` overrides the default (4xx shown, 5xx hidden in production)
  const expose = typeof error.expose === 'boolean' ? error.expose : statusCode < 500;

  const responsePayload = {
    error: {
      message: isProduction && !expose
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
 * @param {string|Array<string|RegExp>|RegExp|boolean|Function} [options.origin='*']
 *   '*', a fixed origin, an allow-list, a RegExp, `true` (reflect request origin),
 *   or `(origin) => boolean|string`.
 * @param {string|string[]} [options.methods]
 * @param {string|string[]} [options.headers] Allowed request headers (default: reflect the
 *   preflight's Access-Control-Request-Headers)
 * @param {string|string[]} [options.exposedHeaders]
 * @param {boolean} [options.credentials]
 * @param {number} [options.maxAge] Preflight cache in seconds
 * @param {boolean} [options.preflightContinue=false] Pass OPTIONS requests on instead of answering 204
 */
export function cors(options = {}) {
  const list = (v) => (Array.isArray(v) ? v.join(',') : v);
  const origin = options.origin ?? '*';
  const methods = list(options.methods) || 'GET,HEAD,PUT,PATCH,POST,DELETE';
  // Unset: reflect Access-Control-Request-Headers on preflight (as Express's cors does)
  const headers = list(options.headers || options.allowedHeaders) || null;
  const exposed = list(options.exposedHeaders) || null;
  const credentials = Boolean(options.credentials);
  const maxAge = options.maxAge !== undefined ? String(options.maxAge) : null;
  // Origin lists may mix exact strings and RegExps
  const allowList = Array.isArray(origin) ? new Set(origin.filter((o) => typeof o === 'string')) : null;
  const allowPatterns = Array.isArray(origin) ? origin.filter((o) => o instanceof RegExp) : null;
  if (credentials && origin === '*') {
    // Reflecting every origin with credentials would let any site read authenticated responses
    throw new TypeError('cors({ credentials: true }) requires an explicit origin (string, array, RegExp, function, or true to reflect)');
  }

  const resolveOrigin = (requestOrigin) => {
    if (origin === '*') return '*';
    if (!requestOrigin) return typeof origin === 'string' ? origin : null;
    if (origin === true) return requestOrigin;
    if (typeof origin === 'string') return origin;
    if (allowList) {
      if (allowList.has(requestOrigin)) return requestOrigin;
      for (const pattern of allowPatterns) {
        pattern.lastIndex = 0;
        if (pattern.test(requestOrigin)) return requestOrigin;
      }
      return null;
    }
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
        if (headers) {
          res.setHeader('Access-Control-Allow-Headers', headers);
        } else {
          appendVary(res, 'Access-Control-Request-Headers');
          const requested = req.headers['access-control-request-headers'];
          if (requested) res.setHeader('Access-Control-Allow-Headers', requested);
        }
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
 * @param {boolean|Array<'br'|'gzip'>} [options.precompressed=false] Serve `file.br` / `file.gz`
 *   siblings when the client accepts that encoding (`true` = `['br', 'gzip']`, in that
 *   preference order). Adds `Vary: Accept-Encoding`.
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
  // Precompressed variants, in server preference order
  let encodings = null;
  if (options.precompressed) {
    encodings = options.precompressed === true ? ['br', 'gzip'] : [...options.precompressed];
    for (const encoding of encodings) {
      if (!PRECOMPRESSED_EXT[encoding]) {
        throw new TypeError(`serveStatic: unsupported precompressed encoding "${encoding}" (use "br" or "gzip")`);
      }
    }
  }

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

    if (encodings !== null) {
      // The representation depends on Accept-Encoding whether or not a variant exists
      appendVary(res, 'Accept-Encoding');
      const variant = await findPrecompressed(fileToServe, req.headers['accept-encoding'], encodings, isInsideRoot);
      if (variant !== null) {
        const type = MIME_TYPES[path.extname(fileToServe).toLowerCase()] || 'application/octet-stream';
        await res.sendFile(variant.path, {
          ...options,
          headers: { 'Content-Encoding': variant.encoding, 'Content-Type': type },
          onError: () => next()
        });
        return;
      }
    }

    await res.sendFile(fileToServe, { ...options, onError: () => next() });
  };
}

const PRECOMPRESSED_EXT = { br: '.br', gzip: '.gz' };

/**
 * Client-acceptable encodings from an Accept-Encoding header, as name -> q.
 * `*` covers unlisted encodings; q=0 excludes.
 */
function parseAcceptEncoding(header) {
  const accepted = new Map();
  if (!header) return accepted;
  for (const part of header.split(',')) {
    const [rawName, ...params] = part.trim().split(';');
    const name = rawName.trim().toLowerCase();
    if (!name) continue;
    let q = 1;
    for (const param of params) {
      const [key, value] = param.trim().split('=');
      if (key.trim().toLowerCase() === 'q') q = Number(value);
    }
    accepted.set(name, Number.isFinite(q) ? q : 0);
  }
  return accepted;
}

/**
 * Pick the first server-preferred encoding the client accepts that has a precompressed
 * sibling file (`file.br`, `file.gz`) inside the root.
 * @returns {Promise<{ path: string, encoding: string } | null>}
 */
async function findPrecompressed(filePath, acceptEncoding, encodings, isInsideRoot) {
  const accepted = parseAcceptEncoding(acceptEncoding);
  if (accepted.size === 0) return null;
  const wildcard = accepted.get('*');
  for (const encoding of encodings) {
    const q = accepted.has(encoding)
      ? accepted.get(encoding)
      : encoding === 'gzip' && accepted.has('x-gzip') ? accepted.get('x-gzip') : wildcard;
    if (!(q > 0)) continue;
    try {
      const candidate = await fs.promises.realpath(filePath + PRECOMPRESSED_EXT[encoding]);
      if (!isInsideRoot(candidate)) continue;
      if ((await fs.promises.stat(candidate)).isFile()) return { path: candidate, encoding };
    } catch {
      // No such variant
    }
  }
  return null;
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
