// SPDX-License-Identifier: MPL-2.0
/**
 * Shared project files (plans/74): uploads that live inside a project so a
 * session saved there can carry its images to every member. Bytes go to the
 * configured BlobStore in bounded parts; the row in `project_files` (migration
 * 0041) holds the declared metadata. An upload is reserved first, then its
 * parts arrive, then it is finalized and listed. An unfinished upload expires
 * after `policy.projectFiles.uploadTtlHours`; from then on it counts toward
 * no budget and the sweep below removes it.
 */
import { createHash } from 'node:crypto';
import type { BlobStore } from '../blobs/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { Store } from '../store/types.ts';

export const PROJECT_FILE_PART_BYTES = 1024 * 1024;
/** The hard ceiling: migration 0041's size CHECK. The configured per-file cap
 *  (`policy.projectFiles.maxFileBytes`) can only be lower. */
export const PROJECT_FILE_MAX_BYTES = 256 * 1024 * 1024;
/** Unfinished uploads one person may hold at once, across the instance. */
export const PROJECT_FILE_PENDING_LIMIT = 16;
/** The bytes one person's unfinished uploads may reserve at once, in largest
 *  files (`maxFileBytes`), so one person cannot hold the instance budget. */
export const PROJECT_FILE_PENDING_FILES = 2;
/** What every file costs a budget beyond its bytes: its row, its part rows and
 *  their index entries, rounded up, so many tiny files cannot fill the
 *  database while the budgets still show room. */
export const PROJECT_FILE_OVERHEAD_BYTES = 4096;
/** An unfinished upload expires this long after it began or after its last
 *  accepted part, and never later than `uploadTtlHours` after it began, so an
 *  upload a closed tab left behind stops counting within minutes. */
export const PROJECT_FILE_IDLE_MS = 15 * 60 * 1000;
/** How long past its expiry an unfinished upload is kept before the sweep
 *  deletes it, so a part PUT that passed its expiry check just before the
 *  deadline finishes writing before its parts are removed. */
export const PROJECT_FILE_SWEEP_GRACE_MS = 60 * 60 * 1000;

/** `policy.projectFiles` (config/instance.ts validates it). Budgets count ready
 *  files plus unfinished uploads that have not expired, each at its size plus
 *  `PROJECT_FILE_OVERHEAD_BYTES`. */
export interface ProjectFilePolicy {
  enabled: boolean;
  maxFileBytes: number;
  projectBudgetBytes: number;
  instanceBudgetBytes: number;
  uploadTtlHours: number;
}
const MIB = 1024 * 1024;
/** Sized for a small hosted Postgres (Neon Free has 1 GB in all). */
export const PROJECT_FILE_DEFAULTS: Readonly<ProjectFilePolicy> = {
  enabled: true, maxFileBytes: 25 * MIB, projectBudgetBytes: 128 * MIB, instanceBudgetBytes: 256 * MIB, uploadTtlHours: 24,
};

export interface ProjectFilePart { size: number; checksum: string }
export interface ProjectFileRecord {
  id: string;
  projectId: string;
  name: string;
  size: number;
  checksum: string;
  contentType: string;
  parts: ProjectFilePart[];
  asset: Record<string, unknown>;
  createdBy: string;
  createdAt: string;
  expiresAt: string;
  ready: boolean;
}

/** What a reservation is checked against. `maxPending` and `maxPendingBytes`
 *  bound one person's unfinished uploads by count and by declared size. */
export interface ProjectFileLimits { projectBudgetBytes: number; instanceBudgetBytes: number; maxPending: number; maxPendingBytes: number }
/** `refused`: the project is gone or the id is already taken. */
export type ProjectFileReservation = 'reserved' | 'project-budget' | 'instance-budget' | 'pending' | 'refused';

export const filePartBlobId = (file: Pick<ProjectFileRecord, 'id'>, part: number): string => `project-file/${file.id}/${part}`;
export const fileChecksum = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');
/** The asset id a session uses for a project file (the shell's org/team-files.ts). */
export const projectFileAssetId = (fileId: string): string => `user/team/${fileId}`;
/** What one file counts toward the budgets (see PROJECT_FILE_OVERHEAD_BYTES). */
export const projectFileCharge = (f: Pick<ProjectFileRecord, 'size'>): number => f.size + PROJECT_FILE_OVERHEAD_BYTES;
/** When an unfinished upload expires if it is touched at `now`. */
export function projectFileExpiry(createdAt: string, uploadTtlHours: number, now = Date.now()): string {
  return new Date(Math.min(Date.parse(createdAt) + uploadTtlHours * 60 * 60 * 1000, now + PROJECT_FILE_IDLE_MS)).toISOString();
}

