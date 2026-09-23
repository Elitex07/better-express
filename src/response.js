import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream';

export const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.wasm': 'application/wasm',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg'
};

const JSON_TYPE = 'application/json; charset=utf-8';
const SAME_SITE = { strict: 'Strict', lax: 'Lax', none: 'None' };

/**
 * Validator for a file: size, mtime and ctime (µs) in hex.
 * ctime is included because deploy tools (rsync -t, cp -p, tar) restore mtime, so a
 * same-size replacement would otherwise keep its ETag; ctime changes on every write.
 * @param {fs.Stats} stats
 */
export function fileEtag(stats) {
  const micros = (ms) => Math.round(ms * 1000).toString(16);
  return `"${stats.size.toString(16)}-${micros(stats.mtimeMs)}-${micros(stats.ctimeMs)}"`;
}

const stripWeak = (tag) => (tag.startsWith('W/') ? tag.slice(2) : tag);

/**
 * Evaluate If-None-Match (preferred) or If-Modified-Since against a file's validators.
 * @param {http.IncomingHttpHeaders} headers
 * @param {string|null} etag
 * @param {number|null} mtimeMs
 */
export function isNotModified(headers, etag, mtimeMs) {
  const ifNoneMatch = headers['if-none-match'];
  if (ifNoneMatch !== undefined) {
    // "*" only asks whether the file exists, which needs no ETag
    if (ifNoneMatch.trim() === '*') return true;
    if (!etag) return false;
    const target = stripWeak(etag);
    return ifNoneMatch.split(',').some((tag) => stripWeak(tag.trim()) === target);
  }
  const ifModifiedSince = headers['if-modified-since'];
  if (ifModifiedSince && mtimeMs !== null) {
    const since = Date.parse(ifModifiedSince);
    // HTTP dates have second precision
    return !Number.isNaN(since) && Math.floor(mtimeMs / 1000) * 1000 <= since;
  }
  return false;
}

/**
 * If-Range: honor the Range header only if the validator still matches.
 * @param {string|undefined} ifRange
 * @param {string|null} etag
 * @param {number} mtimeMs
 */
function ifRangeMatches(ifRange, etag, mtimeMs) {
  if (!ifRange) return true;
  if (ifRange.startsWith('"') || ifRange.startsWith('W/')) {
    // Strong comparison: weak validators never match
    return Boolean(etag) && ifRange === etag;
  }
  const date = Date.parse(ifRange);
  return !Number.isNaN(date) && Math.floor(mtimeMs / 1000) * 1000 === date;
}

/**
 * Parse a single `bytes=` range.
 * @param {string} header
 * @param {number} size
 * @returns {{ start: number, end: number } | -1 | null}
 *   the range, -1 when unsatisfiable, or null to ignore the header and send the whole file
 *   (unsupported unit, multiple ranges, or invalid syntax)
 */
export function parseRange(header, size) {
  if (!header.startsWith('bytes=')) return null;
  const spec = header.slice(6).trim();
  if (spec.includes(',')) return null;
  const dash = spec.indexOf('-');
  if (dash === -1) return null;
  const first = spec.slice(0, dash).trim();
  const last = spec.slice(dash + 1).trim();
  const isDigits = (v) => /^\d+$/.test(v);

  let start;
  let end;
  if (first === '') {
    // Suffix range: the final N bytes
    if (!isDigits(last)) return null;
    const length = Number(last);
    if (length === 0 || size === 0) return -1;
    start = Math.max(0, size - length);
    end = size - 1;
  } else {
    if (!isDigits(first) || (last !== '' && !isDigits(last))) return null;
    start = Number(first);
    if (last !== '' && Number(last) < start) return null;
    if (start >= size) return -1;
    end = last === '' ? size - 1 : Math.min(Number(last), size - 1);
  }
  return { start, end };
}

/**
 * Chainable response helpers (status, json, send, html, redirect, cookie, sendFile...).
 *
 * Helpers live on the prototype rather than being re-created per request, which
 * keeps response objects monomorphic and avoids ~15 closure allocations per hit.
 */
export class BareResponse extends http.ServerResponse {
  /**
   * Set HTTP status code (chainable).
   * @param {number} code
   */
  status(code) {
    this.statusCode = code;
    return this;
  }

  /**
   * Set a single response header or multiple headers via an object (chainable).
   * @param {string|Record<string, string|string[]>} nameOrHeaders
   * @param {string|string[]} [val]
   */
  set(nameOrHeaders, val) {
    if (typeof nameOrHeaders === 'object' && nameOrHeaders !== null) {
      for (const key of Object.keys(nameOrHeaders)) {
        this.setHeader(key, nameOrHeaders[key]);
      }
    } else {
      this.setHeader(nameOrHeaders, val);
    }
    return this;
  }

