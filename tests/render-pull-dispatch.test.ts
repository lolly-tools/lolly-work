// SPDX-License-Identifier: MPL-2.0
/**
 * Pull dispatch for the render worker (plan 324 M3, D5), Work's side: the
 * lease broker (render/worker-leases.ts), its HTTP endpoint
 * (render/lease-routes.ts), the shared reply checks in worker-client.ts, the
 * durable runner's retry and idempotency rules under pull, and the queue
 * signals on /metrics and in the OTLP export.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { createLeaseBroker, type LeaseGrant } from '../server/src/render/worker-leases.ts';
import { registerLeaseRoutes } from '../server/src/render/lease-routes.ts';
import { renderViaWorker, rasteriseViaWorker, signBody, verifyBody, WorkerError, type WorkerConfig, type WorkerExchange } from '../server/src/render/worker-client.ts';
import { createRouter } from '../server/src/api/router.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import { createOtel } from '../server/src/observability/otel.ts';
import { otelConfigFromEnv } from '../server/src/observability/otel-config.ts';
import { RenderRunner, parseRenderConcurrency } from '../server/src/renders/runner.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createToolPoolReader } from '../server/src/render/pools.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const SECRET = 'pull-dispatch-test-secret';
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const ok = (svg = '<svg xmlns="http://www.w3.org/2000/svg"/>') => ({ status: 200, body: JSON.stringify({ svg }) });
const job = (toolId = 'qr-code') => ({ toolId, query: 'url=x', overrides: {}, format: 'svg', profile: {} });
async function until(predicate: () => boolean | Promise<boolean>, ms = 3000): Promise<void> {
  const stop = Date.now() + ms;
  while (Date.now() < stop) { if (await predicate()) return; await delay(5); }
  assert.fail('condition did not settle');
}

// ── the broker ──────────────────────────────────────────────────────────────

test('a waiting worker receives a job the moment it is dispatched, signed when taken', async () => {
  const broker = createLeaseBroker({ secret: SECRET });
  after(() => broker.close());
  const waiting = broker.lease(['tier-b'], 5000);
  assert.equal(broker.stats().find((s) => s.pool === 'tier-b')?.idleWorkers, 1);
  const started = Date.now();
  const exchange = broker.dispatch('/render', job(), { timeoutMs: 5000 });
  const grant = (await waiting)!;
  assert.ok(Date.now() - started < 50, 'no polling interval between dispatch and lease');
  assert.equal(grant.path, '/render');
  assert.equal(grant.pool, 'tier-b');
  assert.ok(verifyBody(grant.payload, SECRET, grant.signature), 'the job is signed with the push key');
  const payload = JSON.parse(grant.payload);
  assert.equal(payload.toolId, 'qr-code');
  assert.ok(Math.abs(payload.ts - Date.now()) < 1000, 'stamped when leased, so the worker skew check passes');
  assert.equal(broker.complete(grant.id, grant.token, ok()), true);
  const done = await exchange;
  assert.equal(done.payload, grant.payload, 'the caller sees the exact payload the worker received');
  assert.equal(done.reply.status, 200);
  assert.equal(broker.complete(grant.id, grant.token, ok()), false, 'a report is accepted once');
});

test('jobs are leased in order; a lapsed lease is reclaimed at the head with a new token', async () => {
  const events: string[] = [];
  const broker = createLeaseBroker({ secret: SECRET, leaseMs: 40, onEvent: (_pool, e) => events.push(e) });
  after(() => broker.close());
  const [a, b, c] = ['a', 'b', 'c'].map((id) => broker.dispatch('/render', job(id), { timeoutMs: 5000 })) as [Promise<WorkerExchange>, Promise<WorkerExchange>, Promise<WorkerExchange>];
  const first = (await broker.lease(['tier-b'], 0))!;
  const second = (await broker.lease(['tier-b'], 0))!;
  assert.equal(JSON.parse(first.payload).toolId, 'a');
  assert.equal(JSON.parse(second.payload).toolId, 'b');
  // The second worker keeps renewing; the first dies: no renewal, no report.
  const renewing = setInterval(() => assert.equal(broker.renew(second.id, second.token), true), 10);
  after(() => clearInterval(renewing));
  await until(() => events.includes('reclaimed'));
  const again = (await broker.lease(['tier-b'], 0))!;
  assert.equal(again.id, first.id);
  assert.notEqual(again.token, first.token);
  assert.equal(JSON.parse(again.payload).toolId, 'a', 'the reclaimed job keeps its place ahead of c');
  assert.equal(broker.complete(first.id, first.token, ok('<svg>stale</svg>')), false, 'the dead worker can never publish');
  assert.equal(broker.renew(first.id, first.token), false);
  assert.equal(broker.complete(again.id, again.token, ok('<svg>a</svg>')), true);
  assert.match((await a).reply.body, /<svg>a</);
  clearInterval(renewing);
  assert.equal(broker.complete(second.id, second.token, ok()), true);
  await b;
  const third = (await broker.lease(['tier-b'], 0))!;
  assert.equal(JSON.parse(third.payload).toolId, 'c');
  broker.complete(third.id, third.token, ok());
  await c;
  assert.deepEqual(events.filter((e) => e !== 'granted'), ['expired', 'reclaimed', 'completed', 'completed', 'completed']);
});

test('a job whose leases keep lapsing fails as a 502 after its reclaims, like a push to a dead worker', async () => {
  const broker = createLeaseBroker({ secret: SECRET, leaseMs: 20, maxReclaims: 1 });
  after(() => broker.close());
  const exchange = broker.dispatch('/rasterise', { svg: '<svg/>', format: 'png' }, { timeoutMs: 5000 });
  const rejected = assert.rejects(exchange, (e: unknown) => e instanceof WorkerError && e.status === 502 && /lease expired/.test(e.message));
  await broker.lease(['tier-b'], 0);
  await broker.lease(['tier-b'], 1000);
  await rejected;
  assert.equal(broker.stats().every((s) => s.waiting === 0 && s.leased === 0), true);
});

test('renewal keeps a lease; the worker timeout still bounds the whole exchange', async () => {
  const broker = createLeaseBroker({ secret: SECRET, leaseMs: 30 });
  after(() => broker.close());
  const exchange = broker.dispatch('/render', job(), { timeoutMs: 150 });
  const rejected = assert.rejects(exchange, (e: unknown) => e instanceof WorkerError && e.status === 502 && /timeout/.test(e.message));
  const grant = (await broker.lease(['tier-b'], 0))!;
  const renewing = setInterval(() => broker.renew(grant.id, grant.token), 10);
  try { await rejected; } finally { clearInterval(renewing); }
  assert.equal(broker.renew(grant.id, grant.token), false, 'the worker learns to stop');
});

test('a job no worker takes in time fails as RENDER_BUSY, the answer a full worker gives under push', async () => {
  const broker = createLeaseBroker({ secret: SECRET, queueTimeoutMs: 30 });
  after(() => broker.close());
  await assert.rejects(broker.dispatch('/render', job(), { timeoutMs: 5000 }),
    (e: unknown) => e instanceof WorkerError && e.status === 503 && e.code === 'RENDER_BUSY' && e.retryAfter === 2);
});

test('cancelling a render drops its queued job, or ends its lease so the worker stops', async () => {
  const broker = createLeaseBroker({ secret: SECRET });
  after(() => broker.close());
  const queued = new AbortController();
  const q = broker.dispatch('/render', job(), { timeoutMs: 5000, signal: queued.signal });
  queued.abort(new Error('cancelled while queued'));
  await assert.rejects(q, /cancelled while queued/);
  assert.equal(await broker.lease(['tier-b'], 0), null, 'nothing left to lease');
  const held = new AbortController();
  const h = broker.dispatch('/render', job(), { timeoutMs: 5000, signal: held.signal });
  const grant = (await broker.lease(['tier-b'], 0))!;
  held.abort(new Error('cancelled while leased'));
  await assert.rejects(h, /cancelled while leased/);
  assert.equal(broker.renew(grant.id, grant.token), false);
  assert.equal(broker.complete(grant.id, grant.token, ok()), false);
});

test('a grant that never reached its worker goes back without counting as a reclaim', async () => {
  const broker = createLeaseBroker({ secret: SECRET, maxReclaims: 0 });
  after(() => broker.close());
  const exchange = broker.dispatch('/render', job(), { timeoutMs: 5000 });
  const lost = (await broker.lease(['tier-b'], 0))!;
  broker.abandon(lost.id, lost.token);
  const next = (await broker.lease(['tier-b'], 0))!;
  assert.equal(next.id, lost.id);
  assert.equal(broker.complete(next.id, next.token, ok()), true);
  await exchange;
});

test('stats report waiting jobs, the oldest wait, leases and idle workers per pool', async () => {
  let clock = 1_000_000;
  const broker = createLeaseBroker({ secret: SECRET, now: () => clock });
  after(() => broker.close());
  const first = broker.dispatch('/render', job(), { timeoutMs: 5000 }); void first.catch(() => {});
  clock += 4000;
  const second = broker.dispatch('/rasterise', { svg: '<svg/>', format: 'png' }, { timeoutMs: 5000 }); void second.catch(() => {});
  clock += 1500;
  assert.deepEqual(broker.stats(), [{ pool: 'tier-b', waiting: 2, oldestWaitSeconds: 5.5, leased: 0, idleWorkers: 0 }]);
  await broker.lease(['tier-b'], 0);
  assert.deepEqual(broker.stats(), [{ pool: 'tier-b', waiting: 1, oldestWaitSeconds: 1.5, leased: 1, idleWorkers: 0 }]);
});

// ── the shared reply checks ─────────────────────────────────────────────────

/** A worker double that leases one job and answers it with `answer`. */
async function answerOne(broker: ReturnType<typeof createLeaseBroker>, answer: (grant: LeaseGrant) => { status: number; body: string; outputSig?: string | null; retryAfter?: string | null }) {
  const grant = (await broker.lease(['tier-b'], 2000))!;
  broker.complete(grant.id, grant.token, answer(grant));
  return grant;
}

