/// <reference types="node" />
import * as http from 'node:http';

// ---------------------------------------------------------------------------
// Route parameters
// ---------------------------------------------------------------------------

/** `id(\\d+)` -> `id` */
type StripPattern<S extends string> = S extends `${infer Name}(${string}` ? Name : S;

type RequiredParamOf<Segment extends string> =
  Segment extends `:${infer Rest}` ? (Rest extends `${string}?` ? never : StripPattern<Rest>) :
  Segment extends '*' ? '*' :
  Segment extends `*${infer Name}` ? '*' | Name :
  never;

type OptionalParamOf<Segment extends string> =
  Segment extends `:${infer Rest}` ? (Rest extends `${infer Body}?` ? StripPattern<Body> : never) : never;

type RequiredParams<Path extends string> =
  Path extends `${infer Head}/${infer Tail}` ? RequiredParamOf<Head> | RequiredParams<Tail> : RequiredParamOf<Path>;

type OptionalParams<Path extends string> =
  Path extends `${infer Head}/${infer Tail}` ? OptionalParamOf<Head> | OptionalParams<Tail> : OptionalParamOf<Path>;

type Flatten<T> = { [K in keyof T]: T[K] };

/**
 * `req.params` shape inferred from a route path literal (Express 4 syntax):
 * `'/users/:id(\\d+)/:tab?/*rest'` -> `{ id: string; tab?: string; '*': string; rest: string }`.
 * Non-literal paths fall back to `Record<string, string>`. Patterns containing "/" are not
 * inferred correctly; annotate those routes' params yourself.
 */
export type RouteParameters<Path extends string> =
  string extends Path
    ? ParamsDictionary
    : Flatten<{ [K in RequiredParams<Path>]: string } & { [K in OptionalParams<Path>]?: string }>;

export interface ParamsDictionary {
  [key: string]: string;
}

export interface ParsedQuery {
  [key: string]: string | string[];
}

// ---------------------------------------------------------------------------
// Request / Response
// ---------------------------------------------------------------------------

export interface Request<P = ParamsDictionary, ReqBody = any> extends http.IncomingMessage {
  /** Route parameters (percent-decoded). */
  params: P;
  /** Request path without the query string. */
  path: string;
  /** Mount prefix of the currently running middleware ('' at the root). */
  baseUrl: string;
  /** Parsed query string; `key[]` and repeated keys become arrays. Assignable. */
  query: ParsedQuery;
  /** Raw query string without the leading "?" ('' when absent). */
  readonly search: string;
  searchParams: URLSearchParams;
  /** Parsed `Cookie` header. Assignable. */
  cookies: Record<string, string>;
  /** Set by `json()` / `urlencoded()` or `req.json()` / `req.urlencoded()`. */
  body: ReqBody;
  /** The application handling this request. */
  app: BareWeb;
  /** Client address; honours `X-Forwarded-For` only with `trustProxy`. Assignable. */
  ip: string;
  /** `'http'` or `'https'`; honours `X-Forwarded-Proto` only with `trustProxy`. Assignable. */
  protocol: string;
  secure: boolean;
  /** Host without port; honours `X-Forwarded-Host` only with `trustProxy`. Assignable. */
  hostname: string;
  /** `X-Requested-With: XMLHttpRequest`. Assignable. */
  xhr: boolean;

  /** Header lookup (case-insensitive; `referer`/`referrer` are interchangeable). */
  get(headerName: 'set-cookie'): string[] | undefined;
  get(headerName: string): string | undefined;

  /** Raw body. Rejects with a 413 error (`statusCode: 413`) above `limit` bytes. */
  buffer(limit?: number): Promise<Buffer>;
  text(limit?: number): Promise<string>;
  /** Parses and caches the body in `req.body`. Rejects with a 400 error on invalid JSON. */
  json<T = ReqBody>(limit?: number): Promise<T>;
  urlencoded(limit?: number): Promise<ParsedQuery>;
}

export interface CookieOptions {
  /** Milliseconds; also sets `Expires` unless `expires` is given. */
  maxAge?: number;
  expires?: Date;
  domain?: string;
  /** Default `'/'`. */
  path?: string;
  httpOnly?: boolean;
  secure?: boolean;
  /** `true` means `Strict`; `'none'` requires `secure: true`. */
  sameSite?: boolean | 'strict' | 'lax' | 'none' | 'Strict' | 'Lax' | 'None';
  priority?: 'low' | 'medium' | 'high' | 'Low' | 'Medium' | 'High';
  /** CHIPS partitioned cookie; requires `secure: true`. */
  partitioned?: boolean;
}

