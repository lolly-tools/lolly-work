// SPDX-License-Identifier: MPL-2.0
/**
 * File references (docs/api.md "File references"): the `file` scope of the
 * scoped uploads (uploads/scoped.ts). A finished upload in that scope is an
 * opaque reference with a digest, an expiry and the operations its owner may
 * run on it. The owner reads it back, names it in the document verbs as
 * `file: { id, checksum }`, keeps an operation's output as another reference,
 * and deletes it.
 *
 * A reference belongs to the account that made it: `user:<id>` for a person,
 * through any of their sessions, or `service:svc_<id>` for one service token.
 * It lives in the store and the blob store, so it outlasts a restart and any
 * replica can serve it. Nobody else learns that it exists: every other caller
 * gets the same 404 as for an id that was never issued, and two owners who
 * hold the same bytes get two references, never a shared one.
 *
 * Nothing is cached between requests. Every read resolves the caller, checks
 * `tool.use` and loads the record again (file-routes.ts and the verb readers
 * in api/app.ts), so deleting a reference, revoking a service token, disabling
 * a person, ending their sessions or denying them `tool.use` refuses the next
 * read.
 */
import { assertFileOperationReport } from '@lolly-tools/core/file-operation-v1';
import type { BlobStore } from '../blobs/types.ts';
import { randomId } from '../lib/crypto.ts';
import { isSha256, sha256, storeTransferPart, TRANSFER_PART_BYTES, type TransferManifest } from './parts.ts';
import {
  finishedUploadExpiry, liveUpload, removeUpload, unfinishedUploadExpiry, uploadParts, UPLOAD_PENDING_LIMIT,
  type FileRole, type UploadPolicy, type UploadRecord, type UploadReservation, type UploadStore,
} from './scoped.ts';

/** The most bytes `POST /api/v1/files` takes in one request, as base64 in
 *  JSON. A larger file goes through the parts protocol in scope `file`. */
export const FILE_INLINE_MAX_BYTES = 4 * 1024 * 1024;
/** The largest operation report a reference keeps, as JSON. */
export const FILE_REPORT_MAX_BYTES = 64 * 1024;
/** The most references one page of the list holds. */
export const FILE_LIST_LIMIT = 50;
export const FILE_ID = /^fil_[A-Za-z0-9_-]{1,64}$/;

/** The reference fields a create or begin body may carry. */
export interface FileMetadata { role: FileRole; derivedFrom?: { id: string; checksum: string }; report?: Record<string, unknown> }

/**
 * The reference fields of a create or begin body, or why they are not valid.
 * `role` is `original` unless the body says `output`. Only an output names the
 * reference it was made from (`derivedFrom`) and the FileOperationReportV1
 * that made it (`report`), which must pass the contract's own check.
 */
export function fileMetadata(body: Record<string, unknown>): FileMetadata | string {
  const role = body.role ?? 'original';
  if (role !== 'original' && role !== 'output') return 'role is original or output';
  if (role === 'original' && (body.derivedFrom !== undefined || body.report !== undefined)) return 'only an output has derivedFrom or a report';
  const metadata: FileMetadata = { role };
  if (body.derivedFrom !== undefined) {
    const d = body.derivedFrom as { id?: unknown; checksum?: unknown } | null;
    if (!d || typeof d !== 'object' || typeof d.id !== 'string' || !FILE_ID.test(d.id) || !isSha256(d.checksum)) {
      return 'derivedFrom is { id, checksum } for one of your file references';
    }
    metadata.derivedFrom = { id: d.id, checksum: d.checksum };
  }
  if (body.report !== undefined) {
    try { assertFileOperationReport(body.report); } catch (error) { return (error as Error).message; }
    if (Buffer.byteLength(JSON.stringify(body.report)) > FILE_REPORT_MAX_BYTES) return `a report is at most ${FILE_REPORT_MAX_BYTES} bytes of JSON`;
    metadata.report = body.report as unknown as Record<string, unknown>;
  }
  return metadata;
}

/** Whether `ref` names a finished file reference of `owner` that has not
 *  expired and holds those bytes. Every other case is the same false. */
export async function ownsFileReference(store: Pick<UploadStore, 'getUpload'>, owner: string, ref: { id: string; checksum: string }): Promise<boolean> {
  const file = await store.getUpload(ref.id);
  return !!file && usableFile(file, owner) && file.checksum === ref.checksum;
}
/** A finished, unexpired file reference that `owner` holds. */
export const usableFile = (file: UploadRecord, owner: string): boolean => file.owner === owner && file.scope === 'file' && file.ready && liveUpload(file);

