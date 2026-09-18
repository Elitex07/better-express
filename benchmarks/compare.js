import autocannon from 'autocannon';
import express from 'express';
import { createApp } from '../src/index.js';

const PORT_EXPRESS = 4001;
const PORT_BAREWEB = 4002;
const WARMUP_DURATION = 2; // seconds for JIT warm-up
const DURATION = 5;        // seconds per trial run
const TRIALS = 3;          // number of benchmark trials
const CONNECTIONS = 50;

async function startExpressServer() {
  const app = express();
  app.get('/test', (req, res) => {
    res.json({ message: 'Hello from benchmark', timestamp: Date.now() });
  });
  app.get('/users/:id', (req, res) => {
    res.json({ userId: req.params.id });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT_EXPRESS, '127.0.0.1', () => resolve(server));
  });
}

async function startBareWebServer() {
  const app = createApp();
  app.get('/test', (req, res) => {
    res.json({ message: 'Hello from benchmark', timestamp: Date.now() });
  });
  app.get('/users/:id', (req, res) => {
    res.json({ userId: req.params.id });
  });

  return new Promise((resolve) => {
    const server = app.listen(PORT_BAREWEB, '127.0.0.1', () => resolve(server));
  });
}

function runAutocannon(url, title, duration = DURATION) {
  return new Promise((resolve, reject) => {
    autocannon({
      url,
      connections: CONNECTIONS,
      duration,
      pipelining: 1
    }, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
  });
}

async function runBenchmarkWithTrials(url, title) {
  // Warm-up run (not included in metrics)
  process.stdout.write(`  Warming up ${title} (${WARMUP_DURATION}s)... `);
  await runAutocannon(url, title, WARMUP_DURATION);
  console.log('done.');

  const results = [];
  for (let trial = 1; trial <= TRIALS; trial++) {
    process.stdout.write(`  Trial ${trial}/${TRIALS} for ${title}... `);
    const res = await runAutocannon(url, title, DURATION);
    results.push(res);
    console.log(`${Math.round(res.requests.average)} req/s`);
  }

  const avgReqSec = results.reduce((acc, r) => acc + r.requests.average, 0) / results.length;
  const avgLatency = results.reduce((acc, r) => acc + r.latency.average, 0) / results.length;
  const avgP99 = results.reduce((acc, r) => acc + r.latency.p99, 0) / results.length;

  // Compute standard deviation of throughput
  const variance = results.reduce((acc, r) => acc + Math.pow(r.requests.average - avgReqSec, 2), 0) / results.length;
  const stdDev = Math.sqrt(variance);

  return {
    avgReqSec: Math.round(avgReqSec),
    stdDev: Math.round(stdDev),
    avgLatency: Number(avgLatency.toFixed(2)),
    avgP99: Number(avgP99.toFixed(2))
  };
}

async function main() {
  console.log('====================================================');
  console.log('🔥 BareWeb vs Express.js Benchmark Suite');
  console.log(`Trials: ${TRIALS} x ${DURATION}s | Warmup: ${WARMUP_DURATION}s | Concurrency: ${CONNECTIONS}`);
  console.log('====================================================\n');

  const expressServer = await startExpressServer();
  const bareWebServer = await startBareWebServer();

  try {
    // 1. Static Route
    console.log('--- 1. Static Route (/test) ---');
    const expressStatic = await runBenchmarkWithTrials(`http://127.0.0.1:${PORT_EXPRESS}/test`, 'Express');
    const bareWebStatic = await runBenchmarkWithTrials(`http://127.0.0.1:${PORT_BAREWEB}/test`, 'BareWeb');

    // 2. Parameterized Route
    console.log('\n--- 2. Parameterized Route (/users/123) ---');
    const expressParam = await runBenchmarkWithTrials(`http://127.0.0.1:${PORT_EXPRESS}/users/123`, 'Express');
    const bareWebParam = await runBenchmarkWithTrials(`http://127.0.0.1:${PORT_BAREWEB}/users/123`, 'BareWeb');

    console.log('\n====================================================');
    console.log('📊 Benchmark Results Summary (Multi-Trial Means)');
    console.log('====================================================\n');

    const summaryTable = [
      {
        Route: '/test (Static)',
        Framework: 'Express.js',
        'Req/Sec (Mean)': expressStatic.avgReqSec,
        'Std Dev': `±${expressStatic.stdDev}`,
        'Avg Latency (ms)': expressStatic.avgLatency,
        'p99 Latency (ms)': expressStatic.avgP99
      },
      {
        Route: '/test (Static)',
        Framework: 'BareWeb ⚡',
        'Req/Sec (Mean)': bareWebStatic.avgReqSec,
        'Std Dev': `±${bareWebStatic.stdDev}`,
        'Avg Latency (ms)': bareWebStatic.avgLatency,
        'p99 Latency (ms)': bareWebStatic.avgP99
      },
      {
        Route: '/users/:id (Param)',
        Framework: 'Express.js',
        'Req/Sec (Mean)': expressParam.avgReqSec,
        'Std Dev': `±${expressParam.stdDev}`,
        'Avg Latency (ms)': expressParam.avgLatency,
        'p99 Latency (ms)': expressParam.avgP99
      },
      {
        Route: '/users/:id (Param)',
        Framework: 'BareWeb ⚡',
        'Req/Sec (Mean)': bareWebParam.avgReqSec,
        'Std Dev': `±${bareWebParam.stdDev}`,
        'Avg Latency (ms)': bareWebParam.avgLatency,
        'p99 Latency (ms)': bareWebParam.avgP99
      }
    ];

    console.table(summaryTable);

    const speedupStatic = (((bareWebStatic.avgReqSec / expressStatic.avgReqSec) - 1) * 100).toFixed(1);
    const speedupParam = (((bareWebParam.avgReqSec / expressParam.avgReqSec) - 1) * 100).toFixed(1);

    console.log('\n🚀 Performance Delta:');
    console.log(`- Static Route: BareWeb is ${speedupStatic >= 0 ? `+${speedupStatic}% faster` : `${speedupStatic}%`}`);
    console.log(`- Parameterized Route: BareWeb is ${speedupParam >= 0 ? `+${speedupParam}% faster` : `${speedupParam}%`}`);
  } finally {
    expressServer.close();
    bareWebServer.close();
  }
}

main().catch(console.error);
