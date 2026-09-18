# Benchmarks

Reproduce with:

```bash
npm run benchmark                 # ~8 minutes, all frameworks
npm run benchmark -- --quick      # ~2 minutes, single short trial
BENCH_FRAMEWORKS=bareweb,express npm run benchmark
BENCH_AFFINITY=0xFFF npm run benchmark   # pin to a CPU mask (see below)
```

## Scenarios

| Scenario | What it measures |
|---|---|
| `static GET /test` | Router + JSON serialisation floor |
| `param GET /users/:id` | Trie param extraction |
| `JSON POST /echo` | Body buffering + `JSON.parse` + response |
| `5 middleware GET /chain` | Middleware dispatch overhead (5 pass-through handlers before the route) |

All handlers return small JSON bodies. `node:http` is a hand-written baseline with a manual `if` router and
represents the ceiling; a framework can only get closer to it.

## Methodology

- Each framework server runs in its **own child process** on its own port (`benchmarks/server.js`). The
  original suite ran client and server on one event loop, which measured neither.
- Each `autocannon` run is a **fresh process**. Reusing the programmatic API in one long-lived process
  degraded throughput ~4x after the first run on Windows.
- Trials are **interleaved round-robin** across frameworks (`trial 1: A B C D E`, `trial 2: A B C D E`, ...),
  so machine-wide drift hits every framework equally. 3 trials × 5 s each, 50 connections, after a 2 s
  JIT warm-up per (framework, scenario).
- Reported value is the **median** req/s over trials, with `min..max` shown so you can judge noise.
- On hybrid CPUs (Intel P+E cores) Windows may schedule a run onto efficiency cores and halve throughput
  at random. `BENCH_AFFINITY=<mask>` pins every server and client to that CPU mask (PowerShell on Windows,
  `taskset` on Linux). P-cores are the lowest-numbered logical CPUs; `0xFFF` = first 12.

## Results

Recorded 2026-09-18 on Windows 11, Intel Core i5-14600K (pinned to the 6 P-cores, `BENCH_AFFINITY=0xFFF`),
Node v24.12.0, 50 connections, 3 x 5 s interleaved trials. Median req/s, p99 latency in parentheses.

| Scenario | node:http | bareweb | express | fastify | koa |
|---|---:|---:|---:|---:|---:|
| static GET /test | **48,810** (p99 1ms) | **43,901** (p99 1ms) | **30,453** (p99 3ms) | **48,112** (p99 1ms) | **43,536** (p99 2ms) |
| param GET /users/:id | **48,854** (p99 1ms) | **45,174** (p99 1ms) | **30,890** (p99 2ms) | **48,726** (p99 1ms) | **45,494** (p99 1ms) |
| JSON POST /echo | **44,189** (p99 1ms) | **39,331** (p99 1ms) | **26,002** (p99 3ms) | **39,350** (p99 1ms) | **32,757** (p99 2ms) |
| 5 middleware GET /chain | **48,746** (p99 1ms) | **44,349** (p99 1ms) | **30,286** (p99 2ms) | **49,027** (p99 1ms) | **46,358** (p99 1ms) |

BareWeb relative throughput (median vs median):

| Scenario | vs node:http | vs Express | vs Fastify | vs Koa |
|---|---:|---:|---:|---:|
| static GET /test | -10.1% | **+44.2%** | -8.8% | +0.8% |
| param GET /users/:id | -7.5% | **+46.2%** | -7.3% | -0.7% |
| JSON POST /echo | -11.0% | **+51.3%** | +0.0% | +20.1% |
| 5 middleware GET /chain | -9.0% | **+46.4%** | -9.5% | -4.3% |

Reading: BareWeb sits ~8-11% below the hand-written `node:http` ceiling, roughly level with Fastify and Koa,
and ~45-50% ahead of Express. The remaining gap to raw `node:http` is the price of a general router,
middleware pipeline and helper classes; see [ROADMAP.md](./ROADMAP.md) for what is still on the table.

### Before / after the hardening & performance pass

Same harness, BareWeb only, `origin/main` before this pass (`3239f53`) vs after, run back-to-back:

| Scenario | before | after | change |
|---|---:|---:|---:|
| static GET /test | 42,851 | 56,272 | **+31%** |
| param GET /users/:id | 43,126 | 56,944 | **+32%** |
| JSON POST /echo | 33,480 | 46,365 | **+38%** |
| 5 middleware GET /chain | 41,725 | 55,658 | **+34%** |

(Solo runs post higher absolute numbers than the five-framework run above because only one server
process is alive; compare ratios, not absolutes, across tables.)

Where it came from, roughly in order of impact: request/response helpers moved onto prototypes handed to
`http.createServer` (no per-request closure allocation), hand-rolled request-target split with lazy
`query`/`hostname`/`cookies` instead of `new URL()` per request, cached per-node execution plans in
`Router.resolve` instead of an O(stack) scan, and slimmer trie lookups.

Numbers from a single machine; absolute values will differ on yours - run the suite and compare the ratios.