export interface SendFileOptions {
  /** Default `true`. */
  etag?: boolean;
  /** Default `true`. */
  lastModified?: boolean;
  /** Serve single byte ranges (206 / 416). Default `true`. */
  acceptRanges?: boolean;
  cacheControl?: string;
  /** Extra headers, set once the file is found. A Content-Type here wins over the extension. */
  headers?: Record<string, string | number | readonly string[]>;
  /** Called instead of sending a 404/500 when the file is missing or the stream fails. */
  onError?: (err: Error & { statusCode?: number }) => void;
}

export interface Response<ResBody = any> extends http.ServerResponse<http.IncomingMessage> {
  status(code: number): this;
  set(name: string, value: string | number | readonly string[]): this;
  set(headers: Record<string, string | number | readonly string[]>): this;
  header(name: string, value: string | number | readonly string[]): this;
  header(headers: Record<string, string | number | readonly string[]>): this;
  /** Full MIME type, or an extension such as `'json'` / `'.html'`. */
  type(type: string): this;
  json(data: ResBody): this;
  /** Strings are sent as text/html or text/plain, Buffers as octet-stream, objects as JSON. */
  send(body?: ResBody | string | Buffer | Uint8Array | number | boolean | null): this;
  html(html: string): this;
  sendStatus(statusCode: number): this;
  cookie(name: string, value: string, options?: CookieOptions): this;
  clearCookie(name: string, options?: CookieOptions): this;
  /** Set `Location` without ending the response; `'back'` uses the Referer or `/`. */
  location(url: string): this;
  /** Default status 302, with a short text body; `'back'` redirects to the Referer. */
  redirect(url: string, status?: number): this;
  redirect(status: number, url: string): this;
  /** Resolves once the response is finished (or an error response was sent); never rejects. */
  sendFile(filePath: string, callback?: (err: Error | null) => void): Promise<void>;
  sendFile(filePath: string, options?: SendFileOptions, callback?: (err: Error | null) => void): Promise<void>;
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * Continue the pipeline. Pass an error to jump to error handlers, or `'route'` to skip the
 * remaining handlers of the current route. Returns the downstream promise, so
 * `await next()` waits for async handlers.
 */
export interface NextFunction {
  (err?: unknown): void | Promise<void>;
  (deferToNext: 'route'): void | Promise<void>;
}

export type RequestHandler<P = ParamsDictionary, ReqBody = any, ResBody = any> = (
  req: Request<P, ReqBody>,
  res: Response<ResBody>,
  next: NextFunction
) => unknown;

/** Four-parameter handlers are error handlers (detected via `Function.length`). */
export type ErrorRequestHandler<P = ParamsDictionary, ReqBody = any, ResBody = any> = (
  err: any,
  req: Request<P, ReqBody>,
  res: Response<ResBody>,
  next: NextFunction
) => unknown;

export type Handler<P = ParamsDictionary, ReqBody = any, ResBody = any> =
  | RequestHandler<P, ReqBody, ResBody>
  | ErrorRequestHandler<P, ReqBody, ResBody>;

type Many<T> = Array<T | T[]>;
type HandlerArgs<P> = Many<Handler<P>>;
type UseItem = Handler | Router | BareWeb | null | undefined | false;

/*
 * Plain handlers come first so inline arrow functions get contextual types. TypeScript cannot
 * contextually type a 4-parameter arrow through overloads, so inline error handlers need
 * parameter annotations (or a const typed as ErrorRequestHandler); they then match the
 * catch-all overload.
 */
export interface RouteMethod<This> {
  <Path extends string>(path: Path, ...handlers: Many<RequestHandler<RouteParameters<Path>>>): This;
  <Path extends string>(path: Path, ...handlers: HandlerArgs<RouteParameters<Path>>): This;
}

export interface UseMethod<This> {
  (prefix: string, ...handlers: Many<RequestHandler>): This;
  (...handlers: Many<RequestHandler>): This;
  /** Error handlers, routers, sub-apps and mixed lists. */
  (prefix: string, ...items: Many<UseItem>): This;
  (...items: Many<UseItem>): This;
}

// ---------------------------------------------------------------------------
// Router
// ---------------------------------------------------------------------------

export interface RouterOptions {
  /**
   * @deprecated Ignored. Route search visits each trie node at most once, so it needs no
   * backtracking cap.
   */
  maxBacktracks?: number;
}

export interface RouteInfo {
  method: string;
  path: string;
  handlers: Handler[];
}

export interface MiddlewareInfo {
  prefix: string;
  handler: Handler;
  isErrorHandler: boolean;
}

export interface PipelineItem {
  prefix: string;
  handler: Handler;
  params?: ParamsDictionary;
  route?: number;
}

export interface ResolvedPipeline {
  isRouteMatched: boolean;
  params: ParamsDictionary;
  pipeline: PipelineItem[];
  errorHandlers: PipelineItem[];
}

export class Router {
  constructor(options?: RouterOptions);
  /** Constructor options. */
  settings: RouterOptions;

