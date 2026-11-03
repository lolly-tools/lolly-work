// SPDX-License-Identifier: MPL-2.0
/**
 * Edge purge outbox (plan 80 section 6.3).
 *
 * `enqueue` writes one row per configured provider when public bytes change;
 * `poll` drains them. Rows that fall due together for one provider are merged,
 * de-duplicated and sent in requests of the provider's batch size, within an
 * in-process token bucket for that provider's documented budget. A request the
 * budget cannot cover now is moved to a new row that falls due when a token
 * frees up. A failure retries with backoff (or the provider's Retry-After),
 * then stops; a malformed request stops at once.
 *
 * A purge never blocks or reverses the event that asked for it: a revoke or a
 * visibility change takes effect at the origin whether or not the purge works.
 */
import { randomUUID } from 'node:crypto';
import { renderTags } from '@lolly-tools/core/delivery-v1';
import { TokenBucket } from './rate.ts';
import { httpsHost } from './http.ts';
import { EdgeApiError, type EdgeAdapter, type PurgeLimits } from './types.ts';
import type { EdgeProviderConfig } from './config.ts';
import type { EdgePurgeInput, EdgePurgeKind, EdgePurgeRecord, EdgePurgeResult, Store } from '../store/types.ts';

export type EdgeOutboxStore = Pick<Store, 'enqueueEdgePurges' | 'claimEdgePurges' | 'settleEdgePurge' | 'nextEdgePurgeAt'>;

/** Waits after each failed attempt: seven attempts over about 1.7 hours. */
export const EDGE_PURGE_RETRY_DELAYS_MS: readonly number[] = [5_000, 30_000, 120_000, 600_000, 1_800_000, 3_600_000];

export interface EdgePurgeRequest {
  tags?: string[];
  /** Root-relative paths, purged on every hostname of every provider. */
  paths?: string[];
  /** Absolute URLs, each sent only to the provider that fronts its hostname. */
  urls?: string[];
  reason: string;
}

export interface EdgeOutboxOptions {
  providers: readonly EdgeProviderConfig[];
  /** The adapter for a provider, or null when its credential is missing. */
  adapterFor: (provider: EdgeProviderConfig) => Promise<EdgeAdapter | null>;
  retryDelaysMs?: readonly number[];
  /** Events inside this window go out together. Default 5 s. */
  coalesceMs?: number;
  /** Requests one pass sends per provider and kind; bounds the lease. Default 20. */
  maxRequestsPerPass?: number;
  /** Per request; also sizes the lease. Default 15 s. */
  requestTimeoutMs?: number;
  /** Called once a row reaches a final state, for the audit log. */
  onSettled?: (record: EdgePurgeRecord, result: EdgePurgeResult) => void | Promise<void>;
  now?: () => number;
}

/** Tags and URLs are checked when they are written, so a bad item cannot stall a batch later. */
export function validPurgeTag(value: string): boolean {
  if (typeof value !== 'string' || value.includes('*')) return false;
  try { renderTags([value], 'comma'); return true; } catch { return false; }
}

export class EdgePurgeOutbox {
  private readonly owner = randomUUID();
  private readonly buckets = new Map<string, TokenBucket>();
  private readonly delays: readonly number[];
  private readonly coalesceMs: number;
  private readonly maxRequests: number;
  private readonly leaseMs: number;
  private readonly now: () => number;
  private polling = false;
  private pollAgain = false;
  private started = false;
  private stopped = false;
  private wake?: ReturnType<typeof setTimeout>;

  private readonly store: EdgeOutboxStore;
  private readonly options: EdgeOutboxOptions;

  constructor(store: EdgeOutboxStore, options: EdgeOutboxOptions) {
    this.store = store;
    this.options = options;
    this.delays = options.retryDelaysMs ?? EDGE_PURGE_RETRY_DELAYS_MS;
    this.coalesceMs = Math.max(0, options.coalesceMs ?? 5_000);
    this.maxRequests = Math.max(1, Math.min(100, options.maxRequestsPerPass ?? 20));
    // The lease outlives a full pass, so a live sender is never claimed over.
    this.leaseMs = this.maxRequests * Math.max(1000, options.requestTimeoutMs ?? 15_000) + 30_000;
    this.now = options.now ?? Date.now;
  }

