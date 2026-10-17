// SPDX-License-Identifier: MPL-2.0
/**
 * The shared transfer primitive behind every resumable upload into this
 * instance (docs/resumable-uploads.md records why it is this parts protocol
 * and not tus). A client declares the bytes first: their size, the whole
 * file's sha256 and one sha256 per fixed-size part. It then sends the parts in
 * any order and as often as it needs, asks which parts arrived when it has
 * lost its place, and finalizes. A part is checked against its declared digest
 * before it is stored, so a BlobStore only ever holds verified bytes.
 *
 * Project files (projects/files.ts) and scoped uploads (uploads/scoped.ts:
 * catalog submission originals and automation inputs) call these functions
 * over their own records. Each scope keeps its own authorization, budget and
 * lifetime; nothing here knows who is asking.
 */
import { createHash, type Hash } from 'node:crypto';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';

/** Every part but the last is this long. */
export const TRANSFER_PART_BYTES = 1024 * 1024;
/** The hard ceiling on one transfer: the size CHECKs of migration 0075. A
 *  scope's configured cap can only be lower. 4 GiB is 4096 parts, whose
 *  declared digests still fit a 512 KiB begin body. */
export const TRANSFER_MAX_BYTES = 4 * 1024 * 1024 * 1024;

const SHA256 = /^[a-f0-9]{64}$/;
export const isSha256 = (value: unknown): value is string => typeof value === 'string' && SHA256.test(value);
export const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

export interface TransferPart { size: number; checksum: string }
/** The bytes a transfer declared before any arrived. */
export interface TransferManifest { size: number; checksum: string; parts: TransferPart[] }
/** One transfer: its manifest, the store holding its parts and the blob id of part `n`. */
export interface TransferParts { blobs: BlobStore; partId(n: number): string; manifest: TransferManifest }

/**
 * The manifest in a begin body, or null. The size is a whole number from 1 to
 * `maxBytes` (never past TRANSFER_MAX_BYTES), there is one part per
 * TRANSFER_PART_BYTES, every part but the last is full, and a one-part
 * transfer's two digests agree, so finalize has nothing left to prove for the
 * common small file.
 */
export function parseTransferManifest(value: unknown, maxBytes = TRANSFER_MAX_BYTES): TransferManifest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const size = v.size as number;
  if (!Number.isSafeInteger(size) || size < 1 || size > Math.min(maxBytes, TRANSFER_MAX_BYTES) || !isSha256(v.checksum)) return null;
  if (!Array.isArray(v.parts) || v.parts.length !== Math.ceil(size / TRANSFER_PART_BYTES)) return null;
  const parts: TransferPart[] = [];
  for (let n = 0; n < v.parts.length; n++) {
    const p = v.parts[n] as Record<string, unknown> | null;
    const expected = Math.min(TRANSFER_PART_BYTES, size - n * TRANSFER_PART_BYTES);
    if (!p || typeof p !== 'object' || p.size !== expected || !isSha256(p.checksum)) return null;
    parts.push({ size: expected, checksum: p.checksum });
  }
  if (parts.length === 1 && parts[0]!.checksum !== v.checksum) return null;
  return { size, checksum: v.checksum, parts };
}

/** A part number from a route, or -1 when it is not a plain whole number. */
export function parsePartIndex(param: string | undefined): number {
  const n = Number(param);
  return param !== undefined && /^\d+$/.test(param) && Number.isSafeInteger(n) ? n : -1;
}

/** Store part `n` when `bytes` are exactly what the manifest declared for it.
 *  Sending a part again replaces it with the same bytes. */
export async function storeTransferPart(t: TransferParts, n: number, bytes: Uint8Array): Promise<'stored' | 'no-part' | 'mismatch'> {
  const part = n >= 0 ? t.manifest.parts[n] : undefined;
  if (!part) return 'no-part';
  if (bytes.length !== part.size || sha256(bytes) !== part.checksum) return 'mismatch';
  await t.blobs.put(t.partId(n), bytes, 'application/octet-stream', { size: part.size, sha256: part.checksum });
  return 'stored';
}

/** What a client needs to carry on after an interruption. */
export interface TransferProgress {
  partBytes: number;
  parts: number;
  /** Part numbers not yet stored, ascending: send these, then finalize. */
  missing: number[];
  receivedParts: number;
  receivedBytes: number;
  /** Bytes in the run of stored parts from the start, where a client that
   *  sends in order carries on (tus calls this Upload-Offset). */
  offset: number;
}

/** Stats read at once while working out progress. */
const HEAD_BATCH = 8;

/**
 * Which parts are stored, from each part's stat. A stored part whose size or
 * sha256 disagrees with the manifest counts as missing, so sending it again
 * replaces it. An S3 object that reports an ETag in place of a sha256 counts
 * as stored when its size matches; finalize reads such a part back.
 */
export async function transferProgress(t: TransferParts): Promise<TransferProgress> {
  const { parts } = t.manifest;
  const stored = new Array<boolean>(parts.length).fill(false);
  for (let start = 0; start < parts.length; start += HEAD_BATCH) {
    await Promise.all(parts.slice(start, start + HEAD_BATCH).map(async (part, i) => {
      const stat = await t.blobs.head(t.partId(start + i));
      stored[start + i] = !!stat && stat.size === part.size && (!isSha256(stat.checksum) || stat.checksum === part.checksum);
    }));
  }
  const missing: number[] = [];
  let receivedBytes = 0, offset = 0, prefix = true;
  parts.forEach((part, n) => {
    if (stored[n]) { receivedBytes += part.size; if (prefix) offset += part.size; }
    else { missing.push(n); prefix = false; }
  });
  return { partBytes: TRANSFER_PART_BYTES, parts: parts.length, missing, receivedParts: parts.length - missing.length, receivedBytes, offset };
}

