// SPDX-License-Identifier: MPL-2.0
/**
 * A token bucket for one provider purge budget. Each server process keeps its
 * own bucket; with several replicas the provider's 429 and Retry-After are the
 * backstop, and the outbox backs off on them.
 */
import type { PurgeLimits } from './types.ts';

export class TokenBucket {
  private tokens: number;
  private last: number;
  private readonly limits: Pick<PurgeLimits, 'requestsPerSecond' | 'burst'>;
  private readonly now: () => number;
  constructor(limits: Pick<PurgeLimits, 'requestsPerSecond' | 'burst'>, now: () => number = Date.now) {
    this.limits = limits;
    this.now = now;
    this.tokens = limits.burst;
    this.last = now();
  }
  private refill(): void {
    const at = this.now();
    this.tokens = Math.min(this.limits.burst, this.tokens + ((at - this.last) / 1000) * this.limits.requestsPerSecond);
    this.last = at;
  }
  /** Whole requests that may be sent now. */
  available(): number {
    this.refill();
    return Math.floor(this.tokens);
  }
  /** How long until one whole token is free; 0 when one is free now. */
  waitMs(): number {
    this.refill();
    if (this.tokens >= 1) return 0;
    const rate = this.limits.requestsPerSecond;
    return rate > 0 ? Math.ceil(((1 - this.tokens) / rate) * 1000) : 60_000;
  }
  /** Take one request's token, or return how long to wait before one is free. */
  take(): { ok: true } | { ok: false; waitMs: number } {
    const waitMs = this.waitMs();
    if (waitMs === 0) { this.tokens -= 1; return { ok: true }; }
    return { ok: false, waitMs };
  }
  /** Spend the rest of the budget after the provider said 429. */
  drain(): void { this.refill(); this.tokens = Math.min(this.tokens, 0); }
}
