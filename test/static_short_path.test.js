import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createApp, serveStatic } from '../src/index.js';

// Windows 8.3 short name of an existing path ('' when unavailable)
function shortName(longPath) {
  try {
    return execFileSync('cmd', ['/d', '/s', '/c', `"for %I in ("${longPath}") do @echo %~sI"`], {
      encoding: 'utf8',
      windowsVerbatimArguments: true
    }).trim();
  } catch {
    return '';
  }
}

describe('serveStatic with a Windows 8.3 short-name root', () => {
  it('serves files instead of answering 403', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bareweb-long-directory-name-'));
    t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
    fs.writeFileSync(path.join(dir, 'hello.txt'), 'hi');

    const short = shortName(dir);
    if (!short || short.toLowerCase() === dir.toLowerCase()) {
      t.skip('8.3 names are disabled on this volume');
      return;
    }

    const app = createApp();
    app.use(serveStatic(short));
    const url = await new Promise((resolve) => {
      const server = app.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${server.address().port}`));
    });
    try {
      const res = await fetch(`${url}/hello.txt`);
      assert.equal(res.status, 200);
      assert.equal(await res.text(), 'hi');
    } finally {
      await app.close();
    }
  });
});