  /** Per-method route tries, including mounted sub-routers. */
  readonly trees: Map<string, Trie>;
  /** Flattened routes, including mounted ones. */
  readonly routes: RouteInfo[];
  /** Flattened middlewares, including mounted ones. */
  readonly middlewares: MiddlewareInfo[];

  /** Middleware with an optional path prefix, or mount a sub-router / sub-app. */
  use: UseMethod<this>;
  /** Mount a router under a prefix. Later registrations on it are picked up (live mounting). */
  mount(prefix: string, subRouter: Router): this;
  add<Path extends string>(method: string, path: Path, ...handlers: Many<RequestHandler<RouteParameters<Path>>>): this;
  add<Path extends string>(method: string, path: Path, ...handlers: HandlerArgs<RouteParameters<Path>>): this;

  get: RouteMethod<this>;
  post: RouteMethod<this>;
  put: RouteMethod<this>;
  delete: RouteMethod<this>;
  patch: RouteMethod<this>;
  options: RouteMethod<this>;
  head: RouteMethod<this>;
  all: RouteMethod<this>;

  resolve(method: string, pathname: string): ResolvedPipeline;
  /** Methods with a route matching `pathname` (HEAD implied by GET). */
  allowedMethods(pathname: string): string[];
  find(method: string, pathname: string): { handlers: Handler[]; params: ParamsDictionary } | null;
}

// ---------------------------------------------------------------------------
// Application
// ---------------------------------------------------------------------------

export interface AppOptions extends RouterOptions {
  /** Trust `X-Forwarded-*` for `req.ip` / `protocol` / `hostname`. Default `false`. */
  /**
   * Trust X-Forwarded-* from: everyone (`true`), listed peer addresses (`'loopback'`,
   * `'10.0.0.2'`, arrays or comma lists), or a predicate on the peer address.
   */
  trustProxy?: boolean | string | readonly string[] | ((remoteAddress: string) => boolean);
  /** Answer 405 + `Allow` and automatic `OPTIONS`. Default `true`; `false` sends 404. */
  methodNotAllowed?: boolean;
  /** ms an idle keep-alive socket stays open (Node default 5000). */
  keepAliveTimeout?: number;
  /** ms allowed to receive the request headers (Node default 60000). */
  headersTimeout?: number;
  /** ms allowed to receive the whole request (Node default 300000); `0` disables. */
  requestTimeout?: number;
}

export interface CloseOptions {
  /** Destroy connections still open after this many ms. */
  timeout?: number;
}

export class BareWeb {
  constructor(options?: AppOptions);
  /** Constructor options. */
  settings: AppOptions;
  router: Router;
  server: http.Server | null;
  middleware: {
    use: UseMethod<BareWeb>;
    readonly entries: MiddlewareInfo[];
  };

  use: UseMethod<this>;

  get: RouteMethod<this>;
  post: RouteMethod<this>;
  put: RouteMethod<this>;
  delete: RouteMethod<this>;
  patch: RouteMethod<this>;
  options: RouteMethod<this>;
  head: RouteMethod<this>;
  all: RouteMethod<this>;

  /** Request listener, usable as `http.createServer(app.handle)`. */
  handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> | undefined;

  /** Listens on `::` (IPv4 + IPv6) when no host is given. */
  listen(port?: number, callback?: () => void): http.Server;
  listen(port: number, host: string, callback?: () => void): http.Server;

