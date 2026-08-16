/**
 * Project visibility - "may this member SEE this project?" (plans/08 §2).
 *
 * Extracted from the HTTP app so the collab ws gateway enforces the SAME rule on
 * a room join that `GET /api/v1/sessions/:id` enforces on a read (OSS plans/100
 * §7, lolly-work plans/14 §6). Two copies of a join gate is exactly the drift a
 * governed instance cannot afford, so there is one function and both callers use
 * it. Pure over (user, project) - no store, no request.
 *
 * Visibility gates WHICH projects a caller sees; RBAC grants gate WHAT they may
 * do (that stays `evaluate()`).
 */
import type { ProjectRecord, UserRecord } from '../store/types.ts';

/**
 * Visibility by MEMBERSHIP alone - the project's owner, or someone in one of its
 * visibility groups. No role bypass.
 *
 * Split out from `canSeeProject` because the admin/owner bypass is a governance
 * power, not a relationship to the project, and one caller needs exactly that
 * distinction: the collab invite surface (`collab/invites.ts`). `canSeeProject`
 * is true for EVERY admin on EVERY project, so an eligibility list built on it
 * over an attacker-minted project (private, or shared to a group nobody holds)
 * is a list of the instance's admins and nobody else - an admin-identification
 * oracle for any member who can create a project, disclosing what
 * `GET /api/v1/users` refuses them. An invite list is therefore membership-based:
 * an admin who is genuinely in the project's group is offered like anyone else;
 * one who is merely an admin is not.
 *
 * The group predicate lives here ONCE and `canSeeProject` is defined over it, so
 * the two can never drift into two readings of the same visibility record.
 */
export function isProjectMember(user: UserRecord, project: ProjectRecord): boolean {
  if (project.ownerId === user.id) return true;
  if (project.visibility !== 'private') {
    return project.visibility.groups.some((g) => user.groups.includes(g));
  }
  return false;
}

export function canSeeProject(user: UserRecord, project: ProjectRecord): boolean {
  if (user.role === 'admin' || user.role === 'owner') return true; // admins see all
  return isProjectMember(user, project);
}
