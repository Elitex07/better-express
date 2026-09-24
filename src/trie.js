/**
 * Segment trie for HTTP route matching.
 *
 * - Fully static routes are also indexed in a Map, so the common case is a single
 *   hash lookup with no path splitting at all.
 * - Dynamic lookups walk the trie in O(K) (K = path segments) for unambiguous
 *   tables. Static > :param > *wildcard priority, with backtracking when a static
 *   branch dead-ends. The trie is a tree and every node sits at a fixed depth, so a
 *   search visits each node at most once: a miss costs at most O(trie size), never
 *   more than scanning the route table, whatever the request path. No cap is needed,
 *   and a cap would 404 valid routes in large ambiguous tables.
 *
 * Express 4 parameter syntax:
 * - `:id?` optional parameter. The route is inserted once per variant (with and without
 *   the segment); variants that land on the same node count once.
 * - `:id(\\d+)` parameter constrained by a RegExp. It applies to one segment, is anchored,
 *   and is tested against the raw (still percent-encoded) segment. A node whose routes
 *   all reject the path is treated as a dead end, so the search backtracks.
 */

export class TrieNode {
  constructor(segment = '') {
    this.segment = segment;
    this.staticChildren = new Map(); // literal segment -> TrieNode
    this.paramChild = null;          // TrieNode for :param
    this.wildcardChild = null;       // TrieNode for '*'
    this.wildcardName = null;        // Name of wildcard parameter (e.g., '*' or 'filepath')
    this.routes = [];                // Route definitions ending at this node
    this.constrained = false;        // Some route here has a :param(regex) constraint
    this.sharedGroups = false;       // Two optional-param variants of one route end here
  }
}

// ":name", ":name?", ":name(regex)", ":name(regex)?"
const PARAM_RE = /^:([A-Za-z0-9_$]+)(?:\((.+)\))?(\?)?$/s;

function decode(value) {
  if (value.indexOf('%') === -1) return value;
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

/**
 * Whether a regex source repeats a group that itself contains an unbounded quantifier,
 * e.g. `(a+)+`, `(\d*)*`, `(?:x+){2,}`. Those nest backtracking and can take exponential
 * time on a crafted, nearly matching segment, blocking the event loop. Heuristic: it does
 * not catch overlapping alternations such as `(a|a)*`.
 * @param {string} source
 */
export function hasNestedQuantifier(source) {
  // Per open group: whether an unbounded quantifier appeared inside it
  const stack = [];
  let lastGroupRepeats = false; // the group that just closed contained a quantifier
  const isUnbounded = (i) => {
    const ch = source[i];
    if (ch === '*' || ch === '+') return true;
    if (ch !== '{') return false;
    const close = source.indexOf('}', i);
    if (close === -1) return false;
    const body = source.slice(i + 1, close);
    // {n,} and {n,m} with m > 1 repeat; {n} and {0,1} do not add backtracking choices
    const m = /^(\d+)(,(\d*))?$/.exec(body);
    return m !== null && m[2] !== undefined && (m[3] === '' || Number(m[3]) > 1);
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i];
    if (ch === '\\') {
      i++;
      lastGroupRepeats = false;
      continue;
    }
    if (ch === '[') {
      // Skip the character class (a "]" right after "[" or "[^" is literal)
      let j = i + 1;
      if (source[j] === '^') j++;
      if (source[j] === ']') j++;
      while (j < source.length && source[j] !== ']') {
        if (source[j] === '\\') j++;
        j++;
      }
      i = j;
      lastGroupRepeats = false;
      continue;
    }
    if (ch === '(') {
      stack.push(false);
      lastGroupRepeats = false;
      continue;
    }
    if (ch === ')') {
      const inner = stack.pop() ?? false;
      if (inner && stack.length > 0) stack[stack.length - 1] = true;
      lastGroupRepeats = inner;
      continue;
    }
    if (isUnbounded(i)) {
      if (lastGroupRepeats) return true;
      if (stack.length > 0) stack[stack.length - 1] = true;
    }
    lastGroupRepeats = false;
  }
  return false;
}

/** Split a route definition on "/" outside parentheses, so regexes may contain "/". */
function splitRoutePath(path) {
  const segments = [];
  let depth = 0;
  let current = '';
  for (let i = 0; i < path.length; i++) {
    const ch = path[i];
    if (ch === '\\') {
      current += ch + (path[i + 1] ?? '');
      i++;
      continue;
    }
    if (ch === '(') depth++;
    else if (ch === ')' && depth > 0) depth--;
    else if (ch === '/' && depth === 0) {
      if (current) segments.push(current);
      current = '';
      continue;
    } else if (ch === '?' && depth === 0 && current.charCodeAt(0) !== 58 /* : */) {
      break; // query string on a static segment; ":name?" keeps its "?"
    }
    current += ch;
  }
  if (current) segments.push(current);
  return segments;
}

/**
 * Parse route segments into tokens and expand optional parameters into variants.
 * @returns {Array<Array<{ type: 'static'|'param'|'wildcard', value?: string, name?: string, regex?: RegExp }>>}
 */
