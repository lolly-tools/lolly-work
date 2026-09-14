// SPDX-License-Identifier: MPL-2.0
/** Experimental single LTR line master. Paragraph layout and export rights delivery are separate gates. */
import type { EmojiGlyphV1, EmojiSourceV1, EmojiStyleV1, EmojiPackPinV1, EmojiMeaningV1 } from '@lolly-tools/core';
import type { TextAPI } from '@lolly-tools/core/host-v1';
import { bytesToBin, sha256Hex } from './bytes.ts';
import { escapeXml } from './xml-escape.ts';
import { describeEmojiPack, matchesEmojiPack, validateEmojiStyle } from './emoji-pack.ts';
import type { VerifiedEmojiPack } from './emoji-pack.ts';
import { resolveEmoji } from './emoji-resolve.ts';
import { segmentEmojiText, requiresEmojiBidiLayout } from './emoji-segment.ts';
import { prepareEmojiSvg, emojiSvgMarkup, emojiSvgChanges } from './emoji-svg.ts';
import type { EmojiXmlParser, PreparedEmojiSvg } from './emoji-svg.ts';
import { svgPath } from './emoji-svg-syntax.ts';

export const EMOJI_LINE_VERSION = 'emoji-line-experiment-v1';
export interface EmojiLineInput {
  text: string;
  style: EmojiStyleV1;
  font: { bytes: Uint8Array; checksum: string; size: number };
}
export interface EmojiLineHost {
  text: Pick<TextAPI, 'toPath'>;
  parseXml: EmojiXmlParser;
  loadArtwork(asset: EmojiGlyphV1['asset']): Promise<Uint8Array>;
}
export interface EmojiLineSource {
  pack: EmojiPackPinV1;
  /** Family and style names of the admitted pack, for credits and ingredient titles. */
  family: string;
  style: string;
  meaning: EmojiMeaningV1;
  /** The glyph's readable name and its pinned asset id in the pack. */
  label: string;
  assetId: string;
  source: EmojiSourceV1;
  sourceChecksum: string;
  artworkChecksum: string;
  canonicalChecksum: string;
  normalizer: string;
  changes: string[];
  occurrences: { start: number; end: number }[];
}
export interface EmojiLineRun { kind: 'text' | 'emoji'; start: number; end: number; x: number; advance: number }
export interface EmojiLineMaster {
  svg: string;
  checksum: string;
  width: number;
  height: number;
  baseline: number;
  advance: number;
  runs: EmojiLineRun[];
  sources: EmojiLineSource[];
  recipe: {
    compiler: typeof EMOJI_LINE_VERSION;
    unicode: '17.0'; segmentation: 'uax29-47'; layout: 'single-ltr-line';
    text: string; style: EmojiStyleV1;
    font: { checksum: string; size: number; instance: 'font-default'; features: string[] };
    textAdapter: 'host.text-v1.192';
    replay: 'materialized-svg';
  };
}
export type EmojiLineResult = { ok: true; master: EmojiLineMaster } | { ok: false; code: string; message: string; start?: number; end?: number };
const fail = (code: string, message: string, span?: { start: number; end: number }): EmojiLineResult => ({ ok: false, code, message, ...(span ? { start: span.start, end: span.end } : {}) });
function hasLineControls(text: string): boolean {
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point < 0x20 || (point >= 0x7f && point <= 0x9f) || point === 0x2028 || point === 0x2029) return true;
  }
  return false;
}
const number = (value: number): string => {
  if (!Number.isFinite(value) || Math.abs(value) > 1_000_000) throw new Error('Line exceeds the supported geometry bounds.');
  return String(Math.round(value * 1_000_000) / 1_000_000);
};

