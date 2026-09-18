/**
 * Radix Tree / Trie implementation for high-performance HTTP route matching.
 *
 * Lookup is O(K) in the number of path segments for unambiguous route tables.
 * When a node has both a static child and a `:param` child, a failed deep match
 * falls back to the sibling branch. Because the structure is a tree, every node
 * is visited at most once per search, so the worst case is O(N) in the number of
 * trie nodes compatible with the request path - bounded by the route table the
 * developer registered, never by request input. A valid route is always found.
 */

export class TrieNode {
  constructor(segment = '') {
    this.segment = segment;
    this.staticChildren = new Map(); // literal segment -> TrieNode
    this.paramChild = null;           // TrieNode for :param
    this.wildcardChild = null;        // TrieNode for '*'
    this.wildcardName = null;         // Name of wildcard parameter on a wildcard node ('*' or 'filepath')
    /** @type {Array<{ handlers: Function[], paramKeys: Array<{index:number,name:string}>, wildcardIndex: number, wildcardName: string|null, routeEntry: any }>} */
    this.routes = [];                 // Route definitions terminating at this node, in insertion order
  }
}

function safeDecode(raw) {
  // Fast path: nothing to decode
  if (raw.indexOf('%') === -1) return raw;
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

export class Trie {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks] Deprecated and ignored. The former cap could reject a valid
   *   deep route with a false 404; search cost is bounded by route-table size (see file header).
   */
  constructor(options = {}) {
    this.root = new TrieNode();
  }

  /**
   * Fast normalization of path into segments.
   * e.g., "/api/users/:id/" -> ["api", "users", ":id"]
   * "/" -> []
   */
  static splitPath(path) {
    if (!path || path === '/') return [];
    let p = path.charCodeAt(0) === 47 /* / */ ? path.slice(1) : path;
    const qIndex = p.indexOf('?');
    if (qIndex !== -1) p = p.slice(0, qIndex);
    if (!p) return [];
    if (p.charCodeAt(p.length - 1) === 47 /* / */) p = p.slice(0, -1);
    if (!p) return [];
    // Fast path: no empty segments possible
    if (p.indexOf('//') === -1 && p.charCodeAt(p.length - 1) !== 47) {
      return p.split('/');
    }
    return p.split('/').filter(Boolean);
  }

  /**
   * Insert a route path and its associated handlers into the Trie.
   * @param {string} path
   * @param {Function[]} handlers
   * @param {object} [routeEntry] Optional parent route entry reference (Router bookkeeping)
   */
  insert(path, handlers, routeEntry = null) {
    if (!handlers || !Array.isArray(handlers) || handlers.length === 0) {
      throw new TypeError(`Route "${path}" requires at least one handler function`);
    }

    const segments = Trie.splitPath(path);
    let current = this.root;
    const paramKeys = [];
    let wildcardIndex = -1;
    let wildcardName = null;

    for (let i = 0; i < segments.length; i++) {
      const segment = segments[i];
      if (segment.charCodeAt(0) === 58 /* : */) {
        paramKeys.push({ index: i, name: segment.slice(1) });
        if (!current.paramChild) {
          current.paramChild = new TrieNode(':');
        }
        current = current.paramChild;
      } else if (segment.charCodeAt(0) === 42 /* * */) {
        wildcardIndex = i;
        wildcardName = segment === '*' ? '*' : segment.slice(1);
        if (current.wildcardChild) {
          if (current.wildcardChild.wildcardName && current.wildcardChild.wildcardName !== wildcardName) {
            throw new Error(`Route collision: wildcard "*${wildcardName}" conflicts with existing wildcard "*${current.wildcardChild.wildcardName}" on path "${path}"`);
          }
        } else {
          current.wildcardChild = new TrieNode('*');
          current.wildcardChild.wildcardName = wildcardName;
        }
        current = current.wildcardChild;
        break; // Wildcard consumes everything remaining
      } else {
        let child = current.staticChildren.get(segment);
        if (!child) {
          child = new TrieNode(segment);
          current.staticChildren.set(segment, child);
        }
        current = child;
      }
    }

    current.routes.push({ handlers, paramKeys, wildcardIndex, wildcardName, routeEntry });
  }

  /**
   * Low-level lookup used by the Router: returns the terminal node and the split segments,
   * or null when nothing matches. Allocates nothing beyond the segment array.
   * @param {string} pathname
   * @returns {{ node: TrieNode, segments: string[] } | null}
   */
  lookup(pathname) {
    const segments = Trie.splitPath(pathname);
    const node = this._searchNode(this.root, segments, 0);
    return node ? { node, segments } : null;
  }

  /**
   * Extract params for one route definition from the matched segments into `into`.
   * @param {object} route route definition stored on a TrieNode
   * @param {string[]} segments
   * @param {Record<string, string>} into
   */
  static extractParams(route, segments, into) {
    const keys = route.paramKeys;
    for (let i = 0; i < keys.length; i++) {
      into[keys[i].name] = safeDecode(segments[keys[i].index]);
    }
    if (route.wildcardIndex !== -1) {
      const val = safeDecode(segments.slice(route.wildcardIndex).join('/'));
      into['*'] = val;
      if (route.wildcardName && route.wildcardName !== '*') {
        into[route.wildcardName] = val;
      }
    }
    return into;
  }

  /**
   * Search for a route matching the given pathname.
   * Returns { handlers, params, matches } or null if no route matches.
   * `matches` carries one entry per route definition terminating at the node, with that
   * route's own params (routes that share a node may declare different param names).
   * @param {string} pathname
   * @returns {{ handlers: Function[], params: Record<string, string>, matches: Array<{ routeEntry: any, handlers: Function[], params: Record<string, string> }> } | null}
   */
  search(pathname) {
    const found = this.lookup(pathname);
    if (!found) return null;

    const { node, segments } = found;
    const params = {};
    const handlers = [];
    const matches = [];

    for (const route of node.routes) {
      const routeParams = Trie.extractParams(route, segments, {});
      Object.assign(params, routeParams);
      for (const h of route.handlers) handlers.push(h);
      matches.push({ routeEntry: route.routeEntry, handlers: route.handlers, params: routeParams });
    }

    return { handlers, params, matches };
  }

  /**
   * Depth-first match: static child, then :param child, then wildcard.
   * @param {TrieNode} node
   * @param {string[]} segments
   * @param {number} index
   * @returns {TrieNode|null}
   */
  _searchNode(node, segments, index) {
    // Reached the end of segments
    if (index === segments.length) {
      if (node.routes.length > 0) return node;
      // A wildcard may match the empty remainder ("/static/*" matches "/static")
      if (node.wildcardChild && node.wildcardChild.routes.length > 0) {
        return node.wildcardChild;
      }
      return null;
    }

    const segment = segments[index];
    const staticChild = node.staticChildren.get(segment);

    // 1. Exact static match first
    if (staticChild) {
      const match = this._searchNode(staticChild, segments, index + 1);
      if (match) return match;
    }

    // 2. Parameterised match (:param) - reached only if the static branch failed (backtrack)
    if (node.paramChild) {
      const match = this._searchNode(node.paramChild, segments, index + 1);
      if (match) return match;
    }

    // 3. Wildcard match (*)
    return this._wildcardOrNull(node);
  }

  _wildcardOrNull(node) {
    if (node.wildcardChild && node.wildcardChild.routes.length > 0) {
      return node.wildcardChild;
    }
    return null;
  }
}
