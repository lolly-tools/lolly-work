/**
 * The render worker's HTTP surface under backpressure (plans/22 §5, plans/23
 * §3.C): the semaphore wired around the context-open→close span of BOTH
 * /render and /rasterise, the 503 RENDER_BUSY + Retry-After response at
 * capacity, and the /readyz flip - all without launching a real Chromium.
 * The browser getter is injectable for exactly this reason (see server.ts
 * __setBrowserGetterForTests); the HMAC signing helper is the one
 * tests/render-worker.test.ts already established (worker-client's signBody).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { runInNewContext } from 'node:vm';
import { signBody } from '../server/src/render/worker-client.ts';

const SECRET = 'worker-test-secret';
let base = '';
let server: Server;
// Typed loosely (not against playwright-core's real Browser) on purpose: the
// stubs below implement only the handful of methods renderSvg()/rasterise()
// actually call, not the full Browser surface, and this file has no need to
// import playwright-core's types just to name that shape.
let setBrowserGetter: (fn: (() => Promise<any>) | null) => void;

before(async () => {
  // Env must be set BEFORE the module is imported - server.ts reads these at
  // module load and process.exit(1)s if the required ones are missing, and
  // LW_RENDER_MAX_CONCURRENT=1 is what makes a second overlapping request
  // deterministically hit the busy path below (no timing races to get there).
  process.env.LW_RENDER_WORKER_SECRET = SECRET;
  process.env.LOLLY_WEB_BASE = 'https://web.test';
  process.env.LW_RENDER_MAX_CONCURRENT = '1';
  process.env.PORT = '0';
  const mod = await import('../workers/render/src/server.ts');
  server = mod.server;
  setBrowserGetter = mod.__setBrowserGetterForTests;

  await new Promise<void>((resolve) => {
    if (server.listening) return resolve();
    server.once('listening', () => resolve());
  });
  const addr = server.address() as AddressInfo;
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => {
  server.close();
});

function sign(body: string): Record<string, string> {
  return { 'content-type': 'application/json', 'x-lw-render-sig': signBody(body, SECRET) };
}
function renderJob(toolId: string): string {
  return JSON.stringify({ toolId, query: 'title=Hi', overrides: {}, format: 'svg', profile: {}, ts: Date.now() });
}
function rasterJob(): string {
  return JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg"></svg>', format: 'png', ts: Date.now() });
}

test('disconnect closes the Chromium context and retains the permit until close completes', async (t) => {
  let opened!: () => void, closing!: () => void, releaseClose!: () => void, rejectDownload!: (error: Error) => void;
  const openGate = new Promise<void>(resolve => { opened = resolve; });
  const closeStarted = new Promise<void>(resolve => { closing = resolve; });
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  setBrowserGetter(async () => ({ newContext: async () => {
    opened();
    return {
      addInitScript: async () => {}, route: async () => {},
      newPage: async () => ({
        goto: async () => {},
        waitForEvent: () => new Promise((_, reject) => { rejectDownload = reject; }),
      }),
      close: async () => { closing(); rejectDownload?.(new Error('context closed')); await closeGate; },
    };
  } }));
  t.after(() => { releaseClose(); setBrowserGetter(null); });
  const controller = new AbortController(), body = renderJob('cancel-me');
  const response = fetch(`${base}/render`, { method: 'POST', headers: sign(body), body, signal: controller.signal });
  const rejected = assert.rejects(response, { name: 'AbortError' });
  await openGate; controller.abort(); await rejected; await closeStarted;
  const closingState = await fetch(`${base}/readyz`);
  assert.equal(closingState.status, 503, 'the closing context still owns capacity');
  assert.deepEqual(await closingState.json(), { ok: false, active: 1, capacity: 1 });
  releaseClose();
  for (let n = 0; n < 50; n++) {
    const ready = await fetch(`${base}/readyz`);
    if (ready.status === 200) {
      assert.deepEqual(await ready.json(), { ok: true, active: 0, capacity: 1 });
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('context cleanup did not return the permit');
});

for (const path of ['/render', '/rasterise']) test(`${path}: cancellation releases a closed context even when newPage stays pending`, async t => {
  let opening!: () => void, closing!: () => void, releaseClose!: () => void, releasePage!: () => void;
  const pageStarted = new Promise<void>(resolve => { opening = resolve; });
  const closeStarted = new Promise<void>(resolve => { closing = resolve; });
  const closeGate = new Promise<void>(resolve => { releaseClose = resolve; });
  let lateCalls = 0;
  const page = { goto: async () => { lateCalls++; }, waitForEvent: async () => { lateCalls++; }, setContent: async () => { lateCalls++; } };
  const pageGate = new Promise<typeof page>(resolve => { releasePage = () => resolve(page); });
  setBrowserGetter(async () => ({ newContext: async () => ({
    addInitScript: async () => {}, route: async () => {},
    newPage: () => { opening(); return pageGate; },
    close: async () => { closing(); await closeGate; },
  }) }));
  t.after(() => { releaseClose(); releasePage(); setBrowserGetter(null); });
  const controller = new AbortController(), body = path === '/render' ? renderJob('cancel-opening') : rasterJob();
  const request = fetch(`${base}${path}`, { method: 'POST', headers: sign(body), body, signal: controller.signal });
  const rejected = assert.rejects(request, { name: 'AbortError' });
  await pageStarted;
  controller.abort(); await rejected; await closeStarted;
  assert.deepEqual(await (await fetch(`${base}/readyz`)).json(), { ok: false, active: 1, capacity: 1 });
  releaseClose();
  let released = false;
  for (let n = 0; n < 50; n++) {
    const ready = await (await fetch(`${base}/readyz`)).json() as { active: number };
    if (ready.active === 0) { released = true; break; }
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.ok(released, 'confirmed context closure releases capacity without waiting for newPage');
  releasePage();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(lateCalls, 0, 'a late page must not start navigation or rendering after cancellation');
});

/** A stub Chromium for /render: `onContextOpen` fires the instant
 *  newContext() is called - i.e. the instant the caller holds the semaphore
 *  permit and has entered the ctx-open→close span - so a test can await it
 *  instead of sleeping to know "the first request is now in flight". The
 *  download only resolves once `hold` settles, so the test also controls
 *  exactly when that span ends. */
