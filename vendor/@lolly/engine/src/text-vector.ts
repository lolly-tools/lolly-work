// SPDX-License-Identifier: MPL-2.0
/** Conversion consumes settled output, including its decorations, artwork and path poses. */
import type { TextLayoutV1, TextStoryV1 } from '@lolly-tools/core';
import { textLayoutSvg } from './text-layout-svg.ts';
import { importVectorPaint } from './vector-paint-import.ts';
import { admitTextInlineSvg, type EmojiXmlParser } from './emoji-svg.ts';
import { escapeXml } from './xml-escape.ts';
export type TextVectorScope='all'|'text'|'emoji';
/** Replace nested SVG viewports with equivalent explicit clipping and transforms. */
export function flattenTextVectorSvg(source:string,parseXml:EmojiXmlParser):string{
  const doc=parseXml(source),root=doc.documentElement;let serial=0;
  function emit(element:Element,outer=false):string{
    const tag=element.localName;if(tag==='title'||tag==='path'&&!element.getAttribute('d')?.trim())return '';
    const attrs=Object.fromEntries(Array.from(element.attributes).filter(attr=>!attr.name.startsWith('data-')&&attr.name!=='role').map(attr=>[attr.name,attr.value]));
    const children=Array.from(element.children).map(child=>emit(child)).join('');
    if(tag==='svg'&&!outer){
      const view=(attrs.viewBox??'').split(/[\s,]+/).map(Number),width=Number(attrs.width??view[2]),height=Number(attrs.height??view[3]);
      if(view.length!==4||![width,height,view[2],view[3]].every(value=>Number.isFinite(value)&&value!>0))throw new Error('This inline vector has no finite viewport.');
      const overflow=attrs.overflow==='visible';
      const scale=Math.min(width/view[2]!,height/view[3]!),x=(width-view[2]!*scale)/2-view[0]!*scale,y=(height-view[3]!*scale)/2-view[1]!*scale,id=`inline-viewport-${serial++}`;
      for(const key of ['xmlns','viewBox','width','height','preserveAspectRatio','overflow'])delete attrs[key];
      const presentation=Object.entries(attrs).map(([name,value])=>` ${name}="${escapeXml(value)}"`).join('');
      if(overflow)return `<g${presentation}><g transform="translate(${x} ${y}) scale(${scale})">${children}</g></g>`;
      return `<g${presentation}><defs><clipPath id="${id}"><rect width="${width}" height="${height}"/></clipPath></defs><g clip-path="url(#${id})"><g transform="translate(${x} ${y}) scale(${scale})">${children}</g></g></g>`;
    }
    delete attrs.overflow;
    return `<${tag}${Object.entries(attrs).map(([name,value])=>` ${name}="${escapeXml(value)}"`).join('')}>${children}</${tag}>`;
  }
  return admitTextInlineSvg(emit(root,true),parseXml,'converted');
}
export async function textFrameVectors(layout:TextLayoutV1,story:TextStoryV1,frameId:string,parseXml:EmojiXmlParser,scope:TextVectorScope='all'){
  const selected=structuredClone(layout);
  for(const line of selected.lines){if(scope==='emoji'){line.runs=[];delete line.hyphen;delete line.rules;delete line.leaders;}if(scope==='text')line.inlines=[];}
  if(scope==='emoji')for(const frame of selected.frames)delete frame.guide;
  const svg=flattenTextVectorSvg(await textLayoutSvg(selected,story,frameId,parseXml),parseXml),vector=importVectorPaint(svg,parseXml);
  const frame=layout.frames.find(frame=>frame.id===frameId)!;
  return {...vector,frameId,start:frame.start,end:frame.end,label:story.source.slice(frame.start,frame.end),resources:structuredClone(layout.resources),emojiSources:(layout.emojiSources??[]).filter(source=>source.occurrences.some(range=>range.start>=frame.start&&range.end<=frame.end))};
}

