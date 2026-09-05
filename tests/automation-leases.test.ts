// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { DurableAutomationRunner } from '../server/src/automation/durable-runner.ts';
import type { AutomationJobRecord } from '../server/src/store/types.ts';
import { AutomationQueue } from '../server/src/automation/jobs.ts';
import { readBlobBody } from '../server/src/blobs/types.ts';
const pause = (ms = 20) => new Promise(resolve => setTimeout(resolve, ms));
const job = (): AutomationJobRecord => ({ id: randomUUID(), principal: 'user:a', verb: 'convert', request: { jobRetries: 1 }, state: 'queued', createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(), priority: 0, attempt: 0 });
test('concurrent idempotency submissions resolve to one job', async () => {
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  const a = new AutomationQueue({ store, blobs }), b = new AutomationQueue({ store, blobs });
  const run = async () => ({ mime: 'text/plain', bytes: new Uint8Array([1]) });
  const replies = await Promise.all([a.create('user:a', 'convert', {}, run, 'same'), b.create('user:a', 'convert', {}, run, 'same')]);
  assert.equal(replies[0]!.job.id, replies[1]!.job.id); assert.equal((await store.listAutomationJobs('user:a')).length, 1);
});
test('bounded blob reads cancel their source and release its lock', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ pull(controller) { controller.enqueue(new Uint8Array(8)); }, cancel() { cancelled = true; } });
  await assert.rejects(readBlobBody(stream, 4), /byte limit/);
  assert.equal(cancelled, true); assert.equal(stream.locked, false);
});
test('claims are atomic across runners; expired claims fence stale publication', async () => {
  const store = createMemoryStore(); const original = job(); await store.putAutomationJob(original);
  const [first, second] = await Promise.all([store.claimAutomationJob('a', ['convert'], 30), store.claimAutomationJob('b', ['convert'], 30)]);
  assert.ok(first); assert.equal(second, null);
  await pause(40);
  const recovered = await store.claimAutomationJob('b', ['convert'], 1000); assert.ok(recovered);
  assert.equal(recovered.leaseToken, 2); assert.equal(recovered.attempt, 2);
  assert.equal(await store.saveClaimedAutomationJob({ ...first, state: 'done' }), false);
  assert.equal(await store.renewAutomationJob(first, 1000), false);
  assert.equal(await store.saveClaimedAutomationJob({ ...recovered, state: 'done' }), true);
});
test('a new runner executes stored requests without process-local closures', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore(); const original = job(); await store.putAutomationJob(original);
  const runner = new DurableAutomationRunner(store, blobs, { convert: async record => ({ mime: 'text/plain', bytes: new TextEncoder().encode(record.principal) }) });
  try {
    await runner.poll(); await pause();
    const done = await store.getAutomationJob(original.id, original.principal);
    assert.equal(done?.state, 'done'); assert.match(done!.resultRef!, /attempt-1/); assert.equal(done!.resultSha256?.length, 64);
  } finally { runner.stop(); }
});
test('a renderer returning after cancellation cannot publish or revive a deleted job', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore(); const original = job(); await store.putAutomationJob(original);
  let release!: () => void; const gate = new Promise<void>(resolve => { release = resolve; });
  const runner = new DurableAutomationRunner(store, blobs, { convert: async () => { await gate; return { mime: 'text/plain', bytes: new Uint8Array([1]) }; } });
  await runner.poll(); await store.deleteAutomationJob(original.id, original.principal); release(); await pause(); runner.stop();
  assert.equal(await store.getAutomationJob(original.id, original.principal), null);
  assert.equal(await blobs.get(`automation/${original.id}/attempt-1/result`), null);
});
