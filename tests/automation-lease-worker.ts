// SPDX-License-Identifier: MPL-2.0
/**
 * One automation worker process for tests/automation-leases-process.test.ts.
 *
 * It runs the production DurableAutomationRunner over a real Postgres store and
 * a real S3 blob store. Only the executor is a stand-in. The store and blob store
 * are wrapped so every claim, heartbeat, fenced save, put and delete is reported
 * to the parent over IPC, which is how the test sees what each process did.
 *
 * LEASE_WORKER_MODE picks what the executor does once it has a job:
 *   run    return at once (after LEASE_WORKER_DELAY_MS, default 0)
 *   hold   wait for a { type: 'release' } message, ignoring cancellation, like a
 *          renderer that never checks its signal
 *   block  block the event loop for LEASE_WORKER_BLOCK_MS, like a synchronous
 *          rasteriser or a long pause. No heartbeat can run meanwhile.
 * LEASE_WORKER_RENEW_DELAY_MS delays each heartbeat before it reaches the
 * database, like a congested link, so a stale worker can reach its save.
 *
 * The runner polls only after a { type: 'go' } message, so the parent can start
 * several processes and let them race from the same moment.
 */
import { createHash } from 'node:crypto';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { createS3BlobStore } from '../server/src/blobs/s3.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import { DurableAutomationRunner, type DurableExecutor } from '../server/src/automation/durable-runner.ts';
import type { AutomationJobRecord } from '../server/src/store/types.ts';

const env = (name: string): string => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is required`);
  return value;
};
const name = env('LEASE_WORKER_NAME');
const verb = env('LEASE_WORKER_VERB');
const mode = env('LEASE_WORKER_MODE');
const leaseMs = Number(env('LEASE_WORKER_LEASE_MS'));
const concurrency = Number(process.env.LEASE_WORKER_CONCURRENCY ?? 1);
const delayMs = Number(process.env.LEASE_WORKER_DELAY_MS ?? 0);
const blockMs = Number(process.env.LEASE_WORKER_BLOCK_MS ?? 0);
const renewDelayMs = Number(process.env.LEASE_WORKER_RENEW_DELAY_MS ?? 0);
const send = (message: Record<string, unknown>): void => { process.send?.({ worker: name, pid: process.pid, at: Date.now(), ...message }); };

const store = await createPostgresStore(env('LW_TEST_DATABASE_URL'));
const s3 = createS3BlobStore(JSON.parse(env('LEASE_WORKER_S3')) as Parameters<typeof createS3BlobStore>[0], env('LW_TEST_S3_CREDENTIAL'));
const blobs: BlobStore = {
  async put(ref, body, mime, declared) {
    const stat = await s3.put(ref, body, mime, declared);
    send({ type: 'put', ref, sha256: stat.checksum });
    return stat;
  },
  head: ref => s3.head(ref),
  get: ref => s3.get(ref),
  async delete(ref) { await s3.delete(ref); send({ type: 'delete', ref }); },
};
const fenced = {
  async claimAutomationJob(owner: string, verbs: string[], ms: number) {
    const job = await store.claimAutomationJob(owner, verbs, ms);
    if (job) send({ type: 'claim', jobId: job.id, attempt: job.attempt, leaseToken: job.leaseToken, leaseOwner: job.leaseOwner, leaseUntil: job.leaseUntil });
    return job;
  },
  async renewAutomationJob(job: AutomationJobRecord, ms: number) {
    if (renewDelayMs > 0) await new Promise(resolve => setTimeout(resolve, renewDelayMs));
    const ok = await store.renewAutomationJob(job, ms);
    send({ type: 'renew', jobId: job.id, leaseToken: job.leaseToken, ok });
    return ok;
  },
  async saveClaimedAutomationJob(job: AutomationJobRecord) {
    const ok = await store.saveClaimedAutomationJob(job);
    send({ type: 'save', jobId: job.id, leaseToken: job.leaseToken, state: job.state, resultRef: job.resultRef ?? null, error: job.error ?? null, ok });
    return ok;
  },
};

let released = false;
const waiting = new Set<() => void>();
const executor: DurableExecutor = async job => {
  send({ type: 'execute', jobId: job.id, attempt: job.attempt, leaseToken: job.leaseToken });
  if (mode === 'hold' && !released) await new Promise<void>(resolve => waiting.add(resolve));
  if (mode === 'block') {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, blockMs);
    send({ type: 'unblocked', jobId: job.id });
  }
  if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));
  // Deterministic and named, so the parent can say whose bytes were published.
  const text = `${name} ${job.id} attempt ${job.attempt}\n`;
  const bytes = new TextEncoder().encode(text);
  send({ type: 'output', jobId: job.id, attempt: job.attempt, text, sha256: createHash('sha256').update(bytes).digest('hex') });
  return { mime: 'text/plain', bytes };
};

const runner = new DurableAutomationRunner(fenced, blobs, { [verb]: executor }, { leaseMs, concurrency, onSettled: () => { send({ type: 'settled' }); void runner.poll(); } });
let timer: ReturnType<typeof setInterval> | undefined;
process.on('message', (message: { type: string }) => {
  if (message.type === 'go') {
    void runner.poll();
    timer = setInterval(() => { void runner.poll(); }, 100);
  } else if (message.type === 'release') {
    released = true;
    for (const resolve of waiting) resolve();
    waiting.clear();
  } else if (message.type === 'stop') {
    clearInterval(timer); runner.stop();
    void store.close().finally(() => process.exit(0));
  }
});
// A parent that went away must not leave a worker holding leases.
process.on('disconnect', () => process.exit(0));
send({ type: 'ready' });