test('pull replies pass the same evidence checks as push, bound to the payload the worker leased', async () => {
  const broker = createLeaseBroker({ secret: SECRET });
  after(() => broker.close());
  const cfg: WorkerConfig = { url: 'https://worker.invalid', secret: SECRET, timeoutMs: 5000, dispatch: broker.dispatch };
  const svg = '<svg xmlns="http://www.w3.org/2000/svg"><rect/></svg>';
  const signedReply = (grant: LeaseGrant, requestSha256 = sha256Hex(grant.payload)) => {
    const body = JSON.stringify({ svg, evidence: { version: 1, requestSha256, outputSha256: sha256Hex(svg), resources: [], limitations: [] } });
    return { status: 200, body, outputSig: signBody(body, SECRET) };
  };
  let seen: unknown;
  const good = renderViaWorker(cfg, { ...job(), format: 'svg', evidence: true }, { onEvidence: (e) => { seen = e; } });
  await answerOne(broker, (g) => signedReply(g));
  assert.equal(await good, svg);
  assert.ok(seen);
  const forged = renderViaWorker(cfg, { ...job(), format: 'svg', evidence: true });
  await answerOne(broker, (g) => signedReply(g, sha256Hex('another request')));
  await assert.rejects(forged, /does not bind this request/);
  const unsigned = renderViaWorker(cfg, { ...job(), format: 'svg', evidence: true });
  await answerOne(broker, (g) => ({ ...signedReply(g), outputSig: null }));
  await assert.rejects(unsigned, /signature is missing or invalid/);
  const busy = rasteriseViaWorker(cfg, { svg, format: 'png' });
  await answerOne(broker, () => ({ status: 503, retryAfter: '2', body: JSON.stringify({ error: { code: 'RENDER_BUSY', message: 'full' } }) }));
  await assert.rejects(busy, (e: unknown) => e instanceof WorkerError && e.code === 'RENDER_BUSY' && e.retryAfter === 2);
  const raster = rasteriseViaWorker(cfg, { svg, format: 'png' });
  await answerOne(broker, () => ({ status: 200, body: JSON.stringify({ bytesB64: Buffer.from('png').toString('base64'), mime: 'image/png' }) }));
  assert.equal(Buffer.from((await raster).bytes).toString(), 'png');
});

