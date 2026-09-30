// SPDX-License-Identifier: MPL-2.0
/** Rectangular flow advances through the authored frame order, independent of paint order. */
import type { TextFrameV1, TextParagraphStyleV1 } from '@lolly-tools/core';
import { textWrapBand,type TextWrapExclusion } from './text-wrap.ts';
import type { ShapedTextLine } from './text-paragraph.ts';
export interface TextFlowSlot { frame: TextFrameV1; column: number; left: number; width: number; top: number; bottom: number;exclusions?:TextWrapExclusion[];direction?:'ltr'|'rtl' }
export interface TextFlowCursor { slot: number; y: number }
export interface TextFlowPlacement { slot: number; y: number; height: number; above: number;left?:number;width?:number }
export function textFlowSlots(frames: TextFrameV1[], direction: 'ltr' | 'rtl', finalHeight?: number,wrap?:Map<string,TextWrapExclusion[]>): TextFlowSlot[] {
  return frames.flatMap((frame, frameIndex) => {
    const width = (frame.width-frame.inset.left-frame.inset.right-(frame.columns.count-1)*frame.columns.gutter)/frame.columns.count;
    return Array.from({ length: frame.columns.count }, (_,column) => ({ frame, column,exclusions:wrap?.get(frame.id),direction,
      left: frame.inset.left + (direction === 'rtl' ? frame.columns.count-1-column : column)*(width+frame.columns.gutter),
      width: frame.mode === 'auto-width' ? 100000 : width, top: frame.inset.top,
      bottom: frame.mode === 'fixed' ? frame.inset.top + Math.min(frame.height-frame.inset.top-frame.inset.bottom, frameIndex === frames.length-1 ? finalHeight ?? Infinity : Infinity) : Infinity }));
  });
}
export function textLineMetrics(line: ShapedTextLine, settings: TextParagraphStyleV1) {
  const size = Math.max(settings.character?.size ?? 16, ...line.pieces.map(piece => piece.style.size ?? 16));
  const height = Math.max(line.ascent+line.descent, size*(settings.lineHeight ?? 1.2));
  return { height, above: (height-line.ascent-line.descent)/2+line.ascent };
}
function positionLine(slot: TextFlowSlot, top: number, metrics: ReturnType<typeof textLineMetrics>, settings: TextParagraphStyleV1, first = false): number {
  if (first && slot.frame.firstBaseline !== undefined) top = Math.max(top, slot.top+slot.frame.firstBaseline-metrics.above);
  if (settings.baselineGrid && slot.frame.grid) top += ((slot.frame.grid.offset-top-metrics.above)%slot.frame.grid.step+slot.frame.grid.step)%slot.frame.grid.step;
  return top;
}
/** Keeps move text only to a real available column. Impossible rules are diagnosed. */
export function placeTextLines(lines: ShapedTextLine[], settings: TextParagraphStyleV1, start: TextFlowCursor, slots: TextFlowSlot[], next?: { lines: ShapedTextLine[]; settings: TextParagraphStyleV1 }) {
  const positions: TextFlowPlacement[] = [], metrics = lines.map(line => textLineMetrics(line, settings));
  let cursor = { ...start }, index = 0, impossible = false;
  const keep = settings.keep ?? { startLines: 1, endLines: 1, together: false, nextLines: 0 };
  const fit = (slotIndex: number, from: number, y: number): TextFlowPlacement[] => {
    const slot = slots[slotIndex]!, result: TextFlowPlacement[] = [];
    const first = y <= slot.top+.0001;
    y += from === 0 ? settings.spaceBefore ?? 0 : 0;
    for (let i = from; i < lines.length; i++) {
      const line = metrics[i]!; y = positionLine(slot, y, line, settings, first && i === from);
      let band=textWrapBand(slot.exclusions,slot.left,slot.width,y,line.height,slot.direction??'ltr'),attempt=0;
      while(band.width<.01&&Number.isFinite(band.next)&&attempt++<256){y=positionLine(slot,Math.max(y+.001,band.next+.001),line,settings);band=textWrapBand(slot.exclusions,slot.left,slot.width,y,line.height,slot.direction??'ltr');}
      if (y+line.height > slot.bottom+.0001||band.width<.01) break;
      result.push({ slot: slotIndex, y, ...line,left:band.left,width:band.width }); y += line.height;
    }
    return result;
  };
  while (index < lines.length && cursor.slot < slots.length) {
    const slot = slots[cursor.slot]!, fitted = fit(cursor.slot, index, cursor.y);
    let take = fitted.length;
    if (!take) { cursor = { slot: cursor.slot+1, y: slots[cursor.slot+1]?.top ?? 0 }; continue; }
    const remaining = lines.length-index, atTop = cursor.y <= slot.top+.0001;
    if (take < remaining) {
      const needsStart = index === 0 && take < keep.startLines;
      const needsWhole = keep.together && index === 0;
      if (needsStart || needsWhole) {
        const later = slots.findIndex((candidate, at) => at > cursor.slot && fit(at, index, candidate.top).length >= (needsWhole ? remaining : Math.min(remaining,keep.startLines)));
        if (later >= 0) { cursor = { slot: later, y: slots[later]!.top }; continue; }
        if (!atTop && cursor.slot+1 < slots.length) { cursor = { slot: cursor.slot+1, y: slots[cursor.slot+1]!.top }; continue; }
        impossible = true;
      }
      if (remaining-take < keep.endLines) {
        const reduced = remaining-keep.endLines;
        if (reduced >= (index === 0 ? Math.max(1,keep.startLines) : 1)) take = reduced;
        else if (!atTop && cursor.slot+1 < slots.length) { cursor = { slot: cursor.slot+1, y: slots[cursor.slot+1]!.top }; continue; }
        else impossible = true;
      }
    } else if (keep.nextLines && next?.lines.length) {
      let y = fitted.at(-1)!.y+fitted.at(-1)!.height+(settings.spaceAfter ?? 0)+(next.settings.spaceBefore ?? 0);
      for (const line of next.lines.slice(0,keep.nextLines)) {
        const metrics = textLineMetrics(line,next.settings); y = positionLine(slot,y,metrics,next.settings)+metrics.height;
      }
      if (y > slot.bottom+.0001) {
        if (take > 1 && !keep.together) take--;
        else if (!atTop && cursor.slot+1 < slots.length) { cursor = { slot: cursor.slot+1, y: slots[cursor.slot+1]!.top }; continue; }
        else impossible = true;
      }
    }
    positions.push(...fitted.slice(0,take)); index += take;
    const last = positions.at(-1)!; cursor = { slot: last.slot, y: last.y+last.height };
    if (index < lines.length) cursor = { slot: cursor.slot+1, y: slots[cursor.slot+1]?.top ?? 0 };
  }
  if (index === lines.length) cursor.y += settings.spaceAfter ?? 0;
  return { positions, cursor, complete: index === lines.length, impossible };
}