/** Media types the optimize verb removes metadata from, and the format it takes for each. */
const OPTIMIZE_FORMATS: Readonly<Record<string, 'png' | 'jpeg' | 'svg'>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/svg+xml': 'svg' };
export const FORMAT_TYPES: Readonly<Record<string, string>> = { png: 'image/png', jpeg: 'image/jpeg', jpg: 'image/jpeg', svg: 'image/svg+xml' };

export interface FileOperation { id: string; method: 'GET' | 'POST' | 'DELETE'; path: string; body?: Record<string, unknown> }
export interface UnavailableOperation { operation: string; code: string; reason: string }

/** What the owner can do with a reference: each operation as the request to
 *  make, and each one this reference cannot take with the reason. */
export function fileOperations(file: Pick<UploadRecord, 'id' | 'checksum' | 'contentType'>): { operations: FileOperation[]; unavailable: UnavailableOperation[] } {
  const ref = { id: file.id, checksum: file.checksum };
  const format = OPTIMIZE_FORMATS[file.contentType.toLowerCase()];
  return {
    operations: [
      { id: 'read', method: 'GET', path: `/api/v1/files/${file.id}/content` },
      { id: 'inspect', method: 'POST', path: '/api/v1/inspect', body: { file: ref } },
      ...(format ? [{ id: 'optimize', method: 'POST' as const, path: '/api/v1/optimize', body: { file: ref, opts: { format }, output: 'file' } }] : []),
      { id: 'delete', method: 'DELETE', path: `/api/v1/files/${file.id}` },
    ],
    unavailable: format ? [] : [{ operation: 'optimize', code: 'FORMAT_UNSUPPORTED', reason: 'optimize removes metadata from PNG, JPEG and SVG files only' }],
  };
}

/** What the owner sees of a reference. The report itself is on the describe answer. */
export function fileWire(file: UploadRecord) {
  return {
    id: file.id, name: file.name, contentType: file.contentType, size: file.size, checksum: file.checksum, role: file.role ?? 'original',
    derivedFrom: file.derivedFrom ?? null, reportedBy: file.report?.by ?? null, createdAt: file.createdAt, expiresAt: file.expiresAt,
    ...fileOperations(file),
  };
}

/** A list cursor: the last reference of a page, opaque to the client. */
export const fileCursor = (file: Pick<UploadRecord, 'createdAt' | 'id'>): string => Buffer.from(`${file.createdAt} ${file.id}`).toString('base64url');
/** The position a cursor names, or null when it is not one this route issued. */
export function parseFileCursor(cursor: string): { createdAt: string; id: string } | null {
  const [createdAt, id, extra] = Buffer.from(cursor, 'base64url').toString('utf8').split(' ');
  if (extra !== undefined || !createdAt || !id || !FILE_ID.test(id) || Number.isNaN(Date.parse(createdAt)) || new Date(createdAt).toISOString() !== createdAt) return null;
  return { createdAt, id };
}

/** The parts protocol's manifest for bytes already in hand. */
export function manifestOf(bytes: Uint8Array): TransferManifest {
  const parts = [];
  for (let n = 0; n < bytes.length; n += TRANSFER_PART_BYTES) parts.push({ size: Math.min(TRANSFER_PART_BYTES, bytes.length - n), checksum: sha256(bytes.subarray(n, n + TRANSFER_PART_BYTES)) });
  return { size: bytes.length, checksum: sha256(bytes), parts };
}

export type FileCreation = { ok: true; file: UploadRecord } | { ok: false; refusal: Exclude<UploadReservation, 'reserved'> | 'expired' };

/**
 * Keep `bytes` as a finished file reference of `owner`. It reserves against
 * the same budgets as an upload, stores each part through the shared
 * primitive, then marks the reference ready to expire `fileTtlHours` later.
 * When anything after the reservation fails, what was stored is removed.
 */
