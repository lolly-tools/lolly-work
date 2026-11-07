// SPDX-License-Identifier: MPL-2.0
/**
 * Limits and budgets on service tokens (plans/82 M7 section 2).
 *
 * Three figures bound a token: calls a minute, renders a day and renders a
 * month. Each is a whole number or null for no cap. A token placed in a partner
 * programme takes the instance default (`automation.tokenLimits`, seeded at
 * 120 calls a minute, 2,000 renders a day and no monthly cap) unless its
 * programme or the token itself says otherwise; the token wins, then the
 * programme, then the instance. An internal token has no limits unless an
 * owner sets some on the token, so CI and other automation change nothing.
 *
 * Calls are braked by a token bucket keyed by token id, in this process like
 * the per-IP buckets (observability/rate-limit.ts), so replicas each allow the
 * figure. Renders are counted in the store when work is accepted, exactly and
 * across replicas: a request that would pass the day's or the month's budget is
 * refused whole, an idempotent replay counts nothing, and a failed or cancelled
 * render stays counted because the worker's time was spent. Days and months
 * are UTC.
 *
 * Every counted call and render is also added to one row per token and day, which
 * is what the admin views read back: today's use, the busiest minute, and the
 * refusals over a limit. Nothing about the caller beyond its token id is kept.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter, type RouteGuard } from '../api/router.ts';
import { rateLimitSurface, type RateLimiter } from '../observability/rate-limit.ts';
import type { ApiTokenRecord, Store, TokenRenderCharge, TokenUsageDay, UserRecord } from '../store/types.ts';
import type { ProgrammeRecord } from '../programmes/types.ts';
import { tokenPlacement } from './service-tokens.ts';

export const TOKEN_LIMIT_KEYS = ['callsPerMinute', 'rendersPerDay', 'rendersPerMonth'] as const;
export type TokenLimitKey = (typeof TOKEN_LIMIT_KEYS)[number];
/** A whole number caps; null means no cap. */
export type TokenLimits = Record<TokenLimitKey, number | null>;
/** What a token or a programme states. An absent key takes the next level's value. */
export type TokenLimitOverrides = Partial<TokenLimits>;
/** Where a token's figure comes from: set on the token, the programme's default,
 *  the instance default, or none because an internal token has no limit. */
export type TokenLimitSource = 'token' | 'programme' | 'instance' | 'none';
export interface ResolvedTokenLimits { limits: TokenLimits; sources: Record<TokenLimitKey, TokenLimitSource> }

/** The instance default a deployment starts with, `automation.tokenLimits`.
 *  120 calls a minute is the per-IP automation bucket's own refill, so one agent
 *  behind one address meets no new ceiling in normal use; one piece takes 8 to
 *  11 calls. 2,000 renders a day is a full day of batch variants for one partner. */
export const TOKEN_LIMIT_SEED: Readonly<TokenLimits> = Object.freeze({ callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null });

/** The largest figure each limit takes. A limit is at least 1: revoke a token to stop it. */
export const TOKEN_LIMIT_MAX: Readonly<Record<TokenLimitKey, number>> = Object.freeze({ callsPerMinute: 100_000, rendersPerDay: 1_000_000, rendersPerMonth: 31_000_000 });

const LIMIT_WORDS: Record<TokenLimitKey, string> = { callsPerMinute: 'calls a minute', rendersPerDay: 'renders a day', rendersPerMonth: 'renders a month' };

const isPlainObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Read a token's or a programme's limits from a request body. */
export function parseLimitOverrides(raw: unknown, field = 'limits'): TokenLimitOverrides | { error: string } {
  if (!isPlainObject(raw)) return { error: `${field} must be an object with callsPerMinute, rendersPerDay or rendersPerMonth` };
  const unknown = Object.keys(raw).find((key) => !(TOKEN_LIMIT_KEYS as readonly string[]).includes(key));
  if (unknown !== undefined) return { error: `${field} takes callsPerMinute, rendersPerDay and rendersPerMonth, not ${unknown.slice(0, 40)}` };
  // Always in the same key order, so two statements of the same figures compare equal.
  const out: TokenLimitOverrides = {};
  for (const key of TOKEN_LIMIT_KEYS) {
    if (!Object.hasOwn(raw, key)) continue;
    const value = raw[key];
    if (value === null) { out[key] = null; continue; }
    if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > TOKEN_LIMIT_MAX[key]) {
      return { error: `${field}.${key} must be a whole number from 1 to ${TOKEN_LIMIT_MAX[key]}, or null for no cap` };
    }
    out[key] = value as number;
  }
  return out;
}

