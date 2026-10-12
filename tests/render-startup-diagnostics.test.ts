// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { catalogStartupDiagnostic } from './collab/render-startup-diagnostics.ts';

const base = 'http://127.0.0.1:31337';
const cookie = 'fixture-cookie-test-only';
const fakeFetch = (response: Response): typeof fetch => async (url, options) => {
  assert.equal(url, `${base}/catalog/tools/index.sig.json`);
  assert.equal(options?.redirect, 'error');
  assert.deepEqual(options?.headers, { cookie });
  assert.ok(options.signal instanceof AbortSignal);
  return response;
};

test('catalog startup diagnostic exposes an existing publication refusal without free text', async () => {
  const response = Response.json({ error: { code: 'BAD_REQUEST', message: 'Mounted catalog publication could not be verified' } }, { status: 503 });
  assert.deepEqual(await catalogStartupDiagnostic(base, cookie, fakeFetch(response)), {
    status: 503, result: 'response', body: 'bounded-error', code: 'BAD_REQUEST', category: 'publication-refused',
  });
});

test('catalog startup diagnostic never reads a successful catalog or emits credentials', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ cancel() { cancelled = true; } }), { status: 200 });
  Object.defineProperty(response.body, 'getReader', { value: () => { throw new Error('Success body must stay unread'); } });
  const result = await catalogStartupDiagnostic(base, cookie, fakeFetch(response));
  assert.deepEqual(result, { status: 200, result: 'available-after-deadline', body: 'not-read' });
  assert.equal(cancelled, true);
  assert.ok(!JSON.stringify(result).includes(cookie));
});

test('catalog startup diagnostic caps errors and cancels the response stream', async () => {
  let cancelled = false;
  const response = new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(1025)); }, cancel() { cancelled = true; } }), { status: 503 });
  assert.deepEqual(await catalogStartupDiagnostic(base, cookie, fakeFetch(response)), { status: 503, result: 'response', body: 'oversized' });
  assert.equal(cancelled, true);
});

test('catalog startup diagnostic emits fixed enums for arbitrary upstream messages and codes', async () => {
  const response = Response.json({ error: { code: cookie, message: cookie, detail: 'private fixture payload' } }, { status: 500 });
  assert.deepEqual(await catalogStartupDiagnostic(base, cookie, fakeFetch(response)), {
    status: 500, result: 'response', body: 'bounded-error', code: 'other', category: 'other',
  });
});

test('catalog startup diagnostic preserves auth and malformed-response distinctions', async () => {
  assert.deepEqual(await catalogStartupDiagnostic(base, cookie, fakeFetch(Response.json({ error: { code: 'UNAUTHORIZED', message: 'sign in first' } }, { status: 401 }))), {
    status: 401, result: 'response', body: 'bounded-error', code: 'UNAUTHORIZED', category: 'other',
  });
  assert.deepEqual(await catalogStartupDiagnostic(base, cookie, fakeFetch(new Response('not json', { status: 503 }))), {
    status: 503, result: 'response', body: 'invalid-json',
  });
});

test('catalog startup diagnostic refuses to send the fixture cookie to foreign or redirected origins', async () => {
  const refused: typeof fetch = async () => { throw new Error('No transport for invalid fixture origin'); };
  for (const origin of ['https://example.invalid', 'http://localhost:31337', 'http://user@127.0.0.1:31337', 'http://127.0.0.1:31337/path']) {
    assert.deepEqual(await catalogStartupDiagnostic(origin, cookie, refused), { status: 0, result: 'invalid-fixture-origin' });
  }
});

test('catalog startup diagnostic separates pending initialization through the real one-second loopback timeout', async () => {
  const server = createServer((request, response) => {
    assert.equal(request.url, '/catalog/tools/index.sig.json');
    assert.equal(request.headers.cookie, cookie);
    // Model an initializer which has not settled: deliberately no headers/body.
    request.once('close', () => response.destroy());
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const address = server.address();assert.ok(address && typeof address !== 'string');
    const started = performance.now();
    assert.deepEqual(await catalogStartupDiagnostic(`http://127.0.0.1:${address.port}`, cookie), { status: 0, result: 'timed-out' });
    assert.ok(performance.now() - started >= 900);
  } finally {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
});
