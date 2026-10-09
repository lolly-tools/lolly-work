import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { signBody } from '../server/src/render/worker-client.ts';

const SECRET = 'route-lifecycle-test-secret';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"><text>finished</text></svg>';
let server: Server, base: string;
let setBrowser: (fn: (() => Promise<any>) | null) => void;
before(async () => {
  process.env.LW_RENDER_WORKER_SECRET = SECRET;
  process.env.LOLLY_WEB_BASE = 'https://web.test';
  process.env.LW_RENDER_MAX_CONCURRENT = '1';
  process.env.LW_RENDER_EXPORT_TIMEOUT_MS = '2000';
  process.env.PORT = '0';
  const mod = await import('../workers/render/src/server.ts');
  server = mod.server; setBrowser = mod.__setBrowserGetterForTests;
  if (!server.listening) await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
after(() => { setBrowser(null); server.close(); });

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}
const tick = () => new Promise<void>(resolve => setImmediate(resolve));
function request(extra: Record<string, unknown> = {}, signal?: AbortSignal, path = '/render') {
  const body = JSON.stringify({ toolId: 'test-tool', query: '', overrides: {}, format: 'svg', ts: Date.now(), ...extra });
  return fetch(`${base}${path}`, { method: 'POST', body, signal,
    headers: { 'content-type': 'application/json', 'x-lw-render-sig': signBody(body, SECRET) } });
}

/** Simulate Playwright's event dispatcher: it does not join route callbacks to
 * goto/download. Catch rejections here so the old bug fails an assertion rather
 * than terminating the test process as it terminated the production worker. */
function fixture(url: string, action: 'fetch' | 'fulfill' | 'continue' | 'abort', fail: boolean, held = false, closeHold?: Promise<void>, wsFailure = false) {
  const started = gate(), finish = gate();
  let routeHandler!: (route: any) => Promise<void>;
  let wsHandler: ((ws: any) => Promise<void>) | undefined;
  let closeCount = 0, closed = false;
  const escaped: unknown[] = [];
  let callback = Promise.resolve();
  const selected = async () => {
    started.release();
    if (held) await finish.promise;
    if (fail || closed) throw new Error('synthetic private URL and read credential must not escape');
  };
  const route = {
    request: () => ({ url: () => url, method: () => 'GET', headers: () => ({}) }),
    fetch: async () => { if (action === 'fetch') await selected(); return { headers: () => ({ 'x-lolly-brand-revision': 'revision-a' }), status: () => 200 }; },
    fulfill: async () => { if (action === 'fulfill') await selected(); },
    continue: async () => { if (action === 'continue') await selected(); },
    abort: async () => { if (action === 'abort') await selected(); },
  };
  const browser = { newContext: async () => ({
    addInitScript: async () => {},
    route: async (_pattern: string, handler: typeof routeHandler) => { routeHandler = handler; },
    routeWebSocket: async (_pattern: string, handler: typeof wsHandler) => { wsHandler = handler; },
    newPage: async () => ({
      waitForEvent: async () => ({ createReadStream: async () => (async function* () { yield Buffer.from(SVG); })(), delete: async () => {} }),
      goto: async () => {
        if (wsFailure) {
          callback = wsHandler!({ close: async () => { throw new Error('synthetic private WebSocket URL'); } }).catch(error => { escaped.push(error); });
          await callback; return;
        }
        callback = routeHandler(route).catch(error => { escaped.push(error); });
        await started.promise;
        if (!held) await callback;
      },
      setContent: async () => { callback = routeHandler(route).catch(error => { escaped.push(error); }); await started.promise; if (!held) await callback; },
      $: async () => ({ screenshot: async () => Buffer.from('test-only raster bytes') }),
    }),
    close: async () => { closeCount++; closed = true; if (closeHold) await closeHold; else finish.release(); },
  }) };
  return { browser, started, finish, escaped, callback: () => callback, closes: () => closeCount };
}

test('a completed SVG waits for its pending fetch response to be fulfilled before context disposal', { timeout: 5000 }, async t => {
  const f = fixture('https://web.test/catalog/index.json', 'fulfill', false, true);
  setBrowser(async () => f.browser);
  t.after(() => f.finish.release());
  const response = request({ brandRevision: 'revision-a' });
  await f.started.promise; await tick(); await tick();
  assert.equal(f.closes(), 0, 'export completion must not dispose the in-flight fetch response');
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { ok: false, active: 1, capacity: 1 });
  f.finish.release();
  const result = await response;
  assert.equal(result.status, 200);
  assert.equal((await result.json() as { svg: string }).svg, SVG);
  await f.callback();
  assert.equal(f.closes(), 1);
  assert.deepEqual(f.escaped, []);
});

for (const [name, url, action, extra] of [
  ['revision fulfill', 'https://web.test/catalog/index.json', 'fulfill', { brandRevision: 'revision-a' }],
  ['read-ticket fetch', 'https://web.test/api/auth/config', 'fetch', { readToken: 'synthetic-read-token' }],
  ['read-ticket fulfill', 'https://web.test/api/auth/config', 'fulfill', { readToken: 'synthetic-read-token' }],
  ['continue', 'https://web.test/assets/app.js', 'continue', {}],
  ['blocked abort', 'https://web.test/models/ocr.onnx', 'abort', {}],
] as const) test(`${name}: a genuine routing failure rejects the render without leaking or rejecting the event callback`, { timeout: 5000 }, async () => {
  const f = fixture(url, action, true);
  setBrowser(async () => f.browser);
  const response = await request(extra);
  assert.equal(response.status, 502);
  const body = await response.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'RENDER_FAILED');
  assert.equal(body.error.message, 'Chromium render failed: A render request could not be completed.');
  await f.callback();
  assert.deepEqual(f.escaped, []);
  assert.equal(f.closes(), 1);
});