function expandRoute(path) {
  let variants = [[]];
  for (const segment of splitRoutePath(path)) {
    let token;
    let optional = false;
    const first = segment.charCodeAt(0);
    if (first === 58 /* : */) {
      const m = PARAM_RE.exec(segment);
      if (m) {
        let regex = null;
        if (m[2] !== undefined) {
          if (hasNestedQuantifier(m[2])) {
            throw new SyntaxError(
              `Unsafe pattern for parameter ":${m[1]}" in route "${path}": a repeated group contains ` +
              'another repetition (e.g. "(a+)+"), which can backtrack exponentially on crafted input. ' +
              'Flatten it (e.g. "a+") or validate the value in the handler.'
            );
          }
          try {
            regex = new RegExp(`^(?:${m[2]})$`);
          } catch (err) {
            throw new SyntaxError(`Invalid pattern for parameter ":${m[1]}" in route "${path}": ${err.message}`);
          }
        }
        token = { type: 'param', name: m[1], regex };
        optional = m[3] === '?';
      } else {
        // Non-identifier names (e.g. ":file.ext") keep the whole remainder as the name
        token = { type: 'param', name: segment.slice(1), regex: null };
      }
    } else if (first === 42 /* * */) {
      token = { type: 'wildcard', name: segment === '*' ? '*' : segment.slice(1) };
    } else {
      token = { type: 'static', value: segment };
    }

    const next = [];
    for (const variant of variants) {
      // A wildcard consumes everything after it
      if (variant.length > 0 && variant[variant.length - 1].type === 'wildcard') {
        next.push(variant);
        continue;
      }
      next.push([...variant, token]);
      if (optional) next.push(variant);
    }
    variants = optional ? dedupeVariants(next) : next;
    if (variants.length > MAX_ROUTE_VARIANTS) {
      throw new RangeError(
        `Route "${path}" expands to more than ${MAX_ROUTE_VARIANTS} optional-parameter variants; ` +
        'split it into several routes'
      );
    }
  }
  return variants;
}

// Each independent optional segment doubles the variants (8 -> 256)
const MAX_ROUTE_VARIANTS = 256;

/**
 * Drop variants that match exactly the same paths as an earlier one: same static
 * segments, params with the same constraint (names don't affect matching). The first
 * variant wins, as it would at match time, so `/:a?/:b?/...` stays linear, not 2^n.
 */
function dedupeVariants(variants) {
  const seen = new Set();
  const kept = [];
  for (const variant of variants) {
    let key = '';
    for (const t of variant) {
      key += t.type === 'static' ? `/s:${t.value}` : t.type === 'param' ? `/p:${t.regex ? t.regex.source : ''}` : '/*';
    }
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(variant);
  }
  return kept;
}

/** Whether `route` accepts the request segments (only its :param(regex) constraints can fail). */
function accepts(route, segments) {
  if (!route.constrained) return true;
  for (const key of route.paramKeys) {
    if (key.regex !== null && !key.regex.test(segments[key.index])) return false;
  }
  return true;
}

export class Trie {
  /**
   * @param {object} [options] Accepted for compatibility; `maxBacktracks` is ignored
   *   (see the complexity note above).
   */
  constructor(options = {}) {
    this.root = new TrieNode();
    /** @type {Map<string, TrieNode>} normalized static path -> node */
    this.staticRoutes = new Map();
  }

