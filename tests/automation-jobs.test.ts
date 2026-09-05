// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { AutomationQueue, jobWire } from '../server/src/automation/jobs.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

const settle = async () => { for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 1)); };

test('automation jobs are isolated by principal and retain result bytes', async () => {
  const queue = new AutomationQueue({ store: createMemoryStore(), blobs: createMemoryBlobStore() });
  const { job } = await queue.create('user:a', 'compile', { toolId: 'card' }, async () => ({ mime: 'application/json', bytes: new TextEncoder().encode('{"ok":true}') }));
  assert.ok(job.state === 'queued' || job.state === 'running');
  assert.equal(await queue.get(job.id, 'user:b'), null);
  await settle();
  assert.equal((await queue.get(job.id, 'user:a'))?.state, 'done');
  assert.equal(new TextDecoder().decode((await queue.result(job.id, 'user:a'))?.bytes), '{"ok":true}');
  assert.equal(jobWire((await queue.get(job.id, 'user:a'))!).resultUrl, `/api/v1/jobs/${job.id}/result`);
});

test('callbacks fail closed unless their exact URL is instance-approved', async () => {
  let calls = 0;
  const queue = new AutomationQueue({ store: createMemoryStore(), blobs: createMemoryBlobStore(), callbackSecret: 'secret', callbackAllowed: () => false, fetchImpl: async () => { calls++; return new Response(null, { status: 204 }); } });
  const { job } = await queue.create('service:ci', 'render', { callbackUrl: 'https://untrusted.test/hook' }, async () => ({ mime: 'image/svg+xml', bytes: new Uint8Array() }));
  await settle();
  assert.equal(calls, 0);
  assert.equal((await queue.get(job.id, 'service:ci'))?.callbackFailed, true);
});

test('idempotency returns one durable job and conflicts on changed requests', async () => {
  const queue = new AutomationQueue({ store: createMemoryStore(), blobs: createMemoryBlobStore() });
  const run = async () => ({ mime: 'text/plain', bytes: new TextEncoder().encode('ok') });
  const first = await queue.create('user:a', 'render', { toolId: 'a' }, run, 'same');
  const second = await queue.create('user:a', 'render', { toolId: 'a' }, run, 'same');
  assert.equal(second.reused, true); assert.equal(second.job.id, first.job.id);
  await assert.rejects(() => queue.create('user:a', 'render', { toolId: 'b' }, run, 'same'), /IDEMPOTENCY_KEY_REUSED/);
});

test('the queue bounds concurrency, retries jobs, and can remove queued work', async () => {
  const queue = new AutomationQueue({ store: createMemoryStore(), blobs: createMemoryBlobStore(), maxConcurrent: 1 });
  let release!: () => void; let secondRan = false;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const first = await queue.create('user:a', 'render', {}, async () => { await gate; return { mime: 'text/plain', bytes: new Uint8Array() }; });
  const second = await queue.create('user:a', 'render', { priority: 9 }, async () => { secondRan = true; return { mime: 'text/plain', bytes: new Uint8Array() }; });
  assert.equal(await queue.remove(second.job.id, 'user:a'), true);
  release(); await settle();
  assert.equal(secondRan, false);
  assert.equal((await queue.get(first.job.id, 'user:a'))?.state, 'done');

  let attempts = 0;
  const retried = await queue.create('user:a', 'render', { jobRetries: 2 }, async () => {
    attempts++;
    if (attempts < 2) throw new Error('transient');
    return { mime: 'text/plain', bytes: new TextEncoder().encode('ok') };
  });
  await settle();
  assert.equal((await queue.get(retried.job.id, 'user:a'))?.state, 'done');
  assert.equal((await queue.get(retried.job.id, 'user:a'))?.attempt, 2);
});
