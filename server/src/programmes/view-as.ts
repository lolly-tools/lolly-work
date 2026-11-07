/**
 * View as a partner (plans/82 M6): someone who manages a programme sees the app
 * exactly as one of its partners would, read-only, without becoming that partner.
 *
 * The start route checks `programme.manage` for that programme, audits
 * `programme.view-as` and returns a token. The app keeps the token in the one tab
 * that asked and sends it on that tab's requests in the `x-lw-view-as` header,
 * so the admin's other tabs carry on as the admin. A `x-lw-` header counts as a
 * credential for caching (api/router.ts), so no shared cache keeps a view-as answer.
 *
 * The token is never enough on its own. A request carrying it must also be signed
 * in as the admin the token names, at the same session epoch, or it is refused
 * (VIEWING_AS_MISMATCH, audited). The admin must still manage the programme, and the
 * programme and company must still be there.
 *
 * With a valid token:
 *   - the reads a partner's home and tools make (VIEW_AS_READS) answer as a member
 *     of the programme (and company), built the way the console Preview builds its
 *     subject: org-config, the served tool and asset indexes, tool files, shared
 *     browse and the company profile. None of them writes or audits anything;
 *   - the sign-in plumbing under /api/auth/ stays the admin's own;
 *   - every other request is refused with VIEWING_AS, "not while viewing as a
 *     partner": no write happens as the partner or as the admin, and no other read
 *     answers as the admin inside a partner's view.
 * The admin's session, groups and grants never change.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { UserRecord } from '../store/types.ts';
import { COMPANY_GROUP_PREFIX, programmeGroup, withPartnerMarker } from './types.ts';

/** The request header that carries the token. */
export const VIEW_AS_HEADER = 'x-lw-view-as';
/** How long one view-as token lasts. Shown to admins with the other limits. */
export const VIEW_AS_TTL_SEC = 3600;

/** The reads a partner's view makes, answered as the partner. Nothing else is. */
export const VIEW_AS_READS: readonly RegExp[] = [
  /^\/api\/v1\/org-config$/,
  /^\/api\/v1\/inbox$/,
  /^\/catalog\//,
  /^\/tools\//,
  /^\/api\/v1\/catalog\/assets(?:\/|$)/,
  /^\/api\/v1\/me\/company\/profile$/,
];

/** What a token says. Short keys: the token travels on every request of the tab. */
export interface ViewAsClaim {
  v: 1;
  /** The admin's user id. */
  u: string;
  /** The admin's session epoch when the view started. */
  e: number;
  /** The programme id. */
  p: string;
  /** The company id, when the view is of one company. */
  c?: string;
  /** Expiry, seconds since the epoch. */
  exp: number;
}

const b64 = (buf: Buffer | string): string => Buffer.from(buf).toString('base64url');
const mac = (body: string, secret: string): Buffer => createHmac('sha256', `view-as:${secret}`).update(body).digest();

/** Sign a claim with the session secret, under a label of its own. */
export function signViewAs(claim: ViewAsClaim, secret: string): string {
  const body = b64(JSON.stringify(claim));
  return `${body}.${b64(mac(body, secret))}`;
}

/** A valid, unexpired claim from a token, or null. Any of the secrets may have signed it. */
export function readViewAs(token: unknown, secrets: string | readonly string[], now = Date.now()): ViewAsClaim | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const [body, sig, extra] = token.split('.');
  if (!body || !sig || extra !== undefined) return null;
  const given = Buffer.from(sig, 'base64url');
  const ok = (Array.isArray(secrets) ? secrets : [secrets]).some((secret: string) => {
    const want = mac(body, secret);
    return want.length === given.length && timingSafeEqual(want, given);
  });
  if (!ok) return null;
  let claim: ViewAsClaim;
  try { claim = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as ViewAsClaim; } catch { return null; }
  if (claim?.v !== 1 || typeof claim.u !== 'string' || typeof claim.e !== 'number' || typeof claim.p !== 'string'
    || (claim.c !== undefined && typeof claim.c !== 'string') || typeof claim.exp !== 'number') return null;
  return claim.exp * 1000 > now ? claim : null;
}

