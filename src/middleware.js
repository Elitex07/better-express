import path from 'node:path';
import fs from 'node:fs';
import { DEFAULT_BODY_LIMIT } from './request.js';

/**
 * Asynchronous middleware runner supporting standard middleware and path prefix filtering.
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
        const isErrorHandler = fn.length === 4;
        this.entries.push({ prefix, handler: fn, isErrorHandler });
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
    
    // Collect all matching middleware + route handlers
    const pipeline = [];
    const errorHandlers = [];

    for (const entry of this.entries) {
      const matchesPrefix = entry.prefix === '/' || pathname === entry.prefix || pathname.startsWith(entry.prefix + '/');
      if (!matchesPrefix) continue;

      if (entry.isErrorHandler) {
        errorHandlers.push(entry.handler);
      } else {
        pipeline.push({ prefix: entry.prefix, handler: entry.handler });
      }
    }

    // Append route-specific handlers
    for (const handler of routeHandlers) {
      if (handler.length === 4) {
        errorHandlers.push(handler);
      } else {
        pipeline.push({ prefix: '', handler });
      }
    }

    await this.runPipeline(req, res, pipeline, errorHandlers, isRouteMatched);
  }

  /**
   * Execute a resolved pipeline of middlewares and route handlers in exact registration sequence.
   * @param {object} req 
   * @param {object} res 
   * @param {Array<{ prefix: string, handler: Function, params?: object }>} pipeline 
   * @param {Array<{ prefix: string, handler: Function, params?: object }>} errorHandlers 
   * @param {boolean} isRouteMatched 
   */
  async runPipeline(req, res, pipeline = [], errorHandlers = [], isRouteMatched = false) {
    const pathname = req.path;
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
      if (item.params) {
        req.params = { ...(req.params || {}), ...item.params };
      }
      const fn = typeof item === 'function' ? item : item.handler;

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
          const errItem = errorHandlers[errIdx++];
          if (errItem.params) {
            req.params = { ...(req.params || {}), ...errItem.params };
          }
          const errFn = typeof errItem === 'function' ? errItem : errItem.handler;
          try {
            const resVal = errFn(e || err, req, res, nextErr);
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

    await next();
  }
}

export function defaultErrorHandler(err, req, res) {
  if (res.writableEnded) return;

  const statusCode = err.statusCode || err.status || 500;
  res.statusCode = statusCode;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  
  const responsePayload = {
    error: {
      message: err.message || 'Internal Server Error',
      statusCode
    }
  };

  if (process.env.NODE_ENV !== 'production' && err.stack) {
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
