/**
 * BareWeb benchmark suite.
 *
 * Compares BareWeb against a raw node:http baseline, Express, Fastify and Koa on four scenarios:
 *   1. static GET       /test
 *   2. param GET        /users/:id
 *   3. JSON POST echo   /echo            (body parsing)
 *   4. middleware chain /chain           (5 pass-through middlewares + route)
 *
 * Methodology (designed to survive noisy machines: hybrid P/E-core scheduling, frequency drift):
 *   - every framework runs in its own child process (benchmarks/server.js) on its own port, so
 *     the client never shares an event loop with a server under test;
 *   - every autocannon run is a fresh process (reusing one degrades ~4x on Windows);
 *   - trials are interleaved round-robin across frameworks, so slow drift hits all of them equally;
 *   - we report the MEDIAN req/s over trials (plus min/max) and median p99 latency.
 *
 * Usage:
 *   node benchmarks/compare.js                # all frameworks, all scenarios
 *   node benchmarks/compare.js --quick        # 1 trial, shorter durations
 *   node benchmarks/compare.js --md           # also print a Markdown table (for BENCHMARKS.md)
 *   BENCH_FRAMEWORKS=bareweb,express node benchmarks/compare.js
 *   BENCH_AFFINITY=0xFFF node benchmarks/compare.js   # pin every process to CPUs in the mask
 *
 * On hybrid CPUs (Intel P+E cores) the OS scheduler may land a run on efficiency cores and halve
 * throughput at random. BENCH_AFFINITY pins servers and clients to a CPU mask (P-cores are the
 * lowest-numbered logical CPUs, e.g. 0xFFF for 6 P-cores with hyper-threading). Implemented via
 * PowerShell on Windows and taskset on Linux; ignored elsewhere.
 */
import { execFile, fork } from 'node:child_process';
import { createRequire } from 'node:module';
import os from 'node:os';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const AUTOCANNON_BIN = require.resolve('autocannon/autocannon.js');

const FRAMEWORK_NAMES = ['node:http', 'bareweb', 'express', 'fastify', 'koa'];
// BENCH_SERVER_SCRIPT lets you point at a patched copy of server.js (e.g. one importing an older BareWeb)
const SERVER_SCRIPT = process.env.BENCH_SERVER_SCRIPT || fileURLToPath(new URL('./server.js', import.meta.url));

const QUICK = process.argv.includes('--quick');
const MARKDOWN = process.argv.includes('--md');
const WARMUP_DURATION = QUICK ? 1 : 2;
const DURATION = QUICK ? 2 : 5;
const TRIALS = QUICK ? 1 : 3;
const CONNECTIONS = 50;
const COOLDOWN_MS = 1000;
const BASE_PORT = 4100;
const AFFINITY = process.env.BENCH_AFFINITY ? Number(process.env.BENCH_AFFINITY) : 0;
const TASKSET = AFFINITY && process.platform === 'linux' ? maskToCpuList(AFFINITY) : null;

function maskToCpuList(mask) {
  const cpus = [];
  for (let i = 0; i < 64; i++) if ((BigInt(mask) >> BigInt(i)) & 1n) cpus.push(i);
  return cpus.join(',');
}

/** Pin a running process to the AFFINITY mask (Windows only; Linux uses taskset at spawn time). */
function pinProcess(pid) {
  if (!AFFINITY || process.platform !== 'win32') return Promise.resolve();
  return new Promise((resolve) => {
    execFile('powershell', ['-NoProfile', '-NonInteractive', '-Command',
      `(Get-Process -Id ${pid}).ProcessorAffinity = ${AFFINITY}`], () => resolve());
  });
}

/** Spawn `node file args` honouring the affinity mask. */
function spawnNode(file, args, options) {
  if (TASKSET) {
    return fork(file, args, { ...options, execPath: 'taskset', execArgv: ['-c', TASKSET, process.execPath] });
  }
  return fork(file, args, options);
}
const JSON_BODY = JSON.stringify({ name: 'Mechanical Keyboard', price: 149, tags: ['input', 'usb'] });

const SCENARIOS = [
  { name: 'static GET /test', path: '/test' },
  { name: 'param GET /users/:id', path: '/users/123' },
  { name: 'JSON POST /echo', path: '/echo', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON_BODY },
  { name: '5 middleware GET /chain', path: '/chain' }
];

