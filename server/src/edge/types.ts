// SPDX-License-Identifier: MPL-2.0
/**
 * Edge (CDN) adapters in front of an instance hostname (plan 80 section 8).
 *
 * Wave 1 covers public delivery classes only: tags on public responses, purges
 * from the outbox, and read-only zone checks. Edge tokens, `/e/` and `/o/` are
 * not built, so no adapter here may cache an instance-private, link-scoped or
 * per-person response.
 */

export type EdgeKind = 'bunny' | 'cloudflare';
export const EDGE_KINDS: readonly EdgeKind[] = ['bunny', 'cloudflare'];

/**
 * Where a provider is based, where it serves and caches, and where it keeps
 * logs. `unknown` is never treated as EU: an operator states it after reading
 * the provider's data processing terms.
 */
export interface EdgeJurisdiction {
  company: 'eu' | 'us' | 'other' | 'self';
  edgeLocations: 'eu' | 'global' | 'self' | 'unknown';
  logs: 'eu' | 'us' | 'self' | 'unknown';
}

/** A provider's documented purge budget, per account. */
export interface PurgeLimits {
  /** Sustained refill rate. Cloudflare Free allows 5 tag purges per minute (1/12 per second). */
  requestsPerSecond: number;
  /** Bucket size: requests that may be sent at once after a quiet period. */
  burst: number;
  /** Items (tags, URLs, prefixes or hosts) one request may carry. */
  opsPerRequest: number;
}

export interface EdgeCapabilities {
  /** The response header the provider reads purge tags from. */
  tagHeader: string;
  tagSeparator: ',';
  /** The provider's limit on that header's value, in bytes. */
  maxTagHeaderBytes: number;
  tagPurge: PurgeLimits;
  urlPurge: PurgeLimits;
  prefixPurge: PurgeLimits | null;
  hostPurge: PurgeLimits | null;
  /** True when tag and URL purges draw on one budget (Bunny's exact bucket). */
  sharedPurgeBudget: boolean;
  /** Largest object the provider caches; larger responses pass through uncached. */
  maxCacheableBytes: number | null;
  /** When these facts were last checked against the provider's documentation. */
  checkedOn: string;
  /** Facts the documentation did not settle; the probe or a live canary must. */
  unverified: string[];
}

export type FindingStatus = 'pass' | 'fail' | 'warn' | 'info';

/** One zone check. `observed` is a setting value, never a credential. */
export interface ZoneFinding {
  id: string;
  status: FindingStatus;
  message: string;
  observed?: string | number | boolean | null;
}

export type PurgeKind = 'tags' | 'urls' | 'prefixes' | 'hosts';

/** What the outbox stores after a purge. No credential, no response body. */
export interface PurgeReceipt {
  provider: string;
  kind: PurgeKind;
  items: number;
  requests: number;
  /** Provider request ids where the API returns one (Cloudflare `result.id`). */
  ids: string[];
}

/**
 * A provider API answer that did not succeed. The message is already scrubbed
 * of the credential. `permanent` marks a request that will fail the same way
 * on every retry (a malformed item), so the outbox stops trying.
 */
export class EdgeApiError extends Error {
  readonly status: number | null;
  readonly retryAfterMs: number | undefined;
  readonly permanent: boolean;
  constructor(message: string, opts: { status?: number | null; retryAfterMs?: number; permanent?: boolean } = {}) {
    super(message);
    this.name = 'EdgeApiError';
    this.status = opts.status ?? null;
    this.retryAfterMs = opts.retryAfterMs;
    this.permanent = opts.permanent ?? false;
  }
}

export interface EdgeAdapter {
  readonly id: string;
  readonly kind: EdgeKind;
  readonly jurisdiction: EdgeJurisdiction;
  /** Where the zone serves from, as configured: `europe` for a Bunny zone restricted to Europe, else `global`. */
  readonly edgeRegion: string;
  readonly tagHeader: string;
  readonly capabilities: EdgeCapabilities;
  /** Purge by tag. Idempotent; tags are delivery-v1 tags (`b_...`, `t_...`). */
  purgeTags(tags: string[]): Promise<PurgeReceipt>;
  /** Purge exact URLs, each on one of this provider's configured hostnames. */
  purgeUrls(urls: string[]): Promise<PurgeReceipt>;
  /** Read-only checks of the zone's settings against the rules for public delivery. */
  verifyZone(): Promise<ZoneFinding[]>;
}
