// SPDX-License-Identifier: MPL-2.0
/**
 * Durable callback outbox and per-attempt cleanup, over the memory store and,
 * when LW_TEST_DATABASE_URL names a disposable database, over Postgres:
 *
 *   LW_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres \
 *     node --test tests/automation-callback-outbox.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, randomUUID } from 'node:crypto';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { AutomationQueue, jobWire } from '../server/src/automation/jobs.ts';
import { CallbackOutbox } from '../server/src/automation/callback-outbox.ts';
import { DurableAutomationRunner, attemptResultRef } from '../server/src/automation/durable-runner.ts';
import { UNRECORDED_CALLBACK_ATTEMPT, type AutomationJobRecord, type Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const url = process.env.LW_TEST_DATABASE_URL;
const drivers: Array<{ name: string; skip: string | false; withStore: (body: (store: Store) => Promise<void>) => Promise<void> }> = [
  { name: 'memory', skip: false, withStore: body => body(createMemoryStore()) },
  { name: 'postgres', skip: !url && 'set LW_TEST_DATABASE_URL to run', withStore: body => withFreshPostgres(url!, body) },
];

const HOOK = 'https://hooks.example/lolly';
const SECRET = 'callback-test-secret';
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (done(value)) return value;
    if (Date.now() > deadline) throw new Error(`condition not met within ${timeoutMs} ms: ${JSON.stringify(value)}`);
    await pause(10);
  }
}

interface Sent { headers: Record<string, string>; body: string; parsed: Record<string, unknown> }
/** A receiver that records each request and answers from a script. */
function receiver(script: Array<number | Error | (() => Promise<Response>)>) {
  const sent: Sent[] = [];
  const fetchImpl = (async (_url: string | URL | Request, init?: RequestInit) => {
    const body = String(init?.body);
    sent.push({ headers: init?.headers as Record<string, string>, body, parsed: JSON.parse(body) as Record<string, unknown> });
    const next = script.length > 1 ? script.shift()! : script[0]!;
    if (next instanceof Error) throw next;
    if (typeof next === 'function') return next();
    return new Response(null, { status: next });
  }) as typeof fetch;
  return { sent, fetchImpl };
}
const signed = (request: Sent): boolean =>
  request.headers['x-lolly-signature'] === `sha256=${createHmac('sha256', SECRET).update(`${request.headers['x-lolly-timestamp']}.${request.body}`).digest('hex')}`;
const settledJob = (overrides: Partial<AutomationJobRecord> = {}): AutomationJobRecord => {
  const at = new Date().toISOString();
  return { id: randomUUID(), principal: 'service:hooks', verb: 'render', request: {}, state: 'done', createdAt: at, updatedAt: at, finishedAt: at, callbackUrl: HOOK, priority: 0, attempt: 1, ...overrides };
};
const outboxFor = (store: Store, fetchImpl: typeof fetch, options: ConstructorParameters<typeof CallbackOutbox>[1] = {}) =>
  new CallbackOutbox(store, { fetchImpl, secret: SECRET, allowed: candidate => candidate === HOOK, retryDelaysMs: [0, 0], ...options });
const callbackOf = async (store: Store, job: AutomationJobRecord) => (await store.getAutomationJob(job.id, job.principal))?.callback;

