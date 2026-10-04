// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { commentId, readCommentAnchor, readCommentThread, COMMENT_MESSAGE_LIMIT, COMMENT_BODY_LIMIT, COMMENT_THREAD_BYTES,
  type CommentThread } from '@lolly-tools/core/canvas-review-v1';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { Store, UserRecord, SessionRecord, ProjectRecord } from '../store/types.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import { nameWithoutEmail } from '../projects/sharing.ts';

interface Dependencies {
  config: InstanceConfig; store: Store;
  audit(actor: string, action: string, resource: string, detail: Record<string, unknown>): Promise<unknown>;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  sessionFor(res: ServerResponse, user: UserRecord, id: string | null): Promise<{ session: SessionRecord; project: ProjectRecord; access: ProjectAccess } | null>;
}
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const bodyText = (value: unknown): value is string => typeof value === 'string' && !!value.trim() && value.length <= COMMENT_BODY_LIMIT;

export function registerCommentRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  const gate = async (req: IncomingMessage, res: ServerResponse, id: string) => {
    const user = await d.memberOf(req);
    if (!user || user.id.startsWith('svc_')) { sendError(res, 401, 'UNAUTHORIZED', 'Comments need a signed-in person.'); return null; }
    const session = await d.sessionFor(res, user, id); if (!session) return null;
    const grants = await d.store.listGrants(), ctx = { userId: user.id, groups: user.groups, role: user.role as Role };
    const can = (action: string) => evaluate(ctx, action, ['*', `session:${id}`, `project:${session.project.id}`], grants);
    if (!can('session.view') || !can('comment.view')) { sendError(res, 403, 'FORBIDDEN', 'Comment access required.'); return null; }
    const enabled = d.config.policy.comments?.enabled !== false;
    const writable = enabled && !session.project.archivedAt;
    return { ...session, user, enabled, permissions: { userId: user.id,
      create: writable && can('comment.create'), editOwn: writable && can('comment.edit'),
      resolveAny: writable && accessAtLeast(session.access, 'editor') && can('comment.resolve'),
      deleteAny: writable && accessAtLeast(session.access, 'manager') && can('comment.moderate') } };
  };
  const path = '/api/v1/sessions/:id/comments';
  router.add('GET', path, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    const threads = access.enabled ? await d.store.listCommentThreads(access.session.id) : [];
    res.setHeader('Cache-Control', 'private, no-store');
    sendJson(res, 200, { enabled: access.enabled, permissions: access.permissions, threads });
  });
  router.add('POST', path, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.permissions.create) return sendError(res, 403, 'FORBIDDEN', 'Creating comments is disabled.');
    const body = await readJson(req, 16_000), anchor = object(body) ? readCommentAnchor(body.anchor) : null;
    if (!object(body) || !commentId(body.id) || !commentId(body.messageId) || !anchor || !bodyText(body.body))
      return sendError(res, 400, 'INVALID_INPUT', 'A valid anchor, message and identifiers are required.');
    const sendExisting = async () => {
      const previous = await d.store.getCommentThread(String(body.id));
      if (!previous) return false;
      if (previous.sessionId !== access.session.id || previous.authorId !== access.user.id
        || previous.messages[0]?.id !== body.messageId || previous.messages[0]?.body !== String(body.body).trim()
        || JSON.stringify(readCommentAnchor(previous.anchor)) !== JSON.stringify(anchor)) sendError(res, 409, 'CONFLICT', 'That comment identifier is already used.');
      else sendJson(res, 200, { thread: previous });
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
    const now = new Date().toISOString(), name = nameWithoutEmail(access.user).slice(0, 256);
    const thread: CommentThread = { id: body.id, sessionId: access.session.id, anchor, authorId: access.user.id, authorName: name,
      revision: 1, createdAt: now, updatedAt: now, messages: [{ id: body.messageId, authorId: access.user.id, authorName: name, body: body.body.trim(), createdAt: now }] };
    const created = await d.store.createCommentThread(thread);
    if (created === 'limit') return sendError(res, 409, 'COMMENT_LIMIT', 'This canvas has reached its comment limit.');
    if (created === 'exists') {
      if (!await sendExisting()) sendError(res, 409, 'CONFLICT', 'That comment identifier is already used.');
      return;
    }
    await d.audit(`user:${access.user.id}`, 'comment.create', `session:${thread.sessionId}`, { threadId: thread.id, anchorKind: thread.anchor.kind });
    sendJson(res, 201, { thread });
  });
  router.add('POST', `${path}/:threadId`, async (req, res, ctx) => {
    const access = await gate(req, res, ctx.params.id!); if (!access) return;
    if (!access.enabled) return sendError(res, 403, 'FORBIDDEN', 'Comments are disabled.');
    const body = await readJson(req, 16_000);
    if (!object(body) || !Number.isSafeInteger(body.revision) || typeof body.action !== 'string') return sendError(res, 400, 'INVALID_INPUT', 'A comment revision and action are required.');
    const previous = await d.store.getCommentThread(ctx.params.threadId!);
    if (!previous || previous.sessionId !== access.session.id) return sendError(res, 404, 'NOT_FOUND', 'No such comment.');
    if (body.action === 'reply' && commentId(body.messageId)) {
      const existing = previous.messages.find(message => message.id === body.messageId);
      if (existing) {
        if (existing.authorId === access.user.id && existing.body === (typeof body.body === 'string' ? body.body.trim() : body.body)) return sendJson(res, 200, { thread: previous });
        return sendError(res, 409, 'CONFLICT', 'That reply identifier is already used.');
      }
    }
    if (body.revision !== previous.revision) return sendError(res, 409, 'COMMENT_CHANGED', 'This thread changed. Refresh it before sending.');
    const next = structuredClone(previous), now = new Date().toISOString();
    if (body.action === 'reply') {
      if (!access.permissions.create) return sendError(res, 403, 'FORBIDDEN', 'Replying is disabled.');
      if (!commentId(body.messageId) || !bodyText(body.body)) return sendError(res, 400, 'INVALID_INPUT', 'A reply is required.');
      if (next.messages.length >= COMMENT_MESSAGE_LIMIT) return sendError(res, 409, 'COMMENT_LIMIT', 'This thread has reached its reply limit.');
      next.messages.push({ id: body.messageId, authorId: access.user.id, authorName: nameWithoutEmail(access.user).slice(0, 256), body: body.body.trim(), createdAt: now });
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
      } else { message.body = ''; message.deletedAt = now; }
    } else return sendError(res, 400, 'INVALID_INPUT', 'Unknown comment action.');
    next.revision++; next.updatedAt = now;
    if (JSON.stringify(next).length > COMMENT_THREAD_BYTES || !readCommentThread(next)) return sendError(res, 409, 'COMMENT_LIMIT', 'This thread is full.');
    if (!await d.store.casCommentThread(next, previous.revision)) return sendError(res, 409, 'COMMENT_CHANGED', 'This thread changed. Refresh it before sending.');
    await d.audit(`user:${access.user.id}`, `comment.${body.action}`, `session:${next.sessionId}`, { threadId: next.id, revision: next.revision });
    sendJson(res, 200, { thread: next });
  });
}
