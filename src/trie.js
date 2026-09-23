/**
 * Segment trie for HTTP route matching.
 *
 * - Fully static routes are also indexed in a Map, so the common case is a single
 *   hash lookup with no path splitting at all.
 * - Dynamic lookups walk the trie in O(K) (K = path segments) for unambiguous
 *   tables. Static > :param > *wildcard priority; backtracking between ambiguous
 *   static/param siblings is bounded by `maxBacktracks`.
 */

export class TrieNode {
  constructor(segment = '') {
    this.segment = segment;
    this.staticChildren = new Map(); // literal segment -> TrieNode
    this.paramChild = null;          // TrieNode for :param
    this.wildcardChild = null;       // TrieNode for '*'
    this.wildcardName = null;        // Name of wildcard parameter (e.g., '*' or 'filepath')
    this.routes = [];                // Route definitions ending at this node
  }
}

function decode(value) {
  if (value.indexOf('%') === -1) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

export class Trie {
  /**
   * @param {object} [options]
   * @param {number} [options.maxBacktracks=500] Maximum backtrack steps before aborting ambiguous branch exploration
   */
  constructor(options = {}) {
    this.root = new TrieNode();
    this.maxBacktracks = options.maxBacktracks ?? 500;
    /** @type {Map<string, TrieNode>} normalized static path -> node */
    this.staticRoutes = new Map();
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
    if (!p.includes('//')) {
      return p.split('/');
    }
    return p.split('/').filter(Boolean);
  }

  /**
   * Insert a route path and its associated handlers into the Trie.
   * @param {string} path
   * @param {Function[]} handlers
   * @param {object} [routeEntry] Optional router entry this route belongs to
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
          if (current.wildcardChild.wildcardName !== wildcardName) {
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

    if (paramKeys.length === 0 && wildcardIndex === -1) {
      this.staticRoutes.set('/' + segments.join('/'), current);
    }
  }

  /**
   * Search for a route matching the given pathname.
   * `params` merges the parameters of every route ending at the matched node;
   * `matches` carries each route's own parameters (never shared across requests).
   * @param {string} pathname
   * @returns {{
   *   handlers: Function[],
   *   params: Record<string, string>,
   *   handlersWithParams: Array<{ handler: Function, params: Record<string, string>, routeEntry: any }>,
   *   matches: Array<{ routeEntry: any, params: Record<string, string>, handlers: Function[] }>,
   *   routeEntries: any[],
   *   routes: any[]
   * } | null}
   */
  search(pathname) {
    let node = this.staticRoutes.get(pathname);
    let segments = null;

    if (node === undefined) {
      segments = Trie.splitPath(pathname);
      node = this._searchNode(this.root, segments, 0, { backtracks: 0 });
      if (!node) return null;
    }

    const params = {};
    const handlers = [];
    const handlersWithParams = [];
    const matches = [];
    const routeEntries = [];

    for (const route of node.routes) {
      let routeParams = params;
      if (segments !== null && (route.paramKeys.length > 0 || route.wildcardIndex !== -1)) {
        routeParams = {};
        for (const { index, name } of route.paramKeys) {
          routeParams[name] = params[name] = decode(segments[index]);
        }
        if (route.wildcardIndex !== -1) {
          const val = decode(segments.slice(route.wildcardIndex).join('/'));
          routeParams['*'] = params['*'] = val;
          if (route.wildcardName !== '*') {
            routeParams[route.wildcardName] = params[route.wildcardName] = val;
          }
        }
      }

      matches.push({ routeEntry: route.routeEntry, params: routeParams, handlers: route.handlers });
      if (route.routeEntry) routeEntries.push(route.routeEntry);
      for (const h of route.handlers) {
        handlers.push(h);
        handlersWithParams.push({ handler: h, params: routeParams, routeEntry: route.routeEntry });
      }
    }

    return { handlers, handlersWithParams, params, matches, routeEntries, routes: node.routes };
  }

  _searchNode(node, segments, index, state) {
    // Reached the end of segments
    if (index === segments.length) {
      if (node.routes.length > 0) return node;
      // A wildcard also matches the empty remainder
      if (node.wildcardChild && node.wildcardChild.routes.length > 0) {
        return node.wildcardChild;
      }
      return null;
    }

    const segment = segments[index];

    // 1. Exact static match first
    const staticChild = node.staticChildren.get(segment);
    if (staticChild !== undefined) {
      const match = this._searchNode(staticChild, segments, index + 1, state);
      if (match) return match;
    }

    // 2. Parameterized match (:param)
    if (node.paramChild) {
      // Falling back from a failed static branch counts as a backtrack
      if (staticChild !== undefined && ++state.backtracks > this.maxBacktracks) {
        return null;
      }
      const match = this._searchNode(node.paramChild, segments, index + 1, state);
      if (match) return match;
    }

    // 3. Wildcard match (*)
    if (node.wildcardChild && node.wildcardChild.routes.length > 0) {
      return node.wildcardChild;
    }

    return null;
  }
}
