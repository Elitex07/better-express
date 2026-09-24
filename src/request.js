import http from 'node:http';

/**
 * Request helpers for BareWeb.
 *
 * All helpers live on BareRequest.prototype instead of being attached as fresh
 * closures on every request: V8 keeps a single stable hidden class for requests,
 * and derived values (query, cookies, ip, ...) are computed lazily on first access.
 */

export const DEFAULT_BODY_LIMIT = 1024 * 1024; // 1 MB

// Host header per RFC 3986: non-empty reg-name / IPv4 or bracketed IP literal, optional port.
const HOST_RE = /^(?:[A-Za-z0-9\-._~!$&'()*+,;=%]+|\[[0-9A-Fa-f:.]+\])(?::(\d{0,5}))?$/;

const LOOPBACK = ['127.0.0.1', '::1', '::ffff:127.0.0.1'];

/**
 * Normalise the `trustProxy` option into a predicate over the direct peer's address.
 * - false/undefined: never trust X-Forwarded-* (default; safe when exposed directly)
 * - true: always trust
 * - function(remoteAddress): custom decision
 * - string (comma-separated) | string[]: trust these peer addresses; 'loopback' covers
 *   127.0.0.1, ::1 and ::ffff:127.0.0.1
 * @param {boolean|Function|string|string[]} [trustProxy]
 * @returns {(remoteAddress: string) => boolean}
 */
export function compileTrustProxy(trustProxy) {
  if (trustProxy === true) return () => true;
  if (typeof trustProxy === 'function') return (addr) => Boolean(trustProxy(addr));
  if (typeof trustProxy === 'string' || Array.isArray(trustProxy)) {
    const list = new Set(
      (Array.isArray(trustProxy) ? trustProxy : trustProxy.split(','))
        .map((s) => String(s).trim())
        .filter(Boolean)
    );
    if (list.delete('loopback')) for (const addr of LOOPBACK) list.add(addr);
    return (addr) => list.has(addr);
  }
  return () => false;
}

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
    // Never let a query key reach Object.prototype
    if (cleanKey === '__proto__') continue;

    // Own-property check: keys like "constructor" must not see Object.prototype
    const existing = Object.hasOwn(query, cleanKey) ? query[cleanKey] : undefined;
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
 * Split a raw request target into pathname and search string without building a
 * WHATWG URL on the hot path. Falls back to URL for targets that need
 * normalization (dot segments, backslashes, absolute-form).
 * @param {string} rawUrl
 * @returns {{ pathname: string, search: string } | null} null when the target is malformed
 */
export function parseUrl(rawUrl) {
  // Browsers never send fragments, but raw clients can; they are not part of the target
  const hashIdx = rawUrl.indexOf('#');
  if (hashIdx !== -1) rawUrl = rawUrl.slice(0, hashIdx);
  const qIdx = rawUrl.indexOf('?');
  const rawPath = qIdx === -1 ? rawUrl : rawUrl.slice(0, qIdx);

  if (
    rawPath.charCodeAt(0) === 47 /* / */ &&
    rawPath.indexOf('/.') === -1 &&
    rawPath.indexOf('\\') === -1
  ) {
    return { pathname: rawPath, search: qIdx === -1 ? '' : rawUrl.slice(qIdx) };
  }

  try {
    const url = new URL(rawUrl, 'http://localhost');
    return { pathname: url.pathname, search: url.search };
  } catch {
    return null;
  }
}

/**
 * @param {string|undefined} host
 * @returns {boolean}
 */
export function isValidHost(host) {
  // A missing/empty Host (HTTP/1.0 clients) is tolerated, as before
  if (host === undefined || host === '') return true;
  const match = HOST_RE.exec(host);
  return match !== null && (!match[1] || Number(match[1]) <= 65535);
}

function payloadTooLarge(limit) {
  const err = new Error(`Payload Too Large: exceeded limit of ${limit} bytes`);
  err.statusCode = 413;
  err.status = 413;
  return err;
}

export class BareRequest extends http.IncomingMessage {
  /**
   * Header getter helper (Express-compatible).
   * @param {string} headerName
   */
  get(headerName) {
    const name = headerName.toLowerCase();
    if (name === 'referer' || name === 'referrer') {
      return this.headers.referrer || this.headers.referer;
    }
    return this.headers[name];
  }

  get query() {
    if (this._query === undefined) {
      this._query = this._search && this._search.length > 1
        ? parseQuery(new URLSearchParams(this._search))
        : {};
    }
    return this._query;
  }

  set query(value) {
    this._query = value;
  }

  /** Raw query string without the leading "?" ('' when absent). */
  get search() {
    const search = this._search;
    return search ? search.slice(1) : '';
  }

  get searchParams() {
    if (this._searchParams === undefined) {
      this._searchParams = new URLSearchParams(this._search || '');
    }
    return this._searchParams;
  }

  set searchParams(value) {
    this._searchParams = value;
  }

  /** Whether X-Forwarded-* headers may be trusted (see the `trustProxy` app option). */
  get _trustProxy() {
    const app = this.app;
    return app !== undefined && typeof app._trustsProxy === 'function' &&
      app._trustsProxy(this.socket?.remoteAddress || '');
  }

  get ip() {
    if (this._trustProxy) {
      const xff = this.headers['x-forwarded-for'];
      if (xff) {
        const comma = xff.indexOf(',');
        return (comma === -1 ? xff : xff.slice(0, comma)).trim();
      }
    }
    return this.socket?.remoteAddress || '';
  }

  get protocol() {
    if (this._trustProxy) {
      const proto = this.headers['x-forwarded-proto'];
      if (proto) {
        const comma = proto.indexOf(',');
        return (comma === -1 ? proto : proto.slice(0, comma)).trim().toLowerCase();
      }
    }
    return this.socket?.encrypted ? 'https' : 'http';
  }

  get secure() {
    return this.protocol === 'https';
  }

  get hostname() {
    let host = (this._trustProxy && this.headers['x-forwarded-host']) || this.headers.host;
    if (!host) return '';
    const comma = host.indexOf(',');
    if (comma !== -1) host = host.slice(0, comma).trim();
    // IPv6 literal: keep the brackets, strip the port after them
    const offset = host.charCodeAt(0) === 91 /* [ */ ? host.indexOf(']') + 1 : 0;
    const colon = host.indexOf(':', offset);
    return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
  }

  get xhr() {
    return (this.headers['x-requested-with'] || '').toLowerCase() === 'xmlhttprequest';
  }

  /** Lazily parsed cookies. */
  get cookies() {
    if (this._parsedCookies) return this._parsedCookies;
    const cookies = {};
    const cookieHeader = this.headers.cookie;
    if (cookieHeader) {
      const pairs = cookieHeader.split(';');
      for (let i = 0; i < pairs.length; i++) {
        const pair = pairs[i];
        const eqIdx = pair.indexOf('=');
        if (eqIdx <= 0) continue;
        let key = pair.slice(0, eqIdx).trim();
        if (key.indexOf('%') !== -1) {
          try { key = decodeURIComponent(key); } catch { /* keep raw key */ }
        }
        let val = pair.slice(eqIdx + 1).trim();
        if (val.charCodeAt(0) === 34 /* " */ && val.charCodeAt(val.length - 1) === 34) {
          val = val.slice(1, -1);
        }
        // First occurrence wins (RFC 6265 ordering: most specific path first)
        if (key === '__proto__' || Object.hasOwn(cookies, key)) continue;
        try {
          cookies[key] = val.indexOf('%') === -1 ? val : decodeURIComponent(val);
        } catch {
          cookies[key] = val;
        }
      }
    }
    this._parsedCookies = cookies;
    return cookies;
  }

  set cookies(value) {
    this._parsedCookies = value;
  }

  /**
   * Read raw request body as Buffer with a size limit.
   * Rejects with HTTP 413 on overflow, even for cached reads.
   * @param {number} [limit]
   * @returns {Promise<Buffer>}
   */
  buffer(limit = DEFAULT_BODY_LIMIT) {
    if (this._bodyBuffer) {
      return this._bodyBuffer.length > limit
        ? Promise.reject(payloadTooLarge(limit))
        : Promise.resolve(this._bodyBuffer);
    }

    if (this._bodyPromise) {
      if (limit < this._bodyLimit) this._bodyLimit = limit;
      return this._bodyPromise.then((buf) => {
        if (buf.length > limit) throw payloadTooLarge(limit);
        return buf;
      });
    }

    this._bodyLimit = limit;

    // Reject early when the declared length already exceeds the limit.
    const declared = this.headers['content-length'];
    if (declared !== undefined && Number(declared) > limit) {
      this.resume();
      this._bodyPromise = Promise.reject(payloadTooLarge(limit));
      return this._bodyPromise;
    }

    this._bodyPromise = new Promise((resolve, reject) => {
      const chunks = [];
      let totalSize = 0;

      const cleanup = () => {
        this.removeListener('data', onData);
        this.removeListener('end', onEnd);
        this.removeListener('error', onError);
      };

      const onData = (chunk) => {
        totalSize += chunk.length;
        if (totalSize > this._bodyLimit) {
          cleanup();
          this.resume(); // drain remaining stream so the socket does not stall
          reject(payloadTooLarge(this._bodyLimit));
          return;
        }
        chunks.push(chunk);
      };

      const onEnd = () => {
        cleanup();
        this._bodyBuffer = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks, totalSize);
        resolve(this._bodyBuffer);
      };

      const onError = (err) => {
        cleanup();
        reject(err);
      };

      this.on('data', onData);
      this.on('end', onEnd);
      this.on('error', onError);
    });

    return this._bodyPromise;
  }

  /**
   * Read request body as a UTF-8 string.
   * @param {number} [limit]
   * @returns {Promise<string>}
   */
  async text(limit = DEFAULT_BODY_LIMIT) {
    const buf = await this.buffer(limit);
    return buf.toString('utf-8');
  }

  /**
   * Parse incoming JSON request body.
   * @param {number} [limit]
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
    } else {
      try {
        this.body = JSON.parse(raw);
      } catch {
        const parseError = new Error('Invalid JSON payload');
        parseError.statusCode = 400;
        throw parseError;
      }
    }
    this._bodyFormat = 'json';
    return this.body;
  }

  /**
   * Parse incoming URL-encoded form body.
   * @param {number} [limit]
   * @returns {Promise<Record<string, string|string[]>>}
   */
  async urlencoded(limit = DEFAULT_BODY_LIMIT) {
    const buf = await this.buffer(limit);
    if (this.body !== undefined && this._bodyFormat === 'urlencoded') {
      return this.body;
    }
    const raw = buf.toString('utf-8');
    this.body = !raw || raw.trim() === '' ? {} : parseQuery(new URLSearchParams(raw));
    this._bodyFormat = 'urlencoded';
    return this.body;
  }
}

// Derived getters stay assignable: writing one shadows it with an own property,
// so middleware can override e.g. `req.ip` without a TypeError in strict mode.
for (const name of ['ip', 'protocol', 'secure', 'hostname', 'xhr']) {
  const descriptor = Object.getOwnPropertyDescriptor(BareRequest.prototype, name);
  descriptor.set = function (value) {
    Object.defineProperty(this, name, { value, writable: true, configurable: true, enumerable: true });
  };
  Object.defineProperty(BareRequest.prototype, name, descriptor);
}

/**
 * Prepare a request for the BareWeb pipeline. Requests created by a BareWeb server
 * already are BareRequests; foreign ones (e.g. `http.createServer(app.handle)`)
 * get their prototype swapped once, like Express does.
 * @param {http.IncomingMessage} req
 * @param {Record<string, string>} [params]
 * @param {{ pathname: string, search?: string }} [parsedUrl] URL or parseUrl() result
 */
export function decorateRequest(req, params = {}, parsedUrl) {
  if (!(req instanceof BareRequest)) {
    Object.setPrototypeOf(req, BareRequest.prototype);
  }
  const parsed = parsedUrl || parseUrl(req.url || '/') || { pathname: '/', search: '' };
  req.params = params;
  req.path = parsed.pathname;
  req._search = parsed.search || '';
  req.baseUrl = '';
  return req;
}