for (const { name, skip, withStore } of drivers) {
  test(`${name}: a settled durable job's callback is acknowledged, never reported as delivered`, { skip }, () => withStore(async store => {
    const { sent, fetchImpl } = receiver([204]);
    const queue = new AutomationQueue({ store, blobs: createMemoryBlobStore(), fetchImpl, callbackSecret: SECRET, callbackAllowed: candidate => candidate === HOOK, resultUrl: job => `https://work.example/api/v1/jobs/${job.id}/result?token=t`, pollMs: 0 });
    try {
      queue.enableDurable({ render: async () => ({ mime: 'text/plain', bytes: new TextEncoder().encode('ok') }) });
      const { job } = await queue.create('service:hooks', 'render', { callbackUrl: HOOK }, async () => { throw new Error('the durable executor runs this verb'); });
      const done = await until(() => queue.get(job.id, 'service:hooks'), current => current?.callback?.state === 'acknowledged');
      assert.equal(sent.length, 1);
      const [request] = sent as [Sent];
      assert.ok(signed(request), 'the signature covers the timestamp and the body');
      assert.equal(request.headers['x-lolly-delivery-id'], done!.callback!.id, 'the idempotency key travels in the delivery id header');
      assert.deepEqual(request.parsed, { jobId: job.id, state: 'done', resultUrl: `https://work.example/api/v1/jobs/${job.id}/result?token=t`, resultToken: null, deliveryId: done!.callback!.id });
      assert.deepEqual(done!.callback, { id: done!.callback!.id, state: 'acknowledged', attempts: 1, lastOutcome: 'acknowledged', lastStatus: 204 });
      assert.equal(done!.callbackFailed, false);
      const wire = jobWire(done!);
      assert.deepEqual(wire.callback, done!.callback);
      assert.doesNotMatch(JSON.stringify(wire), /delivered/i, 'the job resource never claims delivery');
    } finally { queue.stop(); }
  }));

  test(`${name}: an in-process job's callback goes through the same outbox`, { skip }, () => withStore(async store => {
    const { sent, fetchImpl } = receiver([204]);
    const queue = new AutomationQueue({ store, blobs: createMemoryBlobStore(), fetchImpl, callbackSecret: SECRET, callbackAllowed: candidate => candidate === HOOK });
    try {
      const { job } = await queue.create('service:hooks', 'inspect', { callbackUrl: HOOK }, async () => ({ mime: 'application/json', bytes: new TextEncoder().encode('{}') }));
      const done = await until(() => queue.get(job.id, 'service:hooks'), current => current?.callback?.state === 'acknowledged');
      assert.equal(sent[0]?.headers['x-lolly-delivery-id'], done!.callback!.id);
      assert.equal(sent[0]?.parsed.resultUrl, `/api/v1/jobs/${job.id}/result`);
    } finally { queue.stop(); }
  }));

  test(`${name}: a refused attempt and an uncertain attempt are retried with the same id`, { skip }, () => withStore(async store => {
    const job = settledJob(); await store.putAutomationJob(job);
    const seenBetween: unknown[] = [];
    const { sent, fetchImpl } = receiver([
      503,
      async () => { seenBetween.push(await callbackOf(store, job)); throw new DOMException('The operation was aborted due to timeout', 'TimeoutError'); },
      async () => { seenBetween.push(await callbackOf(store, job)); return new Response('{}', { status: 200 }); },
    ]);
    const outbox = outboxFor(store, fetchImpl);
    try {
      await outbox.poll();
      const callback = await until(() => callbackOf(store, job), current => current?.state === 'acknowledged');
      assert.equal(sent.length, 3);
      assert.ok(sent.every(signed), 'every attempt is signed afresh');
      assert.deepEqual(new Set(sent.map(request => request.headers['x-lolly-delivery-id'])), new Set([callback!.id]), 'one idempotency key for every attempt');
      assert.deepEqual(new Set(sent.map(request => request.parsed.deliveryId)), new Set([callback!.id]));
      const [afterRefusal, afterTimeout] = seenBetween as [Record<string, unknown>, Record<string, unknown>];
      assert.deepEqual([afterRefusal.state, afterRefusal.lastOutcome, afterRefusal.lastStatus], ['pending', 'refused', 503]);
      assert.deepEqual([afterTimeout.state, afterTimeout.lastOutcome, afterTimeout.lastStatus], ['pending', 'uncertain', undefined], 'a timeout may have reached the receiver');
      assert.deepEqual(callback, { id: callback!.id, state: 'acknowledged', attempts: 3, lastOutcome: 'acknowledged', lastStatus: 200 });
    } finally { outbox.stop(); }
  }));

  test(`${name}: a callback still unanswered when its sender stops is replayed after a restart`, { skip }, () => withStore(async store => {
    const job = settledJob(); await store.putAutomationJob(job);
    // The first process sends the request and stops before it hears back. Its
    // fetch never settles, the way a killed process never records the answer.
    let answerLate!: (response: Response) => void;
    const stopped = receiver([() => new Promise<Response>(resolve => { answerLate = resolve; })]);
    const first = outboxFor(store, stopped.fetchImpl, { timeoutMs: 100, leaseMs: 1 });
    await first.poll();
    await until(async () => stopped.sent.length, count => count === 1);
    first.stop();
    // The restarted process boots while the dead sender's lease is still held,
    // so it waits for that lease to expire and then sends again.
    const { sent, fetchImpl } = receiver([204]);
    const restarted = new AutomationQueue({ store, blobs: createMemoryBlobStore(), fetchImpl, callbackSecret: SECRET, callbackAllowed: candidate => candidate === HOOK, pollMs: 0 });
    try {
      restarted.enableDurable({ render: async () => ({ mime: 'text/plain', bytes: new Uint8Array() }) });
      const callback = await until(() => callbackOf(store, job), current => current?.state === 'acknowledged');
      assert.equal(sent.length, 1);
      assert.equal(sent[0]!.headers['x-lolly-delivery-id'], stopped.sent[0]!.headers['x-lolly-delivery-id'], 'the replay reuses the first attempt\'s id');
      assert.equal(sent[0]!.parsed.deliveryId, callback!.id);
      assert.ok(signed(sent[0]!));
      assert.equal(callback!.attempts, 2);
      // The stopped sender's answer arrives after the replay: it cannot record.
      answerLate(new Response(null, { status: 500 }));
      await pause(30);
      assert.equal((await callbackOf(store, job))?.state, 'acknowledged');
    } finally { restarted.stop(); }
  }));

  test(`${name}: a replay claimed before the answer is recorded keeps the uncertain outcome`, { skip }, () => withStore(async store => {
    const job = settledJob(); await store.putAutomationJob(job);
    const lost = await store.claimAutomationCallback('stopped-process', 1);
    assert.ok(lost);
    await pause(25);
    const replay = await store.claimAutomationCallback('restarted-process', 60_000);
    assert.deepEqual([replay?.id, replay?.attempt, replay?.lastOutcome, replay?.lastError], [lost.id, 2, 'uncertain', UNRECORDED_CALLBACK_ATTEMPT]);
  }));

  test(`${name}: a callback stops at its attempt limit and fails honestly`, { skip }, () => withStore(async store => {
    const job = settledJob(); await store.putAutomationJob(job);
    const { sent, fetchImpl } = receiver([500]);
    const outbox = outboxFor(store, fetchImpl);
    try {
      await outbox.poll();
      const callback = await until(() => callbackOf(store, job), current => current?.state === 'failed');
      assert.equal(sent.length, 3, 'two retries after the first attempt');
      assert.deepEqual(callback, { id: callback!.id, state: 'failed', attempts: 3, lastOutcome: 'refused', lastStatus: 500 });
      assert.equal((await store.getAutomationJob(job.id, job.principal))?.callbackFailed, true);
      await outbox.poll(); await pause(20);
      assert.equal(sent.length, 3, 'a failed callback is never sent again');
    } finally { outbox.stop(); }
  }));

  test(`${name}: an unapproved callback URL is never sent`, { skip }, () => withStore(async store => {
    const { sent, fetchImpl } = receiver([204]);
    const job = settledJob({ callbackUrl: 'https://elsewhere.example/hook' }); await store.putAutomationJob(job);
    const outbox = outboxFor(store, fetchImpl);
    try {
      await outbox.poll();
      const callback = await until(() => callbackOf(store, job), current => current?.state === 'failed');
      assert.deepEqual(callback, { id: callback!.id, state: 'failed', attempts: 1, lastOutcome: 'not-sent' });
      assert.equal(sent.length, 0);
    } finally { outbox.stop(); }
  }));

  test(`${name}: without a signing secret nothing is sent`, { skip }, () => withStore(async store => {
    const { sent, fetchImpl } = receiver([204]);
    const job = settledJob(); await store.putAutomationJob(job);
    const outbox = new CallbackOutbox(store, { fetchImpl, allowed: () => true });
    try {
      await outbox.poll();
      assert.equal((await until(() => callbackOf(store, job), current => current?.state === 'failed'))?.lastOutcome, 'not-sent');
      assert.equal(sent.length, 0);
    } finally { outbox.stop(); }
  }));

  test(`${name}: deleting a job before its callback is sent removes the callback`, { skip }, () => withStore(async store => {
    const { sent, fetchImpl } = receiver([204]);
    const job = settledJob(); await store.putAutomationJob(job);
    assert.equal(await store.deleteAutomationJob(job.id, job.principal), true);
    const outbox = outboxFor(store, fetchImpl);
    try {
      await outbox.poll(); await pause(20);
      assert.equal(await store.nextAutomationCallbackAt(), null, 'the deleted job took its entry with it');
      assert.equal(sent.length, 0);
    } finally { outbox.stop(); }
  }));

  test(`${name}: a recovered attempt removes the bytes an earlier attempt left behind`, { skip }, () => withStore(async store => {
    const blobs = createMemoryBlobStore();
    const queued = (request: Record<string, unknown> = {}): AutomationJobRecord => settledJob({ verb: 'convert', state: 'queued', attempt: 0, request, callbackUrl: undefined, finishedAt: undefined });
    // A worker claims, stores its bytes at its own attempt path, and dies before its save.
    const crashedAfterStore = async (job: AutomationJobRecord): Promise<string> => {
      await store.putAutomationJob(job);
      const dead = await store.claimAutomationJob('dead-worker', ['convert'], 1);
      assert.equal(dead?.leaseToken, 1);
      const orphan = attemptResultRef(job.id, 1);
      await blobs.put(orphan, new TextEncoder().encode('never published'), 'text/plain');
      await pause(25);
      return orphan;
    };
    let fail = false;
    const runner = new DurableAutomationRunner(store, blobs, { convert: async () => { if (fail) throw new Error('codec failed'); return { mime: 'text/plain', bytes: new TextEncoder().encode('published') }; } });
    try {
      const recovered = queued(); const orphan = await crashedAfterStore(recovered);
      await runner.poll();
      const done = await until(() => store.getAutomationJob(recovered.id, recovered.principal), current => current?.state === 'done');
      assert.equal(done!.resultRef, attemptResultRef(recovered.id, 2));
      assert.ok(await blobs.get(done!.resultRef!), 'the published attempt keeps its bytes');
      assert.equal(await blobs.get(orphan), null, 'the crashed attempt\'s bytes are removed');

      fail = true;
      const failing = queued({ jobRetries: 0 }); const failedOrphan = await crashedAfterStore(failing);
      await runner.poll();
      await until(() => store.getAutomationJob(failing.id, failing.principal), current => current?.state === 'failed');
      assert.equal(await blobs.get(failedOrphan), null, 'a final failure also removes earlier attempts\' bytes');
    } finally { runner.stop(); }

    // Removing a job removes every attempt path it may hold.
    const queue = new AutomationQueue({ store, blobs });
    const removed = queued(); const removedOrphan = await crashedAfterStore(removed);
    assert.equal(await queue.remove(removed.id, removed.principal), true);
    assert.equal(await blobs.get(removedOrphan), null);
    queue.stop();
  }));
}
