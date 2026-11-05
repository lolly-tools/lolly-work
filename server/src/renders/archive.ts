// SPDX-License-Identifier: MPL-2.0
/**
 * One downloadable ZIP for a finished render batch: the rows that have output,
 * plus a manifest with every row's outcome. Each member is read and checked
 * against its receipt before any of it is written, so a file in the archive is
 * always the file the render published. One member at a time is in memory, and
 * the manifest goes last, so it records what the archive actually holds.
 */
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import { ZipBuilder } from '../links/zip.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { batchProgress } from './batch.ts';
import type { RenderBatchRecord, RenderRecord } from './types.ts';

/** Classic ZIP tops out at 4 GiB; this is the limit a collection zip keeps too. */
export const RENDER_ARCHIVE_MAX_BYTES = 2 * 1024 * 1024 * 1024;

const hasOutput = (render: RenderRecord): boolean => render.state === 'succeeded' && !!render.output && !render.output.expiredAt;

export function archivePlan(batch: RenderBatchRecord): { members: number; bytes: number } {
  const rows = batch.rows.filter(({ render }) => hasOutput(render));
  return { members: rows.length, bytes: rows.reduce((sum, { render }) => sum + render.output!.size, 0) };
}

/** Row keys are already safe path segments; only a case difference can collide on extraction. */
function memberName(key: string, format: string, used: Set<string>): string {
  let name = `${key}.${format}`;
  for (let n = 2; used.has(name.toLowerCase()); n++) name = `${key}-${n}.${format}`;
  used.add(name.toLowerCase());
  return name;
}

export interface ArchiveManifestRow {
  key: string;
  renderId: string;
  state: RenderRecord['state'];
  archived: boolean;
  file?: string;
  size?: number;
  sha256?: string;
  /** Why a row with no file has none. A row that failed also has `error`. */
  reason?: string;
  error?: { code: string; message: string };
}

/** Writes the archive through `write`, which answers false once the reader has gone. */
export async function writeBatchArchive(batch: RenderBatchRecord, blobs: BlobStore, write: (chunk: Buffer) => Promise<boolean>, now = new Date()): Promise<ArchiveManifestRow[]> {
  const zip = new ZipBuilder(now);
  const used = new Set<string>();
  const rows: ArchiveManifestRow[] = [];
  for (const { key, render } of batch.rows) {
    const row: ArchiveManifestRow = { key, renderId: render.id, state: render.state, archived: false };
    rows.push(row);
    if (render.error) row.error = { code: render.error.code, message: render.error.message };
    if (!hasOutput(render)) { row.reason = render.output?.expiredAt ? 'OUTPUT_EXPIRED' : 'NOT_SUCCEEDED'; continue; }
    const output = render.output!;
    const blob = await blobs.get(output.ref);
    if (!blob) { row.reason = 'OUTPUT_UNAVAILABLE'; continue; }
    let bytes: Buffer;
    try { bytes = await readBlobBody(blob.body, output.size); }
    catch { row.reason = 'OUTPUT_INTEGRITY'; continue; }
    if (bytes.byteLength !== output.size || sha256Hex(bytes) !== output.sha256) { row.reason = 'OUTPUT_INTEGRITY'; continue; }
    const file = memberName(key, render.request.format, used);
    if (!await write(zip.add(file, bytes))) return rows;
    Object.assign(row, { archived: true, file, size: output.size, sha256: output.sha256 });
  }
  const { state, progress } = batchProgress(batch);
  const manifest = {
    manifestVersion: 1, batchId: batch.id, toolId: batch.request.toolId, format: batch.request.format,
    state, progress, createdAt: batch.createdAt, archived: rows.filter((row) => row.archived).length, rows,
  };
  if (!await write(zip.add('manifest.json', Buffer.from(JSON.stringify(manifest, null, 2))))) return rows;
  await write(zip.end());
  return rows;
}