/** Freeze selected shaped clusters as inline vectors, retaining their advance and source meaning. */
export async function textInlineVectors(layout:TextLayoutV1,story:TextStoryV1,range:import('@lolly-tools/core').TextRangeV1,parseXml:EmojiXmlParser,scope:TextVectorScope,fresh:()=>string){
  const {assertTextRange,TextSourceError}=await import('./text-source.ts');const {replaceStoryRange}=await import('./text-edits.ts');
  const {emojiGraphemes}=await import('./emoji-segment.ts');const {transformTextPath}=await import('./text-spacing.ts');
  assertTextRange(story.source,range);if(layout.storyId!==story.id||layout.revision!==story.revision)throw new TextSourceError('layout-stale','Finish text layout before converting this selection.');
  if(scope!=='emoji' && layout.lines.some(line=>line.dropCap && range.start<line.dropCap.end && range.end>line.dropCap.start))throw new TextSourceError('outline-drop-cap','Convert the whole text frame to preserve this drop capital and its surrounding lines.');
  const replacements:Array<{start:number;end:number;inline:import('@lolly-tools/core').TextInlineV1}>=[],graphemes=emojiGraphemes(story.source);
  function add(start:number,end:number,width:number,ascent:number,descent:number,body:string,overflow=false){
    if(end<=range.start||start>=range.end)return;
    if(start<range.start||end>range.end)throw new TextSourceError('outline-cluster','Select the complete shaped cluster before converting it to paths.');
    if(width<0||ascent+descent<=0)throw new TextSourceError('outline-metrics','This selection has unsupported inline vector metrics.');
    const svg=admitTextInlineSvg(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.max(.01,width)} ${ascent+descent}">${body}</svg>`,parseXml,'inline');
    replacements.push({start,end,inline:{id:fresh(),offset:0,label:story.source.slice(start,end),originalText:story.source.slice(start,end),svg,width,ascent,descent,emojiSources:(layout.emojiSources??[]).filter(source=>source.occurrences.some(range=>range.start>=start&&range.end<=end)).map(source=>({...source,occurrences:[{start:0,end:1}]})),...(overflow?{overflow:'visible' as const}:{})}});
  }
  for(const line of layout.lines){
    const scale=layout.frames.find(frame=>frame.id===line.frameId)?.appliedScale??1;
    if(scope!=='emoji')for(const run of line.runs)for(const cluster of run.shape.clusters){
      if(!cluster.d.trim()&&!/^[ \t\u00a0\u202f]+$/u.test(story.source.slice(cluster.start,cluster.end)))continue;
      const width=cluster.advance/scale,ascent=run.shape.ascent/scale,descent=run.shape.descent/scale,size=run.shape.size/scale;
      const path=transformTextPath(cluster.d,{a:1/scale,b:0,c:0,d:1/scale,e:-cluster.x/scale,f:ascent});
      const decoration=(y:number)=>`<rect x="0" y="${ascent+y}" width="${Math.max(0,width)}" height="${Math.max(.5,size/16)}"/>`;
      add(cluster.start,cluster.end,width,ascent,descent,`<g fill="${escapeXml(run.color)}">${path?`<path d="${escapeXml(path)}"/>`:``}${run.character.underline?decoration(size/10):''}${run.character.strike?decoration(-size*.3):''}</g>`,true);
    }
    if(scope!=='text')for(const inline of line.inlines){
      if(story.inlines.some(item=>item.offset===inline.offset))continue;
      const end=graphemes.find(item=>item.start===inline.offset)?.end;if(end===undefined)throw new TextSourceError('outline-cluster','The inline artwork has no complete source cluster.');
      const root=parseXml(admitTextInlineSvg(inline.svg,parseXml,'art')).documentElement,view=(root.getAttribute('viewBox')??'').split(/[\s,]+/).map(Number);
      const width=inline.advance/scale,height=inline.height/scale,inkWidth=inline.width/scale,fit=Math.min(inkWidth/view[2]!,height/view[3]!);
      const x=(inkWidth-view[2]!*fit)/2-view[0]!*fit,y=(height-view[3]!*fit)/2-view[1]!*fit;
      const svg=admitTextInlineSvg(inline.svg,parseXml,'art'),body=svg.replace(/^<svg[^>]*>/,'').replace(/<\/svg>$/,'');
      const attrs=Array.from(root.attributes).filter(attr=>!['xmlns','viewBox','width','height','preserveAspectRatio'].includes(attr.name)).map(attr=>` ${attr.name}="${escapeXml(attr.value)}"`).join('');
      add(inline.offset,end,width,(inline.ascent??inline.height*.8)/scale,(inline.height-(inline.ascent??inline.height*.8))/scale,`<g transform="translate(${x} ${y}) scale(${fit})"><g${attrs}>${body}</g></g>`);
    }
  }
  if(!replacements.length)throw new TextSourceError('outline-empty','The selection has no matching visible geometry to convert.');
  let next=story;
  for(const replacement of replacements.sort((a,b)=>b.start-a.start))next=replaceStoryRange(next,replacement,{source:'\ufffc',inlines:[replacement.inline]},{paragraphId:fresh}).story;
  return {story:next,count:replacements.length};
}
