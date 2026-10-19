// SPDX-License-Identifier: MPL-2.0
/**
 * Process-level acceptance for durable automation leases. Separate worker
 * processes (tests/automation-lease-worker.ts) share one Postgres database and
 * one S3-compatible bucket, the way replicas share them in production:
 *
 *   1. A worker killed with SIGKILL after its claim is recovered by another
 *      process once its lease expires. Only the recovered attempt publishes.
 *   2. Two processes race to publish one job: the first one's event loop stalls
 *      past its lease, the second claims the job, and both finish together.
 *      Exactly one output is published and the stale attempt's bytes are removed.
 *      This runs twice: as it usually happens, where the stale worker's heartbeat
 *      cancels it, and with a slow heartbeat, where the fenced save must refuse it.
 *   3. Two processes started together over one queue run every job once.
 *   4. A job whose workers keep dying stops at its recovery budget instead of
 *      being claimed again and again.
 *
 * Gated: needs a disposable Postgres and a disposable S3-compatible store
 * (CI runs MinIO as a service container). For example:
 *   docker run --rm -e POSTGRES_PASSWORD=t -p 55432:5432 postgres:17-alpine
 *   docker run --rm -e MINIO_ROOT_USER=lollywork -e MINIO_ROOT_PASSWORD=lollywork-test-only \
 *     -p 9000:9000 bitnamilegacy/minio:2025.7.23
 *   LW_TEST_DATABASE_URL=postgres://postgres:t@127.0.0.1:55432/postgres \
 *   LW_TEST_S3_ENDPOINT=http://127.0.0.1:9000 \
 *   LW_TEST_S3_CREDENTIAL=lollywork:lollywork-test-only \
 *     node --test tests/automation-leases-process.test.ts
 * LW_TEST_S3_BUCKET (default lolly-work-test) is created when missing. Each run
 * writes under its own random prefix and deletes what it wrote.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { fork, type ChildProcess } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { createHash, randomUUID } from 'node:crypto';
import { withFreshPostgres } from './pg-test-schema.ts';
import { createS3BlobStore } from '../server/src/blobs/s3.ts';
import { readBlobBody } from '../server/src/blobs/types.ts';
import { signS3Request, type S3Options } from '../server/src/catalog/providers/s3.ts';
import type { AutomationJobRecord } from '../server/src/store/types.ts';

const url = process.env.LW_TEST_DATABASE_URL;
const endpoint = process.env.LW_TEST_S3_ENDPOINT;
const credential = process.env.LW_TEST_S3_CREDENTIAL ?? '';
const skip = !url ? 'set LW_TEST_DATABASE_URL to run'
  : !endpoint || !credential.includes(':') ? 'set LW_TEST_S3_ENDPOINT and LW_TEST_S3_CREDENTIAL (<accessKeyId>:<secretAccessKey>) to run'
  : false;
const s3Options: S3Options = { bucket: process.env.LW_TEST_S3_BUCKET ?? 'lolly-work-test', region: process.env.LW_TEST_S3_REGION ?? 'us-east-1', ...(endpoint ? { endpoint } : {}) };
const s3Keys = { accessKeyId: credential.slice(0, credential.indexOf(':')), secretAccessKey: credential.slice(credential.indexOf(':') + 1) };
/** Short enough to wait out, long enough that a healthy worker's heartbeat
 *  (every third of it) does not lose a lease on a busy CI runner. */
const LEASE_MS = 3000;
const PRINCIPAL = 'service:lease-acceptance';
const WORKER = new URL('./automation-lease-worker.ts', import.meta.url);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

const s3 = (method: string, key?: string, query?: Record<string, string>): Promise<Response> => {
  const signed = signS3Request({ options: s3Options, ...s3Keys, method, ...(key ? { key } : {}), ...(query ? { query } : {}) });
  return fetch(signed.url, { method, headers: signed.headers, redirect: 'error' });
};
/** Wait for the store to answer, then make sure the bucket exists. */
async function ensureBucket(): Promise<void> {
  let last: unknown;
  for (let i = 0; i < 120; i++) {
    try {
      const head = await s3('HEAD');
      if (head.ok) return;
      if (head.status === 404) {
        const made = await s3('PUT'); const body = await made.text();
        if (made.ok || /BucketAlreadyOwnedByYou/.test(body)) return;
        last = new Error(`bucket create answered ${made.status}: ${body}`);
      } else last = new Error(`bucket check answered ${head.status}`);
    } catch (error) { last = error; } // still starting
    await pause(500);
  }
  throw last;
}
async function listKeys(prefix: string): Promise<string[]> {
  const res = await s3('GET', undefined, { 'list-type': '2', prefix });
  const body = await res.text();
  assert.equal(res.status, 200, body);
  assert.doesNotMatch(body, /<IsTruncated>true</, 'one page holds every key this test writes');
  return [...body.matchAll(/<Key>([^<]+)<\/Key>/g)].map(match => match[1]!).sort();
}
async function removePrefix(prefix: string): Promise<void> {
  for (const key of await listKeys(prefix)) await (await s3('DELETE', key)).body?.cancel();
}