/**
 * Whole-file digests of transfers whose parts arrived in order, so finalize
 * need not read every byte back out of storage. Per process and bounded: a
 * restart, an out-of-order part or another replica means finalize reads the
 * parts back instead. Only verified bytes ever reach a digest.
 */
export class RunningDigests {
  readonly #running = new Map<string, { next: number; hash: Hash; expires: number }>();
  readonly #limit: number;
  constructor(limit = 256) { this.#limit = limit; }

  /** Part `n` of transfer `id` was stored; `expires` is when to stop keeping its digest. */
  track(id: string, n: number, bytes: Uint8Array, expires: number): void {
    const now = Date.now();
    for (const [key, r] of this.#running) if (r.expires <= now) this.#running.delete(key);
    let r = this.#running.get(id);
    if (!r && n === 0 && this.#running.size < this.#limit) {
      r = { next: 0, hash: createHash('sha256'), expires };
      this.#running.set(id, r);
    }
    // A retried part is already in the digest; a skipped one breaks the chain.
    if (r?.next === n) { r.hash.update(bytes); r.next++; r.expires = expires; }
  }

  /** The digest so far, when all `parts` parts went in, in order. */
  digest(id: string, parts: number): string | null {
    const r = this.#running.get(id);
    return r?.next === parts ? r.hash.copy().digest('hex') : null;
  }

  forget(id: string): void { this.#running.delete(id); }
}

export type TransferCheck = { ok: true } | { ok: false; code: 'UPLOAD_INCOMPLETE' | 'CHECKSUM_MISMATCH'; message: string };

/**
 * Check every stored part and then the whole file, before a scope marks a
 * transfer ready. Each part's stored size and sha256 come from its stat, so
 * nothing is read back where the driver reports a sha256 (memory, pg, and S3
 * objects that record one). The whole-file digest is the one part's for a
 * one-part transfer, else `running` (RunningDigests), else the parts read back
 * and hashed.
 */
export async function verifyTransfer(t: TransferParts, running: string | null = null): Promise<TransferCheck> {
  const { parts, checksum } = t.manifest;
  let readBack = false;
  for (let n = 0; n < parts.length; n++) {
    const part = parts[n]!;
    const stat = await t.blobs.head(t.partId(n));
    if (!stat) return { ok: false, code: 'UPLOAD_INCOMPLETE', message: 'upload every part first' };
    if (stat.size !== part.size || (isSha256(stat.checksum) && stat.checksum !== part.checksum)) {
      return { ok: false, code: 'CHECKSUM_MISMATCH', message: 'stored part failed verification' };
    }
    if (!isSha256(stat.checksum)) readBack = true;
  }
  let digest: string;
  if (!readBack && parts.length === 1) digest = parts[0]!.checksum;
  else if (!readBack && running) digest = running;
  else {
    const hash = createHash('sha256');
    for (let n = 0; n < parts.length; n++) {
      const part = parts[n]!;
      const stored = await t.blobs.get(t.partId(n));
      if (!stored) return { ok: false, code: 'UPLOAD_INCOMPLETE', message: 'upload every part first' };
      const bytes = await readBlobBody(stored.body, TRANSFER_PART_BYTES);
      if (bytes.length !== part.size || sha256(bytes) !== part.checksum) {
        return { ok: false, code: 'CHECKSUM_MISMATCH', message: 'stored part failed verification' };
      }
      hash.update(bytes);
    }
    digest = hash.digest('hex');
  }
  return digest === checksum ? { ok: true } : { ok: false, code: 'CHECKSUM_MISMATCH', message: 'file failed verification' };
}

/**
 * The transfer's bytes, one verified part at a time. A missing part, a part
 * that fails its declared digest, or a whole file that fails its own before
 * its last part goes out, throws, so a reader never receives bytes the
 * manifest does not declare.
 */
export async function* transferChunks(t: TransferParts): AsyncGenerator<Uint8Array> {
  const { parts, checksum } = t.manifest;
  const whole = createHash('sha256');
  for (let n = 0; n < parts.length; n++) {
    const part = parts[n]!;
    const stored = await t.blobs.get(t.partId(n));
    if (!stored) throw new Error('transfer part unavailable');
    const bytes = await readBlobBody(stored.body, TRANSFER_PART_BYTES);
    if (bytes.length !== part.size || sha256(bytes) !== part.checksum) throw new Error('transfer part failed verification');
    whole.update(bytes);
    if (n === parts.length - 1 && whole.digest('hex') !== checksum) throw new Error('transfer failed verification');
    yield bytes;
  }
}

/** The whole transfer in one verified buffer, for a consumer that needs it
 *  whole. Refuses a transfer larger than `maxBytes` before reading anything. */
export async function readTransfer(t: TransferParts, maxBytes: number): Promise<Buffer> {
  const { size, parts } = t.manifest;
  if (size < 1 || size > maxBytes || parts.reduce((sum, p) => sum + p.size, 0) !== size) throw new Error('transfer exceeds the read limit');
  const chunks: Uint8Array[] = [];
  for await (const chunk of transferChunks(t)) chunks.push(chunk);
  return Buffer.concat(chunks, size);
}

/** Delete parts 0 to `count - 1`. Deleting a part that is not there is harmless. */
export async function removeTransferParts(t: Pick<TransferParts, 'blobs' | 'partId'>, count: number): Promise<void> {
  for (let n = 0; n < count; n++) await t.blobs.delete(t.partId(n));
}
