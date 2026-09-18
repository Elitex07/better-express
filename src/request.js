import http from 'node:http';

/**
 * Request class with Express-style helper properties and async body parsers.
 *
 * Passed to http.createServer as the `IncomingMessage` option, so every request is
 * created with these helpers on its prototype at zero per-request cost. Expensive
 * derived values (query object, URLSearchParams, cookies, hostname) are computed
 * lazily on first access and cached on the instance.
 */

export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MB

/**
 * Fast query string parser supporting arrays and duplicate keys.
 * @param {URLSearchParams} searchParams
 * @returns {Record<string, string|string[]>}
 */
export function parseQuery(searchParams) {
  const query = {};
  for (const [key, value] of searchParams) {
    const isArrayKey = key.endsWith('[]');
    const cleanKey = isArrayKey ? key.slice(0, -2) : key;

    const existing = query[cleanKey];
    if (existing !== undefined) {
      if (Array.isArray(existing)) {
        existing.push(value);
      } else {
        query[cleanKey] = [existing, value];
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
const EMPTY_OBJECT = Object.freeze({});

function firstForwarded(value) {
  if (!value) return undefined;
  const comma = value.indexOf(',');
  return (comma === -1 ? value : value.slice(0, comma)).trim() || undefined;
}

/** Strip the port from a Host header value, handling bracketed IPv6. */
function hostWithoutPort(host) {
  if (!host) return '';
  if (host.charCodeAt(0) === 91 /* [ */) {
    const close = host.indexOf(']');
    return close === -1 ? host : host.slice(0, close + 1);
  }
  const colon = host.indexOf(':');
  return colon === -1 ? host : host.slice(0, colon);
}

function payloadTooLarge(limit) {
  const err = new Error(`Payload Too Large: exceeded limit of ${limit} bytes`);
  err.statusCode = 413;
  err.status = 413;
  return err;
}

export class BareWebRequest extends http.IncomingMessage {
  // --- header helpers -----------------------------------------------------

  /**
   * Header getter helper (Express-compatible). "referrer" and "referer" are interchangeable.
   * @param {string} headerName
   */
  get(headerName) {
    const name = headerName.toLowerCase();
    if (name === 'referrer' || name === 'referer') {
      return this.headers.referer || this.headers.referrer;
    }
    return this.headers[name];
  }

  /** True when the request was made with XMLHttpRequest (X-Requested-With). */
  get xhr() {
    return (this.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
  }

  // --- URL-derived, lazy --------------------------------------------------

  /** Raw query string without the leading "?" ("" when absent). */
  get search() {
    return this._search === undefined ? '' : this._search;
  }

  /** @returns {URLSearchParams} */
  get searchParams() {
    if (this._searchParams === undefined || this._searchParams === null) {
      this._searchParams = new URLSearchParams(this.search);
    }
    return this._searchParams;
  }

  set searchParams(value) {
    this._searchParams = value;
  }

  /** Parsed query object (arrays for repeated keys / "key[]"). */
  get query() {
    if (this._query === undefined || this._query === null) {
      this._query = this._search ? parseQuery(this.searchParams) : {};
    }
    return this._query;
  }

  set query(value) {
    this._query = value;
  }

  get hostname() {
    if (this._hostname === undefined || this._hostname === null) {
      const forwarded = this._trusted ? firstForwarded(this.headers['x-forwarded-host']) : undefined;
      this._hostname = hostWithoutPort(forwarded || this.headers.host || '');
    }
    return this._hostname;
  }

  set hostname(value) {
    this._hostname = value;
  }

  get protocol() {
    if (this._protocol === undefined || this._protocol === null) {
      const forwarded = this._trusted ? firstForwarded(this.headers['x-forwarded-proto']) : undefined;
      this._protocol = forwarded || (this.socket && this.socket.encrypted ? 'https' : 'http');
    }
    return this._protocol;
  }

  set protocol(value) {
    this._protocol = value;
  }

  get secure() {
    return this.protocol === 'https';
  }

  get ip() {
    if (this._ip === undefined || this._ip === null) {
      const remote = (this.socket && this.socket.remoteAddress) || '';
      const forwarded = this._trusted ? firstForwarded(this.headers['x-forwarded-for']) : undefined;
      this._ip = forwarded || remote;
    }
    return this._ip;
  }

  set ip(value) {
    this._ip = value;
  }

  // --- cookies ------------------------------------------------------------

  get cookies() {
    if (this._cookies === undefined || this._cookies === null) {
      const cookies = {};
      const cookieHeader = this.headers.cookie;
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
      this._cookies = cookies;
    }
    return this._cookies;
  }

  set cookies(value) {
    this._cookies = value;
  }

  // --- body ---------------------------------------------------------------

  /**
   * Read raw request body as Buffer with a size limit.
   * Rejects with HTTP 413 Payload Too Large on overflow, even for cached reads.
   * @param {number} limit Maximum allowed bytes
   * @returns {Promise<Buffer>}
   */
  buffer(limit = DEFAULT_BODY_LIMIT) {
    let state = this._bodyState;
    if (state === undefined || state === null) {
      state = this._bodyState = { promise: null, buffer: null, limit: Infinity };
    }

    if (state.buffer !== null) {
      if (state.buffer.length > limit) {
        return Promise.reject(payloadTooLarge(limit));
      }
      return Promise.resolve(state.buffer);
    }

    if (state.promise !== null) {
      if (limit < state.limit) {
        state.limit = limit;
      }
      return state.promise.then((buf) => {
        if (buf.length > limit) throw payloadTooLarge(limit);
        return buf;
      });
    }

    state.limit = limit;
    const req = this;

    state.promise = new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;
      let exceeded = false;

      const onData = (chunk) => {
        if (exceeded) return;
        totalSize += chunk.length;
        if (totalSize > state.limit) {
          exceeded = true;
          req.removeListener('data', onData);
          req.removeListener('end', onEnd);
          req.removeListener('error', onError);
          req.resume(); // drain remaining stream so socket does not block
          reject(payloadTooLarge(state.limit));
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        if (!exceeded) {
          state.buffer = Buffer.concat(chunks);
          resolve(state.buffer);
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

    return state.promise;
  }

  /**
   * Read request body as a UTF-8 string.
   * @param {number} limit
   * @returns {Promise<string>}
   */
  async text(limit = DEFAULT_BODY_LIMIT) {
    const buf = await this.buffer(limit);
    return buf.toString('utf-8');
  }

  /**
   * Parse incoming JSON request body.
   * Enforces requested limit even when body was previously cached.
   * @param {number} limit
   * @returns {Promise<any>}
   */
  async json(limit = DEFAULT_BODY_LIMIT) {
    const buf = await this.buffer(limit);
    if (this.body !== undefined && this._bodyFormat === 'json') {
      return this.body;
    }
    const raw = buf.toString('utf-8');
    if (!raw || raw.trim() === '') {
      this.body = {};
      this._bodyFormat = 'json';
      return this.body;
    }
    try {
      this.body = JSON.parse(raw);
      this._bodyFormat = 'json';
      return this.body;
    } catch {
      const parseError = new Error('Invalid JSON payload');
      parseError.statusCode = 400;
      throw parseError;
    }
  }

  /**
   * Parse incoming URL-encoded form body.
   * Enforces requested limit even when body was previously cached.
   * @param {number} limit
   * @returns {Promise<Record<string, string|string[]>>}
   */
  async urlencoded(limit = DEFAULT_BODY_LIMIT) {
    const buf = await this.buffer(limit);
    if (this.body !== undefined && this._bodyFormat === 'urlencoded') {
      return this.body;
    }
    const raw = buf.toString('utf-8');
    if (!raw || raw.trim() === '') {
      this.body = {};
      this._bodyFormat = 'urlencoded';
      return this.body;
    }
    this.body = parseQuery(new URLSearchParams(raw));
    this._bodyFormat = 'urlencoded';
    return this.body;
  }
}

/**
 * Initialise per-request state on `req` and make sure it has the BareWebRequest helpers.
 * Requests created by BareWeb's own server already are BareWebRequest instances; for
 * foreign servers the prototype is swapped in.
 *
 * @param {http.IncomingMessage} req
 * @param {Record<string, string>} params route params
 * @param {string|URL} pathnameOrUrl request pathname (or a parsed URL, legacy form)
 * @param {string|object} [searchOrOptions] raw query string without "?" (or options, legacy form)
 * @param {object} [options]
 * @param {(remoteAddress: string) => boolean} [options.trustProxy] compiled predicate (see compileTrustProxy)
 * @returns {BareWebRequest}
 */
export function decorateRequest(req, params = EMPTY_OBJECT, pathnameOrUrl = '/', searchOrOptions = '', options = EMPTY_OBJECT) {
  if (!(req instanceof BareWebRequest)) {
    Object.setPrototypeOf(req, BareWebRequest.prototype);
  }

  let pathname = pathnameOrUrl;
  let search = searchOrOptions;
  if (typeof pathnameOrUrl === 'object' && pathnameOrUrl !== null) {
    // Legacy signature: decorateRequest(req, params, parsedUrl, options)
    pathname = pathnameOrUrl.pathname;
    search = pathnameOrUrl.search ? pathnameOrUrl.search.slice(1) : '';
    options = searchOrOptions || EMPTY_OBJECT;
  }

  req.params = params;
  req.path = pathname;
  req.baseUrl = '';
  req._search = search;
  req._query = null;
  req._searchParams = null;
  req._hostname = null;
  req._protocol = null;
  req._ip = null;
  req._cookies = null;
  req._bodyState = null;

  const trust = options.trustProxy || NEVER_TRUST;
  req._trusted = trust((req.socket && req.socket.remoteAddress) || '');

  return req;
}
