import { createApp } from '../src/index.js';

/**
 * Start an app on an ephemeral port. Returns { app, server, baseUrl, close }.
 * @param {(app: import('../src/app.js').BareWeb) => void} setup
 * @param {object} [options] createApp options
 */
export async function startApp(setup, options) {
  const app = createApp(options);
  setup(app);
  const server = await new Promise((resolve) => {
    const s = app.listen(0, '127.0.0.1', () => resolve(s));
  });
  const { port } = server.address();
  return {
    app,
    server,
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise((resolve) => server.close(resolve))
  };
}

/** Run fn with NODE_ENV temporarily set, restoring afterwards. */
export async function withEnv(name, value, fn) {
  const prev = process.env[name];
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env[name];
    else process.env[name] = prev;
  }
}
