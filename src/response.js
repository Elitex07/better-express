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

/**
 * Augments Node's native http.ServerResponse with chainable helper methods
 * such as status(), json(), send(), html(), redirect(), cookie(), sendStatus(), and sendFile().
 */
export function decorateResponse(res) {
  /**
   * Set HTTP status code (chainable).
   * @param {number} code 
   * @returns {res}
   */
  res.status = function(code) {
    res.statusCode = code;
    return res;
  };

  /**
   * Set a single response header or multiple headers via an object (chainable).
   * @param {string|Record<string, string|string[]>} nameOrHeaders 
   * @param {string|string[]} [val] 
   * @returns {res}
   */
  res.set = function(nameOrHeaders, val) {
    if (typeof nameOrHeaders === 'object' && nameOrHeaders !== null) {
      for (const [key, value] of Object.entries(nameOrHeaders)) {
        res.setHeader(key, value);
      }
    } else {
      res.setHeader(nameOrHeaders, val);
    }
    return res;
  };
  res.header = res.set;

  /**
   * Set Content-Type header.
   * @param {string} type 
   * @returns {res}
   */
  res.type = function(type) {
    res.setHeader('Content-Type', type);
    return res;
  };

  /**
   * Send JSON response.
   * @param {any} data 
   */
  res.json = function(data) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    const payload = JSON.stringify(data);
    res.setHeader('Content-Length', Buffer.byteLength(payload));
    res.end(payload);
    return res;
  };

  /**
   * Send arbitrary response (text, buffer, or json).
   * @param {string|Buffer|object|number|boolean} body 
   */
  res.send = function(body) {
    if (body === null || body === undefined) {
      res.end();
      return res;
    }

    if (Buffer.isBuffer(body)) {
      if (!res.getHeader('Content-Type')) {
        res.setHeader('Content-Type', 'application/octet-stream');
      }
      res.setHeader('Content-Length', body.length);
      res.end(body);
      return res;
    }

    if (typeof body === 'object') {
      return res.json(body);
    }

    const str = String(body);
    if (!res.getHeader('Content-Type')) {
      if (str.trim().startsWith('<') && str.trim().endsWith('>')) {
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
      } else {
        res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      }
    }
    res.setHeader('Content-Length', Buffer.byteLength(str));
    res.end(str);
    return res;
  };

  /**
   * Send HTML response.
   * @param {string} html 
   */
  res.html = function(html) {
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(html));
    res.end(html);
    return res;
  };

  /**
   * Send status code with standard HTTP status text.
   * @param {number} statusCode 
   */
  res.sendStatus = function(statusCode) {
    const text = http.STATUS_CODES[statusCode] || String(statusCode);
    res.statusCode = statusCode;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(text));
    res.end(text);
    return res;
  };

  /**
   * Set a cookie header.
   * @param {string} name 
   * @param {string} val 
   * @param {object} [options] 
   */
  res.cookie = function(name, val, options = {}) {
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

    const prev = res.getHeader('Set-Cookie');
    if (!prev) {
      res.setHeader('Set-Cookie', cookieStr);
    } else if (Array.isArray(prev)) {
      res.setHeader('Set-Cookie', [...prev, cookieStr]);
    } else {
      res.setHeader('Set-Cookie', [prev, cookieStr]);
    }
    return res;
  };

  /**
   * Clear a cookie by setting expired date.
   * @param {string} name 
   * @param {object} [options] 
   */
  res.clearCookie = function(name, options = {}) {
    return res.cookie(name, '', { ...options, expires: new Date(1), maxAge: 0 });
  };

  /**
   * Set the Location header (chainable). "back" resolves to the Referrer or "/".
   * @param {string} url
   * @returns {res}
   */
  res.location = function(url) {
    let target = url;
    if (url === 'back') {
      target = res.req?.headers?.referer || res.req?.headers?.referrer || '/';
    }
    res.setHeader('Location', target);
    return res;
  };

  /**
   * Redirect to URL. Accepts both `redirect(url, status)` and Express' `redirect(status, url)`.
   * Defaults to 302 and writes a small text body so non-browser clients see where they were sent.
   * @param {string|number} urlOrStatus
   * @param {string|number} [statusOrUrl]
   */
  res.redirect = function(urlOrStatus, statusOrUrl) {
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

    res.location(url);
    res.statusCode = status;
    const location = res.getHeader('Location');
    const body = `${http.STATUS_CODES[status] || 'Redirecting'}. Redirecting to ${location}`;
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    res.setHeader('Content-Length', Buffer.byteLength(body));
    res.end(res.req?.method === 'HEAD' ? undefined : body);
    return res;
  };

  /**
   * Stream a file to the response with proper Content-Type.
   * Resolves cleanly after handling 404/500 responses, or invokes provided callback / onError.
   * @param {string} filePath 
   * @param {object|Function} [optionsOrCallback] 
   * @param {Function} [maybeCallback]
   * @returns {Promise<void>}
   */
  res.sendFile = function(filePath, optionsOrCallback = {}, maybeCallback) {
    let options = optionsOrCallback;
    let callback = maybeCallback;

    if (typeof optionsOrCallback === 'function') {
      callback = optionsOrCallback;
      options = {};
    }

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
  };

  return res;
}
