/**
 * Project access - "what may this member do on this project?" (plans/08 section 2,
 * plans/74 "Invite from inside Lolly").
 *
 * Extracted from the HTTP app so the collab ws gateway enforces the SAME rule on
 * a room join that `GET /api/v1/sessions/:id` enforces on a read (OSS plans/100
 * section 7, lolly-work plans/14 section 6). Two copies of a join gate is exactly the drift a
 * governed instance cannot afford, so there is one function and every caller
 * uses it. Pure over (user, project, membership) - no store, no request. The
 * caller reads the person's `project_members` row (or null) and passes it in.
 *
 * The levels, lowest to highest:
 *   - none:    cannot see the project.
 *   - viewer:  reads the project and its sessions.
 *   - editor:  also creates, saves and deletes their own sessions.
 *   - manager: also renames, shares, archives, deletes anyone's session and
 *              manages the people on the project.
 *   - owner:   the project's owner (`projects.owner_id`).
 *
 * Where a level comes from:
 *   - the project's owner is `owner`;
 *   - an explicit membership row gives its role;
 *   - a member of one of the project's visibility groups acts as an `editor`
 *     (today's group sharing, unchanged);
 *   - an instance admin or owner sees every project and acts as an `editor`;
 *     `effectiveProjectAccess` lifts a holder of `project.manage` (admins by
 *     default, deny-able by grant) to `manager` on any project they can see.
 * The highest of these wins.
 *
 * The level gates WHICH projects a caller sees and what they may do there; the
 * global RBAC actions (`session.create`, `session.edit`, ...) still apply on
 * top, so a viewer-role account in an editor group still cannot write.
 */
import type { ProjectMemberRecord, ProjectRecord, UserRecord } from '../store/types.ts';
import { evaluate, type Grant, type Role } from './evaluate.ts';

export type ProjectAccess = 'none' | 'viewer' | 'editor' | 'manager' | 'owner';
/** The membership row for (project, user), or null when there is none. */
export type ProjectMembership = Pick<ProjectMemberRecord, 'projectId' | 'userId' | 'role'> | null | undefined;

const RANK: Record<ProjectAccess, number> = { none: 0, viewer: 1, editor: 2, manager: 3, owner: 4 };

/** Whether `access` is `min` or higher. */
export function accessAtLeast(access: ProjectAccess, min: ProjectAccess): boolean {
  return RANK[access] >= RANK[min];
}

const higher = (a: ProjectAccess, b: ProjectAccess): ProjectAccess => (RANK[a] >= RANK[b] ? a : b);

/** The row's role, but only when the row really is for this user on this
 *  project: a caller that passes the wrong row gets nothing from it. */
function membershipRole(user: UserRecord, project: ProjectRecord, membership: ProjectMembership): ProjectAccess {
  return membership && membership.projectId === project.id && membership.userId === user.id ? membership.role : 'none';
}

function inVisibilityGroup(user: UserRecord, project: ProjectRecord): boolean {
  return project.visibility !== 'private' && project.visibility.groups.some((g) => user.groups.includes(g));
}

/**
 * The caller's level on the project from relationships and role alone, with
 * no grants. `effectiveProjectAccess` adds the `project.manage` lift; routes
 * call that one.
 */
export function projectAccess(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership): ProjectAccess {
  if (project.ownerId === user.id) return 'owner';
  let access = membershipRole(user, project, membership);
  if (inVisibilityGroup(user, project)) access = higher(access, 'editor');
  if (user.role === 'admin' || user.role === 'owner') access = higher(access, 'editor');
  return access;
}

/**
 * `projectAccess` plus the `project.manage` action: a holder of it (admins and
 * owners by role default; a grant can add or deny it) manages every project
 * they can see. It never makes a project visible on its own, so a member
 * granted `project.manage` sees what they saw before. Evaluated over `['*']`,
 * as every project route did before memberships existed.
 */
export function effectiveProjectAccess(
  user: UserRecord, project: ProjectRecord, membership: ProjectMembership, grants: Grant[],
): ProjectAccess {
  const base = projectAccess(user, project, membership);
  if (base === 'none' || base === 'owner' || base === 'manager') return base;
  return evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'project.manage', ['*'], grants)
    ? 'manager'
    : base;
}

/**
 * Visibility by RELATIONSHIP alone - the project's owner, someone in one of
 * its visibility groups, or an explicit member. No role bypass.
 *
 * Split out from `canSeeProject` because the admin/owner bypass is a governance
 * power, not a relationship to the project, and one caller needs exactly that
 * distinction: the collab invite surface (`collab/invites.ts`). `canSeeProject`
 * is true for EVERY admin on EVERY project, so an eligibility list built on it
 * over an attacker-minted project (private, or shared to a group nobody holds)
 * is a list of the instance's admins and nobody else - an admin-identification
 * oracle for any member who can create a project, disclosing what
 * `GET /api/v1/users` refuses them. An invite list is therefore membership-based:
 * an admin who is genuinely in the project's group, or added to it, is offered
 * like anyone else; one who is merely an admin is not.
 */
export function isProjectMember(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership): boolean {
  if (project.ownerId === user.id) return true;
  if (membershipRole(user, project, membership) !== 'none') return true;
  return inVisibilityGroup(user, project);
}

/** Whether the caller may see the project at all (viewer or higher). */
export function canSeeProject(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership): boolean {
  return accessAtLeast(projectAccess(user, project, membership), 'viewer');
}