function startServer(name, port) {
  return new Promise((resolve, reject) => {
    const child = spawnNode(SERVER_SCRIPT, [name, String(port)], { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
    const timer = setTimeout(() => reject(new Error(`${name}: server did not start within 10s`)), 10000);
    child.once('message', (msg) => {
      if (msg && msg.ready) {
        clearTimeout(timer);
        pinProcess(child.pid).then(() => resolve(child));
      }
    });
    child.once('exit', (code) => {
      clearTimeout(timer);
      reject(new Error(`${name}: server exited early with code ${code}`));
    });
  });
}

function stopServer(child) {
  return new Promise((resolve) => {
    child.once('exit', resolve);
    child.send('close');
    setTimeout(() => child.kill(), 3000).unref();
  });
}

/**
 * Run autocannon in a fresh child process and parse its JSON report.
 * Reusing the programmatic API inside one long-lived process degrades throughput ~4x after the
 * first run on Windows, so every run gets its own process.
 */
function runAutocannon(port, scenario, duration) {
  const args = [
    AUTOCANNON_BIN,
    '-c', String(CONNECTIONS),
    '-d', String(duration),
    '-p', '1',
    '-m', scenario.method || 'GET',
    '-j'
  ];
  for (const [k, v] of Object.entries(scenario.headers || {})) args.push('-H', `${k}=${v}`);
  if (scenario.body) args.push('-b', scenario.body);
  args.push(`http://127.0.0.1:${port}${scenario.path}`);

  return new Promise((resolve, reject) => {
    const bin = TASKSET ? 'taskset' : process.execPath;
    const argv = TASKSET ? ['-c', TASKSET, process.execPath, ...args] : args;
    const child = execFile(bin, argv, { maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(`autocannon failed: ${err.message}\n${stderr}`));
      try {
        resolve(JSON.parse(stdout));
      } catch (parseErr) {
        reject(new Error(`could not parse autocannon output: ${parseErr.message}\n${stdout.slice(0, 500)}`));
      }
    });
    pinProcess(child.pid);
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const median = (arr) => {
  const sorted = [...arr].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

function summarise(results) {
  const reqs = results.map((r) => r.requests.average);
  return {
    reqSec: Math.round(median(reqs)),
    min: Math.round(Math.min(...reqs)),
    max: Math.round(Math.max(...reqs)),
    latency: Number(median(results.map((r) => r.latency.average)).toFixed(2)),
    p99: Number(median(results.map((r) => r.latency.p99)).toFixed(2))
  };
}

async function main() {
  const selected = (process.env.BENCH_FRAMEWORKS || FRAMEWORK_NAMES.join(','))
    .split(',').map((s) => s.trim()).filter((s) => FRAMEWORK_NAMES.includes(s));

  console.log('====================================================');
  console.log('BareWeb Benchmark Suite');
  console.log(`Node ${process.version} | ${os.cpus()[0]?.model || 'unknown CPU'} x${os.cpus().length} | ${os.platform()} ${os.release()}`);
  console.log(`Frameworks: ${selected.join(', ')}`);
  console.log(`Trials: ${TRIALS} x ${DURATION}s (interleaved) | Warmup: ${WARMUP_DURATION}s | Connections: ${CONNECTIONS}`);
  if (AFFINITY) console.log(`CPU affinity: 0x${AFFINITY.toString(16)}`);
  console.log('====================================================\n');

  const servers = new Map(); // name -> { child, port }
  for (let i = 0; i < selected.length; i++) {
    const port = BASE_PORT + i;
    servers.set(selected[i], { child: await startServer(selected[i], port), port });
  }

  /** @type {Record<string, Record<string, import('autocannon').Result[]>>} scenario -> framework -> raw results */
  const raw = {};

  try {
    for (const scenario of SCENARIOS) {
      console.log(`--- ${scenario.name} ---`);
      process.stdout.write('  warmup: ');
      for (const name of selected) {
        await runAutocannon(servers.get(name).port, scenario, WARMUP_DURATION);
        process.stdout.write(`${name} `);
      }
      console.log();

      for (let trial = 1; trial <= TRIALS; trial++) {
        process.stdout.write(`  trial ${trial}/${TRIALS}: `);
        for (const name of selected) {
          // Let the previous run's sockets drain so TIME_WAIT churn does not bleed into this one
          await sleep(COOLDOWN_MS);
          const res = await runAutocannon(servers.get(name).port, scenario, DURATION);
          if (res.non2xx > 0 || res.errors > 0) {
            throw new Error(`${name} ${scenario.name}: ${res.non2xx} non-2xx, ${res.errors} errors - fix the harness before trusting numbers`);
          }
          ((raw[scenario.name] ||= {})[name] ||= []).push(res);
          process.stdout.write(`${name}=${Math.round(res.requests.average)} `);
        }
        console.log();
      }
      console.log();
    }
  } finally {
    await Promise.all([...servers.values()].map(({ child }) => stopServer(child)));
  }

  /** scenario -> framework -> summary */
  const table = {};
  for (const scenario of SCENARIOS) {
    table[scenario.name] = {};
    for (const name of selected) table[scenario.name][name] = summarise(raw[scenario.name][name]);
  }

  console.log('====================================================');
  console.log('Summary (median req/s over interleaved trials; higher is better)');
  console.log('====================================================\n');

  const rows = [];
  for (const scenario of SCENARIOS) {
    for (const name of selected) {
      const s = table[scenario.name][name];
      rows.push({
        Scenario: scenario.name,
        Framework: name,
        'Req/s (median)': s.reqSec,
        'min..max': `${s.min}..${s.max}`,
        'Avg ms': s.latency,
        'p99 ms': s.p99
      });
    }
  }
  console.table(rows);

  if (selected.includes('bareweb')) {
    console.log('BareWeb relative throughput:');
    for (const scenario of SCENARIOS) {
      const bw = table[scenario.name].bareweb.reqSec;
      const parts = selected.filter((n) => n !== 'bareweb').map((n) => {
        const other = table[scenario.name][n].reqSec;
        const delta = (bw / other - 1) * 100;
        const sign = Math.abs(delta) < 0.05 ? '±' : delta > 0 ? '+' : '';
        return `${n} ${sign}${delta.toFixed(1)}%`;
      });
      console.log(`  ${scenario.name.padEnd(26)} ${parts.join(' | ')}`);
    }
  }

  if (MARKDOWN) {
    console.log('\n--- Markdown ---\n');
    console.log(`| Scenario | ${selected.join(' | ')} |`);
    console.log(`|---|${selected.map(() => '---:').join('|')}|`);
    for (const scenario of SCENARIOS) {
      const cells = selected.map((n) => {
        const s = table[scenario.name][n];
        return `**${s.reqSec.toLocaleString('en-US')}** (p99 ${s.p99}ms)`;
      });
      console.log(`| ${scenario.name} | ${cells.join(' | ')} |`);
    }
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
