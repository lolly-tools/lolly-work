// SPDX-License-Identifier: MPL-2.0
/**
 * Inbox notices for comments (plan 76 milestone 4): "Ana mentioned you" and
 * "Ana replied", one row per person per thread, written after a comment is
 * saved.
 *
 * Rules:
 * - Best effort. The comment is already committed when this runs; a failure
 *   here is audited (`comment.notice.failed`, ids only) and the comment
 *   response still succeeds, saying `notified: false`.
 * - Recipients are the eligible people mentioned in the message plus, for a
 *   reply, the people already in the thread (its author and the authors of
 *   messages that are not deleted), never the writer. Each is checked again
 *   with `mayReceiveNotices` when the row is written, and at most
 *   `NOTICE_FANOUT_LIMIT` are notified per message.
 * - A writer may cause at most `ACTOR_NOTICE_LIMIT` notices per
 *   `ACTOR_NOTICE_WINDOW_MS`. The count is kept in memory and seeded from the
 *   database (`countNoticesByActorSince`) at the start of each window, so a
 *   restart does not reset it. Over the cap nothing is written and the cap is
 *   audited (`comment.notice.capped`).
 * - A mention notifies a person once per message: `recordMentionSends`
 *   remembers who was told, so removing and adding `@Name` again in later edits
 *   never notifies twice. A send that ends without a written notice (over a
 *   cap, refused at the write, or a failure) is forgotten again, so a later
 *   edit that still mentions the person can tell them.
 * - Each notice written, new or updated, prunes the person's notices past
 *   `NOTICE_KEEP` and older than `NOTICE_MAX_AGE_MS`; the inbox read prunes the
 *   old ones too (inbox/comment-notices.ts).
 * - Rows hold ids only. The inbox builds the title, the excerpt and the names
 *   when it is read, so an edited or deleted message, or an erased person's
 *   name, never stays behind in someone's inbox.
 * - Email is a seam that is off today (`PeopleNotifier.mailUser`). Only a new
 *   mention is mailed, never a reply, and the mail never includes the comment
 *   text. The document title is included only with `policy.comments.emailTitles`.
 */
import type { CommentMessage, CommentThread } from '@lolly-tools/core/canvas-review-v1';
import type { InstanceConfig } from '../config/instance.ts';
import { sessionLabel } from '../collab/invites.ts';
import type { MailParts, PeopleNotifier } from '../notify/people.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';
import type { ProjectRecord, SessionRecord, Store, UserRecord } from '../store/types.ts';
import { mayReceiveNotices } from './access.ts';

/** People one message may notify. */
export const NOTICE_FANOUT_LIMIT = 50;
/** Notices one writer may cause per window. */
export const ACTOR_NOTICE_LIMIT = 120;
export const ACTOR_NOTICE_WINDOW_MS = 10 * 60_000;
/** Notices a person keeps; older ones are pruned when a new one is written. */
export const NOTICE_KEEP = 200;
export const NOTICE_MAX_AGE_MS = 30 * 86_400_000;

/** The link to a thread: the shell's team-session route with the thread id. */
export function threadLink(appBase: string, sessionId: string, threadId: string): string {
  return `${appBase.replace(/\/+$/, '')}/#/team/${encodeURIComponent(sessionId)}?thread=${encodeURIComponent(threadId)}`;
}

/**
 * The mention mail. It takes no comment text at all, so no caller can put the
 * body in a mail. Without `emailTitles` it does not name the document either:
 * the title of a private document is not sent to a mail provider by default.
 */
export function mentionMailParts(o: { actorName: string; instance: string; url: string; label?: string; emailTitles: boolean }): MailParts {
  const where = o.emailTitles && o.label ? ` in ${o.label}` : '';
  return {
    subject: where ? `${o.actorName} mentioned you${where}` : `${o.actorName} mentioned you on ${o.instance}`,
    text: `${o.actorName} mentioned you${where} on ${o.instance}.\n\nOpen the thread: ${o.url}\n`,
  };
}

/** The in-memory per-writer allowance, with the database as its backstop. */
export interface ActorCap {
  take(actorId: string, n: number, recent: (sinceIso: string) => Promise<number>): Promise<boolean>;
}

export function createActorCap(o: { limit?: number; windowMs?: number; now?: () => number } = {}): ActorCap {
  const limit = o.limit ?? ACTOR_NOTICE_LIMIT, windowMs = o.windowMs ?? ACTOR_NOTICE_WINDOW_MS, now = o.now ?? Date.now;
  const windows = new Map<string, { start: number; n: number }>();
  const MAX_KEYS = 10_000;
  return {
    async take(actorId, n, recent) {
      const t = now();
      let w = windows.get(actorId);
      if (!w || t - w.start >= windowMs) {
        // A new window starts from what the database says this writer caused
        // in the last window, so a restart or another process is counted too.
        let seeded = 0;
        try { seeded = await recent(new Date(t - windowMs).toISOString()); } catch { seeded = 0; }
        const current = windows.get(actorId);
        w = current && t - current.start < windowMs ? current : { start: t, n: seeded };
        windows.delete(actorId);
        windows.set(actorId, w);
        if (windows.size > MAX_KEYS) windows.delete(windows.keys().next().value as string);
      }
      if (w.n + n > limit) return false;
      w.n += n;
      return true;
    },
  };
}

