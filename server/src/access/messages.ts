// SPDX-License-Identifier: MPL-2.0
/**
 * The people notices of invitations and access requests (plans/74 invite
 * spec 2.10): every title, body and link, built here and nowhere else. Pure,
 * so the copy is tested without a server. Each notice goes out through
 * notify/people.ts, which puts it in the inbox (and mails it once email is
 * on); no route writes these messages itself.
 *
 *   access-request   to the approvers: someone asks for a project, to join,
 *                    or to use their own account for an invitation
 *   access-answer    to the requester: approved or not
 *   invite-accepted  to an inviter: the person accepted
 *   invite-skipped   to the invitee: one project on the invitation no longer works
 *   welcome          to the invitee, once they are in
 *
 * Server copy is English (plans/75 C20). A person is named the way
 * `nameWithoutEmail` names them, and a project name is cut to 120
 * characters. Every message carries `data.at`, so the shell can say
 * "2 h ago", and ids derived from what the message is about, so writing it
 * again replaces one inbox row instead of adding a second.
 */
import type { InstanceConfig } from '../config/instance.ts';
import type { Message } from '../inbox/target.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { MAX_PROJECT_NAME_CHARS, nameWithoutEmail } from '../projects/sharing.ts';
import type { AccessRequestRecord, ProjectMemberRole } from '../store/types.ts';

/** What every notice needs from the instance, and when it was written. */
export interface NoticeContext {
  /** The workspace name (`instance.name`), first wherever it appears (plans/75 C6). */
  workspace: string;
  /** This instance (`instance.baseUrl`), for links into the console. */
  baseUrl: string;
  /** Where Lolly itself lives: `instance.appUrl` on a split deploy, '' when
   *  the shell is served from this origin. Project links start here. */
  appBase: string;
  /** ISO time the notice was written. */
  at: string;
}

export function noticeContext(config: Pick<InstanceConfig, 'instance'>, nowMs: number): NoticeContext {
  return {
    workspace: config.instance.name,
    baseUrl: config.instance.baseUrl.replace(/\/+$/, ''),
    appBase: (config.instance.appUrl ?? '').replace(/\/+$/, ''),
    at: new Date(nowMs).toISOString(),
  };
}

/** Someone with an account, as the notices name them. Never shown by address alone. */
export type PersonName = { firstname?: string; lastname?: string; email: string };

const MAX_TITLE_CHARS = 200;
const DAY_MS = 86_400_000;
/** How long an answer or an acceptance stays in the inbox. */
export const NOTICE_DAYS = 30;

export const requestNoticeId = (requestId: string): string => `msg_req_${requestId}`;
export const answerNoticeId = (requestId: string): string => `msg_ans_${requestId}`;
export const acceptedNoticeId = (invitationId: string, inviterId: string): string =>
  `msg_acc_${sha256Hex(`${invitationId} ${inviterId}`).slice(0, 24)}`;
export const skippedNoticeId = (invitationId: string, projectId: string): string =>
  `msg_skip_${sha256Hex(`${invitationId} ${projectId}`).slice(0, 24)}`;
export const welcomeNoticeId = (invitationId: string): string => `msg_welcome_${invitationId}`;

const projectName = (name: string | undefined): string =>
  Array.from((name ?? '').trim()).slice(0, MAX_PROJECT_NAME_CHARS).join('') || 'a project';
const title = (text: string): string => Array.from(text).slice(0, MAX_TITLE_CHARS).join('');
const projectLink = (ctx: NoticeContext, projectId: string): string =>
  `${ctx.appBase}/#/team/project/${encodeURIComponent(projectId)}`;
const later = (ctx: NoticeContext, days: number): string => new Date(Date.parse(ctx.at) + days * DAY_MS).toISOString();
/** `data` takes strings only; absent values are left off. */
const data = (fields: Record<string, string | undefined>): Record<string, string> =>
  Object.fromEntries(Object.entries(fields).filter((e): e is [string, string] => typeof e[1] === 'string' && e[1] !== ''));

