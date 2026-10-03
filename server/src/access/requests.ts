// SPDX-License-Identifier: MPL-2.0
/**
 * Access requests, the core (plans/75 G13; plans/74 invite spec 2.9). One
 * object serves four asks:
 *
 *   project  a member asks for a project they cannot open, or a viewer asks
 *            to edit (the route passes their access as `currentRole`)
 *   join     someone who signed in but is not admitted asks to be let in
 *   switch   someone holding an invite link, signed in with another
 *            account, asks to use that account instead (plans/75 C1)
 *   invite   reserved: a manager asking an admin to invite an address
 *
 * The email on a request always comes from a sign-in the server just
 * verified: the member's account, or an `lw/ask` token minted on the page
 * that sign-in rendered. Filing gives the person the same answer whatever
 * happened (created, already open, held by a cap, or nothing to ask for),
 * so a request never tells anyone whether a project exists or who runs it.
 *
 * Who may answer is worked out again on every read and every answer
 * (`approversFor`), against what the request stored, never against what a
 * client sends. Every notice goes through `d.people` (notify/people.ts).
 * The routes (access/routes.ts, the server pages) do the HTTP; this module
 * holds the rules, so they are tested without a server.
 */
import type { InstanceConfig } from '../config/instance.ts';
import { randomId } from '../lib/crypto.ts';
import { mayInviteNewPeople, resolveInvitePolicy } from '../policy/invites.ts';
import { accessAtLeast, effectiveProjectAccess } from '../rbac/project-access.ts';
import type {
  AccessRequestAnswer, AccessRequestKind, AccessRequestMatch, AccessRequestRecord, InvitationRecord, ProjectMemberRole, ProjectRecord, UserRecord,
} from '../store/types.ts';
import { maskEmail } from './mask.ts';
import { noticeContext, requestNotice, requestNoticeId } from './messages.ts';
import type { AskIdentity, FileInput, FileOutcome, RequestDeps } from './types.ts';

const DAY_MS = 86_400_000;
/** Longest note a request keeps, in characters. The routes refuse a longer one. */
export const NOTE_MAX = 280;
/** Longest display name a request keeps. */
export const NAME_MAX = 120;
/** Join requests one address may file in `JOIN_WINDOW_DAYS`. */
export const JOIN_PER_EMAIL = 3;
export const JOIN_WINDOW_DAYS = 30;
/** Switch requests one invitation may collect in a day. */
export const SWITCH_PER_INVITATION_PER_DAY = 3;
/** How long the refusal and wrong-account pages show "not approved". */
export const DECLINE_SHOWN_DAYS = 7;
/** Most people told about one request. */
export const APPROVERS_MAX = 50;

const iso = (ms: number): string => new Date(ms).toISOString();
/** Trimmed and cut to `max` characters (code points), or undefined when empty. */
const clip = (s: string | undefined, max: number): string | undefined => {
  const t = s?.trim();
  return t ? Array.from(t).slice(0, max).join('') : undefined;
};
const charCount = (s: string | undefined): number => (s ? Array.from(s).length : 0);

/** Whether this kind of request may be filed. Project requests and join
 *  requests follow `policy.requests`. A switch request is only ever offered
 *  to someone holding a live invite link, and it goes to that invitation's
 *  people, so it follows the invitation rather than a switch of its own. */
export function requestsAllowed(config: Pick<InstanceConfig, 'policy'>, kind: AccessRequestKind): boolean {
  switch (kind) {
    case 'project': return config.policy.requests.project;
    case 'join': return config.policy.requests.join;
    case 'switch': return true;
    default: return false;
  }
}

/** Whether an invitation can still be accepted at `nowMs`: not revoked, not
 *  accepted, not past its end. */
export function invitationLive(inv: InvitationRecord, nowMs: number): boolean {
  return !inv.revokedAt && !inv.acceptedAt && !(inv.expiresAt && Date.parse(inv.expiresAt) <= nowMs);
}

/** The display name of the IdP a request was signed in with, or null. */
export function providerName(config: Pick<InstanceConfig, 'idp' | 'proxyAuth'>, idp: string | undefined): string | null {
  if (!idp) return null;
  if (idp === 'primary') return config.idp.issuer ? (config.idp.displayName || 'SSO') : null;
  if (idp === 'proxy') return config.proxyAuth.displayName || null;
  const extra = config.idp.additional.find((a) => a.id === idp);
  return extra ? (extra.displayName || extra.label || null) : null;
}

