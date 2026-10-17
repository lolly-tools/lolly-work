// SPDX-License-Identifier: MPL-2.0
/**
 * Scoped uploads (docs/resumable-uploads.md): private, expiring bytes that a
 * person or a service token uploads once and then names by reference. They use
 * the same transfer primitive as project files (uploads/parts.ts) and keep
 * their own records (`uploads`, migration 0075), one row per upload:
 *
 *   - `catalog-submission`: the original for `POST /api/v1/catalog/submit
 *     ?uploadId=...&checksum=...`, removed by a successful submission;
 *   - `automation-input`: bytes for the document verbs (`upload` in place of
 *     `bytesBase64`), readable until the upload expires.
 *
 * Only the owner lists, sends, finishes, names or cancels an upload, and
 * nobody downloads one. An unfinished upload expires like a project file (15
 * minutes after its last accepted part, never later than `uploadTtlHours`
 * after it began); a finished one expires `readyTtlHours` after it finished.
 * Every upload that has not expired counts toward its owner's budget and the
 * instance budget; an expired one counts for nothing and the sweep removes it.
 */
import type { BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { UserRecord } from '../store/types.ts';
import { UNSAFE_TEXT } from '../projects/files.ts';
import { parseTransferManifest, readTransfer, removeTransferParts, TRANSFER_MAX_BYTES, type TransferManifest, type TransferParts } from './parts.ts';

export const UPLOAD_SCOPES = ['catalog-submission', 'automation-input'] as const;
export type UploadScope = typeof UPLOAD_SCOPES[number];
export const isUploadScope = (value: unknown): value is UploadScope => UPLOAD_SCOPES.includes(value as UploadScope);

export interface UploadRecord extends TransferManifest {
  id: string;
  scope: UploadScope;
  /** `user:<id>` for a person or `service:svc_<id>` for a service token: the
   *  principal form the automation API already isolates jobs by. */
  owner: string;
  name: string;
  contentType: string;
  createdAt: string;
  expiresAt: string;
  ready: boolean;
}

/** `policy.uploads` (config/instance.ts validates it). */
export interface UploadPolicy {
  enabled: boolean;
  maxFileBytes: number;
  ownerBudgetBytes: number;
  instanceBudgetBytes: number;
  uploadTtlHours: number;
  readyTtlHours: number;
}
const MIB = 1024 * 1024;
/** Sized like project files, for a small Postgres that also holds the blobs;
 *  the per-file cap matches the default `policy.submit.maxBytes`. */
export const UPLOAD_DEFAULTS: Readonly<UploadPolicy> = {
  enabled: true, maxFileBytes: 64 * MIB, ownerBudgetBytes: 128 * MIB, instanceBudgetBytes: 256 * MIB, uploadTtlHours: 24, readyTtlHours: 24,
};
/** Unfinished uploads one owner may hold at once. */
export const UPLOAD_PENDING_LIMIT = 16;
/** What every upload costs a budget beyond its bytes: its row and part rows. */
export const UPLOAD_OVERHEAD_BYTES = 4096;
/** An unfinished upload expires this long after its begin or its last accepted part. */
export const UPLOAD_IDLE_MS = 15 * 60 * 1000;
/** How long past its expiry an upload is kept before the sweep deletes it, so
 *  a part PUT that passed its expiry check just in time finishes writing first. */
export const UPLOAD_SWEEP_GRACE_MS = 60 * 60 * 1000;
/** The most uploads one owner's list shows. */
export const UPLOAD_LIST_LIMIT = 50;

export interface UploadLimits { ownerBudgetBytes: number; instanceBudgetBytes: number; maxPending: number }
/** `refused`: the id is already taken. */
export type UploadReservation = 'reserved' | 'owner-budget' | 'instance-budget' | 'pending' | 'refused';

/** Records for scoped uploads; `Store` extends this (memory.ts, postgres.ts here). */
export interface UploadStore {
  /** Insert an unfinished upload when the owner's budget, the instance budget
   *  and the owner's pending limit all still allow it. Atomic across owners,
   *  so parallel reservations cannot both pass the instance budget. */
  reserveUpload(upload: UploadRecord, limits: UploadLimits): Promise<UploadReservation>;
  getUpload(id: string): Promise<UploadRecord | null>;
  /** One owner's uploads that have not expired, newest first (createdAt desc, then id). */
  listUploads(owner: string, limit: number): Promise<UploadRecord[]>;
  /** Uploads to delete, earliest expiry first: those that expired by
   *  `expiredBy`, or every upload of `owner`, or both filters together. */
  listUploadsToRemove(filter: { owner?: string; expiredBy?: string }, limit: number): Promise<UploadRecord[]>;
  /** The bytes the budgets see right now, for one owner and the instance. */
  uploadUsage(owner: string): Promise<{ ownerBytes: number; instanceBytes: number }>;
  /** Move an unfinished upload's expiry out to `expiresAt`, never earlier.
   *  False when it is gone or has expired; true, with its expiry left alone,
   *  for a finished upload that has not expired. */
  touchUpload(id: string, expiresAt: string): Promise<boolean>;
  /** Mark an unfinished upload that has not expired ready, expiring at
   *  `expiresAt`. True, changing nothing, when it is already ready and has not
   *  expired; false when it is gone or has expired. */
  completeUpload(id: string, expiresAt: string): Promise<boolean>;
  /** The row only; the caller deletes the parts first. False when unknown. */
  deleteUpload(id: string): Promise<boolean>;
}

export const uploadPartId = (upload: Pick<UploadRecord, 'id'>, n: number): string => `upload/${upload.id}/${n}`;
/** An upload's parts as one transfer, for the shared primitive. */
export const uploadParts = (blobs: BlobStore, upload: UploadRecord): TransferParts => ({ blobs, partId: (n) => uploadPartId(upload, n), manifest: upload });
/** What one upload counts toward the budgets. */
export const uploadCharge = (u: Pick<UploadRecord, 'size'>): number => u.size + UPLOAD_OVERHEAD_BYTES;
export const liveUpload = (u: Pick<UploadRecord, 'expiresAt'>, now = Date.now()): boolean => Date.parse(u.expiresAt) > now;

/** The owner an upload records for a caller: the automation principal form. */
export const uploadOwner = (user: Pick<UserRecord, 'id'>): string => user.id.startsWith('svc_') ? `service:${user.id}` : `user:${user.id}`;

/** The configured policy with defaults filled in; tolerates a hand-built
 *  config that omits the block. */
export function uploadPolicy(config: Pick<InstanceConfig, 'policy'>): UploadPolicy {
  return { ...UPLOAD_DEFAULTS, ...config.policy?.uploads };
}

/** When an unfinished upload expires if it is touched at `now`. */
export function unfinishedUploadExpiry(createdAt: string, uploadTtlHours: number, now = Date.now()): string {
  return new Date(Math.min(Date.parse(createdAt) + uploadTtlHours * 60 * 60 * 1000, now + UPLOAD_IDLE_MS)).toISOString();
}
/** When an upload finished at `now` expires. */
export const finishedUploadExpiry = (readyTtlHours: number, now = Date.now()): string => new Date(now + readyTtlHours * 60 * 60 * 1000).toISOString();

/** A begin body: a known scope, a name of 1 to 200 characters with no control
 *  character, a plain media type, and a transfer manifest within `maxBytes`. */
export function uploadInput(value: unknown, maxBytes: number): Pick<UploadRecord, 'scope' | 'name' | 'contentType' | 'size' | 'checksum' | 'parts'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (!isUploadScope(v.scope)) return null;
  if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200 || UNSAFE_TEXT.test(v.name)) return null;
  if (typeof v.contentType !== 'string' || v.contentType.length > 100 || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(v.contentType)) return null;
  const manifest = parseTransferManifest(v, Math.min(maxBytes, TRANSFER_MAX_BYTES));
  return manifest ? { scope: v.scope, name: v.name.trim(), contentType: v.contentType, ...manifest } : null;
}

