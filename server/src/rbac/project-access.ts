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
import type { ProjectMemberRecord, ProjectMemberRole, ProjectRecord, UserRecord } from '../store/types.ts';
import { evaluate, type Grant, type Role } from './evaluate.ts';

export type ProjectAccess = 'none' | 'viewer' | 'commenter' | 'editor' | 'manager' | 'owner';
/** The membership row for (project, user), or null when there is none. */
export type ProjectMembership = Pick<ProjectMemberRecord, 'projectId' | 'userId' | 'role' | 'expiresAt'> | null | undefined;

/** Every level, lowest first. A commenter (lolly plan 299, migration 0060)
 *  reads and comments but never changes artwork, so every check written as
 *  "editor or higher" already leaves commenters out. */
export const PROJECT_ACCESS_LEVELS: readonly ProjectAccess[] = ['none', 'viewer', 'commenter', 'editor', 'manager', 'owner'];
const RANK: Record<ProjectAccess, number> = { none: 0, viewer: 1, commenter: 2, editor: 3, manager: 4, owner: 5 };

/** Position on the ladder, for callers that sort or compare levels. */
export function projectAccessRank(access: ProjectAccess): number {
  return RANK[access];
}

/** Whether `access` is `min` or higher. */
export function accessAtLeast(access: ProjectAccess, min: ProjectAccess): boolean {
  return RANK[access] >= RANK[min];
}

const higher = (a: ProjectAccess, b: ProjectAccess): ProjectAccess => (RANK[a] >= RANK[b] ? a : b);
const lower = (a: ProjectAccess, b: ProjectAccess): ProjectAccess => (RANK[a] <= RANK[b] ? a : b);

/** The instance's sharing limits (`policy.sharing`, see `config/instance.ts`).
 *  Set once at startup; the defaults allow sharing with the whole instance
 *  up to Commenter, and user-made groups. Read on every evaluation, so
 *  lowering the ceiling also lowers shares made before the change. */
export interface SharingLimits {
  instanceAudience: boolean;
  instanceMaxRole: ProjectMemberRole;
  customGroups: boolean;
}
export const DEFAULT_SHARING_LIMITS: Readonly<SharingLimits> = Object.freeze({
  instanceAudience: true, instanceMaxRole: 'commenter', customGroups: true,
});
let limits: SharingLimits = { ...DEFAULT_SHARING_LIMITS };
export function configureSharingLimits(next: Partial<SharingLimits> | undefined): void {
  limits = { ...DEFAULT_SHARING_LIMITS, ...(next ?? {}) };
}
export function sharingLimits(): Readonly<SharingLimits> {
  return limits;
}

/** Whether a grant ending at `expiresAt` still applies at `now`. */
export function grantLive(expiresAt: string | undefined, now: number): boolean {
  return expiresAt === undefined || Date.parse(expiresAt) > now;
}

/** The row's role, but only when the row really is for this user on this
 *  project and has not ended: a caller that passes the wrong row gets
 *  nothing from it. */
function membershipRole(user: UserRecord, project: ProjectRecord, membership: ProjectMembership, now: number): ProjectAccess {
  return membership && membership.projectId === project.id && membership.userId === user.id && grantLive(membership.expiresAt, now)
    ? membership.role : 'none';
}

/** The highest role a group grant gives this user. A directory group counts
 *  only while it is in the project's visibility, with the grant's role, or
 *  editor when no grant names it (visibility as it worked before 0060). A
 *  user-made group counts while the instance allows them. */
function groupRole(user: UserRecord, project: ProjectRecord, now: number): ProjectAccess {
  let access: ProjectAccess = 'none';
  const visible = project.visibility === 'private' ? [] : project.visibility.groups;
  const grants = project.sharing?.groups ?? [];
  for (const name of visible) {
    if (!user.groups.includes(name)) continue;
    const grant = grants.find((g) => g.kind === 'directory' && g.name === name);
    if (!grant) access = higher(access, 'editor');
    else if (grantLive(grant.expiresAt, now)) access = higher(access, grant.role);
  }
  if (limits.customGroups && user.shareGroups?.length) {
    for (const grant of grants) {
      if (grant.kind === 'custom' && user.shareGroups.includes(grant.id) && grantLive(grant.expiresAt, now)) access = higher(access, grant.role);
    }
  }
  return access;
}

/** Every signed-in member of the instance: a real, enabled account, never a
 *  service token or a guest. */
export function isInstanceMember(user: UserRecord): boolean {
  return !user.disabledAt && !user.id.startsWith('svc_') && user.role !== 'guest';
}

/** The role the project's general access gives this user, capped by the
 *  instance's current ceiling. */
function audienceRole(user: UserRecord, project: ProjectRecord): ProjectAccess {
  const general = project.sharing?.general;
  if (!general || general.audience !== 'instance' || !limits.instanceAudience || !isInstanceMember(user)) return 'none';
  return lower(lower(general.role, limits.instanceMaxRole), 'editor');
}

/**
 * The caller's level on the project from relationships and role alone, with
 * no grants. `effectiveProjectAccess` adds the `project.manage` lift; routes
 * call that one.
 */
export function projectAccess(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership, now: number = Date.now()): ProjectAccess {
  if (project.ownerId === user.id) return 'owner';
  let access = membershipRole(user, project, membership, now);
  access = higher(access, groupRole(user, project, now));
  access = higher(access, audienceRole(user, project));
  if (user.role === 'admin' || user.role === 'owner') access = higher(access, 'editor');
  return access;
}

/**
 * Whether someone at `access` may comment on the project's documents. A
 * commenter or higher always may; a viewer may unless a manager has turned
 * off "Viewers can comment" (default on, which keeps commenting as it was
 * before the commenter role existed). Instance policy (`policy.comments`)
 * and RBAC still apply on top, in `comments/access.ts`.
 */
export function mayCommentOn(project: ProjectRecord, access: ProjectAccess): boolean {
  if (accessAtLeast(access, 'commenter')) return true;
  return access === 'viewer' && project.sharing?.settings?.viewersCanComment !== false;
}

/** Whether someone at `access` may change who has access: managers and the
 *  owner, and editors when the project allows it. */
export function mayShareProject(project: ProjectRecord, access: ProjectAccess): boolean {
  return accessAtLeast(access, 'manager') || (accessAtLeast(access, 'editor') && project.sharing?.settings?.editorsCanShare === true);
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
export function isProjectMember(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership, now: number = Date.now()): boolean {
  if (project.ownerId === user.id) return true;
  if (membershipRole(user, project, membership, now) !== 'none') return true;
  return groupRole(user, project, now) !== 'none';
}

/** Whether the caller may see the project at all (viewer or higher). */
export function canSeeProject(user: UserRecord, project: ProjectRecord, membership?: ProjectMembership): boolean {
  return accessAtLeast(projectAccess(user, project, membership), 'viewer');
}
