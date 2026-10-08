// SPDX-License-Identifier: MPL-2.0
/**
 * Shared project files over HTTP (plans/74; docs/api.md "Project files").
 * Anyone who can see the project lists and downloads its ready files; an
 * editor uploads (begin, parts, finalize); the uploader or a project manager
 * deletes. Every route answers 404 while the feature is off
 * (`projectFilesEnabled`).
 */
import { createHash, type Hash } from 'node:crypto';
import { Readable } from 'node:stream';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createRouter, readJson, readRaw, sendError, sendJson } from '../api/router.ts';
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { Store, UserRecord } from '../store/types.ts';
import { accessAtLeast, type ProjectAccess } from '../rbac/project-access.ts';
import { randomId } from '../lib/crypto.ts';
import { nameWithoutEmail } from './sharing.ts';
import {
  activeProjectFile, fileChecksum, filePartBlobId, projectFileExpiry, projectFileInput, projectFilePolicy, projectFilesEnabled, projectFileWire,
  removeProjectFile, sweepExpiredProjectFiles, validProjectFileName, PROJECT_FILE_PART_BYTES, PROJECT_FILE_PENDING_FILES, PROJECT_FILE_PENDING_LIMIT,
  type ProjectFileRecord,
} from './files.ts';

interface Dependencies {
  config: InstanceConfig;
  store: Store;
  blobs: BlobStore;
  memberOf(req: IncomingMessage): Promise<UserRecord | null>;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string): Promise<UserRecord | null>;
  projectAccessOf(user: UserRecord, project: NonNullable<Awaited<ReturnType<Store['getProject']>>>): Promise<ProjectAccess>;
  audit(actor: string, action: string, subject: string, payload: Record<string, unknown>): Promise<unknown>;
  /** The person a render worker reads one file for (render/read-ticket.ts); admits nothing but the file read route. */
  renderFileReader?(req: IncomingMessage, projectId: string): Promise<UserRecord | null>;
}

const DAY_MS = 24 * 60 * 60 * 1000;
const SHA256 = /^[a-f0-9]{64}$/;
/** Uploads whose running digest this process keeps at once (see `running`). */
const RUNNING_LIMIT = 256;
/** What one person may download in a day, in instance budgets. Every byte is
 *  read out of the database, whose host may meter that (Neon Free: 5 GB a
 *  month), and the shell keeps what it fetched, so only a runaway client
 *  comes near this. */
const DOWNLOAD_BUDGETS_PER_DAY = 2;