const sameKey = (a: Pick<AccessRequestRecord, 'projectId' | 'invitationId'>, b: Pick<AccessRequestRecord, 'projectId' | 'invitationId'>): boolean =>
  (a.projectId ?? '') === (b.projectId ?? '') && (a.invitationId ?? '') === (b.invitationId ?? '');

/** The live open request with the same key as `rec`, if any. */
async function openFor(d: RequestDeps, rec: AccessRequestRecord, now: string): Promise<AccessRequestRecord | undefined> {
  const rows = await d.store.listAccessRequests({
    status: 'open', now, kinds: [rec.kind], email: rec.email,
    ...(rec.projectId ? { projectIds: [rec.projectId] } : {}),
    ...(rec.invitationId ? { invitationId: rec.invitationId } : {}),
  });
  return rows.find((r) => sameKey(r, rec));
}

/** Why a cap holds this request, or null. Project requests are capped per
 *  requester by the route, which answers 429. */
async function capFor(d: RequestDeps, rec: AccessRequestRecord, nowMs: number): Promise<'per-email' | 'workspace-cap' | 'per-invitation' | null> {
  const now = iso(nowMs);
  if (rec.kind === 'join') {
    const recent = await d.store.countAccessRequests({ kind: 'join', email: rec.email, since: iso(nowMs - JOIN_WINDOW_DAYS * DAY_MS), now });
    if (recent >= JOIN_PER_EMAIL) return 'per-email';
  }
  if (rec.kind === 'switch' && rec.invitationId) {
    const today = await d.store.countAccessRequests({ kind: 'switch', invitationId: rec.invitationId, since: iso(nowMs - DAY_MS), now });
    if (today >= SWITCH_PER_INVITATION_PER_DAY) return 'per-invitation';
  }
  if (rec.kind === 'join' || rec.kind === 'switch') {
    const open = await d.store.countAccessRequests({ kind: 'join', openOnly: true, now })
      + await d.store.countAccessRequests({ kind: 'switch', openOnly: true, now });
    if (open >= d.config.policy.requests.joinOpenMax) return 'workspace-cap';
  }
  return null;
}

/** The record a join or switch request stores for a verified sign-in. */
function askRecord(identity: AskIdentity): Pick<AccessRequestRecord, 'email' | 'identitySub' | 'idp' | 'name'> {
  const name = clip(identity.name, NAME_MAX);
  return { email: identity.email.trim().toLowerCase(), identitySub: identity.sub, idp: identity.idp, ...(name ? { name } : {}) };
}

/**
 * File a request. Never throws for a request that cannot go ahead; the
 * outcome says what happened, and the route answers the same either way.
 *
 * - skipped (nothing stored): the kind is off in `policy.requests`; a
 *   project that is unknown or archived, or access already at the role
 *   asked for; a switch on an invitation that is no longer pending and
 *   live, or by the invited address itself.
 * - exists: an open request for the same key, returned as it is.
 * - held (nothing stored, audited `access.request.held`): 3 join requests
 *   from this address in 30 days, 3 switch requests on this invitation in a
 *   day, or `joinOpenMax` open join and switch requests in the workspace.
 * - created: stored; the approvers get an `access-request` notice and the
 *   audit row `access.request` records the note's length, never its text.
 */