/** Produces a self-contained developer specimen, with no native text or implicit emoji fallback. */
export async function compileEmojiLine(input: EmojiLineInput, packs: readonly VerifiedEmojiPack[], host: EmojiLineHost): Promise<EmojiLineResult> {
  try {
    const { text } = input;
    const invalid = validateEmojiStyle(input.style);
    if (invalid) return fail(invalid.code, invalid.message);
    const style = structuredClone(input.style);
    const packSnapshot = [...packs];
    const spans = segmentEmojiText(text);
    if (requiresEmojiBidiLayout(text) || hasLineControls(text)) return fail('unsupported-layout', 'This specimen supports one LTR line. Paragraph, bidi and control-character layout is not available yet.');
    if (spans.length > 1024) return fail('layout-limit', 'The line exceeds the supported span count.');
    const { checksum, size } = input.font;
    if (!/^sha256:[a-f0-9]{64}$/.test(checksum) || !Number.isFinite(size) || size < 1 || size > 4096 || !input.font.bytes.length || input.font.bytes.length > 32 * 1024 * 1024) return fail('invalid-font', 'A bounded, pinned sfnt font and size are required.');
    const fontBytes = new Uint8Array(input.font.bytes);
    const signature = Array.from(fontBytes.subarray(0, 4)).join(',');
    if (!['0,1,0,0', '79,84,84,79'].includes(signature)) return fail('unsupported-font', 'This specimen requires an sfnt TTF or OTF font.');
    // Resolve the entire line before any asynchronous host calls. No partial result is published.
    const resolved = spans.map(span => span.kind === 'emoji' ? resolveEmoji({ kind: 'unicode', text: span.text }, style, packSnapshot) : null);
    for (const [index, span] of spans.entries()) {
      if (span.kind === 'unsupported') return fail('unsupported-sequence', 'This complete emoji cluster is unsupported.', span);
      const result = resolved[index];
      if (result?.status === 'unresolved') return fail(result.issue.code, result.issue.message, span);
    }
    if (`sha256:${await sha256Hex(fontBytes)}` !== checksum) return fail('integrity-mismatch', 'Text font does not match its saved checksum.');
    const fontUrl = `data:font/ttf;base64,${btoa(bytesToBin(fontBytes))}`;
    const features = ['kern=1', 'liga=1'];
    const runs: EmojiLineRun[] = [], sources: EmojiLineSource[] = [], markup: string[] = [];
    const artwork = new Map<string, { svg: PreparedEmojiSvg; source: EmojiLineSource }>();
    let advance = 0, x1 = 0, x2 = 0, y1 = -size, y2 = size * 0.25, outputSize = 0;
    for (const [index, span] of spans.entries()) {
      const x = advance;
      const previousMarkupCount = markup.length;
      if (span.kind === 'text') {
        const shaped = await host.text.toPath({ text: span.text, fontUrl, fontSize: size, features: [...features], preserveWhitespaceAdvance: true });
        if (shaped.notdef !== 0) return fail('text-glyph-unavailable', 'The pinned text font cannot prove complete glyph coverage.', span);
        if (!Number.isFinite(shaped.advanceWidth) || shaped.advanceWidth < 0 || (/^[ \u00a0]+$/.test(span.text) && shaped.advanceWidth <= 0)) return fail('invalid-text-metrics', 'The text host did not supply usable run advances.', span);
        if (shaped.d) {
          const path = svgPath(shaped.d);
          markup.push(`<path d="${escapeXml(path)}" fill="#17252a" transform="translate(${number(x)} 0)"></path>`);
          if (!shaped.bbox) return fail('invalid-text-metrics', 'Outlined text has no measured ink bounds.', span);
        }
        if (shaped.bbox) {
          const box = shaped.bbox;
          for (const value of Object.values(box)) number(value);
          if (box.x1 > box.x2 || box.y1 > box.y2) return fail('invalid-text-metrics', 'The text host returned inverted ink bounds.', span);
          x1 = Math.min(x1, x + box.x1); x2 = Math.max(x2, x + box.x2);
          y1 = Math.min(y1, box.y1); y2 = Math.max(y2, box.y2);
        }
        advance += shaped.advanceWidth;
      } else {
        const resolution = resolved[index];
        if (resolution?.status !== 'resolved') return fail('unresolved-line', 'Emoji resolution did not produce a glyph.', span);
        const value = resolution.value;
        const key = JSON.stringify([value.pack.checksum, value.meaning]);
        let record = artwork.get(key);
        if (!record) {
          const pack = packSnapshot.find(pack => matchesEmojiPack(pack, value.pack));
          const described = pack && describeEmojiPack(pack);
          if (!pack || !described) return fail('pack-unavailable', 'The exact emoji set is unavailable.', span);
          const bytes = await host.loadArtwork(structuredClone(value.glyph.asset));
          const prepared = await prepareEmojiSvg(pack, value.meaning, bytes, host.parseXml);
          if (!prepared.ok) return fail('unsupported-artwork', prepared.message, span);
          const source: EmojiLineSource = {
            pack: value.pack, family: described.family, style: described.style, meaning: value.meaning,
            label: value.glyph.label, assetId: value.glyph.asset.id, source: value.glyph.source,
            sourceChecksum: value.glyph.sourceChecksum, artworkChecksum: value.glyph.asset.checksum,
            canonicalChecksum: prepared.svg.checksum, normalizer: prepared.svg.normalizer,
            changes: emojiSvgChanges(prepared.svg), occurrences: [],
          };
          record = { svg: prepared.svg, source }; artwork.set(key, record); sources.push(source);
        }
        record.source.occurrences.push({ start: span.start, end: span.end });
        const scale = size / value.metrics.unitsPerEm, top = -value.metrics.baseline * scale;
        markup.push(`<g transform="translate(${number(x)} ${number(top)}) scale(${number(scale)})">${emojiSvgMarkup(record.svg, `emoji-${index}`)}</g>`);
        x2 = Math.max(x2, x + value.glyph.viewBox[2] * scale);
        y1 = Math.min(y1, top); y2 = Math.max(y2, top + value.glyph.viewBox[3] * scale);
        advance += value.metrics.advance * scale;
      }
      number(advance);
      runs.push({ kind: span.kind as EmojiLineRun['kind'], start: span.start, end: span.end, x, advance: advance - x });
      if (markup.length > previousMarkupCount) outputSize += markup.at(-1)!.length;
      if (outputSize > 4 * 1024 * 1024) return fail('layout-limit', 'The line exceeds the supported vector output size.');
    }
    const left = x1 - 1, top = y1 - 1, width = Math.max(x2, advance) - left + 1, height = y2 - top + 1;
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${number(width)}" height="${number(height)}" viewBox="${number(left)} ${number(top)} ${number(width)} ${number(height)}"><title>${escapeXml(text)}</title>${markup.join('')}</svg>`;
    return { ok: true, master: {
      svg, checksum: `sha256:${await sha256Hex(new TextEncoder().encode(svg))}`, width, height, baseline: -top, advance, runs, sources,
      recipe: { compiler: EMOJI_LINE_VERSION, unicode: '17.0', segmentation: 'uax29-47', layout: 'single-ltr-line', text, style,
        font: { checksum, size, instance: 'font-default', features }, textAdapter: 'host.text-v1.192', replay: 'materialized-svg' },
    } };
  } catch (error) { return fail('line-compilation-failed', error instanceof Error ? error.message : 'Line compilation failed.'); }
}