/** Check `automation.tokenLimits` at boot. Every key is present after the merge with the seed. */
export function checkTokenLimitConfig(raw: unknown): TokenLimits {
  const parsed = parseLimitOverrides(raw, 'automation.tokenLimits');
  if ('error' in parsed) throw new Error(parsed.error);
  return { ...TOKEN_LIMIT_SEED, ...parsed };
}

/** A token's figures and where each comes from. */
export function resolveTokenLimits(
  token: Pick<ApiTokenRecord, 'groups' | 'limits'>,
  programme: Pick<ProgrammeRecord, 'tokenLimits'> | null | undefined,
  instance: Readonly<TokenLimits>,
): ResolvedTokenLimits {
  const partner = tokenPlacement(token).partner;
  const limits = {} as TokenLimits;
  const sources = {} as Record<TokenLimitKey, TokenLimitSource>;
  for (const key of TOKEN_LIMIT_KEYS) {
    if (token.limits && Object.hasOwn(token.limits, key)) { limits[key] = token.limits[key] ?? null; sources[key] = 'token'; }
    else if (!partner) { limits[key] = null; sources[key] = 'none'; }
    else if (programme?.tokenLimits && Object.hasOwn(programme.tokenLimits, key)) { limits[key] = programme.tokenLimits[key] ?? null; sources[key] = 'programme'; }
    else { limits[key] = instance[key]; sources[key] = 'instance'; }
  }
  return { limits, sources };
}

// ── UTC days and months ─────────────────────────────────────────────────────
const DAY_MS = 86_400_000;
export const utcDay = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
const utcMinute = (ms: number): string => new Date(ms).toISOString().slice(0, 16);
const nextUtcDay = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1); };
const nextUtcMonth = (ms: number): number => { const d = new Date(ms); return Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1); };
/** The first day of the month a day falls in. */
export const monthStartDay = (day: string): string => `${day.slice(0, 7)}-01`;

// ── refusals ────────────────────────────────────────────────────────────────
export type TokenLimitCode = 'RATE_LIMITED' | 'BUDGET_EXHAUSTED';

/** A call or a render turned away by a limit: 429 with Retry-After, and the
 *  same code, message and detail over HTTP and inside an MCP tool result. */
export class TokenLimitRefusal extends Error {
  readonly code: TokenLimitCode;
  readonly status = 429;
  readonly detail: Record<string, unknown>;
  readonly retryAfterSec: number;
  constructor(code: TokenLimitCode, message: string, detail: Record<string, unknown>, retryAfterSec: number) {
    super(message);
    this.name = 'TokenLimitRefusal';
    this.code = code;
    this.detail = detail;
    this.retryAfterSec = retryAfterSec;
  }
}

export function sendTokenLimitRefusal(res: ServerResponse, refusal: TokenLimitRefusal): void {
  res.setHeader('retry-after', String(refusal.retryAfterSec));
  sendError(res, refusal.status, refusal.code, refusal.message, refusal.detail);
}

const figure = (n: number): string => n.toLocaleString('en-US');
const seconds = (n: number): string => (n === 1 ? '1 second' : `${figure(n)} seconds`);

export function rateLimitedRefusal(limit: number, retryAfterSec: number): TokenLimitRefusal {
  return new TokenLimitRefusal('RATE_LIMITED', `This token may make ${figure(limit)} calls a minute. Try again in ${seconds(retryAfterSec)}.`,
    { limit, window: 'minute', retryAfterSec }, retryAfterSec);
}