// ── durable renders under pull ─────────────────────────────────────────────

const spec = parseRenderSpec({ toolId: 'qr-code', format: 'svg', inputs: { url: 'https://example.com' } });
function durable(cfg: WorkerConfig, opts: { retryDelayMs?: number } = {}) {
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  const runner = new RenderRunner({ store, blobs, leaseMs: 5000, pollMs: 0, retryDelayMs: opts.retryDelayMs ?? 60_000,
    execute: async (record, signal) => {
      const svg = await renderViaWorker(cfg, { toolId: record.request.toolId, query: '', overrides: {}, format: 'svg', profile: {} }, { signal });
      return { bytes: Buffer.from(svg), mime: 'image/svg+xml', cacheKey: 'pull-test' };
    } });
  return { store, runner };
}

test('a worker that dies mid-job costs the durable render no attempt: the job is reclaimed, and the key still names one render', async (t) => {
  const broker = createLeaseBroker({ secret: SECRET, leaseMs: 40 });
  const { store, runner } = durable({ url: 'https://worker.invalid', secret: SECRET, timeoutMs: 5000, dispatch: broker.dispatch });
  t.after(async () => { await runner.stop(); broker.close(); });
  const principal = 'user:pull';
  const [one, two] = await Promise.all([store.insertRender(newRender(principal, spec, 'same-key')), store.insertRender(newRender(principal, spec, 'same-key'))]);
  assert.equal(one.record.id, two.record.id, 'Idempotency-Key semantics are the store\'s, unchanged');
  runner.start();
  const dead = (await broker.lease(['tier-b'], 2000))!;
  const live = (await broker.lease(['tier-b'], 2000))!; // waits until the dead lease lapses
  assert.equal(live.id, dead.id);
  assert.equal(broker.complete(live.id, live.token, ok('<svg>done</svg>')), true);
  await until(async () => (await store.getRender(one.record.id, principal))?.state === 'succeeded');
  const done = (await store.getRender(one.record.id, principal))!;
  assert.equal(done.attempt, 1);
  assert.equal(broker.complete(dead.id, dead.token, ok('<svg>late</svg>')), false);
  assert.equal(await broker.lease(['tier-b'], 0), null, 'one job for one durable attempt');
});

