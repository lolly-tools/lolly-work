import test from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { batchProgress, batchWire, newRenderBatch, parseRenderBatchSpec } from '../server/src/renders/batch.ts';
import { RenderResourceError, type RenderRecord, type RenderResult, type RenderStore } from '../server/src/renders/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const spec = parseRenderBatchSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Shared', bg: '#ffffff' }, rows: [
  { key: 'uk', inputs: { title: 'Hello' } }, { key: 'fr', inputs: { title: 'Bonjour' } }, { key: 'de', inputs: { title: 'Hallo' } },
] });
const output: RenderResult = { name: 'default', ref: 'batch/winner', mime: 'image/svg+xml', size: 3, sha256: 'abc', cacheKey: 'key' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function conformance(store: RenderStore) {
  const principal = 'user:batch-tests';
  const submits = await Promise.all(Array.from({ length: 8 }, () => store.insertRenderBatch(newRenderBatch(principal, spec, 'same'))));
  assert.equal(submits.filter((r) => !r.reused).length, 1);
  assert.equal(new Set(submits.map((r) => r.record.id)).size, 1);
  const batch = submits[0]!.record;
  assert.equal((await store.listRenders(principal, 100, 0)).length, 3, 'idempotent losers leave no orphan children');
  assert.equal((await store.listRenderBatches(principal, 10, 0)).length, 1);
  assert.equal(await store.getRenderBatch(batch.id, 'user:other'), null);
  assert.equal(await store.cancelRenderBatch(batch.id, 'user:other'), null);
  assert.deepEqual(await store.listRenderBatches('user:other', 10, 0), []);
  // The per-token counts (plans/82 M7): one batch of three rows, and its renders by state.
  const day = batch.createdAt.slice(0, 10);
  const window = [`${day}T00:00:00.000Z`, new Date(Date.parse(`${day}T00:00:00Z`) + 86_400_000).toISOString()] as const;
  assert.deepEqual(await store.renderBatchUsage([principal, 'user:other'], ...window), [{ principal, day, batches: 1, rows: 3 }]);
  const counted = await store.renderUsage([principal], ...window);
  assert.equal(counted.reduce((n, r) => n + r.count, 0), 3);
  assert.ok(counted.every((r) => r.principal === principal && r.day === day && r.state === 'queued' && r.company === null));
  assert.deepEqual(await store.renderUsage([principal], '2000-01-01T00:00:00.000Z', '2000-01-02T00:00:00.000Z'), []);
  assert.deepEqual(batch.rows.map((row) => row.key), ['uk', 'fr', 'de'], 'authored order survives storage');
  assert.equal(batch.rows[0]!.render.request.inputs.bg, '#ffffff');
  assert.equal(batch.rows[0]!.render.request.inputs.title, 'Hello');
  const initial = await store.getRenderBatch(batch.id, principal);
  batch.rows[0]!.render.request.inputs.title = 'mutated';
  batch.request.rows[0]!.key = 'mutated';
  assert.deepEqual(await store.getRenderBatch(batch.id, principal), initial, 'snapshots cannot mutate stored requests');

  // A failing membership insert rolls back both parent and fresh children.
  for (const kind of ['duplicate-key', 'duplicate-id', 'foreign-child', 'missing-success'] as const) {
    const invalid = newRenderBatch(principal, spec);
    if (kind === 'duplicate-key') invalid.rows[1]!.key = invalid.rows[0]!.key;
    if (kind === 'duplicate-id') invalid.rows[1]!.render.id = invalid.rows[0]!.render.id;
    if (kind === 'foreign-child') invalid.rows[1]!.render.principal = 'user:other';
    if (kind === 'missing-success') { invalid.rows[1]!.render.state = 'succeeded'; invalid.rows[1]!.render.output = output; }
    await assert.rejects(store.insertRenderBatch(invalid));
    assert.equal(await store.getRenderBatch(invalid.id, principal), null);
    assert.equal((await store.listRenders(principal, 100, 0)).length, 3);
  }

  const claimed = (await Promise.all(Array.from({ length: 6 }, () => store.claimRender(10_000))))
    .filter((r): r is RenderRecord => !!r);
  assert.equal(claimed.length, 3);
  assert.equal(new Set(claimed.map((r) => r.id)).size, 3);
  const running = (await store.getRenderBatch(batch.id, principal))!;
  assert.equal(batchProgress(running).state, 'running');
  assert.equal(batchProgress(running).progress.running, 3);
  const winner = claimed.find((r) => r.id === initial!.rows[0]!.render.id)!;
  const failure = claimed.find((r) => r.id === initial!.rows[1]!.render.id)!;
  await store.settleRender(winner.id, winner.leaseToken!, { state: 'succeeded', output });
  await store.settleRender(failure.id, failure.leaseToken!, { state: 'failed', error: { code: 'POLICY', message: 'denied' } });
  const cancelled = (await store.cancelRenderBatch(batch.id, principal))!;
  assert.deepEqual(batchProgress(cancelled).progress, { total: 3, done: 3, queued: 0, running: 0, succeeded: 1, failed: 1, cancelled: 1 });
  assert.equal(batchProgress(cancelled).state, 'failed', 'failure takes precedence over cancellation');
  assert.ok(batchProgress(cancelled).finishedAt);
  for (const r of claimed) assert.equal(await store.settleRender(r.id, r.leaseToken!, { state: 'succeeded', output }), false, 'no late attempt changes a terminal row');
  assert.deepEqual(await store.cancelRenderBatch(batch.id, principal), cancelled, 'cancellation is repeatable');

  const retried = (await store.insertRenderBatch(newRenderBatch(principal, spec, 'retry', cancelled))).record;
  assert.equal(retried.retryOf, batch.id);
  assert.equal(retried.rows[0]!.render.id, winner.id, 'successful row keeps its exact resource and receipt');
  assert.equal(retried.rows[1]!.render.retryOf, failure.id);
  assert.notEqual(retried.rows[1]!.render.id, failure.id);
  assert.equal((await store.listRenders(principal, 100, 0)).length, 5, 'only unsuccessful rows allocate new renders');
  assert.deepEqual(await store.getRenderBatch(batch.id, principal), cancelled, 'retry never rewrites the predecessor');
  assert.equal(batchProgress(retried).progress.succeeded, 1);
  assert.equal((await store.insertRenderBatch(newRenderBatch(principal, spec, 'retry', cancelled))).reused, true);
  const canonicalConflict = await store.insertRenderBatch({ ...newRenderBatch(principal, spec, 'same'), requestHash: 'changed' });
  assert.equal(canonicalConflict.record.requestHash, initial!.requestHash);
  assert.equal((await store.listRenders(principal, 100, 0)).length, 5);

  // One row finishes; the other is abandoned. Another worker recovers just that row.
  const first = (await store.claimRender(10_000))!;
  const abandoned = (await store.claimRender(40))!;
  await store.settleRender(first.id, first.leaseToken!, { state: 'succeeded', output });
  await delay(80);
  const recovered = (await store.claimRender(10_000))!;
  assert.equal(recovered.id, abandoned.id); assert.equal(recovered.attempt, 2);
  assert.equal(await store.settleRender(abandoned.id, abandoned.leaseToken!, { state: 'succeeded', output }), false);
  await store.settleRender(recovered.id, recovered.leaseToken!, { state: 'succeeded', output });
  assert.equal(await store.claimRender(100), null);
  const complete = (await store.getRenderBatch(retried.id, principal))!;
  assert.equal(batchProgress(complete).state, 'succeeded');
  assert.equal(complete.rows[0]!.render.attempt, 1, 'the previously successful row never re-executed');
  assert.throws(() => newRenderBatch(principal, spec, undefined, complete), RenderResourceError);
  const wire = JSON.stringify(batchWire(complete));
  assert.equal(wire.includes('leaseToken'), false); assert.equal(wire.includes('principal'), false);
  assert.equal(wire.includes('batch/winner'), false); assert.ok(wire.includes('/output/default'));
  assert.equal('rows' in batchWire(complete, true), false);
  assert.deepEqual(await store.getRenderBatch(batch.id, principal), cancelled);
  const page = await store.listRenderBatches(principal, 1, 0);
  assert.equal(page.length, 1);
  assert.notEqual(page[0]!.id, (await store.listRenderBatches(principal, 1, 1))[0]!.id);

  const raced = (await store.insertRenderBatch(newRenderBatch(principal, spec))).record;
  const raceClaims = await Promise.all(raced.rows.map(() => store.claimRender(10_000)));
  await Promise.all([store.cancelRenderBatch(raced.id, principal),
    ...raceClaims.map((r) => store.settleRender(r!.id, r!.leaseToken!, { state: 'succeeded', output }))]);
  const final = (await store.getRenderBatch(raced.id, principal))!;
  assert.equal(batchProgress(final).progress.done, 3);
  assert.ok(final.rows.every(({ render }) => render.state === 'cancelled' || render.state === 'succeeded'));
}

const hooked = parseRenderBatchSpec({ toolId: 'card', format: 'svg', callbackUrl: 'https://hooks.example/batches', rows: [{ key: 'one' }, { key: 'two' }] });

/** A batch owes one callback, stored by the call that finishes its last row. */
async function callbackConformance(store: RenderStore) {
  const principal = 'user:batch-callbacks';
  const batch = (await store.insertRenderBatch(newRenderBatch(principal, hooked))).record;
  assert.equal(batch.request.callbackUrl, 'https://hooks.example/batches');
  assert.ok(batch.rows.every(({ render }) => render.request.callbackUrl === undefined), 'rows stay silent');
  const [a, b] = [(await store.claimRender(10_000))!, (await store.claimRender(10_000))!];
  await store.settleRender(a.id, a.leaseToken!, { state: 'succeeded', output });
  assert.equal(await store.renderCallbackSummary(batch.id), null, 'one row is not the whole batch');
  assert.equal(await store.renderCallbackSummary(a.id), null, 'a row owes no callback of its own');
  await store.settleRender(b.id, b.leaseToken!, { state: 'failed', error: { code: 'BROKEN', message: 'no' } });
  const entry = (await store.renderCallbackSummary(batch.id))!;
  assert.equal(entry.state, 'pending');

  // Retrying makes a new parent with its own callback; the finished one keeps its entry.
  const finished = (await store.getRenderBatch(batch.id, principal))!;
  const retried = (await store.insertRenderBatch(newRenderBatch(principal, hooked, undefined, finished))).record;
  assert.equal(await store.renderCallbackSummary(retried.id), null);
  const retry = (await store.claimRender(10_000))!;
  await store.settleRender(retry.id, retry.leaseToken!, { state: 'succeeded', output });
  assert.ok(await store.renderCallbackSummary(retried.id));
  assert.deepEqual(await store.renderCallbackSummary(batch.id), entry);

  // A batch cancel that finishes the batch stores the entry too, and exactly once.
  const stopped = (await store.insertRenderBatch(newRenderBatch(principal, hooked))).record;
  await store.cancelRenderBatch(stopped.id, principal);
  const cancelled = (await store.renderCallbackSummary(stopped.id))!;
  await store.cancelRenderBatch(stopped.id, principal);
  assert.deepEqual(await store.renderCallbackSummary(stopped.id), cancelled);

  // The last two rows finishing at once must not each decide the other is still running.
  for (let round = 0; round < 12; round++) {
    const raced = (await store.insertRenderBatch(newRenderBatch(principal, hooked))).record;
    const claims = [(await store.claimRender(10_000))!, (await store.claimRender(10_000))!];
    await Promise.all(claims.map((claim) => store.settleRender(claim.id, claim.leaseToken!, { state: 'succeeded', output })));
    assert.ok(await store.renderCallbackSummary(raced.id), `round ${round}: the last row stored the callback`);
  }

  // A cancel racing the last row settles to one entry whichever wins.
  const contested = (await store.insertRenderBatch(newRenderBatch(principal, hooked))).record;
  const live = [(await store.claimRender(10_000))!, (await store.claimRender(10_000))!];
  await Promise.all([store.cancelRenderBatch(contested.id, principal),
    ...live.map((claim) => store.settleRender(claim.id, claim.leaseToken!, { state: 'succeeded', output }))]);
  assert.ok(await store.renderCallbackSummary(contested.id));

  // A row that ran out of attempts can be the one that finishes the batch.
  const fragile = parseRenderBatchSpec({ toolId: 'card', format: 'svg', maxAttempts: 1, callbackUrl: 'https://hooks.example/batches', rows: [{ key: 'one' }] });
  const lost = (await store.insertRenderBatch(newRenderBatch(principal, fragile))).record;
  await store.claimRender(30);
  await delay(60);
  assert.equal(await store.claimRender(1_000), null);
  assert.ok(await store.renderCallbackSummary(lost.id), 'an exhausted last row finishes the batch');
}

test('durable batch memory conformance: atomic children, cancellation, retry and row recovery', async () => conformance(createMemoryStore()));
test('durable batch Postgres conformance: atomic children, cancellation, retry and row recovery', {
  skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run',
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, conformance));

test('batch callback memory conformance: one entry, stored when the last row finishes', async () => callbackConformance(createMemoryStore()));
test('batch callback Postgres conformance: one entry, stored when the last row finishes', {
  skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run',
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, callbackConformance));

test('batch requests bound expansion, preserve row identity and reject ambiguous or unsafe input', () => {
  const valid = { toolId: 'card', format: 'svg', rows: [{ key: 'uk', inputs: { title: 'Hello' } }] };
  for (const value of [null, [], {}, { ...valid, rows: [] }, { ...valid, rows: Array(201).fill(valid.rows[0]) },
    { ...valid, rows: [...valid.rows, ...valid.rows] }, { ...valid, extra: true },
    ...['../uk', '', 'a'.repeat(81)].map((key) => ({ ...valid, rows: [{ key }] })),
    { ...valid, rows: [{ key: 'uk', toolId: 'other' }] }, { ...valid, rows: [{ key: 'uk', inputs: null }] },
    { ...valid, rows: [{ key: 'uk', inputs: JSON.parse('{"__proto__":{}}') }] },
    { ...valid, inputs: { title: 'a'.repeat(20_000) }, rows: Array.from({ length: 101 }, (_, n) => ({ key: String(n) })) },
  ]) assert.throws(() => parseRenderBatchSpec(value), RenderResourceError);
  const a = newRenderBatch('user:a', parseRenderBatchSpec(valid));
  const b = newRenderBatch('user:a', parseRenderBatchSpec({ rows: [{ inputs: { title: 'Hello' }, key: 'uk' }], format: 'SVG', toolId: 'card' }));
  assert.equal(a.requestHash, b.requestHash);
  assert.notEqual(a.requestHash, newRenderBatch('user:a', parseRenderBatchSpec({ ...valid, rows: [{ key: 'fr', inputs: { title: 'Hello' } }] })).requestHash);
  assert.throws(() => newRenderBatch('user:a', spec, ' '), RenderResourceError);
  assert.throws(() => newRenderBatch('user:a', spec, undefined, a), RenderResourceError);
});