/** The groups a partner in the claimed programme (and company) holds. */
export function viewAsGroups(claim: Pick<ViewAsClaim, 'p' | 'c'>): string[] {
  return withPartnerMarker([programmeGroup(claim.p), ...(claim.c ? [`${COMPANY_GROUP_PREFIX}${claim.c}`] : [])]);
}

/** The member a view answers as: no record in the store, groups only, the way the
 *  console Preview builds its subject. Its id names the admin, so nothing it reads
 *  can be mistaken for a real person's. */
export function viewAsSubject(claim: ViewAsClaim, role: string, label: string, now = new Date().toISOString()): UserRecord {
  const groups = viewAsGroups(claim);
  return {
    id: `view-as:${claim.u}`, sub: `view-as:${claim.u}`, email: 'view-as@example',
    firstname: 'Example', lastname: label,
    idpGroups: groups, localGroups: [], groups, role,
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  } as UserRecord;
}

/** What org-config says about an active view, for the app's banner. */
export interface ViewingAs { programme: { id: string; name: string }; company?: { id: string; name: string } }

export interface ViewAsDeps {
  /** The admin behind the request's own session cookie, never a token or an agent. */
  sessionMember(req: IncomingMessage): Promise<UserRecord | null>;
  /** True when the request is an agent's or a service token's, which never views as anyone. */
  delegated(req: IncomingMessage): boolean;
  mayManage(user: UserRecord, programmeId: string): Promise<boolean>;
  programme(id: string): Promise<{ id: string; name: string; endedAt?: string } | null>;
  company(id: string): Promise<{ id: string; programmeId: string; name: string; endedAt?: string } | null>;
  roleOf(groups: string[]): string;
  secret: string;
  verifySecrets: string | readonly string[];
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
  now?: () => number;
}

/** One request's view: who answers, and who asked. */
interface ActiveView { member: UserRecord; admin: UserRecord; viewingAs: ViewingAs }