/** "view", "comment on", "edit" or "manage": what the role lets you do to a project. */
const VERB: Record<ProjectMemberRole, string> = { viewer: 'view', commenter: 'comment on', editor: 'edit', manager: 'manage' };
/** "view access", "comment access", "edit access", "manager access". */
const ACCESS: Record<ProjectMemberRole, string> = { viewer: 'view', commenter: 'comment', editor: 'edit', manager: 'manager' };
/** "as a Viewer", "as a Commenter", "as an Editor", "as a Manager". */
const AS_ROLE: Record<ProjectMemberRole, string> = { viewer: 'a Viewer', commenter: 'a Commenter', editor: 'an Editor', manager: 'a Manager' };

/** The requester's name: the name from their sign-in, else the start of their address. */
export function requesterName(req: Pick<AccessRequestRecord, 'name' | 'email'>): string {
  return nameWithoutEmail({ ...(req.name ? { firstname: req.name } : {}), email: req.email });
}

/**
 * The notice an approver gets when a request is filed (`kind: 'request'`,
 * severity action). It ends when the request expires; answering, withdrawing
 * or superseding the request ends it at once (`retireRequestNotice`). A
 * switch request repeats the warning that an invite link may have been
 * passed on (plans/75 4.8 rule 2).
 */
export function requestNotice(o: {
  request: AccessRequestRecord;
  approverIds: string[];
  /** The display name of the IdP the requester signed in with. */
  provider?: string | null;
  projectName?: string;
  /** switch: the invited address, masked (`maskEmail`). */
  maskedInvitee?: string;
}, ctx: NoticeContext): Message {
  const req = o.request;
  const name = requesterName(req);
  const project = projectName(o.projectName);
  const head = req.kind === 'project' ? `${name} asks to ${VERB[req.role ?? 'viewer']} ${project}`
    : req.kind === 'join' ? `${name} asks to join ${ctx.workspace}`
      : req.kind === 'switch' ? `${name} asks to use their own account for an invitation`
        : `${name} asks for access to ${ctx.workspace}`;
  const note = req.note?.replace(/\s+/g, ' ').trim();
  let body = [req.email, o.provider || undefined, note ? `“${note}”` : undefined].filter(Boolean).join(' · ');
  if (req.kind === 'switch') {
    body += `\nSomeone with the invitation for ${o.maskedInvitee ?? 'another address'} signed in as ${req.email}. `
      + 'Approve only if you know the address belongs to them.';
  }
  return {
    id: requestNoticeId(req.id),
    kind: 'request',
    severity: 'action',
    audience: { users: [...o.approverIds] },
    title: title(head),
    body,
    cta: req.kind === 'project' && req.projectId
      ? { label: 'Review', url: projectLink(ctx, req.projectId) }
      : { label: 'Review', url: `${ctx.baseUrl}/admin#/users` },
    data: data({
      kind: 'access-request', at: ctx.at, requestId: req.id, requestKind: req.kind, projectId: req.projectId,
      viaSessionId: req.viaSessionId, role: req.role, invitationId: req.invitationId, userId: req.userId,
    }),
    endsAt: req.expiresAt,
    dismissible: true,
  };
}

/**
 * The answer to a project request, for the person who asked. Only project
 * requests get one: the other kinds come from someone with no account to
 * tell. The approver is named only once they approved (plans/75 4.8: a
 * requester never learns who manages a project from a refusal).
 */
export function answerNotice(o: {
  request: AccessRequestRecord;
  outcome: 'approved' | 'declined';
  approver: PersonName;
  projectName?: string;
  /** The role given, when approved. Defaults to the request's answer role, then to what was asked. */
  role?: ProjectMemberRole;
}, ctx: NoticeContext): Message {
  const req = o.request;
  if (!req.userId || !req.projectId) throw new Error('an answer notice needs the requester\'s account and the project');
  const project = projectName(o.projectName);
  const role = o.role ?? req.answerRole ?? req.role ?? 'viewer';
  const approved = o.outcome === 'approved';
  return {
    id: answerNoticeId(req.id),
    kind: 'notice',
    severity: 'info',
    audience: { users: [req.userId] },
    title: title(approved
      ? `${nameWithoutEmail(o.approver)} gave you ${ACCESS[role]} access to ${project}`
      : `Your request for ${project} was not approved`),
    ...(approved ? { cta: { label: 'Open', url: projectLink(ctx, req.projectId) } } : {}),
    data: data({
      kind: 'access-answer', at: ctx.at, requestId: req.id, requestKind: req.kind, projectId: req.projectId,
      outcome: o.outcome, ...(approved ? { role } : {}),
    }),
    endsAt: later(ctx, NOTICE_DAYS),
    dismissible: true,
  };
}

