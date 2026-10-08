// SPDX-License-Identifier: MPL-2.0
/**
 * Who may read a document's comments (plan 76 milestone 4).
 *
 * One predicate for every comment read: the comments routes' gate, the notice
 * written when someone replies or mentions, the inbox notice read and the
 * unread count. A notice is a pointer into comments, so the person it points
 * at must pass the same test the comments panel applies, at write time and
 * again at read time. Two copies of this rule could drift; one cannot.
 *
 * Pure: callers load the records and pass them in, so the rule is testable as
 * data and never grows a query of its own.
 */
import type { InstanceConfig } from '../config/instance.ts';
import { evaluate, type Grant, type Role } from '../rbac/evaluate.ts';
import { effectiveProjectAccess, type ProjectAccess, type ProjectMembership } from '../rbac/project-access.ts';
import type { ProjectRecord, SessionRecord, UserRecord } from '../store/types.ts';

/** Why comments are closed to someone: the document is gone, the person may
 *  not read it, or the instance has switched the feature off. */
export type CommentReadRefusal = 'gone' | 'forbidden' | 'off';

export type CommentReadDecision =
  | { ok: true; access: ProjectAccess; can: (action: string) => boolean }
  | { ok: false; reason: CommentReadRefusal };

export interface CommentReadInput {
  user: UserRecord;
  /** The session whose comments are read; null or deleted reads as gone. */
  session: SessionRecord | null | undefined;
  /** The project loaded from `session.projectId`, never from the request. */
  project: ProjectRecord | null | undefined;
  /** The person's membership row on that project, if any. */
  membership: ProjectMembership;
  grants: Grant[];
  config: Pick<InstanceConfig, 'policy'>;
}

/**
 * Whether `user` may read the comments of `session`.
 *
 * Requires, in order: the session exists and is not deleted, and the project
 * is the one the session belongs to; the person is a signed-in account (not a
 * service token, not disabled) with some access to the project; `session.view`
 * and `comment.view` hold over the session's selectors; and comments are on
 * for the instance. `can` evaluates further actions over the same selectors.
 */
export function mayReadComments(input: CommentReadInput): CommentReadDecision {
  const { user, session, project, grants } = input;
  if (!session || session.deletedAt || !project || project.id !== session.projectId) return { ok: false, reason: 'gone' };
  if (user.id.startsWith('svc_') || user.disabledAt) return { ok: false, reason: 'forbidden' };
  const access = effectiveProjectAccess(user, project, input.membership, grants);
  if (access === 'none') return { ok: false, reason: 'forbidden' };
  const ctx = { userId: user.id, groups: user.groups, role: user.role as Role };
  const selectors = ['*', `session:${session.id}`, `project:${project.id}`];
  const can = (action: string): boolean => evaluate(ctx, action, selectors, grants);
  if (!can('session.view') || !can('comment.view')) return { ok: false, reason: 'forbidden' };
  if (input.config.policy.comments?.enabled === false) return { ok: false, reason: 'off' };
  return { ok: true, access, can };
}

/** `mayReadComments`, and the instance keeps comment notices on. */
export function mayReceiveNotices(input: CommentReadInput): CommentReadDecision {
  const decision = mayReadComments(input);
  if (!decision.ok) return decision;
  return input.config.policy.comments?.notices === false ? { ok: false, reason: 'off' } : decision;
}