/** What the owner sees of an upload: no owner (it is theirs) and no part table. */
export function uploadWire(u: UploadRecord) {
  return { id: u.id, scope: u.scope, name: u.name, size: u.size, checksum: u.checksum, contentType: u.contentType, ready: u.ready, createdAt: u.createdAt, expiresAt: u.expiresAt };
}

/** Delete an upload's parts, then its row, then its parts again, for the same
 *  reason as removeProjectFile: an interruption leaves a row a later sweep
 *  still finds, and the second pass takes a part an in-flight PUT wrote. */
export async function removeUpload(store: UploadStore, blobs: BlobStore, upload: UploadRecord): Promise<boolean> {
  const parts = uploadParts(blobs, upload);
  await removeTransferParts(parts, upload.parts.length);
  const removed = await store.deleteUpload(upload.id);
  await removeTransferParts(parts, upload.parts.length);
  return removed;
}

/** Remove every upload one owner holds (account erasure). Bounded, so an owner
 *  still uploading cannot keep it running. */
export async function removeUploadsOwnedBy(store: UploadStore, blobs: BlobStore, owner: string): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const batch = await store.listUploadsToRemove({ owner }, 100);
    if (!batch.length) break;
    for (const upload of batch) if (await removeUpload(store, blobs, upload)) removed++;
  }
  return removed;
}

