import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_BODY_LIMIT } from './request.js';

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
      if (item.params) {
        req.params = { ...(req.params || {}), ...item.params };
      }
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
    if (item.params) {
      req.params = { ...(req.params || {}), ...item.params };
    }

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

/**
 * Built-in zero-dependency CORS middleware.
 * @param {object} [options]
 */
export function cors(options = {}) {
  const origin = options.origin || '*';
  const methods = options.methods || 'GET,HEAD,PUT,PATCH,POST,DELETE';
  const headers = options.headers || 'Content-Type,Authorization';
  const credentials = options.credentials ? 'true' : null;
  const maxAge = options.maxAge ? String(options.maxAge) : null;

  return (req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Access-Control-Allow-Methods', methods);
    res.setHeader('Access-Control-Allow-Headers', headers);
    if (credentials) res.setHeader('Access-Control-Allow-Credentials', credentials);
    if (maxAge) res.setHeader('Access-Control-Max-Age', maxAge);

    if (req.method === 'OPTIONS') {
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

    const reqPath = req.path;
    if (reqPath.includes('\0')) {
      return res.status(400).send('Bad Request');
    }

    // Check if raw URL contains traversal attempts
    if (req.url && req.url.includes('..')) {
      return res.status(403).send('Forbidden');
    }

    // Strip mount prefix (baseUrl)
    let subPath = reqPath;
    if (req.baseUrl && subPath.startsWith(req.baseUrl)) {
      subPath = subPath.slice(req.baseUrl.length);
    }
    if (!subPath.startsWith('/')) {
      subPath = '/' + subPath;
    }

    if (subPath.includes('..')) {
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
