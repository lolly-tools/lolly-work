// SPDX-License-Identifier: MPL-2.0
/**
 * Access requests over HTTP (plans/74 invite spec 2.7 R6 to R12; plans/75
 * G13). The rules live in requests.ts; this module checks who is asking,
 * reads the body and answers.
 *
 *   POST /api/v1/projects/:id/access-requests   ask for a project (or ask to edit)
 *   POST /api/v1/sessions/:id/access-requests   the same, from a session link
 *   GET  /api/v1/access-requests/mine           your own asks for one project or session
 *   POST /api/v1/access-requests/:id/withdraw   take your own ask back
 *   GET  /api/v1/access-requests                the requests you may answer now
 *   POST /api/v1/access-requests/:id/approve    approve, with a role for a project
 *   POST /api/v1/access-requests/:id/decline    decline
 *
 * Filing answers 202 `{"ok":true}` whatever happened (a new request, one
 * already open, a cap, an unknown or archived project, access already
 * there, requests switched off), so asking never tells anyone whether a
 * project exists or who runs it. Only the daily allowance answers
 * differently (429), and it counts every ask alike.
 *
 * Who may answer is asked again on every list, approve and decline, against
 * what the request stored and never against anything the client sends:
 * for a project request, anyone who manages that project now (its owner, its
 * managers, and admins and owners through `project.manage`); for a join
 * request, anyone who may invite new people; for a request to use another
 * account, both. Approve claims the request before it changes anything, so
 * of two people answering at once exactly one wins and the other gets 409
 * with who answered.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import { displayName } from '../iam/member.ts';
import { randomId } from '../lib/crypto.ts';
import { inviteDomainAllowed, mayInviteNewPeople, resolveInvitePolicy } from '../policy/invites.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';
import { evaluate, ownerOnlyAction, roleFromGroups, type Grant, type Role } from '../rbac/evaluate.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import {
  PROJECT_MEMBER_ROLES, type AccessRequestRecord, type InvitationProject, type InvitationRecord, type ProjectMemberRole,
  type ProjectRecord, type UserRecord,
} from '../store/types.ts';
import { maskEmail } from './mask.ts';
import { answerNotice, joinApprovedText, noticeContext } from './messages.ts';
import { fileRequest, invitationLive, NOTE_MAX, providerName, retireRequestNotice } from './requests.ts';
import type { MyRequest, RequestDeps, RequestView } from './types.ts';

/** Who an app-side change is made by: the same actor `shareProjectWith` takes. */
export interface ShareActor { principal: string; name: string; userId: string | null }

/** What `issueInvitation` (app.ts, invitation region) takes and answers. */
export interface IssueInvitationInput {
  email: string;
  groups: string[];
  projects: InvitationProject[];
  expiresAt?: string;
  createdVia: 'console' | 'project' | 'request';
  passwordSetup?: boolean;
}
/** A refusal's reason is only reported here (spec 2.9 lists invites-not-allowed,
 *  domain-not-allowed, invitations-off and account-disabled), so any string
 *  the closure gives is taken. */
export type IssueInvitationResult =
  | { status: 'created' | 'existing'; invitation: InvitationRecord }
  | { status: 'already-member'; userIds: string[] }
  | { status: 'refused'; reason: string };

/** What the routes need from the app: the requests core's deps plus the
 *  app closures that share a project, write an invitation and describe one. */
export interface AccessRouteDeps extends RequestDeps {
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: ProjectRecord, grants?: Grant[]): Promise<ProjectAccess>;
  shareProjectWith(
    project: ProjectRecord, target: UserRecord, role: ProjectMemberRole, actor: ShareActor, via: 'request', opts?: { message?: boolean },
  ): Promise<'added' | 'already'>;
  issueInvitation(actor: UserRecord, input: IssueInvitationInput): Promise<IssueInvitationResult>;
  /** The console's wire for an invitation. */
  invitationView(inv: InvitationRecord): unknown;
  /** The personal invite link for one entry of an invitation. */
  inviteLink(inv: Pick<InvitationRecord, 'id' | 'linkVersion'>, projectId: string | null): string;
}

const DAY_MS = 86_400_000;
/** Asks one person may make in a day, project and session links together. */
export const ASKS_PER_DAY = 20;
/** How far back "your own asks" reach for an answered one. */
const MINE_DAYS = 30;
/** The default window of the answered list (the console's "Answered (n)"). */
const ANSWERED_DAYS = 7;
const KINDS_ANSWERED_HERE = ['project', 'join', 'switch'] as const;
/** Lowest to highest, for "does this group's role outrank the approver's"
 *  (the console invitation guard's order). */
const ROLE_RANK: readonly Role[] = ['guest', 'viewer', 'member', 'author', 'approver', 'admin', 'owner'];

const iso = (ms: number): string => new Date(ms).toISOString();
const isMemberRole = (v: unknown): v is ProjectMemberRole =>
  typeof v === 'string' && (PROJECT_MEMBER_ROLES as readonly string[]).includes(v);