/** The configured policy with defaults filled in; tolerates a hand-built
 *  config that omits the block. */
export function projectFilePolicy(config: Pick<InstanceConfig, 'policy'>): ProjectFilePolicy {
  return { ...PROJECT_FILE_DEFAULTS, ...config.policy?.projectFiles };
}

/** Shared files are on only when policy allows them and the store keeps them:
 *  on the memory store an upload would vanish with the process. */
export function projectFilesEnabled(config: Pick<InstanceConfig, 'policy'>, store: Pick<Store, 'storageKind'>): boolean {
  return projectFilePolicy(config).enabled && store.storageKind !== 'memory';
}

/** Control characters, and half an emoji, which Postgres refuses inside JSON. */
export const UNSAFE_TEXT = /[\x00-\x1f\x7f]|[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/;

/** A file name an upload or a rename accepts: 1 to 200 characters, not blank, with
 *  no control character or half an emoji. The download route encodes the name with
 *  encodeURIComponent, which throws on half an emoji. */
export const validProjectFileName = (name: unknown): name is string =>
  typeof name === 'string' && !!name.trim() && name.length <= 200 && !UNSAFE_TEXT.test(name);

/** What the instance keeps beside a file's bytes, from what the shell's
 *  org/team-files.ts `describe` sends: its kind, format, size in pixels and
 *  name. Anything else, a credential included, is dropped, so the row stays
 *  small and flat whatever a client sends. */
function projectFileAsset(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const v = value as Record<string, unknown>;
  const label = (s: unknown): s is string => typeof s === 'string' && s.length <= 64;
  const pixels = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n > 0;
  const name = v.meta && typeof v.meta === 'object' ? (v.meta as Record<string, unknown>).name : undefined;
  return {
    ...(label(v.type) ? { type: v.type } : {}), ...(label(v.format) ? { format: v.format } : {}),
    ...(pixels(v.width) ? { width: v.width } : {}), ...(pixels(v.height) ? { height: v.height } : {}),
    ...(typeof name === 'string' && name.length <= 200 && !UNSAFE_TEXT.test(name) ? { meta: { name } } : {}),
  };
}

/** Metadata is fixed before bytes arrive. Each part can only be retried with
 * the declared bytes, so finalization and a repeated PUT cannot race a change. */
export function projectFileInput(value: unknown): Pick<ProjectFileRecord, 'name' | 'size' | 'checksum' | 'contentType' | 'parts' | 'asset'> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const digest = (s: unknown): s is string => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
  if (!validProjectFileName(v.name)) return null;
  if (!Number.isSafeInteger(v.size) || (v.size as number) < 1 || (v.size as number) > PROJECT_FILE_MAX_BYTES || !digest(v.checksum)) return null;
  if (typeof v.contentType !== 'string' || !/^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+$/i.test(v.contentType) || v.contentType.length > 100) return null;
  if (!Array.isArray(v.parts) || v.parts.length !== Math.ceil((v.size as number) / PROJECT_FILE_PART_BYTES)) return null;
  const parts: ProjectFilePart[] = [];
  for (let n = 0; n < v.parts.length; n++) {
    const p = v.parts[n];
    const size = Math.min(PROJECT_FILE_PART_BYTES, (v.size as number) - n * PROJECT_FILE_PART_BYTES);
    if (!p || typeof p !== 'object' || p.size !== size || !digest(p.checksum)) return null;
    parts.push({ size, checksum: p.checksum });
  }
  // One part is the whole file, so the two digests must agree; finalize then
  // has nothing left to prove for the common small image.
  if (parts.length === 1 && parts[0]!.checksum !== v.checksum) return null;
  return { name: v.name.trim(), size: v.size as number, checksum: v.checksum, contentType: v.contentType, parts, asset: projectFileAsset(v.asset) };
}

