// SPDX-License-Identifier: MPL-2.0
/** inline-em-v1 sizing, and prepared plus treated emoji artwork for one run of text. */
import type { EmojiGlyphV1, EmojiMetricsV1, EmojiPackPinV1, EmojiStyleV1 } from '@lolly-tools/core';
import { describeEmojiPack, emojiPackPinKey, matchesEmojiPack } from './emoji-pack.ts';
import type { VerifiedEmojiPack } from './emoji-pack.ts';
import { resolveEmoji } from './emoji-resolve.ts';
import { segmentEmojiText } from './emoji-segment.ts';
import { emojiSvgChanges, emojiSvgMarkup, inkPreparedEmojiSvg, prepareEmojiSvg } from './emoji-svg.ts';
import type { EmojiXmlParser, PreparedEmojiSvg } from './emoji-svg.ts';
import { applyEmojiTreatment } from './emoji-treatment.ts';
import type { EmojiLineSource } from './emoji-line.ts';

/** The metrics policy this module implements, as saved in an `EmojiStyleV1`. */
export const EMOJI_METRICS_POLICY = 'inline-em-v1';

/** The treatment recipe carried by a style. Read off the contract so the engine
 *  needs no second copy of the union. */
type EmojiTreatment = EmojiStyleV1['treatment'];

/**
 * One placed glyph's box, in em, under `inline-em-v1`. Every value is a
 * multiple of the surrounding font size, so a glyph tracks the text it sits in
 * without the engine measuring anything: the host does the layout, exactly as it
 * does for text today.
 */
export interface EmojiInlineMetricsV1 {
  /** Ink-box height, `viewBox[3] / unitsPerEm`. */
  heightEm: number;
  /** Ink-box width, `viewBox[2] / unitsPerEm`. */
  widthEm: number;
  /** The glyph's advance, which may be wider or narrower than the ink box. */
  advanceEm: number;
  /** How far the ink box drops below the baseline. */
  descentEm: number;
  /** Space after the ink box, only when the advance is the wider of the two. */
  marginRightEm: number;
}

/** Sizing for one glyph under `inline-em-v1`. Pure arithmetic on pinned numbers. */
export function emojiInlineMetrics(glyph: Pick<EmojiGlyphV1, 'viewBox'>, metrics: EmojiMetricsV1): EmojiInlineMetricsV1 {
  const height = glyph.viewBox[3], width = glyph.viewBox[2];
  const { unitsPerEm, advance, baseline } = metrics;
  if (!(unitsPerEm > 0) || !Number.isFinite(width) || !Number.isFinite(height)) throw new Error('Emoji metrics require a positive em size.');
  const heightEm = height / unitsPerEm, widthEm = width / unitsPerEm, advanceEm = advance / unitsPerEm;
  return { heightEm, widthEm, advanceEm, descentEm: (height - baseline) / unitsPerEm, marginRightEm: Math.max(0, advanceEm - widthEm) };
}

/** Six decimal places, so the same inputs write the same characters everywhere. */
const em = (value: number): string => String(Math.round(value * 1_000_000) / 1_000_000);

/** The inline style an outer emoji span carries, so a placement needs no shell stylesheet. */
export function emojiInlineStyle(metrics: EmojiInlineMetricsV1): string {
  const margin = metrics.marginRightEm > 0 ? `;margin-right:${em(metrics.marginRightEm)}em` : '';
  return `display:inline-block;position:relative;width:${em(metrics.widthEm)}em;height:${em(metrics.heightEm)}em;vertical-align:${em(-metrics.descentEm)}em${margin}`;
}

/** What the caller can do for the engine: hand over pinned bytes and parse XML. */
export interface EmojiTextIO {
  loadArtwork(pin: EmojiPackPinV1, asset: EmojiGlyphV1['asset']): Promise<Uint8Array>;
  parseXml: EmojiXmlParser;
}

/** One pack's artwork for one meaning under one treatment, prepared once. */
export interface EmojiArtworkRecord {
  svg: PreparedEmojiSvg;
  metrics: EmojiInlineMetricsV1;
  label: string;
  key: string;
  /** The census entry without its occurrences, which belong to a single run of text. */
  base: Omit<EmojiLineSource, 'occurrences'>;
}

/** Keyed by pack pin, meaning and treatment. The caller owns it, so a runtime
 *  prepares each distinct artwork once however many nodes it appears in. */
export type EmojiArtworkCache = Map<string, EmojiArtworkRecord>;

export interface PrepareEmojiTextOptions {
  cache?: EmojiArtworkCache;
  /** Base for placement prefixes. Each glyph gets `<prefix>-<n>`, so local ids
   *  cannot collide once the markup is placed in a document. */
  prefix?: string;
}

export type EmojiTextSegmentV1 =
  | { kind: 'text'; text: string }
  | { kind: 'emoji'; text: string; key: string; label: string; markup: string; metrics: EmojiInlineMetricsV1; source: EmojiLineSource }
  | { kind: 'unresolved'; text: string; label?: string; reason: string };

export interface PreparedEmojiText {
  segments: EmojiTextSegmentV1[];
  /** One entry per distinct artwork, ready for `emojiSourceIngredients`. */
  census: EmojiLineSource[];
}

const meaningKey = (meaning: EmojiLineSource['meaning']): string => meaning.kind === 'unicode' ? meaning.key : meaning.id;