export function budgetRefusal(charge: Extract<TokenRenderCharge, { ok: false }>, requested: number, nowMs: number): TokenLimitRefusal {
  const day = charge.period === 'day';
  const resetsAtMs = day ? nextUtcDay(nowMs) : nextUtcMonth(nowMs);
  const renews = day ? 'The budget renews at 00:00 UTC.'
    : `The budget renews at 00:00 UTC on ${new Date(resetsAtMs).toLocaleDateString('en-GB', { day: 'numeric', month: 'long', timeZone: 'UTC' })}.`;
  const remaining = Math.max(0, charge.limit - charge.used);
  const when = day ? 'today' : 'this month';
  const message = remaining === 0
    ? `This token has used its ${figure(charge.limit)} renders for ${when}. ${renews}`
    : `This request needs ${figure(requested)} renders and this token has ${figure(remaining)} left ${when}. Nothing was started. ${renews}`;
  const retryAfterSec = Math.max(1, Math.ceil((resetsAtMs - nowMs) / 1000));
  return new TokenLimitRefusal('BUDGET_EXHAUSTED', message, {
    limit: charge.limit, period: charge.period, used: charge.used, remaining,
    ...(requested > 1 ? { requested } : {}), resetsAt: new Date(resetsAtMs).toISOString().replace('.000Z', 'Z'),
  }, retryAfterSec);
}

/** One sentence for an agent: this token's limits, in the words the refusals use. */
export function limitsSentence(limits: TokenLimits): string {
  const { callsPerMinute: calls, rendersPerDay: day, rendersPerMonth: month } = limits;
  if (calls === null && day === null && month === null) return 'This token has no call or render limits.';
  const parts = [
    calls === null ? 'any number of calls a minute' : `${figure(calls)} calls a minute`,
    day === null ? 'any number of renders a day' : `${figure(day)} renders a day`,
  ];
  const monthly = month === null ? ', with no monthly cap' : ` and ${figure(month)} renders a month`;
  return `This token may make ${parts.join(' and ')}${monthly}. A call over a limit is refused with RATE_LIMITED or BUDGET_EXHAUSTED and says when to try again.`;
}

// ── the MCP endpoint's own requests ─────────────────────────────────────────
/** The requests the organisation MCP endpoint dispatches for one message it
 *  already counted. An in-process set, never a header, so no outside caller can
 *  mark a request as one of these and skip its count. */
const innerDispatch = new WeakSet<IncomingMessage>();
export function markInnerDispatch(req: IncomingMessage): void { innerDispatch.add(req); }

/** The MCP endpoint counts each message itself once it has read one: a ping and
 *  a notification count nothing. */
const MCP_PATH = '/api/v1/mcp';

/** The token id in a render principal (`service:svc_<id>`), or null for anyone else. */
export function tokenIdOfPrincipal(principal: string): string | null {
  return principal.startsWith('service:svc_') ? principal.slice('service:svc_'.length) : null;
}

// ── use read back ───────────────────────────────────────────────────────────
export interface TokenUsageView {
  today: { day: string; calls: number; renders: number; busiestMinute: number };
  month: { from: string; renders: number };
  /** The last seven UTC days, today included. */
  week: { from: string; rateLimited: number; budgetRefused: number };
  /** The most recent call or render a limit turned away, ever. */
  lastRefusal: { at: string; code: string } | null;
  resetsAt: string;
  monthResetsAt: string;
}

/** What an owner or a manager reads for one token: the figures, where each comes
 *  from, what the token itself states, and its use against them. */
export interface TokenLimitAdminView {
  limits: TokenLimits;
  limitSources: Record<TokenLimitKey, TokenLimitSource>;
  limitOverrides: TokenLimitOverrides;
  usage: TokenUsageView;
}

type LimitStore = Pick<Store, 'getApiToken' | 'getProgramme' | 'listProgrammes' | 'recordTokenCall' | 'recordTokenRefusal'
  | 'chargeTokenRenders' | 'refundTokenRenders' | 'listTokenUsage' | 'latestTokenRefusals'>;

export interface TokenLimitDeps {
  store: LimitStore;
  /** `automation.tokenLimits`, read at boot. */
  instance: Readonly<TokenLimits>;
  /** A limiter of its own, so the per-IP switch never turns a manager's limits off. */
  limiter: RateLimiter;
  now?: () => number;
  /** A call or render a limit turned away, for the metrics. */
  onRefused?(code: TokenLimitCode): void;
}

