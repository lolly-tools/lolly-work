// SPDX-License-Identifier: MPL-2.0
/**
 * Who a comment may mention (plan 76 milestone 4).
 *
 * A mention names a person and later sends them a notice that points into the
 * document, so it may only name someone who can already open that document and
 * read its comments. It never grants access: an ineligible id is dropped, and
 * nothing here writes a membership, a grant or a request.
 *
 * Mentionable means all of:
 * - `mayJoinSession` (collab/invites.ts): the owner, an explicit member or
 *   someone in a visibility group; not disabled; `collab.join` allowed. The
 *   admin bypass is excluded on purpose, as for invites, so the suggestion
 *   list never becomes a directory of the instance's admins.
 * - `mayReadComments` (comments/access.ts) for that person.
 * - Not the person writing, and not a service principal.
 *
 * Names come from `nameWithoutEmail`, never from the request, so a mention can
 * never carry an address or a name the client made up.
 */
import { COMMENT_MENTION_LIMIT, type CommentMention } from '@lolly-tools/core/canvas-review-v1';
import { interactionKey } from '@lolly-tools/core/canvas-interaction-v1';
import type { InstanceConfig } from '../config/instance.ts';
import { mayJoinSession } from '../collab/invites.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';
import type { Grant } from '../rbac/evaluate.ts';
import type { ProjectRecord, SessionRecord, Store, UserRecord } from '../store/types.ts';
import { mayReadComments } from './access.ts';

/** Longest name a mention carries, matching the core reader's limit. */
const MAX_MENTION_NAME = 256;

/** The shape a request's `mentions` must have: at most ten ids. Anything else
 *  is a 400, so a client bug is visible instead of silently notifying nobody. */
export function readMentionRequest(value: unknown): string[] | null {
  if (!Array.isArray(value) || value.length > COMMENT_MENTION_LIMIT) return null;
  if (!value.every((id) => typeof id === 'string' && interactionKey(id))) return null;
  return [...new Set(value as string[])];
}

/** The name a mention shows for a person. */
export function mentionName(user: Pick<UserRecord, 'firstname' | 'lastname' | 'email'>): string {
  return nameWithoutEmail(user).slice(0, MAX_MENTION_NAME);
}

/**
 * Whether `user` may be mentioned in (and suggested for) comments on `session`.
 * `grants` and `membership` are passed in so a caller checking many people
 * loads them once.
 */
export function mayBeMentioned(o: {
  user: UserRecord; session: SessionRecord; project: ProjectRecord; grants: Grant[];
  membership: Parameters<typeof mayJoinSession>[3]; config: Pick<InstanceConfig, 'policy'>; actorId: string;
}): boolean {
  if (o.user.id === o.actorId || o.user.id.startsWith('svc_')) return false;
  if (!mayJoinSession(o.user, o.project, o.grants, o.membership)) return false;
  return mayReadComments({ user: o.user, session: o.session, project: o.project, membership: o.membership, grants: o.grants, config: o.config }).ok;
}

/**
 * Keep the requested ids that name eligible people, with their server-side
 * names, in request order. `skipped` counts the ids dropped (unknown,
 * ineligible, the actor, a service principal); the response never says which,
 * so a mention cannot be used to probe who exists.
 */
export async function eligibleMentionIds(
  d: { store: Store; config: Pick<InstanceConfig, 'policy'> },
  o: { session: SessionRecord; project: ProjectRecord; requested: readonly string[]; actorId: string; grants?: Grant[] },
): Promise<{ kept: CommentMention[]; skipped: number }> {
  const requested = [...new Set(o.requested)].slice(0, COMMENT_MENTION_LIMIT);
  if (!requested.length) return { kept: [], skipped: 0 };
  const grants = o.grants ?? await d.store.listGrants();
  const kept: CommentMention[] = [];
  for (const id of requested) {
    if (id === o.actorId || id.startsWith('svc_')) continue;
    const user = await d.store.getUser(id);
    if (!user) continue;
    const membership = await d.store.getProjectMember(o.project.id, user.id);
    if (mayBeMentioned({ user, session: o.session, project: o.project, grants, membership, config: d.config, actorId: o.actorId })) {
      kept.push({ id: user.id, name: mentionName(user) });
    }
  }
  return { kept, skipped: requested.length - kept.length };
}

/**
 * The mentions an edit keeps when the request names none: the previous ones
 * whose `@Name` still appears in the new text. Removing the name from the text
 * removes the mention; nothing else does.
 */
export function mentionsStillInBody(previous: readonly CommentMention[] | undefined, body: string): CommentMention[] {
  return (previous ?? []).filter((m) => body.includes(`@${m.name}`));
}
