/**
 * The Chromium render-worker CLIENT protocol (plans/07/11) — HMAC signing, the
 * request shape, and error-status mapping. No engine, no browser: a mock fetch
 * stands in for the worker.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { signBody, verifyBody, renderViaWorker, rasteriseViaWorker, WorkerError, WORKER_TS_SKEW_MS } from '../server/src/render/worker-client.ts';

const SECRET = 'shared-key';
const CFG = { url: 'http://worker.local', secret: SECRET, timeoutMs: 5000 };
const JOB = { toolId: 'hooky', query: 'title=Hi', overrides: { logo: 'brand/logo' }, format: 'svg' as const, profile: {} };
const RASTER_JOB = { svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>', format: 'png' };
const okSvg = '<svg xmlns="http://www.w3.org/2000/svg"><text>ok</text></svg>';
const res = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

test('signBody/verifyBody round-trip; a tampered body is rejected', () => {
  const sig = signBody('{"a":1}', SECRET);
  assert.ok(verifyBody('{"a":1}', SECRET, sig));
  assert.equal(verifyBody('{"a":2}', SECRET, sig), false);
  assert.equal(verifyBody('{"a":1}', 'other', sig), false);
});

test('renderViaWorker signs the exact body, stamps ts, and returns the SVG', async () => {
  let seen: { sig: string | null; body: string } = { sig: null, body: '' };
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    seen = { sig: (init.headers as Record<string, string>)['x-lw-render-sig'] ?? null, body: String(init.body) };
    return res(200, { svg: okSvg });
  }) as unknown as typeof fetch;

  const now = 1_700_000_000_000;
  const svg = await renderViaWorker(CFG, JOB, { now, fetchImpl });
  assert.equal(svg, okSvg);
  // The signature verifies over the exact bytes sent, and the body carries ts.
  assert.ok(seen.sig && verifyBody(seen.body, SECRET, seen.sig));
  const parsed = JSON.parse(seen.body) as { ts: number; toolId: string };
  assert.equal(parsed.ts, now);
  assert.equal(parsed.toolId, 'hooky');
});

test('renderViaWorker maps worker errors to statuses', async () => {
  const withStatus = (status: number, body: unknown = { error: { message: 'nope' } }) =>
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => res(status, body)) as unknown as typeof fetch });

  // 422/400 pass through (a real policy/param rejection); other 5xx become 502.
  await assert.rejects(withStatus(422), (e: WorkerError) => e instanceof WorkerError && e.status === 422);
  await assert.rejects(withStatus(400), (e: WorkerError) => e.status === 400);
  await assert.rejects(withStatus(500), (e: WorkerError) => e.status === 502);
  // A 200 with no SVG is a protocol failure.
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => res(200, { svg: 'not-svg' })) as unknown as typeof fetch }),
    (e: WorkerError) => e instanceof WorkerError && /no SVG/.test(e.message),
  );
});

test('renderViaWorker maps an unreachable worker to 502', async () => {
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl: (async () => { throw new Error('ECONNREFUSED'); }) as unknown as typeof fetch }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 502,
  );
});

test('renderViaWorker maps a worker 503 to RENDER_BUSY (plans/23 §3.C), distinct from a generic 502, and passes Retry-After through untouched — no retry loop here', async () => {
  let calls = 0;
  const fetchImpl = (async () => {
    calls++;
    return res(503, { error: { message: 'at capacity' } }, { 'retry-after': '2' });
  }) as unknown as typeof fetch;

  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === 2,
  );
  assert.equal(calls, 1, 'the client makes exactly one attempt — retrying, if any, is the caller\'s call');
});

test('renderViaWorker: a 503 with no Retry-After header still maps to RENDER_BUSY, just without a retryAfter hint', async () => {
  const fetchImpl = (async () => res(503, { error: { message: 'busy' } })) as unknown as typeof fetch;
  await assert.rejects(
    renderViaWorker(CFG, JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === undefined,
  );
});

test('rasteriseViaWorker maps a worker 503 to RENDER_BUSY the same way renderViaWorker does', async () => {
  const fetchImpl = (async () => res(503, { error: { message: 'busy' } }, { 'retry-after': '2' })) as unknown as typeof fetch;
  await assert.rejects(
    rasteriseViaWorker(CFG, RASTER_JOB, { fetchImpl }),
    (e: WorkerError) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === 2,
  );
});

test('the accepted timestamp skew is bounded', () => {
  assert.equal(WORKER_TS_SKEW_MS, 5 * 60 * 1000);
});
