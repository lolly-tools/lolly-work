/**
 * View as a partner (plans/82 M6): someone who manages a programme sees the app
 * exactly as one of its partners would, without becoming that partner. While
 * viewing, changes are not saved to the partner's account.
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
 * The admin's session, groups and grants never change. The claim is versioned
 * (`v`) and the audit names the view (`via: 'view-as'`), so acting for a person with
 * their permission can be added later as a new version beside this one.
 */
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { UserRecord } from '../store/types.ts';
import { setViewAsViewer } from '../rbac/evaluate.ts';
import { COMPANY_GROUP_PREFIX, programmeGroup, withPartnerMarker } from './types.ts';

/** The request header that carries the token. */
export const VIEW_AS_HEADER = 'x-lw-view-as';
/** How long one view-as token lasts. Shown to admins with the other limits. */
export const VIEW_AS_TTL_SEC = 3600;

/** The reads a partner's view makes, answered as the partner. Nothing else is. */
export const VIEW_AS_READS: readonly RegExp[] = [
  /^\/api\/v1\/org-config$/,
  // The shell renews its AI lease here; a partner's answer keeps the view's AI as theirs.
  /^\/api\/v1\/policy\/ai$/,
  /^\/api\/v1\/inbox$/,
  /^\/catalog\//,
  /^\/tools\//,
  /^\/api\/v1\/catalog\/assets(?:\/|$)/,
  /^\/api\/v1\/me\/company\/profile$/,
];

/** A WebSocket upgrade from a tab viewing as a partner: the header, or the query
 *  marker a browser has to use, since it cannot set a header on a WebSocket. A view
 *  never joins a live room, as the partner or as the admin. */
export function isViewAsUpgrade(req: IncomingMessage): boolean {
  if (req.headers[VIEW_AS_HEADER] !== undefined) return true;
  try { return new URL(req.url ?? '/', 'http://local').searchParams.has('view-as'); } catch { return true; }
}

/** The sign-in plumbing a viewing tab still needs as the admin: its session, the
 *  boot probe, and signing out. Every other /api/auth/ route is refused with a view. */
const ADMIN_AUTH_KEPT: ReadonlyArray<readonly [string, string]> = [
  ['GET', '/api/auth/session'], ['HEAD', '/api/auth/session'],
  ['GET', '/api/auth/config'], ['HEAD', '/api/auth/config'],
  ['POST', '/api/auth/logout'],
];

/** Thrown when a request that carried a view fails its recheck: the request ends with
 *  403 VIEWING_AS_ENDED and never carries on as anonymous or as the admin. */
export class ViewAsEndedError extends Error {
  readonly status = 403;
  readonly code = 'VIEWING_AS_ENDED';
  constructor() { super('This view as a partner has ended. Stop viewing and start again.'); }
}

/** What a token says. Short keys: the token travels on every request of the tab. */
export interface ViewAsClaim {
  v: 1;
  /** The admin's user id. */
  u: string;
  /** The admin's session epoch when the view started. */
  e: number;
  /** The session the view started in: a hash of the stable id sign-out revokes, so the
   *  token works in that session only, never in another of the same admin's. */
  s: string;
  /** This view's own id. Ending the view records it, so the token stops for good. */
  i: string;
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
    || typeof claim.s !== 'string' || typeof claim.i !== 'string'
    || (claim.c !== undefined && typeof claim.c !== 'string') || typeof claim.exp !== 'number') return null;
  return claim.exp * 1000 > now ? claim : null;
}