/** Open and not yet past its end. */
const liveOpen = (r: AccessRequestRecord, nowMs: number): boolean => r.status === 'open' && Date.parse(r.expiresAt) > nowMs;
/** The status a reader sees: an open row past its end reads as expired. */
const statusOf = (r: AccessRequestRecord, nowMs: number): AccessRequestRecord['status'] =>
  r.status === 'open' && !liveOpen(r, nowMs) ? 'expired' : r.status;
const userIdOf = (principal: string | undefined): string | null => (principal?.startsWith('user:') ? principal.slice(5) : null);
const actorOf = (u: UserRecord): ShareActor => ({ principal: `user:${u.id}`, name: displayName(u), userId: u.id });

const mine = (r: AccessRequestRecord, nowMs: number): MyRequest => ({
  id: r.id, status: statusOf(r, nowMs), role: r.role ?? null, createdAt: r.createdAt,
  answeredAt: r.answeredAt ?? null, answerRole: r.answerRole ?? null,
});

export function registerAccessRoutes(router: ReturnType<typeof createRouter>, d: AccessRouteDeps): void {
  const { store, config } = d;

  // Asks each person made in the day since their first ask in it, per
  // process (like the other route allowances): a brake on a script, not
  // an exact quota.
  const asked = new Map<string, { since: number; n: number }>();
  /** Seconds until this person may ask again, or 0 after counting this ask. */
  const askWait = (userId: string): number => {
    const now = d.now();
    if (asked.size >= 10_000) for (const [id, w] of asked) if (w.since + DAY_MS <= now) asked.delete(id);
    let w = asked.get(userId);
    if (!w || w.since + DAY_MS <= now) { w = { since: now, n: 0 }; asked.set(userId, w); }
    if (w.n >= ASKS_PER_DAY) return Math.max(1, Math.ceil((w.since + DAY_MS - now) / 1000));
    w.n++;
    return 0;
  };

  /**
   * Whether `caller` may answer a request now. One answer per caller and
   * response: grants, the invite policy and each project are read once.
   * Nobody answers their own request.
   */
  const answerers = (caller: UserRecord) => {
    let grants: Promise<Grant[]> | null = null;
    const grantsNow = (): Promise<Grant[]> => (grants ??= store.listGrants());
    const policy = resolveInvitePolicy(config.policy.invites);
    let invites: Promise<boolean> | null = null;
    const mayInvite = (): Promise<boolean> => (invites ??= grantsNow().then((g) => mayInviteNewPeople(caller, g, policy)));
    const manages = new Map<string, Promise<boolean>>();
    const managesProject = (projectId: string | undefined): Promise<boolean> => {
      if (!projectId) return Promise.resolve(false);
      let hit = manages.get(projectId);
      if (!hit) {
        hit = (async () => {
          const project = await store.getProject(projectId);
          return !!project && accessAtLeast(await d.projectAccessOf(caller, project, await grantsNow()), 'manager');
        })();
        manages.set(projectId, hit);
      }
      return hit;
    };
    return {
      grants: grantsNow,
      policy,
      async may(r: AccessRequestRecord): Promise<boolean> {
        if (r.userId === caller.id) return false;
        switch (r.kind) {
          case 'project': return managesProject(r.projectId);
          case 'join': return mayInvite();
          case 'switch': return (await mayInvite()) || (!!r.userId && await managesProject(r.projectId));
          default: return false;
        }
      },
    };
  };

  /**
   * Requests as an approver sees them (`RequestView`). Names come from
   * `nameWithoutEmail`; the invited address on a switch request is masked.
   * Projects, sessions, invitations and people are read once per response.
   */
  const viewsFor = () => {
    const memo = new Map<string, Promise<unknown>>();
    const once = <T>(key: string, load: () => Promise<T>): Promise<T> => {
      let hit = memo.get(key) as Promise<T> | undefined;
      if (!hit) { hit = load(); memo.set(key, hit); }
      return hit;
    };
    const personName = async (principal: string | undefined): Promise<string | null> => {
      const id = userIdOf(principal);
      if (!id) return null;
      const u = await once(`u:${id}`, () => store.getUser(id));
      return u ? nameWithoutEmail(u) : null;
    };
    return async (r: AccessRequestRecord): Promise<RequestView> => {
      const nowMs = d.now();
      const project = r.projectId ? await once(`p:${r.projectId}`, () => store.getProject(r.projectId!)) : null;
      const session = r.viaSessionId ? await once(`s:${r.viaSessionId}`, () => store.getSession(r.viaSessionId!)) : null;
      let invitation: RequestView['invitation'] = null;
      if (r.kind === 'switch' && r.invitationId) {
        const inv = await once(`i:${r.invitationId}`, () => store.getInvitation(r.invitationId!));
        if (inv) {
          const entry = (inv.projects ?? []).find((p) => p.projectId === r.projectId);
          invitation = { id: inv.id, maskedEmail: maskEmail(inv.email), inviter: await personName(entry?.invitedBy ?? inv.invitedBy) };
        }
      }
      const answeredBy = await personName(r.answeredBy);
      return {
        id: r.id, kind: r.kind, status: statusOf(r, nowMs), email: r.email, name: r.name ?? null,
        provider: providerName(config, r.idp), note: r.note ?? null, role: r.role ?? null, currentRole: r.currentRole ?? null,
        project: project ? { id: project.id, name: project.name } : null,
        session: r.viaSessionId
          ? { id: r.viaSessionId, name: session && typeof session.meta?.label === 'string' ? session.meta.label : null }
          : null,
        invitation, createdAt: r.createdAt, expiresAt: r.expiresAt, answeredAt: r.answeredAt ?? null,
        answeredBy: answeredBy ? { name: answeredBy } : null, answerRole: r.answerRole ?? null,
      };
    };
  };

  /** 409 with the request as it stands, so the approver can be told who
   *  answered it and how. `request` also rides inside `error`, for a client
   *  that reads only the error object. */
  const alreadyAnswered = async (res: ServerResponse, id: string): Promise<void> => {
    const now = await store.getAccessRequest(id);
    const request = now ? await viewsFor()(now) : null;
    sendJson(res, 409, {
      error: { code: 'ALREADY_ANSWERED', message: 'this request was already answered', request },
      request,
    });
  };

  /** End a request that can no longer be approved (its project archived, its
   *  person disabled, its invitation over) and answer 409 with why. */
  const endWith = async (
    res: ServerResponse, r: AccessRequestRecord, caller: UserRecord, code: string, message: string,
  ): Promise<void> => {
    const nowMs = d.now();
    const ended = await store.answerAccessRequest(r.id, { status: 'expired', at: iso(nowMs), by: `user:${caller.id}` }, iso(nowMs));
    if (ended) await retireRequestNotice(d, ended);
    sendError(res, 409, code, message);
  };

  // ── asking (R6, R7) ─────────────────────────────────────────────────────

  const ask = async (req: IncomingMessage, res: ServerResponse, target: { projectId: string } | { sessionId: string }): Promise<void> => {
    const user = await d.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const body = (await readJson(req, 16 * 1024)) as { role?: unknown; note?: unknown } | null;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    if (body.role !== 'viewer' && body.role !== 'commenter' && body.role !== 'editor') {
      return sendError(res, 400, 'INVALID_INPUT', 'role must be viewer, commenter or editor', { field: 'role' });
    }
    if (body.note !== undefined && body.note !== null && typeof body.note !== 'string') {
      return sendError(res, 400, 'INVALID_INPUT', 'note must be text', { field: 'note' });
    }
    const note = typeof body.note === 'string' ? body.note : undefined;
    if (note && Array.from(note.trim()).length > NOTE_MAX) {
      return sendError(res, 400, 'INVALID_INPUT', `note must be at most ${NOTE_MAX} characters`, { field: 'note' });
    }
    const wait = askWait(user.id);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return sendError(res, 429, 'RATE_LIMITED', `at most ${ASKS_PER_DAY} requests a day; try again later`);
    }
    let projectId: string | undefined;
    let viaSessionId: string | undefined;
    if ('projectId' in target) projectId = target.projectId;
    else {
      const session = await store.getSession(target.sessionId);
      if (session && !session.deletedAt) { projectId = session.projectId; viaSessionId = session.id; }
    }
    const project = projectId ? await store.getProject(projectId) : null;
    if (project) {
      await fileRequest(d, {
        kind: 'project', user, projectId: project.id, role: body.role, currentRole: await d.projectAccessOf(user, project),
        ...(viaSessionId ? { viaSessionId } : {}), ...(note ? { note } : {}),
      });
    }
    // The same answer for every outcome (security rule 8).
    sendJson(res, 202, { ok: true }, { 'cache-control': 'no-store' });
  };
  router.add('POST', '/api/v1/projects/:id/access-requests', (req, res, ctx) => ask(req, res, { projectId: ctx.params.id! }));
  router.add('POST', '/api/v1/sessions/:id/access-requests', (req, res, ctx) => ask(req, res, { sessionId: ctx.params.id! }));

  // ── your own asks (R8, R9) ──────────────────────────────────────────────

  // Only the caller's own rows for the project (a session resolves to its
  // project, where one request per person is kept): open ones, and those
  // answered in the last 30 days, newest first.
  router.add('GET', '/api/v1/access-requests/mine', async (req, res, ctx) => {
    const user = await d.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const projectParam = ctx.url.searchParams.get('projectId');
    const sessionParam = ctx.url.searchParams.get('sessionId');
    if (!projectParam === !sessionParam) {
      return sendError(res, 400, 'INVALID_INPUT', 'name exactly one of projectId and sessionId');
    }
    const projectId = projectParam ?? (await store.getSession(sessionParam!))?.projectId;
    const nowMs = d.now();
    const rows = projectId
      ? [
        ...await store.listAccessRequests({ status: 'open', now: iso(nowMs), kinds: ['project'], userId: user.id, projectIds: [projectId] }),
        ...await store.listAccessRequests({
          status: 'answered', now: iso(nowMs), kinds: ['project'], userId: user.id, projectIds: [projectId],
          answeredSince: iso(nowMs - MINE_DAYS * DAY_MS),
        }),
      ]
      : [];
    rows.sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0));
    sendJson(res, 200, { requests: rows.map((r) => mine(r, nowMs)) }, { 'cache-control': 'private, no-store' });
  });

  router.add('POST', '/api/v1/access-requests/:id/withdraw', async (req, res, ctx) => {
    const user = await d.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const r = await store.getAccessRequest(ctx.params.id!);
    // Anyone else's request, or none: the same 404.
    if (!r || r.userId !== user.id) return sendError(res, 404, 'NOT_FOUND', 'no such request');
    const nowMs = d.now();
    const withdrawn = liveOpen(r, nowMs)
      ? await store.answerAccessRequest(r.id, { status: 'withdrawn', at: iso(nowMs), by: `user:${user.id}` }, iso(nowMs))
      : null;
    if (!withdrawn) {
      const request = mine((await store.getAccessRequest(r.id)) ?? r, nowMs);
      return sendJson(res, 409, { error: { code: 'ALREADY_ANSWERED', message: 'this request was already answered', request }, request });
    }
    await retireRequestNotice(d, withdrawn);
    await d.audit(`user:${user.id}`, 'access.withdraw', `request:${withdrawn.id}`, { kind: withdrawn.kind });
    sendJson(res, 200, { request: mine(withdrawn, nowMs) });
  });

  // ── answering (R10, R11, R12) ───────────────────────────────────────────

  router.add('GET', '/api/v1/access-requests', async (req, res, ctx) => {
    const caller = await d.memberOf(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    const status = ctx.url.searchParams.get('status') ?? 'open';
    if (status !== 'open' && status !== 'answered') return sendError(res, 400, 'INVALID_INPUT', 'status must be open or answered', { field: 'status' });
    const nowMs = d.now();
    const sinceParam = ctx.url.searchParams.get('since');
    const since = sinceParam ? Date.parse(sinceParam) : nowMs - ANSWERED_DAYS * DAY_MS;
    if (!Number.isFinite(since)) return sendError(res, 400, 'INVALID_INPUT', 'since must be an ISO 8601 date-time', { field: 'since' });
    const rows = await store.listAccessRequests({
      status, now: iso(nowMs), kinds: [...KINDS_ANSWERED_HERE], ...(status === 'answered' ? { answeredSince: iso(since) } : {}),
    });
    const who = answerers(caller);
    const mayAnswer = await Promise.all(rows.map((r) => who.may(r)));
    const view = viewsFor();
    const requests = await Promise.all(rows.filter((_, i) => mayAnswer[i]).map((r) => view(r)));
    sendJson(res, 200, { requests }, { 'cache-control': 'private, no-store' });
  });

  /** The caller and the request, when the caller may answer it now; answers
   *  401, 404, 403 or 409 itself otherwise (null having answered). */
  const answerGate = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const caller = await d.memberOf(req);
    if (!caller) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    const r = await store.getAccessRequest(id);
    if (!r || r.kind === 'invite') { sendError(res, 404, 'NOT_FOUND', 'no such request'); return null; }
    const who = answerers(caller);
    // Request ids are random, so a 403 here tells a stranger nothing.
    if (!(await who.may(r))) { sendError(res, 403, 'FORBIDDEN', 'you cannot answer this request'); return null; }
    if (!liveOpen(r, d.now())) { await alreadyAnswered(res, r.id); return null; }
    return { caller, r, who };
  };

  router.add('POST', '/api/v1/access-requests/:id/approve', async (req, res, ctx) => {
    const gate = await answerGate(req, res, ctx.params.id!);
    if (!gate) return;
    const { caller, r, who } = gate;
    // The body gives a role, and for a join a project to add the person to.
    // The project, the person and the invitation a request is about are what
    // it stored, never what the body says (security rule 10).
    const body = (await readJson(req, 4 * 1024)) as { role?: unknown; projectId?: unknown } | null;
    if (body !== null && (typeof body !== 'object' || Array.isArray(body))) return sendError(res, 400, 'INVALID_INPUT', 'body must be a JSON object');
    if (body?.role !== undefined && body.role !== null && !isMemberRole(body.role)) {
      return sendError(res, 400, 'INVALID_INPUT', 'role must be viewer, editor or manager', { field: 'role' });
    }
    const asked = isMemberRole(body?.role) ? body.role : undefined;
    if (r.kind === 'project') return approveProject(res, caller, r, asked ?? r.role ?? 'viewer', who.policy.projectRoles);
    if (r.kind === 'join') {
      const into = body?.projectId;
      if (into !== undefined && into !== null && into !== '' && typeof into !== 'string') {
        return sendError(res, 400, 'INVALID_INPUT', 'projectId must be a project id', { field: 'projectId' });
      }
      return approveJoin(res, caller, r, who, typeof into === 'string' && into ? { projectId: into, role: asked ?? 'viewer' } : null);
    }
    if (r.userId) return approveSwitchToAccount(res, caller, r, who);
    return approveSwitchMove(res, caller, r, who);
  });

  router.add('POST', '/api/v1/access-requests/:id/decline', async (req, res, ctx) => {
    const gate = await answerGate(req, res, ctx.params.id!);
    if (!gate) return;
    const { caller, r } = gate;
    const nowMs = d.now();
    const declined = await store.answerAccessRequest(r.id, { status: 'declined', at: iso(nowMs), by: `user:${caller.id}` }, iso(nowMs));
    if (!declined) return alreadyAnswered(res, r.id);
    await retireRequestNotice(d, declined);
    // Only a project request comes from an account to tell. The answer never
    // names who declined (security rule 20).
    if (declined.kind === 'project' && declined.userId && declined.projectId) {
      const project = await store.getProject(declined.projectId);
      await d.people.tell({
        message: answerNotice({ request: declined, outcome: 'declined', approver: caller, ...(project ? { projectName: project.name } : {}) },
          noticeContext(config, nowMs)),
        kind: 'answer',
      });
    }
    await d.audit(`user:${caller.id}`, 'access.decline', `request:${declined.id}`, {
      kind: declined.kind, email: declined.email, ...(declined.projectId ? { projectId: declined.projectId } : {}),
    });
    sendJson(res, 200, { request: await viewsFor()(declined) });
  });

  /** Claim the request as approved. Null when someone else answered first. */
  const claim = (r: AccessRequestRecord, caller: UserRecord, role?: ProjectMemberRole) => {
    const at = iso(d.now());
    return store.answerAccessRequest(r.id, { status: 'approved', at, by: `user:${caller.id}`, ...(role ? { role } : {}) }, at);
  };

  /** Run the change an approval makes. The request is already approved, so
   *  a failure leaves it approved: the audit row says `effect: 'failed'` and
   *  someone adds the person by hand. */
  const effect = async <T>(
    res: ServerResponse, caller: UserRecord, approved: AccessRequestRecord, run: () => Promise<T>,
  ): Promise<T | null> => {
    try {
      return await run();
    } catch (err) {
      console.error(`[lolly-work] approving ${approved.id} did not complete: ${(err as Error).message}`);
      await d.audit(`user:${caller.id}`, 'access.approve', `request:${approved.id}`, {
        kind: approved.kind, email: approved.email, ...(approved.projectId ? { projectId: approved.projectId } : {}), effect: 'failed',
      });
      sendError(res, 500, 'INTERNAL', 'the request is approved, but the change did not complete; add the person by hand');
      return null;
    }
  };

  /** A project request: the role must be one the policy gives, the project
   *  live and the person enabled. They are shared in with no share message;
   *  the answer notice tells them, naming the approver. */
  const approveProject = async (
    res: ServerResponse, caller: UserRecord, r: AccessRequestRecord, role: ProjectMemberRole, projectRoles: ProjectMemberRole[],
  ): Promise<void> => {
    if (!projectRoles.includes(role)) {
      return sendError(res, 400, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${role} role`, { field: 'role' });
    }
    const project = await store.getProject(r.projectId!);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such request');
    if (project.archivedAt) return endWith(res, r, caller, 'PROJECT_ARCHIVED', 'the project is archived; restore it before adding people');
    const requester = r.userId ? await store.getUser(r.userId) : null;
    if (!requester || requester.disabledAt) return endWith(res, r, caller, 'REQUESTER_UNAVAILABLE', 'the person who asked can no longer sign in');
    const approved = await claim(r, caller, role);
    if (!approved) return alreadyAnswered(res, r.id);
    await retireRequestNotice(d, approved);
    const outcome = await effect(res, caller, approved, () =>
      d.shareProjectWith(project, requester, role, actorOf(caller), 'request', { message: false }));
    if (!outcome) return;
    const nowMs = d.now();
    await d.people.tell({
      message: answerNotice({ request: approved, outcome: 'approved', approver: caller, projectName: project.name, role }, noticeContext(config, nowMs)),
      kind: 'answer',
    });
    await d.audit(`user:${caller.id}`, 'access.approve', `request:${approved.id}`, {
      kind: 'project', email: approved.email, role, outcome, projectId: project.id,
    });
    sendJson(res, 200, { request: await viewsFor()(approved), outcome });
  };

  /** The refusals an invitation for a new address would meet, asked before
   *  the request is claimed: the domain list, invitations switched off, and
   *  a disabled account holding the address (admission refuses every
   *  account of an address when one is disabled). */
  const newAddressRefusal = async (res: ServerResponse, caller: UserRecord, r: AccessRequestRecord, who: ReturnType<typeof answerers>): Promise<boolean> => {
    if (!inviteDomainAllowed(r.email, who.policy)) {
      sendError(res, 403, 'DOMAIN_NOT_ALLOWED', 'this instance does not invite addresses at that domain');
      return true;
    }
    if (config.idp.admission?.invitations === false) {
      sendError(res, 409, 'INVITATIONS_OFF', 'sign-in does not read invitations on this instance');
      return true;
    }
    if ((await store.findUsersByEmail(r.email)).some((u) => u.disabledAt)) {
      await endWith(res, r, caller, 'REQUESTER_UNAVAILABLE', 'an account with this address is disabled');
      return true;
    }
    return false;
  };

  /** What the approver passes on while nothing is emailed. */
  const signInMessage = (r: AccessRequestRecord) =>
    ({ text: joinApprovedText({ email: r.email, provider: providerName(config, r.idp) }, noticeContext(config, d.now())) });
  const answerInvitation = async (inv: InvitationRecord, projectId: string | null) => ({
    invitation: await d.invitationView(inv),
    ...(invitationLive(inv, d.now()) ? { link: d.inviteLink(inv, projectId) } : {}),
  });
  /**
   * Write the invitation `issueInvitation` would not, because an account
   * already holds the address. That account is not admitted (it would have
   * signed in, and asked as itself), and sign-in admits it only through an
   * invitation, so the approval writes one.
   */
  const invitationForHeldAddress = async (caller: UserRecord, input: IssueInvitationInput): Promise<InvitationRecord> => {
    const { invitation, created } = await store.createInvitation({
      id: `inv_${randomId(10)}`, email: input.email, groups: input.groups, invitedBy: `user:${caller.id}`, createdAt: iso(d.now()),
      ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), projects: input.projects, createdVia: 'request',
    });
    if (created) {
      await d.audit(`user:${caller.id}`, 'invite.create', `invitation:${invitation.id}`, {
        email: input.email, groups: input.groups, ...(input.projects.length ? { projects: input.projects } : {}),
        ...(input.expiresAt ? { expiresAt: input.expiresAt } : {}), via: 'request',
      });
    }
    return invitation;
  };

  /**
   * A join request: an invitation for the verified address, so the
   * person's next sign-in is admitted. The approver may also put a project
   * they manage on it (`into`), which acceptance applies. An address an
   * account already holds gets no invitation ('already'; with `into`, that
   * account is shared the project now, 'added'), unless no invitation
   * admits it any more (one was revoked, say): sign-in still asks for one
   * (`invitationForHeldAddress`).
   */
  const approveJoin = async (
    res: ServerResponse, caller: UserRecord, r: AccessRequestRecord, who: ReturnType<typeof answerers>,
    into: { projectId: string; role: ProjectMemberRole } | null,
  ): Promise<void> => {
    let project: ProjectRecord | null = null;
    if (into) {
      if (!who.policy.projectRoles.includes(into.role)) {
        return sendError(res, 400, 'ROLE_NOT_ALLOWED', `this instance does not allow giving the ${into.role} role`, { field: 'role' });
      }
      project = await store.getProject(into.projectId);
      // The same answer for a project that does not exist and one the
      // approver does not manage.
      if (!project || !accessAtLeast(await d.projectAccessOf(caller, project, await who.grants()), 'manager')) {
        return sendError(res, 403, 'FORBIDDEN', 'you can add people only to a project you manage', { field: 'projectId' });
      }
      if (project.archivedAt) return sendError(res, 400, 'INVALID_INPUT', 'that project is archived', { field: 'projectId' });
    }
    if (await newAddressRefusal(res, caller, r, who)) return;
    const approved = await claim(r, caller, into?.role);
    if (!approved) return alreadyAnswered(res, r.id);
    await retireRequestNotice(d, approved);
    const nowMs = d.now();
    const expiresAt = iso(nowMs + who.policy.maxTtlHours * 3_600_000);
    const entries: InvitationProject[] = project && into ? [{ projectId: project.id, role: into.role, invitedBy: `user:${caller.id}` }] : [];
    const done = await effect(res, caller, approved, async () => {
      const input: IssueInvitationInput = { email: approved.email, groups: [], projects: entries, createdVia: 'request', expiresAt };
      const issued = await d.issueInvitation(caller, input);
      if (issued.status === 'refused') throw new Error(`the invitation was refused (${issued.reason})`);
      if (issued.status !== 'already-member') return { outcome: 'invited' as const, invitation: issued.invitation };
      const active = await store.findActiveInvitation(approved.email);
      const admitsNow = !!active && (!!active.acceptedAt || invitationLive(active, nowMs));
      if (config.idp.admission && !admitsNow) return { outcome: 'invited' as const, invitation: await invitationForHeldAddress(caller, input) };
      let added = false;
      for (const id of project && into ? issued.userIds : []) {
        const holder = await store.getUser(id);
        if (holder && (await d.shareProjectWith(project!, holder, into!.role, actorOf(caller), 'request')) === 'added') added = true;
      }
      return { outcome: added ? 'added' as const : 'already' as const, invitation: null };
    });
    if (!done) return;
    const message = signInMessage(approved);
    await d.people.mail(approved.email, { subject: `You can now sign in to ${config.instance.name}`, text: message.text }, 'join-approved', `user:${caller.id}`);
    await d.audit(`user:${caller.id}`, 'access.approve', `request:${approved.id}`, {
      kind: 'join', email: approved.email, outcome: done.outcome, ...(done.invitation ? { invitationId: done.invitation.id } : {}),
      ...(project && into ? { projectId: project.id, role: into.role } : {}),
    });
    sendJson(res, 200, {
      request: await viewsFor()(approved), outcome: done.outcome,
      ...(done.invitation ? await answerInvitation(done.invitation, project?.id ?? null) : {}), message,
    });
  };

  /** The invitation a switch request was filed on, while it can still be
   *  used; ends the request with 409 otherwise. */
  const liveInvitation = async (res: ServerResponse, caller: UserRecord, r: AccessRequestRecord): Promise<InvitationRecord | null> => {
    const inv = r.invitationId ? await store.getInvitation(r.invitationId) : null;
    if (!inv || !invitationLive(inv, d.now())) {
      await endWith(res, r, caller, 'INVITATION_ENDED', 'the invitation was used, revoked or ended');
      return null;
    }
    return inv;
  };

  /**
   * The groups on an invitation this approver could give directly, under
   * the console's guards (POST /api/v1/invitations): `grant.edit`; never a
   * group whose role outranks the approver's; an owner group, or one holding
   * an owner-only grant, only by an owner; and a group in the local registry,
   * unless an owner names it.
   */
  const grantableGroups = async (approver: UserRecord, groups: string[], grants: Grant[]): Promise<{ give: string[]; skip: string[] }> => {
    if (!groups.length) return { give: [], skip: [] };
    const ctx = { userId: approver.id, groups: approver.groups, role: approver.role as Role };
    if (!evaluate(ctx, 'grant.edit', ['*'], grants)) return { give: [], skip: [...groups] };
    const owner = approver.role === 'owner';
    const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
    const rank = ROLE_RANK.indexOf(approver.role as Role);
    const give: string[] = [];
    const skip: string[] = [];
    for (const g of groups) {
      const role = roleFromGroups([g], config.idp.roleGroups);
      const powered = grants.some((gr) => gr.principal === `group:${g}` && gr.effect === 'allow' && ownerOnlyAction(gr.action));
      const ok = (owner || (role !== 'owner' && !powered && registry.has(g))) && ROLE_RANK.indexOf(role) <= rank;
      (ok ? give : skip).push(g);
    }
    return { give, skip };
  };

  /**
   * A switch request from someone already signed in here: they get what the
   * invitation would have given, as far as the approver could give it
   * directly. Each project the approver manages is shared with them (a role
   * is only ever raised) and taken off the invitation; the invitation's
   * groups are given only under `grantableGroups`. A project-made invitation
   * left with nothing on it is revoked, so the link stops working. 'already'
   * when none of it changed what the account had.
   */
  const approveSwitchToAccount = async (
    res: ServerResponse, caller: UserRecord, r: AccessRequestRecord, who: ReturnType<typeof answerers>,
  ): Promise<void> => {
    const inv = await liveInvitation(res, caller, r);
    if (!inv) return;
    const requester = await store.getUser(r.userId!);
    if (!requester || requester.disabledAt) return endWith(res, r, caller, 'REQUESTER_UNAVAILABLE', 'the person who asked can no longer sign in');
    const tokenEntry = (inv.projects ?? []).find((p) => p.projectId === r.projectId);
    const approved = await claim(r, caller, tokenEntry?.role);
    if (!approved) return alreadyAnswered(res, r.id);
    await retireRequestNotice(d, approved);
    const grants = await who.grants();
    const done = await effect(res, caller, approved, async () => {
      const added: Array<{ projectId: string; role: ProjectMemberRole; name: string }> = [];
      const skippedProjects: string[] = [];
      const at = iso(d.now());
      for (const entry of inv.projects ?? []) {
        const project = await store.getProject(entry.projectId);
        if (!project || project.archivedAt || !who.policy.projectRoles.includes(entry.role)
          || !accessAtLeast(await d.projectAccessOf(caller, project, grants), 'manager')) {
          skippedProjects.push(entry.projectId);
          continue;
        }
        if ((await d.shareProjectWith(project, requester, entry.role, actorOf(caller), 'request', { message: false })) === 'added') {
          added.push({ projectId: project.id, role: entry.role, name: project.name });
        }
        const dropped = await store.dropInvitationProject(inv.id, project.id, at, { revokeWhenEmpty: (inv.createdVia ?? 'console') !== 'console' });
        if (dropped?.revokedAt) {
          await d.audit(`user:${caller.id}`, 'invite.revoke', `invitation:${inv.id}`, { email: inv.email, was: 'pending', via: 'request', projectId: project.id });
        } else if (dropped) {
          await d.audit(`user:${caller.id}`, 'invite.project.remove', `invitation:${inv.id}`, { email: inv.email, projectId: project.id, via: 'request' });
        }
      }
      const groups = await grantableGroups(caller, inv.groups, grants);
      const joined = groups.give.filter((g) => !requester.localGroups.includes(g));
      if (joined.length) {
        const registry = new Set((await store.listLocalGroups()).map((g) => g.name));
        for (const name of joined.filter((g) => !registry.has(g))) await store.putLocalGroup({ name, createdAt: at });
        const updated = await store.setLocalGroups(requester.id, [...requester.localGroups, ...joined]);
        if (updated) await d.audit(`user:${caller.id}`, 'user.local-groups', `user:${updated.id}`, { localGroups: updated.localGroups, via: 'request' });
      }
      return { added, skippedProjects, groups: { given: joined, skipped: groups.skip } };
    });
    if (!done) return;
    const outcome = done.added.length || done.groups.given.length ? 'added' : 'already';
    // The answer names the link's project when it was added, else the first.
    const shown = done.added.find((a) => a.projectId === r.projectId) ?? done.added[0];
    if (shown) {
      await d.people.tell({
        message: answerNotice({
          request: { ...approved, projectId: shown.projectId }, outcome: 'approved', approver: caller, projectName: shown.name, role: shown.role,
        }, noticeContext(config, d.now())),
        kind: 'answer',
      });
    }
    await d.audit(`user:${caller.id}`, 'access.approve', `request:${approved.id}`, {
      kind: 'switch', email: approved.email, outcome, invitationId: inv.id, added: done.added.map((a) => a.projectId),
      ...(done.groups.given.length ? { groups: done.groups.given } : {}),
      ...(done.groups.skipped.length ? { groupsSkipped: done.groups.skipped } : {}),
      ...(approved.projectId ? { projectId: approved.projectId } : {}),
    });
    sendJson(res, 200, {
      request: await viewsFor()(approved), outcome,
      added: done.added.map(({ projectId, role }) => ({ projectId, role })),
      skipped: { projects: done.skippedProjects, groups: done.groups.skipped },
    });
  };

  /**
   * A switch request from someone with no account here: the invitation
   * moves to the address they signed in with. The new invitation carries
   * the same projects, now in the approver's name (acceptance asks their
   * standing again), the groups the approver could give, and the same end.
   * The old one is revoked once the new one exists, so its link stops
   * working and one invitation never admits two people (plans/75 C1).
   */
  const approveSwitchMove = async (
    res: ServerResponse, caller: UserRecord, r: AccessRequestRecord, who: ReturnType<typeof answerers>,
  ): Promise<void> => {
    const old = await liveInvitation(res, caller, r);
    if (!old) return;
    if (await newAddressRefusal(res, caller, r, who)) return;
    const approved = await claim(r, caller);
    if (!approved) return alreadyAnswered(res, r.id);
    await retireRequestNotice(d, approved);
    const grants = await who.grants();
    const nowMs = d.now();
    const done = await effect(res, caller, approved, async () => {
      const groups = await grantableGroups(caller, old.groups, grants);
      const input: IssueInvitationInput = {
        email: approved.email, groups: groups.give,
        projects: (old.projects ?? []).map((p) => ({ projectId: p.projectId, role: p.role, invitedBy: `user:${caller.id}` })),
        createdVia: 'request', expiresAt: old.expiresAt ?? iso(nowMs + who.policy.maxTtlHours * 3_600_000),
      };
      const issued = await d.issueInvitation(caller, input);
      if (issued.status === 'refused') throw new Error(`the new invitation was refused (${issued.reason})`);
      const invitation = issued.status === 'already-member' ? await invitationForHeldAddress(caller, input) : issued.invitation;
      const revoked = await store.revokeInvitation(old.id, iso(d.now()), { pendingOnly: true });
      if (revoked) {
        await d.audit(`user:${caller.id}`, 'invite.revoke', `invitation:${old.id}`, { email: old.email, was: 'pending', via: 'request', to: invitation.id });
      }
      return { invitation, groupsSkipped: groups.skip, oldRevoked: !!revoked };
    });
    if (!done) return;
    await d.audit(`user:${caller.id}`, 'access.approve', `request:${approved.id}`, {
      kind: 'switch', email: approved.email, outcome: 'moved', moved: { from: old.id, to: done.invitation.id },
      ...(done.groupsSkipped.length ? { groupsSkipped: done.groupsSkipped } : {}),
      ...(done.oldRevoked ? {} : { effect: 'old-invitation-kept' }),
      ...(approved.projectId ? { projectId: approved.projectId } : {}),
    });
    sendJson(res, 200, {
      request: await viewsFor()(approved), outcome: 'moved',
      ...await answerInvitation(done.invitation, approved.projectId ?? null),
      message: signInMessage(approved), skipped: { projects: [], groups: done.groupsSkipped },
    });
  };
}
