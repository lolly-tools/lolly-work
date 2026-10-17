// SPDX-License-Identifier: MPL-2.0
/**
 * File references over HTTP (docs/api.md "File references"; uploads/files.ts).
 * A member or a service token holding `tool.use` keeps small bytes as a
 * reference in one request, or a larger file through the parts protocol in
 * scope `file` (uploads/routes.ts), then lists, describes, reads and deletes
 * its own references. Every route on one reference answers the same 404 to
 * anyone but its owner, and every route answers 404 while
 * `policy.uploads.enabled` is false.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';
import { INERT_BYTE_HEADERS } from '../api/file-delivery.ts';
import { createRouter, readJson, sendError, sendJson } from '../api/router.ts';
import type { BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { sha256, transferChunks } from './parts.ts';
import {
  createFileReference, creationRefusal, FILE_INLINE_MAX_BYTES, FILE_LIST_LIMIT, FILE_REPORT_MAX_BYTES, fileCursor, fileMetadata, fileWire,
  ownsFileReference, parseFileCursor, usableFile,
} from './files.ts';
import { removeUpload, sweepExpiredUploads, uploadDescription, uploadOwner, uploadParts, uploadPolicy, type UploadRecord } from './scoped.ts';

interface Dependencies {
  config: InstanceConfig;
  store: Store;
  blobs: BlobStore;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  serviceAccountOf(req: IncomingMessage): Promise<UserRecord | null>;
  /** True for a request a document agent makes for a person (agents/project-requests.ts). */
  delegated(req: IncomingMessage): boolean;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** What one owner may read back in a day, in instance upload budgets, as for
 *  project files: every byte may come out of a metered database. */
const READ_BUDGETS_PER_DAY = 2;
/** The largest create body: the base64 of FILE_INLINE_MAX_BYTES, a report and the names. */
const INLINE_BODY_BYTES = Math.ceil(FILE_INLINE_MAX_BYTES / 3) * 4 + FILE_REPORT_MAX_BYTES + 16 * 1024;
const BASE64 = /^[A-Za-z0-9+/]*={0,2}$/;