export function createTokenLimits(deps: TokenLimitDeps) {
  const { store, instance, limiter } = deps;
  const now = deps.now ?? Date.now;
  const iso = (ms: number): string => new Date(ms).toISOString();
  /** A failed write of the use row never turns a call away. */
  const quietly = (what: string) => (error: unknown): void => { console.error(`token limits: ${what} was not recorded: ${(error as Error).message}`); };

  const resolve = async (rec: Pick<ApiTokenRecord, 'groups' | 'limits'>, programmes?: ReadonlyMap<string, ProgrammeRecord>): Promise<ResolvedTokenLimits> => {
    const { programmeId } = tokenPlacement(rec);
    const programme = programmeId ? (programmes ? programmes.get(programmeId) ?? null : await store.getProgramme(programmeId)) : null;
    return resolveTokenLimits(rec, programme, instance);
  };

  const refused = async (tokenId: string, code: TokenLimitCode, at: number): Promise<void> => {
    deps.onRefused?.(code);
    await store.recordTokenRefusal(tokenId, utcDay(at), code, iso(at)).catch(quietly('a refusal'));
  };

  /** Spend one call from the token's minute bucket and count it for the day. */
  const spendCall = async (rec: ApiTokenRecord): Promise<TokenLimitRefusal | null> => {
    const at = now();
    const cap = (await resolve(rec)).limits.callsPerMinute;
    if (cap !== null) {
      const verdict = limiter.take('token', rec.id, { capacity: cap, refillPerSec: cap / 60 });
      if (!verdict.ok) {
        await refused(rec.id, 'RATE_LIMITED', at);
        return rateLimitedRefusal(cap, verdict.retryAfterSec);
      }
    }
    await store.recordTokenCall(rec.id, utcDay(at), utcMinute(at)).catch(quietly('a call'));
    return null;
  };

  /**
   * Count `n` renders for the token a render principal names, when the work is
   * accepted. Throws TokenLimitRefusal when that would pass the day's or the
   * month's budget, so nothing is started. `replay` answers true for a request
   * an idempotency key already names, which counts nothing. The function it
   * returns gives the renders back, for a submission that turned out to be a
   * replay after all or was never accepted.
   */
  const chargeRenders = async (principal: string, n: number, replay?: () => Promise<boolean>): Promise<(() => Promise<void>) | undefined> => {
    const tokenId = tokenIdOfPrincipal(principal);
    if (!tokenId || n < 1) return undefined;
    const rec = await store.getApiToken(tokenId);
    if (!rec || rec.revokedAt) return undefined;
    if (replay && await replay()) return undefined;
    const at = now();
    const day = utcDay(at);
    const { limits } = await resolve(rec);
    const charge = await store.chargeTokenRenders(rec.id, day, n, { day: limits.rendersPerDay, month: limits.rendersPerMonth });
    if (!charge.ok) {
      await refused(rec.id, 'BUDGET_EXHAUSTED', at);
      throw budgetRefusal(charge, n, at);
    }
    let given = false;
    return async () => {
      if (given) return;
      given = true;
      await store.refundTokenRenders(rec.id, day, n);
    };
  };

  /** Today's, this month's and this week's use for each token, in two reads. */
  const usage = async (tokenIds: readonly string[]): Promise<Map<string, TokenUsageView>> => {
    const at = now();
    const today = utcDay(at);
    const weekFrom = utcDay(at - 6 * DAY_MS);
    const monthFrom = monthStartDay(today);
    const from = weekFrom < monthFrom ? weekFrom : monthFrom;
    const [rows, latest] = await Promise.all([store.listTokenUsage(from, today, tokenIds), store.latestTokenRefusals(tokenIds)]);
    const out = new Map<string, TokenUsageView>();
    for (const id of tokenIds) {
      out.set(id, {
        today: { day: today, calls: 0, renders: 0, busiestMinute: 0 }, month: { from: monthFrom, renders: 0 },
        week: { from: weekFrom, rateLimited: 0, budgetRefused: 0 }, lastRefusal: null,
        resetsAt: iso(nextUtcDay(at)), monthResetsAt: iso(nextUtcMonth(at)),
      });
    }
    for (const row of rows as TokenUsageDay[]) {
      const view = out.get(row.tokenId);
      if (!view) continue;
      if (row.day === today) view.today = { day: today, calls: row.calls, renders: row.renders, busiestMinute: row.busiestMinute };
      if (row.day >= monthFrom) view.month.renders += row.renders;
      if (row.day >= weekFrom) { view.week.rateLimited += row.rateLimited; view.week.budgetRefused += row.budgetRefused; }
    }
    for (const last of latest) {
      const view = out.get(last.tokenId);
      if (view) view.lastRefusal = { at: last.at, code: last.code };
    }
    return out;
  };

  /** The admin view of each token, reading the programmes and the use once. */
  const adminViews = async (records: readonly ApiTokenRecord[]): Promise<Map<string, TokenLimitAdminView>> => {
    const programmes = new Map((await store.listProgrammes()).map((p) => [p.id, p]));
    const used = await usage(records.map((r) => r.id));
    const out = new Map<string, TokenLimitAdminView>();
    for (const rec of records) {
      const { limits, sources } = await resolve(rec, programmes);
      out.set(rec.id, { limits, limitSources: sources, limitOverrides: { ...(rec.limits ?? {}) }, usage: used.get(rec.id)! });
    }
    return out;
  };

  /** What the token itself reads: its figures and its use, never where a figure comes from. */
  const ownView = async (rec: ApiTokenRecord): Promise<{ limits: TokenLimits; usage: { today: { calls: number; renders: number }; month: { renders: number }; resetsAt: string } }> => {
    const [{ limits }, used] = await Promise.all([resolve(rec), usage([rec.id])]);
    const view = used.get(rec.id)!;
    return { limits, usage: { today: { calls: view.today.calls, renders: view.today.renders }, month: { renders: view.month.renders }, resetsAt: view.resetsAt } };
  };

  /** Installed after the scope guard: one call for every request a token makes
   *  on the automation surface. The MCP endpoint counts its own messages. */
  const guard = (tokenOf: (req: IncomingMessage) => Promise<{ record: ApiTokenRecord } | false | null>): RouteGuard =>
    async (req, res, route) => {
      if (innerDispatch.has(req)) return true;
      if (route.method === 'POST' && route.path === MCP_PATH) return true;
      if (rateLimitSurface(route.method, new URL(req.url ?? '/', 'http://local').pathname) !== 'automation') return true;
      const token = await tokenOf(req);
      if (!token) return true;
      const refusal = await spendCall(token.record);
      if (!refusal) return true;
      sendTokenLimitRefusal(res, refusal);
      return false;
    };

  return { resolve, spendCall, chargeRenders, usage, adminViews, ownView, guard, instance };
}