  get configured(): boolean { return this.options.providers.length > 0; }

  /**
   * Write purge rows for every provider. Items that are not delivery tags or
   * exact HTTPS URLs on a configured hostname are refused here, with the reason.
   */
  async enqueue(request: EdgePurgeRequest): Promise<{ records: EdgePurgeRecord[]; refused: string[] }> {
    const refused: string[] = [];
    const tags = [...new Set(request.tags ?? [])].filter(value => validPurgeTag(value) || (refused.push(`tag ${JSON.stringify(String(value).slice(0, 100))}`), false));
    const paths = [...new Set(request.paths ?? [])].filter(path => {
      const ok = typeof path === 'string' && /^\/[^\s?#*]*$/.test(path) && !path.startsWith('//') && !path.split('/').some(part => part === '..' || part === '.');
      if (!ok) refused.push(`path ${JSON.stringify(String(path).slice(0, 100))}`);
      return ok;
    });
    const urls = [...new Set(request.urls ?? [])];
    const entries: EdgePurgeInput[] = [];
    const claimedUrls = new Set<string>();
    for (const provider of this.options.providers) {
      if (tags.length) entries.push({ providerId: provider.id, kind: 'tags', items: tags, reason: request.reason, notBeforeMs: this.coalesceMs });
      const own = urls.filter(url => { const host = httpsHost(url); return !!host && provider.hostnames.includes(host) && !url.includes('*'); });
      own.forEach(url => claimedUrls.add(url));
      const expanded = [...new Set([...own, ...provider.hostnames.flatMap(host => paths.map(path => `https://${host}${path}`))])];
      if (expanded.length) entries.push({ providerId: provider.id, kind: 'urls', items: expanded, reason: request.reason, notBeforeMs: this.coalesceMs });
    }
    for (const url of urls) if (!claimedUrls.has(url)) refused.push(`URL ${JSON.stringify(String(url).slice(0, 200))} (not an exact HTTPS URL on a configured edge hostname)`);
    const records = entries.length ? await this.store.enqueueEdgePurges(entries) : [];
    if (records.length && this.started) this.schedule(this.coalesceMs);
    return { records, refused };
  }

  /** Run as a long-lived worker: poll now and whenever the next row falls due. */
  start(): void { this.started = true; this.stopped = false; void this.poll().catch(() => {}); }
  stop(): void { this.stopped = true; clearTimeout(this.wake); }

  /** One pass over every provider and kind. Safe to call concurrently; overlapping calls fold into one. */
  async poll(): Promise<void> {
    if (this.stopped) return;
    if (this.polling) { this.pollAgain = true; return; }
    this.polling = true;
    let soonest: number | undefined;
    try {
      do {
        this.pollAgain = false;
        for (const provider of this.options.providers) {
          for (const kind of ['tags', 'urls'] as const) {
            const wait = await this.drain(provider, kind);
            if (wait !== undefined) soonest = soonest === undefined ? wait : Math.min(soonest, wait);
          }
        }
      } while (this.pollAgain && !this.stopped);
    } finally {
      this.polling = false;
      if (this.started && !this.stopped) await this.scheduleNext(soonest);
    }
  }

  private bucketFor(provider: EdgeProviderConfig, adapter: EdgeAdapter, kind: EdgePurgeKind): { bucket: TokenBucket; limits: PurgeLimits } {
    const caps = adapter.capabilities;
    const limits = kind === 'tags' ? caps.tagPurge : caps.urlPurge;
    const key = `${provider.id}:${caps.sharedPurgeBudget ? 'all' : kind}`;
    let bucket = this.buckets.get(key);
    if (!bucket) { bucket = new TokenBucket(limits, this.now); this.buckets.set(key, bucket); }
    return { bucket, limits };
  }

  /** Drain due rows for one provider and kind. Returns a wait in ms when the budget ran out. */
  private async drain(provider: EdgeProviderConfig, kind: EdgePurgeKind): Promise<number | undefined> {
    const adapter = await this.options.adapterFor(provider);
    let budgetWait: number | undefined;
    let affordable = this.maxRequests;
    let opsPerRequest = 1;
    let bucket: TokenBucket | undefined;
    if (adapter) {
      const chosen = this.bucketFor(provider, adapter, kind);
      bucket = chosen.bucket;
      opsPerRequest = Math.max(1, chosen.limits.opsPerRequest);
      affordable = Math.min(this.maxRequests, bucket.available());
      if (affordable < 1) return bucket.waitMs() || 1000;
    }
    const rows = await this.store.claimEdgePurges(this.owner, this.leaseMs, provider.id, kind, adapter ? affordable * opsPerRequest : 50);
    if (!rows.length) return undefined;
    if (!adapter) {
      await this.settleAll(rows, rows.map(row => this.retry(row, `No credential is available for edge provider ${provider.id}. Set its credentialRef variable or store one with lw edge credential.`)));
      return undefined;
    }
    const items = [...new Set(rows.flatMap(row => row.items))];
    const batches: string[][] = [];
    for (let i = 0; i < items.length; i += opsPerRequest) batches.push(items.slice(i, i + opsPerRequest));
    const ids: string[] = [];
    let sent = 0;
    let requests = 0;
    for (const batch of batches) {
      const token = bucket!.take();
      if (!token.ok) { budgetWait = token.waitMs; break; }
      try {
        const receipt = kind === 'tags' ? await adapter.purgeTags(batch) : await adapter.purgeUrls(batch);
        ids.push(...receipt.ids);
        requests += receipt.requests;
        sent += batch.length;
      } catch (error) {
        const failure = error instanceof EdgeApiError ? error : new EdgeApiError('The purge failed unexpectedly.');
        if (failure.status === 429) bucket!.drain();
        await this.settleAll(rows, rows.map(row => failure.permanent
          ? { state: 'failed' as const, error: failure.message }
          : this.retry(row, failure.message, failure.retryAfterMs)));
        return failure.status === 429 ? (failure.retryAfterMs ?? this.delays[0] ?? 5_000) : undefined;
      }
    }
    const rest = items.slice(sent);
    let remainder: EdgePurgeRecord | undefined;
    if (rest.length) {
      [remainder] = await this.store.enqueueEdgePurges([{ providerId: provider.id, kind, items: rest, reason: rows[0]!.reason, notBeforeMs: budgetWait ?? 1000 }]);
    }
    const receipt = { provider: provider.id, kind, items: sent, requests, ids, ...(remainder ? { deferred: rest.length, deferredTo: remainder.id } : {}) };
    await this.settleAll(rows, rows.map(() => ({ state: 'done' as const, receipt })));
    return budgetWait;
  }

  private retry(row: EdgePurgeRecord, error: string, retryAfterMs?: number): EdgePurgeResult {
    const delay = this.delays[row.attempt - 1];
    if (delay === undefined) return { state: 'failed', error: `${error} No attempts remain (limit ${this.delays.length + 1}).` };
    return { state: 'pending', error, retryAfterMs: Math.max(delay, retryAfterMs ?? 0) };
  }

  private async settleAll(rows: EdgePurgeRecord[], results: EdgePurgeResult[]): Promise<void> {
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i]!, result = results[i]!;
      const recorded = await this.store.settleEdgePurge(row, result);
      if (recorded && result.state !== 'pending') await Promise.resolve(this.options.onSettled?.(row, result)).catch(() => {});
    }
  }

  private schedule(ms: number): void {
    if (this.stopped) return;
    clearTimeout(this.wake);
    this.wake = setTimeout(() => { void this.poll().catch(() => {}); }, Math.min(Math.max(ms, 250), 2 ** 31 - 1));
    this.wake.unref?.();
  }

  private async scheduleNext(budgetWait: number | undefined): Promise<void> {
    let next = budgetWait ?? Infinity;
    try {
      const at = await this.store.nextEdgePurgeAt();
      // At least a second: the store's clock decides what is due, and a small skew must not spin.
      if (at) next = Math.min(next, Math.max(Date.parse(at) - this.now(), 1000));
    } catch { next = Math.min(next, 30_000); }
    if (Number.isFinite(next)) this.schedule(next);
    else clearTimeout(this.wake);
  }
}