export function registerFileRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  /**
   * A member or a service token that holds `tool.use` right now. Resolved
   * afresh on every request, with no cache, so a revoked token, a disabled
   * account, ended sessions or a denied `tool.use` refuse the next request.
   * A document agent acts inside one document and never holds a person's files.
   */
  const caller = async (req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null> => {
    if (!uploadPolicy(d.config).enabled) { sendError(res, 404, 'NOT_FOUND', 'uploads are off'); return null; }
    if (d.delegated(req)) { sendError(res, 403, 'FORBIDDEN', 'file references need the person or a service token'); return null; }
    const user = (await d.memberOf(req)) ?? (await d.serviceAccountOf(req));
    if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    if (user.role === 'guest' || user.disabledAt) { sendError(res, 403, 'FORBIDDEN', 'file references need a member or a service token'); return null; }
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, 'tool.use', ['*'], await d.store.listGrants())) {
      sendError(res, 403, 'FORBIDDEN', 'tool.use required'); return null;
    }
    return user;
  };
  /** The caller's own usable reference, or the one 404 every other case gets:
   *  never issued, someone else's, another scope, unfinished or expired. */
  const owned = async (res: ServerResponse, user: UserRecord, id: string): Promise<UploadRecord | null> => {
    const file = await d.store.getUpload(id);
    if (!file || !usableFile(file, uploadOwner(user))) { sendError(res, 404, 'NOT_FOUND', 'no such file reference'); return null; }
    return file;
  };
  // Bytes each owner read back in the day since their first read in it, per process.
  const reads = new Map<string, { since: number; bytes: number }>();
  /** Seconds until `bytes` more fit in the owner's day, or 0 after counting them. */
  const readWait = (owner: string, bytes: number, perDay: number): number => {
    const now = Date.now();
    if (reads.size >= 10_000) for (const [id, w] of reads) if (w.since + DAY_MS <= now) reads.delete(id);
    let w = reads.get(owner);
    if (!w || w.since + DAY_MS <= now) { w = { since: now, bytes: 0 }; reads.set(owner, w); }
    if (w.bytes + bytes > perDay) return Math.max(1, Math.ceil((w.since + DAY_MS - now) / 1000));
    w.bytes += bytes;
    return 0;
  };

  router.add('GET', '/api/v1/files', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const cursor = ctx.url.searchParams.get('cursor');
    const before = cursor === null ? undefined : parseFileCursor(cursor);
    if (before === null) return sendError(res, 400, 'INVALID_INPUT', 'cursor is the nextCursor of an earlier page');
    const limitParam = ctx.url.searchParams.get('limit');
    const limit = limitParam === null ? FILE_LIST_LIMIT : Number(limitParam);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > FILE_LIST_LIMIT) return sendError(res, 400, 'INVALID_INPUT', `limit is a whole number from 1 to ${FILE_LIST_LIMIT}`);
    // One more than the page, to know whether another page follows.
    const files = await d.store.listUploads(uploadOwner(user), limit + 1, { scope: 'file', ready: true, ...(before ? { before } : {}) });
    const page = files.slice(0, limit);
    sendJson(res, 200, { files: page.map(fileWire), nextCursor: files.length > limit ? fileCursor(page[page.length - 1]!) : null });
  }, { delivery: 'person-private' });

  router.add('POST', '/api/v1/files', async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const policy = uploadPolicy(d.config), owner = uploadOwner(user);
    let body: Record<string, unknown> | null;
    try { body = await readJson(req, INLINE_BODY_BYTES) as Record<string, unknown> | null; }
    catch (error) {
      if ((error as { status?: number }).status === 413) return sendError(res, 413, 'PAYLOAD_TOO_LARGE', `one request keeps at most ${FILE_INLINE_MAX_BYTES} bytes; upload a larger file in parts with scope file`);
      throw error;
    }
    if (!body || typeof body !== 'object' || Array.isArray(body)) return sendError(res, 400, 'INVALID_INPUT', 'JSON object body required');
    const encoded = body.bytesBase64;
    if (typeof encoded !== 'string' || !encoded || encoded.length % 4 !== 0 || !BASE64.test(encoded)) return sendError(res, 400, 'INVALID_INPUT', 'bytesBase64 is the file as canonical base64');
    const bytes = Buffer.from(encoded, 'base64');
    if (bytes.toString('base64') !== encoded) return sendError(res, 400, 'INVALID_INPUT', 'bytesBase64 is the file as canonical base64');
    const maxBytes = Math.min(FILE_INLINE_MAX_BYTES, policy.maxFileBytes);
    if (bytes.length > maxBytes) return sendError(res, 413, 'UPLOAD_TOO_LARGE', `one request keeps at most ${maxBytes} bytes; upload a larger file in parts with scope file`, { maxBytes });
    // The same name and media type rules as an upload's begin.
    const described = uploadDescription(body);
    if (!described) return sendError(res, 400, 'INVALID_INPUT', 'a name of 1 to 200 characters and a plain media type are required');
    const metadata = fileMetadata(body);
    if (typeof metadata === 'string') return sendError(res, 400, 'INVALID_INPUT', metadata);
    if (body.checksum !== undefined && body.checksum !== sha256(bytes)) return sendError(res, 422, 'CHECKSUM_MISMATCH', 'the bytes do not match checksum');
    // An output names one of the owner's own references; any other is the same 404.
    if (metadata.derivedFrom && !await ownsFileReference(d.store, owner, metadata.derivedFrom)) return sendError(res, 404, 'NOT_FOUND', 'no such file reference');
    await sweepExpiredUploads(d.store, d.blobs).catch(() => 0);
    const created = await createFileReference({ store: d.store, blobs: d.blobs, policy }, owner, bytes, {
      ...described, role: metadata.role,
      ...(metadata.derivedFrom ? { derivedFrom: metadata.derivedFrom } : {}),
      ...(metadata.report ? { report: { by: 'owner' as const, report: metadata.report } } : {}),
    });
    if (!created.ok) { const [status, code, message] = creationRefusal(created.refusal); return sendError(res, status, code, message); }
    await d.audit(`user:${user.id}`, 'file.create', `file:${created.file.id}`, { size: created.file.size, checksum: created.file.checksum, role: metadata.role });
    sendJson(res, 201, { file: fileWire(created.file) }, { 'cache-control': 'no-store' });
  });

  router.add('GET', '/api/v1/files/:id', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const file = await owned(res, user, ctx.params.id!);
    if (!file) return;
    sendJson(res, 200, { file: fileWire(file), report: file.report?.report ?? null }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/files/:id/content', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const file = await owned(res, user, ctx.params.id!);
    if (!file) return;
    const wait = readWait(file.owner, file.size, READ_BUDGETS_PER_DAY * uploadPolicy(d.config).instanceBudgetBytes);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return sendError(res, 429, 'RATE_LIMITED', 'you have read back a lot of files today; try again later');
    }
    // Inert whatever the declared type, and checked as it streams: a part or a
    // whole file that fails its declared digest cuts the body short.
    res.writeHead(200, {
      ...INERT_BYTE_HEADERS, 'content-type': file.contentType, 'content-length': String(file.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'cache-control': 'private, no-store',
      etag: `"${file.checksum}"`, 'repr-digest': `sha-256=:${Buffer.from(file.checksum, 'hex').toString('base64')}:`,
    });
    Readable.from(transferChunks(uploadParts(d.blobs, file))).on('error', () => res.destroy()).pipe(res);
  }, { delivery: 'person-private' });

  router.add('DELETE', '/api/v1/files/:id', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const file = await owned(res, user, ctx.params.id!);
    if (!file) return;
    await removeUpload(d.store, d.blobs, file);
    await d.audit(`user:${user.id}`, 'file.delete', `file:${file.id}`, { size: file.size, checksum: file.checksum, role: file.role ?? 'original' });
    res.writeHead(204); res.end();
  });
}
