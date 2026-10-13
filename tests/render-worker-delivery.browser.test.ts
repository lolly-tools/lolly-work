// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { existsSync } from 'node:fs';
import { deliverResponse, ResponseBudget } from '../workers/render/src/request-delivery.ts';

const playwrightPath = '../workers/render/node_modules/playwright-core/index.mjs';
const { chromium } = await import(playwrightPath);
const browserPath = process.env.LOLLY_BROWSER_PATH ?? chromium.executablePath();
const skip = !existsSync(browserPath) && 'Install the worker browser or set LOLLY_BROWSER_PATH.';

test('browser page and subresource redirects are refused while direct assets load', { skip, timeout: 30000 }, async t => {
  let finalHits = 0;
  const source = createServer((req, res) => {
    if (req.url === '/page' || req.url === '/image') {
      res.writeHead(302, { location: '/final' }); res.end(); return;
    }
    if (req.url === '/final') { finalHits++; res.end('final'); return; }
    if (req.url === '/direct') { res.setHeader('content-type', 'text/plain'); res.end('direct'); return; }
    res.setHeader('content-type', 'text/html'); res.end('<!doctype html><title>sample</title>');
  });
  await new Promise<void>(resolve => source.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => source.close(() => resolve())));
  const base = `http://127.0.0.1:${(source.address() as AddressInfo).port}`;
  const browser = await chromium.launch({ executablePath: browserPath });
  t.after(() => browser.close());
  const context = await browser.newContext({ serviceWorkers: 'block' });
  const budget = new ResponseBudget();
  await context.route('**/*', (route: Parameters<typeof deliverResponse>[0]) => deliverResponse(route, budget, new AbortController().signal, { timeout: 3000 }));
  const redirected = await context.newPage();
  await assert.rejects(redirected.goto(base + '/page', { timeout: 5000 }));
  await redirected.close();
  const page = await context.newPage();
  await page.goto(base, { timeout: 5000 });
  const result = await page.evaluate(async (base: string) => {
    const direct = await (await fetch(base + '/direct')).text();
    let redirected = false;
    try { await fetch(base + '/image'); redirected = true; } catch { /* refused response */ }
    return { direct, redirected };
  }, base);
  assert.deepEqual(result, { direct: 'direct', redirected: false });
  assert.equal(finalHits, 0);
});
