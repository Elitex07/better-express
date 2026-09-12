/**
 * Augments Node's native http.IncomingMessage with lightweight helper properties
 * and async body parsing methods.
 */

export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MB

/**
 * Fast query string parser supporting arrays and duplicate keys.
 * @param {URLSearchParams} searchParams 
 * @returns {Record<string, string|string[]>}
 */
export function parseQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams.entries()) {
    const isArrayKey = key.endsWith('[]');
    const cleanKey = isArrayKey ? key.slice(0, -2) : key;

    if (query[cleanKey] !== undefined) {
      if (Array.isArray(query[cleanKey])) {
        query[cleanKey].push(value);
      } else {
        query[cleanKey] = [query[cleanKey], value];
      }
    } else if (isArrayKey) {
      query[cleanKey] = [value];
    } else {
      query[cleanKey] = value;
    }
  }
  return query;
}

export function decorateRequest(req, params = {}, parsedUrl) {
  req.params = params;
  req.path = parsedUrl.pathname;
  req.query = parseQuery(parsedUrl.searchParams);
  req.searchParams = parsedUrl.searchParams;

  // Client IP address
  req.ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || '';

  // Hostname & Protocol
  req.hostname = parsedUrl.hostname;
  req.protocol = req.headers['x-forwarded-proto'] || (req.socket?.encrypted ? 'https' : 'http');
  req.secure = req.protocol === 'https';

  // AJAX / XHR helper
  req.xhr = (req.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';

  // Header getter helper (Express-compatible)
  req.get = function(headerName) {
    return req.headers[headerName.toLowerCase()];
  };

  // Lazy cookie parsing
  Object.defineProperty(req, 'cookies', {
    get() {
      if (req._parsedCookies) return req._parsedCookies;
      const cookies = {};
      const cookieHeader = req.headers.cookie;
      if (cookieHeader) {
        const pairs = cookieHeader.split(';');
        for (let i = 0; i < pairs.length; i++) {
          const pair = pairs[i];
          const eqIdx = pair.indexOf('=');
          if (eqIdx > 0) {
            const key = pair.slice(0, eqIdx).trim();
            const val = pair.slice(eqIdx + 1).trim();
            try {
              cookies[decodeURIComponent(key)] = decodeURIComponent(val);
            } catch {
              cookies[key] = val;
            }
          }
        }
      }
      req._parsedCookies = cookies;
      return req._parsedCookies;
    },
    configurable: true
  });

  // Cached body storage
  let _bodyBufferPromise = null;

  /**
   * Read raw request body as Buffer with a size limit.
   * Emits HTTP 413 Payload Too Large error on overflow.
   * @param {number} limit Maximum allowed bytes
   * @returns {Promise<Buffer>}
   */
  req.buffer = function(limit = DEFAULT_BODY_LIMIT) {
    if (_bodyBufferPromise) return _bodyBufferPromise;

    _bodyBufferPromise = new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;
      let exceeded = false;

      const onData = (chunk) => {
        if (exceeded) return;
        totalSize += chunk.length;
        if (totalSize > limit) {
          exceeded = true;
          req.removeListener('data', onData);
          req.removeListener('end', onEnd);
          req.removeListener('error', onError);
          req.resume(); // drain remaining stream so socket does not block
          const err = new Error(`Payload Too Large: exceeded limit of ${limit} bytes`);
          err.statusCode = 413;
          err.status = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (!exceeded) {
          resolve(Buffer.concat(chunks));
        }
      };

      const onError = (err) => {
        if (!exceeded) {
          reject(err);
        }
      };

      req.on('data', onData);
      req.on('end', onEnd);
      req.on('error', onError);
    });

    return _bodyBufferPromise;
  };

  /**
   * Read request body as a UTF-8 string.
   * @param {number} limit 
   * @returns {Promise<string>}
   */
  req.text = async function(limit = DEFAULT_BODY_LIMIT) {
    const buf = await req.buffer(limit);
    return buf.toString('utf-8');
  };

  /**
   * Parse incoming JSON request body.
   * @param {number} limit 
   * @returns {Promise<any>}
   */
  req.json = async function(limit = DEFAULT_BODY_LIMIT) {
    if (req.body !== undefined) return req.body;
    const raw = await req.text(limit);
    if (!raw || raw.trim() === '') {
      req.body = {};
      return req.body;
    }
    try {
      req.body = JSON.parse(raw);
      return req.body;
    } catch (err) {
      const parseError = new Error('Invalid JSON payload');
      parseError.statusCode = 400;
      throw parseError;
    }
  };

  /**
   * Parse incoming URL-encoded form body.
   * @param {number} limit 
   * @returns {Promise<Record<string, string|string[]>>}
   */
  req.urlencoded = async function(limit = DEFAULT_BODY_LIMIT) {
    if (req.body !== undefined) return req.body;
    const raw = await req.text(limit);
    if (!raw || raw.trim() === '') {
      req.body = {};
      return req.body;
    }
    const params = new URLSearchParams(raw);
    req.body = parseQuery(params);
    return req.body;
  };

  return req;
}
