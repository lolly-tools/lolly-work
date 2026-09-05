// SPDX-License-Identifier: MPL-2.0
/** Durable automation queue: Store owns metadata and BlobStore owns bytes. */
import { randomUUID, createHmac } from 'node:crypto';
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import type { AutomationJobRecord, Store } from '../store/types.ts';

export type AutomationJob = AutomationJobRecord;
type JobStore = Pick<Store, 'putAutomationJob' | 'getAutomationJob' | 'listAutomationJobs' | 'findAutomationJobByIdempotency' | 'deleteAutomationJob'>;
export interface JobOutput { mime: string; bytes: Uint8Array; value?: unknown }

export interface AutomationQueueOptions {
  fetchImpl?: typeof fetch;
  store?: JobStore;
  blobs?: BlobStore;
  callbackSecret?: string;
  /** Fail closed: a callback is sent only when the instance approves its URL. */
  callbackAllowed?: (url: string) => boolean;
  /** Mint an authenticated, expiring result URL for an out-of-band callback. */
  resultUrl?: (job: AutomationJob) => string;
  /** Process-local drain width. The durable lease/replica runner is plan 40;
   * this bound prevents one process from stampeding its render worker. */
  maxConcurrent?: number;
}

interface PendingJob { job: AutomationJob; work: (job: AutomationJob) => Promise<JobOutput> }

export class AutomationQueue {
  private readonly jobs = new Map<string, AutomationJob>();
  private readonly options: AutomationQueueOptions;
  private readonly pending: PendingJob[] = [];
  private readonly running = new Set<string>();
  private readonly cancelled = new Set<string>();
  private active = 0;
  constructor(options: AutomationQueueOptions = {}) { this.options = options; }

  async create(principal: string, verb: string, request: Record<string, unknown>, run: (job: AutomationJob) => Promise<JobOutput>, idempotencyKey?: string): Promise<{ job: AutomationJob; reused: boolean }> {
    if (idempotencyKey) {
      const existing = await this.findByKey(principal, idempotencyKey);
      if (existing) {
        if (existing.verb !== verb || JSON.stringify(existing.request) !== JSON.stringify(request)) throw new Error('IDEMPOTENCY_KEY_REUSED');
        return { job: existing, reused: true };
      }
    }
    const now = new Date().toISOString();
    const priority = Math.max(0, Math.min(9, Math.trunc(Number(request.priority ?? 0) || 0)));
    const job: AutomationJob = { id: randomUUID(), principal, verb, request: structuredClone(request), state: 'queued', createdAt: now, updatedAt: now, priority, attempt: 0, ...(typeof request.callbackUrl === 'string' ? { callbackUrl: request.callbackUrl } : {}), ...(idempotencyKey ? { idempotencyKey } : {}) };
    await this.save(job);
    this.pending.push({ job, work: run });
    this.pending.sort((a, b) => b.job.priority - a.job.priority || a.job.createdAt.localeCompare(b.job.createdAt));
    queueMicrotask(() => this.drain());
    return { job, reused: false };
  }

  async get(id: string, principal: string): Promise<AutomationJob | null> {
    if (this.options.store) return this.options.store.getAutomationJob(id, principal);
    const job = this.jobs.get(id); return job?.principal === principal ? structuredClone(job) : null;
  }

  async list(principal: string): Promise<AutomationJob[]> {
    if (this.options.store) return this.options.store.listAutomationJobs(principal);
    return [...this.jobs.values()].filter((j) => j.principal === principal).sort((a, b) => b.createdAt.localeCompare(a.createdAt)).map((j) => structuredClone(j));
  }

  async result(id: string, principal: string): Promise<JobOutput | null> {
    const job = await this.get(id, principal);
    if (!job?.resultRef || !job.resultMime || job.state !== 'done' || !this.options.blobs) return null;
    const blob = await this.options.blobs.get(job.resultRef); if (!blob) return null;
    return { mime: job.resultMime, bytes: new Uint8Array(await readBlobBody(blob.body)) };
  }