interface Message {
  worker: string; pid: number; at: number; type: string;
  jobId?: string; attempt?: number; leaseToken?: number; leaseOwner?: string; leaseUntil?: string;
  ok?: boolean; state?: string; resultRef?: string | null; error?: string | null; ref?: string; sha256?: string; text?: string;
}

/** One worker process and everything it has reported so far. */
class LeaseWorker {
  readonly name: string;
  readonly messages: Message[] = [];
  readonly exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  private readonly child: ChildProcess;
  private readonly changes = new EventEmitter();
  private log = '';
  constructor(name: string, env: Record<string, string>) {
    this.name = name;
    this.child = fork(WORKER, [], { execArgv: [], env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
    this.child.stdout!.on('data', bytes => { this.log += bytes; });
    this.child.stderr!.on('data', bytes => { this.log += bytes; });
    this.child.on('message', message => { this.messages.push(message as Message); this.changes.emit('change'); });
    this.exited = new Promise(resolve => this.child.once('exit', (code, signal) => { resolve({ code, signal }); this.changes.emit('change'); }));
  }
  get running(): boolean { return this.child.exitCode === null && this.child.signalCode === null; }
  of(type: string, jobId?: string): Message[] { return this.messages.filter(m => m.type === type && (jobId === undefined || m.jobId === jobId)); }
  /** The first matching report, already received or still to come. */
  async waitFor(type: string, match: (m: Message) => boolean = () => true, timeoutMs = 60_000): Promise<Message> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = this.of(type).find(match);
      if (found) return found;
      if (!this.running) throw new Error(`worker ${this.name} exited before reporting ${type}\n${this.log}`);
      const left = deadline - Date.now();
      if (left <= 0) throw new Error(`worker ${this.name} did not report ${type} within ${timeoutMs} ms\n${this.log}`);
      await once(this.changes, 'change', { signal: AbortSignal.timeout(left) }).catch(() => {});
    }
  }
  send(type: 'go' | 'release'): void { this.child.send({ type }); }
  async kill(): Promise<void> {
    this.child.kill('SIGKILL');
    assert.equal((await this.exited).signal, 'SIGKILL');
  }
  async stop(): Promise<void> {
    if (!this.running) return;
    if (this.child.connected) this.child.send({ type: 'stop' });
    const force = setTimeout(() => this.child.kill('SIGKILL'), 5000);
    await this.exited; clearTimeout(force);
  }
}

