// SPDX-License-Identifier: MPL-2.0
/**
 * Durable callback outbox. A settled job's callback is a stored entry, written in
 * the same store call that settles the job, never a closure in one process. Any
 * process claims due entries with a lease, so an entry that no process finished
 * is sent again after a restart, with the same id.
 *
 * Every attempt of one callback carries that id in `x-lolly-delivery-id` and in
 * the signed body: the same idempotency key contract as a signed-HTTPS delivery
 * attempt, so one receiver can drop duplicates from both by that id. Work never
 * reports a callback as delivered. A 2xx answer is recorded as `acknowledged`;
 * a timeout or a dropped connection is `uncertain`, because the receiver may
 * have acted on it, and the retry reuses the id.
 */
import { createHmac, randomUUID } from 'node:crypto';
import type { AutomationCallbackRecord, AutomationCallbackResult, AutomationJobRecord, Store } from '../store/types.ts';

export type CallbackOutboxStore = Pick<Store, 'claimAutomationCallback' | 'settleAutomationCallback' | 'nextAutomationCallbackAt' | 'getAutomationJob'>;

/** The header that carries the idempotency key, shared with signed-HTTPS delivery. */
export const CALLBACK_ID_HEADER = 'x-lolly-delivery-id';
/** The wait after each failed attempt. One more attempt than delays: six in all, over about 45 minutes. */
export const CALLBACK_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000];

export interface CallbackOutboxOptions {
  fetchImpl?: typeof fetch;
  /** HMAC key for `x-lolly-signature`. Without it nothing is sent. */
  secret?: string;
  /** Fail closed: an entry whose URL the instance does not approve is never sent. */
  allowed?: (url: string) => boolean;
  /** Mint an authenticated, expiring result URL. Each attempt mints a fresh one. */
  resultUrl?: (job: AutomationJobRecord) => string;
  /** Mint the token a receiver sends as `x-lw-job-token`. Each attempt mints a fresh one. */
  resultToken?: (job: AutomationJobRecord) => string;
  leaseMs?: number;
  timeoutMs?: number;
  retryDelaysMs?: readonly number[];
  concurrency?: number;
}

export class CallbackOutbox {
  private readonly owner = randomUUID();
  private readonly store: CallbackOutboxStore;
  private readonly fetchImpl: typeof fetch;
  private readonly options: CallbackOutboxOptions;
  private readonly timeoutMs: number;
  private readonly leaseMs: number;
  private readonly delays: readonly number[];
  private readonly width: number;
  /** The wait before looking again after a store error: the first retry delay, from 1 s to 30 s. */
  private readonly errorWakeMs: number;
  private readonly running = new Set<Promise<void>>();
  private polling = false;
  private pollAgain = false;
  private stopped = false;
  /** True while nothing else polls on a clock: the outbox then wakes itself
   *  when the next pending entry falls due. */
  private selfScheduled = true;
  private wake?: ReturnType<typeof setTimeout>;
  constructor(store: CallbackOutboxStore, options: CallbackOutboxOptions = {}) {
    this.store = store; this.options = options; this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = Math.max(100, options.timeoutMs ?? 10_000);
    // The lease outlives a full attempt, so a live sender is never claimed over.
    this.leaseMs = Math.max(this.timeoutMs * 3, options.leaseMs ?? 60_000);
    this.delays = options.retryDelaysMs ?? CALLBACK_RETRY_DELAYS_MS;
    this.width = Math.max(1, Math.min(16, options.concurrency ?? 4));
    this.errorWakeMs = Math.min(30_000, Math.max(1000, this.delays[0] ?? 30_000));
  }

  /** A timer elsewhere calls poll() on a clock, so the outbox stops waking itself. */
  polledOnTimer(): void { this.selfScheduled = false; clearTimeout(this.wake); }

