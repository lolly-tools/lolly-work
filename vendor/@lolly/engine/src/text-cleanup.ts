// SPDX-License-Identifier: MPL-2.0
/** Optional, reviewable typography edits; never an automatic source normalizer. */
import type { TextRangeV1, TextStoryV1 } from '@lolly-tools/core';
import { assertTextRange, textBoundaries, TextSourceError } from './text-source.ts';
import { replaceStoryRange } from './text-edits.ts';
export interface TextCleanupEdit extends TextRangeV1 { before: string; after: string; kind: 'quotes' | 'spaces' | 'discretionary' }
export interface TextCleanupPreview { storyId: string; revision: number; range: TextRangeV1; edits: TextCleanupEdit[] }
export interface TextCleanupOptions { quotes: boolean; spaces: boolean; discretionary: boolean }
export function previewTextCleanup(story: TextStoryV1, range: TextRangeV1, language: string, options: TextCleanupOptions): TextCleanupPreview {
  assertTextRange(story.source, range);
  const edits: TextCleanupEdit[] = [], source = story.source.slice(range.start, range.end), boundaries = textBoundaries(story.source);
  const protectedRanges = [...story.spans.filter(span => span.literal), ...[...story.source.matchAll(/(?:https?:\/\/|www\.)[^\s]+|`[^`\n]+`/gu)].map(match => ({ start: match.index, end: match.index + match[0].length }))];
  const add = (start: number, end: number, after: string, kind: TextCleanupEdit['kind']) => {
    start += range.start; end += range.start;
    if (!boundaries.has(start) || !boundaries.has(end)) return;
    if (protectedRanges.some(item => item.start < end && item.end > start) || edits.some(item => item.start < end && item.end > start)) return;
    if (edits.length >= 512) throw new TextSourceError('cleanup-size', 'Select a smaller range to preview typography cleanup.');
    edits.push({ start, end, before: story.source.slice(start, end), after, kind });
  };
  const tag = language.toLowerCase().split('-')[0];
  if (options.quotes && ['en', 'fr', 'de', 'es'].includes(tag!)) {
    const pair = tag === 'fr' ? ['«\u202f', '\u202f»'] : tag === 'de' ? ['„', '“'] : ['“', '”'];
    for (const match of source.matchAll(/"([^"\n\r\u2028\u2029]+)"/gu)) {
      add(match.index, match.index+1, pair[0]!, 'quotes'); add(match.index+match[0].length-1, match.index+match[0].length, pair[1]!, 'quotes');
    }
    for (const match of source.matchAll(/(?<=\p{L})'(?=\p{L})/gu)) add(match.index, match.index+1, '’', 'quotes');
  }
  if (options.spaces) for (const match of source.matchAll(/(?<=\S) {2,}(?=\S)/gu)) add(match.index, match.index+match[0].length, ' ', 'spaces');
  if (options.discretionary) for (const match of source.matchAll(/[\u00ad\u200b]/gu)) add(match.index, match.index+1, '', 'discretionary');
  return { storyId: story.id, revision: story.revision, range: { ...range }, edits: edits.sort((a,b) => a.start-b.start) };
}
export function applyTextCleanup(story: TextStoryV1, preview: TextCleanupPreview): TextStoryV1 {
  if (story.id !== preview.storyId || story.revision !== preview.revision) throw new TextSourceError('cleanup-stale', 'The text changed. Preview typography cleanup again.');
  assertTextRange(story.source, preview.range);
  if (preview.edits.length > 512) throw new TextSourceError('cleanup-size', 'The cleanup preview exceeds the supported size.');
  let previous = preview.range.start;
  for (const edit of preview.edits) {
    assertTextRange(story.source, edit);
    if (edit.start < previous || edit.end > preview.range.end || edit.start === edit.end || typeof edit.after !== 'string' || edit.after.length > 8 || /[\r\n\u2028\u2029\ufffc]/u.test(edit.after)) throw new TextSourceError('cleanup-edit', 'The cleanup preview contains an unsupported edit.');
    previous = edit.end;
  }
  if (story.id !== preview.storyId || story.revision !== preview.revision || preview.edits.some(edit => story.source.slice(edit.start, edit.end) !== edit.before)) throw new TextSourceError('cleanup-stale', 'The text changed. Preview typography cleanup again.');
  let next = story;
  for (const edit of [...preview.edits].reverse()) next = replaceStoryRange(next, edit, { source: edit.after }, { paragraphId: () => { throw new TextSourceError('cleanup-paragraph', 'Typography cleanup cannot add paragraphs.'); } }).story;
  return next === story ? story : { ...next, revision: story.revision + 1 };
}
