/**
 * Benchmark suite: BareWeb vs Express.js vs raw node:http (and optionally Next.js).
 *
 * Each server runs in its own child process, so autocannon never competes with the
 * server under test for the same event loop.
 *
 * Env knobs:
 *   BENCH_DURATION=5      seconds per trial
 *   BENCH_TRIALS=3        trials per scenario (mean is reported)
 *   BENCH_CONNECTIONS=50  concurrent connections
 *   BENCH_WORKERS=0       autocannon worker threads (use 2+ on multi-core machines, otherwise
 *                         the load generator, not the server, becomes the bottleneck)
 *   BENCH_ONLY=bareweb,express   subset of frameworks
 *   NEXT_URL=http://127.0.0.1:3000   an already running `next start` app that serves
 *                                    GET /test and GET /users/[id] route handlers
 */
import { fork } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import autocannon from 'autocannon';

const DURATION = Number(process.env.BENCH_DURATION || 5);
const WARMUP_DURATION = 2;
const TRIALS = Number(process.env.BENCH_TRIALS || 3);
const CONNECTIONS = Number(process.env.BENCH_CONNECTIONS || 50);
const WORKERS = Number(process.env.BENCH_WORKERS || 0);
const SERVER_SCRIPT = fileURLToPath(new URL('./server.js', import.meta.url));

const FRAMEWORKS = [
  { name: 'node:http', key: 'node', port: 4000 },
  { name: 'Express', key: 'express', port: 4001 },
  { name: 'BareWeb', key: 'bareweb', port: 4002 }
].filter((f) => !process.env.BENCH_ONLY || process.env.BENCH_ONLY.split(',').includes(f.key));

const SCENARIOS = [
  { name: 'Static route', path: '/test' },
  { name: 'Param route', path: '/users/123' },
  { name: '5 middlewares', path: '/mw/test' },
  { name: '500-route table', path: '/r499' },
  { name: '404', path: '/nope' },
  {
    name: 'POST JSON',
    path: '/echo',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'bench', tags: ['a', 'b', 'c'], nested: { n: 1 } })
  }
];

function startServer(key, port) {
  return new Promise((resolve, reject) => {
    const child = fork(SERVER_SCRIPT, [key, String(port)], { stdio: 'inherit' });
    child.once('message', (msg) => msg === 'ready' && resolve(child));
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`${key} server exited with code ${code}`)));
  });
}

function run(opts, duration) {
  return new Promise((resolve, reject) => {
    const workers = WORKERS > 0 ? { workers: WORKERS } : {};
    autocannon({ connections: CONNECTIONS, pipelining: 1, duration, ...workers, ...opts }, (err, result) =>
      err ? reject(err) : resolve(result)
    );
  });
}

async function measure(baseUrl, scenario) {
  const opts = {
    url: baseUrl + scenario.path,
    method: scenario.method || 'GET',
    headers: scenario.headers,
    body: scenario.body
  };
  await run(opts, WARMUP_DURATION);
  const results = [];
  for (let i = 0; i < TRIALS; i++) results.push(await run(opts, DURATION));
  const mean = (fn) => results.reduce((acc, r) => acc + fn(r), 0) / results.length;
  return {
    reqSec: Math.round(mean((r) => r.requests.average)),
    p99: Number(mean((r) => r.latency.p99).toFixed(2)),
    errors: results.reduce((acc, r) => acc + r.errors + r.non2xx, 0)
  };
}

async function main() {
  console.log(`Trials: ${TRIALS} x ${DURATION}s | Warmup: ${WARMUP_DURATION}s | Connections: ${CONNECTIONS} | Workers: ${WORKERS}\n`);

  const targets = [];
  const rows = [];
  try {
    // Inside try: if a later server fails to start, the earlier ones are still killed
    for (const fw of FRAMEWORKS) {
      targets.push({ ...fw, url: `http://127.0.0.1:${fw.port}`, child: await startServer(fw.key, fw.port) });
    }
    if (process.env.NEXT_URL) {
      targets.push({ name: 'Next.js', url: process.env.NEXT_URL, only: ['/test', '/users/123'] });
    }

    for (const scenario of SCENARIOS) {
      const row = { Scenario: scenario.name };
      for (const target of targets) {
        if (target.only && !target.only.includes(scenario.path)) {
          row[target.name] = '-';
          continue;
        }
        process.stdout.write(`  ${scenario.name} @ ${target.name}... `);
        const r = await measure(target.url, scenario);
        // 404 scenario is expected to be non-2xx; ignore those counts there.
        const errNote = r.errors && scenario.path !== '/nope' ? ` (${r.errors} errors)` : '';
        console.log(`${r.reqSec} req/s, p99 ${r.p99}ms${errNote}`);
        row[target.name] = `${r.reqSec} (p99 ${r.p99}ms)`;
        target[scenario.name] = r.reqSec;
      }
      rows.push(row);
    }
  } finally {
    for (const t of targets) t.child?.kill();
  }

  console.log('\nRequests/sec (mean), p99 latency');
  console.table(rows);

  const bare = targets.find((t) => t.key === 'bareweb');
  const exp = targets.find((t) => t.key === 'express');
  if (bare && exp) {
    console.log('\nBareWeb vs Express:');
    for (const s of SCENARIOS) {
      const delta = ((bare[s.name] / exp[s.name] - 1) * 100).toFixed(1);
      console.log(`  ${s.name.padEnd(16)} ${delta >= 0 ? '+' : ''}${delta}%`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
