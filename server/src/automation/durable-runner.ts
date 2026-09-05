// SPDX-License-Identifier: MPL-2.0
/** Restartable, replica-safe execution. Input is stored data, never a lost closure. */
import { randomUUID, createHash } from 'node:crypto';
import type { Store, AutomationJobRecord } from '../store/types.ts';
import type { BlobStore } from '../blobs/types.ts';
import type { JobOutput } from './jobs.ts';

export type DurableExecutor = (job: AutomationJobRecord, signal: AbortSignal) => Promise<JobOutput>;
export class DurableAutomationRunner {
  private readonly owner = randomUUID();
  private readonly store: Pick<Store, 'claimAutomationJob' | 'renewAutomationJob' | 'saveClaimedAutomationJob'>;
  private readonly blobs: BlobStore;
  private readonly executors: Record<string, DurableExecutor>;
  private readonly leaseMs: number;
  private readonly width: number;
  private readonly onComplete?: (job: AutomationJobRecord) => Promise<void>;
  private polling = false;
  private stopped = false;
  private readonly running = new Map<string, AbortController>();
  constructor(store: Pick<Store, 'claimAutomationJob' | 'renewAutomationJob' | 'saveClaimedAutomationJob'>, blobs: BlobStore, executors: Record<string, DurableExecutor>, options: { leaseMs?: number; concurrency?: number; onComplete?: (job: AutomationJobRecord) => Promise<void> } = {}) {
    this.store = store; this.blobs = blobs; this.executors = executors;
    this.leaseMs = Math.max(30, options.leaseMs ?? 120_000); this.width = Math.max(1, Math.min(16, options.concurrency ?? 4));
    this.onComplete = options.onComplete;
  }
  async poll(): Promise<void> {
    if (this.polling || this.stopped) return;
    this.polling = true;
    try {
      while (!this.stopped && this.running.size < this.width) {
        const job = await this.store.claimAutomationJob(this.owner, Object.keys(this.executors), this.leaseMs);
        if (!job) break;
        const controller = new AbortController(); this.running.set(job.id, controller);
        void this.run(job, controller).catch(() => { /* lease expires; another poll retries */ }).finally(() => { this.running.delete(job.id); });
      }
    } finally { this.polling = false; }
  }
  stop(): void { this.stopped = true; for (const controller of this.running.values()) controller.abort(); }
  private async run(job: AutomationJobRecord, controller: AbortController): Promise<void> {
    const heartbeat = setInterval(() => {
      void this.store.renewAutomationJob(job, this.leaseMs).then(ok => { if (!ok) controller.abort(); }, () => controller.abort());
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    heartbeat.unref();
    // A losing worker owns only its attempt path. It can never overwrite or delete
    // the winning worker's bytes, even when a renderer ignores cancellation.
    const ref = `automation/${job.id}/attempt-${job.leaseToken}/result`;
    let wrote = false;
    try {
      const retries = Math.max(0, Math.min(3, Math.trunc(Number(job.request.jobRetries ?? 0) || 0)));
      // One recovery attempt is available even when the caller asked for no
      // ordinary codec retries. A crashed worker is not a failed codec result.
      if (job.attempt > retries + 2) throw new Error('Execution lease expired; recovery budget exhausted. Resubmit to try again.');
      const output = await this.executors[job.verb]!(job, controller.signal);
      controller.signal.throwIfAborted();
      if (output.bytes.byteLength > 256 * 1024 * 1024) throw new Error('Automation output exceeds the 256 MB result limit.');
      await this.blobs.put(ref, output.bytes, output.mime); wrote = true;
      controller.signal.throwIfAborted();
      Object.assign(job, { state: 'done', resultRef: ref, resultMime: output.mime, resultSha256: createHash('sha256').update(output.bytes).digest('hex'), finishedAt: new Date().toISOString() });
      // Callback outbox/replay is separate: never claim a callback was delivered.
      if (job.callbackUrl) job.callbackFailed = true;
      if (!await this.store.saveClaimedAutomationJob(job)) { await this.blobs.delete(ref); wrote = false; }
      else { wrote = false; await this.onComplete?.(job).catch(() => {}); }
    } catch (error) {
      if (wrote) await this.blobs.delete(ref).catch(() => {});
      if (!controller.signal.aborted) {
        job.state = 'failed'; job.error = error instanceof Error ? error.message : String(error); job.finishedAt = new Date().toISOString();
        delete job.resultRef; delete job.resultMime; delete job.resultSha256;
        const retries = Math.max(0, Math.min(3, Math.trunc(Number(job.request.jobRetries ?? 0) || 0)));
        if (job.attempt <= retries) { job.state = 'queued'; delete job.finishedAt; }
        if (job.callbackUrl && job.state === 'failed') job.callbackFailed = true;
        if (await this.store.saveClaimedAutomationJob(job) && job.state === 'failed') await this.onComplete?.(job).catch(() => {});
      }
    } finally { clearInterval(heartbeat); }
  }
}