  async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) { this.pollAgain = true; return; }
    this.polling = true;
    let storeFailed = false;
    try {
      do {
        this.pollAgain = false;
        while (!this.stopped && this.running.size < this.width) {
          const claimed = await this.store.claimAutomationCallback(this.owner, this.leaseMs);
          if (!claimed) break;
          // An attempt that throws (the store failed to record it) keeps its
          // lease until expiry; the next claim then records it as uncertain.
          const attempt: Promise<void> = this.attempt(claimed).catch(() => {}).finally(() => { this.running.delete(attempt); void this.poll().catch(() => {}); });
          this.running.add(attempt);
        }
      } while (this.pollAgain && !this.stopped);
    } catch (error) {
      storeFailed = true;
      throw error;
    } finally {
      this.polling = false;
      // Re-arm after a store error too: while the outbox wakes itself, nothing
      // else would look again until another job settles.
      if (this.selfScheduled && !this.running.size) await this.scheduleWake(storeFailed);
    }
  }

  stop(): void { this.stopped = true; clearTimeout(this.wake); }

  private async scheduleWake(storeFailed: boolean): Promise<void> {
    // After a store error (a database still starting, say) nothing says what is
    // pending, so look again after a bounded wait rather than never.
    let wait = this.errorWakeMs;
    if (!storeFailed) {
      try {
        const next = await this.store.nextAutomationCallbackAt();
        if (!next) { clearTimeout(this.wake); return; }
        // At least a second: the store's clock decides what is due, and a small
        // skew must not turn this into a tight loop.
        wait = Math.min(Math.max(Date.parse(next) - Date.now(), 1000), 2 ** 31 - 1);
      } catch { /* the bounded wait above */ }
    }
    clearTimeout(this.wake);
    if (this.stopped) return;
    this.wake = setTimeout(() => { void this.poll().catch(() => {}); }, wait);
    this.wake.unref();
  }

  private async attempt(callback: AutomationCallbackRecord): Promise<void> {
    const settle = (result: AutomationCallbackResult): Promise<boolean> => this.store.settleAutomationCallback(callback, result);
    const limit = this.delays.length + 1;
    if (callback.attempt > limit) {
      // Only an attempt whose sender stopped mid-flight runs past the limit;
      // keep its uncertain outcome rather than claim nothing was sent.
      await settle({ state: 'failed', outcome: callback.lastOutcome ?? 'not-sent', error: `${callback.lastError ? `${callback.lastError} ` : ''}No attempts remain (limit ${limit}).` });
      return;
    }
    const job = await this.store.getAutomationJob(callback.jobId, callback.principal);
    if (!job) { await settle({ state: 'failed', outcome: 'not-sent', error: 'The job no longer exists.' }); return; }
    const { secret, allowed, resultUrl, resultToken } = this.options;
    if (!secret) { await settle({ state: 'failed', outcome: 'not-sent', error: 'No webhook signing secret is configured.' }); return; }
    if (!allowed?.(callback.url)) { await settle({ state: 'failed', outcome: 'not-sent', error: 'This instance does not approve the callback URL.' }); return; }
    const done = job.state === 'done';
    const body = JSON.stringify({ jobId: job.id, state: job.state, resultUrl: done ? (resultUrl?.(job) ?? `/api/v1/jobs/${job.id}/result`) : null, resultToken: done ? (resultToken?.(job) ?? null) : null, deliveryId: callback.id });
    const timestamp = String(Date.now());
    const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
    let response: Response;
    try {
      response = await this.fetchImpl(callback.url, {
        method: 'POST', body, redirect: 'error', signal: AbortSignal.timeout(this.timeoutMs),
        headers: { 'content-type': 'application/json', 'x-lolly-timestamp': timestamp, 'x-lolly-signature': `sha256=${signature}`, [CALLBACK_ID_HEADER]: callback.id },
      });
      await response.body?.cancel().catch(() => {});
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await settle(this.next(callback, { outcome: 'uncertain', error: `The request did not complete (${reason}); the receiver may have received it.` }));
      return;
    }
    if (response.ok) { await settle({ state: 'acknowledged', outcome: 'acknowledged', status: response.status }); return; }
    await settle(this.next(callback, { outcome: 'refused', status: response.status, error: `The receiver answered ${response.status}.` }));
  }

  /** Another attempt after the scheduled wait, or failed once none remain. */
  private next(callback: AutomationCallbackRecord, result: Omit<AutomationCallbackResult, 'state'>): AutomationCallbackResult {
    const delay = this.delays[callback.attempt - 1];
    return delay === undefined ? { ...result, state: 'failed' } : { ...result, state: 'pending', retryAfterMs: delay };
  }
}