test('WebSocket refusal failures reject the render and cannot escape its event callback', { timeout: 5000 }, async () => {
  const f = fixture('https://web.test/assets/app.js', 'continue', false, false, undefined, true);
  setBrowser(async () => f.browser);
  const response = await request();
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { error: { message: string } }).error.message, 'Chromium render failed: A render request could not be completed.');
  await f.callback(); assert.deepEqual(f.escaped, []); assert.equal(f.closes(), 1);
});

for (const [url, action] of [
  ['https://web.test/assets/image.png', 'continue'], ['https://web.test/models/ocr.onnx', 'abort'],
] as const) test(`raster ${action} failures propagate without a leaked callback or successful raster`, { timeout: 5000 }, async () => {
  const f = fixture(url, action, true);
  setBrowser(async () => f.browser);
  const response = await request({ svg: SVG, format: 'png' }, undefined, '/rasterise');
  assert.equal(response.status, 502);
  assert.equal((await response.json() as { error: { message: string } }).error.message, 'Chromium raster failed: A render request could not be completed.');
  await f.callback(); assert.deepEqual(f.escaped, []); assert.equal(f.closes(), 1);
});

test('a genuine late fulfill failure during the bounded drain cannot turn into a successful export', { timeout: 5000 }, async t => {
  const f = fixture('https://web.test/catalog/index.json', 'fulfill', true, true);
  setBrowser(async () => f.browser); t.after(() => f.finish.release());
  const response = request({ brandRevision: 'revision-a' });
  await f.started.promise; await tick(); await tick();
  f.finish.release();
  assert.equal((await response).status, 502);
  await f.callback(); assert.deepEqual(f.escaped, []); assert.equal(f.closes(), 1);
});

for (const status of [200, 409]) test(`a late catalogue ${status === 409 ? '409' : 'revision mismatch'} stays fatal after another valid route and completed download`, { timeout: 5000 }, async t => {
  const started = gate(), finish = gate();
  let handler!: (route: any) => Promise<void>, closes = 0, callback = Promise.resolve();
  const escaped: unknown[] = [];
  const route = (late: boolean) => ({
    request: () => ({ url: () => `https://web.test/catalog/${late ? 'late' : 'first'}.json`, headers: () => ({}), method: () => 'GET' }),
    fetch: async () => {
      if (late) { started.release(); await finish.promise; }
      return { status: () => late ? status : 200, headers: () => ({ 'x-lolly-brand-revision': late && status === 200 ? 'wrong-revision' : 'revision-a' }) };
    },
    fulfill: async () => {}, abort: async () => {},
  });
  setBrowser(async () => ({ newContext: async () => ({
    addInitScript: async () => {}, route: async (_pattern: string, h: typeof handler) => { handler = h; },
    newPage: async () => ({
      waitForEvent: async () => ({ createReadStream: async () => (async function* () { yield Buffer.from(SVG); })(), delete: async () => {} }),
      goto: async () => {
        await handler(route(false));
        callback = handler(route(true)).catch(error => { escaped.push(error); });
        await started.promise;
      },
    }),
    close: async () => { closes++; finish.release(); },
  }) }));
  t.after(() => finish.release());
  const response = request({ brandRevision: 'revision-a' });
  await started.promise; await tick(); await tick();
  assert.equal(closes, 0); finish.release();
  const result = await response;
  assert.equal(result.status, 502);
  assert.equal((await result.json() as { error: { message: string } }).error.message,
    'Chromium render failed: The catalogue revision changed or the worker is not connected to this instance. Retry after refreshing.');
  await callback; assert.deepEqual(escaped, []); assert.equal(closes, 1);
});

test('caller cancellation closes once and consumes a response disposed by that explicit close', { timeout: 5000 }, async () => {
  const f = fixture('https://web.test/catalog/index.json', 'fulfill', false, true);
  setBrowser(async () => f.browser);
  const controller = new AbortController();
  const response = request({ brandRevision: 'revision-a' }, controller.signal);
  const canceled = assert.rejects(response, { name: 'AbortError' });
  await f.started.promise; controller.abort(); await canceled;
  for (let n = 0; n < 50 && !f.closes(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  await f.callback();
  assert.equal(f.closes(), 1); assert.deepEqual(f.escaped, []);
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { ok: true, active: 0, capacity: 1 });
});

test('cancellation during normal drain retains capacity until close, without waiting for an unsettled callback', { timeout: 5000 }, async t => {
  const closeHold = gate();
  const f = fixture('https://web.test/catalog/index.json', 'fulfill', false, true, closeHold.promise);
  setBrowser(async () => f.browser);
  t.after(() => { closeHold.release(); f.finish.release(); });
  const controller = new AbortController(), response = request({ brandRevision: 'revision-a' }, controller.signal);
  const canceled = assert.rejects(response, { name: 'AbortError' });
  await f.started.promise; await tick(); await tick();
  assert.equal(f.closes(), 0);
  controller.abort(); await canceled;
  for (let n = 0; n < 50 && !f.closes(); n++) await new Promise(resolve => setTimeout(resolve, 10));
  assert.equal(f.closes(), 1);
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { ok: false, active: 1, capacity: 1 });
  closeHold.release(); // deliberately does NOT settle the route
  for (let n = 0; n < 50; n++) {
    const ready = await (await fetch(`${base}/readyz`)).json() as { active: number };
    if (ready.active === 0) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { ok: true, active: 0, capacity: 1 });
  f.finish.release(); await f.callback(); assert.deepEqual(f.escaped, []);
});
