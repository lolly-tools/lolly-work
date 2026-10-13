// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';
import { signBody } from '../server/src/render/worker-client.ts';

const playwrightPath = '../workers/render/node_modules/playwright-core/index.mjs';
const { chromium } = await import(playwrightPath);
const executable = process.env.LOLLY_BROWSER_PATH ?? chromium.executablePath();
const skip = !existsSync(executable) && 'Install the worker browser to check required sandbox startup.';

test('actual worker browser startup gates readiness and rasterises PNG/PDF with required sandbox settings', { skip, timeout: 45000 }, async t => {
  process.env.LW_RENDER_WORKER_SECRET = 'owned-browser-startup';
  process.env.LOLLY_WEB_BASE = 'http://127.0.0.1:8787';
  process.env.LW_RENDER_MAX_CONCURRENT = '1'; process.env.PORT = '0';
  process.env.LOLLY_BROWSER_PATH = executable;
  const worker = await import('../workers/render/src/server.ts');
  if (!worker.server.listening) await new Promise<void>(resolve => worker.server.once('listening', resolve));
  t.after(() => new Promise<void>(resolve => worker.server.close(() => resolve())));
  const base = `http://127.0.0.1:${(worker.server.address() as AddressInfo).port}`;
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  const browser = await worker.getBrowser();
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
  assert.equal(await worker.getBrowser(), browser);
  for (const format of ['png', 'pdf']) {
    const body = JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="24"><rect width="32" height="24" fill="#123456"/></svg>', format, ts: Date.now() });
    const response = await fetch(`${base}/rasterise`, { method: 'POST', body,
      headers: { 'content-type': 'application/json', 'x-lw-render-sig': signBody(body, process.env.LW_RENDER_WORKER_SECRET) } });
    const result = await response.json() as { bytesB64: string; mime: string };
    assert.equal(response.status, 200);
    const bytes = Buffer.from(result.bytesB64, 'base64');
    assert.ok(bytes.length > 100);
    assert.equal(result.mime, format === 'png' ? 'image/png' : 'application/pdf');
    if (format === 'png') assert.deepEqual(bytes.subarray(0, 8), Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    else assert.equal(bytes.subarray(0, 5).toString(), '%PDF-');
  }
  await browser.close();
  assert.equal((await fetch(`${base}/readyz`)).status, 503);
  const recovered = await worker.getBrowser();
  assert.notEqual(recovered, browser);
  assert.equal((await fetch(`${base}/readyz`)).status, 200);
});

test('worker process becomes ready through eager sandboxed startup before any render request', { skip, timeout: 45000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../workers/render/src/server.ts', import.meta.url))], {
    env: { ...process.env, PORT: '0', LW_RENDER_WORKER_SECRET: 'owned-eager-startup', LOLLY_WEB_BASE: 'http://127.0.0.1:8787',
      LOLLY_BROWSER_PATH: executable, LOLLY_BROWSER_CHANNEL: '' }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  const exited = new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  const base = await new Promise<string>((resolve, reject) => {
    let output = '';
    child.stdout.on('data', chunk => {
      output += chunk;
      const port = /listening on :(\d+)/.exec(output)?.[1];
      if (port) resolve(`http://127.0.0.1:${port}`);
    });
    child.once('exit', () => reject(new Error('Worker stopped before listening')));
    child.once('error', reject);
  });
  const until = Date.now() + 35000;
  let ready = false;
  while (Date.now() < until && child.exitCode === null) {
    const response = await fetch(`${base}/readyz`, { signal: AbortSignal.timeout(1000) });
    if (response.status === 200) { ready = true; break; }
    assert.equal(response.status, 503);
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.equal(ready, true, 'Startup must launch the browser without a render request');
  assert.equal((await fetch(`${base}/healthz`)).status, 200);
  child.kill('SIGTERM'); assert.equal(await exited, 0);
});
