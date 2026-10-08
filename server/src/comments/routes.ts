// SPDX-License-Identifier: MPL-2.0
/**
 * Review comments on a session (plan 76): threads, replies, mentions, read
 * state and the people a comment may mention.
 *
 * Every route opens with the same gate: a signed-in person (never a service
 * token), the session read gate (`sessionFor`: 404, 403, 410), and
 * `mayReadComments` (comments/access.ts), the one predicate the notices and
 * the inbox use too. Writes are rate limited per person. After a write is
 * saved, peers in the session's room get a `comment` event with ids only
 * (`roomEvents`), and the people the write concerns get an inbox notice
 * (comments/notices.ts).
 *
 * Paths: the collection routes for reads and people are siblings of
 * `/comments` (`/comment-reads`, `/comment-people`), not children of it. The
 * router takes the first pattern that matches, so `/comments/read` would be
 * read as a thread id.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { commentId, readCommentAnchor, readCommentThread, COMMENT_MESSAGE_LIMIT, COMMENT_BODY_LIMIT, COMMENT_THREAD_BYTES,
  type CommentMention, type CommentMessage, type CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { eligibleInvitees, normalizeQuery } from '../collab/invites.ts';
import { sha256Hex } from '../lib/crypto.ts';
import type { PeopleNotifier } from '../notify/people.ts';
import { createWindowQuota } from '../projects/sharing.ts';
import type { Store, UserRecord, SessionRecord, ProjectRecord } from '../store/types.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { mayReadComments } from './access.ts';
import { eligibleMentionIds, mentionName, mentionsStillInBody, readMentionRequest } from './mentions.ts';
import { createActorCap, recordCommentNotices } from './notices.ts';

/** The live event peers get after a comment write: ids and a revision, no text. */
export interface CommentEventFrame { t: 'comment'; threadId: string; revision: number }

interface Dependencies {
  config: InstanceConfig; store: Store;
  audit(actor: string, action: string, resource: string, detail: Record<string, unknown>): Promise<unknown>;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  sessionFor(res: ServerResponse, user: UserRecord, id: string | null): Promise<{ session: SessionRecord; project: ProjectRecord; access: ProjectAccess } | null>;
  /** The mail seam for mention notices; mail stays off without it. */
  people?: Pick<PeopleNotifier, 'mailUser'>;
  /** Sends a `comment` event to the session's live room (AppDeps.roomEvents).
   *  Undefined where no room runs (the Vercel function); GET then reports
   *  `features.events: false` and the shell keeps polling. */
  roomEvents?: (sessionId: string, frame: CommentEventFrame) => void;
}