export async function createFileReference(
  d: { store: UploadStore; blobs: BlobStore; policy: UploadPolicy }, owner: string, bytes: Uint8Array,
  meta: { name: string; contentType: string; role: FileRole; derivedFrom?: UploadRecord['derivedFrom']; report?: UploadRecord['report'] },
): Promise<FileCreation> {
  const now = Date.now(), createdAt = new Date(now).toISOString();
  const file: UploadRecord = {
    id: `fil_${randomId(16)}`, scope: 'file', owner, name: meta.name, contentType: meta.contentType, ...manifestOf(bytes),
    createdAt, expiresAt: unfinishedUploadExpiry(createdAt, d.policy.uploadTtlHours, now), ready: false, role: meta.role,
    ...(meta.derivedFrom ? { derivedFrom: meta.derivedFrom } : {}), ...(meta.report ? { report: meta.report } : {}),
  };
  const outcome = await d.store.reserveUpload(file, {
    ownerBudgetBytes: d.policy.ownerBudgetBytes, instanceBudgetBytes: d.policy.instanceBudgetBytes, maxPending: UPLOAD_PENDING_LIMIT,
  });
  if (outcome !== 'reserved') return { ok: false, refusal: outcome };
  try {
    const parts = uploadParts(d.blobs, file);
    for (let n = 0; n < file.parts.length; n++) {
      if (await storeTransferPart(parts, n, bytes.subarray(n * TRANSFER_PART_BYTES, (n + 1) * TRANSFER_PART_BYTES)) !== 'stored') throw new Error('a part failed verification');
    }
    const expiresAt = finishedUploadExpiry(d.policy.fileTtlHours);
    if (!await d.store.completeUpload(file.id, expiresAt)) {
      await removeUpload(d.store, d.blobs, file);
      return { ok: false, refusal: 'expired' };
    }
    return { ok: true, file: { ...file, ready: true, expiresAt } };
  } catch (error) {
    await removeUpload(d.store, d.blobs, file).catch(() => false);
    throw error;
  }
}

/** The status, code and message for a creation the budgets refused. */
export function creationRefusal(refusal: Exclude<FileCreation, { ok: true }>['refusal']): [number, string, string] {
  if (refusal === 'owner-budget') return [413, 'UPLOAD_BUDGET', 'your uploads have no room for that file; delete or use some first'];
  if (refusal === 'instance-budget') return [413, 'INSTANCE_UPLOAD_BUDGET', 'this instance has no room for that file'];
  if (refusal === 'pending') return [413, 'UPLOAD_PENDING', 'finish or cancel your unfinished uploads first'];
  return [409, 'CONFLICT', 'make the file again'];
}

const OPTION_KEY = /^(?!__proto__$|constructor$|prototype$)[a-zA-Z][a-zA-Z0-9_.-]{0,79}$/;
/** A FileOperationReportV1 format name for a media type. */
const formatOf = (contentType: string): string => OPTIMIZE_FORMATS[contentType.toLowerCase()] ?? (contentType.split('/')[1] ?? 'binary').slice(0, 80);

/**
 * The FileOperationReportV1 this instance writes for an optimize whose output
 * it keeps as a reference. Names and media types are the declared ones; the
 * sizes and digests are of the exact bytes. Only the plain option values go
 * in, so nothing a client sent beyond them is repeated back.
 */
export function optimizeReport(
  input: { name: string; contentType: string; bytes: Uint8Array }, output: { name: string; contentType: string; bytes: Uint8Array },
  opts: Record<string, unknown> | undefined, stages: string[],
): Record<string, unknown> {
  const facts = (f: typeof input) => ({ name: f.name.slice(0, 4096), format: formatOf(f.contentType), formatSource: 'declared', mime: f.contentType, size: f.bytes.byteLength, sha256: sha256(f.bytes) });
  const options = Object.fromEntries(Object.entries(opts ?? {}).filter(([key, value]) => OPTION_KEY.test(key)
    && (typeof value === 'number' ? Number.isFinite(value) : typeof value === 'boolean' || (typeof value === 'string' && value.length <= 4096))).slice(0, 64));
  const report: unknown = {
    version: 1, operation: 'optimize', state: 'succeeded', inputs: [facts(input)], outputs: [facts(output)], options,
    changes: [...stages.slice(0, 399).map((stage) => String(stage).slice(0, 4096)), `${input.bytes.byteLength} → ${output.bytes.byteLength} bytes`],
    findings: [], metadata: stages.includes('strip-metadata') ? 'removed' : 'not-checked', execution: 'instance',
  };
  assertFileOperationReport(report);
  return report as unknown as Record<string, unknown>;
}
