// SPDX-License-Identifier: MPL-2.0
/**
 * Tokens a programme's manager issues for a partner's agent (plans/82 M7
 * section 3), all under `programme.manage` for that programme.
 *
 * A manager mints a token for their own programme, and optionally one company
 * in it, and hands the secret to the partner. The server sets what the body may
 * not: the automation role always; the programme's and the company's groups,
 * never groups from the body; and `via: 'programme'` on the record, so the token
 * never leaves its programme. Scopes are capped at render, documents, files and
 * catalog.read (render and catalog.read by default), the tools must sit inside
 * the programme's own list, and the lifetime defaults to 90 days.
 *
 * `programme.manage` is evaluated against `programme:<id>` and then `*`, so a
 * grant scoped to one programme lets its holder mint, list and revoke only that
 * programme's tokens, while an admin's instance-wide right keeps every programme.
 *
 * Revoking by programme or company, and in bulk exits, stays with the exit
 * routes; a token revoked here stays revoked.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import { randomId } from '../lib/crypto.ts';
import { credentialExpiry, CREDENTIAL_DEFAULT_DAYS } from '../iam/credential-expiry.ts';
import { mintServiceSecret, programmeTokenGroups, tokenPlacement } from '../iam/service-tokens.ts';
import { parseProgrammeTokenScopes } from '../iam/token-scopes.ts';
import { parseLimitOverrides, type createTokenLimits } from '../iam/token-limits.ts';
import { AUTOMATION_ROLE } from '../rbac/evaluate.ts';
import type { ApiTokenRecord, Store, UserRecord } from '../store/types.ts';
import { programmeView } from './routes.ts';

type Router = ReturnType<typeof createRouter>;

/** A token with fewer days than this left is listed as expiring. No notice is
 *  sent: the manager's list is where expiry is read. */
export const EXPIRING_WITHIN_DAYS = 14;

export interface ProgrammeTokenRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  limits: ReturnType<typeof createTokenLimits>;
  now?: () => number;
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_TOKEN_TOOLS = 64;