  header(nameOrHeaders, val) {
    return this.set(nameOrHeaders, val);
  }

  /**
   * Set Content-Type header. Accepts a full type or a file extension ("json", ".html").
   * @param {string} type
   */
  type(type) {
    const ext = type.charCodeAt(0) === 46 /* . */ ? type : `.${type}`;
    this.setHeader('Content-Type', type.includes('/') ? type : (MIME_TYPES[ext] || type));
    return this;
  }

  /**
   * Send JSON response.
   * @param {any} data
   */
  json(data) {
    const payload = JSON.stringify(data);
    if (!this.hasHeader('content-type')) {
      this.setHeader('Content-Type', JSON_TYPE);
    }
    // undefined (e.g. res.json(undefined)) serializes to nothing
    if (payload === undefined) {
      this.setHeader('Content-Length', 0);
      this.end();
      return this;
    }
    this.setHeader('Content-Length', Buffer.byteLength(payload));
    this.end(payload);
    return this;
  }

  /**
   * Send arbitrary response (text, buffer, or json).
   * @param {string|Buffer|object|number|boolean} body
   */
  send(body) {
    if (body === null || body === undefined) {
      this.end();
      return this;
    }

    if (typeof body === 'string') {
      if (!this.hasHeader('content-type')) {
        const trimmed = body.trim();
        this.setHeader(
          'Content-Type',
          trimmed.charCodeAt(0) === 60 /* < */ && trimmed.charCodeAt(trimmed.length - 1) === 62 /* > */
            ? 'text/html; charset=utf-8'
            : 'text/plain; charset=utf-8'
        );
      }
      this.setHeader('Content-Length', Buffer.byteLength(body));
      this.end(body);
      return this;
    }

    if (Buffer.isBuffer(body) || body instanceof Uint8Array) {
      if (!this.hasHeader('content-type')) {
        this.setHeader('Content-Type', 'application/octet-stream');
      }
      this.setHeader('Content-Length', body.byteLength);
      this.end(body);
      return this;
    }

    if (typeof body === 'object') {
      return this.json(body);
    }

    return this.send(String(body));
  }

  /**
   * Send HTML response.
   * @param {string} html
   */
  html(html) {
    this.setHeader('Content-Type', 'text/html; charset=utf-8');
    this.setHeader('Content-Length', Buffer.byteLength(html));
    this.end(html);
    return this;
  }

  /**
   * Send status code with standard HTTP status text.
   * @param {number} statusCode
   */
  sendStatus(statusCode) {
    const text = http.STATUS_CODES[statusCode] || String(statusCode);
    this.statusCode = statusCode;
    this.setHeader('Content-Type', 'text/plain; charset=utf-8');
    this.setHeader('Content-Length', Buffer.byteLength(text));
    this.end(text);
    return this;
  }

  /**
   * Set a cookie header.
   * @param {string} name
   * @param {string} val
   * @param {object} [options]
   */
  cookie(name, val, options = {}) {
    let cookieStr = `${encodeURIComponent(name)}=${encodeURIComponent(val)}`;
    if (options.maxAge !== undefined) {
      const maxAge = Math.floor(options.maxAge / 1000);
      cookieStr += `; Max-Age=${maxAge}`;
      if (!options.expires) cookieStr += `; Expires=${new Date(Date.now() + maxAge * 1000).toUTCString()}`;
    }
    if (options.domain) cookieStr += `; Domain=${options.domain}`;
    cookieStr += `; Path=${options.path || '/'}`;
    if (options.expires) cookieStr += `; Expires=${options.expires.toUTCString()}`;
    if (options.httpOnly) cookieStr += '; HttpOnly';
    if (options.secure) cookieStr += '; Secure';
    if (options.sameSite) {
      const sameSite = options.sameSite === true ? 'Strict' : SAME_SITE[String(options.sameSite).toLowerCase()];
      if (!sameSite) throw new TypeError(`Invalid sameSite option: ${options.sameSite}`);
      cookieStr += `; SameSite=${sameSite}`;
    }

    const prev = this.getHeader('Set-Cookie');
    if (!prev) {
      this.setHeader('Set-Cookie', cookieStr);
    } else if (Array.isArray(prev)) {
      this.setHeader('Set-Cookie', [...prev, cookieStr]);
    } else {
      this.setHeader('Set-Cookie', [prev, cookieStr]);
    }
    return this;
  }

  /**
   * Clear a cookie by setting expired date.
   * @param {string} name
   * @param {object} [options]
   */
  clearCookie(name, options = {}) {
    return this.cookie(name, '', { ...options, expires: new Date(1), maxAge: 0 });
  }