/** Per-person write limits: every create and every command counts. */
export const COMMENT_WRITES_PER_MINUTE = 30;
export const COMMENT_WRITES_PER_HOUR = 300;
export const COMMENT_READS_PER_MINUTE = 120;
export const COMMENT_PEOPLE_PER_MINUTE = 60;
/** Threads one `comment-reads` call may name. */
export const COMMENT_READS_MAX_IDS = 100;

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bodyText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= COMMENT_BODY_LIMIT;
const isoTime = (value: unknown): value is string => typeof value === 'string' && value.length <= 32 && Number.isFinite(Date.parse(value));
const ifNoneMatch = (req: IncomingMessage, etag: string): boolean =>
  String(req.headers['if-none-match'] ?? '').split(',').map((t) => t.trim().replace(/^W\//, '')).includes(etag);
const PRIVATE = { 'cache-control': 'private, no-store' };

export function registerCommentRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  const quotas = {
    writeMinute: createWindowQuota(COMMENT_WRITES_PER_MINUTE, 60_000),
    writeHour: createWindowQuota(COMMENT_WRITES_PER_HOUR, 3_600_000),
    reads: createWindowQuota(COMMENT_READS_PER_MINUTE, 60_000),
    people: createWindowQuota(COMMENT_PEOPLE_PER_MINUTE, 60_000),
  };
  /** Spend one unit of each quota for `userId`, or answer 429 and return false. */
  const allowed = (res: ServerResponse, userId: string, ...limits: Array<[ReturnType<typeof createWindowQuota>, number]>): boolean => {
    for (const [quota, retryAfterSec] of limits) {
      if (quota.take(userId)) continue;
      res.setHeader('retry-after', String(retryAfterSec));
      sendError(res, 429, 'RATE_LIMITED', 'Too many comment requests. Try again in a moment.');
      return false;
    }
    return true;
  };
  const writeAllowed = (res: ServerResponse, userId: string) => allowed(res, userId, [quotas.writeMinute, 60], [quotas.writeHour, 3600]);
  const noticeDeps = { store: d.store, config: d.config, audit: d.audit, ...(d.people ? { people: d.people } : {}), cap: createActorCap() };

  const gate = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const user = await d.memberOf(req);
    if (!user || user.id.startsWith('svc_')) { sendError(res, 401, 'UNAUTHORIZED', 'Comments need a signed-in person.'); return null; }
    const found = await d.sessionFor(res, user, id); if (!found) return null;
    const [grants, membership] = await Promise.all([d.store.listGrants(), d.store.getProjectMember(found.project.id, user.id)]);
    const read = mayReadComments({ user, session: found.session, project: found.project, membership, grants, config: d.config });
    if (!read.ok && read.reason === 'gone') { sendError(res, 410, 'SESSION_DELETED', 'this session was deleted'); return null; }
    if (!read.ok && read.reason === 'forbidden') { sendError(res, 403, 'FORBIDDEN', 'Comment access required.'); return null; }
    const enabled = read.ok, can = read.ok ? read.can : () => false;
    const writable = enabled && !found.project.archivedAt;
    return { ...found, user, grants, enabled, permissions: { userId: user.id,
      create: writable && can('comment.create'), editOwn: writable && can('comment.edit'),
      resolveAny: writable && accessAtLeast(found.access, 'editor') && can('comment.resolve'),
      deleteAny: writable && accessAtLeast(found.access, 'manager') && can('comment.moderate') } };
  };
  type Access = NonNullable<Awaited<ReturnType<typeof gate>>>;
  const mentionsOn = () => d.config.policy.comments?.mentions !== false;
  /** The eligible people among `requested`; none while mentions are off. */
  const keepMentions = async (access: Access, requested: readonly string[]): Promise<CommentMention[]> =>
    mentionsOn() && requested.length ? (await eligibleMentionIds({ store: d.store, config: d.config },
      { session: access.session, project: access.project, requested, actorId: access.user.id, grants: access.grants })).kept : [];
  /** Tell the room, best effort: a peer that misses it still polls. */
  const announce = (thread: CommentThread) => {
    try { d.roomEvents?.(thread.sessionId, { t: 'comment', threadId: thread.id, revision: thread.revision }); } catch { /* polling covers it */ }
  };
  const notify = async (access: Access, thread: CommentThread, message: CommentMessage, mentions: readonly CommentMention[], kind: 'create' | 'reply' | 'edit') =>
    (await recordCommentNotices(noticeDeps, { session: access.session, project: access.project, thread, message, actor: access.user,
      mentioned: mentions.map((m) => m.id), kind })).notified;

  const path = '/api/v1/sessions/:id/comments';
  router.add('GET', path, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    const features = { mentions: access.enabled && mentionsOn(), reads: true, events: !!d.roomEvents, thread: true };
    let body: Record<string, unknown> = { enabled: false, permissions: access.permissions, threads: [], reads: {}, notices: [], features };
    if (access.enabled) {
      const [threads, state, notices] = await Promise.all([d.store.listCommentThreads(access.session.id),
        d.store.readCommentState(access.user.id, access.session.id), d.store.listCommentNotices(access.user.id)]);
      body = { enabled: true, permissions: access.permissions, threads, reads: state.reads, readFloor: state.floorAt,
        notices: notices.filter((n) => n.sessionId === access.session.id).map((n) => n.threadId), features };
    }
    const etag = `"cm-${sha256Hex(JSON.stringify(body)).slice(0, 24)}"`;
    if (ifNoneMatch(req, etag)) { res.writeHead(304, { etag, ...PRIVATE }); res.end(); return; }
    sendJson(res, 200, body, { etag, ...PRIVATE });
  });
  router.add('GET', `${path}/:threadId`, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.enabled) return sendError(res, 403, 'FORBIDDEN', 'Comments are disabled.');
    const thread = commentId(ctx.params.threadId) ? await d.store.getCommentThread(ctx.params.threadId) : null;
    if (!thread || thread.sessionId !== access.session.id) return sendError(res, 404, 'NOT_FOUND', 'No such comment.');
    const readAt = (await d.store.readCommentState(access.user.id, access.session.id)).reads[thread.id];
    sendJson(res, 200, { thread, ...(readAt ? { readAt } : {}) }, PRIVATE);
  });
  router.add('POST', path, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.permissions.create) return sendError(res, 403, 'FORBIDDEN', 'Creating comments is disabled.');
    if (!writeAllowed(res, access.user.id)) return;
    const body = await readJson(req, 16_000), anchor = object(body) ? readCommentAnchor(body.anchor) : null;
    if (!object(body) || !commentId(body.id) || !commentId(body.messageId) || !anchor || !bodyText(body.body))
      return sendError(res, 400, 'INVALID_INPUT', 'A valid anchor, message and identifiers are required.');
    const requested = body.mentions === undefined ? [] : readMentionRequest(body.mentions);
    if (!requested) return sendError(res, 400, 'INVALID_INPUT', 'mentions must be a list of at most 10 person ids.');
    const sendExisting = async () => {
      const previous = await d.store.getCommentThread(String(body.id));
      if (!previous) return false;
      if (previous.sessionId !== access.session.id || previous.authorId !== access.user.id
        || previous.messages[0]?.id !== body.messageId || previous.messages[0]?.body !== String(body.body).trim()
        || JSON.stringify(readCommentAnchor(previous.anchor)) !== JSON.stringify(anchor)) sendError(res, 409, 'CONFLICT', 'That comment identifier is already used.');
      // A retry of a comment that was saved: its notices were written then.
      else sendJson(res, 200, { thread: previous, notified: true });
      return true;
    };
    if (await sendExisting()) return;
    // Object anchors are created only for live rows. Later deletion leaves the
    // thread findable; undo of the same stable ID restores its pin.
    if (anchor.kind === 'object') {
      const rows = access.session.inputs[anchor.collection];
      if (!Array.isArray(rows) || !rows.some(row => object(row) && (row.id === anchor.objectId || row.__rid === anchor.objectId)))
        return sendError(res, 409, 'ANCHOR_MISSING', 'The object was removed. Place a canvas comment instead.');
    }
    const mentions = await keepMentions(access, requested);
    const now = new Date().toISOString(), name = mentionName(access.user);
    const message: CommentMessage = { id: body.messageId, authorId: access.user.id, authorName: name, body: body.body.trim(), createdAt: now,
      ...(mentions.length ? { mentions } : {}) };
    const thread: CommentThread = { id: body.id, sessionId: access.session.id, anchor, authorId: access.user.id, authorName: name,
      revision: 1, createdAt: now, updatedAt: now, messages: [message] };
    const created = await d.store.createCommentThread(thread);
    if (created === 'limit') return sendError(res, 409, 'COMMENT_LIMIT', 'This canvas has reached its comment limit.');
    if (created === 'exists') {
      if (!await sendExisting()) sendError(res, 409, 'CONFLICT', 'That comment identifier is already used.');
      return;
    }
    await d.audit(`user:${access.user.id}`, 'comment.create', `session:${thread.sessionId}`, { threadId: thread.id, anchorKind: thread.anchor.kind,
      mentioned: mentions.map((m) => m.id) });
    announce(thread);
    sendJson(res, 201, { thread, notified: await notify(access, thread, message, mentions, 'create') });
  });
  router.add('POST', `${path}/:threadId`, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.enabled) return sendError(res, 403, 'FORBIDDEN', 'Comments are disabled.');
    if (!writeAllowed(res, access.user.id)) return;
    const body = await readJson(req, 16_000);
    if (!object(body) || !Number.isSafeInteger(body.revision) || typeof body.action !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'A comment revision and action are required.');
    const requested = body.mentions === undefined || !['reply', 'edit'].includes(body.action) ? undefined : readMentionRequest(body.mentions);
    if (requested === null) return sendError(res, 400, 'INVALID_INPUT', 'mentions must be a list of at most 10 person ids.');
    const previous = await d.store.getCommentThread(ctx.params.threadId!);
    if (!previous || previous.sessionId !== access.session.id) return sendError(res, 404, 'NOT_FOUND', 'No such comment.');
    if (body.action === 'reply' && commentId(body.messageId)) {
      const existing = previous.messages.find(message => message.id === body.messageId);
      if (existing) {
        if (existing.authorId === access.user.id && existing.body === (typeof body.body === 'string' ? body.body.trim() : body.body)) return sendJson(res, 200, { thread: previous, notified: true });
        return sendError(res, 409, 'CONFLICT', 'That reply identifier is already used.');
      }
    }
    if (body.revision !== previous.revision) return sendError(res, 409, 'COMMENT_CHANGED', 'This thread changed. Refresh it before sending.');
    const next = structuredClone(previous), now = new Date().toISOString();
    let written: CommentMessage | undefined, mentions: CommentMention[] = [];
    if (body.action === 'reply') {
      if (!access.permissions.create) return sendError(res, 403, 'FORBIDDEN', 'Replying is disabled.');
      if (!commentId(body.messageId) || !bodyText(body.body)) return sendError(res, 400, 'INVALID_INPUT', 'A reply is required.');
      if (next.messages.length >= COMMENT_MESSAGE_LIMIT) return sendError(res, 409, 'COMMENT_LIMIT', 'This thread has reached its reply limit.');
      mentions = await keepMentions(access, requested ?? []);
      written = { id: body.messageId, authorId: access.user.id, authorName: mentionName(access.user), body: body.body.trim(), createdAt: now,
        ...(mentions.length ? { mentions } : {}) };
      next.messages.push(written);
    } else if (body.action === 'resolve' || body.action === 'reopen') {
      if (!(access.permissions.resolveAny || access.permissions.create && previous.authorId === access.user.id)) return sendError(res, 403, 'FORBIDDEN', 'You cannot resolve this thread.');
      if (body.action === 'resolve') { next.resolvedAt = now; next.resolvedBy = access.user.id; }
      else { delete next.resolvedAt; delete next.resolvedBy; }
    } else if (body.action === 'edit' || body.action === 'delete') {
      const message = next.messages.find(message => message.id === body.messageId);
      if (!message || message.deletedAt) return sendError(res, 404, 'NOT_FOUND', 'No such message.');
      const own = access.permissions.editOwn && message.authorId === access.user.id;
      if (!own && !(body.action === 'delete' && access.permissions.deleteAny)) return sendError(res, 403, 'FORBIDDEN', 'You cannot change this message.');
      if (body.action === 'edit') {
        if (!bodyText(body.body)) return sendError(res, 400, 'INVALID_INPUT', 'A message is required.');
        message.body = body.body.trim(); message.editedAt = now;
        // No list in the request keeps the mentions whose @Name is still in the text.
        mentions = requested === undefined ? mentionsStillInBody(message.mentions, message.body) : await keepMentions(access, requested);
        if (mentions.length) message.mentions = mentions; else delete message.mentions;
        written = message;
      } else { message.body = ''; message.deletedAt = now; delete message.mentions; }
    } else return sendError(res, 400, 'INVALID_INPUT', 'Unknown comment action.');
    next.revision++; next.updatedAt = now;
    if (JSON.stringify(next).length > COMMENT_THREAD_BYTES || !readCommentThread(next)) return sendError(res, 409, 'COMMENT_LIMIT', 'This thread is full.');
    if (!await d.store.casCommentThread(next, previous.revision)) return sendError(res, 409, 'COMMENT_CHANGED', 'This thread changed. Refresh it before sending.');
    await d.audit(`user:${access.user.id}`, `comment.${body.action}`, `session:${next.sessionId}`, { threadId: next.id, revision: next.revision,
      ...(written ? { mentioned: mentions.map((m) => m.id) } : {}) });
    announce(next);
    const notified = written && (body.action === 'reply' || body.action === 'edit')
      ? await notify(access, next, written, mentions, body.action) : true;
    sendJson(res, 200, { thread: next, notified });
  });

  // Read state: the caller's own rows only. No `threadIds` marks every thread
  // in the session; `at` defaults to now and is never later than now.
  router.add('POST', '/api/v1/sessions/:id/comment-reads', async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.enabled) return sendError(res, 403, 'FORBIDDEN', 'Comments are disabled.');
    if (!allowed(res, access.user.id, [quotas.reads, 60])) return;
    const body = (await readJson(req, 16_000)) ?? {};
    if (!object(body)) return sendError(res, 400, 'INVALID_INPUT', 'A JSON object is required.');
    const ids = body.threadIds;
    if (ids !== undefined && (!Array.isArray(ids) || ids.length > COMMENT_READS_MAX_IDS || !ids.every((id) => commentId(id))))
      return sendError(res, 400, 'INVALID_INPUT', `threadIds must be a list of at most ${COMMENT_READS_MAX_IDS} thread ids.`);
    if (body.at !== undefined && !isoTime(body.at)) return sendError(res, 400, 'INVALID_INPUT', 'at must be an ISO time.');
    const inSession = new Set((await d.store.listCommentThreads(access.session.id)).map((t) => t.id));
    const threadIds = ids === undefined ? [...inSession] : [...new Set(ids as string[])];
    if (threadIds.some((id) => !inSession.has(id))) return sendError(res, 404, 'NOT_FOUND', 'No such comment.');
    const nowMs = Date.now(), readAt = new Date(Math.min(isoTime(body.at) ? Date.parse(body.at) : nowMs, nowMs)).toISOString();
    if (threadIds.length) {
      await d.store.markCommentsRead(access.user.id, access.session.id, threadIds.map((threadId) => ({ threadId, at: readAt })));
      await d.store.deleteCommentNotices(access.user.id, { threadIds });
    }
    sendJson(res, 200, { readAt, count: threadIds.length }, PRIVATE);
  });

  // Who the caller may mention: people who can open this session and read its
  // comments, prefix matched, at most 20, without the caller and without any
  // address. Only for someone who may comment here.
  router.add('GET', '/api/v1/sessions/:id/comment-people', async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.permissions.create) return sendError(res, 403, 'FORBIDDEN', 'Commenting is not available to you here.');
    if (!mentionsOn()) return sendError(res, 403, 'FORBIDDEN', 'Mentions are off for this workspace.');
    if (!allowed(res, access.user.id, [quotas.people, 60])) return;
    const q = normalizeQuery(ctx.url.searchParams.get('q'));
    const [users, memberships] = await Promise.all([d.store.listUsers(), d.store.listProjectMembers(access.project.id)]);
    const byUser = new Map(memberships.map((m) => [m.userId, m])), grants = access.grants;
    const { invitees, truncated } = eligibleInvitees({ users, project: access.project, grants, memberships, callerId: access.user.id, q,
      include: (u) => mayReadComments({ user: u, session: access.session, project: access.project, membership: byUser.get(u.id) ?? null, grants, config: d.config }).ok });
    sendJson(res, 200, { people: invitees, truncated }, PRIVATE);
  });
}
