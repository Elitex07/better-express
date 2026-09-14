/**
 * Radix Tree / Trie implementation for high-performance HTTP route matching.
 * Provides O(K) lookup where K is the number of path segments, avoiding
 * linear regex evaluation.
 */

export class TrieNode {
  constructor(segment = '') {
    this.segment = segment;
    this.staticChildren = new Map(); // literal segment -> TrieNode
    this.paramChild = null;           // TrieNode for :param
    this.wildcardChild = null;        // TrieNode for '*'
    this.handlers = null;            // Array of handler functions
    this.paramKeys = null;           // Array of { index: number, name: string }
    this.wildcardIndex = -1;         // Index where wildcard starts
    this.wildcardName = null;        // Name of wildcard parameter (e.g., '*' or 'filepath')
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
   */
  insert(path, handlers) {
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
      if (segment.startsWith(':')) {
        const paramName = segment.slice(1);
        paramKeys.push({ index: i, name: paramName });
        if (!current.paramChild) {
          current.paramChild = new TrieNode(':');
        }
        current = current.paramChild;
      } else if (segment === '*' || segment.startsWith('*')) {
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
        if (!current.staticChildren.has(segment)) {
          current.staticChildren.set(segment, new TrieNode(segment));
        }
        current = current.staticChildren.get(segment);
      }
    }

    if (current.handlers) {
      current.handlers = current.handlers.concat(handlers);
    } else {
      current.handlers = handlers;
    }
    current.paramKeys = current.paramKeys || paramKeys;
    current.wildcardIndex = current.wildcardIndex !== -1 ? current.wildcardIndex : wildcardIndex;
    if (wildcardName) {
      current.wildcardName = wildcardName;
    }
  }

  /**
   * Search for a route matching the given pathname.
   * Returns { handlers, params } or null if no route matches.
   * @param {string} pathname 
   * @returns {{ handlers: Function[], params: Record<string, string> } | null}
   */
  search(pathname) {
    const segments = Trie.splitPath(pathname);
    const state = { backtracks: 0 };
    const match = this._searchNode(this.root, segments, 0, state);

    if (match && match.handlers && match.handlers.length > 0) {
      const params = {};
      if (match.paramKeys) {
        for (const { index, name } of match.paramKeys) {
          const rawVal = segments[index];
          try {
            params[name] = decodeURIComponent(rawVal);
          } catch {
            params[name] = rawVal;
          }
        }
      }
      if (match.wildcardIndex !== -1) {
        const rawWildcard = segments.slice(match.wildcardIndex).join('/');
        let val;
        try {
          val = decodeURIComponent(rawWildcard);
        } catch {
          val = rawWildcard;
        }
        params['*'] = val;
        if (match.wildcardName && match.wildcardName !== '*') {
          params[match.wildcardName] = val;
        }
      }
      return { handlers: match.handlers, params };
    }

    return null;
  }

  _searchNode(node, segments, index, state = { backtracks: 0 }) {
    // Reached the end of segments
    if (index === segments.length) {
      if (node.handlers && node.handlers.length > 0) return node;
      // If no exact match handlers, check if wildcard child matches empty
      if (node.wildcardChild && node.wildcardChild.handlers && node.wildcardChild.handlers.length > 0) {
        return node.wildcardChild;
      }
      return null;
    }

    const segment = segments[index];

    // 1. Try exact static match first
    if (node.staticChildren.has(segment)) {
      const match = this._searchNode(node.staticChildren.get(segment), segments, index + 1, state);
      if (match) return match;
    }

    // 2. Try parameterized match (:param)
    if (node.paramChild) {
      // If we already attempted staticChildren and it failed, this branch incurs a backtrack
      if (node.staticChildren.has(segment)) {
        state.backtracks++;
        if (state.backtracks > this.maxBacktracks) {
          return null; // Stop unbounded backtracking
        }
      }
      const match = this._searchNode(node.paramChild, segments, index + 1, state);
      if (match) return match;
    }

    // 3. Try wildcard match (*)
    if (node.wildcardChild && node.wildcardChild.handlers && node.wildcardChild.handlers.length > 0) {
      return node.wildcardChild;
    }

    return null;
  }
}
