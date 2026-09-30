// SPDX-License-Identifier: MPL-2.0
/** Source boundary helpers shared by editing and composition. */
import { emojiGraphemes, EMOJI_TEXT_MAX_UNITS } from './emoji-segment.ts';
import type { TextBreakV1, TextRangeV1 } from '@lolly-tools/core';

export const TEXT_SOURCE_MAX_UNITS = EMOJI_TEXT_MAX_UNITS;
export class TextSourceError extends Error {
  readonly code: string;
  constructor(code: string, message: string) { super(message); this.name = 'TextSourceError'; this.code = code; }
}
const boundaryCache = new Map<string, ReadonlySet<number>>();
let boundaryUnits = 0;
function boundaryIndex(source: string): ReadonlySet<number> {
  const cached = boundaryCache.get(source);
  if (cached) { boundaryCache.delete(source); boundaryCache.set(source, cached); return cached; }
  try {
    const result = new Set([0, ...emojiGraphemes(source).map(cluster => cluster.end)]);
    while (boundaryCache.size && (boundaryCache.size >= 128 || boundaryUnits + source.length > 262144)) {
      const first = boundaryCache.keys().next().value!; boundaryUnits -= first.length; boundaryCache.delete(first);
    }
    boundaryCache.set(source, result); boundaryUnits += source.length; return result;
  }
  catch { throw new TextSourceError('source-unicode', 'Text must contain valid Unicode within the supported length.'); }
}
export function textBoundaries(source: string): Set<number> { return new Set(boundaryIndex(source)); }
export function assertTextRange(source: string, range: TextRangeV1, boundaries = boundaryIndex(source)): void {
  if (!Number.isSafeInteger(range.start) || !Number.isSafeInteger(range.end)
    || range.start > range.end || !boundaries.has(range.start) || !boundaries.has(range.end)) {
    throw new TextSourceError('source-boundary', 'Text ranges must end at complete character boundaries.');
  }
}
/** User selections may land inside a cluster. Expand a range; snap a caret by affinity. */
export function snapTextRange(source: string, range: TextRangeV1, affinity: 'upstream' | 'downstream' = 'downstream'): TextRangeV1 {
  const boundaries = [...textBoundaries(source)];
  const bounded = (value: number): number => Number.isFinite(value) ? Math.min(source.length, Math.max(0, Math.trunc(value))) : 0;
  const a = bounded(Math.min(range.start, range.end)), b = bounded(Math.max(range.start, range.end));
  const before = (at: number): number => boundaries.findLast(value => value <= at) ?? 0;
  const after = (at: number): number => boundaries.find(value => value >= at) ?? source.length;
  if (a === b) { const at = affinity === 'upstream' ? before(a) : after(a); return { start: at, end: at }; }
  return { start: before(a), end: after(b) };
}
/** Break records preserve the original separator bytes, including CRLF. */
export function sourceBreaks(source: string, newline: 'paragraph' | 'soft' = 'paragraph'): TextBreakV1[] {
  textBoundaries(source);
  const breaks: TextBreakV1[] = [];
  const separators = new Set([10, 13, 11, 12, 0x85, 0x2028, 0x2029]);
  for (let i = 0; i < source.length; i++) {
    const cp = source.charCodeAt(i);
    if (!separators.has(cp)) continue;
    const length = cp === 13 && source.charCodeAt(i + 1) === 10 ? 2 : 1;
    breaks.push({ start: i, length, kind: cp === 0x2028 ? 'soft' : cp === 0x2029 ? 'paragraph' : newline });
    i += length - 1;
  }
  return breaks;
}
export function paragraphRanges(source: string, breaks: readonly TextBreakV1[]): TextRangeV1[] {
  const ranges: TextRangeV1[] = []; let start = 0;
  for (const item of breaks) if (item.kind === 'paragraph') {
    ranges.push({ start, end: item.start }); start = item.start + item.length;
  }
  ranges.push({ start, end: source.length });
  return ranges;
}
export function deletionRange(source: string, range: TextRangeV1, backwards: boolean): TextRangeV1 {
  const snapped = snapTextRange(source, range, backwards ? 'downstream' : 'upstream');
  if (snapped.start !== snapped.end) return snapped;
  const boundaries = [...textBoundaries(source)], index = boundaries.indexOf(snapped.start);
  return backwards ? { start: boundaries[Math.max(0, index - 1)]!, end: snapped.end }
    : { start: snapped.start, end: boundaries[Math.min(boundaries.length - 1, index + 1)]! };
}
