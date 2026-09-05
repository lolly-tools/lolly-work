import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { readBlobBody } from '../server/src/blobs/types.ts';
import { newRender, parseRenderSpec, renderWire } from '../server/src/renders/request.ts';
import { RenderRunner } from '../server/src/renders/runner.ts';
import { RenderResourceError, type RenderRecord } from '../server/src/renders/types.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { runRenderStoreConformance } from './render-store-conformance.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { evidenceFixture } from './render-evidence-fixture.ts';

const spec = parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Hello' } });
const result = { bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml', cacheKey: 'render-key', evidence: evidenceFixture(Buffer.from('<svg/>')) };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await delay(10); }
  assert.fail('render did not settle');
}

test('render resources: memory store conformance', async () => runRenderStoreConformance(createMemoryStore()));
test('render resources: Postgres store conformance', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, runRenderStoreConformance);
});

test('request fingerprints preserve typed values, normalize object key order and reject unsafe input', () => {
  const a = newRender('user:a', parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { b: 2, a: { y: true, x: 1 } } }));
  const b = newRender('user:a', parseRenderSpec({ inputs: { a: { x: 1, y: true }, b: 2 }, format: 'SVG', toolId: 'card' }));
  assert.equal(a.requestHash, b.requestHash);
  const changed = newRender('user:a', parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { b: '2', a: { x: 1, y: true } } }));
  assert.notEqual(a.requestHash, changed.requestHash);
  for (const invalid of [null, [], {}, { ...spec, unknown: true }, { ...spec, inputs: [] }, { ...spec, inputs: null }, { ...spec, maxAttempts: 100 },
    { ...spec, priority: 0.2 }, { ...spec, inputs: { n: Infinity } }, { ...spec, toolId: '../private' },
    { ...spec, inputs: JSON.parse('{"__proto__":{"polluted":true}}') }]) {
    assert.throws(() => parseRenderSpec(invalid), RenderResourceError);
  }
  assert.throws(() => newRender('user:a', spec, ' '), RenderResourceError);
});

test('a fresh runner recovers a persisted request without the original closure', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  await store.claimRender(30); // process disappears after claiming
  await delay(60);
  const runner = new RenderRunner({ store, blobs, execute: async (record) => { assert.deepEqual(record.request, spec); return result; } });
  t.after(() => runner.stop());
  await runner.tick();
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded');
  const saved = (await store.getRender(r.id, r.principal))!;
  assert.equal(saved.attempt, 2);
  assert.equal(saved.output!.sha256, sha256Hex(result.bytes));
  assert.deepEqual(saved.output!.evidence, result.evidence);
  assert.deepEqual(await readBlobBody((await blobs.get(saved.output!.ref))!.body), result.bytes);
  const wire = renderWire(saved);
  assert.equal('leaseToken' in wire, false); assert.equal('principal' in wire, false);
  assert.equal('ref' in (wire.output as object), false);
});

test('cancellation prevents a late executor from retaining or publishing bytes', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  let claimed: RenderRecord | undefined;
  const runner = new RenderRunner({ store, blobs, leaseMs: 60, execute: async (record) => { claimed = record; await gate; return result; } });
  t.after(() => runner.stop());
  await runner.tick(); await until(async () => !!claimed);
  await store.cancelRender(r.id, r.principal);
  await delay(40); release(); await delay(30);
  assert.equal((await store.getRender(r.id, r.principal))!.state, 'cancelled');
  assert.equal(await blobs.get(`renders/${r.id}/attempt-1-${claimed!.leaseToken}`), null);
});

test('transient failures retry, permanent policy failures stop, timeouts consume bounded attempts', async (t) => {
  for (const kind of ['transient', 'permanent', 'timeout'] as const) {
    const store = createMemoryStore(); const blobs = createMemoryBlobStore();
    let attempts = 0;
    const r = (await store.insertRender(newRender('user:a', { ...spec, maxAttempts: 2 }))).record;
    const runner = new RenderRunner({ store, blobs, timeoutMs: kind === 'timeout' ? 20 : 1_000, pollMs: 10, retryDelayMs: 1,
      execute: async () => {
        attempts++;
        if (kind === 'timeout') await new Promise(() => {});
        if (kind === 'permanent') throw new RenderResourceError('FORBIDDEN', 403, 'policy changed');
        if (attempts === 1) throw new Error('temporary failure');
        return result;
      },
    });
    t.after(() => runner.stop()); runner.start();
    await until(async () => ['succeeded', 'failed'].includes((await store.getRender(r.id, r.principal))!.state));
    const settled = (await store.getRender(r.id, r.principal))!;
    assert.equal(settled.state, kind === 'transient' ? 'succeeded' : 'failed');
    assert.equal(settled.attempt, kind === 'permanent' ? 1 : 2);
    await runner.stop();
  }
});

