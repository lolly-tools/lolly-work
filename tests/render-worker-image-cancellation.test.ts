// SPDX-License-Identifier: MPL-2.0
/** Cancellation waits for the exact signed resource and observes real socket close. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRenderResourceHold } from './collab/render-resource-hold.ts';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('the image cancellation control holds only the signed hook and closes or resumes every real request', { timeout: 5000 }, async t => {
  const hold = createRenderResourceHold(), path = '/tools/qr-code@' + 'a'.repeat(16) + '/hooks.js';
  const target = { path, readToken: 'fixture-render-read', revision: 'fixture-revision' };
  let entered = deferred(), disconnected = deferred(), served = 0;
  const server = createServer((req, res) => {
    const resume = () => { served++; res.end('signed hook bytes'); };
    if (hold.intercept(req, res, resume)) {
      res.once('close', () => { disconnected.resolve(); }); entered.resolve();
    } else resume();
  });
  t.after(async () => { hold.release(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const headers = { 'x-lw-render-read': target.readToken, 'x-lolly-brand-revision': target.revision };
  assert.throws(() => hold.arm({ ...target, path: '/catalog/tools/index.json' }), /signed hook/);
  hold.arm(target);
  for (const [route, init] of [
    ['/catalog/tools/index.json', { headers }],
    [path.replace('a'.repeat(16), 'b'.repeat(16)), { headers }],
    [path, { headers: { ...headers, 'x-lw-render-read': 'other-render' } }],
    [path, { headers: { ...headers, 'x-lolly-brand-revision': 'other-revision' } }],
    [path, { method: 'POST', headers }],
  ] as const) assert.equal(await (await fetch(base + route, init)).text(), 'signed hook bytes');
  assert.equal(hold.reads, 0); assert.equal(served, 5);
  const abort = new AbortController(); let settled = false;
  const pending = fetch(base + path, { headers, signal: abort.signal }).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, { name: 'AbortError' });
  await entered.promise; assert.equal(settled, false); assert.equal(served, 5);
  abort.abort(); await rejection; await disconnected.promise;
  assert.equal(hold.reads, 1); assert.equal(hold.closed, 1);
  hold.release();
  assert.equal(await (await fetch(base + path, { headers })).text(), 'signed hook bytes');
  entered = deferred(); disconnected = deferred(); hold.arm(target);
  const resumed = fetch(base + path, { headers }); await entered.promise;
  hold.release(); assert.equal(await (await resumed).text(), 'signed hook bytes');
  assert.equal(hold.reads, 1); assert.equal(hold.closed, 0, 'A released response is served rather than counted as a cancellation');
});
