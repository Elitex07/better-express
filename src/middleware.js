import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_BODY_LIMIT } from './request.js';

/**
 * Route handlers see their own route's params merged over whatever is already on req.params.
 * In the common single-route case the router hands the same object it already assigned to
 * req.params, so no allocation happens.
 */
function applyParams(req, item) {
  const p = item.params;
  if (p !== null && p !== undefined && p !== req.params) {
    req.params = { ...req.params, ...p };
  }
}

/**
 * Execute a resolved pipeline of middlewares and route handlers in exact registration sequence.
 * Shared by BareWeb.handle; the single place where next()/error propagation semantics live.
 * @param {object} req
 * @param {object} res
 * @param {Array<{ prefix: string, handler: Function, params?: object }>} pipeline
 * @param {Array<{ prefix: string, handler: Function, params?: object }>} errorHandlers
 * @param {boolean} isRouteMatched
 * @param {string[]} [allowedMethods] methods that match the path when the route did not (405 / OPTIONS)
 */
export async function runPipeline(req, res, pipeline, errorHandlers, isRouteMatched, allowedMethods = []) {
  let index = 0;

  const handleErrors = async (err) => {
    if (errorHandlers.length === 0) {
      defaultErrorHandler(err, req, res);
      return;
    }
    let errIdx = 0;
    const nextErr = async (e) => {
      const current = e || err;
      if (errIdx >= errorHandlers.length) {
        defaultErrorHandler(current, req, res);
        return;
      }
      const item = errorHandlers[errIdx++];
      req.baseUrl = item.prefix === '/' ? '' : item.prefix;
      applyParams(req, item);
      try {
        const resVal = item.handler(current, req, res, nextErr);
        if (resVal && typeof resVal.then === 'function') {
          await resVal;
        }
      } catch (unexpected) {
        defaultErrorHandler(unexpected, req, res);
      }
    };
    await nextErr(err);
  };

  const next = async (err) => {
    if (err) {
      return handleErrors(err);
    }

    if (index >= pipeline.length) {
      if (!isRouteMatched && !res.writableEnded) {
        sendUnmatched(req, res, allowedMethods);
      }
      return;
    }

    const item = pipeline[index++];
    req.baseUrl = item.prefix === '/' ? '' : item.prefix;
    applyParams(req, item);

    try {
      const result = item.handler(req, res, next);
      if (result && typeof result.then === 'function') {
        await result;
      }
    } catch (caughtErr) {
      await handleErrors(caughtErr);
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
 * Terminal response when no route handled the request:
 * - path known under other methods + OPTIONS request -> 204 with Allow (automatic preflight/discovery)
 * - path known under other methods                    -> 405 Method Not Allowed with Allow
 * - otherwise                                          -> 404
 */
export function sendUnmatched(req, res, allowedMethods = []) {
  if (allowedMethods.length > 0) {
    const allow = allowedMethods.join(', ');
    res.setHeader('Allow', allow);
    if (req.method === 'OPTIONS') {
      res.statusCode = 204;
      res.setHeader('Content-Length', '0');
      res.end();
      return;
    }
    res.status(405).json({
      error: {
        message: `Method ${req.method} not allowed for ${req.path}`,
        statusCode: 405,
        allow: allowedMethods
      }
    });
    return;
  }

  res.status(404).json({
    error: {
      message: `Cannot ${req.method} ${req.path}`,
      statusCode: 404
    }
  });
}

/**
 * Final error handler. In production, 5xx messages are masked with the generic
 * HTTP status text unless the error opts in via `err.expose = true`, so internal
 * details (DB errors, file paths, ...) never reach clients. Stack traces are
 * only ever included outside production.
 */
export function defaultErrorHandler(err, req, res) {
  if (res.writableEnded) return;

  const isProduction = process.env.NODE_ENV === 'production';
  const rawStatus = Number(err.statusCode || err.status);
  const statusCode = rawStatus >= 400 && rawStatus <= 599 ? rawStatus : 500;
  const expose = typeof err.expose === 'boolean' ? err.expose : statusCode < 500;

  let message = err.message || http.STATUS_CODES[statusCode] || 'Internal Server Error';
  if (isProduction && !expose) {
    message = http.STATUS_CODES[statusCode] || 'Internal Server Error';
  }

  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');

  const responsePayload = {
    error: { message, statusCode }
  };

  if (!isProduction && err.stack) {
    responsePayload.error.stack = err.stack;
  }

  res.end(JSON.stringify(responsePayload));
}

function toHeaderList(value) {
  return Array.isArray(value) ? value.join(',') : value;
}

/**
 * Build an origin resolver from the `origin` option.
 * @returns {{ isStatic: boolean, resolve: (reqOrigin: string|undefined, req: object) => string|false }}
 */
function compileOrigin(origin) {
  if (origin === undefined || origin === true || origin === '*') {
    return { isStatic: true, resolve: () => '*' };
  }
  if (origin === false) {
    return { isStatic: true, resolve: () => false };
  }
  if (typeof origin === 'string') {
    return { isStatic: true, resolve: () => origin };
  }
  if (origin instanceof RegExp) {
    return { isStatic: false, resolve: (reqOrigin) => (reqOrigin && origin.test(reqOrigin) ? reqOrigin : false) };
  }
  if (Array.isArray(origin)) {
    return {
      isStatic: false,
      resolve: (reqOrigin) => {
        if (!reqOrigin) return false;
        for (const o of origin) {
          if (o instanceof RegExp ? o.test(reqOrigin) : o === reqOrigin) return reqOrigin;
        }
        return false;
      }
    };
  }
  if (typeof origin === 'function') {
    return {
      isStatic: false,
      resolve: (reqOrigin, req) => {
        const out = origin(reqOrigin, req);
        if (out === true) return reqOrigin || '*';
        return out || false;
      }
    };
  }
  throw new TypeError('cors(): unsupported "origin" option');
}

/**
 * Built-in zero-dependency CORS middleware.
 * @param {object} [options]
 * @param {string|boolean|RegExp|Array<string|RegExp>|Function} [options.origin='*']
 *   Allowed origin(s). Non-static forms reflect the request Origin when it matches and add `Vary: Origin`.
 *   A function receives (requestOrigin, req) and returns a string, true (reflect) or false.
 * @param {string|string[]} [options.methods='GET,HEAD,PUT,PATCH,POST,DELETE']
 * @param {string|string[]} [options.headers] Allowed request headers; defaults to reflecting
 *   Access-Control-Request-Headers on preflight.
 * @param {string|string[]} [options.exposedHeaders] Access-Control-Expose-Headers
 * @param {boolean} [options.credentials=false]
 * @param {number} [options.maxAge]
 * @param {number} [options.optionsSuccessStatus=204]
 * @param {boolean} [options.preflightContinue=false] Pass OPTIONS to the next handler instead of ending it.
 */
export function cors(options = {}) {
  const { isStatic, resolve } = compileOrigin(options.origin);
  const methods = toHeaderList(options.methods || 'GET,HEAD,PUT,PATCH,POST,DELETE');
  const allowedHeaders = options.headers ? toHeaderList(options.headers) : null;
  const exposedHeaders = options.exposedHeaders ? toHeaderList(options.exposedHeaders) : null;
  const credentials = Boolean(options.credentials);
  const maxAge = options.maxAge !== undefined ? String(options.maxAge) : null;
  const optionsSuccessStatus = options.optionsSuccessStatus || 204;
  const preflightContinue = Boolean(options.preflightContinue);

  if (credentials && isStatic && resolve() === '*') {
    throw new TypeError('cors(): credentials: true cannot be combined with origin "*" (browsers reject it); list explicit origins instead');
  }

  return (req, res, next) => {
    const allowOrigin = resolve(req.headers.origin, req);

    if (!isStatic) {
      // Response depends on the request Origin; tell caches so
      appendVary(res, 'Origin');
    }

    if (allowOrigin) {
      res.setHeader('Access-Control-Allow-Origin', allowOrigin);
      if (credentials) res.setHeader('Access-Control-Allow-Credentials', 'true');
      if (exposedHeaders) res.setHeader('Access-Control-Expose-Headers', exposedHeaders);
    }

    if (req.method === 'OPTIONS') {
      if (allowOrigin) {
        res.setHeader('Access-Control-Allow-Methods', methods);
        const reqHeaders = req.headers['access-control-request-headers'];
        if (allowedHeaders) {
          res.setHeader('Access-Control-Allow-Headers', allowedHeaders);
        } else if (reqHeaders) {
          res.setHeader('Access-Control-Allow-Headers', reqHeaders);
          appendVary(res, 'Access-Control-Request-Headers');
        }
        if (maxAge) res.setHeader('Access-Control-Max-Age', maxAge);
      }
      if (preflightContinue) return next();
      res.statusCode = optionsSuccessStatus;
      res.setHeader('Content-Length', '0');
      return res.end();
    }

    next();
  };
}

/** Append a field to the Vary header without duplicating it. */
function appendVary(res, field) {
  const prev = res.getHeader('Vary');
  if (!prev) {
    res.setHeader('Vary', field);
    return;
  }
  const current = String(prev);
  if (current === '*') return;
  const fields = current.split(',').map((f) => f.trim().toLowerCase());
  if (!fields.includes(field.toLowerCase())) {
    res.setHeader('Vary', `${current}, ${field}`);
  }
}

/**
 * Built-in zero-dependency static file server middleware.
 * @param {string} rootPath Directory path to serve files from
 * @param {object} [options]
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

  return async (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      return next();
    }

    // Strip mount prefix (baseUrl)
    let subPath = req.path;
    if (req.baseUrl && subPath.startsWith(req.baseUrl)) {
      subPath = subPath.slice(req.baseUrl.length);
    }
    if (!subPath.startsWith('/')) {
      subPath = '/' + subPath;
    }

    // Decode percent-encoding so "my%20file.txt" resolves; reject malformed sequences
    try {
      subPath = decodeURIComponent(subPath);
    } catch {
      return res.status(400).send('Bad Request');
    }

    if (subPath.includes('\0')) {
      return res.status(400).send('Bad Request');
    }

    // Reject traversal on exact ".." segments only, so "a..b.txt" or "?q=.." stay valid.
    // path.resolve + the lexical/realpath checks below are the real guard; this is a cheap early exit.
    if (subPath.split('/').includes('..')) {
      return res.status(403).send('Forbidden');
    }

    let filePath = path.resolve(resolvedRoot, '.' + subPath);

    // Lexical check
    if (filePath !== resolvedRoot && !filePath.startsWith(resolvedRoot + path.sep)) {
      return res.status(403).send('Forbidden');
    }

    // Check real path to ensure symlinks inside static root do not escape
    fs.realpath(filePath, async (realErr, realFilePath) => {
      if (realErr) {
        return next();
      }

      const rel = path.relative(realRoot, realFilePath);
      if (rel.startsWith('..') || path.isAbsolute(rel)) {
        return res.status(403).send('Forbidden');
      }

      fs.stat(realFilePath, async (err, stats) => {
        if (err) {
          return next();
        }

        let fileToServe = realFilePath;
        if (stats.isDirectory()) {
          if (!indexFile) return next();
          const candidateIndex = path.join(realFilePath, indexFile);
          try {
            const realIndex = await fs.promises.realpath(candidateIndex);
            const relIndex = path.relative(realRoot, realIndex);
            if (relIndex.startsWith('..') || path.isAbsolute(relIndex)) {
              return res.status(403).send('Forbidden');
            }
            const indexStats = await fs.promises.stat(realIndex);
            if (!indexStats.isFile()) return next();
            fileToServe = realIndex;
          } catch {
            return next();
          }
        } else if (!stats.isFile()) {
          return next();
        }

        try {
          await res.sendFile(fileToServe, options);
        } catch {
          next();
        }
      });
    });
  };
}

/**
 * Express-compatible automatic JSON body parser middleware.
 * @param {object} [options] 
 */
export function json(options = {}) {
  const limit = options.limit || DEFAULT_BODY_LIMIT;
  return async (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/json') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try {
        await req.json(limit);
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}

/**
 * Express-compatible automatic URL-encoded form body parser middleware.
 * @param {object} [options] 
 */
export function urlencoded(options = {}) {
  const limit = options.limit || DEFAULT_BODY_LIMIT;
  return async (req, res, next) => {
    const contentType = req.headers['content-type'] || '';
    if (contentType.includes('application/x-www-form-urlencoded') && ['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) {
      try {
        await req.urlencoded(limit);
      } catch (err) {
        return next(err);
      }
    }
    next();
  };
}