export async function fileRequest(d: RequestDeps, input: FileInput): Promise<FileOutcome> {
  const { store, config } = d;
  if (!requestsAllowed(config, input.kind)) return { outcome: 'skipped' };
  const nowMs = d.now();
  const now = iso(nowMs);
  const note = clip(input.note, NOTE_MAX);
  const base = {
    id: `req_${randomId(10)}`, status: 'open' as const, createdAt: now,
    expiresAt: iso(nowMs + config.policy.requests.ttlDays * DAY_MS), ...(note ? { note } : {}),
  };
  let rec: AccessRequestRecord;
  let actor: string;
  if (input.kind === 'project') {
    const project = await store.getProject(input.projectId);
    if (!project || project.archivedAt || accessAtLeast(input.currentRole, input.role)) return { outcome: 'skipped' };
    const name = clip([input.user.firstname, input.user.lastname].filter(Boolean).join(' '), NAME_MAX);
    actor = `user:${input.user.id}`;
    rec = {
      ...base, kind: 'project', email: input.user.email.trim().toLowerCase(), userId: input.user.id, ...(name ? { name } : {}),
      projectId: project.id, ...(input.viaSessionId ? { viaSessionId: input.viaSessionId } : {}),
      role: input.role, currentRole: input.currentRole,
    };
  } else if (input.kind === 'join') {
    actor = 'anonymous';
    rec = { ...base, kind: 'join', ...askRecord(input.identity) };
  } else {
    const asked = askRecord(input.identity);
    const inv = await store.getInvitation(input.invitationId);
    if (!inv || !invitationLive(inv, nowMs) || inv.email === asked.email) return { outcome: 'skipped' };
    // A link for a project the invitation no longer carries reads as a
    // workspace link (invite spec 2.9).
    const projectId = input.projectId && (inv.projects ?? []).some((p) => p.projectId === input.projectId) ? input.projectId : undefined;
    actor = input.userId ? `user:${input.userId}` : 'anonymous';
    rec = {
      ...base, kind: 'switch', ...asked, invitationId: inv.id,
      ...(projectId ? { projectId } : {}), ...(input.userId ? { userId: input.userId } : {}),
    };
  }

  const open = await openFor(d, rec, now);
  if (open) return { outcome: 'exists', request: open };
  const held = await capFor(d, rec, nowMs);
  if (held) {
    await d.audit(actor, 'access.request.held', 'request', { kind: rec.kind, email: rec.email, reason: held });
    return { outcome: 'held' };
  }
  const { request, created } = await store.createAccessRequest(rec, now);
  if (!created) return { outcome: 'exists', request };

  await tellApprovers(d, request);
  await d.audit(actor, 'access.request', `request:${request.id}`, {
    kind: request.kind, requestId: request.id, email: request.email,
    ...(request.projectId ? { projectId: request.projectId } : {}),
    ...(request.viaSessionId ? { viaSessionId: request.viaSessionId } : {}),
    ...(request.invitationId ? { invitationId: request.invitationId } : {}),
    ...(request.role ? { role: request.role } : {}),
    noteChars: charCount(request.note),
  });
  return { outcome: 'created', request };
}

/** Put the `access-request` notice to everyone who may answer now. Nobody
 *  to tell means no notice; the console's Requests card still lists it. */
async function tellApprovers(d: RequestDeps, request: AccessRequestRecord): Promise<void> {
  const approvers = await approversFor(d, request);
  if (!approvers.length) return;
  const project = request.projectId ? await d.store.getProject(request.projectId) : null;
  const invitation = request.kind === 'switch' && request.invitationId ? await d.store.getInvitation(request.invitationId) : null;
  const message = requestNotice({
    request,
    approverIds: approvers.map((u) => u.id),
    provider: providerName(d.config, request.idp),
    ...(project ? { projectName: project.name } : {}),
    ...(invitation ? { maskedInvitee: maskEmail(invitation.email) } : {}),
  }, noticeContext(d.config, d.now()));
  await d.people.tell({ message, kind: 'request' });
}

/**
 * What the refusal and wrong-account pages show about earlier asks from this
 * address: the open request, if there is one, and the latest one declined in
 * the last `DECLINE_SHOWN_DAYS` days.
 */
export async function requestStateFor(
  d: RequestDeps, q: { kind: 'join' | 'switch'; email: string; invitationId?: string },
): Promise<{ open?: AccessRequestRecord; lastDeclined?: AccessRequestRecord }> {
  const nowMs = d.now();
  const now = iso(nowMs);
  const filter = { kinds: [q.kind], email: q.email.trim().toLowerCase(), ...(q.invitationId ? { invitationId: q.invitationId } : {}) };
  const ours = (r: AccessRequestRecord): boolean => (r.invitationId ?? '') === (q.invitationId ?? '');
  const open = (await d.store.listAccessRequests({ status: 'open', now, ...filter })).find(ours);
  const lastDeclined = (await d.store.listAccessRequests({
    status: 'answered', now, ...filter, answeredSince: iso(nowMs - DECLINE_SHOWN_DAYS * DAY_MS), limit: 50,
  })).find((r) => r.status === 'declined' && ours(r));
  return { ...(open ? { open } : {}), ...(lastDeclined ? { lastDeclined } : {}) };
}

/** The owner and the managers of a project, as accounts. */
async function projectManagers(d: RequestDeps, project: ProjectRecord): Promise<UserRecord[]> {
  const ids = [project.ownerId, ...(await d.store.listProjectMembers(project.id)).filter((m) => m.role === 'manager').map((m) => m.userId)];
  const users = await Promise.all([...new Set(ids)].map((id) => d.store.getUser(id)));
  return users.filter((u): u is UserRecord => !!u);
}