test('a lost database response after successful settlement never deletes the winning bytes', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const settle = store.settleRender.bind(store);
  store.settleRender = async (id, token, outcome) => {
    const saved = await settle(id, token, outcome);
    if (outcome.state === 'succeeded' && saved) throw new Error('connection lost after commit');
    return saved;
  };
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  const runner = new RenderRunner({ store, blobs, execute: async () => result });
  t.after(() => runner.stop()); await runner.tick();
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded');
  await delay(20);
  const saved = (await store.getRender(r.id, r.principal))!;
  assert.ok(await blobs.get(saved.output!.ref));
});

test('a second worker recovers an expired attempt while the old renderer is still running', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  let releaseOld!: () => void; let releaseHeartbeat!: () => void;
  const oldWork = new Promise<void>((resolve) => { releaseOld = resolve; });
  const disconnected = new Promise<void>((resolve) => { releaseHeartbeat = resolve; });
  let oldToken = '';
  const heartbeat = store.heartbeatRender.bind(store);
  store.heartbeatRender = async (id, token, leaseMs) => {
    if (token === oldToken) await disconnected;
    return heartbeat(id, token, leaseMs);
  };
  const oldRunner = new RenderRunner({ store, blobs, leaseMs: 60, execute: async (record) => {
    oldToken = record.leaseToken!; await oldWork; return { ...result, bytes: Buffer.from('old'), evidence: evidenceFixture(Buffer.from('old')) };
  } });
  const replacement = new RenderRunner({ store, blobs, execute: async () => result });
  t.after(async () => { releaseOld(); releaseHeartbeat(); await oldRunner.stop(); await replacement.stop(); });
  await oldRunner.tick(); await until(async () => !!oldToken); await delay(90);
  await replacement.tick();
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded');
  releaseOld(); releaseHeartbeat(); await delay(30);
  const winner = (await store.getRender(r.id, r.principal))!;
  assert.equal(winner.attempt, 2);
  assert.equal(winner.output!.sha256, sha256Hex(result.bytes));
  assert.deepEqual(winner.output!.evidence, result.evidence, 'a stale worker cannot replace the winning execution receipt');
  assert.ok(await blobs.get(winner.output!.ref));
  assert.equal(await blobs.get(`renders/${r.id}/attempt-1-${oldToken}`), null);
});

test('a runner refuses mismatched output/evidence and a tampered evidence digest before storing bytes', async (t) => {
  for (const evidence of [evidenceFixture(Buffer.from('different output')), { ...result.evidence, id: 'tampered' }]) {
    const store = createMemoryStore(); const blobs = createMemoryBlobStore();
    const resource = (await store.insertRender(newRender('user:a', { ...spec, maxAttempts: 1 }))).record;
    let ref = '';
    const runner = new RenderRunner({ store, blobs, execute: async (record) => {
      ref = `renders/${record.id}/attempt-${record.attempt}-${record.leaseToken}`;
      return { ...result, evidence };
    } });
    t.after(() => runner.stop());
    await runner.tick();
    await until(async () => (await store.getRender(resource.id, resource.principal))?.state === 'failed');
    const failed = (await store.getRender(resource.id, resource.principal))!;
    assert.equal(failed.error!.code, 'RENDER_EVIDENCE_MISMATCH');
    assert.equal(failed.output, undefined); assert.equal(await blobs.get(ref), null);
  }
});

test('heartbeats retain a long render and prevent a second worker from claiming it', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const runner = new RenderRunner({ store, blobs, leaseMs: 90, execute: async () => { await gate; return result; } });
  t.after(async () => { release(); await runner.stop(); });
  await runner.tick(); await delay(200);
  assert.equal(await store.claimRender(1_000), null);
  release();
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded');
  assert.equal((await store.getRender(r.id, r.principal))!.attempt, 1);
});

test('shutdown waits for an in-flight claim and releases it without executing', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  const claim = store.claimRender.bind(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  store.claimRender = async (leaseMs) => { await gate; return claim(leaseMs); };
  let executed = false; let stopped = false;
  const runner = new RenderRunner({ store, blobs, execute: async () => { executed = true; return result; } });
  const tick = runner.tick(); const stop = runner.stop().then(() => { stopped = true; });
  await delay(10); assert.equal(stopped, false);
  release(); await Promise.all([tick, stop]);
  assert.equal(executed, false);
  assert.equal((await store.getRender(r.id, r.principal))!.state, 'queued');
});
