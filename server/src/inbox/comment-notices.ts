// SPDX-License-Identifier: MPL-2.0
/**
 * Comment notices in the inbox (plan 76 milestone 4): "Ana mentioned you in
 * Spring poster" and "Ana replied in Spring poster", read from the
 * `comment_notices` rows that comments/notices.ts writes.
 *
 * Rules:
 * - A row holds ids, a kind and a count. Everything a person reads is built
 *   here, when the inbox is read: the title, the excerpt of the newest message
 *   by someone else, the actor's name and the document's label. An edited or
 *   deleted message, a renamed document or an erased person's name never
 *   stays behind in anyone's inbox.
 * - Access is checked again on every read with `mayReceiveNotices`, the same
 *   predicate the comments routes and the notice write use. The rows are
 *   grouped by document, so each document and its project are loaded once and
 *   the predicate runs once per document, never once per notice.
 * - A notice whose document is gone, or whose project the person can no
 *   longer reach at all, is deleted: it cannot come back. One hidden by a
 *   grant or by the instance policy is kept, so lifting the refusal shows it
 *   again, until it is older than `NOTICE_MAX_AGE_MS`: every read prunes those,
 *   because a hidden notice is never written again and so never pruned by a
 *   write (comments/notices.ts).
 * - The threads come from one `getCommentThreadsByIds` read and the actors'
 *   names from one `getUsersByIds` read. No query runs per notice.
 * - The server's text is English (plans/75 C20). Lolly renders its own
 *   translated title from `data` and builds the thread link from
 *   `data.sessionId` and `data.threadId`, never from `cta.url`.
 */
