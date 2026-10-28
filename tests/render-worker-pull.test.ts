// SPDX-License-Identifier: MPL-2.0
/**
 * Pull dispatch, the worker's side (workers/render/src/pull.ts), against the
 * real lease endpoint and broker Work runs (server/src/render/lease-routes.ts,
 * worker-leases.ts), and runJob in server.ts: a pulled job passes the same
 * signature, freshness and capacity code a pushed POST does. No Chromium: the
 * browser getter is the stub the push tests use.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createLeaseBroker } from '../server/src/render/worker-leases.ts';
import { registerLeaseRoutes } from '../server/src/render/lease-routes.ts';
import { renderViaWorker, signBody, verifyBody, type WorkerConfig } from '../server/src/render/worker-client.ts';
import { createRouter } from '../server/src/api/router.ts';
import { pullBase, startPull, type JobReply } from '../workers/render/src/pull.ts';

const SECRET = 'worker-pull-test-secret';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => boolean, ms = 5000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (predicate()) return; await delay(5); }
  assert.fail('condition did not settle');
}

let workerModule: typeof import('../workers/render/src/server.ts');
before(async () => {
  process.env.LW_RENDER_WORKER_SECRET = SECRET;
  process.env.LOLLY_WEB_BASE = 'https://web.test';
  process.env.LW_RENDER_MAX_CONCURRENT = '1';
  process.env.PORT = '0';
  delete process.env.LW_RENDER_PULL_URL;
  workerModule = await import('../workers/render/src/server.ts');
});
after(() => { workerModule.server.close(); });

/** Work's lease endpoint with a fresh broker. */
async function work(opts: { leaseMs?: number } = {}) {
  const broker = createLeaseBroker({ secret: SECRET, leaseMs: opts.leaseMs ?? 15_000 });
  const router = createRouter();
  registerLeaseRoutes(router, { broker, secret: SECRET });
  const server: Server = createServer((req, res) => void router.dispatch(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  after(() => { broker.close(); server.closeAllConnections(); server.close(); });
  return { broker, base };
}

test('the pull URL is HTTPS in production and loopback HTTP only for evaluation', () => {
  assert.equal(pullBase('https://work.example/', true, {}), 'https://work.example');
  assert.equal(pullBase('http://127.0.0.1:8080', false, {}), 'http://127.0.0.1:8080');
  for (const bad of ['http://work.svc:8787', 'https://user:pw@work.example', 'https://work.example/?a=1', 'ftp://work.example']) {
    assert.throws(() => pullBase(bad, false, {}), /LW_RENDER_PULL_URL/);
  }
  assert.throws(() => pullBase('http://127.0.0.1:8080', true, {}), /LW_RENDER_PULL_URL/);
  assert.throws(() => pullBase('https://work.example', true, { NODE_TLS_REJECT_UNAUTHORIZED: '0' }), /certificate verification/);
});

test('worker slots lease jobs as Work records them and report replies Work verifies as it would a push', async (t) => {
  const { broker, base } = await work();
  const cfg: WorkerConfig = { url: 'https://worker.invalid', secret: SECRET, timeoutMs: 5000, dispatch: broker.dispatch };
  let running = 0, peak = 0;
  const pull = startPull({ base, secret: SECRET, slots: 2, pools: ['tier-b'], waitMs: 1000, run: async (job) => {
    assert.ok(verifyBody(job.payload, SECRET, job.signature), 'the job arrives signed by Work');
    running++; peak = Math.max(peak, running);
    await delay(20);
    running--;
    const svg = `<svg data-tool="${JSON.parse(job.payload).toolId}"/>`;
    const body = JSON.stringify({ svg });
    return { status: 200, headers: { 'content-type': 'application/json', 'x-lw-output-sig': signBody(body, SECRET) }, body };
  } });
  t.after(() => pull.stop());
  const tools = ['a', 'b', 'c', 'd', 'e'];
  const svgs = await Promise.all(tools.map((toolId) => renderViaWorker(cfg, { toolId, query: '', overrides: {}, format: 'svg', profile: {} })));
  assert.deepEqual(svgs, tools.map((toolId) => `<svg data-tool="${toolId}"/>`));
  assert.equal(peak, 2, 'never more jobs at once than slots');
});

test('a lease Work withdraws (the render was cancelled) stops the job and is not reported', async (t) => {
  const { broker, base } = await work({ leaseMs: 1000 });
  let aborted = false, reported = false;
  const pull = startPull({ base, secret: SECRET, slots: 1, pools: ['tier-b'], waitMs: 1000, run: (_job, signal) => new Promise<JobReply>((resolve) => {
    signal.addEventListener('abort', () => { aborted = true; resolve({ status: 502, headers: {}, body: '{}' }); }, { once: true });
  }) });
  t.after(() => pull.stop());
  const cancel = new AbortController();
  const exchange = broker.dispatch('/render', { toolId: 'slow' }, { timeoutMs: 10_000, signal: cancel.signal });
  await until(() => pull.running() === 1);
  cancel.abort(new Error('cancelled by its owner'));
  await assert.rejects(exchange, /cancelled by its owner/);
  await until(() => aborted, 3000);
  const original = broker.complete;
  broker.complete = (...args) => { reported = true; return original(...args); };
  await delay(100);
  assert.equal(reported, false);
});

test('a worker that stops mid-job lets its lease lapse, and another worker finishes the job', async () => {
  const { broker, base } = await work({ leaseMs: 1000 });
  let started!: () => void;
  const begun = new Promise<void>((resolve) => { started = resolve; });
  const first = startPull({ base, secret: SECRET, slots: 1, pools: ['tier-b'], waitMs: 1000, run: (_job, signal) => new Promise<JobReply>((resolve) => {
    started();
    signal.addEventListener('abort', () => resolve({ status: 502, headers: {}, body: '{"error":{"code":"RENDER_FAILED"}}' }), { once: true });
  }) });
  const exchange = broker.dispatch('/render', { toolId: 'kept' }, { timeoutMs: 10_000 });
  await begun;
  await first.stop();
  const second = startPull({ base, secret: SECRET, slots: 1, pools: ['tier-b'], waitMs: 1000,
    run: async () => ({ status: 200, headers: {}, body: '{"svg":"<svg/>"}' }) });
  try {
    const done = await exchange;
    assert.equal(done.reply.status, 200, 'the stopping worker did not report a failure');
  } finally { await second.stop(); }
});

// ── runJob: one code path for pushed and pulled jobs ───────────────────────

function stubRasterBrowser() {
  return {
    async newContext() {
      return {
        async route() {},
        async newPage() { return { async setContent() {}, async $() { return { async screenshot() { return Buffer.from('fake-png'); } }; } }; },
        async close() {},
      };
    },
  };
}

test('a pulled job passes the same signature and freshness checks as a POST', async () => {
  workerModule.__setBrowserGetterForTests(async () => stubRasterBrowser() as never);
  const raw = JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg"/>', format: 'png', ts: Date.now() });
  const permit = async () => () => {};
  const signal = new AbortController().signal;
  const good = await workerModule.runJob('/rasterise', raw, signBody(raw, SECRET), signal, permit);
  assert.equal(good.status, 200);
  assert.equal(Buffer.from(JSON.parse(good.body).bytesB64, 'base64').toString(), 'fake-png');
  assert.equal((await workerModule.runJob('/rasterise', raw, signBody(raw, 'another-key'), signal, permit)).status, 401);
  const stale = JSON.stringify({ svg: '<svg/>', format: 'png', ts: Date.now() - 10 * 60_000 });
  assert.equal(JSON.parse((await workerModule.runJob('/rasterise', stale, signBody(stale, SECRET), signal, permit)).body).error.code, 'STALE');
  const busy = await workerModule.runJob('/rasterise', raw, signBody(raw, SECRET), signal, async () => null);
  assert.equal(busy.status, 503);
  assert.equal(busy.headers['retry-after'], '2');
  workerModule.__setBrowserGetterForTests(null);
});