  async remove(id: string, principal: string): Promise<boolean> {
    const job = await this.get(id, principal); if (!job) return false;
    const pendingIndex = this.pending.findIndex((candidate) => candidate.job.id === id);
    if (pendingIndex >= 0) this.pending.splice(pendingIndex, 1);
    if (this.running.has(id)) this.cancelled.add(id);
    if (job.resultRef) await this.options.blobs?.delete(job.resultRef);
    this.jobs.delete(id);
    return this.options.store ? this.options.store.deleteAutomationJob(id, principal) : true;
  }

  async save(job: AutomationJob): Promise<void> {
    if (this.cancelled.has(job.id)) return;
    job.updatedAt = new Date().toISOString(); this.jobs.set(job.id, structuredClone(job));
    await this.options.store?.putAutomationJob(job);
  }

  private async findByKey(principal: string, key: string): Promise<AutomationJob | null> {
    if (this.options.store) return this.options.store.findAutomationJobByIdempotency(principal, key);
    return [...this.jobs.values()].find((j) => j.principal === principal && j.idempotencyKey === key) ?? null;
  }

  private drain(): void {
    const limit = Math.max(1, Math.min(32, this.options.maxConcurrent ?? 4));
    while (this.active < limit && this.pending.length) {
      const next = this.pending.shift()!;
      this.active++;
      this.running.add(next.job.id);
      void this.run(next.job, next.work).finally(() => {
        this.active--;
        this.running.delete(next.job.id);
        this.cancelled.delete(next.job.id);
        this.drain();
      });
    }
  }

  private async run(job: AutomationJob, work: (job: AutomationJob) => Promise<JobOutput>): Promise<void> {
    const retries = Math.max(0, Math.min(3, Math.trunc(Number(job.request.jobRetries ?? 0) || 0)));
    let output: JobOutput | null = null;
    let failure: unknown;
    for (let retry = 0; retry <= retries && !output && !this.cancelled.has(job.id); retry++) {
      job.state = 'running'; job.attempt++; delete job.error; await this.save(job);
      try { output = await work(job); }
      catch (error) { failure = error; }
    }
    if (this.cancelled.has(job.id)) return;
    if (output) {
      if (!this.options.blobs) failure = new Error('automation result blob store unavailable');
      else {
        try {
          const ref = `automation/${job.id}/result`;
          await this.options.blobs.put(ref, output.bytes, output.mime);
          if (this.cancelled.has(job.id)) { await this.options.blobs.delete(ref); return; }
          job.resultRef = ref; job.resultMime = output.mime; job.state = 'done';
        } catch (error) { failure = error; output = null; }
      }
    }
    if (!output || failure && !job.resultRef) {
      job.error = failure instanceof Error ? failure.message : String(failure ?? 'automation job failed');
      job.state = 'failed';
    }
    job.finishedAt = new Date().toISOString(); await this.save(job); await this.callback(job);
  }

  private async callback(job: AutomationJob): Promise<void> {
    if (!job.callbackUrl) return;
    if (!this.options.callbackAllowed?.(job.callbackUrl) || !this.options.callbackSecret) { job.callbackFailed = true; await this.save(job); return; }
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const body = JSON.stringify({ jobId: job.id, state: job.state, resultUrl: job.state === 'done' ? (this.options.resultUrl?.(job) ?? `/api/v1/jobs/${job.id}/result`) : null });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', this.options.callbackSecret).update(`${timestamp}.${body}`).digest('hex');
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const response = await fetchImpl(job.callbackUrl, { method: 'POST', headers: { 'content-type': 'application/json', 'x-lolly-timestamp': timestamp, 'x-lolly-signature': `sha256=${signature}` }, body });
        if (response.ok) return;
      } catch { /* bounded retry below */ }
      if (attempt < 2) await new Promise((resolve) => setTimeout(resolve, 25 * (2 ** attempt)));
    }
    job.callbackFailed = true; await this.save(job);
  }
}

export function jobWire(job: AutomationJob, resultUrl = `/api/v1/jobs/${job.id}/result`): Record<string, unknown> {
  return { jobId: job.id, verb: job.verb, state: job.state, statusUrl: `/api/v1/jobs/${job.id}`, resultUrl: job.state === 'done' ? resultUrl : null, error: job.error ?? null, callbackFailed: job.callbackFailed ?? false, progress: job.progress ?? null, priority: job.priority, attempt: job.attempt, createdAt: job.createdAt, finishedAt: job.finishedAt ?? null };
}
