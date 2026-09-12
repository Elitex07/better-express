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
  }
}

export class Trie {
  constructor() {
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
    const segments = Trie.splitPath(path);
    let current = this.root;
    const paramKeys = [];
    let wildcardIndex = -1;

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
        if (!current.wildcardChild) {
          current.wildcardChild = new TrieNode('*');
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
  }

  /**
   * Search for a route matching the given pathname.
   * Returns { handlers, params } or null if no route matches.
   * @param {string} pathname 
   * @returns {{ handlers: Function[], params: Record<string, string> } | null}
   */
  search(pathname) {
    const segments = Trie.splitPath(pathname);
    const match = this._searchNode(this.root, segments, 0);

    if (match && match.handlers) {
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
        try {
          params['*'] = decodeURIComponent(rawWildcard);
        } catch {
          params['*'] = rawWildcard;
        }
      }
      return { handlers: match.handlers, params };
    }

    return null;
  }

  _searchNode(node, segments, index) {
    // Reached the end of segments
    if (index === segments.length) {
      if (node.handlers) return node;
      // If no exact match handlers, check if wildcard child matches empty
      if (node.wildcardChild && node.wildcardChild.handlers) {
        return node.wildcardChild;
      }
      return null;
    }

    const segment = segments[index];

    // 1. Try exact static match first
    if (node.staticChildren.has(segment)) {
      const match = this._searchNode(node.staticChildren.get(segment), segments, index + 1);
      if (match) return match;
    }

    // 2. Try parameterized match (:param)
    if (node.paramChild) {
      const match = this._searchNode(node.paramChild, segments, index + 1);
      if (match) return match;
    }

    // 3. Try wildcard match (*)
    if (node.wildcardChild && node.wildcardChild.handlers) {
      return node.wildcardChild;
    }

    return null;
  }
}