/** What a token carries for a session: never the session's own id, a labelled hash of it. */
export function viewAsSessionBinding(sessionKey: string): string {
  return createHash('sha256').update(JSON.stringify(['view-as-session', sessionKey])).digest('base64url').slice(0, 32);
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

/**
 * Keep the browser's own cache apart for a route that can answer both ways: every
 * answer varies on the view header, and an answer to a view is never stored, so
 * switching from one company to another, or back to the admin's own view, never
 * reads bytes cached for the other. Headers a route passes to writeHead are merged.
 */
function partitionCache(res: ServerResponse, view: boolean): void {
  const original = res.writeHead;
  const varyWith = (vary: unknown): string =>
    [...new Set([...String(vary ?? '').split(',').map((v) => v.trim()).filter(Boolean), VIEW_AS_HEADER])].join(', ');
  res.writeHead = function (this: ServerResponse, status: number, ...args: unknown[]) {
    const at = typeof args[0] === 'string' ? 1 : 0;
    const passed = args[at];
    if (passed && typeof passed === 'object' && !Array.isArray(passed)) {
      const headers = { ...(passed as Record<string, unknown>) };
      let vary: unknown = this.getHeader('vary');
      for (const name of Object.keys(headers)) {
        const lower = name.toLowerCase();
        if (lower === 'vary') { vary = headers[name]; delete headers[name]; }
        if (view && lower === 'cache-control') delete headers[name];
      }
      headers.vary = varyWith(vary);
      if (view) headers['cache-control'] = 'no-store';
      args[at] = headers;
    } else {
      this.setHeader('vary', varyWith(this.getHeader('vary')));
      if (view) this.setHeader('cache-control', 'no-store');
    }
    return Reflect.apply(original, this, [status, ...args]);
  } as ServerResponse['writeHead'];
}

/** What org-config says about an active view, for the app's banner. */
export interface ViewingAs { programme: { id: string; name: string }; company?: { id: string; name: string } }

export interface ViewAsDeps {
  /** The admin behind the request's own session cookie, never a token or an agent. */
  sessionMember(req: IncomingMessage): Promise<UserRecord | null>;
  /** True when the request is an agent's or a service token's, which never views as anyone. */
  delegated(req: IncomingMessage): boolean;
  /** The stable id of the request's own cookie session, the one sign-out revokes, or null. */
  sessionKey(req: IncomingMessage): string | null;
  /** Whether a view was ended (POST /api/v1/view-as/end), and recording that it was. */
  viewEnded(viewId: string): Promise<boolean>;
  endView(viewId: string): Promise<void>;
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
interface ActiveView { member: UserRecord; admin: UserRecord; viewingAs: ViewingAs; claim: ViewAsClaim; ended?: boolean; res?: ServerResponse }

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
   * The check every view-as request passes, at the gate and again at every later
   * authentication in the same request: the admin behind the request's own session,
   * at the epoch the token names, before the token's expiry, still managing a
   * programme and company that are still there. Returns what failed, or the view.
   */
  async function check(req: IncomingMessage, claim: ViewAsClaim): Promise<{ fail: 'mismatch'; admin: UserRecord | null } | { fail: 'ended' } | { view: ActiveView }> {
    const admin = deps.delegated(req) || req.headers.authorization !== undefined ? null : await deps.sessionMember(req);
    if (!admin || admin.id !== claim.u || admin.sessionEpoch !== claim.e) return { fail: 'mismatch', admin };
    const sessionKey = deps.sessionKey(req);
    if (!sessionKey || viewAsSessionBinding(sessionKey) !== claim.s) return { fail: 'mismatch', admin };
    if (await deps.viewEnded(claim.i)) return { fail: 'ended' };
    // The gate read an unexpired token, but slow work (a file conversion, say) can
    // carry a request past the expiry, and a later authentication must see that.
    if (claim.exp * 1000 <= now()) return { fail: 'ended' };
    const viewingAs = (await deps.mayManage(admin, claim.p)) ? await scope(claim) : null;
    if (!viewingAs) return { fail: 'ended' };
    const groups = viewAsGroups(claim);
    const label = viewingAs.company ? viewingAs.company.name : viewingAs.programme.name;
    const member = viewAsSubject(claim, deps.roleOf(groups), label);
    // The admin's own denies follow them into the view (rbac/evaluate.ts).
    setViewAsViewer(member.id, { userId: admin.id, groups: admin.groups });
    return { view: { member, admin, viewingAs, claim } };
  }

  const ended = (res: ServerResponse): true => {
    sendError(res, 403, 'VIEWING_AS_ENDED', 'This view as a partner has ended. Stop viewing and start again.');
    return true;
  };

  /**
   * Run before any route. Returns true when it answered the request itself (a refusal).
   * A request with no header passes, with only its cache kept apart from a view's.
   */
  async function gate(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
    const method = req.method ?? 'GET';
    const partnerRead = (method === 'GET' || method === 'HEAD') && VIEW_AS_READS.some((re) => re.test(pathname));
    const header = req.headers[VIEW_AS_HEADER];
    if (header === undefined) { if (partnerRead) partitionCache(res, false); return false; }
    // The admin's own session, boot probe and sign-out stay theirs; no other
    // sign-in route (passkeys, passwords, invitations) is reachable from a view.
    if (pathname.startsWith('/api/auth/')) {
      if (ADMIN_AUTH_KEPT.some(([m, path]) => m === method && path === pathname)) return false;
      sendError(res, 403, 'VIEWING_AS', 'Not while viewing as a partner.');
      return true;
    }
    const claim = readViewAs(Array.isArray(header) ? header[0] : header, deps.verifySecrets, now());
    if (!claim) return ended(res);
    const result = await check(req, claim);
    if ('fail' in result && result.fail === 'mismatch') {
      await deps.audit(result.admin ? `user:${result.admin.id}` : 'anonymous', 'programme.view-as.mismatch', `programme:${claim.p}`, {
        via: 'view-as', view: claim.i, claimedUser: claim.u, path: pathname, ...(claim.c ? { company: claim.c } : {}),
      });
      sendError(res, 403, 'VIEWING_AS_MISMATCH', 'This view as a partner belongs to another session.');
      return true;
    }
    if (!partnerRead) { sendError(res, 403, 'VIEWING_AS', 'Not while viewing as a partner.'); return true; }
    if ('fail' in result) return ended(res);
    active.set(req, { ...result.view, res });
    partitionCache(res, true);
    return false;
  }

  /** End a view's request: the 403 goes out at once, so no route's own error handling
   *  (a catch that would answer 502, say) can turn the end into anything else. */
  const endRequest = (view: ActiveView): never => {
    view.ended = true;
    if (view.res && !view.res.headersSent) {
      try { sendError(view.res, 403, 'VIEWING_AS_ENDED', new ViewAsEndedError().message); } catch { /* the request ends below regardless */ }
    }
    throw new ViewAsEndedError();
  };

  /**
   * Who a request authenticates as, when it is a view: the partner, after the same
   * check the gate ran, so a route that authenticates again after slow work (a file
   * conversion, say) sees an admin who was disabled, signed out everywhere or lost the
   * programme in between. `undefined` when the request is not a view. A view whose
   * check now fails answers 403 VIEWING_AS_ENDED at once and throws ViewAsEndedError,
   * here and at every later authentication in the request, so it never carries on as
   * anonymous or as the admin, and no route's catch can answer anything else.
   */
  async function member(req: IncomingMessage): Promise<UserRecord | undefined> {
    const view = active.get(req);
    if (!view) return undefined;
    if (view.ended) return endRequest(view);
    const result = await check(req, view.claim);
    if ('fail' in result) return endRequest(view);
    active.set(req, { ...result.view, ...(view.res ? { res: view.res } : {}) });
    return result.view.member;
  }

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
      const sessionKey = deps.sessionKey(req);
      if (!sessionKey) return sendError(res, 401, 'UNAUTHORIZED', 'sign in again first');
      const claim: ViewAsClaim = { v: 1, u: admin.id, e: admin.sessionEpoch, s: viewAsSessionBinding(sessionKey), i: randomBytes(12).toString('base64url'),
        p, ...(c ? { c } : {}), exp: Math.floor(now() / 1000) + VIEW_AS_TTL_SEC };
      await deps.audit(`user:${admin.id}`, 'programme.view-as', `programme:${p}`, { via: 'view-as', view: claim.i, ...(c ? { company: c } : {}), expiresAt: new Date(claim.exp * 1000).toISOString() });
      sendJson(res, 201, { token: signViewAs(claim, deps.secret), expiresAt: new Date(claim.exp * 1000).toISOString(), ...viewingAs }, { 'cache-control': 'no-store' });
    }, { delivery: 'person-private' });

    /** Stop viewing: the view's id is recorded as ended, so the token answers 403
     *  VIEWING_AS_ENDED from then on, wherever it is replayed; audited for the record. */
    router.add('POST', '/api/v1/view-as/end', async (req, res) => {
      const admin = deps.delegated(req) ? null : await deps.sessionMember(req);
      if (!admin) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
      const body = ((await readJson(req)) ?? {}) as { token?: unknown };
      const claim = readViewAs(body.token, deps.verifySecrets, now());
      if (claim && claim.u === admin.id) {
        await deps.endView(claim.i);
        await deps.audit(`user:${admin.id}`, 'programme.view-as.end', `programme:${claim.p}`, { via: 'view-as', view: claim.i, ...(claim.c ? { company: claim.c } : {}) });
      }
      res.writeHead(204, { 'cache-control': 'no-store' });
      res.end();
    }, { delivery: 'person-private' });
  }

  /** Whether this request is an admitted view, for routes that would start work on a read. */
  const viewing = (req: IncomingMessage): boolean => active.has(req);

  return { gate, member, decorate, register, viewing };
}

export type ViewAs = ReturnType<typeof createViewAs>;
