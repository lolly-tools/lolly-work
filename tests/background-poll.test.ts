// SPDX-License-Identifier: MPL-2.0
/**
 * LW_BACKGROUND_POLL_MS (server/src/main.ts → AppDeps.backgroundPollMs): the
 * durable render and automation runners can run without a timer, so a
 * long-lived host leaves a database that scales to zero (Neon) asleep while
 * nobody works. Work must still run: at start, on submission, after each
 * finished item (a backlog drains) and, for a render, after a retry delay.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import { RenderRunner, parseBackgroundPollMs, type RenderRunner as Runner } from '../server/src/renders/runner.ts';
import { RenderResourceError } from '../server/src/renders/types.ts';
import { AutomationQueue } from '../server/src/automation/jobs.ts';
import type { AutomationJobRecord } from '../server/src/store/types.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';

const spec = parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Hello' } });
const output = { bytes: Buffer.from('<svg/>'), mime: 'image/svg+xml', cacheKey: 'k' };
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate: () => Promise<boolean>, what: string): Promise<void> {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await delay(10); }
  assert.fail(`timed out waiting for ${what}`);
}

test('LW_BACKGROUND_POLL_MS: unset keeps the default, 0 means no timer, nonsense is refused', () => {
  assert.equal(parseBackgroundPollMs(undefined), undefined);
  assert.equal(parseBackgroundPollMs(' '), undefined);
  assert.equal(parseBackgroundPollMs('0'), 0);
  assert.equal(parseBackgroundPollMs('300000'), 300_000);
  assert.equal(parseBackgroundPollMs('2147483647'), 2_147_483_647);
  // Above this a Node timer fires at once, the opposite of what was asked.
  for (const bad of ['-1', '1.5', 'often', '2147483648', '1e12']) assert.throws(() => parseBackgroundPollMs(bad), /LW_BACKGROUND_POLL_MS/, bad);
});

test('a render runner without a timer runs a backlog, then waits for a kick', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const a = (await store.insertRender(newRender('user:a', spec))).record;
  const b = (await store.insertRender(newRender('user:b', spec))).record;
  let executed = 0;
  const runner = new RenderRunner({ store, blobs, concurrency: 1, pollMs: 0, execute: async () => { executed++; return output; } });
  t.after(() => runner.stop());
  runner.start();
  // Concurrency 1: the second request is claimed when the first finishes, not by a timer.
  await until(async () => (await store.getRender(a.id, a.principal))?.state === 'succeeded'
    && (await store.getRender(b.id, b.principal))?.state === 'succeeded', 'the backlog');
  assert.equal(executed, 2);

  // Written straight to the store, as another replica would: nothing polls for it.
  const c = (await store.insertRender(newRender('user:c', spec))).record;
  await delay(150);
  assert.equal((await store.getRender(c.id, c.principal))?.state, 'queued', 'no timer claimed it');
  runner.kick(); // what a submission does (renders/routes.ts kick)
  await until(async () => (await store.getRender(c.id, c.principal))?.state === 'succeeded', 'the kicked render');
});

test('a render runner without a timer still retries a transient failure once its delay passes', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const r = (await store.insertRender(newRender('user:a', { ...spec, maxAttempts: 2 }))).record;
  let attempts = 0;
  const runner = new RenderRunner({ store, blobs, pollMs: 0, retryDelayMs: 20, execute: async () => {
    attempts++;
    if (attempts === 1) throw new RenderResourceError('WORKER_BUSY', 503, 'try again');
    return output;
  } });
  t.after(() => runner.stop());
  runner.start();
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded', 'the retry');
  assert.equal(attempts, 2);
});

test('a durable automation queue without a timer runs on submission and drains its backlog', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const queue = new AutomationQueue({ store, blobs, maxConcurrent: 1, pollMs: 0 });
  t.after(() => queue.stop());
  const ran: string[] = [];
  queue.enableDurable({ inspect: async (job) => { ran.push(job.id); await delay(5); return { mime: 'application/json', bytes: new TextEncoder().encode('{}') }; } });

  // Written straight to the store: no submission, no timer, so it waits.
  const now = new Date().toISOString();
  const parked: AutomationJobRecord = { id: 'job-parked', principal: 'user:a', verb: 'inspect', request: {}, state: 'queued', createdAt: now, updatedAt: now, priority: 0, attempt: 0 };
  await store.putAutomationJob(parked);
  await delay(150);
  assert.equal((await queue.get('job-parked', 'user:a'))?.state, 'queued', 'no timer claimed it');

  // A submission looks for work; with one slot, the rest follows each finished job.
  const first = await queue.create('user:a', 'inspect', { n: 1 }, async () => { throw new Error('durable verbs never use this'); });
  const second = await queue.create('user:a', 'inspect', { n: 2 }, async () => { throw new Error('durable verbs never use this'); });
  for (const id of ['job-parked', first.job.id, second.job.id]) {
    await until(async () => (await queue.get(id, 'user:a'))?.state === 'done', `job ${id}`);
  }
  assert.equal(ran.length, 3);
});

test('a durable automation queue without a timer retries a requeued job and runs the one behind it', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const queue = new AutomationQueue({ store, blobs, maxConcurrent: 1, pollMs: 0 });
  t.after(() => queue.stop());
  let executions = 0;
  queue.enableDurable({ inspect: async (job) => {
    executions++;
    await delay(5);
    if (job.request.flaky && job.attempt === 1) throw new Error('transient');
    return { mime: 'application/json', bytes: new TextEncoder().encode('{}') };
  } });
  // The first attempt fails and is requeued (no onComplete): its freed slot
  // must still look for work, or both jobs wait for the next submission.
  const flaky = await queue.create('user:a', 'inspect', { flaky: true, jobRetries: 1 }, async () => { throw new Error('unused'); });
  const next = await queue.create('user:a', 'inspect', { n: 2 }, async () => { throw new Error('unused'); });
  for (const id of [flaky.job.id, next.job.id]) {
    await until(async () => (await queue.get(id, 'user:a'))?.state === 'done', `job ${id}`);
  }
  assert.equal(executions, 3);
});

// Postgres takes a claim's snapshot when the statement starts: a request that
// commits while that claim is in flight is invisible to it. The stand-in claim
// reads the store at once and answers one round trip later.
const slowClaims = <S extends { claimRender: (...a: any[]) => Promise<any>; claimAutomationJob: (...a: any[]) => Promise<any> }>(store: S): S => {
  const claimRender = store.claimRender.bind(store);
  store.claimRender = async (...args: any[]) => { const r = await claimRender(...args); await delay(40); return r; };
  const claimJob = store.claimAutomationJob.bind(store);
  store.claimAutomationJob = async (...args: any[]) => { const r = await claimJob(...args); await delay(40); return r; };
  return store;
};

test('a render runner without a timer keeps a kick that lands while a claim is in flight', async (t) => {
  const store = slowClaims(createMemoryStore()); const blobs = createMemoryBlobStore();
  const runner = new RenderRunner({ store, blobs, pollMs: 0, execute: async () => output });
  t.after(() => runner.stop());
  runner.start(); // its claim sees an empty queue
  await delay(10);
  const r = (await store.insertRender(newRender('user:a', spec))).record;
  runner.kick(); // the submission's kick, while the first claim is still out
  await until(async () => (await store.getRender(r.id, r.principal))?.state === 'succeeded', 'the render submitted mid-claim');
});

test('a durable automation queue without a timer keeps a submission that lands while a claim is in flight', async (t) => {
  const store = slowClaims(createMemoryStore()); const blobs = createMemoryBlobStore();
  const queue = new AutomationQueue({ store, blobs, pollMs: 0 });
  t.after(() => queue.stop());
  queue.enableDurable({ inspect: async () => ({ mime: 'application/json', bytes: new TextEncoder().encode('{}') }) });
  await delay(10); // enableDurable's first claim is still out
  const { job } = await queue.create('user:a', 'inspect', { n: 1 }, async () => { throw new Error('unused'); });
  await until(async () => (await queue.get(job.id, 'user:a'))?.state === 'done', 'the job submitted mid-claim');
});

test('buildApp hands backgroundPollMs to both runners', async (t) => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-poll-'));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Poll', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false }, dev: { enabled: true, users: [] } }));
  const claims = async (backgroundPollMs: number | undefined, ms: number): Promise<{ renders: number; jobs: number }> => {
    const store = createMemoryStore();
    const counts = { renders: 0, jobs: 0 };
    const claimRender = store.claimRender.bind(store);
    store.claimRender = async (leaseMs) => { counts.renders++; return claimRender(leaseMs); };
    const claimJob = store.claimAutomationJob.bind(store);
    store.claimAutomationJob = async (...args) => { counts.jobs++; return claimJob(...args); };
    let runner: Runner | undefined;
    buildApp({ config, store, secrets: { session: 's'.repeat(32), link: 'l'.repeat(32) }, blobs: createMemoryBlobStore(),
      onRenderRunner: (r) => { runner = r; }, ...(backgroundPollMs !== undefined ? { backgroundPollMs } : {}) });
    runner!.start();
    t.after(() => runner?.stop());
    await delay(ms);
    return counts;
  };
  const off = await claims(0, 300);
  assert.deepEqual(off, { renders: 1, jobs: 1 }, 'one look each at start, then quiet');
  const often = await claims(40, 300);
  assert.ok(often.renders >= 4 && often.jobs >= 4, `a 40 ms poll looks again and again (${JSON.stringify(often)})`);
});