test('no worker in time leaves the durable render exactly as a busy push worker does', async (t) => {
  const busyFetch = (async () => new Response(JSON.stringify({ error: { code: 'RENDER_BUSY', message: 'full' } }),
    { status: 503, headers: { 'retry-after': '2' } })) as typeof fetch;
  const broker = createLeaseBroker({ secret: SECRET, queueTimeoutMs: 20 });
  const push = durable({ url: 'https://worker.invalid', secret: SECRET, timeoutMs: 5000 });
  const pull = durable({ url: 'https://worker.invalid', secret: SECRET, timeoutMs: 5000, dispatch: broker.dispatch });
  // The push double answers like a saturated worker.
  const realFetch = globalThis.fetch;
  globalThis.fetch = busyFetch;
  t.after(async () => { globalThis.fetch = realFetch; await push.runner.stop(); await pull.runner.stop(); broker.close(); });
  const outcomes = [];
  for (const side of [push, pull]) {
    const { record } = await side.store.insertRender(newRender('user:busy', spec));
    await side.runner.tick();
    await until(async () => (await side.store.getRender(record.id, 'user:busy'))?.state === 'queued'
      && !!(await side.store.getRender(record.id, 'user:busy'))?.error);
    const r = (await side.store.getRender(record.id, 'user:busy'))!;
    outcomes.push({ state: r.state, attempt: r.attempt, code: r.error?.code, waits: Date.parse(r.availableAt) > Date.now() });
  }
  assert.deepEqual(outcomes[0], { state: 'queued', attempt: 1, code: 'RENDER_BUSY', waits: true });
  assert.deepEqual(outcomes[1], outcomes[0]);
});

test('LW_RENDER_CONCURRENCY accepts 1 to 128 and keeps the default when unset', () => {
  assert.equal(parseRenderConcurrency(undefined), undefined);
  assert.equal(parseRenderConcurrency(' '), undefined);
  assert.equal(parseRenderConcurrency('64'), 64);
  for (const bad of ['0', '129', '2.5', 'many']) assert.throws(() => parseRenderConcurrency(bad), /LW_RENDER_CONCURRENCY/);
  assert.equal(new RenderRunner({ store: createMemoryStore(), blobs: createMemoryBlobStore(), execute: async () => { throw new Error('unused'); } }).concurrency, 2);
});

// ── the lease endpoint ─────────────────────────────────────────────────────

