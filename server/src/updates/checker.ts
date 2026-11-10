// SPDX-License-Identifier: MPL-2.0
/**
 * The release check: reads the release feed once a day, with jitter, and on
 * demand, and keeps the last answer in memory.
 *
 * The request is the one `helm repo update` makes: a plain GET of the index,
 * with no cookie, no user agent, no version and nothing about this instance or
 * its people. It goes through the provider egress guard (catalog/providers/
 * egress.ts): public addresses only, pinned to the DNS answer, bounded in size
 * and time, and parsed off the main thread (feed-thread.ts). The configured
 * feed's own origin may be private, for an internal mirror the operator named; a
 * redirect may leave that origin only for the GitHub release asset hosts (default
 * feed) or the operator's network.providers.redirectOrigins.
 *
 * A failure is logged once, when the check starts failing, and changes nothing
 * else: readiness never depends on it, and the last good answer stays.
 */
import { createProviderFetch, ProviderEgressError, type ProviderNetworkPolicy, type ProviderResolver } from '../catalog/providers/egress.ts';
import { FeedError, newerReleases, type FeedRelease } from './feed.ts';
import { parseChartIndexOffThread } from './feed-thread.ts';
import type { UpdateSettings } from './settings.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** After a success: a day, give or take two hours. */
const NEXT_OK = { base: DAY_MS, jitter: 2 * 60 * 60 * 1000 };
/** After a failure: six hours, give or take one. */
const NEXT_FAILED = { base: 6 * 60 * 60 * 1000, jitter: 60 * 60 * 1000 };
/** The first check after boot: between 30 seconds and 5 minutes. */
const FIRST = { min: 30_000, max: 5 * 60_000 };
/** An on-demand check soon after another answers from memory. */
export const CHECK_COOLDOWN_MS = 30_000;
/** The published index is a few kilobytes a release. */
const FEED_MAX_BYTES = 2 * 1024 * 1024;
const FEED_TIMEOUT_MS = 20_000;
/** Where github.com sends a release asset download. */
const GITHUB_ASSET_ORIGINS = ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com'];

export type CheckStatus = 'off' | 'never' | 'ok' | 'failed';

export interface UpdateSnapshot {
  status: CheckStatus;
  /** When the feed was last read successfully. */
  checkedAt: string | null;
  attemptedAt: string | null;
  /** A closed code for the last failure, never a message from the network. */
  error: string | null;
  current: string;
  /** Releases newer than `current` on the channel, newest first. */
  newer: FeedRelease[];
}

export interface UpdateChecker {
  readonly settings: UpdateSettings;
  snapshot(): UpdateSnapshot;
  /** Read the feed now, or join a check under way. Within the cooldown after
   *  the last attempt the answer comes from memory. */
  checkNow(): Promise<UpdateSnapshot>;
  start(): void;
  stop(): void;
}

type Log = (level: 'info' | 'warn', message: string, fields?: Record<string, unknown>) => void;

export interface CheckerOptions {
  settings: UpdateSettings;
  currentVersion: string;
  network: ProviderNetworkPolicy;
  fetchImpl?: typeof fetch;
  resolver?: ProviderResolver;
  log?: Log;
  now?: () => number;
  random?: () => number;
  /** How long the off-thread parse may take (feed-thread.ts). */
  parseDeadlineMs?: number;
}

/** The network policy for the feed: the operator's, plus the feed's own origin
 *  and the GitHub asset hosts when the feed is on GitHub. */
export function feedNetworkPolicy(settings: UpdateSettings, network: ProviderNetworkPolicy): ProviderNetworkPolicy {
  const origin = new URL(settings.feedUrl).origin;
  return {
    allowedPrivateOrigins: [...new Set([...network.allowedPrivateOrigins, origin])],
    redirectOrigins: [...new Set([...network.redirectOrigins, ...(origin === 'https://github.com' ? GITHUB_ASSET_ORIGINS : [])])],
    maxBytes: FEED_MAX_BYTES,
  };
}