export const activeProjectFile = (f: ProjectFileRecord, now = Date.now()): boolean => f.ready || Date.parse(f.expiresAt) > now;

/** The list row: no part table and no expiry, which only the uploader needs. */
export function projectFileWire(f: ProjectFileRecord, names: ReadonlyMap<string, string>) {
  const name = names.get(f.createdBy);
  return {
    id: f.id, projectId: f.projectId, name: f.name, size: f.size, checksum: f.checksum, contentType: f.contentType,
    ready: true as const, asset: f.asset, createdAt: f.createdAt, createdBy: f.createdBy, ...(name ? { createdByName: name } : {}),
  };
}

/** Delete a file's parts, then its row, then its parts again. Parts first, so
 *  an interruption leaves a row that a later delete or sweep can still find.
 *  The second pass takes a part that an in-flight PUT wrote after the first
 *  pass: that PUT checked for the row before the row went, so it kept its
 *  part, and a PUT that checks after the row went deletes its own. */
export async function removeProjectFile(store: Store, blobs: BlobStore, file: ProjectFileRecord): Promise<boolean> {
  for (let n = 0; n < file.parts.length; n++) await blobs.delete(filePartBlobId(file, n));
  const removed = await store.deleteProjectFile(file.id);
  for (let n = 0; n < file.parts.length; n++) await blobs.delete(filePartBlobId(file, n));
  return removed;
}

/** Remove every unfinished upload by one person (account erasure). Bounded,
 *  so a person still uploading cannot keep it running. */
export async function removeUploadsBy(store: Store, blobs: BlobStore, userId: string): Promise<number> {
  let removed = 0;
  for (let round = 0; round < 20; round++) {
    const batch = await store.listUnfinishedProjectFiles({ createdBy: userId }, 100);
    if (!batch.length) break;
    for (const file of batch) if (await removeProjectFile(store, blobs, file)) removed++;
  }
  return removed;
}

/** Remove unfinished uploads that expired more than the grace period ago,
 *  instance-wide and at most `limit` per call. Runs before every new
 *  reservation and from the retention run; returns how many went. */
export async function sweepExpiredProjectFiles(
  store: Store, blobs: BlobStore, { now = Date.now(), limit = 50 }: { now?: number; limit?: number } = {},
): Promise<number> {
  const cutoff = new Date(now - PROJECT_FILE_SWEEP_GRACE_MS).toISOString();
  let swept = 0;
  for (const file of await store.listUnfinishedProjectFiles({ expiredBy: cutoff }, limit)) {
    if (await removeProjectFile(store, blobs, file)) swept++;
  }
  return swept;
}

/** How often the long-lived server sweeps on its own (`scheduleProjectFileSweep`). */
export const PROJECT_FILE_SWEEP_INTERVAL_MS = 24 * 60 * 60 * 1000;
const SWEEP_BATCH = 500;

/**
 * The long-lived server's timed sweep (main.ts): one pass now and one every
 * `intervalMs`, whatever the retention policy says, so the parts of expired
 * uploads leave storage on a quiet instance too. A pass takes up to `rounds`
 * batches of 500. The timer is unref'd, passes never overlap, and a failed pass
 * is logged, never thrown. `first` settles when the first pass ends.
 */
export function scheduleProjectFileSweep(
  store: Store, blobs: BlobStore,
  { intervalMs = PROJECT_FILE_SWEEP_INTERVAL_MS, rounds = 20, log = console }:
    { intervalMs?: number; rounds?: number; log?: Pick<Console, 'log' | 'error'> } = {},
): { first: Promise<void>; stop: () => void } {
  let running = false;
  const pass = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      let swept = 0;
      for (let round = 0; round < rounds; round++) {
        const batch = await sweepExpiredProjectFiles(store, blobs, { limit: SWEEP_BATCH });
        swept += batch;
        if (batch < SWEEP_BATCH) break;
      }
      if (swept) log.log(`[lolly-work] swept ${swept} expired project-file upload(s)`);
    } catch (error) {
      log.error(`[lolly-work] project-file sweep failed: ${(error as Error).message}`);
    } finally { running = false; }
  };
  const timer = setInterval(() => void pass(), intervalMs);
  timer.unref();
  return { first: pass(), stop: () => clearInterval(timer) };
}