async function serve(handler: (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => void): Promise<{ base: string; server: Server }> {
  const server = createServer(handler);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  after(() => { server.closeAllConnections(); server.close(); });
  const address = server.address();
  return { base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, server };
}
const nonce = () => randomBytes(18).toString('base64url');
function signedPost(base: string, path: string, body: Record<string, unknown>, opts: { secret?: string; ts?: number; signal?: AbortSignal } = {}) {
  const raw = JSON.stringify({ ts: opts.ts ?? Date.now(), ...body });
  return fetch(`${base}${path}`, { method: 'POST', body: raw, ...(opts.signal ? { signal: opts.signal } : {}),
    headers: { 'content-type': 'application/json', 'x-lw-render-sig': signBody(raw, opts.secret ?? SECRET) } });
}

test('the lease endpoint refuses unsigned, mis-signed, stale, malformed and replayed requests', async () => {
  const broker = createLeaseBroker({ secret: SECRET });
  after(() => broker.close());
  const router = createRouter();
  registerLeaseRoutes(router, { broker, secret: SECRET });
  const { base } = await serve((req, res) => void router.dispatch(req, res));
  const unsigned = await fetch(`${base}/api/internal/render/lease`, { method: 'POST', body: JSON.stringify({ pools: ['tier-b'], waitMs: 0, ts: Date.now(), nonce: nonce() }) });
  assert.equal(unsigned.status, 401);
  assert.equal((await signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 0, nonce: nonce() }, { secret: 'another-key' })).status, 401);
  assert.equal((await signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 0, nonce: nonce() }, { ts: Date.now() - 120_000 })).status, 401);
  assert.equal((await signedPost(base, '/api/internal/render/lease', { pools: ['gpu'], waitMs: 0, nonce: nonce() })).status, 400);
  assert.equal((await signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 60_000, nonce: nonce() })).status, 400);
  const raw = JSON.stringify({ pools: ['tier-b'], waitMs: 0, ts: Date.now(), nonce: nonce() });
  const send = () => fetch(`${base}/api/internal/render/lease`, { method: 'POST', body: raw, headers: { 'x-lw-render-sig': signBody(raw, SECRET) } });
  assert.equal((await send()).status, 204, 'nothing to lease');
  assert.equal((await send()).status, 401, 'a recorded request cannot be replayed');
});

test('over HTTP: a long-poll returns the job, renewal and result need the current token, and a hang-up stops the wait', async () => {
  const broker = createLeaseBroker({ secret: SECRET });
  after(() => broker.close());
  const router = createRouter();
  registerLeaseRoutes(router, { broker, secret: SECRET });
  const { base } = await serve((req, res) => void router.dispatch(req, res));
  const polling = signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 5000, nonce: nonce() });
  await until(() => broker.stats().some((s) => s.idleWorkers === 1));
  const exchange = broker.dispatch('/render', job(), { timeoutMs: 5000 });
  const res = await polling;
  assert.equal(res.status, 200);
  const grant = await res.json() as LeaseGrant;
  assert.ok(verifyBody(grant.payload, SECRET, grant.signature));
  assert.equal((await signedPost(base, `/api/internal/render/leases/${grant.id}/renew`, { token: 'not-the-token' })).status, 410);
  assert.equal((await signedPost(base, `/api/internal/render/leases/${grant.id}/renew`, { token: grant.token })).status, 204);
  const body = JSON.stringify({ svg: '<svg/>' });
  assert.equal((await signedPost(base, `/api/internal/render/leases/${grant.id}/result`, { token: grant.token, status: 200, body, outputSig: signBody(body, SECRET) })).status, 204);
  assert.equal((await signedPost(base, `/api/internal/render/leases/${grant.id}/result`, { token: grant.token, status: 200, body })).status, 410, 'a second report is refused');
  const done = await exchange;
  assert.equal(done.reply.body, body);
  assert.ok(verifyBody(done.reply.body, SECRET, done.reply.outputSig ?? ''));
  const hangUp = new AbortController();
  const abandoned = signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 5000, nonce: nonce() }, { signal: hangUp.signal });
  await until(() => broker.stats().some((s) => s.idleWorkers === 1));
  hangUp.abort();
  await assert.rejects(abandoned);
  await until(() => broker.stats().every((s) => s.idleWorkers === 0));
});

// ── the app: off by default, and the queue signals ──────────────────────────

