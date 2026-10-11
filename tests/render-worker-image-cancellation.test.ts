// SPDX-License-Identifier: MPL-2.0
/** Cancellation waits for the exact signed resource and observes real socket close. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createRenderResourceHold, requestRenderCancellation } from './collab/render-resource-hold.ts';

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
  assert.equal(hold.pending, 1);
  // An independent request must not release the signed dependency.
  assert.equal(await (await fetch(base + '/readyz')).text(), 'signed hook bytes');
  assert.equal(settled, false); assert.equal(hold.pending, 1);
  abort.abort(); await rejection; await disconnected.promise;
  assert.equal(hold.reads, 1); assert.equal(hold.closed, 1); assert.equal(hold.pending, 0);
  hold.release();
  assert.equal(await (await fetch(base + path, { headers })).text(), 'signed hook bytes');
  entered = deferred(); disconnected = deferred(); hold.arm(target);
  const resumed = fetch(base + path, { headers }); await entered.promise;
  hold.release(); assert.equal(await (await resumed).text(), 'signed hook bytes');
  assert.equal(hold.reads, 1); assert.equal(hold.closed, 0, 'A released response is served rather than counted as a cancellation');
});


test('native POST cancellation closes its real socket after a concurrent active readiness probe', { timeout: 5000 }, async t => {
  const entered = deferred(), closed = deferred();
  const body = '{"toolId":"qr-code","format":"svg","ts":1}';
  const headers = { 'content-type': 'application/json', 'x-lw-render-sig': 'actual-fixture-hmac-bytes' };
  let active = 0, released = false;
  const server = createServer((req, res) => {
    if (req.url === '/readyz') { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ active })); return; }
    void (async () => {
      assert.equal(req.method, 'POST'); assert.equal(req.url, '/render');
      assert.equal(req.headers['x-lw-render-sig'], headers['x-lw-render-sig']);
      assert.equal(req.headers['content-type'], headers['content-type']);
      const chunks: Buffer[] = []; for await (const bytes of req) chunks.push(Buffer.from(bytes));
      assert.equal(Buffer.concat(chunks).toString(), body);
      if (released) { res.end('fresh render'); return; }
      active++; res.once('close', () => { active--; closed.resolve(); }); entered.resolve();
    })().catch(error => { res.destroy(error); });
  });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`, abort = new AbortController();
  let settled = false, status: number | undefined;
  const pending = requestRenderCancellation(base + '/render', headers, body, abort.signal)
    .then(value => { status = value; return value; }).finally(() => { settled = true; });
  const rejection = assert.rejects(pending, { name: 'AbortError', code: 'ABORT_ERR' });
  await entered.promise;
  assert.deepEqual(await (await fetch(base + '/readyz')).json(), { active: 1 });
  assert.equal(settled, false); assert.equal(status, undefined);
  abort.abort(); await rejection; await closed.promise;
  assert.deepEqual(await (await fetch(base + '/readyz')).json(), { active: 0 });
  released = true;
  assert.equal(await requestRenderCancellation(base + '/render', headers, body, new AbortController().signal), 200);
});

test('native cancellation cannot manufacture AbortError after worker response headers arrived', { timeout: 5000 }, async t => {
  const server = createServer((_req, res) => { res.writeHead(502); res.end('already answered'); });
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const abort = new AbortController();
  const pending = requestRenderCancellation(`http://127.0.0.1:${address.port}/render`, {}, 'same request', abort.signal);
  assert.equal(await pending, 502); abort.abort();
  await assert.rejects(assert.rejects(pending, { name: 'AbortError' }), { code: 'ERR_ASSERTION', message: /Missing expected rejection/ });
});
