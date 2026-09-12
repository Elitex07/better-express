import createApp, { Router, cors } from '../src/index.js';

const app = createApp();
const PORT = process.env.PORT || 3000;

// In-memory data store for demonstration
const items = [
  { id: 1, name: 'Laptop Pro', price: 1299 },
  { id: 2, name: 'Mechanical Keyboard', price: 149 },
  { id: 3, name: 'Wireless Mouse', price: 49 }
];

// 1. Built-in zero-dependency CORS middleware
app.use(cors());

// 2. Global Logger Middleware (calculates response time)
app.use(async (req, res, next) => {
  const start = Date.now();
  await next();
  const duration = Date.now() - start;
  console.log(`[BareWeb] ${req.method} ${req.path} - ${res.statusCode} (${duration}ms)`);
});

// 3. Custom header middleware
app.use((req, res, next) => {
  res.setHeader('X-Powered-By', 'BareWeb');
  next();
});

// 4. Welcome / Home Route
app.get('/', (req, res) => {
  res.html(`
    <!DOCTYPE html>
    <html lang="en">
    <head>
      <meta charset="UTF-8">
      <title>BareWeb Server ⚡</title>
      <style>
        body { font-family: system-ui, -apple-system, sans-serif; background: #0b0f19; color: #f8fafc; padding: 3rem; }
        .card { background: #151e2e; padding: 2.5rem; border-radius: 14px; max-width: 640px; box-shadow: 0 10px 25px -5px rgb(0 0 0 / 0.3); border: 1px solid #1e293b; }
        h1 { color: #38bdf8; margin-top: 0; display: flex; align-items: center; gap: 0.5rem; }
        code { background: #1e293b; padding: 0.2rem 0.5rem; border-radius: 5px; font-size: 0.9em; color: #a5f3fc; }
        ul { line-height: 2; }
        a { color: #38bdf8; text-decoration: none; font-weight: 500; }
        a:hover { text-decoration: underline; }
        .tag { display: inline-block; background: #0369a1; color: #fff; font-size: 0.75rem; padding: 0.15rem 0.6rem; border-radius: 9999px; font-weight: 600; margin-left: 0.5rem; }
      </style>
    </head>
    <body>
      <div class="card">
        <h1>⚡ BareWeb is Running</h1>
        <p>A high-performance, optimized web server framework for Node.js built with a Radix Tree router and zero runtime dependencies.</p>
        <h3>Interactive API Endpoints:</h3>
        <ul>
          <li><a href="/api/v1/items">GET /api/v1/items</a> <span class="tag">Sub-Router</span></li>
          <li><a href="/api/v1/items/1">GET /api/v1/items/1</a></li>
          <li><a href="/search?q=keyboard">GET /search?q=keyboard</a> <span class="tag">Query Parsing</span></li>
          <li><a href="/cookie-demo">GET /cookie-demo</a> <span class="tag">Cookie Helper</span></li>
          <li><code>POST /api/v1/items</code> - Add new item (JSON body)</li>
        </ul>
      </div>
    </body>
    </html>
  `);
});

// 5. Sub-Router Demonstration (/api/v1)
const apiV1 = new Router();

// Sub-router scoped middleware
apiV1.use((req, res, next) => {
  res.setHeader('X-API-Version', 'v1');
  next();
});

// List all items (supports ?maxPrice filter)
apiV1.get('/items', (req, res) => {
  let result = items;
  if (req.query.maxPrice) {
    const max = parseFloat(req.query.maxPrice);
    result = result.filter(item => item.price <= max);
  }
  res.json({ count: result.length, items: result });
});

// Get item by ID (Parameterized route)
apiV1.get('/items/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const item = items.find(i => i.id === id);

  if (!item) {
    return res.status(404).json({ error: { message: `Item with id ${id} not found` } });
  }

  res.json(item);
});

// Add new item (JSON body parsing)
apiV1.post('/items', async (req, res) => {
  const body = await req.json();

  if (!body.name || typeof body.price !== 'number') {
    return res.status(400).json({ error: { message: 'Fields "name" and "price" are required' } });
  }

  const newItem = {
    id: items.length + 1,
    name: body.name,
    price: body.price
  };

  items.push(newItem);
  res.status(201).json({ message: 'Item created successfully', item: newItem });
});

// Mount sub-router into app
app.use('/api/v1', apiV1);

// 6. Search endpoint demonstrating query parsing
app.get('/search', (req, res) => {
  const query = req.query.q || '';
  const filtered = items.filter(item => 
    item.name.toLowerCase().includes(query.toLowerCase())
  );
  res.json({ query, results: filtered });
});

// 7. Cookie Demo
app.get('/cookie-demo', (req, res) => {
  res.cookie('lastVisit', new Date().toISOString(), { httpOnly: true });
  res.json({
    message: 'Cookie "lastVisit" set',
    receivedCookies: req.cookies
  });
});

// 8. Wildcard demonstration
app.get('/static/*', (req, res) => {
  res.json({ requestedFile: req.params['*'] });
});

// Start Server
app.listen(PORT, () => {
  console.log(`🚀 BareWeb server running at http://localhost:${PORT}`);
});
