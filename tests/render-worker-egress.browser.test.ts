/**
 * The render worker's egress rule against a real Chromium and a real Lolly shell
 * (plans/58 WP0). A Sandbox pen rendered through the worker tries to reach a server on
 * loopback (by image, by fetch and by the name localhost) and the cloud metadata
 * address; the server must see nothing, and the render must still succeed.
 * Gated like render-worker-production.browser.test.ts: set LOLLY_WEB_BASE to a served
 * shell (LOLLY_BROWSER_PATH if the pinned Chromium is not installed).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { renderViaWorker } from '../server/src/render/worker-client.ts';

const skip = !process.env.LOLLY_WEB_BASE && 'Set LOLLY_WEB_BASE to run the worker against a real Lolly shell.';
test('a rendered Sandbox reaches neither loopback nor the metadata address, and the render still completes', { skip, timeout: 150_000 }, async () => {
  process.env.PORT = '0';
  process.env.LW_RENDER_WORKER_SECRET = 'local-egress-browser-test';
  process.env.LW_RENDER_EXPORT_TIMEOUT_MS = '60000';
  const playwrightPath: string = '../workers/render/node_modules/playwright-core/index.mjs';
  const { chromium } = await import(playwrightPath);
  const browser = await chromium.launch({ ...(process.env.LOLLY_BROWSER_PATH ? { executablePath: process.env.LOLLY_BROWSER_PATH } : {}) });
  const { server, __setBrowserGetterForTests } = await import('../workers/render/src/server.ts');
  __setBrowserGetterForTests(async () => browser);
  let hits = 0;
  const trap = createServer((_req, res) => { hits++; res.end('x'); });
  try {
    await new Promise<void>((resolve) => trap.listen(0, '127.0.0.1', () => resolve()));
    const port = (trap.address() as AddressInfo).port;
    if (!server.listening) await new Promise<void>((resolve) => server.once('listening', resolve));
    const cfg = { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, secret: process.env.LW_RENDER_WORKER_SECRET, timeoutMs: 120_000 };
    const html = `<h1>probe</h1><img src="http://127.0.0.1:${port}/img"><img src="http://169.254.169.254/latest/meta-data/">`;
    const js = `fetch('http://127.0.0.1:${port}/fetch').catch(function(){}); new Image().src = 'http://localhost:${port}/by-name';`;
    const svg = await renderViaWorker(cfg, { toolId: 'sandbox', format: 'svg', profile: {}, overrides: {}, query: new URLSearchParams({ html, js }).toString() } as never);
    assert.match(String(svg), /<svg/);
    await new Promise((resolve) => setTimeout(resolve, 1500)); // late requests
    assert.equal(hits, 0, 'nothing reached the loopback server');
  } finally {
    __setBrowserGetterForTests(null);
    await browser.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    trap.close();
  }
});