function stubRenderBrowser(onContextOpen: () => void, hold: Promise<void>) {
  return {
    async newContext() {
      onContextOpen();
      return {
        async addInitScript(script: () => void) {
          const realm: Record<string, unknown> = {};
          runInNewContext(`(${script.toString()})()`, realm);
          assert.equal(realm.__LOLLY_AI_DISABLED__, true);
          assert.equal(Object.getOwnPropertyDescriptor(realm, '__LOLLY_AI_DISABLED__')?.writable, false);
        },
        async route(_pattern: string, handler: (route: any) => Promise<void>) {
          for (const [url, expected] of [
            ['https://web.test/models/ocr/model.onnx', 'abort'],
            ['https://models.test/weights.gguf', 'abort'],
            ['https://web.test/assets/app.js', 'continue'],
          ]) {
            let action = '';
            await handler({ request: () => ({ url: () => url }),
              abort: async () => { action = 'abort'; }, continue: async () => { action = 'continue'; } });
            assert.equal(action, expected);
          }
        },
        async newPage() {
          return {
            async waitForEvent() {
              await hold;
              return {
                async createReadStream() {
                  return (async function* () {
                    yield Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>');
                  })();
                },
                async delete() {},
              };
            },
            async goto() {},
          };
        },
        async close() {},
      };
    },
  };
}

/** Same idea for /rasterise, whose Chromium surface is setContent/$/screenshot
 *  rather than goto/waitForEvent - the pause point moves to setContent. */
function stubRasterBrowser(onContextOpen: () => void, hold: Promise<void>) {
  return {
    async newContext(options: { javaScriptEnabled?: boolean }) {
      assert.equal(options.javaScriptEnabled, false);
      onContextOpen();
      return {
        async route(_pattern: string, handler: (route: unknown) => Promise<void>) {
          let blocked = false;
          await handler({ request: () => ({ url: () => 'https://shell.example/models/ocr/model.onnx' }), abort: async () => { blocked = true; }, continue: async () => {} });
          assert.equal(blocked, true);
        },
        async newPage() {
          return {
            async setContent() { await hold; },
            async $() {
              return { async screenshot() { return Buffer.from('fake-png-bytes'); } };
            },
          };
        },
        async close() {},
      };
    },
  };
}