function failureCode(error: unknown): string {
  if (error instanceof FeedError) return error.code;
  if (error instanceof ProviderEgressError) {
    return ({ address: 'refused', url: 'refused', redirect: 'redirect', size: 'too-large', unresolved: 'unresolved' } as Record<string, string>)[error.code] ?? 'unreachable';
  }
  return (error as { name?: string })?.name === 'TimeoutError' ? 'timeout' : 'unreachable';
}

export function createUpdateChecker(options: CheckerOptions): UpdateChecker {
  const { settings, currentVersion } = options;
  const now = options.now ?? Date.now;
  const random = options.random ?? Math.random;
  const log: Log = options.log ?? (() => {});
  const guarded = createProviderFetch(feedNetworkPolicy(settings, options.network), options.fetchImpl, options.resolver);
  let releases: FeedRelease[] = [];
  let checkedAt: number | null = null;
  let attemptedAt: number | null = null;
  let error: string | null = null;
  let running: Promise<UpdateSnapshot> | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let started = false;
  let newestSeen: string | null = null;

  const snapshot = (): UpdateSnapshot => ({
    status: !settings.check ? 'off' : attemptedAt === null ? 'never' : error ? 'failed' : 'ok',
    checkedAt: checkedAt === null ? null : new Date(checkedAt).toISOString(),
    attemptedAt: attemptedAt === null ? null : new Date(attemptedAt).toISOString(),
    error,
    current: currentVersion,
    newer: newerReleases(releases, currentVersion, settings.channel),
  });

  async function read(): Promise<FeedRelease[]> {
    const response = await guarded(settings.feedUrl, {
      headers: { accept: 'application/yaml, text/yaml, text/plain;q=0.9, */*;q=0.1' },
      signal: AbortSignal.timeout(FEED_TIMEOUT_MS),
    });
    if (response.status !== 200) {
      await response.body?.cancel().catch(() => {});
      throw new FeedError('status', `The release feed answered ${response.status}.`);
    }
    return parseChartIndexOffThread(await response.text(), options.parseDeadlineMs ? { deadlineMs: options.parseDeadlineMs } : {});
  }

  async function run(): Promise<UpdateSnapshot> {
    const failedBefore = error !== null;
    attemptedAt = now();
    try {
      releases = await read();
      checkedAt = now();
      error = null;
      const newest = snapshot().newer[0]?.version ?? null;
      if (failedBefore || newest !== newestSeen) {
        log('info', newest ? `release check: Lolly Work ${newest} is available (this server runs ${currentVersion})` : 'release check: this server runs the newest release', { channel: settings.channel });
      }
      newestSeen = newest;
    } catch (failure) {
      error = failureCode(failure);
      if (!failedBefore) log('warn', `release check: the release feed could not be read (${error}); trying again later`, {});
    }
    return snapshot();
  }

  function schedule(delay: number): void {
    if (!started) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void checkNow().finally(() => {
        const next = error ? NEXT_FAILED : NEXT_OK;
        schedule(next.base + (random() * 2 - 1) * next.jitter);
      });
    }, Math.max(0, delay));
    timer.unref?.();
  }

  function checkNow(): Promise<UpdateSnapshot> {
    if (!settings.check) return Promise.resolve(snapshot());
    if (running) return running;
    if (attemptedAt !== null && now() - attemptedAt < CHECK_COOLDOWN_MS) return Promise.resolve(snapshot());
    running = run().finally(() => { running = null; });
    return running;
  }

  return {
    settings,
    snapshot,
    checkNow,
    start() {
      if (started || !settings.check) return;
      started = true;
      schedule(FIRST.min + random() * (FIRST.max - FIRST.min));
    },
    stop() {
      started = false;
      if (timer) clearTimeout(timer);
      timer = null;
    },
  };
}