/**
 * Segment one string, resolve every complete emoji through the saved style, and
 * prepare plus treat each distinct artwork once. Nothing here falls back to an
 * operating-system font: a cluster that does not resolve comes back as
 * `unresolved` for the caller to draw as a placeholder.
 */
export async function prepareEmojiText(
  text: string,
  style: EmojiStyleV1 | null | undefined,
  packs: readonly VerifiedEmojiPack[],
  io: EmojiTextIO,
  options: PrepareEmojiTextOptions = {},
): Promise<PreparedEmojiText> {
  const cache = options.cache ?? new Map<string, EmojiArtworkRecord>();
  const prefix = options.prefix ?? 'emoji';
  const treatment: EmojiTreatment = style?.treatment ?? { mode: 'original', strengthBps: 0 };
  const segments: EmojiTextSegmentV1[] = [];
  const census: EmojiLineSource[] = [];
  const used = new Map<string, EmojiLineSource>();
  let placement = 0;

  const pushText = (value: string): void => {
    const previous = segments.at(-1);
    if (previous?.kind === 'text') previous.text += value;
    else segments.push({ kind: 'text', text: value });
  };

  for (const span of segmentEmojiText(text)) {
    if (span.kind === 'text') { pushText(span.text); continue; }
    if (span.kind === 'unsupported') { segments.push({ kind: 'unresolved', text: span.text, reason: 'unsupported-sequence' }); continue; }
    const resolution = resolveEmoji({ kind: 'unicode', text: span.text }, style ?? null, packs);
    if (resolution.status === 'text') { pushText(resolution.text); continue; }
    if (resolution.status === 'unresolved') { segments.push({ kind: 'unresolved', text: span.text, reason: resolution.issue.code }); continue; }
    const value = resolution.value;
    const record = await artworkFor(value, treatment, packs, io, cache);
    if ('reason' in record) { segments.push({ kind: 'unresolved', text: span.text, label: value.glyph.label, reason: record.reason }); continue; }
    const key = cacheKey(value.pack, value.meaning, treatment);
    let source = used.get(key);
    if (!source) {
      source = { ...structuredClone(record.base), occurrences: [] };
      used.set(key, source);
      census.push(source);
    }
    source.occurrences.push({ start: span.start, end: span.end });
    segments.push({
      kind: 'emoji', text: span.text, key: record.key, label: record.label,
      markup: emojiSvgMarkup(record.svg, `${prefix}-${placement++}`),
      metrics: record.metrics, source,
    });
  }
  return { segments, census };
}

const cacheKey = (pin: EmojiPackPinV1, meaning: EmojiLineSource['meaning'], treatment: EmojiTreatment): string =>
  JSON.stringify([emojiPackPinKey(pin), meaningKey(meaning), treatment]);

/** Prepare and treat one glyph's artwork, or say why it cannot be drawn. */
async function artworkFor(
  value: { pack: EmojiPackPinV1; meaning: EmojiLineSource['meaning']; glyph: EmojiGlyphV1; metrics: EmojiMetricsV1 },
  treatment: EmojiTreatment,
  packs: readonly VerifiedEmojiPack[],
  io: EmojiTextIO,
  cache: EmojiArtworkCache,
): Promise<EmojiArtworkRecord | { reason: string }> {
  const key = cacheKey(value.pack, value.meaning, treatment);
  const cached = cache.get(key);
  if (cached) return cached;
  const pack = packs.find(candidate => matchesEmojiPack(candidate, value.pack));
  const described = pack && describeEmojiPack(pack);
  if (!pack || !described) return { reason: 'pack-unavailable' };
  let bytes: Uint8Array;
  try { bytes = await io.loadArtwork(structuredClone(value.pack), structuredClone(value.glyph.asset)); }
  catch { return { reason: 'artwork-unavailable' }; }
  const prepared = await prepareEmojiSvg(pack, value.meaning, bytes, io.parseXml);
  if (!prepared.ok) return { reason: 'unsupported-artwork' };
  // `original` is the upstream artwork, so there is nothing to recolour. The one
  // thing it does is bind a single-ink glyph's black paints to the text colour,
  // which is how the same artwork behaves when a monochrome set ships as a font;
  // artwork that is not single ink comes back as it is. Every other mode goes
  // through the one pinned recipe, where black is a palette decision like any
  // other colour, so the ink rewrite stays out of the way.
  const svg = treatment.mode === 'original'
    ? await inkPreparedEmojiSvg(prepared.svg)
    : (await applyEmojiTreatment(prepared.svg, treatment, value.meaning)).svg;
  let metrics: EmojiInlineMetricsV1;
  // Admission bounds a pack's metrics, so this is an invariant break rather than
  // an ordinary gap. One odd glyph still must not take a whole render down.
  try { metrics = emojiInlineMetrics(value.glyph, value.metrics); }
  catch { return { reason: 'unsupported-metrics' }; }
  const record: EmojiArtworkRecord = {
    svg, metrics, label: value.glyph.label, key: meaningKey(value.meaning),
    base: {
      pack: structuredClone(value.pack), family: described.family, style: described.style,
      meaning: structuredClone(value.meaning), label: value.glyph.label, assetId: value.glyph.asset.id,
      source: structuredClone(value.glyph.source), sourceChecksum: value.glyph.sourceChecksum,
      artworkChecksum: value.glyph.asset.checksum, canonicalChecksum: svg.checksum,
      normalizer: svg.normalizer, changes: emojiSvgChanges(svg),
    },
  };
  cache.set(key, record);
  return record;
}