test('POST /render: a second overlapping request is refused with 503 RENDER_BUSY + Retry-After while the first holds the only permit, and the first still completes 200', async () => {
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let contextOpened!: () => void;
  const contextOpen = new Promise<void>((resolve) => { contextOpened = resolve; });
  setBrowserGetter(async () => stubRenderBrowser(contextOpened, hold));

  const bodyA = renderJob('hooky-a');
  const reqA = fetch(`${base}/render`, { method: 'POST', headers: sign(bodyA), body: bodyA });
  await contextOpen; // request A now holds the (only) permit and is blocked mid-context

  const bodyB = renderJob('hooky-b');
  const resB = await fetch(`${base}/render`, { method: 'POST', headers: sign(bodyB), body: bodyB });
  assert.equal(resB.status, 503, 'no free permit ⇒ immediate 503, not a queued wait');
  assert.equal(resB.headers.get('retry-after'), '2');
  const jsonB = await resB.json() as { error: { code: string } };
  assert.equal(jsonB.error.code, 'RENDER_BUSY');

  releaseHold(); // let request A's context finish and release its permit
  const resA = await reqA;
  assert.equal(resA.status, 200, 'the request that actually held the permit is unaffected by the refusal');
  const jsonA = await resA.json() as { svg: string };
  assert.match(jsonA.svg, /<svg/);

  setBrowserGetter(null);
});

test('GET /readyz flips 200 → 503 → 200 across a saturating request, and needs no HMAC signature', async () => {
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let contextOpened!: () => void;
  const contextOpen = new Promise<void>((resolve) => { contextOpened = resolve; });
  setBrowserGetter(async () => stubRenderBrowser(contextOpened, hold));

  // No x-lw-render-sig header anywhere in this test - /readyz must not require one.
  const readyBefore = await fetch(`${base}/readyz`);
  assert.equal(readyBefore.status, 200);
  assert.deepEqual(await readyBefore.json(), { ok: true, active: 0, capacity: 1 });

  const body = renderJob('hooky-c');
  const inFlight = fetch(`${base}/render`, { method: 'POST', headers: sign(body), body });
  await contextOpen;

  const readyDuring = await fetch(`${base}/readyz`);
  assert.equal(readyDuring.status, 503, 'saturated ⇒ not ready, so k8s stops routing new work here');
  assert.deepEqual(await readyDuring.json(), { ok: false, active: 1, capacity: 1 });

  releaseHold();
  await inFlight;

  const readyAfter = await fetch(`${base}/readyz`);
  assert.equal(readyAfter.status, 200, 'capacity freed ⇒ ready again');
  assert.deepEqual(await readyAfter.json(), { ok: true, active: 0, capacity: 1 });

  setBrowserGetter(null);
});

test('POST /rasterise is gated by the same capacity limit as /render', async () => {
  let releaseHold!: () => void;
  const hold = new Promise<void>((resolve) => { releaseHold = resolve; });
  let contextOpened!: () => void;
  const contextOpen = new Promise<void>((resolve) => { contextOpened = resolve; });
  setBrowserGetter(async () => stubRasterBrowser(contextOpened, hold));

  const bodyA = rasterJob();
  const reqA = fetch(`${base}/rasterise`, { method: 'POST', headers: sign(bodyA), body: bodyA });
  await contextOpen;

  const bodyB = rasterJob();
  const resB = await fetch(`${base}/rasterise`, { method: 'POST', headers: sign(bodyB), body: bodyB });
  assert.equal(resB.status, 503);
  assert.equal(resB.headers.get('retry-after'), '2');
  const jsonB = await resB.json() as { error: { code: string } };
  assert.equal(jsonB.error.code, 'RENDER_BUSY');

  releaseHold();
  const resA = await reqA;
  assert.equal(resA.status, 200);
  const jsonA = await resA.json() as { bytesB64: string; mime: string };
  assert.equal(jsonA.mime, 'image/png');

  setBrowserGetter(null);
});

test('a bad HMAC signature is still rejected 401 even when capacity is free (auth is not skippable by getting the busy-check first)', async () => {
  const body = renderJob('hooky-d');
  const res = await fetch(`${base}/render`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-lw-render-sig': 'not-a-real-signature' },
    body,
  });
  assert.equal(res.status, 401);
});

test('pinPdfDates: two PDFs differing only in Chromium wall-clock dates become byte-identical, offsets untouched', async () => {
  const { pinPdfDates } = await import('../workers/render/src/server.ts');
  const at = (d: string) => Buffer.from(
    `%PDF-1.4\n1 0 obj\n<</CreationDate (D:${d}+00'00')/ModDate (D:${d}+00'00')/Producer (Chromium)>>\nendobj\nxref\ntrailer\n%%EOF\n`, 'latin1');
  const a = pinPdfDates(at('20260811150515'));
  const b = pinPdfDates(at('20260811150519'));
  assert.equal(Buffer.compare(a, b), 0, 'the only difference was the clock — pinned away');
  assert.equal(a.length, at('20260811150515').length, 'same-length splice: nothing moved, xref offsets stay valid');
  assert.match(a.toString('latin1'), /CreationDate \(D:19700101000000\+00'00'\)/);
  const odd = Buffer.from(`%PDF-1.4 /CreationDate (D:2026)`, 'latin1');
  assert.equal(pinPdfDates(odd).toString('latin1'), `%PDF-1.4 /CreationDate (D:1970)`, 'shorter stamps pin to a valid prefix, same length');
});

