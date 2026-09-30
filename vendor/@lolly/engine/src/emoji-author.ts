// SPDX-License-Identifier: MPL-2.0
/** Author a versioned set from labelled SVGs. Imported art follows the same admission path. */
import type { EmojiMeaningV1, EmojiPackBundleV1, EmojiPackManifestV1, EmojiSourceV1 } from '@lolly-tools/core/emoji-v1';
import { sha256Hex } from './bytes.ts';
import { admitEmojiBundle } from './emoji-bundle.ts';
import type { EmojiXmlParser } from './emoji-svg.ts';

export interface EmojiSetDraft {
  id: string; family: string; style: string; version: string; source: EmojiSourceV1;
  notices: { name: string; text: string }[];
  glyphs: { meaning: EmojiMeaningV1; label: string; svg: string }[];
}
export async function buildEmojiBundle(draft: EmojiSetDraft, parseXml: EmojiXmlParser): Promise<EmojiPackBundleV1> {
  if (!draft.glyphs.length || draft.glyphs.length > 4096) throw new Error('An authored set needs 1 to 4096 glyphs.');
  const artwork: Record<string, string> = Object.create(null);
  const glyphs: EmojiPackManifestV1['glyphs'] = [];
  let total = 0;
  for (let i = 0; i < draft.glyphs.length; i++) {
    const entry = draft.glyphs[i]!;
    const bytes = new TextEncoder().encode(entry.svg); total += bytes.length;
    if (bytes.length > 2 * 1024 * 1024 || total > 48 * 1024 * 1024) throw new Error('Authored emoji artwork exceeds the import limit.');
    if (/<!DOCTYPE|<!ENTITY|<\?/i.test(entry.svg)) throw new Error('Remove XML declarations and DTDs from the authored SVG.');
    const root = parseXml(entry.svg).documentElement;
    const rawBox = root?.getAttribute('viewBox');
    const viewBox = rawBox ? rawBox.trim().split(/[\s,]+/).map(Number) : [0, 0, Number(root?.getAttribute('width')), Number(root?.getAttribute('height'))];
    if (viewBox.length !== 4 || !viewBox.every(Number.isFinite) || viewBox[2]! <= 0 || viewBox[3]! <= 0) throw new Error(`Give ${entry.label} a finite SVG viewBox.`);
    const checksum = `sha256:${await sha256Hex(bytes)}`;
    const url = `glyph-${i}.svg`; artwork[url] = entry.svg;
    glyphs.push({ meaning: entry.meaning, label: entry.label,
      asset: { source: 'library', id: entry.meaning.kind === 'unicode' ? `${draft.id}/unicode/${entry.meaning.key}` : entry.meaning.id, url, type: 'vector', format: 'svg', pin: { version: draft.version, format: 'svg' }, checksum },
      source: structuredClone(draft.source), sourceChecksum: checksum, viewBox: viewBox as [number, number, number, number],
      metrics: { unitsPerEm: viewBox[3]!, advance: viewBox[2]!, baseline: viewBox[3]! * .85 } });
  }
  const manifest: EmojiPackManifestV1 = { schemaVersion: 1, minimumReader: 1, id: draft.id, family: draft.family, style: draft.style,
    version: draft.version, unicodeVersion: '17.0', artwork: 'source-svg-v1', metrics: { unitsPerEm: 1000, advance: 1000, baseline: 850 },
    source: structuredClone(draft.source), notices: structuredClone(draft.notices), glyphs };
  const bundle: EmojiPackBundleV1 = { schemaVersion: 1, kind: 'emoji-pack-bundle', manifest: JSON.stringify(manifest), artwork };
  await admitEmojiBundle(new TextEncoder().encode(JSON.stringify(bundle)), parseXml);
  return bundle;
}
