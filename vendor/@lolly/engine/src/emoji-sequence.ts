// SPDX-License-Identifier: MPL-2.0
/** Whole-sequence emoji recognition from pinned Unicode data, independent of the host's ICU. */
import data from './emoji-data/17.0.json' with { type: 'json' };

export const EMOJI_UNICODE_VERSION = '17.0';
export const EMOJI_SEQUENCE_MAX_SCALARS = 32;

export interface EmojiSequence {
  key: string;
  label: string;
  alias: boolean;
}

let sequenceIndex: Map<string, EmojiSequence> | undefined;
let textVariations: Set<string> | undefined;

function index(): Map<string, EmojiSequence> {
  if (sequenceIndex) return sequenceIndex;
  sequenceIndex = new Map();
  for (const entry of data.entries) {
    sequenceIndex.set(entry.key, { key: entry.key, label: entry.label, alias: false });
    for (const alias of entry.aliases) {
      sequenceIndex.set(alias, { key: entry.key, label: entry.label, alias: true });
    }
  }
  return sequenceIndex;
}

/** Lowercase hex, at least four digits per scalar, joined by hyphens. No normalization. */
export function emojiSequenceKey(text: string): string | null {
  if (!text || text.length > EMOJI_SEQUENCE_MAX_SCALARS * 2) return null;
  const points: string[] = [];
  for (const char of text) {
    const point = char.codePointAt(0)!;
    if (point >= 0xd800 && point <= 0xdfff) return null;
    points.push(point.toString(16).padStart(4, '0'));
    if (points.length > EMOJI_SEQUENCE_MAX_SCALARS) return null;
  }
  return points.join('-');
}

/** Lookup consumes one complete candidate, never a prefix or pieces of an unknown joined sequence.
 * This is not grapheme segmentation, bidi, line breaking or mixed-text layout. */
export function lookupEmojiSequence(text: string): EmojiSequence | null {
  const key = emojiSequenceKey(text);
  const found = key === null ? undefined : index().get(key);
  return found ? { ...found } : null;
}

export function isCanonicalEmojiKey(key: string): boolean {
  return index().get(key)?.alias === false;
}

/** A bare text-default character is text unless the author requests emoji presentation. */
export function usesTextPresentation(text: string, presentation: 'auto' | 'emoji' = 'auto'): boolean {
  textVariations ??= new Set(data.textVariations);
  const key = emojiSequenceKey(text);
  if (key && textVariations.has(key)) return true;
  const found = lookupEmojiSequence(text);
  return presentation === 'auto' && !!found?.alias && Array.from(text).length === 1;
}
