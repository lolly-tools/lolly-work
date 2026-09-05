import type { BlobStore } from '../blobs/types.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { RenderResourceError, type RenderRecord, type RenderStore } from './types.ts';
import { evidenceHash, type RenderEvidence } from '../render/evidence.ts';

export interface RenderExecution { bytes: Uint8Array; mime: string; cacheKey: string; evidence?: RenderEvidence }
export interface RenderRunnerOptions {
  store: RenderStore;
  blobs: BlobStore;
  execute: (record: RenderRecord, signal: AbortSignal) => Promise<RenderExecution>;
  concurrency?: number;
  leaseMs?: number;
  timeoutMs?: number;
  pollMs?: number;
  retryDelayMs?: number;
  maxOutputBytes?: number;
  onError?: (error: unknown) => void;
}

/** Polls durable requests. At-least-once execution, fenced immutable publication. */
export class RenderRunner {
  private readonly active = new Set<Promise<void>>();
  private readonly controllers = new Set<AbortController>();
  private timer?: ReturnType<typeof setInterval>;
  private claiming = false;
  private claimFinished?: Promise<void>;
  private stopped = false;
  readonly concurrency: number;
  readonly leaseMs: number;
  readonly timeoutMs: number;
  private readonly options: RenderRunnerOptions;
  constructor(options: RenderRunnerOptions) {
    this.options = options;
    this.concurrency = options.concurrency ?? 2;
    this.leaseMs = options.leaseMs ?? 30_000;
    this.timeoutMs = options.timeoutMs ?? 120_000;
    if (!Number.isInteger(this.concurrency) || this.concurrency < 1 || this.concurrency > 32) throw new Error('render concurrency must be 1–32');
    if (!Number.isFinite(this.leaseMs) || this.leaseMs < 30 || !Number.isFinite(this.timeoutMs) || this.timeoutMs < 1) throw new Error('invalid render lease/timeout');
  }

  start(): void {
    if (this.timer) return;
    this.stopped = false;
    this.timer = setInterval(() => this.kick(), this.options.pollMs ?? 1_000);
    this.timer.unref();
    this.kick();
  }

  kick(): void { void this.tick().catch((error) => this.report(error)); }

  /** One bounded claim pass, useful to hosts and restart/conformance tests. */
  async tick(): Promise<void> {
    if (this.claiming || this.stopped) return;
    this.claiming = true;
    let finishClaim!: () => void;
    this.claimFinished = new Promise<void>((resolve) => { finishClaim = resolve; });
    try {
      while (!this.stopped && this.active.size < this.concurrency) {
        const record = await this.options.store.claimRender(this.leaseMs);
        if (!record) break;
        if (this.stopped) {
          await this.options.store.settleRender(record.id, record.leaseToken!, {
            state: 'failed', error: { code: 'WORKER_STOPPED', message: 'worker stopped before execution' }, retryAfterMs: 0,
          });
          break;
        }
        const pending = this.run(record).catch((error) => this.report(error)).finally(() => this.active.delete(pending));
        this.active.add(pending);
      }
    } finally { this.claiming = false; finishClaim(); }
  }

  /** Stop claims/heartbeats and fence physical work that cannot be interrupted. */
  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    for (const controller of this.controllers) controller.abort(new RenderResourceError('WORKER_STOPPED', 503, 'worker stopped'));
    await this.claimFinished;
    await Promise.all([...this.active]);
  }

  private report(error: unknown): void {
    if (this.options.onError) this.options.onError(error);
    else console.error('[lolly-work] render runner:', error instanceof Error ? error.message : String(error));
  }

  private async run(record: RenderRecord): Promise<void> {
    const { store, blobs } = this.options;
    const token = record.leaseToken!;
    const controller = new AbortController(); this.controllers.add(controller);
    const { signal } = controller;
    // An old worker never writes the replacement worker's blob, even if it
    // finishes after its lease expires or cancellation has been committed.
    const ref = `renders/${record.id}/attempt-${record.attempt}-${token}`;
    const timer = setTimeout(() => controller.abort(new RenderResourceError('RENDER_TIMEOUT', 504, 'render exceeded its execution budget')), this.timeoutMs);
    let heartbeatPending = false;
    const heartbeat = setInterval(() => {
      if (heartbeatPending || signal.aborted) return;
      heartbeatPending = true;
      void store.heartbeatRender(record.id, token, this.leaseMs).then((ok) => {
        if (!ok) controller.abort(new RenderResourceError('LEASE_LOST', 409, 'render lease no longer belongs to this worker'));
      }).catch((error) => controller.abort(error)).finally(() => { heartbeatPending = false; });
    }, Math.max(10, Math.floor(this.leaseMs / 3)));
    let abortListener!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abortListener = () => reject(signal.reason);
      signal.addEventListener('abort', abortListener, { once: true });
    });
    const work = async (): Promise<void> => {
      const output = await this.options.execute(record, signal);
      signal.throwIfAborted();
      if (output.bytes.byteLength > (this.options.maxOutputBytes ?? 32 * 1024 * 1024)) {
        throw new RenderResourceError('OUTPUT_TOO_LARGE', 413, 'render output exceeds the retained-byte limit');
      }
      const sha256 = sha256Hex(output.bytes);
      if (output.evidence) {
        const { id, ...body } = output.evidence;
        if (body.outputSha256 !== sha256 || id !== evidenceHash(body)) {
          throw new RenderResourceError('RENDER_EVIDENCE_MISMATCH', 500, 'execution evidence does not identify these output bytes');
        }
      }
      let mayHavePublished = false;
      try {
        await blobs.put(ref, output.bytes, output.mime);
        signal.throwIfAborted();
        // A lost SQL response may follow a committed settlement. In that
        // ambiguous case retain the bytes; deleting them could break a winner.
        mayHavePublished = true;
        mayHavePublished = await store.settleRender(record.id, token, { state: 'succeeded', output: {
          name: 'default', ref, mime: output.mime, size: output.bytes.byteLength,
          sha256, cacheKey: output.cacheKey,
          ...(output.evidence ? { evidence: output.evidence } : {}),
        } });
      } finally {
        // Runs even when a timed-out put eventually finishes. A failed cleanup
        // is observable; it must not turn successful publication into a retry.
        if (!mayHavePublished) await blobs.delete(ref).catch((error) => this.report(error));
      }
    };
    try {
      await Promise.race([work(), aborted]);
    } catch (error) {
      const e = error as { code?: unknown; status?: unknown; message?: unknown } | null;
      const code = typeof e?.code === 'string' ? e.code : 'RENDER_FAILED';
      const status = typeof e?.status === 'number' ? e.status : 500;
      const transient = status === 408 || status === 429 || (status >= 500 && status !== 501);
      await store.settleRender(record.id, token, {
        state: 'failed',
        error: { code, message: typeof e?.message === 'string' ? e.message.slice(0, 500) : 'render failed' },
        ...(transient ? { retryAfterMs: Math.min(30_000, (this.options.retryDelayMs ?? 1_000) * 2 ** (record.attempt - 1)) } : {}),
      });
    } finally {
      clearTimeout(timer); clearInterval(heartbeat);
      signal.removeEventListener('abort', abortListener);
      this.controllers.delete(controller);
    }
  }
}
