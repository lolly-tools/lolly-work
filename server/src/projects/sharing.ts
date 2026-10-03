// SPDX-License-Identifier: MPL-2.0
/**
 * Project sharing helpers (plans/74, "Invite from inside Lolly"): the inbox
 * message a person gets when they are added to a project, and the rules for
 * merging a project into an invitation. Pure, so the routes stay thin and the
 * tests can hit the rules without a server.
 */
import { sha256Hex } from '../lib/crypto.ts';
import type { Message } from '../inbox/target.ts';
import type { InvitationProject, ProjectMemberRole } from '../store/types.ts';

const ROLE_RANK: Record<ProjectMemberRole, number> = { viewer: 1, editor: 2, manager: 3 };

/** The higher of two project roles. */
export function higherRole(a: ProjectMemberRole, b: ProjectMemberRole): ProjectMemberRole {
  return ROLE_RANK[a] >= ROLE_RANK[b] ? a : b;
}

/** Whether `a` is a higher role than `b`. */
export function roleAbove(a: ProjectMemberRole, b: ProjectMemberRole): boolean {
  return ROLE_RANK[a] > ROLE_RANK[b];
}

/**
 * Add one project to an invitation's list. A project already on the list
 * keeps the higher of the two roles, so inviting again never lowers what an
 * earlier invitation promised. `changed` is false when the list already said
 * as much.
 */
export function mergeInvitationProject(
  existing: readonly InvitationProject[], add: InvitationProject,
): { projects: InvitationProject[]; changed: boolean } {
  const projects = existing.map((p) => ({ ...p }));
  const at = projects.findIndex((p) => p.projectId === add.projectId);
  if (at < 0) return { projects: [...projects, { ...add }], changed: true };
  const cur = projects[at]!;
  if (!roleAbove(add.role, cur.role)) return { projects, changed: false };
  // The person who raised the role now answers for the entry: acceptance
  // re-checks their standing, not the earlier inviter's.
  projects[at] = { projectId: cur.projectId, role: add.role, ...(add.invitedBy ? { invitedBy: add.invitedBy } : {}) };
  return { projects, changed: true };
}

/**
 * A person's name for someone who may not see their email: first and last
 * name, else the part of the address before the "@", else 'Member'. A name
 * field that holds an address (some IdPs send the email as the name) is cut
 * the same way. `displayName` falls back to the whole address, which the
 * people list shows only to managers.
 */
export function nameWithoutEmail(u: { firstname?: string; lastname?: string; email: string }): string {
  const local = (v: string): string => (v.includes('@') ? v.slice(0, v.indexOf('@')) : v).trim();
  const full = local([u.firstname, u.lastname].filter(Boolean).join(' '));
  return full || local(u.email) || 'Member';
}

/**
 * A per-key allowance over a fixed window, in memory: `take(key, n)` spends
 * `n` and answers false, spending nothing, when that would pass `limit` in
 * the current window. Per process, so on a host with several instances each
 * one counts on its own: a brake on misuse, not an exact quota.
 */
export function createWindowQuota(limit: number, windowMs: number, now: () => number = Date.now) {
  const used = new Map<string, { start: number; n: number }>();
  const MAX_KEYS = 10_000;
  return {
    take(key: string, n = 1): boolean {
      const t = now();
      const cur = used.get(key);
      const live = cur && t - cur.start < windowMs ? cur : { start: t, n: 0 };
      used.delete(key);
      used.set(key, live);
      if (used.size > MAX_KEYS) used.delete(used.keys().next().value as string);
      if (live.n + n > limit) return false;
      live.n += n;
      return true;
    },
  };
}

/** Longest project name the message title carries. */
export const MAX_PROJECT_NAME_CHARS = 120;
const MAX_TITLE_CHARS = 200;

/**
 * The id of "you were added to project P". Derived from (project, person) so
 * adding the same person again rewrites one inbox row instead of stacking a
 * second (`putMessage` upserts by id in both drivers). A dismissal is kept:
 * removing and re-adding someone never puts a message back in front of them.
 */
export function shareMessageId(projectId: string, userId: string): string {
  return `msg_share_${sha256Hex(`${projectId} ${userId}`).slice(0, 24)}`;
}

/**
 * The inbox message for someone added to a project: "<inviter> shared
 * <project> with you", with a link to the shell's team project route
 * `<appBase>/#/team/project/<projectId>`. `appBase` is '' when the app is
 * served from the same origin, which makes the link '/#/team/project/<id>'.
 */
export function buildShareMessage(opts: {
  projectId: string;
  projectName: string;
  role: ProjectMemberRole;
  inviteeId: string;
  inviterName: string;
  appBase: string;
}): Message {
  const name = opts.projectName.trim().slice(0, MAX_PROJECT_NAME_CHARS) || 'a project';
  return {
    id: shareMessageId(opts.projectId, opts.inviteeId),
    kind: 'share',
    severity: 'info',
    audience: { users: [opts.inviteeId] },
    title: `${opts.inviterName} shared ${name} with you`.slice(0, MAX_TITLE_CHARS),
    cta: { label: 'Open', url: `${opts.appBase.replace(/\/+$/, '')}/#/team/project/${encodeURIComponent(opts.projectId)}` },
    data: { kind: 'project-share', projectId: opts.projectId, role: opts.role },
    dismissible: true,
  };
}
