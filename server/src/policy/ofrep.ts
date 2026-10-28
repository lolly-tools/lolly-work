/**
 * The organisation's flag service, asked through the OpenFeature Remote
 * Evaluation Protocol (OFREP; the OpenAPI document is service/openapi.yaml in
 * github.com/open-feature/protocol). flagd, GO Feature Flag or any other
 * service that answers OFREP can then decide the default of the shell's
 * governed flags, while the shell keeps reading one resolved value from
 * org-config and never talks to the vendor itself.
 *
 * What is sent: one `POST <url>/ofrep/v1/evaluate/flags/<keyPrefix><flag id>`
 * per governed flag, with the body `{ "context": { "groups": [...], "role": "..." } }`.
 * `groups` are the person's effective groups (narrowed to `contextGroups` when
 * that list is set), sorted; `role` is their Work role. No email, name, user id
 * or session id is sent. `targetingKey` is left out unless `targetingKey:
 * "cohort"` asks for one; that key is a hash of the same groups and role, so it
 * is shared by everyone with that combination and identifies no person. The
 * bearer credential (LW_OFREP_TOKEN) is sent as `Authorization: Bearer`, or as
 * `X-API-Key` with `auth: "api-key"`; both are the spec's own schemes.
 *
 * Failure is closed to Work: any error, timeout, non-boolean value or
 * unparseable answer leaves the flag on Work's own governed value (group rules,
 * then the instance setting, then the shell's built-in default). An answer
 * with no `value` (the spec's code default) or with reason `DISABLED` means
 * the same, without counting as an error. Answers are cached per flag and per
 * context, because many people share one combination of groups and role.
 */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { serviceUrl } from '../lib/service-url.ts';
import { GOVERNABLE_FLAGS, isGroupScopedFlag } from './feature-flags.ts';

export type OfrepAuth = 'bearer' | 'api-key';
export type OfrepTargetingKey = 'none' | 'cohort';

/** `featureFlags.ofrep` in instance.json, after validation. */
export interface OfrepConfig {
  /** The service's base URL; `/ofrep/v1/...` is appended. HTTPS, or HTTP to
   *  a loopback address outside production, the rule for every outbound service. */
  url: string;
  /** Which governed flags the service decides. Absent means every flag that
   *  is not instance-only. */
  flags?: string[];
  /** Prepended to the flag id to form the service's flag key. */
  keyPrefix?: string;
  /** Per-request budget in milliseconds, from connect to the last body byte. */
  timeoutMs: number;
  /** How long an answer is reused for the same flag and context. */
  cacheSeconds: number;
  /** When set, only these group names are sent; others never leave Work. */
  contextGroups?: string[];
  targetingKey: OfrepTargetingKey;
  auth: OfrepAuth;
}

export const OFREP_DEFAULTS = { timeoutMs: 500, cacheSeconds: 30, targetingKey: 'none', auth: 'bearer' } as const;
const OFREP_KEYS = ['url', 'flags', 'keyPrefix', 'timeoutMs', 'cacheSeconds', 'contextGroups', 'targetingKey', 'auth'];
const KEY_PREFIX = /^[A-Za-z0-9._:/-]{0,64}$/;
const GROUP_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;

/** Validate and fill `featureFlags.ofrep` in place. Throws with the field name
 *  on a bad shape, so a typo stops the boot instead of leaving a flag ungoverned. */
