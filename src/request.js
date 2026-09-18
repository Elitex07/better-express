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

/**
 * Normalise the `trustProxy` option into a predicate over the socket's remote address.
 * - false/undefined: never trust X-Forwarded-* (default; safe for direct exposure)
 * - true: always trust
 * - function(remoteAddress): custom decision
 * - string | string[]: trust when remoteAddress is in the list ('loopback' is a shortcut)
 * @param {boolean|Function|string|string[]} [trustProxy]
 * @returns {(remoteAddress: string) => boolean}
 */
export function compileTrustProxy(trustProxy) {
  if (trustProxy === true) return () => true;
  if (typeof trustProxy === 'function') return trustProxy;
  if (typeof trustProxy === 'string' || Array.isArray(trustProxy)) {
    const list = new Set(
      (Array.isArray(trustProxy) ? trustProxy : trustProxy.split(','))
        .map((s) => s.trim())
        .filter(Boolean)
    );
    if (list.has('loopback')) {
      list.add('127.0.0.1');
      list.add('::1');
      list.add('::ffff:127.0.0.1');
    }
    return (addr) => list.has(addr);
  }
  return () => false;
}

const NEVER_TRUST = () => false;

/**
 * @param {import('node:http').IncomingMessage} req
 * @param {Record<string, string>} params
 * @param {URL} parsedUrl
 * @param {object} [options]
 * @param {(remoteAddress: string) => boolean} [options.trustProxy] compiled predicate (see compileTrustProxy)
 */
export function decorateRequest(req, params = {}, parsedUrl, options = {}) {
  req.params = params;
  req.path = parsedUrl.pathname;
  req.query = parseQuery(parsedUrl.searchParams);
  req.searchParams = parsedUrl.searchParams;

  const remoteAddress = req.socket?.remoteAddress || '';
  const trust = options.trustProxy || NEVER_TRUST;
  const trusted = trust(remoteAddress);

  // Client IP address: only honour X-Forwarded-For from a trusted proxy
  const xff = trusted ? req.headers['x-forwarded-for'] : undefined;
  req.ip = (xff && xff.split(',')[0].trim()) || remoteAddress;

  // Hostname & Protocol
  const xfHost = trusted ? req.headers['x-forwarded-host'] : undefined;
  req.hostname = (xfHost && xfHost.split(',')[0].trim()) || parsedUrl.hostname;
  const xfProto = trusted ? req.headers['x-forwarded-proto'] : undefined;
  req.protocol = (xfProto && xfProto.split(',')[0].trim()) || (req.socket?.encrypted ? 'https' : 'http');
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
  let _bodyBuffer = null;
  let _activeLimit = Infinity;

  /**
   * Read raw request body as Buffer with a size limit.
   * Emits HTTP 413 Payload Too Large error on overflow, even for cached reads.
   * @param {number} limit Maximum allowed bytes
   * @returns {Promise<Buffer>}
   */
  req.buffer = function(limit = DEFAULT_BODY_LIMIT) {
    if (_bodyBuffer !== null) {
      if (_bodyBuffer.length > limit) {
        const err = new Error(`Payload Too Large: exceeded limit of ${limit} bytes`);
        err.statusCode = 413;
        err.status = 413;
        return Promise.reject(err);
      }
      return Promise.resolve(_bodyBuffer);
    }

    if (_bodyBufferPromise !== null) {
      if (limit < _activeLimit) {
        _activeLimit = limit;
      }
      return _bodyBufferPromise.then((buf) => {
        if (buf.length > limit) {
          const err = new Error(`Payload Too Large: exceeded limit of ${limit} bytes`);
          err.statusCode = 413;
          err.status = 413;
          throw err;
        }
        return buf;
      });
    }

    _activeLimit = limit;

    _bodyBufferPromise = new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;
      let exceeded = false;

      const onData = (chunk) => {
        if (exceeded) return;
        totalSize += chunk.length;
        if (totalSize > _activeLimit) {
          exceeded = true;
          req.removeListener('data', onData);
          req.removeListener('end', onEnd);
          req.removeListener('error', onError);
          req.resume(); // drain remaining stream so socket does not block
          const err = new Error(`Payload Too Large: exceeded limit of ${_activeLimit} bytes`);
          err.statusCode = 413;
          err.status = 413;
          reject(err);
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (!exceeded) {
          _bodyBuffer = Buffer.concat(chunks);
          resolve(_bodyBuffer);
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
   * Enforces requested limit even when body was previously cached.
   * @param {number} limit 
   * @returns {Promise<any>}
   */
  req.json = async function(limit = DEFAULT_BODY_LIMIT) {
    const buf = await req.buffer(limit);
    if (req.body !== undefined && req._bodyFormat === 'json') {
      return req.body;
    }
    const raw = buf.toString('utf-8');
    if (!raw || raw.trim() === '') {
      req.body = {};
      req._bodyFormat = 'json';
      return req.body;
    }
    try {
      req.body = JSON.parse(raw);
      req._bodyFormat = 'json';
      return req.body;
    } catch {
      const parseError = new Error('Invalid JSON payload');
      parseError.statusCode = 400;
      throw parseError;
    }
  };

  /**
   * Parse incoming URL-encoded form body.
   * Enforces requested limit even when body was previously cached.
   * @param {number} limit 
   * @returns {Promise<Record<string, string|string[]>>}
   */
  req.urlencoded = async function(limit = DEFAULT_BODY_LIMIT) {
    const buf = await req.buffer(limit);
    if (req.body !== undefined && req._bodyFormat === 'urlencoded') {
      return req.body;
    }
    const raw = buf.toString('utf-8');
    if (!raw || raw.trim() === '') {
      req.body = {};
      req._bodyFormat = 'urlencoded';
      return req.body;
    }
    const params = new URLSearchParams(raw);
    req.body = parseQuery(params);
    req._bodyFormat = 'urlencoded';
    return req.body;
  };

  return req;
}