async function startApp(dispatch?: 'push' | 'pull') {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pull-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  for (const [id, manifest] of [['hooked', { id: 'hooked', hooks: { onInit: true } }], ['plain', { id: 'plain' }]] as const) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify(manifest));
  }
  const receiverBodies: Buffer[] = [];
  const receiver = await serve(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    receiverBodies.push(Buffer.concat(chunks));
    res.writeHead(200, { 'content-type': 'application/json' }); res.end('{}');
  });
  const otel = createOtel(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${receiver.base}/v1/metrics`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }, '1').config);
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Pull', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }] },
    render: { worker: { url: 'http://127.0.0.1:9', timeoutMs: 5000, ...(dispatch ? { dispatch } : {}) } },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's'.repeat(32), link: 'l'.repeat(32), renderWorker: SECRET }, blobs: createMemoryBlobStore(), otel, backgroundPollMs: 0 });
  const { base } = await serve((req, res) => void app(req, res));
  return { base, store, otel, receiverBodies, config };
}
const scrape = async (base: string) => (await (await fetch(`${base}/metrics`)).text()).split('\n');

test('push is the default: the config says so and no lease route exists', async () => {
  const { base, config } = await startApp();
  assert.equal(config.render.worker.dispatch, 'push');
  assert.equal((await signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 0, nonce: nonce() })).status, 404);
  const lines = await scrape(base);
  assert.ok(lines.includes('lw_render_queue_depth{pool="tier-b"} 0'), 'queue signals are exported under push too');
  assert.ok(!lines.some((l) => l.startsWith('lw_render_leases_active') || l.startsWith('lw_render_workers_waiting')), 'lease series only exist under pull');
  assert.throws(() => parseConfig(JSON.stringify({ render: { worker: { dispatch: 'queue' } } })), /dispatch must be "push" or "pull"/);
  assert.throws(() => parseConfig(JSON.stringify({ render: { worker: { pull: { leaseMs: 10, queueTimeoutMs: 30000 } } } })), /leaseMs/);
});

test('/metrics and the OTLP export carry queue depth, oldest wait and the lease series per pool', async () => {
  const { base, store, otel, receiverBodies } = await startApp('pull');
  for (const toolId of ['hooked', 'hooked', 'plain']) await store.insertRender(newRender('user:m', parseRenderSpec({ toolId, format: 'svg' })));
  await delay(20);
  const polling = signedPost(base, '/api/internal/render/lease', { pools: ['tier-b'], waitMs: 400, nonce: nonce() });
  await delay(50);
  const lines = await scrape(base);
  const value = (series: string) => Number(lines.find((l) => l.startsWith(`${series} `))?.split(' ')[1]);
  assert.equal(value('lw_render_queue_depth{pool="tier-b"}'), 2, 'hooked tools wait for the Chromium pool');
  assert.equal(value('lw_render_queue_depth{pool="tier-a"}'), 1);
  assert.ok(value('lw_render_oldest_wait_seconds{pool="tier-b"}') > 0);
  assert.equal(value('lw_render_workers_waiting{pool="tier-b"}'), 1, 'the open long-poll is an idle worker slot');
  assert.equal(value('lw_render_leases_active{pool="tier-b"}'), 0);
  assert.equal((await polling).status, 204);
  await otel.shutdown();
  const exported = receiverBodies.map((b) => JSON.parse(b.toString())).flatMap((m) => m.resourceMetrics[0].scopeMetrics[0].metrics as Array<{ name: string; gauge?: { dataPoints: Array<{ attributes: Array<{ key: string; value: { stringValue: string } }> }> } }>);
  const depth = exported.find((m) => m.name === 'lw_render_queue_depth');
  assert.ok(depth?.gauge, 'the OTLP mapping reads the same series');
  assert.deepEqual(depth.gauge.dataPoints.map((p) => p.attributes.find((a) => a.key === 'pool')?.value.stringValue).sort(), ['tier-a', 'tier-b']);
  assert.ok(exported.some((m) => m.name === 'lw_render_workers_waiting'));
});

test('the lease counter is a /metrics series, and a tool pool follows the manifest and the fast-path flag', async () => {
  const m = createMetrics();
  m.renderLease('tier-b', 'granted');
  m.renderLease('tier-b', 'granted');
  m.renderLease('tier-b', 'expired');
  const text = m.renderText([]);
  assert.match(text, /# TYPE lw_render_leases_total counter/);
  assert.match(text, /lw_render_leases_total\{pool="tier-b",event="granted"\} 2/);
  assert.ok(m.snapshot().some((l) => l.name === 'lw_render_leases_total' && l.labels?.event === 'expired'), 'and the OTLP snapshot carries it');
  const pack = await mkdtemp(join(tmpdir(), 'lw-pool-'));
  await mkdir(join(pack, 'tools', 'hooked'), { recursive: true });
  await writeFile(join(pack, 'tools', 'hooked', 'tool.json'), JSON.stringify({ hooks: { onInit: true } }));
  assert.equal(await createToolPoolReader({ pack, allowHooksInFastPath: false })('hooked'), 'tier-b');
  assert.equal(await createToolPoolReader({ pack, allowHooksInFastPath: true })('hooked'), 'tier-a');
  assert.equal(await createToolPoolReader({ pack, allowHooksInFastPath: false })('../etc'), 'tier-a');
});