test('PDF rasterisation uses the SVG viewport instead of the browser default paper size', async t => {
  let options: Record<string, unknown> | undefined;
  setBrowserGetter(async () => ({ newContext: async () => ({
    route: async () => {}, close: async () => {},
    newPage: async () => ({ setContent: async () => {}, $: async () => ({ boundingBox: async () => ({ x: 0, y: 0, width: 200, height: 100 }) }), pdf: async (opts: Record<string, unknown>) => { options = opts; return Buffer.from('%PDF-1.7\n'); } }),
  }) }));
  t.after(() => setBrowserGetter(null));
  const body = JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"/>', format: 'pdf', ts: Date.now() });
  const response = await fetch(`${base}/rasterise`, { method: 'POST', headers: sign(body), body });
  assert.equal(response.status, 200);
  assert.equal(options!.width, '200px'); assert.equal(options!.height, '100px'); assert.equal(options!.pageRanges, '1');
});

test('worker response signs observed resource bytes and the dispatched request', async t => {
  const { createHash } = await import('node:crypto');
  const { verifyBody } = await import('../server/src/render/worker-client.ts');
  const source = Buffer.from('<svg/>'), svg = '<svg xmlns="http://www.w3.org/2000/svg"/>';
  let listener: ((response: unknown) => void) | undefined;
  setBrowserGetter(async () => ({ newContext: async () => ({
    route: async () => {}, close: async () => {}, addInitScript: async () => {},
    newPage: async () => ({
      on: (_event: string, fn: (response: unknown) => void) => { listener = fn; }, off: () => {},
      goto: async () => { listener?.({ headers: () => ({ 'content-length': String(source.length) }), body: async () => source, url: () => 'https://web.test/tools/card/template.html' }); },
      waitForEvent: async () => ({ createReadStream: async () => (async function* () { yield Buffer.from(svg); })(), delete: async () => {} }),
    }),
  }) }));
  t.after(() => setBrowserGetter(null));
  const body = JSON.stringify({ toolId: 'card', query: '', overrides: {}, format: 'svg', evidence: true, ts: Date.now() });
  const response = await fetch(`${base}/render`, { method: 'POST', headers: sign(body), body }); const raw = await response.text();
  assert.equal(response.status, 200); assert.ok(verifyBody(raw, SECRET, response.headers.get('x-lw-output-sig')!));
  const out = JSON.parse(raw);
  assert.equal(out.evidence.requestSha256, createHash('sha256').update(body).digest('hex'));
  assert.equal(out.evidence.resources[0].sha256, createHash('sha256').update(source).digest('hex'));
  assert.equal(out.evidence.outputSha256, createHash('sha256').update(svg).digest('hex'));
});


