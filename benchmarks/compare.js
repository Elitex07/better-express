import autocannon from 'autocannon';
import express from 'express';
import { createApp } from '../src/index.js';

const PORT_EXPRESS = 4001;
const PORT_BAREWEB = 4002;
const DURATION = 5; // seconds per benchmark test
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

function runAutocannon(url, title) {
  return new Promise((resolve, reject) => {
    process.stdout.write(`Benchmarking ${title}... `);
    autocannon({
      url,
      connections: CONNECTIONS,
      duration: DURATION,
      pipelining: 1
    }, (err, result) => {
      if (err) return reject(err);
      console.log('Done!');
      resolve(result);
    });
  });
}

async function main() {
  console.log('====================================================');
  console.log('🔥 BareWeb vs Express.js Benchmark Suite');
  console.log(`Duration: ${DURATION}s | Concurrency: ${CONNECTIONS} connections`);
  console.log('====================================================\n');

  const expressServer = await startExpressServer();
  const bareWebServer = await startBareWebServer();

  try {
    // 1. Static Endpoint (/test)
    console.log('--- 1. Static Route (/test) ---');
    const expressTest = await runAutocannon(`http://127.0.0.1:${PORT_EXPRESS}/test`, 'Express');
    const bareWebTest = await runAutocannon(`http://127.0.0.1:${PORT_BAREWEB}/test`, 'BareWeb');

    // 2. Parameterized Route (/users/123)
    console.log('\n--- 2. Parameterized Route (/users/123) ---');
    const expressParam = await runAutocannon(`http://127.0.0.1:${PORT_EXPRESS}/users/123`, 'Express');
    const bareWebParam = await runAutocannon(`http://127.0.0.1:${PORT_BAREWEB}/users/123`, 'BareWeb');

    console.log('\n====================================================');
    console.log('📊 Benchmark Results Summary');
    console.log('====================================================\n');

    const results = [
      {
        Route: '/test (Static)',
        Framework: 'Express.js',
        'Req/Sec': Math.round(expressTest.requests.average),
        'Latency (avg ms)': expressTest.latency.average,
        'p99 Latency (ms)': expressTest.latency.p99
      },
      {
        Route: '/test (Static)',
        Framework: 'BareWeb ⚡',
        'Req/Sec': Math.round(bareWebTest.requests.average),
        'Latency (avg ms)': bareWebTest.latency.average,
        'p99 Latency (ms)': bareWebTest.latency.p99
      },
      {
        Route: '/users/:id (Param)',
        Framework: 'Express.js',
        'Req/Sec': Math.round(expressParam.requests.average),
        'Latency (avg ms)': expressParam.latency.average,
        'p99 Latency (ms)': expressParam.latency.p99
      },
      {
        Route: '/users/:id (Param)',
        Framework: 'BareWeb ⚡',
        'Req/Sec': Math.round(bareWebParam.requests.average),
        'Latency (avg ms)': bareWebParam.latency.average,
        'p99 Latency (ms)': bareWebParam.latency.p99
      }
    ];

    console.table(results);

    const speedupStatic = ((bareWebTest.requests.average / expressTest.requests.average - 1) * 100).toFixed(1);
    const speedupParam = ((bareWebParam.requests.average / expressParam.requests.average - 1) * 100).toFixed(1);

    console.log(`\n🚀 Results:`);
    console.log(`- Static Route: BareWeb is ${speedupStatic >= 0 ? `+${speedupStatic}% faster` : `${speedupStatic}%`}`);
    console.log(`- Parameterized Route: BareWeb is ${speedupParam >= 0 ? `+${speedupParam}% faster` : `${speedupParam}%`}`);
  } finally {
    expressServer.close();
    bareWebServer.close();
  }
}

main().catch(console.error);