export function registerProjectFileRoutes(router: ReturnType<typeof createRouter>, d: Dependencies): void {
  /** read: viewer. write: `session.create` plus editor, and not archived.
   *  rename uses `session.edit` with the same project access.
   *  delete: viewer here; the route then wants the uploader or a manager.
   *  Every mode wants a signed-in person, never a service token. */
  const gate = async (req: IncomingMessage, res: ServerResponse, projectId: string, mode: 'read' | 'write' | 'rename' | 'delete'): Promise<{ user: UserRecord; access: ProjectAccess } | null> => {
    if (!projectFilesEnabled(d.config, d.store)) { sendError(res, 404, 'NOT_FOUND', 'project files are off'); return null; }
    const write = mode === 'write' || mode === 'rename';
    const user = write ? await d.requireAction(req, res, mode === 'rename' ? 'session.edit' : 'session.create') : await d.memberOf(req) ?? (mode === 'read' ? await d.renderFileReader?.(req, projectId) ?? null : null);
    if (!user) { if (!write) sendError(res, 401, 'UNAUTHORIZED', 'sign in first'); return null; }
    // A service token passes requireAction, but a file names the person who
    // uploaded it and the read routes take people only.
    if (user.id.startsWith('svc_')) { sendError(res, 403, 'FORBIDDEN', 'project files need a signed-in person'); return null; }
    const project = await d.store.getProject(projectId);
    if (!project) { sendError(res, 404, 'NOT_FOUND', 'no such project'); return null; }
    const access = await d.projectAccessOf(user, project);
    if (!accessAtLeast(access, write ? 'editor' : 'viewer')) {
      sendError(res, 403, 'FORBIDDEN', 'project access required'); return null;
    }
    if (write && project.archivedAt) { sendError(res, 409, 'ARCHIVED', 'this project is archived'); return null; }
    return { user, access };
  };
  const find = async (res: ServerResponse, projectId: string, id: string): Promise<ProjectFileRecord | null> => {
    const file = await d.store.getProjectFile(id);
    if (!file || file.projectId !== projectId) { sendError(res, 404, 'NOT_FOUND', 'no such project file'); return null; }
    return file;
  };

  // The digest of each upload whose parts arrive in order, so finalize need
  // not read every byte back out of the database. Per process and bounded: a
  // restart, an out-of-order part or another instance means finalize reads the
  // parts back instead. Only verified bytes ever reach a digest.
  const running = new Map<string, { next: number; hash: Hash; expires: number }>();
  const track = (file: ProjectFileRecord, n: number, bytes: Uint8Array, expires: number): void => {
    const now = Date.now();
    for (const [id, r] of running) if (r.expires <= now) running.delete(id);
    let r = running.get(file.id);
    if (!r && n === 0 && running.size < RUNNING_LIMIT) {
      r = { next: 0, hash: createHash('sha256'), expires };
      running.set(file.id, r);
    }
    // A retried part is already in the digest; a skipped one breaks the chain.
    if (r?.next === n) { r.hash.update(bytes); r.next++; r.expires = expires; }
  };
  // Bytes each person downloaded in the day since their first download in it, per process.
  const downloads = new Map<string, { since: number; bytes: number }>();
  /** Seconds until `bytes` more fit in the person's day, or 0 after counting them. */
  const downloadWait = (userId: string, bytes: number, perDay: number): number => {
    const now = Date.now();
    if (downloads.size >= 10_000) for (const [id, w] of downloads) if (w.since + DAY_MS <= now) downloads.delete(id);
    let w = downloads.get(userId);
    if (!w || w.since + DAY_MS <= now) { w = { since: now, bytes: 0 }; downloads.set(userId, w); }
    if (w.bytes + bytes > perDay) return Math.max(1, Math.ceil((w.since + DAY_MS - now) / 1000));
    w.bytes += bytes;
    return 0;
  };

  router.add('GET', '/api/v1/projects/:id/files', async (req, res, ctx) => {
    if (!await gate(req, res, ctx.params.id!, 'read')) return;
    const policy = projectFilePolicy(d.config);
    const [files, usage] = await Promise.all([d.store.listProjectFiles(ctx.params.id!), d.store.projectFileUsage(ctx.params.id!)]);
    const uploaders = [...new Set(files.map((f) => f.createdBy))];
    // Any viewer reads this list, so a name never falls back to an email.
    const names = new Map(uploaders.length ? (await d.store.getUsersByIds(uploaders)).map((u) => [u.id, nameWithoutEmail(u)]) : []);
    sendJson(res, 200, {
      files: files.map((f) => projectFileWire(f, names)),
      limits: {
        partBytes: PROJECT_FILE_PART_BYTES, maxBytes: policy.maxFileBytes, projectBudgetBytes: policy.projectBudgetBytes,
        projectUsedBytes: usage.projectBytes, instanceRemainingBytes: Math.max(0, policy.instanceBudgetBytes - usage.instanceBytes),
      },
    }, { 'cache-control': 'private, no-store' });
  });
  router.add('POST', '/api/v1/projects/:id/files', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'write');
    if (!gated) return;
    const policy = projectFilePolicy(d.config);
    const body = await readJson(req, 512 * 1024);
    const size = body && typeof body === 'object' ? (body as { size?: unknown }).size : undefined;
    if (typeof size === 'number' && Number.isSafeInteger(size) && size > policy.maxFileBytes) {
      return sendError(res, 413, 'PROJECT_FILE_TOO_LARGE', `a shared file can be at most ${policy.maxFileBytes} bytes`, { maxBytes: policy.maxFileBytes });
    }
    const input = projectFileInput(body);
    if (!input) return sendError(res, 400, 'INVALID_INPUT', 'invalid file metadata or part checksums');
    // Best effort: the retention run sweeps as well, so a failure here only
    // leaves litter that no budget counts.
    await sweepExpiredProjectFiles(d.store, d.blobs).catch(() => 0);
    const now = Date.now(), createdAt = new Date(now).toISOString();
    const file: ProjectFileRecord = { ...input, id: `fil_${randomId(16)}`, projectId: ctx.params.id!, createdBy: gated.user.id,
      createdAt, expiresAt: projectFileExpiry(createdAt, policy.uploadTtlHours, now), ready: false };
    const outcome = await d.store.reserveProjectFile(file, {
      projectBudgetBytes: policy.projectBudgetBytes, instanceBudgetBytes: policy.instanceBudgetBytes,
      maxPending: PROJECT_FILE_PENDING_LIMIT, maxPendingBytes: PROJECT_FILE_PENDING_FILES * policy.maxFileBytes,
    });
    if (outcome === 'project-budget') return sendError(res, 413, 'PROJECT_FILE_BUDGET', 'this project has no room for that file; delete files to make room');
    if (outcome === 'instance-budget') return sendError(res, 413, 'INSTANCE_FILE_BUDGET', 'this instance has no room for that file');
    if (outcome === 'pending') return sendError(res, 413, 'PROJECT_FILE_PENDING', 'finish or cancel your unfinished uploads first');
    if (outcome !== 'reserved') return sendError(res, 404, 'NOT_FOUND', 'no such project');
    sendJson(res, 201, { file, partBytes: PROJECT_FILE_PART_BYTES }, { 'cache-control': 'no-store' });
  });
  router.add('PUT', '/api/v1/projects/:id/files/:fileId/parts/:part', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'write');
    if (!gated) return;
    const file = await find(res, ctx.params.id!, ctx.params.fileId!);
    if (!file) return;
    if (file.createdBy !== gated.user.id) return sendError(res, 403, 'FORBIDDEN', 'only the uploader may complete this file');
    if (file.ready) return sendError(res, 409, 'FILE_READY', 'this file is already complete');
    if (!activeProjectFile(file)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    const n = Number(ctx.params.part);
    const part = /^\d+$/.test(ctx.params.part!) && Number.isSafeInteger(n) ? file.parts[n] : undefined;
    if (!part) return sendError(res, 400, 'INVALID_PART', 'no such part');
    const bytes = await readRaw(req, PROJECT_FILE_PART_BYTES);
    if (bytes.length !== part.size || fileChecksum(bytes) !== part.checksum) return sendError(res, 422, 'CHECKSUM_MISMATCH', 'part does not match the declared bytes');
    await d.blobs.put(filePartBlobId(file, n), bytes, 'application/octet-stream');
    // An accepted part keeps the upload alive. A cancel or the expiry can land
    // while the bytes were in flight: take back a part whose upload is gone,
    // so it cannot outlive the row that finds it (see removeProjectFile).
    const expires = projectFileExpiry(file.createdAt, projectFilePolicy(d.config).uploadTtlHours);
    if (!await d.store.touchProjectFile(file.id, expires)) {
      await d.blobs.delete(filePartBlobId(file, n));
      return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    }
    track(file, n, bytes, Date.parse(expires));
    res.writeHead(204); res.end();
  });
  router.add('POST', '/api/v1/projects/:id/files/:fileId/finalize', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'write');
    if (!gated) return;
    const file = await find(res, ctx.params.id!, ctx.params.fileId!);
    if (!file) return;
    if (file.createdBy !== gated.user.id) return sendError(res, 403, 'FORBIDDEN', 'only the uploader may complete this file');
    if (!activeProjectFile(file)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    if (file.ready) return sendJson(res, 200, { file }, { 'cache-control': 'no-store' });
    // Each part's stored size and sha256 come from its stat, so nothing is
    // read back where the driver reports a sha256 (memory, pg). S3 reports an
    // ETag instead, so those parts are read and hashed.
    let readBack = false;
    for (let n = 0; n < file.parts.length; n++) {
      const part = file.parts[n]!;
      const stat = await d.blobs.head(filePartBlobId(file, n));
      if (!stat) return sendError(res, 409, 'UPLOAD_INCOMPLETE', 'upload every part first');
      if (stat.size !== part.size || (SHA256.test(stat.checksum) && stat.checksum !== part.checksum)) {
        return sendError(res, 422, 'CHECKSUM_MISMATCH', 'stored part failed verification');
      }
      if (!SHA256.test(stat.checksum)) readBack = true;
    }
    // The whole-file digest: one part is the whole file (projectFileInput
    // holds the two digests equal); otherwise the running digest, else the
    // parts read back.
    const r = running.get(file.id);
    let digest: string;
    if (!readBack && file.parts.length === 1) digest = file.parts[0]!.checksum;
    else if (!readBack && r?.next === file.parts.length) digest = r.hash.copy().digest('hex');
    else {
      const hash = createHash('sha256');
      for (let n = 0; n < file.parts.length; n++) {
        const part = file.parts[n]!;
        const stored = await d.blobs.get(filePartBlobId(file, n));
        if (!stored) return sendError(res, 409, 'UPLOAD_INCOMPLETE', 'upload every part first');
        const bytes = await readBlobBody(stored.body, PROJECT_FILE_PART_BYTES);
        if (bytes.length !== part.size || fileChecksum(bytes) !== part.checksum) return sendError(res, 422, 'CHECKSUM_MISMATCH', 'stored part failed verification');
        hash.update(bytes);
      }
      digest = hash.digest('hex');
    }
    if (digest !== file.checksum) return sendError(res, 422, 'CHECKSUM_MISMATCH', 'file failed verification');
    if (!await d.store.completeProjectFile(file.id)) return sendError(res, 410, 'UPLOAD_EXPIRED', 'start a new upload');
    running.delete(file.id);
    await d.audit(`user:${gated.user.id}`, 'project.file-upload', `project:${file.projectId}`, { fileId: file.id, name: file.name, size: file.size, checksum: file.checksum });
    sendJson(res, 200, { file: { ...file, ready: true } }, { 'cache-control': 'no-store' });
  });
  router.add('GET', '/api/v1/projects/:id/files/:fileId', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'read');
    if (!gated) return;
    const file = await find(res, ctx.params.id!, ctx.params.fileId!);
    if (!file) return;
    if (!file.ready) return sendError(res, 404, 'NOT_FOUND', 'file is not complete');
    const wait = downloadWait(gated.user.id, file.size, DOWNLOAD_BUDGETS_PER_DAY * projectFilePolicy(d.config).instanceBudgetBytes);
    if (wait) {
      res.setHeader('retry-after', String(wait));
      return sendError(res, 429, 'RATE_LIMITED', 'you have downloaded a lot of shared files today; try again later');
    }
    // Every part is checked as it streams, and the whole file before its last
    // part goes out, so a body that fails its declared digest is cut short.
    const bytes = async function* () {
      const whole = createHash('sha256');
      for (let n = 0; n < file.parts.length; n++) {
        const stored = await d.blobs.get(filePartBlobId(file, n));
        if (!stored) throw new Error('project file part unavailable');
        const data = await readBlobBody(stored.body, PROJECT_FILE_PART_BYTES);
        if (data.length !== file.parts[n]!.size || fileChecksum(data) !== file.parts[n]!.checksum) throw new Error('project file part failed verification');
        whole.update(data);
        if (n === file.parts.length - 1 && whole.digest('hex') !== file.checksum) throw new Error('project file failed verification');
        yield data;
      }
    };
    res.writeHead(200, { 'content-type': file.contentType, 'content-length': String(file.size),
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'x-content-type-options': 'nosniff',
      'cache-control': 'private, no-store', etag: `"${file.checksum}"` });
    Readable.from(bytes()).on('error', () => res.destroy()).pipe(res);
  });
  router.add('PATCH', '/api/v1/projects/:id/files/:fileId', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'rename'); if (!gated) return;
    const project = await d.store.getProject(ctx.params.id!);
    if (!project) return sendError(res, 404, 'NOT_FOUND', 'no such project');
    const body = await readJson(req) as { name?: unknown } | null;
    // The same rule as an upload's name (files.ts), so a renamed file stays downloadable.
    if (!validProjectFileName(body?.name)) return sendError(res, 400, 'INVALID_INPUT', 'a file name of 1 to 200 characters, without control characters, is required');
    const name = body.name.trim();
    if (!await d.store.renameProjectFile(project.id, ctx.params.fileId!, name)) return sendError(res, 404, 'NOT_FOUND', 'no such ready file');
    await d.audit(`user:${gated.user.id}`, 'project.file-rename', `project:${project.id}`, { fileId: ctx.params.fileId });
    sendJson(res, 200, { name });
  });
  // Delete a ready file, or cancel an unfinished upload. A ready file that a
  // live session in the project still uses is refused unless a manager says
  // ?force=1, since those sessions would open without it.
  router.add('DELETE', '/api/v1/projects/:id/files/:fileId', async (req, res, ctx) => {
    const gated = await gate(req, res, ctx.params.id!, 'delete');
    if (!gated) return;
    const file = await find(res, ctx.params.id!, ctx.params.fileId!);
    if (!file) return;
    const manager = accessAtLeast(gated.access, 'manager');
    if (file.createdBy !== gated.user.id && !manager) {
      return sendError(res, 403, 'FORBIDDEN', 'only the uploader or a project manager can delete this file');
    }
    const using = file.ready ? await d.store.listSessionsUsingProjectFile(file.projectId, file.id) : [];
    const forced = using.length > 0 && manager && ctx.url.searchParams.get('force') === '1';
    if (using.length && !forced) {
      return sendError(res, 409, 'FILE_IN_USE', `${using.length} session(s) in this project use this file`, {
        sessions: using.map((s) => ({ id: s.id, title: typeof s.meta?.label === 'string' && s.meta.label ? s.meta.label : s.toolId })),
      });
    }
    await removeProjectFile(d.store, d.blobs, file);
    running.delete(file.id);
    await d.audit(`user:${gated.user.id}`, 'project.file-delete', `project:${file.projectId}`, {
      fileId: file.id, name: file.name, size: file.size, ready: file.ready, ...(forced ? { forced: true, sessions: using.map((s) => s.id) } : {}),
    });
    res.writeHead(204); res.end();
  });
}