/**
 * The notice an inviter gets when their invitation is accepted. One per
 * (invitation, inviter): a person who put two projects on one invitation
 * hears once. With a project it opens the project; a console invitation
 * without one opens the person in the console.
 */
export function acceptedNotice(o: {
  invitationId: string;
  inviterId: string;
  invitee: PersonName & { id: string };
  project?: { id: string; name: string };
  /** Link to the console's People view instead (an invitation made there). */
  console?: boolean;
}, ctx: NoticeContext): Message {
  const cta = o.project ? { label: 'Open', url: projectLink(ctx, o.project.id) }
    : o.console ? { label: 'Open People', url: `${ctx.baseUrl}/admin#/users?focus=${encodeURIComponent(o.invitee.id)}` }
      : undefined;
  return {
    id: acceptedNoticeId(o.invitationId, o.inviterId),
    kind: 'notice',
    severity: 'info',
    audience: { users: [o.inviterId] },
    title: title(`${nameWithoutEmail(o.invitee)} accepted your invitation`),
    body: o.project ? `${o.invitee.email} can now open ${projectName(o.project.name)}.` : `${o.invitee.email} joined ${ctx.workspace}.`,
    ...(cta ? { cta } : {}),
    data: data({ kind: 'invite-accepted', at: ctx.at, invitationId: o.invitationId, userId: o.invitee.id, projectId: o.project?.id }),
    endsAt: later(ctx, NOTICE_DAYS),
    dismissible: true,
  };
}

/** The notice an invitee gets for a project entry acceptance could not apply:
 *  the person who added it can no longer add people, or the project was archived. */
export function skippedNotice(o: { invitationId: string; inviteeId: string; project: { id: string; name: string } }, ctx: NoticeContext): Message {
  const project = projectName(o.project.name);
  return {
    id: skippedNoticeId(o.invitationId, o.project.id),
    kind: 'notice',
    severity: 'info',
    audience: { users: [o.inviteeId] },
    title: title(`Your invitation to ${project} no longer works`),
    body: `The person who invited you can no longer add people to ${project}, or the project was archived. `
      + 'Ask someone on the project to add you again.',
    data: data({ kind: 'invite-skipped', at: ctx.at, invitationId: o.invitationId, projectId: o.project.id }),
    dismissible: true,
  };
}

/**
 * The welcome an invitee gets once they are in. With a project, it says the
 * role and opens the project; the per-project share message is not sent as
 * well. An inviter with no name to show is replaced by the workspace name.
 */
export function welcomeNotice(o: {
  invitationId: string;
  inviteeId: string;
  inviter: PersonName | null;
  project?: { id: string; name: string; role: ProjectMemberRole };
}, ctx: NoticeContext): Message {
  const inviter = o.inviter ? nameWithoutEmail(o.inviter) : ctx.workspace;
  return {
    id: welcomeNoticeId(o.invitationId),
    kind: 'notice',
    severity: 'info',
    audience: { users: [o.inviteeId] },
    title: title(`Welcome to ${ctx.workspace}`),
    body: o.project
      ? `${inviter} invited you. You can open ${projectName(o.project.name)} as ${AS_ROLE[o.project.role]}.`
      : `${inviter} invited you. Projects shared with you appear in Projects.`,
    ...(o.project ? { cta: { label: 'Open', url: projectLink(ctx, o.project.id) } } : {}),
    data: data({ kind: 'welcome', at: ctx.at, invitationId: o.invitationId, projectId: o.project?.id, role: o.project?.role }),
    dismissible: true,
  };
}

/**
 * What an admin copies to someone whose join request they approved, while
 * nothing is emailed: "You can now sign in to lolly.ing. Open
 * https://lolly.ing and sign in as sam.k@gmail.com with GitHub."
 */
export function joinApprovedText(o: { email: string; provider?: string | null }, ctx: NoticeContext): string {
  const where = ctx.appBase || ctx.baseUrl;
  return `You can now sign in to ${ctx.workspace}. Open ${where} and sign in as ${o.email}${o.provider ? ` with ${o.provider}` : ''}.`;
}
