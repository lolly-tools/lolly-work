// SPDX-License-Identifier: MPL-2.0
/** Portable text fragments resolve styles and rehome font ids without changing source. */
import type { TextCharacterV1, TextDocumentV1, TextRangeV1, TextStoryV1 } from '@lolly-tools/core';
import { createTextStory, parseTextDocument } from './text-story-document.ts';
import { assertTextRange, paragraphRanges } from './text-source.ts';
import { normalizeTextSpans, type TextInsertion } from './text-edits.ts';
import { textStyleResolver } from './text-styles.ts';
export function sliceTextDocument(doc: TextDocumentV1, story: TextStoryV1, range: TextRangeV1): TextDocumentV1 {
  assertTextRange(story.source, range);
  const result = createTextStory('fragment', story.source.slice(range.start, range.end), index => `p${index}`);
  result.breaks = story.breaks.filter(item => item.start >= range.start && item.start < range.end).map(item => ({ ...item, start: item.start - range.start }));
  const resolve = textStyleResolver(doc);
  result.paragraphs = paragraphRanges(result.source, result.breaks).map((bounds, index) => {
    const at = bounds.start + range.start, paragraph = story.paragraphs.find(item => item.start <= at && item.end >= at) ?? story.paragraphs.at(-1)!;
    return { ...bounds, id: `p${index}`, paragraph: resolve.paragraph(story, paragraph) };
  });
  const points = [...new Set([range.start, range.end, ...story.paragraphs.flatMap(item => [item.start, item.end]), ...story.spans.flatMap(item => [item.start, item.end])])].filter(at => at >= range.start && at <= range.end).sort((a, b) => a - b);
  result.spans = normalizeTextSpans(result.source, points.slice(0, -1).map((at, index) => {
    const paragraph = story.paragraphs.find(item => item.start <= at && item.end >= at) ?? story.paragraphs.at(-1)!;
    const span = story.spans.find(item => item.start <= at && item.end > at);
    return { start: at - range.start, end: points[index + 1]! - range.start, character: resolve.character(story, paragraph, at), ...(span?.noBreak ? { noBreak: true } : {}), ...(span?.literal ? { literal: true } : {}) };
  }));
  result.inlines = story.inlines.filter(item => item.offset >= range.start && item.offset < range.end).map(item => ({ ...structuredClone(item), offset: item.offset - range.start }));
  const used = new Set<string>();
  const remember = (value: TextCharacterV1 | undefined) => { if (value?.font) used.add(value.font); for (const id of value?.fallbackFonts ?? []) used.add(id); };
  for (const item of result.spans) remember(item.character);
  for (const item of result.paragraphs) remember(item.paragraph?.character);
  return parseTextDocument({ version: 1, stories: [result], fonts: doc.fonts.filter(font => used.has(font.id)), styles: [] });
}
export function importTextFragment(doc: TextDocumentV1, input: unknown, inlineId: () => string): { document: TextDocumentV1; insertion: TextInsertion } {
  const parsed = parseTextDocument(input);
  if (parsed.stories.length !== 1 || parsed.stories[0]!.frameIds.length) throw new Error('A text fragment must contain one unplaced story.');
  const fragment = sliceTextDocument(parsed, parsed.stories[0]!, { start: 0, end: parsed.stories[0]!.source.length });
  const fonts = new Map(doc.fonts.map(font => [font.id, font])), ids = new Map<string, string>();
  for (const font of fragment.fonts) {
    const same = [...fonts.values()].find(item => item.sha256 === font.sha256 && item.faceIndex === font.faceIndex);
    let id = same?.id ?? font.id;
    if (!same && fonts.has(id)) { const base = `font-${font.sha256}-${font.faceIndex}`; id = base; for (let n = 1; fonts.has(id); n++) id = `${base}-${n}`; }
    ids.set(font.id, id); if (!same) fonts.set(id, { ...font, id });
  }
  const rehome = (value: TextCharacterV1 | undefined): TextCharacterV1 | undefined => value ? { ...value,
    ...(value.font ? { font: ids.get(value.font)! } : {}), ...(value.fallbackFonts ? { fallbackFonts: value.fallbackFonts.map(id => ids.get(id)!) } : {}) } : undefined;
  const story = fragment.stories[0]!;
  return { document: { ...doc, fonts: [...fonts.values()] }, insertion: {
    source: story.source, breaks: story.breaks, spans: story.spans.map(span => ({ ...span, character: rehome(span.character) })),
    paragraphs: story.paragraphs.map(paragraph => ({ start: paragraph.start, paragraph: { ...paragraph.paragraph, character: rehome(paragraph.paragraph?.character) } })),
    inlines: story.inlines.map(inline => ({ ...inline, id: inlineId() })),
  } };
}
