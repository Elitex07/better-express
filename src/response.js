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
    if (options.secure) cookieStr += '; Secure';
    if (options.sameSite) {
      const sameSite = typeof options.sameSite === 'string' 
        ? options.sameSite.toLowerCase() 
        : 'strict';
      cookieStr += `; SameSite=${sameSite.charAt(0).toUpperCase() + sameSite.slice(1)}`;
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
   * Redirect to URL with optional status (default 302).
   * @param {string} url 
   * @param {number} status 
   */
  res.redirect = function(url, status = 302) {
    res.statusCode = status;
    res.setHeader('Location', url);
    res.end();
    return res;
  };

  /**
   * Stream a file to the response with proper Content-Type.
   * @param {string} filePath 
   * @param {object} [options] 
   * @returns {Promise<void>}
   */
  res.sendFile = function(filePath, options = {}) {
    return new Promise((resolve, reject) => {
      fs.stat(filePath, (err, stats) => {
        if (err || !stats.isFile()) {
          const error = new Error(`File not found: ${filePath}`);
          error.statusCode = 404;
          if (options.onError) {
            options.onError(error);
          } else if (!res.writableEnded) {
            res.status(404).json({ error: { message: error.message, statusCode: 404 } });
          }
          return reject(error);
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', stats.size);
        if (options.cacheControl) {
          res.setHeader('Cache-Control', options.cacheControl);
        }

        const stream = fs.createReadStream(filePath);
        stream.pipe(res);
        stream.on('end', () => resolve());
        stream.on('error', (streamErr) => {
          if (!res.writableEnded) {
            res.status(500).end('File stream error');
          }
          reject(streamErr);
        });
      });
    });
  };

  return res;
}
