// SPDX-License-Identifier: MPL-2.0
/** Reviewed words are tied to one indexed asset revision and selected file. */
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import type { AssetIndexEntry } from './lifecycle.ts';

export interface TextIndexSource {
  revision: string;
  fileId: string;
  method: 'ocr' | 'digital';
  reviewedBy: string;
  reviewedAt: string;
}
export interface TextIndexFile { id: string; name: string; format: string; url: string; role?: 'original' | 'rendition'; checksum?: string }
const metaFiles = (entry: AssetIndexEntry): unknown => entry.meta && typeof entry.meta === 'object'
  ? (entry.meta as Record<string, unknown>).assetFiles : undefined;

export function textIndexRevision(entry: AssetIndexEntry): string {
  return sha256Hex(canonicalJson({ id: entry.id, version: entry.version ?? null, checksum: entry.checksum ?? null,
    formats: entry.formats ?? [], files: metaFiles(entry) ?? null }));
}

export function textIndexFiles(entry: AssetIndexEntry): TextIndexFile[] {
  const files = metaFiles(entry);
  if (Array.isArray(files)) return files.filter((file): file is TextIndexFile => !!file && typeof file === 'object'
    && typeof file.id === 'string' && typeof file.url === 'string' && typeof file.format === 'string'
    && typeof file.name === 'string' && /^[a-f0-9]{24}$/.test(file.id)).slice(0, 3000);
  return (entry.formats ?? []).filter(file => file.format !== 'thumb' && !file.rendition && typeof file.url === 'string').map(file => ({
    id: sha256Hex(`${file.format}\0${file.url}`).slice(0, 24), name: typeof file.filename === 'string' ? file.filename : `${entry.name ?? entry.id}.${file.format}`,
    format: file.format, url: file.url!,
    ...(typeof file.checksum === 'string' ? { checksum: file.checksum } : {}),
  }));
}

export function textIndexCurrent(source: TextIndexSource, entry: AssetIndexEntry): boolean {
  return source.revision === textIndexRevision(entry) && textIndexFiles(entry).some(file => file.id === source.fileId);
}

export function textIndexView(entry: AssetIndexEntry, meta: { extractedText?: string; extractedTextSource?: TextIndexSource } | null | undefined) {
  const source = meta?.extractedTextSource;
  return { revision: textIndexRevision(entry), assetVersion: String(entry.version ?? ''),
    status: !meta?.extractedText ? 'none' : !source ? 'unverified' : textIndexCurrent(source, entry) ? 'current' : 'stale',
    characters: meta?.extractedText?.length ?? 0, ...(source ? { source } : {}) };
}
