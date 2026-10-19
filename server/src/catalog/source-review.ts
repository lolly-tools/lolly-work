// SPDX-License-Identifier: MPL-2.0
/** Frozen source review is distinct from admission and final-byte delivery. */
import { sha256Hex } from '../lib/crypto.ts';
import type { AssetVersionRecord } from './versions.ts';
export interface SourceReviewFile {
  assetId: string;
  version: number;
  format: string;
  sha256: string;
  representation: 'original';
}
export interface SourceReviewSubject {
  purpose: string;
  target: string;
  files: SourceReviewFile[];
  fingerprint: string;
  origin: 'member-session' | 'agent-delegated';
  observedAt: string;
  mappingRevision: 'instance-source-review-v1';
  metadataHistory: 'not-recorded';
}
export function parseSourceReview(value: unknown): Omit<SourceReviewSubject, 'fingerprint' | 'origin' | 'observedAt' | 'mappingRevision' | 'metadataHistory'> | null {
  if (!value || typeof value !== 'object') return null;
  const body = value as Record<string, unknown>;
  if (typeof body.purpose !== 'string' || !body.purpose.trim() || body.purpose.length > 200
    || typeof body.target !== 'string' || !body.target.trim() || body.target.length > 300
    || !Array.isArray(body.files) || !body.files.length || body.files.length > 32) return null;
  const files: SourceReviewFile[] = [];
  for (const raw of body.files) {
    if (!raw || typeof raw !== 'object') return null;
    const f = raw as Record<string, unknown>;
    if (typeof f.assetId !== 'string' || !/^inst\/[A-Za-z0-9_-]{1,200}$/.test(f.assetId)
      || !Number.isSafeInteger(f.version) || Number(f.version) < 1
      || typeof f.format !== 'string' || !/^[a-zA-Z0-9._-]{1,100}$/.test(f.format)
      || typeof f.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(f.sha256) || f.representation !== 'original') return null;
    files.push({ assetId: f.assetId, version: Number(f.version), format: f.format, sha256: f.sha256, representation: 'original' });
  }
  const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
  files.sort((a, b) => compare(a.assetId, b.assetId) || a.version - b.version || compare(a.format, b.format));
  if (new Set(files.map(f => `${f.assetId}:${f.version}:${f.format}`)).size !== files.length) return null;
  return { purpose: body.purpose.trim(), target: body.target.trim(), files };
}
export function freezeSourceReview(value: NonNullable<ReturnType<typeof parseSourceReview>>, now: string, origin: SourceReviewSubject['origin'] = 'member-session'): SourceReviewSubject {
  const subject = structuredClone(value);
  return { ...subject, fingerprint: sha256Hex(JSON.stringify(subject)), origin, observedAt: now,
    mappingRevision: 'instance-source-review-v1', metadataHistory: 'not-recorded' };
}
export function sourceReviewFormat(file: SourceReviewFile, rows: AssetVersionRecord[]) {
  return rows.find(row => row.version === file.version)?.formats.find(format => format.format === file.format && format.checksum === file.sha256);
}