  /**
   * Graceful shutdown: stop accepting connections, close idle keep-alive sockets and let
   * in-flight requests finish with `Connection: close`.
   */
  close(callback?: (err?: Error) => void): Promise<void>;
  close(options: CloseOptions, callback?: (err?: Error) => void): Promise<void>;
}

// ---------------------------------------------------------------------------
// Middleware
// ---------------------------------------------------------------------------

export type CorsOrigin =
  | string
  | ReadonlyArray<string | RegExp>
  | RegExp
  | boolean
  | ((origin: string) => boolean | string | null | undefined);

export interface CorsOptions {
  /** Default `'*'`. `true` reflects the request origin. */
  origin?: CorsOrigin;
  methods?: string | readonly string[];
  /** Allowed request headers. Default: reflect the preflight's Access-Control-Request-Headers. */
  headers?: string | readonly string[];
  allowedHeaders?: string | readonly string[];
  exposedHeaders?: string | readonly string[];
  /** Requires an explicit `origin`. */
  credentials?: boolean;
  /** Preflight cache in seconds. */
  maxAge?: number;
  /** Pass OPTIONS on instead of answering 204. Default `false`. */
  preflightContinue?: boolean;
}

export interface ServeStaticOptions extends Omit<SendFileOptions, 'onError'> {
  /** Directory index file, or `false` to disable. Default `'index.html'`. */
  index?: string | false;
  /**
   * Serve `file.br` / `file.gz` siblings when the client accepts that encoding.
   * `true` = `['br', 'gzip']` (preference order). Adds `Vary: Accept-Encoding`.
   */
  precompressed?: boolean | ReadonlyArray<'br' | 'gzip'>;
}

export interface BodyParserOptions {
  /** Maximum body size in bytes. Default 1 MB. */
  limit?: number;
}

// Built-ins never read req.app, so they are typed for standalone use too; a standalone
// handler is accepted anywhere an app handler is.
export function cors(options?: CorsOptions): StandaloneRequestHandler;
export function serveStatic(rootPath: string, options?: ServeStaticOptions): StandaloneRequestHandler;
export function json(options?: BodyParserOptions): StandaloneRequestHandler;
export function urlencoded(options?: BodyParserOptions): StandaloneRequestHandler;

/**
 * A request run through `MiddlewareStack` outside an app: `req.app` is only set when the
 * caller set it, unlike requests dispatched by `BareWeb`, which always have it.
 */
export type StandaloneRequest<P = ParamsDictionary, ReqBody = any> = Omit<Request<P, ReqBody>, 'app'> & {
  app?: BareWeb;
};

export type StandaloneRequestHandler = (req: StandaloneRequest, res: Response, next: NextFunction) => unknown;
export type StandaloneErrorRequestHandler = (err: any, req: StandaloneRequest, res: Response, next: NextFunction) => unknown;
export type StandaloneHandler = StandaloneRequestHandler | StandaloneErrorRequestHandler;

/**
 * Standalone middleware runner; applications dispatch through Router directly.
 * Handlers typed with `Request` (which promises `req.app`) are rejected here; type them
 * as `StandaloneRequestHandler` instead.
 */
export class MiddlewareStack {
  entries: Array<{ prefix: string; handler: StandaloneHandler; isErrorHandler: boolean }>;
  use(prefix: string, ...handlers: Many<StandaloneRequestHandler>): void;
  use(...handlers: Many<StandaloneRequestHandler>): void;
  use(prefix: string, ...handlers: Many<StandaloneHandler>): void;
  use(...handlers: Many<StandaloneHandler>): void;
  run(req: StandaloneRequest, res: Response, routeHandlers?: StandaloneHandler[], isRouteMatched?: boolean): Promise<void>;
  runPipeline(
    req: StandaloneRequest,
    res: Response,
    pipeline?: Array<StandaloneHandler | { prefix: string; handler: StandaloneHandler; route?: number }>,
    errorHandlers?: Array<StandaloneHandler | { prefix: string; handler: StandaloneHandler; route?: number }>,
    isRouteMatched?: boolean
  ): Promise<void>;
}

// ---------------------------------------------------------------------------
// Low-level utilities
// ---------------------------------------------------------------------------

export interface TrieMatch {
  routeEntry: unknown;
  params: ParamsDictionary;
  handlers: Handler[];
}

export interface TrieSearchResult {
  /** The matched trie node. */
  node: unknown;
  handlers: Handler[];
  params: ParamsDictionary;
  handlersWithParams: Array<{ handler: Handler; params: ParamsDictionary; routeEntry: unknown }>;
  matches: TrieMatch[];
  routeEntries: unknown[];
  routes: unknown[];
}

export class Trie {
  constructor(options?: RouterOptions);
  static splitPath(path: string): string[];
  insert(path: string, handlers: Handler[], routeEntry?: unknown): void;
  /** `skip`: nodes to treat as non-matching (used by the next('route') fallback). */
  search(pathname: string, skip?: Set<unknown>): TrieSearchResult | null;
}

/** Default body size limit in bytes (1 MB). */
export const DEFAULT_BODY_LIMIT: number;
/** Extension (with dot) -> Content-Type. */
export const MIME_TYPES: Record<string, string>;

export function parseQuery(searchParams: Iterable<[string, string]>): ParsedQuery;
export function decorateRequest(
  req: http.IncomingMessage,
  params?: ParamsDictionary,
  parsedUrl?: { pathname: string; search?: string }
): Request;
export function decorateResponse(res: http.ServerResponse): Response;

export interface CreateApp {
  (options?: AppOptions): BareWeb;
  BareWeb: typeof BareWeb;
  Router: typeof Router;
  Trie: typeof Trie;
  cors: typeof cors;
  serveStatic: typeof serveStatic;
  json: typeof json;
  urlencoded: typeof urlencoded;
}

export const createApp: CreateApp;
export default createApp;