export function createViewAs(deps: ViewAsDeps) {
  const now = () => (deps.now ? deps.now() : Date.now());
  const active = new WeakMap<IncomingMessage, ActiveView>();

  /** The programme and company a claim names, or null when either has gone or ended. */
  const scope = async (claim: Pick<ViewAsClaim, 'p' | 'c'>): Promise<ViewingAs | null> => {
    const programme = await deps.programme(claim.p);
    if (!programme || programme.endedAt) return null;
    if (!claim.c) return { programme: { id: programme.id, name: programme.name } };
    const company = await deps.company(claim.c);
    if (!company || company.endedAt || company.programmeId !== programme.id) return null;
    return { programme: { id: programme.id, name: programme.name }, company: { id: company.id, name: company.name } };
  };

  /**
   * Run before any route. Returns true when it answered the request itself (a refusal).
   * A request with no header passes untouched.
   */
  async function gate(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const header = req.headers[VIEW_AS_HEADER];
    if (header === undefined) return false;
    // The admin's own sign-in plumbing (session, sign-out) stays theirs.
    if (pathname.startsWith('/api/auth/')) return false;
    const claim = readViewAs(Array.isArray(header) ? header[0] : header, deps.verifySecrets, now());
    if (!claim) { sendError(res, 403, 'VIEWING_AS_ENDED', 'This view as a partner has ended. Stop viewing and start again.'); return true; }
    const admin = deps.delegated(req) ? null : await deps.sessionMember(req);
    if (!admin || admin.id !== claim.u || admin.sessionEpoch !== claim.e) {
      await deps.audit(admin ? `user:${admin.id}` : 'anonymous', 'programme.view-as.mismatch', `programme:${claim.p}`, {
        via: 'view-as', claimedUser: claim.u, path: pathname, ...(claim.c ? { company: claim.c } : {}),
      });
      sendError(res, 403, 'VIEWING_AS_MISMATCH', 'This view as a partner belongs to another session.');
      return true;
    }
    const method = req.method ?? 'GET';
    if ((method !== 'GET' && method !== 'HEAD') || !VIEW_AS_READS.some((re) => re.test(pathname))) {
      sendError(res, 403, 'VIEWING_AS', 'Not while viewing as a partner.');
      return true;
    }
    const viewingAs = (await deps.mayManage(admin, claim.p)) ? await scope(claim) : null;
    if (!viewingAs) { sendError(res, 403, 'VIEWING_AS_ENDED', 'This view as a partner has ended. Stop viewing and start again.'); return true; }
    const groups = viewAsGroups(claim);
    const label = viewingAs.company ? viewingAs.company.name : viewingAs.programme.name;
    active.set(req, { member: viewAsSubject(claim, deps.roleOf(groups), label), admin, viewingAs });
    return false;
  }

  /** The partner this request answers as, when it is a view-as read. */
  const member = (req: IncomingMessage): UserRecord | undefined => active.get(req)?.member;

  /** Mark an org-config payload as a view: the banner's names, and no write offered. */
  function decorate<T extends { can: Record<string, boolean> }>(req: IncomingMessage, payload: T): T & { viewingAs?: ViewingAs } {
    const view = active.get(req);
    if (!view) return payload;
    return { ...payload, can: Object.fromEntries(Object.keys(payload.can).map((k) => [k, false])), viewingAs: view.viewingAs };
  }

  function register(router: ReturnType<typeof createRouter>): void {
    /** Start viewing as a member of programme `:id`, or of one company in it. */
    router.add('POST', '/api/v1/programmes/:id/view-as', async (req, res, ctx) => {
      const admin = deps.delegated(req) ? null : await deps.sessionMember(req);
      if (!admin) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      const p = String(ctx.params.id);
      if (!(await deps.mayManage(admin, p))) return sendError(res, 403, 'FORBIDDEN', 'you do not manage this programme');
      const body = ((await readJson(req)) ?? {}) as { company?: unknown };
      if (body.company !== undefined && typeof body.company !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'company must be a company id');
      const c = typeof body.company === 'string' && body.company ? body.company : undefined;
      const viewingAs = await scope({ p, ...(c ? { c } : {}) });
      if (!viewingAs) return sendError(res, 404, 'NOT_FOUND', c ? 'no such company in this programme' : 'no such programme');
      const claim: ViewAsClaim = { v: 1, u: admin.id, e: admin.sessionEpoch, p, ...(c ? { c } : {}), exp: Math.floor(now() / 1000) + VIEW_AS_TTL_SEC };
      await deps.audit(`user:${admin.id}`, 'programme.view-as', `programme:${p}`, { via: 'view-as', ...(c ? { company: c } : {}), expiresAt: new Date(claim.exp * 1000).toISOString() });
      sendJson(res, 201, { token: signViewAs(claim, deps.secret), expiresAt: new Date(claim.exp * 1000).toISOString(), ...viewingAs }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    /** Stop viewing: audited for the record. The token simply stops being sent. */
    router.add('POST', '/api/v1/view-as/end', async (req, res) => {
      const admin = deps.delegated(req) ? null : await deps.sessionMember(req);
      if (!admin) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      const body = ((await readJson(req)) ?? {}) as { token?: unknown };
      const claim = readViewAs(body.token, deps.verifySecrets, now());
      if (claim && claim.u === admin.id) {
        await deps.audit(`user:${admin.id}`, 'programme.view-as.end', `programme:${claim.p}`, { via: 'view-as', ...(claim.c ? { company: claim.c } : {}) });
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    }, { delivery: 'person-private' });
  }

  return { gate, member, decorate, register };
}

export type ViewAs = ReturnType<typeof createViewAs>;