/** Remove uploads that expired more than the grace period ago, at most
 *  `limit` per call. Runs before every begin, from the retention run and on
 *  the long-lived server's timer; returns how many went. */
export async function sweepExpiredUploads(
  store: UploadStore, blobs: BlobStore, { now = Date.now(), limit = 50 }: { now?: number; limit?: number } = {},
): Promise<number> {
  const cutoff = new Date(now - UPLOAD_SWEEP_GRACE_MS).toISOString();
  let swept = 0;
  for (const upload of await store.listUploadsToRemove({ expiredBy: cutoff }, limit)) {
    if (await removeUpload(store, blobs, upload)) swept++;
  }
  return swept;
}

const SWEEP_BATCH = 500;
/** The long-lived server's timed sweep (main.ts): one pass now and one a day,
 *  up to 20 batches of 500 each. The timer is unref'd, passes never overlap,
 *  and a failed pass is logged, never thrown. */
export function scheduleUploadSweep(
  store: UploadStore, blobs: BlobStore,
  { intervalMs = 24 * 60 * 60 * 1000, log = console }: { intervalMs?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): { first: Promise<void>; stop: () => void } {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let swept = 0;
      for (let round = 0; round < 20; round++) {
        const batch = await sweepExpiredUploads(store, blobs, { limit: SWEEP_BATCH });
        swept += batch;
        if (batch < SWEEP_BATCH) break;
      }
      if (swept) log.log(`[lolly-work] swept ${swept} expired upload(s)`);
    } catch (error) {
      log.error(`[lolly-work] upload sweep failed: ${(error as Error).message}`);
    } finally { running = false; }
  };
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref();
  return { first: pass(), stop: () => clearInterval(timer) };
}

/** A reference a consumer could not use, with the status and code to answer. */
export class UploadReferenceError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(status: number, code: string, message: string) { super(message); this.name = 'UploadReferenceError'; this.status = status; this.code = code; }
}

/**
 * The verified bytes of a finished upload that `owner` names, for `scope`. The
 * reference is `{ id, checksum }`; the checksum binds the bytes, so a stale id
 * cannot stand in for other content. An upload the owner cannot name (unknown,
 * someone else's, another scope, unfinished or expired) is a 404 either way,
 * so an id reveals nothing about anyone else's uploads.
 */
export async function readUploadReference(
  d: { store: Pick<UploadStore, 'getUpload'>; blobs: BlobStore; policy: UploadPolicy },
  ref: unknown, owner: string, scope: UploadScope, maxBytes = d.policy.maxFileBytes,
): Promise<{ upload: UploadRecord; bytes: Buffer }> {
  const { id, checksum } = (ref && typeof ref === 'object' ? ref : {}) as { id?: unknown; checksum?: unknown };
  if (typeof id !== 'string' || !/^upl_[A-Za-z0-9_-]{1,64}$/.test(id) || typeof checksum !== 'string' || !/^[a-f0-9]{64}$/.test(checksum)) {
    throw new UploadReferenceError(400, 'INVALID_INPUT', 'an upload reference is { id, checksum } for one finished upload');
  }
  if (!d.policy.enabled) throw new UploadReferenceError(404, 'NOT_FOUND', 'uploads are off');
  const upload = await d.store.getUpload(id);
  if (!upload || upload.owner !== owner || upload.scope !== scope || !upload.ready || !liveUpload(upload) || upload.checksum !== checksum) {
    throw new UploadReferenceError(404, 'NOT_FOUND', 'no such finished upload');
  }
  if (upload.size > maxBytes) throw new UploadReferenceError(413, 'PAYLOAD_TOO_LARGE', `the upload is larger than the ${maxBytes} bytes this use takes`);
  try { return { upload, bytes: await readTransfer(uploadParts(d.blobs, upload), maxBytes) }; }
  catch { throw new UploadReferenceError(422, 'SOURCE_UNAVAILABLE', 'the upload could not be verified; nothing was used'); }
}