export function registerProgrammeTokenRoutes(router: Router, deps: ProgrammeTokenRouteDeps): void {
  const { store } = deps;
  const now = deps.now ?? Date.now;
  /** The manager of this programme: a grant on `programme:<id>`, or on every programme. */
  const manager = (req: IncomingMessage, res: ServerResponse, programmeId: string) => deps.requireAction(req, res, 'programme.manage', [`programme:${programmeId}`, '*']);
  const programmeOr404 = async (res: ServerResponse, id: string) => {
    const rec = await store.getProgramme(id);
    if (!rec) sendError(res, 404, 'NOT_FOUND', 'no such programme');
    return rec;
  };
  /** A live or revoked token placed in this programme, or a 404 for any other. */
  const placedOr404 = async (res: ServerResponse, programmeId: string, tokenId: string): Promise<ApiTokenRecord | null> => {
    const token = await store.getApiToken(tokenId);
    if (!token || tokenPlacement(token).programmeId !== programmeId) { sendError(res, 404, 'NOT_FOUND', 'no such token in this programme'); return null; }
    return token;
  };

  /** One row of the manager's list: what was issued, when it ends, and its limits and use. */
  const rows = async (tokens: ApiTokenRecord[]) => {
    const views = await deps.limits.adminViews(tokens);
    const at = now();
    return tokens.map((t) => {
      const placed = tokenPlacement(t);
      const expiresMs = t.expiresAt ? Date.parse(t.expiresAt) : Number.POSITIVE_INFINITY;
      const live = !t.revokedAt && expiresMs > at;
      return {
        id: t.id, label: t.label, company: placed.companyId ?? null, scopes: t.scopes ?? null, tools: t.tools ?? null, via: t.via ?? null,
        createdAt: t.createdAt, expiresAt: t.expiresAt ?? null, lastUsedAt: t.lastUsedAt ?? null, revokedAt: t.revokedAt ?? null,
        live, expired: !t.revokedAt && expiresMs <= at, expiring: live && expiresMs - at < EXPIRING_WITHIN_DAYS * 86_400_000,
        ...views.get(t.id)!,
      };
    });
  };

  // ── mint ───────────────────────────────────────────────────────────────────
  router.add('POST', '/api/v1/programmes/:id/tokens', async (req, res, ctx) => {
    const programmeId = String(ctx.params.id);
    const actor = await manager(req, res, programmeId); if (!actor) return;
    const programme = await programmeOr404(res, programmeId); if (!programme) return;
    const body = await readJson(req) as Record<string, unknown> | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    if (body.groups !== undefined) return sendError(res, 400, 'INVALID_INPUT', 'a programme token takes its groups from the programme and the company, never from the body');
    if (body.role !== undefined && body.role !== AUTOMATION_ROLE) return sendError(res, 400, 'INVALID_INPUT', `a programme token always takes the ${AUTOMATION_ROLE} role`);
    const label = typeof body.label === 'string' ? body.label.trim().slice(0, 80) : '';
    if (!label) return sendError(res, 400, 'INVALID_INPUT', 'label required: name the agent or automation, not a person');
    let companyId: string | undefined;
    if (body.company !== undefined && body.company !== null) {
      const company = typeof body.company === 'string' ? (await store.listCompanies()).find((c) => c.id === body.company) : undefined;
      if (!company || company.programmeId !== programme.id) return sendError(res, 404, 'NOT_FOUND', 'no such company in this programme');
      companyId = company.id;
    }
    const scopes = parseProgrammeTokenScopes(body.scopes);
    if ('error' in scopes) return sendError(res, 400, scopes.code, scopes.error);
    let tools: string[] | undefined;
    if (body.tools !== undefined) {
      if (!scopes.some((scope) => scope === 'render' || scope === 'documents')) return sendError(res, 400, 'INVALID_INPUT', 'a tools list needs the render or documents scope');
      if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > MAX_TOKEN_TOOLS || body.tools.some((t) => typeof t !== 'string' || !TOOL_ID.test(t))) {
        return sendError(res, 400, 'INVALID_INPUT', `tools must list 1 to ${MAX_TOKEN_TOOLS} tool ids`);
      }
      const allowed = new Set((await programmeView(store, programme)).tools);
      const outside = (body.tools as string[]).filter((t) => !allowed.has(t));
      if (outside.length) return sendError(res, 400, 'TOOL_NOT_IN_PROGRAMME', `not in this programme's tools: ${outside.slice(0, 5).join(', ')}`);
      tools = [...new Set(body.tools as string[])].sort();
    }
    let expiresAt: string;
    try { expiresAt = credentialExpiry(body.ttlDays === undefined ? CREDENTIAL_DEFAULT_DAYS : body.ttlDays, now()); }
    catch { return sendError(res, 400, 'INVALID_INPUT', 'ttlDays must be an integer from 1 to 365'); }
    const limits = body.limits === undefined || body.limits === null ? {} : parseLimitOverrides(body.limits);
    if ('error' in limits) return sendError(res, 400, 'INVALID_INPUT', limits.error);
    const { secret, tokenHash } = mintServiceSecret();
    const rec: ApiTokenRecord = {
      id: `tok_${randomId(8)}`, label, role: AUTOMATION_ROLE, scopes, ...(tools ? { tools } : {}),
      groups: programmeTokenGroups(programme.id, companyId), ...(Object.keys(limits).length ? { limits } : {}), via: 'programme',
      tokenHash, createdBy: `user:${actor.id}`, createdAt: new Date(now()).toISOString(), expiresAt,
    };
    await store.putApiToken(rec);
    await deps.audit(`user:${actor.id}`, 'token.create', `token:${rec.id}`, {
      label, role: AUTOMATION_ROLE, scopes, ...(tools ? { tools } : {}), programme: programme.id, ...(companyId ? { company: companyId } : {}),
      expiresAt, ...(rec.limits ? { limits: rec.limits } : {}), via: 'programme',
    });
    const [row] = await rows([rec]);
    // The one and only time the secret exists in a response; the manager hands it to the partner.
    sendJson(res, 201, { ...row, programme: programme.id, token: secret }, { 'cache-control': 'no-store' });
  });

  // ── list ───────────────────────────────────────────────────────────────────
  router.add('GET', '/api/v1/programmes/:id/tokens', async (req, res, ctx) => {
    const programmeId = String(ctx.params.id);
    if (!(await manager(req, res, programmeId))) return;
    if (!(await programmeOr404(res, programmeId))) return;
    const company = ctx.url.searchParams.get('company');
    const tokens = (await store.listApiTokens()).filter((t) => {
      const placed = tokenPlacement(t);
      return placed.programmeId === programmeId && (company === null || placed.companyId === company);
    });
    sendJson(res, 200, { programme: programmeId, tokens: await rows(tokens), expiringWithinDays: EXPIRING_WITHIN_DAYS }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  // ── limits on one token ────────────────────────────────────────────────────
  /** `{ limits }` replaces what the token states, as the owner's route does. */
  router.add('PUT', '/api/v1/programmes/:id/tokens/:tokenId', async (req, res, ctx) => {
    const programmeId = String(ctx.params.id);
    const actor = await manager(req, res, programmeId); if (!actor) return;
    const token = await placedOr404(res, programmeId, String(ctx.params.tokenId)); if (!token) return;
    if (token.revokedAt) return sendError(res, 409, 'TOKEN_REVOKED', 'this token is revoked');
    const body = await readJson(req) as { limits?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.hasOwn(body, 'limits')) {
      return sendError(res, 400, 'INVALID_INPUT', 'send { limits }: callsPerMinute, rendersPerDay and rendersPerMonth, each a whole number or null');
    }
    const parsed = body.limits === null ? {} : parseLimitOverrides(body.limits);
    if ('error' in parsed) return sendError(res, 400, 'INVALID_INPUT', parsed.error);
    const before = { ...(token.limits ?? {}) };
    const next: ApiTokenRecord = { ...token };
    if (Object.keys(parsed).length) next.limits = parsed; else delete next.limits;
    await store.putApiToken(next);
    await deps.audit(`user:${actor.id}`, 'token.limits', `token:${token.id}`, { before, after: { ...parsed }, via: 'programme', programme: programmeId });
    const [row] = await rows([next]);
    sendJson(res, 200, row, { 'cache-control': 'no-store' });
  });

  // ── revoke one ─────────────────────────────────────────────────────────────
  router.add('DELETE', '/api/v1/programmes/:id/tokens/:tokenId', async (req, res, ctx) => {
    const programmeId = String(ctx.params.id);
    const actor = await manager(req, res, programmeId); if (!actor) return;
    const token = await placedOr404(res, programmeId, String(ctx.params.tokenId)); if (!token) return;
    if (!(await store.revokeApiToken(token.id, new Date(now()).toISOString()))) return sendError(res, 404, 'NOT_FOUND', 'no such live token');
    const placed = tokenPlacement(token);
    await deps.audit(`user:${actor.id}`, 'token.revoke', `token:${token.id}`, { via: 'programme', programme: programmeId, ...(placed.companyId ? { company: placed.companyId } : {}) });
    sendJson(res, 200, { ok: true });
  });
}
