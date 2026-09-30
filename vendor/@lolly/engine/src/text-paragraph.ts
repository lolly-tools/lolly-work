// SPDX-License-Identifier: MPL-2.0
/** Contextual paragraph shaping with logical source and visual placement kept apart. */
import type { TextArtworkV1, TextCharacterV1, TextDocumentV1, TextFontInfoV1, TextFontResourceV1, TextLayoutServicesV1, TextParagraphV1, TextRangeV1, TextShapedRunV1, TextStoryV1 } from '@lolly-tools/core';
import { emojiGraphemes } from './emoji-segment.ts';
import { assertTextRange, TextSourceError } from './text-source.ts';
import { analyzeTextBidi, reorderTextRuns, textLineLevels, textScriptRuns } from './text-unicode.ts';
import { textStyleResolver } from './text-styles.ts';
import { spaceTextLine } from './text-spacing.ts';
import { positionTextTabs } from './text-tabs.ts';
import { textDisplaySource, mapTextDisplayRun } from './text-display.ts';
import { textSemanticSource } from './text-semantic.ts';
interface Atom extends TextRangeV1 {
  style: TextCharacterV1;
  font: TextFontResourceV1;
  script: string;
  artwork?: TextArtworkV1;
  hidden: boolean;
  tab?: boolean;
}
export interface TextParagraphPiece extends TextRangeV1 {
  x: number;
  advance: number;
  ascent: number;
  descent: number;
  style: TextCharacterV1;
  level: number;
  shape?: TextShapedRunV1;
  artwork?: TextArtworkV1;
  carets: Array<{ offset: number; x: number }>;
  tab?: {leader?:string;shape?:TextShapedRunV1};
  tabDistance?:number;
}
export interface ShapedTextLine extends TextRangeV1 {
  pieces: TextParagraphPiece[];
  advance: number;
  ascent: number;
  descent: number;
  direction: 'ltr' | 'rtl';
  hyphen?: { shape: TextShapedRunV1; color: string };
}
function shapedLineBytes(line: ShapedTextLine): number {
  const runBytes = (run: TextShapedRunV1 | undefined): number => !run ? 0 :
    1024 + 2 * (run.text.length + run.script.length + run.language.length + JSON.stringify(run.font).length) +
    64 * run.missing.length + run.clusters.reduce((sum, cluster) => sum + 160 + 2 * cluster.d.length + 48 * cluster.carets.length, 0);
  return 256 + runBytes(line.hyphen?.shape) + line.pieces.reduce((sum, piece) => sum + 256 +
    2 * JSON.stringify(piece.style).length + 48 * piece.carets.length + runBytes(piece.shape) +
    runBytes(piece.tab?.shape) + (piece.artwork ? 2 * JSON.stringify(piece.artwork).length : 0), 0);
}
function covers(info: TextFontInfoV1, text: string): boolean {
  for (const char of text) {
    const cp = char.codePointAt(0)!;
    if (cp === 0x200c || cp === 0x200d || cp === 0xfe0e || cp === 0xfe0f || cp === 0xad || cp === 0x200b || cp === 0x2060) continue;
    let low = 0, high = info.coverage.length - 1, found = false;
    while (low <= high) { const middle = (low + high) >>> 1, [a, b] = info.coverage[middle]!; if (cp < a) high = middle - 1; else if (cp > b) low = middle + 1; else { found = true; break; } }
    if (!found) return false;
  }
  return true;
}
const round = (n: number): number => Math.round(n * 10000) / 10000;
/** No font URL, browser layout or host fallback can change this paragraph's metrics. */
export async function prepareTextParagraph(doc: TextDocumentV1, story: TextStoryV1, paragraph: TextParagraphV1,
  services: TextLayoutServicesV1, artwork: readonly TextArtworkV1[] = []) {
  const styles = textStyleResolver(doc), settings = styles.paragraph(story, paragraph);
  const source = story.source.slice(paragraph.start, paragraph.end), semantic=textSemanticSource(story,paragraph), bidi = analyzeTextBidi(semantic.source, settings.direction);
  const scripts = textScriptRuns(semantic.source), fonts = new Map(doc.fonts.map(font => [font.id, font]));
  const metadata = new Map<string, TextFontInfoV1>(), prepared = new Map(artwork.map(item => [item.start, item]));
  const inlineByOffset = new Map(story.inlines.map(item => [item.offset, item]));
  const clusters = emojiGraphemes(source), atoms: Atom[] = [];
  const needed = new Set<string>();
  const characters = clusters.map(cluster => styles.character(story, paragraph, paragraph.start + cluster.start));
  const defaultCharacter = styles.character(story, paragraph, paragraph.start);
  for (const character of [...characters, defaultCharacter]) {
    if (!character.font) throw new TextSourceError('font-missing', 'Choose an available font before composing this text.');
    for (const id of [character.font, ...character.fallbackFonts ?? []]) needed.add(id);
  }
  const queue = [...needed]; let cursor = 0;
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    while (cursor < queue.length) {
      const id = queue[cursor++]!, font = fonts.get(id);
      if (!font) throw new TextSourceError('font-missing', `The text font is missing: ${id}`);
      metadata.set(id, await services.fontInfo(font));
    }
  }));
  let scriptIndex = 0;
  for (const [index, cluster] of clusters.entries()) {
    const start = paragraph.start + cluster.start, end = paragraph.start + cluster.end, text = story.source.slice(start, end), style = characters[index]!;
    while (scripts[scriptIndex] && scripts[scriptIndex]!.end <= semantic.forward.get(start)!) scriptIndex++;
    const script = scripts[scriptIndex]?.script ?? 'Zyyy', inline = inlineByOffset.get(start);
    const art = prepared.get(start) ?? (inline ? { start, end, svg: inline.svg, overflow:inline.overflow, whitespace:false, width: inline.width, ascent: inline.ascent, descent: inline.descent, id: inline.id, sha256: '' } : undefined);
    if (art && (art.end !== end || ![art.width, art.inkWidth ?? art.width, art.ascent, art.descent].every(n => Number.isFinite(n) && n >= 0))) throw new TextSourceError('artwork-range', 'Inline artwork must cover one complete character with finite dimensions.');
    const hidden = [...text].every(char => [0xad, 0x200b, 0x2060, 0xfeff, 0x061c, 0x200e, 0x200f].includes(char.codePointAt(0)!) || char.codePointAt(0)! >= 0x202a && char.codePointAt(0)! <= 0x202e || char.codePointAt(0)! >= 0x2066 && char.codePointAt(0)! <= 0x2069);
    const separator = story.breaks.some(item => item.start === start);
    const id = [style.font!, ...style.fallbackFonts ?? []].find(id => art || hidden || separator || text==='\t' || covers(metadata.get(id)!, textDisplaySource(text,style.case,settings.language).text));
    if (!id) throw new TextSourceError('font-glyph', `No pinned font covers the character at source offset ${start}.`);
    atoms.push({ start, end, style, font: fonts.get(id)!, script, artwork: art, tab:text==='\t', hidden: hidden || separator });
  }
  const atomIndex=new Map(atoms.map((atom,index)=>[atom.start,index]));atomIndex.set(paragraph.end,atoms.length);
  const cache = new Map<string, { promise:Promise<ShapedTextLine>;bytes:number }>(); let cacheBytes=0;
  async function shape(range: TextRangeV1, trimEnd = true, outline = true): Promise<ShapedTextLine> {
    assertTextRange(source, { start: range.start - paragraph.start, end: range.end - paragraph.start });
    const key = `${range.start}:${range.end}:${trimEnd}:${outline}`;
    const cached = cache.get(key); if (cached) return cached.promise;
    const result=shapeLine(range,trimEnd,outline),entry={promise:result,bytes:0};cache.set(key,entry);
    try{const line=await result;if(cache.get(key)!==entry)return line;entry.bytes=shapedLineBytes(line);cacheBytes+=entry.bytes;
      while(cache.size&&(cache.size>128||cacheBytes>1024*1024)){const first=cache.keys().next().value!;cacheBytes-=cache.get(first)!.bytes;cache.delete(first);}
      return line;
    }catch(error){if(cache.get(key)===entry)cache.delete(key);throw error;}
  }
  async function shapeLine(range: TextRangeV1, trimEnd: boolean, outline: boolean): Promise<ShapedTextLine> {
    const levels = textLineLevels(bidi, { start: semantic.forward.get(range.start)!, end: semantic.forward.get(range.end)! });
    const local = atoms.slice(atomIndex.get(range.start),atomIndex.get(range.end));
    let visibleEnd = range.end;
    if (trimEnd) for (let i = local.length - 1; i >= 0 && /^[ \t\u200b]*$/u.test(inlineByOffset.get(local[i]!.start)?.originalText??story.source.slice(local[i]!.start, local[i]!.end)); i--) visibleEnd = local[i]!.start;
    type Segment = Atom & { level: number; key: string };
    const segments: Segment[] = [];
    let levelIndex = 0;
    for (const atom of local) {
      while (levels[levelIndex] && levels[levelIndex]!.end <= semantic.forward.get(atom.start)!) levelIndex++;
      const level = levels[levelIndex]?.level ?? bidi.base, hidden = atom.hidden || atom.start >= visibleEnd;
      const key = JSON.stringify([atom.style, atom.font.id, atom.script, level, hidden]);
      const previous = segments.at(-1);
      if (!atom.tab && !previous?.tab && !atom.artwork && !previous?.artwork && previous?.key === key && !hidden) previous.end = atom.end;
      else segments.push({ ...atom, hidden, level, key });
    }
    const pieces: TextParagraphPiece[] = []; let pen = 0, ascent = 0, descent = 0;
    for (const segment of reorderTextRuns(segments)) {
      const { start, end, style, font, script, level } = segment, size = style.size ?? 16, shift = style.baselineShift ?? 0;
      let shaped: TextShapedRunV1 | undefined, advance = 0, above = size * .8, below = size * .2;
      if (segment.artwork&&!segment.hidden) { advance = segment.artwork.width; above = segment.artwork.ascent; below = segment.artwork.descent; }
      else if (!segment.hidden&&!segment.tab) {
        const info = metadata.get(font.id)!, axes = { ...style.axes };
        if (style.weight !== undefined && info.axes.wght && axes.wght === undefined) axes.wght = style.weight;
        if (style.italic && info.axes.ital && axes.ital === undefined) axes.ital = 1;
        const literal=story.source.slice(start,end),display=textDisplaySource(literal,style.case,settings.language);
        if(style.case==='small-caps'&&!info.features.includes('smcp'))throw new TextSourceError('font-feature','This font does not support small capitals.');
        shaped = await services.shapeRun({ outline, font, text: display.text, start, direction: level % 2 ? 'rtl' : 'ltr', script,
          language: settings.language ?? 'und', size, tracking: style.tracking, axes, features: style.case==='small-caps'?{...style.features,smcp:1}:style.features,
          context: { before: textDisplaySource(story.source.slice(range.start,start),style.case,settings.language).text, after: textDisplaySource(story.source.slice(end,visibleEnd),style.case,settings.language).text } });
        if(display.text!==literal)shaped=mapTextDisplayRun(shaped,literal,start,display);
        if (shaped.missing.length) throw new TextSourceError('font-glyph', `The pinned font could not shape text at source offset ${shaped.missing[0]!.start}.`);
        advance = shaped.advance; above = shaped.ascent; below = shaped.descent;
      }
      const carets = shaped ? shaped.clusters.flatMap(cluster => cluster.carets.map(caret => ({ offset: caret.offset, x: round(pen + caret.x) })))
        : [{ offset: start, x: round(pen + (level % 2 ? advance : 0)) }, { offset: end, x: round(pen + (level % 2 ? 0 : advance)) }];
      pieces.push({ start, end, x: round(pen), advance, ascent: above, descent: below, style, level, shape: shaped, artwork: segment.hidden?undefined:segment.artwork, tab:segment.tab?{}:undefined, carets });
      pen += advance; ascent = Math.max(ascent, above + shift); descent = Math.max(descent, below - shift);
    }
    if(pieces.some(piece=>piece.tab)){
      pen=positionTextTabs(pieces,settings,story.source,bidi.base?'rtl':'ltr');
      for(const piece of pieces)if(piece.tab?.leader){const atom=atoms.find(atom=>atom.start===piece.start)!;const shape=await services.shapeRun({font:atom.font,text:piece.tab.leader,start:piece.start,direction:bidi.base?'rtl':'ltr',script:'Zyyy',language:settings.language??'und',size:piece.style.size??16,axes:piece.style.axes,features:piece.style.features});if(shape.missing.length)throw new TextSourceError('font-glyph','This font cannot draw the selected tab leader.');piece.tab.shape=shape;}
    }
    if (!pieces.length) {
      const size = defaultCharacter.size ?? 16;
      const metrics = await services.shapeRun({ font: fonts.get(defaultCharacter.font!)!, text: '', start: range.start, direction: bidi.base ? 'rtl' : 'ltr', script: 'Zyyy', language: settings.language ?? 'und', size, axes: defaultCharacter.axes });
      ascent = metrics.ascent; descent = metrics.descent;
    }
    return spaceTextLine({ ...range, pieces, advance: round(pen), ascent: round(ascent), descent: round(descent), direction: bidi.base ? 'rtl' : 'ltr' }, story.source, settings.wordSpacing?.ideal ?? 1);
  }
  const hyphens = new Map<number, Promise<{ shape: TextShapedRunV1; color: string }>>();
  async function hyphen(at: number) {
    let value = hyphens.get(at);
    if (!value) {
      const atom = atoms.findLast(atom => atom.start < at && !atom.hidden && !atom.artwork) ?? atoms[0];
      const style = atom?.style ?? defaultCharacter, font = atom?.font ?? fonts.get(style.font!)!, info = metadata.get(font.id)!;
      const axes = { ...style.axes }; if (style.weight !== undefined && info.axes.wght && axes.wght === undefined) axes.wght = style.weight;
      value = services.shapeRun({ font, text: covers(info, '\u2010') ? '\u2010' : '-', start: at, direction: bidi.base ? 'rtl' : 'ltr', script: atom?.script ?? 'Latn', language: settings.language ?? 'und', size: style.size ?? 16, axes, features: style.features })
        .then(shape => { if (shape.missing.length) throw new TextSourceError('font-glyph', 'This font cannot draw a discretionary hyphen.'); return { shape, color: style.color ?? '#000000' }; });
      hyphens.set(at, value);
    }
    return value;
  }
  const orderedFonts = queue.map(id => metadata.get(id)!);
  return { settings, shape, hyphen, direction:(bidi.base?'rtl':'ltr') as 'rtl'|'ltr', resources: orderedFonts.map(info => ({ id: info.resource.id, sha256: info.resource.sha256 })),
    shaper: [...new Set(orderedFonts.map(info => info.shaper))].join(', '), atoms };
}