// ── the owner's route ───────────────────────────────────────────────────────
type Router = ReturnType<typeof createRouter>;

export interface TokenLimitRouteDeps {
  store: Pick<Store, 'getApiToken' | 'putApiToken'>;
  limits: ReturnType<typeof createTokenLimits>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
}

/** `PUT /api/v1/tokens/:id/limits { limits }`, by an owner (`token.manage`).
 *  The body's `limits` replaces what the token states: a key it leaves out takes
 *  the programme's or the instance's figure, `null` there means no cap, and
 *  `limits: null` or `{}` clears every figure the token states. */
export function registerTokenLimitRoutes(router: Router, deps: TokenLimitRouteDeps): void {
  router.add('PUT', '/api/v1/tokens/:id/limits', async (req, res, ctx) => {
    const actor = await deps.requireAction(req, res, 'token.manage');
    if (!actor) return;
    const token = await deps.store.getApiToken(String(ctx.params.id));
    if (!token || token.revokedAt) return sendError(res, 404, 'NOT_FOUND', 'no such live token');
    const body = await readJson(req) as { limits?: unknown } | null;
    if (!isPlainObject(body) || !Object.hasOwn(body, 'limits')) return sendError(res, 400, 'INVALID_INPUT', 'send { limits }: callsPerMinute, rendersPerDay and rendersPerMonth, each a whole number or null');
    const parsed = body.limits === null ? {} : parseLimitOverrides(body.limits);
    if ('error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);
    const before = { ...(token.limits ?? {}) };
    const next: ApiTokenRecord = { ...token };
    if (Object.keys(parsed).length) next.limits = parsed; else delete next.limits;
    await deps.store.putApiToken(next);
    await deps.audit(`user:${actor.id}`, 'token.limits', `token:${token.id}`, { before, after: { ...parsed } });
    const view = (await deps.limits.adminViews([next])).get(next.id)!;
    sendJson(res, 200, { id: next.id, label: next.label, ...view }, { 'cache-control': 'no-store' });
  });
}

/** Plain words for each limit, for the CLI and the admin views. */
export function limitWords(key: TokenLimitKey): string { return LIMIT_WORDS[key]; }