/**
 * Who may answer a request now. Asked again on every list, approve and
 * decline, so a manager who was demoted since the request was filed can no
 * longer answer it.
 *
 * - project: the project's owner and its managers. When none of them has an
 *   enabled account, every enabled account that manages the project through
 *   `project.manage` (admins and owners).
 * - join, and switch without an account: everyone who may invite new
 *   people (`mayInviteNewPeople`; on lolly.ing, admins and owners).
 * - switch with an account: the managers of the link's project, then the
 *   people above.
 *
 * Disabled accounts and the requester are never approvers. At most
 * `APPROVERS_MAX`, managers first.
 */
export async function approversFor(d: RequestDeps, req: AccessRequestRecord): Promise<UserRecord[]> {
  const { store, config } = d;
  const out = new Map<string, UserRecord>();
  const add = (u: UserRecord): void => {
    if (!u.disabledAt && u.id !== req.userId && out.size < APPROVERS_MAX) out.set(u.id, u);
  };
  if (req.kind === 'project') {
    const project = req.projectId ? await store.getProject(req.projectId) : null;
    if (!project) return [];
    (await projectManagers(d, project)).forEach(add);
    if (!out.size) {
      const grants = await store.listGrants();
      const members = new Map((await store.listProjectMembers(project.id)).map((m) => [m.userId, m]));
      for (const u of await store.listUsers()) {
        if (accessAtLeast(effectiveProjectAccess(u, project, members.get(u.id), grants), 'manager')) add(u);
      }
    }
    return [...out.values()];
  }
  if (req.kind === 'switch' && req.userId && req.projectId) {
    const project = await store.getProject(req.projectId);
    if (project) (await projectManagers(d, project)).forEach(add);
  }
  const grants = await store.listGrants();
  const policy = resolveInvitePolicy(config.policy.invites);
  for (const u of await store.listUsers()) if (mayInviteNewPeople(u, grants, policy)) add(u);
  return [...out.values()];
}

/** End the approvers' notice for a request now (an answer, a withdrawal or a
 *  supersede), so it leaves every inbox at once. */
export async function retireRequestNotice(d: RequestDeps, req: AccessRequestRecord): Promise<void> {
  const id = requestNoticeId(req.id);
  const msg = (await d.store.listMessages()).find((m) => m.id === id);
  const nowMs = d.now();
  if (!msg || (msg.endsAt && Date.parse(msg.endsAt) <= nowMs)) return;
  await d.people.tell({ message: { ...msg, endsAt: iso(nowMs) }, kind: 'request' });
}

/** Close requests that some other step has made moot, retiring their
 *  notices. No answer notice: the share or the acceptance says it. */
async function supersede(
  d: RequestDeps, closing: AccessRequestMatch[], by: string, reason: 'membership' | 'invitation',
): Promise<void> {
  const at = iso(d.now());
  const answer: AccessRequestAnswer = { status: 'superseded', at, by };
  for (const q of closing) {
    for (const r of await d.store.closeAccessRequests(q, answer, at)) {
      await retireRequestNotice(d, r);
      await d.audit(by, 'access.supersede', `request:${r.id}`, { kind: r.kind, by: reason });
    }
  }
}

/**
 * Someone was given `role` on a project another way (shared, invited,
 * another request): their open requests for that project asking for that
 * role or less are superseded. `by` is the principal that gave the access.
 */
export async function closeRequestsOnAccess(
  d: RequestDeps, q: { projectId: string; userId: string; role: ProjectMemberRole }, by: string,
): Promise<void> {
  await supersede(d, [{ kind: 'project', projectId: q.projectId, userId: q.userId, roleAtMost: q.role }], by, 'membership');
}

/**
 * An address was invited, or accepted an invitation: its open join request
 * is superseded, and with `invitationId` so are the switch requests on that
 * invitation, which nobody else can use now.
 */
export async function closeRequestsForEmail(d: RequestDeps, q: { email: string; invitationId?: string }, by: string): Promise<void> {
  await supersede(d, [
    { kind: 'join', email: q.email.trim().toLowerCase() },
    ...(q.invitationId ? [{ kind: 'switch' as const, invitationId: q.invitationId }] : []),
  ], by, 'invitation');
}
