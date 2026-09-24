// Compile-only checks for src/index.d.ts (`npm run typecheck`).
// Lines marked @ts-expect-error must fail to type-check.
import http from 'node:http';
import createApp, {
  BareWeb,
  Router,
  cors,
  json,
  serveStatic,
  urlencoded,
  DEFAULT_BODY_LIMIT,
  MIME_TYPES,
  type Request,
  type Response,
  type NextFunction,
  type RequestHandler,
  type ErrorRequestHandler
} from 'bareweb';
import { createApp as namedCreateApp } from 'bareweb';

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends (<T>() => T extends B ? 1 : 2) ? true : false;
const assertType = <T extends true>(): T => true as T;

const app: BareWeb = createApp({
  trustProxy: true,
  methodNotAllowed: false,
  keepAliveTimeout: 65_000,
  headersTimeout: 66_000,
  requestTimeout: 0,
  maxBacktracks: 100
});
namedCreateApp();
new createApp.Router();

// @ts-expect-error unknown option
createApp({ trustproxy: true });

// Middleware and body parsers
app.use(json({ limit: DEFAULT_BODY_LIMIT }), urlencoded());
app.use('/static', serveStatic('public', { index: false, cacheControl: 'max-age=60', etag: true }));
app.use(cors({ origin: ['https://a.example'], credentials: true, exposedHeaders: 'X-Id', maxAge: 600 }));
app.use(cors({ origin: /\.example$/ }), cors({ origin: (o) => o.endsWith('.example') }));

// Route params are inferred from the path literal
app.get('/users/:id/files/*path', (req, res) => {
  assertType<Equal<typeof req.params, { id: string; '*': string; path: string }>>();
  // @ts-expect-error not a param of this route
  req.params.name;
  res.status(200).json({ id: req.params.id, file: req.params.path });
});
app.post('/items/:itemId', async (req, res, next) => {
  const body = await req.json<{ name: string }>();
  body.name.toUpperCase();
  if (!req.params.itemId) return next(new Error('missing'));
  if (req.params.itemId === '0') return next('route');
  await next();
  res.send(req.params.itemId);
});
const dynamicPath: string = '/x';
app.put(dynamicPath, (req, res) => {
  const p: Record<string, string> = req.params;
  res.sendStatus(204);
});

// Request helpers
app.get('/req', (req, res) => {
  const ip: string = req.ip;
  const secure: boolean = req.secure;
  const q = req.query.tags;
  const tags: string[] = Array.isArray(q) ? q : q ? [q] : [];
  const session: string | undefined = req.cookies.session;
  const ua: string | undefined = req.get('user-agent');
  const setCookie: string[] | undefined = req.get('set-cookie');
  req.ip = '10.0.0.1';
  req.app.settings.trustProxy;
  res.set({ 'X-A': '1' }).header('X-B', ['1', '2']).type('json').send({ tags, ip, secure, session, ua, setCookie });
});

// Response helpers
app.get('/res', async (req, res) => {
  res.cookie('sid', 'abc', { httpOnly: true, sameSite: 'lax', maxAge: 1000 }).clearCookie('old');
  res.redirect('/elsewhere');
  res.redirect(301, '/moved');
  res.html('<p>hi</p>');
  await res.sendFile('file.txt', { acceptRanges: false });
  await res.sendFile('file.txt', (err) => { if (err) console.error(err); });
  // @ts-expect-error invalid sameSite
  res.cookie('a', 'b', { sameSite: 'sometimes' });
});

// Handler arrays, reusable typed handlers and error handlers
const auth: RequestHandler = (req, res, next) => { next(); };
const onError: ErrorRequestHandler = (err, req, res, next) => { res.status(500).json({ message: String(err) }); };
app.get('/multi', [auth, auth], (req: Request, res: Response) => res.send('ok'));
app.use(onError);
// Inline error handlers need annotations (TypeScript can't infer 4-arg arrows via overloads)
app.use((err: any, req: Request, res: Response, next: NextFunction) => {
  res.status(err.statusCode ?? 500).json({ path: req.path });
  next();
});
app.get('/boom/:id', auth, onError);
// @ts-expect-error handlers must be functions
app.get('/bad', 42);
app.use('/api', auth, onError);

// Routers and sub-apps
const router = new Router({ maxBacktracks: 10 });
router.get('/:slug', (req, res) => res.send(req.params.slug));
router.add('OPTIONS', '/:slug', (req, res) => res.sendStatus(204));
router.options('/:slug/meta', (req, res) => res.send(req.params.slug));
app.options('/preflight/:id', (req, res) => res.send(req.params.id));
const maxBacktracks: number | undefined = router.settings.maxBacktracks;
app.use('/r', router);
app.use('/sub', createApp());
const methods: string[] = router.allowedMethods('/x');
const routes = router.routes.map((r) => `${r.method} ${r.path}`);

// Lifecycle
const server: http.Server = app.listen(3000, '127.0.0.1', () => {});
app.listen(0);
http.createServer(app.handle);
void app.close();
void app.close({ timeout: 5000 });
app.close((err) => { if (err) console.error(err); });
app.close({ timeout: 1 }, () => {});

const mime: string | undefined = MIME_TYPES['.json'];
const next: NextFunction = () => {};
void [server, methods, routes, mime, next];