  /**
   * Redirect to URL with optional status (default 302).
   * Accepts both `redirect(url, status)` and Express-style `redirect(status, url)`.
   * @param {string|number} urlOrStatus
   * @param {number|string} [statusOrUrl]
   */
  redirect(urlOrStatus, statusOrUrl) {
    let url = urlOrStatus;
    let status = statusOrUrl ?? 302;
    if (typeof urlOrStatus === 'number') {
      status = urlOrStatus;
      url = statusOrUrl;
    }
    this.statusCode = status;
    this.setHeader('Location', encodeURI(url).replace(/%25([0-9A-Fa-f]{2})/g, '%$1'));
    this.setHeader('Content-Length', 0);
    this.end();
    return this;
  }

  /**
   * Stream a file to the response with proper Content-Type.
   * Sends ETag/Last-Modified, answers conditional requests with 304 and single byte
   * ranges with 206 (416 when unsatisfiable). Options: `etag`, `lastModified`,
   * `acceptRanges` (all default true), `cacheControl`, `onError`.
   * Resolves after the response finishes (or after a 404/500 was sent), and never rejects.
   * @param {string} filePath
   * @param {object|Function} [optionsOrCallback]
   * @param {Function} [maybeCallback]
   * @returns {Promise<void>}
   */
  sendFile(filePath, optionsOrCallback = {}, maybeCallback) {
    let options = optionsOrCallback || {};
    let callback = maybeCallback;

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
      options = {};
    }

    const fail = (error, fallback) => {
      if (callback) return callback(error);
      if (options.onError) return options.onError(error);
      if (!this.headersSent) {
        fallback();
      } else if (!this.writableEnded) {
        this.destroy(error);
      }
    };

    return new Promise((resolve) => {
      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          const error = new Error(`File not found: ${filePath}`);
          error.statusCode = 404;
          fail(error, () => this.status(404).json({ error: { message: 'Not Found', statusCode: 404 } }));
          return resolve();
        }

        const req = this.req;
        const method = req ? req.method : 'GET';
        // Validators and ranges only apply to plain successful GET/HEAD responses
        const cacheable = req && this.statusCode === 200 && (method === 'GET' || method === 'HEAD');
        const etag = options.etag === false ? null : fileEtag(stats);
        const lastModified = options.lastModified === false ? null : stats.mtime.toUTCString();

        if (etag) this.setHeader('ETag', etag);
        if (lastModified) this.setHeader('Last-Modified', lastModified);
        if (options.cacheControl) this.setHeader('Cache-Control', options.cacheControl);

        if (cacheable && isNotModified(req.headers, etag, lastModified ? stats.mtimeMs : null)) {
          this.statusCode = 304;
          this.end();
          if (callback) callback(null);
          return resolve();
        }

        const ext = path.extname(filePath).toLowerCase();
        this.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');

        let range = null;
        if (options.acceptRanges !== false) {
          this.setHeader('Accept-Ranges', 'bytes');
          const rangeHeader = cacheable ? req.headers.range : undefined;
          if (rangeHeader && ifRangeMatches(req.headers['if-range'], etag, stats.mtimeMs)) {
            range = parseRange(rangeHeader, stats.size);
          }
        }

        if (range === -1) {
          this.statusCode = 416;
          this.setHeader('Content-Range', `bytes */${stats.size}`);
          this.setHeader('Content-Length', 0);
          this.end();
          if (callback) callback(null);
          return resolve();
        }

        if (range) {
          this.statusCode = 206;
          this.setHeader('Content-Range', `bytes ${range.start}-${range.end}/${stats.size}`);
          this.setHeader('Content-Length', range.end - range.start + 1);
        } else {
          this.setHeader('Content-Length', stats.size);
        }

        if (method === 'HEAD') {
          this.end();
          if (callback) callback(null);
          return resolve();
        }

        // pipeline() destroys the file stream when the client disconnects,
        // so aborted downloads do not leak file descriptors.
        pipeline(fs.createReadStream(filePath, range || undefined), this, (streamErr) => {
          if (streamErr && streamErr.code !== 'ERR_STREAM_PREMATURE_CLOSE') {
            fail(streamErr, () => this.status(500).end('File stream error'));
          } else if (callback) {
            callback(streamErr || null);
          }
          resolve();
        });
      });
    });
  }
}

/**
 * Prepare a response for the BareWeb pipeline. Responses created by a BareWeb
 * server already are BareResponses; foreign ones get their prototype swapped once.
 * @param {http.ServerResponse} res
 */
export function decorateResponse(res) {
  if (!(res instanceof BareResponse)) {
    Object.setPrototypeOf(res, BareResponse.prototype);
  }
  return res;
}