export function validateOfrepConfig(value: unknown, requireHttps: boolean): asserts value is OfrepConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('featureFlags.ofrep must be an object');
  const v = value as Record<string, unknown>;
  const unknown = Object.keys(v).find((key) => !OFREP_KEYS.includes(key));
  if (unknown) throw new Error(`featureFlags.ofrep has an unknown key "${unknown}"`);
  if (typeof v.url !== 'string') throw new Error('featureFlags.ofrep.url is required');
  try { v.url = serviceUrl(v.url, requireHttps); }
  catch { throw new Error('featureFlags.ofrep.url requires HTTPS; HTTP is only for explicit loopback evaluation, without credentials, query or fragment'); }
  if (v.flags !== undefined) {
    if (!Array.isArray(v.flags) || !v.flags.length || new Set(v.flags).size !== v.flags.length
      || v.flags.some((id) => typeof id !== 'string' || !isGroupScopedFlag(id))) {
      throw new Error(`featureFlags.ofrep.flags must list governed flag ids, each once (${governedIds().join(', ')})`);
    }
  }
  if (v.keyPrefix !== undefined && (typeof v.keyPrefix !== 'string' || !KEY_PREFIX.test(v.keyPrefix))) {
    throw new Error('featureFlags.ofrep.keyPrefix must be up to 64 letters, digits or . _ : / -');
  }
  v.timeoutMs ??= OFREP_DEFAULTS.timeoutMs;
  if (!Number.isInteger(v.timeoutMs) || (v.timeoutMs as number) < 50 || (v.timeoutMs as number) > 5000) {
    throw new Error('featureFlags.ofrep.timeoutMs must be a whole number from 50 to 5000');
  }
  v.cacheSeconds ??= OFREP_DEFAULTS.cacheSeconds;
  if (!Number.isInteger(v.cacheSeconds) || (v.cacheSeconds as number) < 1 || (v.cacheSeconds as number) > 3600) {
    throw new Error('featureFlags.ofrep.cacheSeconds must be a whole number from 1 to 3600');
  }
  if (v.contextGroups !== undefined) {
    if (!Array.isArray(v.contextGroups) || v.contextGroups.length > 500 || new Set(v.contextGroups).size !== v.contextGroups.length
      || v.contextGroups.some((g) => typeof g !== 'string' || g !== g.trim() || !GROUP_NAME.test(g))) {
      throw new Error('featureFlags.ofrep.contextGroups must list up to 500 group names, each once');
    }
  }
  v.targetingKey ??= OFREP_DEFAULTS.targetingKey;
  if (v.targetingKey !== 'none' && v.targetingKey !== 'cohort') throw new Error('featureFlags.ofrep.targetingKey must be "none" or "cohort"');
  v.auth ??= OFREP_DEFAULTS.auth;
  if (v.auth !== 'bearer' && v.auth !== 'api-key') throw new Error('featureFlags.ofrep.auth must be "bearer" or "api-key"');
}

function governedIds(): string[] {
  return GOVERNABLE_FLAGS.filter((f) => isGroupScopedFlag(f.id)).map((f) => f.id);
}

/** Who a flag is evaluated for. Only these two facts can reach the service. */
export interface OfrepSubject { groups: readonly string[]; role: string }

/** The evaluation context sent for one person: their groups (narrowed by
 *  `contextGroups`), their role and, only on request, a cohort key. */
export function ofrepContext(config: Pick<OfrepConfig, 'contextGroups' | 'targetingKey'>, subject: OfrepSubject): Record<string, unknown> {
  const allowed = config.contextGroups ? new Set(config.contextGroups) : null;
  const groups = [...new Set(subject.groups)]
    .filter((g) => typeof g === 'string' && g.length > 0 && (!allowed || allowed.has(g)))
    .sort();
  const context: Record<string, unknown> = { groups, role: subject.role };
  if (config.targetingKey === 'cohort') {
    context.targetingKey = `cohort-${sha256Hex(canonicalJson({ groups, role: subject.role })).slice(0, 32)}`;
  }
  return context;
}

/** Why an evaluation fell back to Work's value: a fixed set, so it can label a metric. */
export type OfrepErrorReason =
  | 'timeout' | 'network' | 'unauthorized' | 'not_found' | 'rate_limited'
  | 'targeting_key_missing' | 'invalid_request' | 'server' | 'status'
  | 'bad_response' | 'type_mismatch';

/** Where the resolver reports. app.ts wires the Prometheus registry. */
export interface OfrepMetrics {
  request(flag: string): void;
  error(flag: string, reason: OfrepErrorReason): void;
}

export interface OfrepStats {
  requests: number;
  errors: number;
  lastSuccessAt: string | null;
  lastError: { at: string; flag: string; reason: OfrepErrorReason } | null;
}

