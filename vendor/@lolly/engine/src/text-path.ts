// SPDX-License-Identifier: MPL-2.0
/** Shaped clusters follow one authored guide without reversing or rewriting their source. */
import type { TextFrameV1, TextLayoutV1, TextStoryV1, TextShapedRunV1, TextLayoutLineV1 } from '@lolly-tools/core';
import { emojiTextPath } from './emoji-text-path.ts';
import { parseSvgPath } from './svg-path.ts';
import { textFrameKey } from './text-frame.ts';
import { textLineMetrics } from './text-flow.ts';
import { transformTextPath, spaceTextLine, textSpaceWidth } from './text-spacing.ts';
import { TextSourceError } from './text-source.ts';
import type { prepareTextParagraph } from './text-paragraph.ts';
type Prepared=Awaited<ReturnType<typeof prepareTextParagraph>>;
const radians=(degrees:number)=>degrees*Math.PI/180;
const point=(x:number,y:number,angle:number,dx:number,dy:number)=>({x:x+Math.cos(radians(angle))*dx-Math.sin(radians(angle))*dy,y:y+Math.sin(radians(angle))*dx+Math.cos(radians(angle))*dy});
export async function composePathText(story:TextStoryV1,frame:TextFrameV1,prepared:Prepared,result:TextLayoutV1):Promise<TextLayoutV1>{
  if(prepared.settings.dropCap?.enabled!==false&&prepared.settings.dropCap)throw new Error('Drop capitals need a rectangular text frame. Disable the drop capital or detach this text from its path.');
  if(story.source.includes('\t'))throw new Error('Tabs need a rectangular text frame. Replace the tab or detach this text from its path.');
  if(story.paragraphs.length!==1 || story.breaks.length)throw new TextSourceError('path-paragraph','Path text supports one paragraph without forced line breaks. Remove the breaks or detach it from the path.');
  const path=frame.path!,curve=emojiTextPath(path.d),closed=!!parseSvgPath(path.d)[0]?.closed;
  if(path.start>=curve.length || path.end> (closed?path.start+curve.length:curve.length)+.001)throw new TextSourceError('path-interval','Choose an interval within the guide, with at most one traversal of a closed path.');
  const end=Math.min(path.end,closed?path.start+curve.length:curve.length),available=end-path.start;
  let shaped=await prepared.shape(story.paragraphs[0]!,false),scale=1,consumed=story.source.length;
  if(path.fit && shaped.advance>0){scale=available/shaped.advance;if(scale<.01 || scale>100)throw new TextSourceError('path-fit','This fit would change the text size by more than the supported range. Resize the guide or change the font size.');}
  else if(shaped.advance>available+.001){
    const boundaries=[0,...new Set(shaped.pieces.flatMap(piece=>piece.shape?piece.shape.clusters.map(cluster=>cluster.end):[piece.end]))].sort((a,b)=>a-b);
    let low=0,high=boundaries.length-1;
    while(low<high){const mid=Math.ceil((low+high)/2),trial=await prepared.shape({start:0,end:boundaries[mid]!},false);if(trial.advance<=available+.001)low=mid;else high=mid-1;}
    consumed=boundaries[low]!;shaped=await prepared.shape({start:0,end:consumed},false);result.overset={start:consumed,end:story.source.length};
  }
  const align=prepared.settings.lastAlign??(prepared.settings.align==='justify'?'start':prepared.settings.align)??'start';
  let spacingFailure=false;
  if(align==='justify'&&!path.fit){
    const spaces=textSpaceWidth(shaped,story.source),spacing=prepared.settings.wordSpacing??{min:.8,ideal:1,max:1.5};
    const desired=spaces?1+(available-shaped.advance)/spaces:1;
    shaped=spaceTextLine(shaped,story.source,Math.max(spacing.min/(spacing.ideal||1),Math.min(spacing.max/(spacing.ideal||1),desired)));
    spacingFailure=Math.abs(shaped.advance-available)>.01;
  }
  if(shaped.pieces.some(piece=>piece.advance<0||piece.shape?.clusters.some(cluster=>cluster.advance<0)))throw new TextSourceError('path-tracking','This tracking reverses a shaped cluster. Increase tracking before placing the text on a path.');
  const metrics=textLineMetrics(shaped,prepared.settings),height=metrics.height*scale,above=metrics.above*scale;
  const space=available-shaped.advance*scale;
  const anchor=path.start+(align==='center'?space/2:(align==='end')!==(shaped.direction==='rtl')?space:0);
  const sample=(distance:number)=>{
    let d=path.flip?path.start+end-distance:distance;d=path.reverse?curve.length-d:d;
    if(closed)d=((d%curve.length)+curve.length)%curve.length;
    const at=curve.at(d);return {...at,angle:at.angle+(path.reverse?180:0)+(path.flip?180:0)};
  };
  const pose=(x:number,width:number,shift=0)=>{
    const at=sample(anchor+(x+width/2)*scale),origin=point(at.x,at.y,at.angle,-width*scale/2,path.baseline-shift*scale);
    return {...origin,angle:at.angle};
  };
  const line:TextLayoutLineV1={start:0,end:consumed,paragraphId:story.paragraphs[0]!.id,frameId:frame.id,column:0,x:0,y:0,baseline:above,width:shaped.advance*scale,height,direction:shaped.direction,path:true,runs:[],inlines:[],carets:[]};
  const order=new Map<TextLayoutLineV1['carets'][number],number>();
  const caret=(offset:number,x:number,origin:ReturnType<typeof pose>,affinity:'upstream'|'downstream',distance=0)=>{
    const at=point(origin.x,origin.y,origin.angle,x,-above),stop={offset,affinity,...at,height,angle:origin.angle};line.carets.push(stop);order.set(stop,distance+x);
  };
  let tight=false;
  for(const piece of shaped.pieces){
    if(piece.shape)for(const cluster of piece.shape.clusters){
      const x=piece.x+cluster.x,origin=pose(x,cluster.advance,piece.style.baselineShift??0),base=pose(x,cluster.advance);
      const transform={a:scale,b:0,c:0,d:scale,e:-cluster.x*scale,f:0};
      const shape:TextShapedRunV1={...piece.shape,start:cluster.start,end:cluster.end,text:story.source.slice(cluster.start,cluster.end),size:piece.shape.size*scale,advance:cluster.advance*scale,ascent:piece.shape.ascent*scale,descent:piece.shape.descent*scale,lineGap:piece.shape.lineGap*scale,
        clusters:[{...cluster,x:0,advance:cluster.advance*scale,d:transformTextPath(cluster.d,transform),carets:cluster.carets.map(caret=>({...caret,x:(caret.x-cluster.x)*scale}))}]};
      line.runs.push({...origin,color:piece.style.color??'#000000',character:piece.style,shape});
      for(const stop of shape.clusters[0]!.carets)caret(stop.offset,stop.x,base,stop.offset===cluster.end?'upstream':'downstream',x*scale);
      const a=sample(anchor+x*scale).angle,b=sample(anchor+(x+cluster.advance)*scale).angle;
      if(Math.abs(((b-a+540)%360)-180)>35)tight=true;
    }
    else{
      const origin=pose(piece.x,piece.advance),base=pose(piece.x,piece.advance,piece.style.baselineShift??0);
      for(const stop of piece.carets)caret(stop.offset,(stop.x-piece.x)*scale,origin,stop.offset===piece.end?'upstream':'downstream',piece.x*scale);
      if(piece.artwork){const at=point(base.x,base.y,base.angle,0,-piece.ascent*scale);line.inlines.push({offset:piece.start,...at,advance:piece.advance*scale,width:(piece.artwork.inkWidth??piece.advance)*scale,height:(piece.ascent+piece.descent)*scale,ascent:piece.ascent*scale,angle:base.angle,svg:piece.artwork.svg,overflow:piece.artwork.overflow,direction:piece.level%2?'rtl':'ltr',baselineShift:(piece.style.baselineShift??0)*scale});}
    }
  }
  if(!line.carets.length)caret(0,0,pose(0,0),'downstream');
  line.carets.sort((a,b)=>order.get(a)!-order.get(b)!||a.offset-b.offset);
  result.lines=[line];result.shaper=prepared.shaper;result.resources=[...prepared.resources];
  for(const piece of shaped.pieces)if(piece.artwork&&!result.resources.some(item=>item.id===piece.artwork!.id))result.resources.push({id:piece.artwork.id,sha256:piece.artwork.sha256});
  result.frames=[{id:frame.id,start:0,end:consumed,columnEnds:[consumed],width:frame.width,height:frame.height,geometryKey:textFrameKey(frame),appliedScale:scale,...(path.guide?{guide:path.d}:{})}];
  const notice=(code:string,severity:'info'|'warning'|'error',message:string)=>result.diagnostics.push({code,severity,storyId:story.id,frameId:frame.id,start:0,end:story.source.length,message});
  if(result.overset)result.diagnostics.push({...result.overset,code:'overset',severity:'error',storyId:story.id,frameId:frame.id,message:'Text continues beyond the path endpoint. Extend the interval, change its size, or choose Fit to path.'});
  if(tight)notice('path-tight','warning','The guide turns sharply within a shaped cluster. Soften the curve or reduce the text size.');
  if(spacingFailure)notice('word-spacing','warning','This line cannot reach both endpoints within the chosen word-spacing limits.');
  if(frame.hidden)notice('frame-hidden','info','This hidden frame still owns its place in the story.');
  if(frame.locked)notice('frame-locked','info','This locked frame still owns its place in the story.');
  if(path.fit && Math.abs(scale-1)>.001)notice('path-fit','info',`Fit to path applies ${Math.round(scale*1000)/10}% of the authored text size.`);
  return result;
}