test('render read credentials stay on the instance catalog and do not follow redirects', async t => {
  const fetched: string[] = [], continued: string[] = [];
  setBrowserGetter(async () => ({ newContext: async () => ({
    addInitScript: async () => {}, close: async () => {},
    route: async (_pattern: string, handler: (route: any) => Promise<void>) => {
      for (const path of ['https://web.test/api/auth/config', 'https://web.test/catalog/assets/index.json', 'https://web.test/tools/design/tool.json', 'https://web.test/api/v1/projects', 'https://example.com/catalog/assets/index.json']) {
        const response = { headers: () => ({ 'x-lolly-brand-revision': 'rev' }), status: () => 200 };
        await handler({ request: () => ({ url: () => path, method: () => 'GET', headers: () => ({ accept: '*/*' }) }),
          fetch: async (options: any) => { assert.equal(options.maxRedirects, 0); assert.equal(options.headers['x-lw-render-read'], 'read-token'); fetched.push(path); return response; },
          fulfill: async () => {}, abort: async () => { assert.fail('unexpected refusal'); }, continue: async () => { continued.push(path); } });
      }
    },
    newPage: async () => ({ goto: async () => {}, waitForEvent: async () => ({ createReadStream: async () => (async function* () { yield Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'); })(), delete: async () => {} }) }),
  }) }));
  t.after(() => setBrowserGetter(null));
  const body = JSON.stringify({ toolId: 'design', query: '', overrides: {}, format: 'svg', brandRevision: 'rev', readToken: 'read-token', ts: Date.now() });
  const res = await fetch(base+'/render', { method: 'POST', headers: sign(body), body });
  assert.equal(res.status, 200, JSON.stringify(await res.json()));
  assert.deepEqual(fetched, ['https://web.test/api/auth/config', 'https://web.test/catalog/assets/index.json', 'https://web.test/tools/design/tool.json']);
  assert.deepEqual(continued, ['https://web.test/api/v1/projects', 'https://example.com/catalog/assets/index.json']);
});

test('the project file read predicate admits only GET or HEAD of one file', async () => {
  const { projectFileRead } = await import('../workers/render/src/server.ts');
  for (const method of ['GET', 'HEAD']) assert.equal(projectFileRead(method, '/api/v1/projects/prj_a/files/fil_a'), true);
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS', 'get']) assert.equal(projectFileRead(method, '/api/v1/projects/prj_a/files/fil_a'), false, method);
  for (const path of ['/api/v1/projects/prj_a/files', '/api/v1/projects/prj_a/files/', '/api/v1/projects/prj_a/files/fil_a/', '/api/v1/projects/prj_a/files/fil_a/parts/0',
    '/api/v1/projects/prj_a/files/fil_a/finalize', '/api/v1/projects/prj_a', '/api/v1/projects', '/api/v1/sessions/ses_a', '/api/v1/projects//files/fil_a',
    '/x/api/v1/projects/prj_a/files/fil_a', '/api/v1/org-config', '/catalog/assets/index.json']) assert.equal(projectFileRead('GET', path), false, path);
});

test('render read credentials reach same-origin project file reads and no other API path', async t => {
  const fetched: string[] = [], continued: string[] = [];
  const requests: [string, string][] = [
    ['GET', 'https://web.test/api/v1/projects/prj_a/files/fil_a'],
    ['HEAD', 'https://web.test/api/v1/projects/prj_a/files/fil_b?download=1'],
    ['POST', 'https://web.test/api/v1/projects/prj_a/files/fil_a'],
    ['DELETE', 'https://web.test/api/v1/projects/prj_a/files/fil_a'],
    ['GET', 'https://web.test/api/v1/projects/prj_a/files'],
    ['PUT', 'https://web.test/api/v1/projects/prj_a/files/fil_a/parts/0'],
    ['POST', 'https://web.test/api/v1/projects/prj_a/files/fil_a/finalize'],
    ['GET', 'https://web.test/api/v1/sessions/ses_a'],
    ['GET', 'https://example.com/api/v1/projects/prj_a/files/fil_a'],
  ];
  let token: string | undefined;
  setBrowserGetter(async () => ({ newContext: async () => ({
    addInitScript: async () => {}, close: async () => {},
    route: async (_pattern: string, handler: (route: any) => Promise<void>) => {
      for (const [method, path] of requests) {
        await handler({ request: () => ({ url: () => path, method: () => method, headers: () => ({ accept: '*/*' }) }),
          fetch: async (options: any) => { assert.equal(options.maxRedirects, 0); assert.equal(options.headers['x-lw-render-read'], token); fetched.push(`${method} ${path}`); return {}; },
          fulfill: async () => {}, abort: async () => { assert.fail('unexpected refusal'); }, continue: async () => { continued.push(`${method} ${path}`); } });
      }
    },
    newPage: async () => ({ goto: async () => {}, waitForEvent: async () => ({ createReadStream: async () => (async function* () { yield Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'); })(), delete: async () => {} }) }),
  }) }));
  t.after(() => setBrowserGetter(null));
  for (const readToken of ['read-token', undefined]) {
    token = readToken; fetched.length = 0; continued.length = 0;
    const body = JSON.stringify({ toolId: 'design', query: '', overrides: {}, format: 'svg', ...(readToken ? { readToken } : {}), ts: Date.now() });
    const res = await fetch(base+'/render', { method: 'POST', headers: sign(body), body });
    assert.equal(res.status, 200, JSON.stringify(await res.json()));
    assert.deepEqual(fetched, readToken ? ['GET https://web.test/api/v1/projects/prj_a/files/fil_a', 'HEAD https://web.test/api/v1/projects/prj_a/files/fil_b?download=1'] : []);
    assert.deepEqual(continued, requests.map(([method, path]) => `${method} ${path}`).filter(row => !fetched.includes(row)));
  }
});
