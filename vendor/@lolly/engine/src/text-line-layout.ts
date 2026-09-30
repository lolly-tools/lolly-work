// SPDX-License-Identifier: MPL-2.0
/** Shared settled glyph, inline and caret placement for a rectangular line. */
import type { TextLayoutLineV1, TextParagraphStyleV1 } from '@lolly-tools/core';
import type { ShapedTextLine } from './text-paragraph.ts';
import type { TextFlowPlacement, TextFlowSlot } from './text-flow.ts';
import { spaceTextLine, textSpaceWidth } from './text-spacing.ts';
export function positionTextLine(source: string, paragraphId: string, original: ShapedTextLine, index: number, last: boolean, settings: TextParagraphStyleV1, slot: TextFlowSlot, position: TextFlowPlacement) {
  let shaped = original;
  const startIndent = (settings.indentStart ?? 0)+(index ? 0 : settings.firstIndent ?? 0), endIndent = settings.indentEnd ?? 0;
  const available = slot.width-startIndent-endIndent;
  const align = last ? settings.lastAlign ?? (settings.align === 'justify' ? 'start' : settings.align) ?? 'start' : settings.align ?? 'start';
  let spacingFailure = false;
  if (align === 'justify' && slot.frame.mode !== 'auto-width') {
    const spaces = textSpaceWidth(shaped, source), spacing = settings.wordSpacing ?? { min: .8, ideal: 1, max: 1.5 };
    const desired = spaces ? 1+(available-shaped.advance)/spaces : 1;
    shaped = spaceTextLine(shaped,source,Math.max(spacing.min/(spacing.ideal || 1),Math.min(spacing.max/(spacing.ideal || 1),desired)));
    spacingFailure = Math.abs(shaped.advance-available) > .01;
  }
  const left = slot.left+(shaped.direction === 'rtl' ? endIndent : startIndent), room = slot.frame.mode === 'auto-width' ? shaped.advance : available;
  const alignment = align === 'center' ? (room-shaped.advance)/2 : (align === 'end') !== (shaped.direction === 'rtl') ? room-shaped.advance : 0;
  let optical=0;
  if(settings.opticalMargin&&align!=='center'){
    const edge=align==='end'?shaped.pieces.at(-1):shaped.pieces[0],cluster=align==='end'?edge?.shape?.clusters.at(-1):edge?.shape?.clusters[0];
    if(cluster&&/^[.,;:!?“”‘’"'«»‹›،。、「」]+$/u.test(source.slice(cluster.start,cluster.end)))optical=(align==='end'?1:-1)*Math.min(cluster.advance/2,(edge!.style.size??16)/3);
  }
  const x = left+alignment+optical, baseline = position.y+position.above;
  const line: TextLayoutLineV1 = { start: shaped.start, end: shaped.end, paragraphId, frameId: slot.frame.id, column: slot.column,
    x,y:position.y,baseline,width:shaped.advance,height:position.height,direction:shaped.direction,runs:[],inlines:[],carets:[] };
  const textX = x+(shaped.direction === 'rtl' ? shaped.hyphen?.shape.advance ?? 0 : 0);
  if (shaped.hyphen) line.hyphen = { ...shaped.hyphen, x:shaped.direction === 'rtl' ? x : x+shaped.advance-shaped.hyphen.shape.advance, y:baseline };
  for (const piece of shaped.pieces) {
    const y = baseline-(piece.style.baselineShift ?? 0);
    if(piece.tab?.shape){const shape=piece.tab.shape,step=shape.advance;if(step>0){const count=Math.min(1024,Math.floor(piece.advance/step));if(count){line.leaders??=[];line.leaders.push({x:textX+piece.x+(piece.advance-count*step)/2,y,shape,count,step,color:piece.style.color??'#000000'});}}}
    if (piece.shape) line.runs.push({ x:textX+piece.x,y,angle:0,color:piece.style.color ?? '#000000',character:piece.style,shape:piece.shape });
    if (piece.artwork) line.inlines.push({ offset:piece.start,x:textX+piece.x,y:y-piece.ascent,advance:piece.advance,width:piece.artwork.inkWidth ?? piece.advance,height:piece.ascent+piece.descent,angle:0,svg:piece.artwork.svg,overflow:piece.artwork.overflow,direction:piece.level%2?'rtl':'ltr',ascent:piece.ascent,baselineShift:piece.style.baselineShift??0 });
    for (const caret of piece.carets) if (!line.carets.some(item => item.offset === caret.offset && Math.abs(item.x-textX-caret.x) < .0001))
      line.carets.push({ offset:caret.offset,affinity:caret.offset === piece.end ? 'upstream' : 'downstream',x:textX+caret.x,y:position.y,height:position.height,angle:0 });
  }
  for(const [rule,enabled,at] of [[settings.ruleBefore,index===0,position.y],[settings.ruleAfter,last,position.y+position.height]] as const)if(rule&&rule.enabled!==false&&enabled){line.rules??=[];line.rules.push({x:left,y:at+(enabled&&rule===settings.ruleBefore?-rule.offset-rule.width:rule.offset),width:slot.frame.mode==='auto-width'?shaped.advance:available,height:rule.width,color:rule.color});}
  if (!line.carets.length) line.carets.push({ offset:shaped.start,affinity:'downstream',x,y:position.y,height:position.height,angle:0 });
  line.carets.sort((a,b) => a.x-b.x || a.offset-b.offset);
  return { line, spacingFailure, widthFailure: shaped.advance > available+.001, measuredWidth: shaped.advance+startIndent+endIndent };
}
export function shiftTextLine(line: TextLayoutLineV1, y: number): void {
  line.y += y; line.baseline += y;
  for (const run of line.runs) run.y += y;
  for (const inline of line.inlines) inline.y += y;
  for (const caret of line.carets) caret.y += y;
  if (line.hyphen) line.hyphen.y += y;
  for(const item of [...line.leaders??[],...line.rules??[]])item.y+=y;
}