test('automation leases hold across worker processes sharing Postgres and S3', { skip, timeout: 300_000 }, async t => {
  await ensureBucket();
  const run = `lease-acceptance/${randomUUID()}`;
  const workers: LeaseWorker[] = [];
  const start = async (name: string, verb: string, mode: 'run' | 'hold' | 'block', settings: Record<string, string> = {}): Promise<LeaseWorker> => {
    const worker = new LeaseWorker(name, {
      LEASE_WORKER_NAME: name, LEASE_WORKER_VERB: verb, LEASE_WORKER_MODE: mode, LEASE_WORKER_LEASE_MS: String(LEASE_MS),
      LEASE_WORKER_S3: JSON.stringify({ ...s3Options, prefix: `${run}/${verb}` }), ...settings,
    });
    workers.push(worker);
    await worker.waitFor('ready');
    return worker;
  };
  const stopAll = async (): Promise<void> => { await Promise.all(workers.splice(0).map(worker => worker.stop())); };

  await withFreshPostgres(url!, async store => {
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: url }); await db.connect();
    const queued = async (verb: string): Promise<AutomationJobRecord> => {
      const now = new Date().toISOString();
      const job: AutomationJobRecord = { id: randomUUID(), principal: PRINCIPAL, verb, request: { jobRetries: 0 }, state: 'queued', createdAt: now, updatedAt: now, priority: 0, attempt: 0 };
      await store.putAutomationJob(job); return job;
    };
    /** The lease as Postgres sees it, on Postgres's own clock. */
    const lease = async (id: string) => {
      const { rows } = await db.query('select state, lease_owner, lease_token, lease_until, lease_until > now() as held from automation_jobs where id=$1', [id]);
      const row = rows[0] as { state: string; lease_owner: string; lease_token: number; lease_until: Date; held: boolean };
      return { state: row.state, owner: row.lease_owner, token: row.lease_token, until: row.lease_until.getTime(), held: row.held };
    };
    /** The job finished on `attempt` from `winner`, and the bucket holds that one object. */
    const assertPublishedOnce = async (job: AutomationJobRecord, winner: LeaseWorker, attempt: number): Promise<void> => {
      const done = await store.getAutomationJob(job.id, job.principal);
      const ref = `automation/${job.id}/attempt-${attempt}/result`;
      const output = winner.of('output', job.id).find(m => m.attempt === attempt);
      assert.ok(done && output, `job ${job.id} has a record and ${winner.name} produced attempt ${attempt}`);
      assert.deepEqual({ state: done.state, attempt: done.attempt, resultRef: done.resultRef, resultSha256: done.resultSha256 }, { state: 'done', attempt, resultRef: ref, resultSha256: output.sha256 });
      const prefix = `${run}/${job.verb}`;
      assert.deepEqual(await listKeys(`${prefix}/automation/${job.id}/`), [`${prefix}/${ref}`], 'exactly one stored output');
      const blob = await createS3BlobStore({ ...s3Options, prefix }, credential).get(ref);
      assert.ok(blob);
      const bytes = await readBlobBody(blob.body, 1024 * 1024);
      assert.equal(Buffer.from(bytes).toString(), output.text, `the published bytes are ${winner.name}'s`);
      assert.equal(sha256(bytes), done.resultSha256);
    };

    try {
      await t.test('a worker killed with SIGKILL after its claim is recovered by another process', async () => {
        try {
          const job = await queued('crash');
          const a = await start('a', 'crash', 'hold'); a.send('go');
          const claimed = await a.waitFor('claim', m => m.jobId === job.id);
          await a.waitFor('execute', m => m.jobId === job.id);
          await a.kill();
          assert.deepEqual([claimed.attempt, claimed.leaseToken], [1, 1]);
          // The dead process still holds its lease, so nothing may take the job early.
          const { until: deadUntil, ...dead } = await lease(job.id);
          assert.deepEqual(dead, { state: 'running', owner: claimed.leaseOwner, token: 1, held: true });

          const b = await start('b', 'crash', 'run'); b.send('go');
          const recovered = await b.waitFor('claim', m => m.jobId === job.id);
          assert.deepEqual([recovered.attempt, recovered.leaseToken], [2, 2]);
          assert.notEqual(recovered.leaseOwner, claimed.leaseOwner);
          assert.ok(Date.parse(recovered.leaseUntil!) - LEASE_MS >= deadUntil, 'the job was reclaimed only after the dead lease expired');
          await b.waitFor('save', m => m.jobId === job.id && m.ok === true);
          await assertPublishedOnce(job, b, 2);
          assert.equal(a.of('put').length, 0, 'the killed process stored nothing');
        } finally { await stopAll(); }
      });

      /** A blocks its event loop past its lease, so no heartbeat runs, and B claims
       *  the job. B is released as A wakes, so both attempts store and save at the
       *  same time. Exactly one output may be published, and it must be B's. */
      const race = async (verb: string, stale: Record<string, string> = {}) => {
        const job = await queued(verb);
        const a = await start('a', verb, 'block', { LEASE_WORKER_BLOCK_MS: String(LEASE_MS + 2000), ...stale });
        const b = await start('b', verb, 'hold');
        a.send('go');
        const first = await a.waitFor('claim', m => m.jobId === job.id);
        await a.waitFor('execute', m => m.jobId === job.id);
        b.send('go');
        const second = await b.waitFor('claim', m => m.jobId === job.id);
        assert.deepEqual([first.attempt, first.leaseToken, second.attempt, second.leaseToken], [1, 1, 2, 2]);
        await a.waitFor('unblocked', m => m.jobId === job.id);
        b.send('release');
        await Promise.all([a.waitFor('settled'), b.waitFor('settled'), a.waitFor('renew', m => m.jobId === job.id)]);

        assert.ok(b.of('save', job.id).some(m => m.ok && m.state === 'done'), 'the current lease holder publishes');
        assert.ok(a.of('save', job.id).every(m => !m.ok), 'the stale attempt never saves');
        assert.ok(a.of('renew', job.id).every(m => !m.ok), 'nor renews the lease it lost');
        const staleRef = `automation/${job.id}/attempt-1/result`;
        assert.deepEqual(a.of('put').map(m => m.ref), [staleRef], 'the stale attempt wrote only its own attempt path');
        assert.deepEqual(a.of('delete').map(m => m.ref), [staleRef], 'and removed it');
        await assertPublishedOnce(job, b, 2);
        return { job, a };
      };

      await t.test('two processes racing one job publish exactly one output', async () => {
        // Usually the stale worker's heartbeat answers while its bytes are being
        // stored, and it cancels itself before saving.
        try { await race('race'); } finally { await stopAll(); }
      });

      await t.test('the fenced save refuses a stale worker whose heartbeat is too slow to stop it', async () => {
        try {
          // A slow heartbeat lets the stale worker reach the save, as on a congested
          // database link. The lease token, not the heartbeat, has to refuse it.
          const { job, a } = await race('race-slow-heartbeat', { LEASE_WORKER_RENEW_DELAY_MS: '2000' });
          assert.deepEqual(a.of('save', job.id).map(m => [m.ok, m.state]), [[false, 'done']], 'the stale attempt tried to publish and was refused');
        } finally { await stopAll(); }
      });

      await t.test('two processes started together run every queued job once', async () => {
        try {
          const jobs = await Promise.all(Array.from({ length: 16 }, () => queued('claims')));
          // No lease expires here: the race is between claims, not executions.
          const settings = { LEASE_WORKER_LEASE_MS: '30000', LEASE_WORKER_CONCURRENCY: '2', LEASE_WORKER_DELAY_MS: '150' };
          const pair = [await start('a', 'claims', 'run', settings), await start('b', 'claims', 'run', settings)];
          for (const worker of pair) worker.send('go');
          const deadline = Date.now() + 60_000;
          while ((await store.listAutomationJobs(PRINCIPAL)).filter(job => job.verb === 'claims' && job.state === 'done').length < jobs.length) {
            assert.ok(Date.now() < deadline, 'every claimed job finishes');
            await pause(50);
          }
          const executed = pair.flatMap(worker => worker.of('execute').map(m => m.jobId!));
          assert.deepEqual(executed.sort(), jobs.map(job => job.id).sort(), 'each job ran exactly once');
          for (const worker of pair) assert.ok(worker.of('execute').length > 0, `worker ${worker.name} claimed some of the queue`);
          for (const job of jobs) await assertPublishedOnce(job, pair.find(worker => worker.of('execute', job.id).length)!, 1);
          assert.equal((await listKeys(`${run}/claims/`)).length, jobs.length, 'no extra objects');
        } finally { await stopAll(); }
      });

      await t.test('a job whose workers keep dying stops at its recovery budget', async () => {
        try {
          const job = await queued('budget');
          for (const [name, attempt] of [['a', 1], ['b', 2]] as const) {
            const worker = await start(name, 'budget', 'hold'); worker.send('go');
            assert.equal((await worker.waitFor('claim', m => m.jobId === job.id)).attempt, attempt);
            await worker.waitFor('execute', m => m.jobId === job.id);
            await worker.kill();
          }
          const c = await start('c', 'budget', 'run'); c.send('go');
          const saved = await c.waitFor('save', m => m.jobId === job.id);
          assert.equal(saved.ok, true);
          assert.equal(saved.state, 'failed');
          assert.match(saved.error ?? '', /recovery budget exhausted/);
          assert.equal(c.of('execute').length, 0, 'the third attempt does not run the job again');
          const failed = await store.getAutomationJob(job.id, job.principal);
          assert.deepEqual({ state: failed?.state, attempt: failed?.attempt, resultRef: failed?.resultRef }, { state: 'failed', attempt: 3, resultRef: undefined });
          assert.deepEqual(await listKeys(`${run}/budget/automation/${job.id}/`), [], 'nothing was stored');
        } finally { await stopAll(); }
      });
    } finally {
      await stopAll();
      await db.end();
      await removePrefix(`${run}/`).catch(() => {});
    }
  });
});
