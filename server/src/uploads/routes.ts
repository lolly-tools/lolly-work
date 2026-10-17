// SPDX-License-Identifier: MPL-2.0
/**
 * Scoped uploads over HTTP (docs/api.md "Uploads"; uploads/scoped.ts). A
 * signed-in person or a service token begins an upload in one scope, sends
 * its parts, asks which parts arrived after an interruption, and finalizes;
 * the bytes are then named by reference, never downloaded. The list shows the
 * caller's own uploads, and every route on one upload is its owner's alone and
 * answers 404 to anyone else. Every route answers 404 while
 * `policy.uploads.enabled` is false. A finished upload in scope `file` is a
 * file reference, which its owner also reads back (file-routes.ts).
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, readRaw, sendError, sendJson } from '../api/router.ts';
import type { BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import { randomId } from '../lib/crypto.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { parsePartIndex, RunningDigests, storeTransferPart, TRANSFER_PART_BYTES, transferProgress, verifyTransfer } from './parts.ts';
import {
  finishedUploadExpiry, finishedUploadTtlHours, isUploadScope, liveUpload, removeUpload, sweepExpiredUploads, unfinishedUploadExpiry, uploadIdPrefix, uploadInput,
  uploadOwner, uploadParts, uploadPolicy, uploadWire, UPLOAD_LIST_LIMIT, UPLOAD_PENDING_LIMIT, type UploadRecord, type UploadScope,
} from './scoped.ts';
import { fileMetadata, fileWire, ownsFileReference, type FileMetadata } from './files.ts';

interface Dependencies {
  config: InstanceConfig;
  store: Store;
  blobs: BlobStore;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  serviceAccountOf(req: IncomingMessage): Promise<UserRecord | null>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
}

/** The action each scope's begin needs: the right to submit to the catalog,
 *  or to use tools, which the document verbs an automation input or a file
 *  reference feeds need. */
const SCOPE_ACTION: Record<UploadScope, string> = { 'catalog-submission': 'catalog.submit', 'automation-input': 'tool.use', file: 'tool.use' };

