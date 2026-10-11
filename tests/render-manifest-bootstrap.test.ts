// SPDX-License-Identifier: MPL-2.0
/** Actual HTTP responses distinguish cold bootstrap from signed hook cancellation. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createRenderManifestBootstrap, RENDER_BOOTSTRAP_BUDGET_MS, waitForRenderManifestBootstrap } from './collab/render-manifest-bootstrap.ts';
import { createRenderResourceHold } from './collab/render-resource-hold.ts';

const target = { path: '/tools/qr-code@' + 'a'.repeat(16) + '/tool.json', readToken: 'fixture-read', revision: 'fixture-revision' };
const headers = { 'x-lw-render-read': target.readToken, 'x-lolly-brand-revision': target.revision };

async function fixture(t: { after: (fn: () => Promise<void>) => void }, handler: (req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer(handler);
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  return `http://127.0.0.1:${address.port}`;
}

test('only the addressed authenticated current-revision manifest response opens bootstrap', { timeout: 5000 }, async t => {
  const gate = createRenderManifestBootstrap(); gate.arm(target);
  const base = await fixture(t, (req, res) => {
    gate.observe(req, res); res.setHeader('x-lolly-brand-revision', target.revision); res.end('{}');
  });
  for (const [path, init] of [
    ['/catalog/tools/index.json', { headers }],
    [target.path.replace('a'.repeat(16), 'b'.repeat(16)), { headers }],
    [target.path, { headers: { ...headers, 'x-lw-render-read': 'another-job' } }],
    [target.path, { headers: { ...headers, 'x-lolly-brand-revision': 'another-revision' } }],
    [target.path, { method: 'POST', headers }],
  ] as const) {
    assert.equal((await fetch(base + path, init)).status, 200);
    assert.equal(gate.complete, false); assert.equal(gate.refused, false);
  }
  assert.equal((await fetch(base + target.path, { headers })).status, 200);
  await waitForRenderManifestBootstrap(gate, { settled: () => false, contexts: () => 1 });
  assert.equal(gate.complete, true);
  assert.throws(() => gate.arm(target), /fresh signed manifest/);
  assert.throws(() => createRenderManifestBootstrap().arm({ ...target, path: '/tools/qr-code/tool.json' }), /fresh signed manifest/);
});

for (const mode of ['status', 'revision', 'closed'] as const) {
  test(`a ${mode} manifest response cannot count as bootstrap success`, { timeout: 5000 }, async t => {
    const gate = createRenderManifestBootstrap(); gate.arm(target);
    const base = await fixture(t, (req, res) => {
      gate.observe(req, res);
      if (mode === 'closed') { res.destroy(); return; }
      res.setHeader('x-lolly-brand-revision', mode === 'revision' ? 'another-revision' : target.revision);
      res.statusCode = mode === 'status' ? 401 : 200; res.end('{}');
    });
    const request = fetch(base + target.path, { headers });
    if (mode === 'closed') await assert.rejects(request); else await request;
    await assert.rejects(waitForRenderManifestBootstrap(gate, { settled: () => false, contexts: () => 1 }), /refused or closed/);
    assert.equal(gate.complete, false);
  });
}

test('worker response or context disappearance refuses setup before hook cancellation', async () => {
  const gate = createRenderManifestBootstrap(); gate.arm(target);
  await assert.rejects(waitForRenderManifestBootstrap(gate, { settled: () => true, contexts: () => 0 }), /render responded/);
  let reads = 0;
  await assert.rejects(waitForRenderManifestBootstrap(gate, { settled: () => false, contexts: () => ++reads === 1 ? 1 : 0 }), /context closed/);
});

test('cold bootstrap beyond five seconds preserves the separate held-hook and real abort interval', { timeout: 9000 }, async t => {
  assert.equal(RENDER_BOOTSTRAP_BUDGET_MS + 5000, 20_000, 'Bootstrap and hook phases share the original export budget');
  const gate = createRenderManifestBootstrap(); gate.arm(target);
  const hold = createRenderResourceHold(); hold.arm({ ...target, path: target.path.replace('tool.json', 'hooks.js') });
  t.after(async () => { hold.release(); });
  let arrived!: () => void, closed!: () => void;
  const hookArrived = new Promise<void>(resolve => { arrived = resolve; });
  const hookClosed = new Promise<void>(resolve => { closed = resolve; });
  const base = await fixture(t, (req, res) => {
    gate.observe(req, res);
    if (hold.intercept(req, res, () => res.end('signed hook bytes'))) {
      res.once('close', closed); arrived(); return;
    }
    const timer = setTimeout(() => { res.setHeader('x-lolly-brand-revision', target.revision); res.end('{}'); }, 5100);
    res.once('close', () => { clearTimeout(timer); });
  });
  const started = performance.now();
  const manifest = fetch(base + target.path, { headers });
  await waitForRenderManifestBootstrap(gate, { settled: () => false, contexts: () => 1 });
  assert.ok(performance.now() - started >= 5000, 'A cold response can genuinely outlast the hook-only interval');
  assert.equal((await manifest).status, 200);
  const hookStarted = performance.now(), abort = new AbortController(); let settled = false;
  const pending = fetch(base + target.path.replace('tool.json', 'hooks.js'), { headers, signal: abort.signal }).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await hookArrived;
  assert.ok(performance.now() - hookStarted < 5000);
  assert.equal(settled, false); assert.equal(hold.pending, 1);
  abort.abort(); await rejection; await hookClosed;
  assert.equal(hold.closed, hold.reads); assert.equal(hold.pending, 0);
});
