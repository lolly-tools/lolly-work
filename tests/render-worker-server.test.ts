/**
 * The render worker's HTTP surface under backpressure (plans/22 §5, plans/23
 * §3.C): the semaphore wired around the context-open→close span of BOTH
 * /render and /rasterise, the 503 RENDER_BUSY + Retry-After response at
 * capacity, and the /readyz flip — all without launching a real Chromium.
 * The browser getter is injectable for exactly this reason (see server.ts
 * __setBrowserGetterForTests); the HMAC signing helper is the one
 * tests/render-worker.test.ts already established (worker-client's signBody).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
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
  // Env must be set BEFORE the module is imported — server.ts reads these at
  // module load and process.exit(1)s if the required ones are missing, and
  // LW_RENDER_MAX_CONCURRENT=1 is what makes a second overlapping request
  // deterministically hit the busy path below (no timing races to get there).
  process.env.LW_RENDER_WORKER_SECRET = SECRET;
  process.env.LOLLY_WEB_BASE = 'http://web.test';
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

/** A stub Chromium for /render: `onContextOpen` fires the instant
 *  newContext() is called — i.e. the instant the caller holds the semaphore
 *  permit and has entered the ctx-open→close span — so a test can await it
 *  instead of sleeping to know "the first request is now in flight". The
 *  download only resolves once `hold` settles, so the test also controls
 *  exactly when that span ends. */
function stubRenderBrowser(onContextOpen: () => void, hold: Promise<void>) {
  return {
    async newContext() {
      onContextOpen();
      return {
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
 *  rather than goto/waitForEvent — the pause point moves to setContent. */
function stubRasterBrowser(onContextOpen: () => void, hold: Promise<void>) {
  return {
    async newContext() {
      onContextOpen();
      return {
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

  // No x-lw-render-sig header anywhere in this test — /readyz must not require one.
  const readyBefore = await fetch(`${base}/readyz`);
  assert.equal(readyBefore.status, 200);
  assert.deepEqual(await readyBefore.json(), { ok: true });

  const body = renderJob('hooky-c');
  const inFlight = fetch(`${base}/render`, { method: 'POST', headers: sign(body), body });
  await contextOpen;

  const readyDuring = await fetch(`${base}/readyz`);
  assert.equal(readyDuring.status, 503, 'saturated ⇒ not ready, so k8s stops routing new work here');
  assert.deepEqual(await readyDuring.json(), { ok: false });

  releaseHold();
  await inFlight;

  const readyAfter = await fetch(`${base}/readyz`);
  assert.equal(readyAfter.status, 200, 'capacity freed ⇒ ready again');
  assert.deepEqual(await readyAfter.json(), { ok: true });

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