export function registerUploadRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  /** A signed-in person or a service token; never a guest seat or an anonymous caller. */
  const caller = async (req: IncomingMessage, res: ServerResponse): Promise<UserRecord | null> => {
    if (!uploadPolicy(d.config).enabled) { sendError(res, 404, 'NOT_FOUND', 'uploads are off'); return null; }
    const user = (await d.memberOf(req)) ?? (await d.serviceAccountOf(req));
    if (!user) { sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    if (user.role === 'guest' || user.disabledAt) { sendError(res, 403, 'FORBIDDEN', 'uploads need a member or a service token'); return null; }
    return user;
  };
  /** The caller's own upload, or a 404 that says nothing about anyone else's. */
  const owned = async (res: ServerResponse, user: UserRecord, id: string): Promise<UploadRecord | null> => {
    const upload = await d.store.getUpload(id);
    if (!upload || upload.owner !== uploadOwner(user)) { sendError(res, 404, 'NOT_FOUND', 'no such upload'); return null; }
    return upload;
  };
  const running = new RunningDigests();
  /** A finished upload, and for a file reference what the files routes show of it. */
  const finishedWire = (u: UploadRecord) => ({ upload: uploadWire(u), ...(u.scope === 'file' ? { file: fileWire(u) } : {}) });

  router.add('GET', '/api/v1/uploads', async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const policy = uploadPolicy(d.config), owner = uploadOwner(user);
    const [uploads, usage] = await Promise.all([d.store.listUploads(owner, UPLOAD_LIST_LIMIT), d.store.uploadUsage(owner)]);
    sendJson(res, 200, {
      uploads: uploads.map(uploadWire),
      limits: {
        partBytes: TRANSFER_PART_BYTES, maxBytes: policy.maxFileBytes, ownerBudgetBytes: policy.ownerBudgetBytes,
        ownerUsedBytes: usage.ownerBytes, instanceRemainingBytes: Math.max(0, policy.instanceBudgetBytes - usage.instanceBytes),
      },
    }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('POST', '/api/v1/uploads', async (req, res) => {
    const user = await caller(req, res);
    if (!user) return;
    const policy = uploadPolicy(d.config);
    const body = await readJson(req, 512 * 1024) as Record<string, unknown> | null;
    const scope = body && typeof body === 'object' ? body.scope : undefined;
    if (!isUploadScope(scope)) return sendError(res, 400, 'INVALID_INPUT', 'scope is catalog-submission, automation-input or file');
    const action = SCOPE_ACTION[scope];
    if (!evaluate({ userId: user.id, groups: user.groups, role: user.role as Role }, action, ['*'], await d.store.listGrants())) {
      return sendError(res, 403, 'FORBIDDEN', `${action} required`);
    }
    // A catalog original can be no larger than a submission may be.
    const maxBytes = scope === 'catalog-submission' ? Math.min(policy.maxFileBytes, d.config.policy.submit.maxBytes) : policy.maxFileBytes;
    if (typeof body?.size === 'number' && Number.isSafeInteger(body.size) && body.size > maxBytes) {
      return sendError(res, 413, 'UPLOAD_TOO_LARGE', `an upload in this scope can be at most ${maxBytes} bytes`, { maxBytes });
    }
    const input = uploadInput(body, maxBytes);
    if (!input) return sendError(res, 400, 'INVALID_INPUT', 'invalid upload metadata or part checksums');
    // A file reference also says whether it is an output, and of which of the
    // caller's own references; naming any other is the same 404.
    let file: FileMetadata | undefined;
    if (scope === 'file') {
      const metadata = fileMetadata(body!);
      if (typeof metadata === 'string') return sendError(res, 400, 'INVALID_INPUT', metadata);
      if (metadata.derivedFrom && !await ownsFileReference(d.store, uploadOwner(user), metadata.derivedFrom)) return sendError(res, 404, 'NOT_FOUND', 'no such file reference');
      file = metadata;
    }
    // Best effort: the retention run and the timer sweep as well.
    await sweepExpiredUploads(d.store, d.blobs).catch(() => 0);
    const now = Date.now(), createdAt = new Date(now).toISOString();
    const upload: UploadRecord = { ...input, id: `${uploadIdPrefix(scope)}${randomId(16)}`, owner: uploadOwner(user), createdAt,
      expiresAt: unfinishedUploadExpiry(createdAt, policy.uploadTtlHours, now), ready: false,
      ...(file ? { role: file.role, ...(file.derivedFrom ? { derivedFrom: file.derivedFrom } : {}), ...(file.report ? { report: { by: 'owner' as const, report: file.report } } : {}) } : {}) };
    const outcome = await d.store.reserveUpload(upload, {
      ownerBudgetBytes: policy.ownerBudgetBytes, instanceBudgetBytes: policy.instanceBudgetBytes, maxPending: UPLOAD_PENDING_LIMIT,
    });
    if (outcome === 'owner-budget') return sendError(res, 413, 'UPLOAD_BUDGET', 'your uploads have no room for that file; cancel or use some first');
    if (outcome === 'instance-budget') return sendError(res, 413, 'INSTANCE_UPLOAD_BUDGET', 'this instance has no room for that upload');
    if (outcome === 'pending') return sendError(res, 413, 'UPLOAD_PENDING', 'finish or cancel your unfinished uploads first');
    if (outcome !== 'reserved') return sendError(res, 409, 'CONFLICT', 'start the upload again');
    sendJson(res, 201, { upload: { ...uploadWire(upload), parts: upload.parts }, partBytes: TRANSFER_PART_BYTES }, { 'cache-control': 'no-store' });
  });

  router.add('GET', '/api/v1/uploads/:id', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const upload = await owned(res, user, ctx.params.id!);
    if (!upload) return;
    if (!liveUpload(upload)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    sendJson(res, 200, { upload: uploadWire(upload) }, { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  // Resume: which parts are stored. Reading this keeps nothing alive.
  router.add('GET', '/api/v1/uploads/:id/parts', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const upload = await owned(res, user, ctx.params.id!);
    if (!upload) return;
    if (!liveUpload(upload)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    const progress = upload.ready
      ? { partBytes: TRANSFER_PART_BYTES, parts: upload.parts.length, missing: [], receivedParts: upload.parts.length, receivedBytes: upload.size, offset: upload.size }
      : await transferProgress(uploadParts(d.blobs, upload));
    sendJson(res, 200, { id: upload.id, ready: upload.ready, size: upload.size, checksum: upload.checksum, expiresAt: upload.expiresAt, ...progress },
      { 'cache-control': 'no-store' });
  }, { delivery: 'person-private' });

  router.add('PUT', '/api/v1/uploads/:id/parts/:part', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const upload = await owned(res, user, ctx.params.id!);
    if (!upload) return;
    if (upload.ready) return sendError(res, 409, 'UPLOAD_READY', 'this upload is already complete');
    if (!liveUpload(upload)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    const n = parsePartIndex(ctx.params.part);
    if (!upload.parts[n]) return sendError(res, 400, 'INVALID_PART', 'no such part');
    const bytes = await readRaw(req, TRANSFER_PART_BYTES);
    if (await storeTransferPart(uploadParts(d.blobs, upload), n, bytes) !== 'stored') return sendError(res, 422, 'CHECKSUM_MISMATCH', 'part does not match the declared bytes');
    // An accepted part keeps the upload alive. A cancel or the expiry can land
    // while the bytes were in flight: take back a part whose upload is gone.
    const expires = unfinishedUploadExpiry(upload.createdAt, uploadPolicy(d.config).uploadTtlHours);
    if (!await d.store.touchUpload(upload.id, expires)) {
      await d.blobs.delete(uploadParts(d.blobs, upload).partId(n));
      return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    }
    running.track(upload.id, n, bytes, Date.parse(expires));
    res.writeHead(204); res.end();
  });

  router.add('POST', '/api/v1/uploads/:id/finalize', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const upload = await owned(res, user, ctx.params.id!);
    if (!upload) return;
    if (!liveUpload(upload)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    if (upload.ready) return sendJson(res, 200, finishedWire(upload), { 'cache-control': 'no-store' });
    const check = await verifyTransfer(uploadParts(d.blobs, upload), running.digest(upload.id, upload.parts.length));
    if (!check.ok) return sendError(res, check.code === 'UPLOAD_INCOMPLETE' ? 409 : 422, check.code, check.message);
    const expiresAt = finishedUploadExpiry(finishedUploadTtlHours(uploadPolicy(d.config), upload.scope));
    if (!await d.store.completeUpload(upload.id, expiresAt)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    running.forget(upload.id);
    const finished = (await d.store.getUpload(upload.id)) ?? { ...upload, ready: true, expiresAt };
    if (upload.scope === 'file') await d.audit(`user:${user.id}`, 'file.create', `file:${upload.id}`, { size: upload.size, checksum: upload.checksum, role: upload.role ?? 'original' });
    else await d.audit(`user:${user.id}`, 'upload.finish', `upload:${upload.id}`, { scope: upload.scope, size: upload.size, checksum: upload.checksum });
    sendJson(res, 200, finishedWire(finished), { 'cache-control': 'no-store' });
  });

  router.add('DELETE', '/api/v1/uploads/:id', async (req, res, ctx) => {
    const user = await caller(req, res);
    if (!user) return;
    const upload = await owned(res, user, ctx.params.id!);
    if (!upload) return;
    await removeUpload(d.store, d.blobs, upload);
    running.forget(upload.id);
    await d.audit(`user:${user.id}`, 'upload.delete', `upload:${upload.id}`, { scope: upload.scope, size: upload.size, ready: upload.ready });
    res.writeHead(204); res.end();
  });
}
