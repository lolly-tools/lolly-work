// SPDX-License-Identifier: MPL-2.0
import type { IncomingMessage, ServerResponse } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { SUBJECT_CATEGORIES, SUBJECT_OMISSIONS, readSubjectCursor, subjectCursor, subjectLimit, subjectRow, type SubjectCategory } from './subject.ts';

interface Deps {
  router: ReturnType<typeof createRouter>; store: Store; secret: string;
  owner(req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload?: Record<string, unknown>): Promise<unknown>;
}

export function registerSubjectRoutes({ router, store, secret, owner, audit }: Deps): void {
  router.add('GET', '/api/v1/users/:id/subject-export', async (req, res, ctx) => {
    const reader = await owner(req, res);
    if (!reader) return;
    const target = await store.getUser(ctx.params.id!);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'No such account.');
    const category = ctx.url.searchParams.get('category') ?? 'identities';
    if (!SUBJECT_CATEGORIES.includes(category as SubjectCategory)) return sendError(res, 400, 'INVALID_INPUT', 'Choose a supported export category.');
    let limit: number, after: string;
    try {
      limit = subjectLimit(ctx.url.searchParams.get('limit'));
      after = readSubjectCursor(ctx.url.searchParams.get('cursor'), target.id, category as SubjectCategory, secret);
    } catch { return sendError(res, 400, 'INVALID_INPUT', 'Use a valid bounded page size and continuation cursor.'); }
    const observedAt = new Date().toISOString();
    const rows = await store.subjectRows(target.id, category as SubjectCategory, after, limit + 1);
    const page = rows.slice(0, limit);
    const nextCursor = rows.length > limit ? subjectCursor(target.id, category as SubjectCategory, page.at(-1)!.key, secret) : null;
    await audit(`user:${reader.id}`, 'user.subject-export.read', `user:${target.id}`, { category, count: page.length, continued: !!after, hasMore: !!nextCursor });
    const account = subjectRow(target.id, { id: target.id, sub: target.sub, email: target.email, firstname: target.firstname ?? null,
      lastname: target.lastname ?? null, title: target.title ?? null, groups: target.groups, role: target.role, disabledAt: target.disabledAt ?? null,
      telemetryConsent: target.telemetryConsent ?? null, createdAt: target.createdAt, lastSeenAt: target.lastSeenAt }).value;
    sendJson(res, 200, { version: 1, scope: 'account-and-direct-metadata', account, category, observedAt, rows: page.map(r => r.value),
      nextCursor, categories: SUBJECT_CATEGORIES, completeSubjectExport: false, snapshot: false, additionalOrRacingRecordsPossible: true,
      omissions: SUBJECT_OMISSIONS }, { 'cache-control': 'no-store' });
  });

  router.add('GET', '/api/v1/users/:id/offboarding-preview', async (req, res, ctx) => {
    const reader = await owner(req, res);
    if (!reader) return;
    const target = await store.getUser(ctx.params.id!);
    if (!target) return sendError(res, 404, 'NOT_FOUND', 'No such account.');
    const [credentials, links] = await Promise.all([store.subjectRows(target.id, 'credentials', '', 201), store.subjectRows(target.id, 'links', '', 201)]);
    await audit(`user:${reader.id}`, 'user.offboarding-preview.read', `user:${target.id}`);
    sendJson(res, 200, { userId: target.id, scope: 'disable-sessions-and-direct-issuance', disabled: !!target.disabledAt,
      self: reader.id === target.id, credentials: { observed: Math.min(200, credentials.length), truncated: credentials.length > 200 },
      links: { observed: Math.min(200, links.length), truncated: links.length > 200 }, boundPerIssuanceCategory: 1000,
      applyRechecks: true, additionalOrRacingRecordsPossible: true, completeOffboarding: false,
      reviewRequired: ['service credential descendants', 'ownership and shared content', 'identity provider and SCIM provisioning',
        'queued jobs and integrations', 'external sessions, copies and backups', 'separate erasure and retention decisions'] }, { 'cache-control': 'no-store' });
  });

  router.add('POST', '/api/v1/users/:id/offboard', async (req, res, ctx) => {
    const actor = await owner(req, res);
    if (!actor) return;
    const body = await readJson(req, 4096) as { confirmUserId?: unknown } | null;
    if (body?.confirmUserId !== ctx.params.id) return sendError(res, 400, 'INVALID_INPUT', 'Confirm the account id to disable and revoke its direct issuance.');
    const result = await store.offboardUser(ctx.params.id!, actor.id, new Date().toISOString(), 1000);
    if (result.status === 'not-found') return sendError(res, 404, 'NOT_FOUND', 'No such account.');
    if (result.status === 'self') return sendError(res, 409, 'OFFBOARD_SELF', 'Another owner must offboard this account.');
    if (result.status === 'last-owner') return sendError(res, 409, 'LAST_OWNER', 'Keep another active owner before disabling this account.');
    if (result.status === 'limit') return sendError(res, 409, 'OFFBOARD_LIMIT', 'Direct issuance exceeds the bounded batch. Revoke reviewed pages first and retry; this request made no changes.');
    await audit(`user:${actor.id}`, 'user.offboard', `user:${ctx.params.id}`, { ...result });
    sendJson(res, 200, { ...result, userId: ctx.params.id, scope: 'disable-sessions-and-direct-issuance', completeOffboarding: false,
      additionalOrRacingRecordsPossible: true, retainedOwnershipAndContent: true }, { 'cache-control': 'no-store' });
  });
}
