// SPDX-License-Identifier: MPL-2.0
/** A drop capital occupies an explicit exclusion beside the first paragraph lines. */
import type { TextParagraphV1, TextStoryV1, TextLayoutLineV1 } from '@lolly-tools/core';
import { emojiGraphemes } from './emoji-segment.ts';
import { TextSourceError } from './text-source.ts';
import { pathBounds,pathFromSubPaths } from './geom/path.ts';
import { parseSvgPath } from './svg-path.ts';
import { transformTextPath } from './text-spacing.ts';
import type { prepareTextParagraph } from './text-paragraph.ts';
export async function prepareTextDropCap(story:TextStoryV1,paragraph:TextParagraphV1,prepared:Awaited<ReturnType<typeof prepareTextParagraph>>){
  const setting=prepared.settings.dropCap;if(!setting||setting.enabled===false||paragraph.start===paragraph.end)return null;
  const clusters=emojiGraphemes(story.source.slice(paragraph.start,paragraph.end)),end=paragraph.start+(clusters[setting.characters-1]?.end??clusters.at(-1)!.end);
  if(/\s|[\ufffc\u2028\u2029]/u.test(story.source.slice(paragraph.start,end)))throw new TextSourceError('drop-cap-source','Select visible letters before the first space or line break for a drop capital.');
  const full=await prepared.shape(paragraph,false,false);
  if(full.pieces.some(piece=>piece.artwork&&piece.start<end)||full.pieces.flatMap(piece=>piece.shape?.clusters??[]).some(cluster=>cluster.start<end&&cluster.end>end))throw new TextSourceError('drop-cap-cluster','Choose complete shaped letters for the drop capital; inline artwork is not supported.');
  const cap=await prepared.shape({start:paragraph.start,end},false),d=cap.pieces.flatMap(piece=>piece.shape?.clusters.map(cluster=>transformTextPath(cluster.d,{a:1,b:0,c:0,d:1,e:piece.x,f:-(piece.style.baselineShift??0)}))??[]).join('');
  const bounds=pathBounds(pathFromSubPaths(parseSvgPath(d)));if(!bounds||bounds.y1<=bounds.y0)throw new TextSourceError('drop-cap-empty','Start this paragraph with a visible letter before enabling a drop capital.');
  const size=prepared.settings.character?.size??cap.pieces[0]?.style.size??16,lineHeight=Math.max(size*(prepared.settings.lineHeight??1.2),full.ascent+full.descent),height=lineHeight*setting.lines,scale=height/(bounds.y1-bounds.y0),width=(bounds.x1-bounds.x0)*scale;
  if(scale>100||height>100000)throw new TextSourceError('drop-cap-size','The requested drop capital exceeds the supported size.');
  const shape=prepared.shape;
  const ordinary={...prepared,shape:async(range:import('@lolly-tools/core').TextRangeV1,trim=true,outline=true)=>{
    if(range.start>=end)return shape(range,trim,outline);
    const line=await shape({start:Math.max(range.start,end),end:Math.max(end,range.end)},trim,outline);
    return {...line,start:range.start,pieces:[{start:range.start,end,x:0,advance:0,ascent:size*.8,descent:size*.2,style:cap.pieces[0]!.style,level:cap.direction==='rtl'?1:0,carets:[]},...line.pieces]};
  },settings:{...prepared.settings,keep:{startLines:Math.max(setting.lines,prepared.settings.keep?.startLines??1),endLines:prepared.settings.keep?.endLines??1,together:prepared.settings.keep?.together??false,nextLines:prepared.settings.keep?.nextLines??0}}};
  return {prepared:ordinary,end,width:width+setting.gap,lines:setting.lines,height,paint(line:TextLayoutLineV1,left:number,right:number){
    line.dropCap = { start: paragraph.start, end };
    const x=cap.direction==='rtl'?right-width:left,y=line.y;
    for(const piece of cap.pieces)if(piece.shape){const shape={...piece.shape,size:piece.shape.size*scale,advance:piece.shape.advance*scale,ascent:piece.shape.ascent*scale,descent:piece.shape.descent*scale,lineGap:piece.shape.lineGap*scale,clusters:piece.shape.clusters.map(cluster=>({...cluster,x:cluster.x*scale,advance:cluster.advance*scale,d:transformTextPath(cluster.d,{a:scale,b:0,c:0,d:scale,e:0,f:0}),carets:cluster.carets.map(caret=>({...caret,x:caret.x*scale}))}))};
      const at=x+(piece.x-bounds.x0)*scale,baseline=y-bounds.y0*scale-(piece.style.baselineShift??0)*scale;line.runs.unshift({x:at,y:baseline,angle:0,color:piece.style.color??'#000000',character:{...piece.style,size:shape.size},shape});
      for(const cluster of shape.clusters)for(const caret of cluster.carets)line.carets.push({offset:caret.offset,affinity:caret.offset===cluster.end?'upstream':'downstream',x:at+caret.x,y,height,angle:0});
    }
    line.carets.sort((a,b)=>a.x-b.x||a.offset-b.offset);
  }};
}