import type { CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { sessionLabel } from '../collab/invites.ts';
import { mayReceiveNotices } from '../comments/access.ts';
import { NOTICE_KEEP, NOTICE_MAX_AGE_MS, threadLink } from '../comments/notices.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';
import type { Grant } from '../rbac/evaluate.ts';
import { projectAccess } from '../rbac/project-access.ts';
import type { CommentNotice, SessionRecord, Store, UserRecord } from '../store/types.ts';
import type { Message } from './target.ts';

/** How much of the newest message the inbox shows, in characters. */
export const NOTICE_EXCERPT_CHARS = 140;
/** The body of a notice whose thread holds no message by someone else any more. */
export const NOTICE_GONE_BODY = 'This comment is no longer available.';
/** Longest title the inbox carries, as every other inbox message. */
const MAX_TITLE_CHARS = 200;

/** A comment notice as an inbox row: the same fields as every other inbox
 *  message, with its own `kind`. */
export type CommentInboxMessage = Omit<Message, 'kind'> & { kind: 'comment' };

export interface InboxNoticeDeps {
  store: Store;
  config: Pick<InstanceConfig, 'instance' | 'policy'>;
  now?: () => number;
}

/** A notice the person may see now, with the document it points into. */
export interface AccessibleNotice { notice: CommentNotice; session: SessionRecord }

const clip = (text: string, max: number): string => Array.from(text).slice(0, max).join('');

/**
 * The person's notices that pass `mayReceiveNotices` now, newest first. Rows
 * older than `NOTICE_MAX_AGE_MS`, rows for a document that is gone, and rows
 * for a project the person can no longer reach are deleted as a side effect
 * (best effort: a failed delete only means they are tried again on the next
 * read). `grants` may be passed by a caller that already holds them.
 */
export async function accessibleNotices(d: InboxNoticeDeps, user: UserRecord, o: { grants?: Grant[] } = {}): Promise<AccessibleNotice[]> {
  const listed = await d.store.listCommentNotices(user.id);
  if (!listed.length) return [];
  // The age limit holds while notices are hidden or switched off too. Only a
  // read that finds an expired row writes anything.
  const cutoff = (d.now ?? Date.now)() - NOTICE_MAX_AGE_MS;
  const notices = listed.filter((n) => Date.parse(n.createdAt) >= cutoff);
  if (notices.length < listed.length) await d.store.pruneCommentNotices(user.id, NOTICE_KEEP, new Date(cutoff).toISOString()).catch(() => 0);
  // Off for the whole instance: every notice is hidden, and none is deleted
  // before its time.
  const policy = d.config.policy.comments;
  if (policy?.enabled === false || policy?.notices === false || !notices.length) return [];
  const sessionIds = [...new Set(notices.map((n) => n.sessionId))];
  const [sessions, grants, memberships] = await Promise.all([
    Promise.all(sessionIds.map((id) => d.store.getSession(id))),
    o.grants ? Promise.resolve(o.grants) : d.store.listGrants(),
    d.store.listUserProjectMemberships(user.id),
  ]);
  // The project comes from the document, never from the notice row.
  const projectIds = [...new Set(sessions.flatMap((s) => (s ? [s.projectId] : [])))];
  const projects = new Map((await Promise.all(projectIds.map((id) => d.store.getProject(id)))).flatMap((p) => (p ? [[p.id, p] as const] : [])));
  const memberOf = new Map(memberships.map((m) => [m.projectId, m]));
  const gone: string[] = [];
  const open = new Map<string, SessionRecord>();
  sessionIds.forEach((id, i) => {
    const session = sessions[i];
    const project = session ? projects.get(session.projectId) : undefined;
    const membership = project ? memberOf.get(project.id) ?? null : null;
    if (!session || session.deletedAt || !project || projectAccess(user, project, membership) === 'none') { gone.push(id); return; }
    if (mayReceiveNotices({ user, session, project, membership, grants, config: d.config }).ok) open.set(id, session);
  });
  if (gone.length) await d.store.deleteCommentNotices(user.id, { sessionIds: gone }).catch(() => 0);
  return notices.flatMap((notice) => {
    const session = open.get(notice.sessionId);
    return session ? [{ notice, session }] : [];
  });
}

/** The newest message in the thread that someone other than `recipientId`
 *  wrote and nobody deleted. */
function newestByOthers(thread: CommentThread | undefined, recipientId: string): string | undefined {
  if (!thread) return undefined;
  for (let i = thread.messages.length - 1; i >= 0; i--) {
    const m = thread.messages[i]!;
    if (!m.deletedAt && m.authorId !== recipientId && m.body.trim()) return m.body;
  }
  return undefined;
}

/**
 * One notice as an inbox row. Pure: the caller loads the thread, the actor
 * and the document. The title names the actor and the document; a reply
 * notice that counts several replies says how many instead of who.
 */
export function noticeMessage(n: CommentNotice, ctx: {
  session: SessionRecord;
  /** The thread as stored now; absent or from another document reads as no message left. */
  thread: CommentThread | undefined;
  /** The person who caused the newest event; absent when the account is gone. */
  actor: Pick<UserRecord, 'firstname' | 'lastname' | 'email'> | undefined;
  /** Base URL of the Lolly app: '' when it is served from this origin. */
  appBase: string;
}): CommentInboxMessage {
  const actorName = ctx.actor ? nameWithoutEmail({ firstname: ctx.actor.firstname, lastname: ctx.actor.lastname, email: ctx.actor.email ?? '' }) : 'Member';
  const label = sessionLabel(ctx.session);
  const title = n.kind === 'mention' ? `${actorName} mentioned you in ${label}`
    : n.count > 1 ? `New replies in ${label}: ${n.count}` : `${actorName} replied in ${label}`;
  const latest = newestByOthers(ctx.thread && ctx.thread.sessionId === n.sessionId ? ctx.thread : undefined, n.userId);
  return {
    id: n.id,
    kind: 'comment',
    severity: 'info',
    audience: { users: [n.userId] },
    title: clip(title, MAX_TITLE_CHARS),
    body: latest === undefined ? NOTICE_GONE_BODY : clip(latest, NOTICE_EXCERPT_CHARS),
    cta: { label: 'Open thread', url: threadLink(ctx.appBase, n.sessionId, n.threadId) },
    data: {
      kind: n.kind === 'mention' ? 'comment-mention' : 'comment-reply',
      sessionId: n.sessionId, projectId: ctx.session.projectId, threadId: n.threadId,
      actorName, label, count: String(n.count), at: n.createdAt,
    },
    dismissible: true,
  };
}

/**
 * The person's comment notices as inbox rows, newest first: the accessible
 * rows, their threads in one read and their actors in one read.
 */
export async function listAccessibleNotices(d: InboxNoticeDeps, user: UserRecord, o: { grants?: Grant[] } = {}): Promise<CommentInboxMessage[]> {
  const rows = await accessibleNotices(d, user, o);
  if (!rows.length) return [];
  const [threads, actors] = await Promise.all([
    d.store.getCommentThreadsByIds([...new Set(rows.map((r) => r.notice.threadId))]),
    d.store.getUsersByIds([...new Set(rows.map((r) => r.notice.actorId))]),
  ]);
  const threadById = new Map(threads.map((t) => [t.id, t]));
  const actorById = new Map(actors.map((u) => [u.id, u]));
  const appBase = d.config.instance.appUrl ?? '';
  return rows.map(({ notice, session }) => noticeMessage(notice, {
    session, thread: threadById.get(notice.threadId), actor: actorById.get(notice.actorId), appBase,
  }));
}