export interface NoticeDeps {
  store: Store;
  config: Pick<InstanceConfig, 'instance' | 'policy'>;
  audit(actor: string, action: string, resource: string, detail: Record<string, unknown>): Promise<unknown>;
  /** The mail seam; absent in tests that do not need it. */
  people?: Pick<PeopleNotifier, 'mailUser'>;
  cap: ActorCap;
  now?: () => number;
}

export interface NoticeEvent {
  session: SessionRecord;
  project: ProjectRecord;
  /** The thread as committed. */
  thread: CommentThread;
  /** The message that was written or edited. */
  message: CommentMessage;
  actor: UserRecord;
  /** Eligible people mentioned in the message (ids from `eligibleMentionIds`). */
  mentioned: readonly string[];
  /** What happened: a new thread, a reply, or an edit of a message. */
  kind: 'create' | 'reply' | 'edit';
}

export interface NoticeResult {
  /** False when someone who should have been told was not: over a cap, or a failure. */
  notified: boolean;
  /** Settles when any mail calls finish. The response never waits for it. */
  mailed: Promise<void>;
}

/** The thread's people: its author and the authors of messages that are not deleted. */
function participants(thread: CommentThread): string[] {
  return [thread.authorId, ...thread.messages.filter((m) => !m.deletedAt).map((m) => m.authorId)];
}

/** Write the notices for one saved comment. Never throws. */
export async function recordCommentNotices(d: NoticeDeps, e: NoticeEvent): Promise<NoticeResult> {
  const done = (notified: boolean, mailed: Promise<void> = Promise.resolve()): NoticeResult => ({ notified, mailed });
  const resource = `session:${e.session.id}`, actor = `user:${e.actor.id}`;
  // The mention sends this write recorded, and those whose notice was written.
  // `finally` forgets the rest, so a cap or a failure never uses up a person's
  // one notice for this message.
  let fresh = new Set<string>();
  const told = new Set<string>();
  try {
    // With notices off nobody is told, so a mention says so.
    if (d.config.policy.comments?.notices === false) return done(!e.mentioned.length);
    const nowMs = (d.now ?? Date.now)(), at = new Date(nowMs).toISOString();
    const mentioned = e.mentioned.filter((id) => id !== e.actor.id);
    fresh = new Set(mentioned.length ? await d.store.recordMentionSends(e.thread.id, e.message.id, mentioned, at) : []);
    const others = e.kind === 'reply' ? participants(e.thread) : [];
    const wanted = [...new Set([...mentioned.filter((id) => fresh.has(id)), ...others])].filter((id) => id !== e.actor.id);
    const notified = wanted.length <= NOTICE_FANOUT_LIMIT;
    const grants = await d.store.listGrants();
    const recipients: UserRecord[] = [];
    for (const id of wanted.slice(0, NOTICE_FANOUT_LIMIT)) {
      const user = await d.store.getUser(id);
      if (!user) continue;
      const membership = await d.store.getProjectMember(e.project.id, user.id);
      if (mayReceiveNotices({ user, session: e.session, project: e.project, membership, grants, config: d.config }).ok) recipients.push(user);
    }
    if (!recipients.length) return done(notified);
    if (!await d.cap.take(e.actor.id, recipients.length, (since) => d.store.countNoticesByActorSince(e.actor.id, since))) {
      await d.audit(actor, 'comment.notice.capped', resource, { threadId: e.thread.id, messageId: e.message.id, recipients: recipients.length });
      return done(false);
    }
    const mails: Promise<unknown>[] = [];
    const prunedBefore = new Date(nowMs - NOTICE_MAX_AGE_MS).toISOString();
    for (const user of recipients) {
      const isMention = fresh.has(user.id);
      const result = await d.store.upsertCommentNotice({
        userId: user.id, threadId: e.thread.id, sessionId: e.session.id, projectId: e.project.id,
        kind: isMention ? 'mention' : 'reply', actorId: e.actor.id, messageId: e.message.id, at, mentioned: isMention,
      });
      if (isMention) told.add(user.id);
      // An updated row can leave older ones of the person's behind, so every
      // write prunes, not only a new row.
      await d.store.pruneCommentNotices(user.id, NOTICE_KEEP, prunedBefore);
      if (result !== 'created') continue;
      if (isMention && d.people) {
        const parts = mentionMailParts({
          actorName: nameWithoutEmail(e.actor), instance: d.config.instance.name,
          url: threadLink(d.config.instance.appUrl ?? d.config.instance.baseUrl, e.session.id, e.thread.id),
          label: sessionLabel(e.session), emailTitles: d.config.policy.comments?.emailTitles === true,
        });
        mails.push(d.people.mailUser(user.id, parts, 'mention').catch(() => 'failed'));
      }
    }
    return done(notified, Promise.allSettled(mails).then(() => undefined));
  } catch {
    try { await d.audit(actor, 'comment.notice.failed', resource, { threadId: e.thread.id, messageId: e.message.id }); } catch { /* audit is best effort here too */ }
    return done(false);
  } finally {
    const untold = [...fresh].filter((id) => !told.has(id));
    if (untold.length) await d.store.forgetMentionSends(e.thread.id, e.message.id, untold).catch(() => 0);
  }
}
