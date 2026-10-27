// SPDX-License-Identifier: MPL-2.0
/**
 * The OTLP/HTTP sender and the bounded batch queue in front of it.
 *
 * Nothing here runs on a request's path: a finished span or log record is an
 * array push. Encoding, compression and the POST happen on a timer, one export
 * in flight per signal. The queue has a hard size; a record that arrives when
 * it is full is dropped and counted, never waited for, so a slow or absent
 * collector costs memory up to the bound and no latency at all.
 */
import { request as httpRequest, Agent as HttpAgent, type IncomingMessage } from 'node:http';
import { request as httpsRequest, Agent as HttpsAgent } from 'node:https';
import { gzip } from 'node:zlib';
import { promisify } from 'node:util';
import type { BatchConfig, ExporterConfig } from './otel-config.ts';

const gzipAsync = promisify(gzip);
/** Statuses the OTLP/HTTP specification says to retry, with backoff. */
const RETRYABLE = new Set([429, 502, 503, 504]);

export interface Sender {
  /** POST one encoded request. True when the receiver accepted it (2xx). */
  send(body: Uint8Array, deadline: number): Promise<boolean>;
  close(): void;
}

export interface SendFailure { status?: number; error?: string }

/** One sender per signal, with its own keep-alive agent. `onFailure` hears
 *  about a rejected or failed export (status or error code only). */
export function createSender(cfg: ExporterConfig, onFailure: (failure: SendFailure) => void): Sender {
  const url = new URL(cfg.url);
  const secure = url.protocol === 'https:';
  const agent = secure
    ? new HttpsAgent({ keepAlive: true, maxSockets: 2, ...(cfg.ca ? { ca: cfg.ca } : {}), ...(cfg.cert ? { cert: cfg.cert } : {}), ...(cfg.key ? { key: cfg.key } : {}) })
    : new HttpAgent({ keepAlive: true, maxSockets: 2 });
  const contentType = cfg.protocol === 'http/json' ? 'application/json' : 'application/x-protobuf';

  const attempt = (payload: Uint8Array, timeoutMs: number): Promise<{ status?: number; retryAfterMs?: number; error?: string }> =>
    new Promise((resolve) => {
      const req = (secure ? httpsRequest : httpRequest)(url, {
        method: 'POST',
        agent,
        timeout: timeoutMs,
        headers: {
          ...cfg.headers,
          'content-type': contentType,
          'content-length': String(payload.length),
          ...(cfg.compression === 'gzip' ? { 'content-encoding': 'gzip' } : {}),
          'user-agent': 'lolly-work-otlp',
        },
      }, (res: IncomingMessage) => {
        res.resume(); // the body (a partial-success notice at most) is not needed
        res.on('end', () => {
          const after = Number(res.headers['retry-after']);
          resolve({ status: res.statusCode ?? 0, ...(Number.isFinite(after) && after >= 0 ? { retryAfterMs: after * 1000 } : {}) });
        });
        res.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? 'response-error' }));
      });
      req.on('timeout', () => req.destroy(Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' })));
      req.on('error', (err: NodeJS.ErrnoException) => resolve({ error: err.code ?? 'request-error' }));
      req.end(payload);
    });

  return {
    async send(body, deadline) {
      const payload = cfg.compression === 'gzip' ? new Uint8Array(await gzipAsync(body)) : body;
      for (let tries = 0; ; tries++) {
        const left = deadline - Date.now();
        if (left <= 0) { onFailure({ error: 'deadline' }); return false; }
        const result = await attempt(payload, Math.min(cfg.timeoutMs, left));
        if (result.status && result.status >= 200 && result.status < 300) return true;
        const retryable = result.error !== undefined || RETRYABLE.has(result.status ?? 0);
        const backoff = result.retryAfterMs ?? Math.min(250 * 2 ** tries, 4_000) * (0.5 + Math.random() / 2);
        if (!retryable || tries >= 4 || Date.now() + backoff >= deadline) {
          onFailure(result.error !== undefined ? { error: result.error } : { status: result.status ?? 0 });
          return false;
        }
        await new Promise(r => setTimeout(r, backoff).unref());
      }
    },
    close() { agent.destroy(); },
  };
}

export type QueueOutcome = 'exported' | 'queue_full' | 'export_failed';

/**
 * The batch processor of the OpenTelemetry specification, sized by the
 * OTEL_BSP_* (spans) or OTEL_BLRP_* (logs) settings: export when a full batch
 * is waiting or `scheduleDelayMs` after the first item of a batch arrived,
 * whichever is sooner. A timer exists only while items are waiting.
 */
export class BatchQueue<T> {
  private readonly cfg: BatchConfig;
  private readonly exportBatch: (items: T[], deadline: number) => Promise<boolean>;
  private readonly count: (outcome: QueueOutcome, n: number) => void;
  private items: T[] = [];
  private timer: NodeJS.Timeout | undefined;
  private running: Promise<void> | undefined;
  private closed = false;

  constructor(cfg: BatchConfig, exportBatch: (items: T[], deadline: number) => Promise<boolean>, count: (outcome: QueueOutcome, n: number) => void) {
    this.cfg = cfg;
    this.exportBatch = exportBatch;
    this.count = count;
  }

  get size(): number { return this.items.length; }

  push(item: T): void {
    if (this.closed || this.items.length >= this.cfg.maxQueueSize) { this.count('queue_full', 1); return; }
    this.items.push(item);
    if (this.items.length >= this.cfg.maxExportBatchSize) this.kick();
    else if (!this.timer && !this.running) this.arm();
  }

  private arm(): void {
    this.timer = setTimeout(() => { this.timer = undefined; this.kick(); }, this.cfg.scheduleDelayMs);
    this.timer.unref();
  }

  private kick(): void {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    if (this.running) return;
    this.running = this.drain(false).finally(() => {
      this.running = undefined;
      if (this.items.length && !this.closed) {
        if (this.items.length >= this.cfg.maxExportBatchSize) this.kick(); else this.arm();
      }
    });
  }

  /** Export one batch, or everything when `all`, one request at a time. */
  private async drain(all: boolean): Promise<void> {
    do {
      const batch = this.items.splice(0, this.cfg.maxExportBatchSize);
      if (!batch.length) return;
      const ok = await this.exportBatch(batch, Date.now() + this.cfg.exportTimeoutMs).catch(() => false);
      this.count(ok ? 'exported' : 'export_failed', batch.length);
    } while (all ? this.items.length > 0 : this.items.length >= this.cfg.maxExportBatchSize);
  }

  /** Export everything waiting now. */
  async flush(): Promise<void> {
    if (this.timer) { clearTimeout(this.timer); this.timer = undefined; }
    while (this.running) await this.running;
    if (!this.items.length) return;
    this.running = this.drain(true).finally(() => { this.running = undefined; });
    await this.running;
  }

  /** Stop accepting, then export what is waiting. */
  async shutdown(): Promise<void> {
    this.closed = true;
    await this.flush();
  }
}