export interface OfrepResolver {
  /** The flag ids this service decides. */
  readonly flags: readonly string[];
  /** The service's origin, for the console. Never carries a path or credential. */
  readonly origin: string;
  /** The service's answers for this person, by flag id. A flag missing from
   *  the map stays on Work's governed value. Never throws. */
  evaluate(subject: OfrepSubject): Promise<Map<string, boolean>>;
  stats(): OfrepStats;
}

/** The most cached answers kept; the oldest go first. */
const MAX_CACHE_ENTRIES = 5000;
/** The largest answer read. A flag evaluation is a few hundred bytes. */
const MAX_BODY_BYTES = 64 * 1024;
/** Transient failures are retried sooner than a stable answer is refreshed. */
const RETRY_FLOOR_MS = 5000;
/** A 429's Retry-After is honoured up to this long. */
const MAX_RETRY_AFTER_MS = 60_000;

class OfrepFailure extends Error {
  readonly reason: OfrepErrorReason;
  readonly retryAfterMs: number | undefined;
  constructor(reason: OfrepErrorReason, retryAfterMs?: number) {
    super(reason);
    this.reason = reason;
    this.retryAfterMs = retryAfterMs;
  }
}

interface Outcome { value: boolean | undefined; ttlMs: number }

export function createOfrepResolver(opts: {
  config: OfrepConfig;
  /** LW_OFREP_TOKEN. Absent sends no credential (a flagd without auth). */
  token?: string;
  fetchImpl?: typeof fetch;
  metrics?: OfrepMetrics;
  now?: () => number;
}): OfrepResolver {
  const { config, token, metrics } = opts;
  const fetchImpl = opts.fetchImpl ?? fetch;
  const now = opts.now ?? Date.now;
  const flags = Object.freeze([...(config.flags ?? governedIds())]);
  const base = config.url.replace(/\/+$/, '');
  const cacheMs = config.cacheSeconds * 1000;
  const shortMs = Math.min(cacheMs, RETRY_FLOOR_MS);
  const cache = new Map<string, { value: boolean | undefined; expires: number }>();
  const inflight = new Map<string, Promise<boolean | undefined>>();
  const stats: OfrepStats = { requests: 0, errors: 0, lastSuccessAt: null, lastError: null };
  const authHeaders: Record<string, string> = !token ? {}
    : config.auth === 'api-key' ? { 'x-api-key': token } : { authorization: `Bearer ${token}` };
  let lastLog = { reason: '', at: 0 };

  const request = async (flag: string, context: Record<string, unknown>): Promise<Outcome> => {
    const key = `${config.keyPrefix ?? ''}${flag}`;
    stats.requests += 1;
    metrics?.request(flag);
    let res: Response;
    try {
      res = await fetchImpl(`${base}/ofrep/v1/evaluate/flags/${encodeURIComponent(key)}`, {
        method: 'POST',
        redirect: 'error',
        signal: AbortSignal.timeout(config.timeoutMs),
        headers: { 'content-type': 'application/json', accept: 'application/json', ...authHeaders },
        body: JSON.stringify({ context }),
      });
    } catch (e) {
      throw new OfrepFailure(isTimeout(e) ? 'timeout' : 'network');
    }
    let text: string;
    try { text = await readCapped(res); }
    catch (e) { throw new OfrepFailure(isTimeout(e) ? 'timeout' : e instanceof OfrepFailure ? e.reason : 'network'); }
    if (res.status === 200) {
      let body: unknown;
      try { body = JSON.parse(text); } catch { throw new OfrepFailure('bad_response'); }
      if (!body || typeof body !== 'object' || Array.isArray(body)) throw new OfrepFailure('bad_response');
      const b = body as Record<string, unknown>;
      // No value is the spec's code default, and DISABLED means the service has
      // switched the flag off for itself: either way Work's value applies.
      if (!Object.hasOwn(b, 'value') || b.reason === 'DISABLED') return { value: undefined, ttlMs: cacheMs };
      if (typeof b.value !== 'boolean') throw new OfrepFailure('type_mismatch');
      return { value: b.value, ttlMs: cacheMs };
    }
    if (res.status === 401 || res.status === 403) throw new OfrepFailure('unauthorized');
    if (res.status === 404) throw new OfrepFailure('not_found');
    if (res.status === 429) throw new OfrepFailure('rate_limited', retryAfterMs(res.headers.get('retry-after'), now()));
    if (res.status === 400) {
      let code: unknown;
      try { code = (JSON.parse(text) as Record<string, unknown>)?.errorCode; } catch { /* the status alone decides */ }
      throw new OfrepFailure(code === 'TARGETING_KEY_MISSING' ? 'targeting_key_missing' : 'invalid_request');
    }
    throw new OfrepFailure(res.status >= 500 ? 'server' : 'status');
  };

  const fail = (flag: string, failure: OfrepFailure): Outcome => {
    stats.errors += 1;
    const at = now();
    stats.lastError = { at: new Date(at).toISOString(), flag, reason: failure.reason };
    metrics?.error(flag, failure.reason);
    // One line per reason a minute at most: a dead service must not flood the log.
    if (lastLog.reason !== failure.reason || at - lastLog.at > 60_000) {
      lastLog = { reason: failure.reason, at };
      console.warn(`[lolly-work] flag service: ${flag} kept Work's value (${failure.reason})`);
    }
    // Stable answers (a missing flag, a refused credential, a bad shape) are
    // asked again after the normal cache time; transient ones sooner.
    const transient = ['timeout', 'network', 'server', 'status'].includes(failure.reason);
    const ttlMs = failure.reason === 'rate_limited'
      ? Math.max(shortMs, failure.retryAfterMs ?? shortMs)
      : transient ? shortMs : cacheMs;
    return { value: undefined, ttlMs };
  };

  const one = (flag: string, context: Record<string, unknown>, contextKey: string): Promise<boolean | undefined> => {
    const key = `${flag}\u0000${contextKey}`;
    const hit = cache.get(key);
    if (hit && hit.expires > now()) return Promise.resolve(hit.value);
    const pending = inflight.get(key);
    if (pending) return pending;
    const run = request(flag, context)
      .then((outcome) => {
        stats.lastSuccessAt = new Date(now()).toISOString();
        return outcome;
      }, (e) => fail(flag, e instanceof OfrepFailure ? e : new OfrepFailure('network')))
      .then(({ value, ttlMs }) => {
        cache.delete(key);
        if (cache.size >= MAX_CACHE_ENTRIES) {
          for (const [k, entry] of cache) if (entry.expires <= now()) cache.delete(k);
          if (cache.size >= MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value!);
        }
        cache.set(key, { value, expires: now() + ttlMs });
        return value;
      })
      .finally(() => inflight.delete(key));
    inflight.set(key, run);
    return run;
  };

  return {
    flags,
    origin: new URL(base).origin,
    async evaluate(subject) {
      const context = ofrepContext(config, subject);
      const contextKey = canonicalJson(context);
      const answers = await Promise.all(flags.map((flag) => one(flag, context, contextKey)));
      const out = new Map<string, boolean>();
      flags.forEach((flag, i) => {
        const value = answers[i];
        if (value !== undefined) out.set(flag, value);
      });
      return out;
    },
    stats: () => ({ ...stats, lastError: stats.lastError ? { ...stats.lastError } : null }),
  };
}

function isTimeout(e: unknown): boolean {
  const name = (e as { name?: string } | null)?.name;
  return name === 'TimeoutError' || name === 'AbortError';
}

/** Read at most MAX_BODY_BYTES; a longer answer is not a flag evaluation. */
async function readCapped(res: Response): Promise<string> {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    await res.body?.cancel().catch(() => {});
    throw new OfrepFailure('bad_response');
  }
  if (!res.body) return '';
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BODY_BYTES) {
      await reader.cancel().catch(() => {});
      throw new OfrepFailure('bad_response');
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** Retry-After as seconds or an HTTP date, bounded to a minute. */
function retryAfterMs(header: string | null, nowMs: number): number | undefined {
  if (!header) return undefined;
  const seconds = Number(header);
  const ms = Number.isFinite(seconds) ? seconds * 1000 : Date.parse(header) - nowMs;
  if (!Number.isFinite(ms) || ms <= 0) return undefined;
  return Math.min(ms, MAX_RETRY_AFTER_MS);
}
