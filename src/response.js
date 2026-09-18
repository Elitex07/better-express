import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';

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
  '.txt': 'text/plain; charset=utf-8',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.mp4': 'video/mp4'
};

const JSON_TYPE = 'application/json; charset=utf-8';
const TEXT_TYPE = 'text/plain; charset=utf-8';
const HTML_TYPE = 'text/html; charset=utf-8';

/**
 * Response class with Express-style chainable helpers.
 *
 * Passed to http.createServer as the `ServerResponse` option, so every response is
 * created with these methods on its prototype at zero per-request cost. When
 * BareWeb.handle is used with a foreign server, decorateResponse() swaps the
 * prototype in instead.
 */
export class BareWebResponse extends http.ServerResponse {
  /**
   * Set HTTP status code (chainable).
   * @param {number} code
   * @returns {this}
   */
  status(code) {
    this.statusCode = code;
    return this;
  }

  /**
   * Set a single response header or multiple headers via an object (chainable).
   * @param {string|Record<string, string|string[]>} nameOrHeaders
   * @param {string|string[]} [val]
   * @returns {this}
   */
  set(nameOrHeaders, val) {
    if (typeof nameOrHeaders === 'object' && nameOrHeaders !== null) {
      for (const key in nameOrHeaders) {
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
   * Set Content-Type header.
   * @param {string} type
   * @returns {this}
   */
  type(type) {
    this.setHeader('Content-Type', type);
    return this;
  }

  /**
   * Send JSON response.
   * @param {any} data
   */
  json(data) {
    if (!this.hasHeader('Content-Type')) {
      this.setHeader('Content-Type', JSON_TYPE);
    }
    const payload = JSON.stringify(data);
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

    if (Buffer.isBuffer(body)) {
      if (!this.hasHeader('Content-Type')) {
        this.setHeader('Content-Type', 'application/octet-stream');
      }
      this.setHeader('Content-Length', body.length);
      this.end(body);
      return this;
    }

    if (typeof body === 'object') {
      return this.json(body);
    }

    const str = String(body);
    if (!this.hasHeader('Content-Type')) {
      const trimmed = str.trim();
      if (trimmed.charCodeAt(0) === 60 /* < */ && trimmed.charCodeAt(trimmed.length - 1) === 62 /* > */) {
        this.setHeader('Content-Type', HTML_TYPE);
      } else {
        this.setHeader('Content-Type', TEXT_TYPE);
      }
    }
    this.setHeader('Content-Length', Buffer.byteLength(str));
    this.end(str);
    return this;
  }

  /**
   * Send HTML response.
   * @param {string} html
   */
  html(html) {
    this.setHeader('Content-Type', HTML_TYPE);
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
    this.setHeader('Content-Type', TEXT_TYPE);
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
    if (options.maxAge !== undefined) cookieStr += `; Max-Age=${Math.floor(options.maxAge / 1000)}`;
    if (options.domain) cookieStr += `; Domain=${options.domain}`;
    if (options.path) cookieStr += `; Path=${options.path}`;
    else cookieStr += '; Path=/';
    if (options.expires) cookieStr += `; Expires=${options.expires.toUTCString()}`;
    if (options.httpOnly) cookieStr += '; HttpOnly';

    let sameSite = null;
    if (options.sameSite) {
      const raw = typeof options.sameSite === 'string' ? options.sameSite.toLowerCase() : 'strict';
      if (raw !== 'strict' && raw !== 'lax' && raw !== 'none') {
        throw new TypeError(`Invalid sameSite value "${options.sameSite}" (expected "strict", "lax" or "none")`);
      }
      sameSite = raw.charAt(0).toUpperCase() + raw.slice(1);
    }
    // Browsers reject SameSite=None without Secure; fail loudly instead of silently dropping the cookie
    if (sameSite === 'None' && !options.secure) {
      throw new TypeError('Cookies with sameSite: "none" must also set secure: true');
    }
    if (options.secure) cookieStr += '; Secure';
    if (sameSite) cookieStr += `; SameSite=${sameSite}`;

    if (options.priority) {
      const p = String(options.priority).toLowerCase();
      if (p !== 'low' && p !== 'medium' && p !== 'high') {
        throw new TypeError(`Invalid priority value "${options.priority}" (expected "low", "medium" or "high")`);
      }
      cookieStr += `; Priority=${p.charAt(0).toUpperCase() + p.slice(1)}`;
    }
    if (options.partitioned) {
      if (!options.secure) throw new TypeError('Partitioned cookies (CHIPS) must also set secure: true');
      cookieStr += '; Partitioned';
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
   * Set the Location header (chainable). "back" resolves to the Referrer or "/".
   * @param {string} url
   * @returns {this}
   */
  location(url) {
    let target = url;
    if (url === 'back') {
      target = this.req?.headers?.referer || this.req?.headers?.referrer || '/';
    }
    this.setHeader('Location', target);
    return this;
  }

  /**
   * Redirect to URL. Accepts both `redirect(url, status)` and Express' `redirect(status, url)`.
   * Defaults to 302 and writes a small text body so non-browser clients see where they were sent.
   * @param {string|number} urlOrStatus
   * @param {string|number} [statusOrUrl]
   */
  redirect(urlOrStatus, statusOrUrl) {
    let url = urlOrStatus;
    let status = 302;
    if (typeof urlOrStatus === 'number') {
      status = urlOrStatus;
      url = statusOrUrl;
    } else if (typeof statusOrUrl === 'number') {
      status = statusOrUrl;
    }
    if (typeof url !== 'string') {
      throw new TypeError('res.redirect() requires a URL string');
    }

    this.location(url);
    this.statusCode = status;
    const location = this.getHeader('Location');
    const body = `${http.STATUS_CODES[status] || 'Redirecting'}. Redirecting to ${location}`;
    this.setHeader('Content-Type', TEXT_TYPE);
    this.setHeader('Content-Length', Buffer.byteLength(body));
    this.end(this.req?.method === 'HEAD' ? undefined : body);
    return this;
  }

  /**
   * Stream a file to the response with proper Content-Type.
   * Resolves cleanly after handling 404/500 responses, or invokes provided callback / onError.
   * @param {string} filePath
   * @param {object|Function} [optionsOrCallback]
   * @param {Function} [maybeCallback]
   * @returns {Promise<void>}
   */
  sendFile(filePath, optionsOrCallback = {}, maybeCallback) {
    let options = optionsOrCallback;
    let callback = maybeCallback;

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
      options = {};
    }

    const res = this;
    return new Promise((resolve) => {
      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          const error = new Error(`File not found: ${filePath}`);
          error.statusCode = 404;

          if (callback) {
            callback(error);
            return resolve();
          }

          if (options && options.onError) {
            options.onError(error);
            return resolve();
          }

          if (!res.writableEnded) {
            res.status(404).json({ error: { message: error.message, statusCode: 404 } });
          }
          return resolve();
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        if (options && options.cacheControl) {
          res.setHeader('Cache-Control', options.cacheControl);
        }

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);

        stream.on('end', () => {
          if (callback) callback(null);
          resolve();
        });

        stream.on('error', (streamErr) => {
          if (callback) {
            callback(streamErr);
            return resolve();
          }
          if (options && options.onError) {
            options.onError(streamErr);
            return resolve();
          }
          if (!res.writableEnded) {
            res.status(500).end('File stream error');
          }
          resolve();
        });
      });
    });
  }
}

/**
 * Ensure `res` has the BareWeb helper methods. Responses created by BareWeb's own server
 * already are BareWebResponse instances; for foreign servers the prototype is swapped in.
 * @param {http.ServerResponse} res
 * @returns {BareWebResponse}
 */
export function decorateResponse(res) {
  if (!(res instanceof BareWebResponse)) {
    Object.setPrototypeOf(res, BareWebResponse.prototype);
  }
  return res;
}