  /**
   * Fast normalization of a request path into segments.
   * e.g., "/api/users/42/" -> ["api", "users", "42"]
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
    // Empty segments ("a//b", "//a", "a//") are ignored
    if (!p.includes('//') && p.charCodeAt(0) !== 47 && p.charCodeAt(p.length - 1) !== 47) {
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

    // Variants of one registration share a group so a node matches it at most once
    const group = {};
    const variants = expandRoute(path);
    const allParams = new Set();
    for (const variant of variants) {
      for (const t of variant) if (t.type === 'param') allParams.add(t.name);
    }

    for (const tokens of variants) {
      let current = this.root;
      const paramKeys = [];
      const present = new Set();
      let wildcardIndex = -1;
      let wildcardName = null;
      const staticParts = [];

      for (let i = 0; i < tokens.length; i++) {
        const token = tokens[i];
        if (token.type === 'param') {
          paramKeys.push({ index: i, name: token.name, regex: token.regex });
          present.add(token.name);
          if (!current.paramChild) current.paramChild = new TrieNode(':');
          current = current.paramChild;
        } else if (token.type === 'wildcard') {
          wildcardIndex = i;
          wildcardName = token.name;
          if (current.wildcardChild) {
            if (current.wildcardChild.wildcardName !== wildcardName) {
              throw new Error(`Route collision: wildcard "*${wildcardName}" conflicts with existing wildcard "*${current.wildcardChild.wildcardName}" on path "${path}"`);
            }
          } else {
            current.wildcardChild = new TrieNode('*');
            current.wildcardChild.wildcardName = wildcardName;
          }
          current = current.wildcardChild;
        } else {
          staticParts.push(token.value);
          let child = current.staticChildren.get(token.value);
          if (!child) {
            child = new TrieNode(token.value);
            current.staticChildren.set(token.value, child);
          }
          current = child;
        }
      }

      const missing = [];
      for (const name of allParams) {
        if (!present.has(name)) {
          missing.push(name);
        }
      }
      const constrained = paramKeys.some((k) => k.regex !== null);
      if (current.routes.some((r) => r.group === group)) current.sharedGroups = true;
      current.routes.push({ handlers, paramKeys, missing, wildcardIndex, wildcardName, routeEntry, group, constrained });
      if (constrained) current.constrained = true;

      if (paramKeys.length === 0 && wildcardIndex === -1) {
        this.staticRoutes.set('/' + staticParts.join('/'), current);
      }
    }
  }

  /**
   * Search for a route matching the given pathname.
   * `params` merges the parameters of every route ending at the matched node;
   * `matches` carries each route's own parameters (never shared across requests).
   * @param {string} pathname
   * @param {Set<TrieNode>} [skip] Nodes to treat as non-matching (next('route') fallback)
   * @returns {{
   *   node: TrieNode,
   *   handlers: Function[],
   *   params: Record<string, string>,
   *   handlersWithParams: Array<{ handler: Function, params: Record<string, string>, routeEntry: any }>,
   *   matches: Array<{ routeEntry: any, params: Record<string, string>, handlers: Function[] }>,
   *   routeEntries: any[],
   *   routes: any[]
   * } | null}
   */
  search(pathname, skip) {
    let node = this.staticRoutes.get(pathname);
    let segments = null;

    if (node === undefined || (skip !== undefined && skip.has(node))) {
      segments = Trie.splitPath(pathname);
      node = this._searchNode(this.root, segments, 0, skip);
      if (!node) return null;
    }

    const params = {};
    const handlers = [];
    const handlersWithParams = [];
    const matches = [];
    const routeEntries = [];
    const routes = node.routes;
    const seenGroups = node.sharedGroups ? new Set() : null;

    for (const route of routes) {
      if (seenGroups !== null) {
        if (seenGroups.has(route.group)) continue;
      }
      if (segments !== null && !accepts(route, segments)) continue;
      if (seenGroups !== null) seenGroups.add(route.group);

      let routeParams = params;
      if (segments !== null && (route.paramKeys.length > 0 || route.wildcardIndex !== -1 || route.missing.length > 0)) {
        routeParams = {};
        for (const { index, name } of route.paramKeys) {
          routeParams[name] = params[name] = decode(segments[index]);
        }
        for (const name of route.missing) {
          routeParams[name] = undefined;
          if (!(name in params)) params[name] = undefined;
        }
        if (route.wildcardIndex !== -1) {
          const val = decode(segments.slice(route.wildcardIndex).join('/'));
          routeParams['*'] = params['*'] = val;
          if (route.wildcardName !== '*') {
            routeParams[route.wildcardName] = params[route.wildcardName] = val;
          }
        }
      } else if (route.missing.length > 0) {
        // Static variant of a route with optional params (found via the static map)
        routeParams = {};
        for (const name of route.missing) {
          routeParams[name] = undefined;
          if (!(name in params)) params[name] = undefined;
        }
      }

      matches.push({ routeEntry: route.routeEntry, params: routeParams, handlers: route.handlers });
      if (route.routeEntry) routeEntries.push(route.routeEntry);
      for (const h of route.handlers) {
        handlers.push(h);
        handlersWithParams.push({ handler: h, params: routeParams, routeEntry: route.routeEntry });
      }
    }

    return { node, handlers, handlersWithParams, params, matches, routeEntries, routes };
  }

  /** A node ends a match when it has routes, isn't skipped, and one of them accepts the path. */
  _terminal(node, segments, skip) {
    if (node.routes.length === 0) return false;
    if (skip === undefined && !node.constrained) return true; // common case
    if (skip !== undefined && skip.has(node)) return false;
    if (!node.constrained) return true;
    for (const route of node.routes) {
      if (accepts(route, segments)) return true;
    }
    return false;
  }

  _searchNode(node, segments, index, skip) {
    // Reached the end of segments
    if (index === segments.length) {
      if (this._terminal(node, segments, skip)) return node;
      // A wildcard also matches the empty remainder
      const wildcard = node.wildcardChild;
      if (wildcard && this._terminal(wildcard, segments, skip)) return wildcard;
      return null;
    }

    const segment = segments[index];

    // 1. Exact static match first
    const staticChild = node.staticChildren.get(segment);
    if (staticChild !== undefined) {
      const match = this._searchNode(staticChild, segments, index + 1, skip);
      if (match) return match;
    }

    // 2. Parameterized match (:param)
    if (node.paramChild) {
      const match = this._searchNode(node.paramChild, segments, index + 1, skip);
      if (match) return match;
    }

    // 3. Wildcard match (*)
    const wildcard = node.wildcardChild;
    if (wildcard && this._terminal(wildcard, segments, skip)) return wildcard;

    return null;
  }
}
