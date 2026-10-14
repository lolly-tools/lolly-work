// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createBrowserLifecycle } from '../workers/render/src/browser-lifecycle.ts';

class BrowserFixture extends EventEmitter {
  connected = true;
  closes = 0;
  isConnected() { return this.connected; }
  async close() { this.closes++; this.disconnect(); }
  disconnect() { this.connected = false; this.emit('disconnected'); }
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));

test('startup and requests share one browser launch and readiness follows connection', async () => {
  let resolve!: (browser: BrowserFixture) => void, launches = 0;
  const browser = new BrowserFixture();
  const lifecycle = createBrowserLifecycle({ launch: () => { launches++; return new Promise<BrowserFixture>(done => { resolve = done; }); }, timeoutMs: 1000 });
  const first = lifecycle.get(), second = lifecycle.get();
  assert.equal(first, second); assert.equal(lifecycle.ready, false);
  await tick(); assert.equal(launches, 1);
  resolve(browser); assert.equal(await first, browser); assert.equal(lifecycle.ready, true);
  assert.equal(await lifecycle.get(), browser);
  await lifecycle.close(); await lifecycle.close();
  assert.equal(browser.closes, 1); assert.equal(lifecycle.ready, false);
  await assert.rejects(lifecycle.get(), /stopped/);
});

test('failed and timed-out launches never become ready, and late browsers are closed', async () => {
  const failed = createBrowserLifecycle({ launch: async () => { throw new Error('sandbox unavailable'); }, timeoutMs: 100 });
  await assert.rejects(failed.get(), /startup did not complete/); assert.equal(failed.ready, false);
  await failed.close();
  let resolve!: (browser: BrowserFixture) => void;
  const lifecycle = createBrowserLifecycle({ launch: () => new Promise<BrowserFixture>(done => { resolve = done; }), timeoutMs: 20 });
  await assert.rejects(lifecycle.get(), /startup did not complete/);
  assert.equal(lifecycle.ready, false);
  const late = new BrowserFixture(); resolve(late); await tick();
  assert.equal(late.closes, 1); assert.equal(lifecycle.ready, false);
  await lifecycle.close();
});

test('disconnect immediately removes readiness and recovery is shared and bounded', async () => {
  const initial = new BrowserFixture(), recovered = new BrowserFixture();
  let resolve!: (browser: BrowserFixture) => void, launches = 0, failures = 0;
  const lifecycle = createBrowserLifecycle({ timeoutMs: 1000, onRecoveryFailure: () => { failures++; }, launch: async () => {
    if (++launches === 1) return initial;
    return new Promise<BrowserFixture>(done => { resolve = done; });
  } });
  assert.equal(await lifecycle.get(), initial);
  initial.disconnect(); assert.equal(lifecycle.ready, false);
  const request = lifecycle.get(); await tick(); assert.equal(launches, 2);
  resolve(recovered); assert.equal(await request, recovered); assert.equal(lifecycle.ready, true);
  assert.equal(failures, 0); await lifecycle.close(); assert.equal(launches, 2);

  const broken = new BrowserFixture();
  let attempts = 0, notify!: () => void;
  const notified = new Promise<void>(done => { notify = done; });
  const refused = createBrowserLifecycle({ timeoutMs: 20, onRecoveryFailure: notify,
    launch: async () => ++attempts === 1 ? broken : new Promise<BrowserFixture>(() => {}) });
  await refused.get(); broken.disconnect(); await notified;
  assert.equal(refused.ready, false); assert.equal(attempts, 2);
  await refused.close();
});

test('shutdown closes a browser that resolves after the worker stops', async () => {
  let resolve!: (browser: BrowserFixture) => void;
  const lifecycle = createBrowserLifecycle({ launch: () => new Promise<BrowserFixture>(done => { resolve = done; }), timeoutMs: 1000 });
  const pending = lifecycle.get(); await tick(); const closing = lifecycle.close();
  const late = new BrowserFixture(); resolve(late);
  await assert.rejects(pending, /startup did not complete/); await closing;
  assert.equal(late.closes, 1); assert.equal(lifecycle.ready, false);
});

test('real worker entry exits after bounded browser startup refusal', { timeout: 10000 }, async t => {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../workers/render/src/server.ts', import.meta.url))], {
    env: { ...process.env, PORT: '0', LW_RENDER_WORKER_SECRET: 'owned-startup-fixture', LOLLY_WEB_BASE: 'http://127.0.0.1:8787',
      LW_RENDER_BROWSER_STARTUP_TIMEOUT_MS: '1000', LOLLY_BROWSER_PATH: '/owned-missing-browser', LOLLY_BROWSER_CHANNEL: '' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  t.after(() => { if (child.exitCode === null) child.kill('SIGKILL'); });
  let stderr = '';
  child.stderr.on('data', chunk => { stderr += chunk; });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('exit', resolve); child.once('error', reject); });
  assert.equal(code, 1); assert.match(stderr, /browser startup refused/);
  assert.doesNotMatch(stderr, /owned-startup-fixture/);
});
