// SPDX-License-Identifier: MPL-2.0
/** DOM-free authored text composition. Every consumer paints the same settled lines. */
import type { TextFrameV1, TextLayoutRequestV1, TextLayoutServicesV1, TextLayoutV1, TextStoryV1 } from '@lolly-tools/core';
import { parseTextFrame, textFrameKey } from './text-frame.ts';
import { sha256Hex } from './bytes.ts';
import { parseTextDocument } from './text-story-document.ts';
import { TextSourceError } from './text-source.ts';
import { TEXT_UNICODE_VERSION } from './text-unicode.ts';
import { prepareTextParagraph } from './text-paragraph.ts';
import { composeParagraphLines } from './text-lines.ts';
import { textFlowSlots, placeTextLines, type TextFlowCursor } from './text-flow.ts';
import { scaleTextStory } from './text-scale.ts';
import { textStyleResolver } from './text-styles.ts';
import { prepareTextWrap,type TextWrapExclusion } from './text-wrap.ts';
import { prepareTextDropCap } from './text-drop-cap.ts';
import { mergeEmojiSourceRecords } from './emoji-source-records.ts';
import type { TextCompositionCache,TextFlowCheckpoint } from './text-composition-cache.ts';
import { positionTextLine, shiftTextLine } from './text-line-layout.ts';
export const TEXT_LAYOUT_ALGORITHM = 'lolly-text-1';
type Prepared = Awaited<ReturnType<typeof prepareTextParagraph>>;
function admitFrames(story: TextStoryV1, requested: TextFrameV1[]): TextFrameV1[] {
  const map = new Map(requested.map(frame => [frame.id,parseTextFrame(frame)]));
  if (map.size !== requested.length || map.size !== story.frameIds.length || requested.some(frame => frame.storyId !== story.id) || story.frameIds.some(id => !map.has(id)))
    throw new TextSourceError('frame-owner', 'Text frames must agree with their authored story order.');
  const frames = story.frameIds.map(id => map.get(id)!);
  for (const frame of frames) {
    if(frame.shrink&&(frames.length!==1||frame.mode!=='fixed'))throw new TextSourceError('frame-shrink','Shrink to fit needs one standalone fixed text frame.');
    if (frame.mode === 'path' && (frames.length!==1 || frame.columns.count!==1)) throw new TextSourceError('frame-mode', 'Path text cannot join rectangular frames or columns.');
    if ((frames.length > 1 || frame.columns.count > 1) && frame.mode !== 'fixed') throw new TextSourceError('frame-mode', 'Linked frames and columns need fixed frame sizes.');
  }
  return frames;
}
function emptyLayout(story: TextStoryV1): TextLayoutV1 {
  return { version:1,algorithm:TEXT_LAYOUT_ALGORITHM,shaper:'',unicode:TEXT_UNICODE_VERSION,storyId:story.id,revision:story.revision,resources:[],lines:[],frames:[],overset:null,diagnostics:[],emojiSources:mergeEmojiSourceRecords(story.inlines.flatMap(inline=>(inline.emojiSources??[]).map(source=>({...source,occurrences:[{start:inline.offset,end:inline.offset+1}]})))) };
}
async function composeFrames(story: TextStoryV1, frames: TextFrameV1[], prepared: Prepared[], finalHeight?: number,wrap?:Map<string,TextWrapExclusion[]>,cache?:TextCompositionCache,keys:string[]=[]): Promise<TextLayoutV1> {
  const result = emptyLayout(story);
  const slots = textFlowSlots(frames,prepared[0]!.direction,finalHeight,wrap), ends = new Map<number,number>(), bottoms = new Map<number,number>(), widths = new Map<string,number>();
  let cursor: TextFlowCursor = { slot:0,y:slots[0]!.top }, consumed = 0, from=0;
  const signature=JSON.stringify([story.id,frames,finalHeight,[...wrap??[]]]),previous=cache?.previous();
  let checkpoints:TextFlowCheckpoint[]=[];
  if(previous?.signature===signature){
    while(from<keys.length&&from<previous.keys.length&&keys[from]===previous.keys[from])from++;
    if(from<keys.length&&from&&prepared[from-1]!.settings.keep?.nextLines)from--;
    const point=previous.checkpoints.findLast(item=>item.paragraph<from);
    if(point){
      from=point.paragraph+1;cursor={...point.cursor};consumed=point.consumed;
      result.lines=structuredClone(previous.layout.lines.slice(0,point.lines));result.diagnostics=structuredClone(previous.layout.diagnostics.slice(0,point.diagnostics));result.resources=structuredClone(previous.layout.resources.slice(0,point.resources));result.shaper=point.shaper;
      point.ends.forEach(([a,b])=>{ends.set(a,b);});point.bottoms.forEach(([a,b])=>{bottoms.set(a,b);});point.widths.forEach(([a,b])=>{widths.set(a,b);});checkpoints=previous.checkpoints.filter(item=>item.paragraph<from);
    }else from=0;
  }
  const resource = (item: { id:string;sha256:string }) => { if (!result.resources.some(resource => resource.id === item.id)) result.resources.push(item); };
  for (const [paragraphIndex, paragraph] of story.paragraphs.entries()) {
    if(paragraphIndex<from)continue;
    const original=prepared[paragraphIndex]!,drop=await prepareTextDropCap(story,paragraph,original),item=drop?.prepared??original,{settings}=item;
    item.resources.forEach(resource); result.shaper = item.shaper;
    if (cursor.slot >= slots.length) { result.overset = { start:consumed,end:story.source.length }; break; }
    const initialWidth = slots[cursor.slot]!.width;
    let schedule: number[] = [], settled = false;
    let composed: Awaited<ReturnType<typeof composeParagraphLines>> | undefined, flow: ReturnType<typeof placeTextLines> | undefined;
    const next = prepared[paragraphIndex+1];
    const following = next && settings.keep?.nextLines ? { settings:next.settings, lines:(await composeParagraphLines(story,story.paragraphs[paragraphIndex+1]!,next,() => initialWidth-(next.settings.indentStart ?? 0)-(next.settings.indentEnd ?? 0))).lines } : undefined;
    for (let attempt = 0; attempt < 12; attempt++) {
      const width = (line: number) => (schedule[line] ?? schedule.at(-1) ?? initialWidth)-(settings.indentStart ?? 0)-(settings.indentEnd ?? 0)-(line ? 0 : settings.firstIndent ?? 0)-(drop&&line<drop.lines?drop.width:0);
      composed = await composeParagraphLines(drop?{...story,spans:[...story.spans,{start:paragraph.start,end:drop.end,noBreak:true}]}:story,paragraph,item,width);
      flow = placeTextLines(composed.lines,settings,cursor,slots,following);
      const actual = flow.positions.map(position => position.width??slots[position.slot]!.width);
      if (actual.every((value,index) => Math.abs(value-(schedule[index] ?? schedule.at(-1) ?? initialWidth)) < .0001)) { settled = true; break; }
      schedule = actual;
    }
    if (!settled || !composed || !flow) throw new TextSourceError('flow-budget', 'Text could not settle across these frame widths. Make the widths more similar or split the paragraph.');
    composed.resources.forEach(resource);
    for (const notice of composed.diagnostics) result.diagnostics.push({ ...notice,storyId:story.id,frameId:slots[cursor.slot]!.frame.id,severity:'warning' });
    if (flow.impossible) result.diagnostics.push({ ...paragraph,code:'keep-impossible',severity:'warning',storyId:story.id,frameId:slots[cursor.slot]!.frame.id,message:'These columns cannot satisfy all paragraph keeps. Available text is shown; resize a frame or relax the keep settings.' });
    for (const [index, position] of flow.positions.entries()) {
      const baseSlot=slots[position.slot]!,slot={...baseSlot,left:position.left??baseSlot.left,width:position.width??baseSlot.width}, shaped = composed.lines[index]!;
      const inset=drop&&index<drop.lines?drop.width:0;
      const positioned = positionTextLine(story.source,paragraph.id,shaped,index,index === composed.lines.length-1,settings,{...slot,left:slot.left+(shaped.direction==='ltr'?inset:0),width:slot.width-inset},position);
      if(drop&&index===0){drop.paint(positioned.line,slot.left+(settings.indentStart??0)+(settings.firstIndent??0),slot.left+slot.width-(settings.indentStart??0)-(settings.firstIndent??0));if(position.y+drop.height>slot.bottom+.001)result.diagnostics.push({...paragraph,code:'drop-cap-height',severity:'error',storyId:story.id,frameId:slot.frame.id,message:'The drop capital is taller than this text column. Reduce its lines or enlarge the frame.'});}
      result.lines.push(positioned.line); consumed = shaped.end; ends.set(position.slot,consumed); bottoms.set(position.slot,Math.max(bottoms.get(position.slot)??0,position.y+position.height,drop&&index===0?position.y+drop.height:0));
      widths.set(slot.frame.id,Math.max(widths.get(slot.frame.id) ?? 0,positioned.measuredWidth+inset));
      if (positioned.spacingFailure) result.diagnostics.push({ start:shaped.start,end:shaped.end,code:'word-spacing',severity:'warning',storyId:story.id,frameId:slot.frame.id,message:'This line cannot reach both edges within the chosen word-spacing limits.' });
      if (positioned.widthFailure) result.diagnostics.push({ start:shaped.start,end:shaped.end,code:'line-width',severity:'error',storyId:story.id,frameId:slot.frame.id,message:'This unbroken text is wider than its text frame.' });
    }
    cursor = flow.cursor;
    if (!flow.complete) { result.overset = { start:consumed,end:story.source.length }; break; }
    const separator = story.breaks.find(item => item.kind === 'paragraph' && item.start === paragraph.end);
    if (separator) consumed = separator.start+separator.length;
    ends.set(cursor.slot,consumed); if(drop&&flow.positions[0]?.slot===cursor.slot)cursor.y=Math.max(cursor.y,flow.positions[0].y+drop.height+(settings.spaceAfter??0));bottoms.set(cursor.slot,Math.max(bottoms.get(cursor.slot)??0,cursor.y));
    if(checkpoints.length<128)checkpoints.push({paragraph:paragraphIndex,lines:result.lines.length,diagnostics:result.diagnostics.length,resources:result.resources.length,shaper:result.shaper,cursor:{...cursor},consumed,ends:[...ends],bottoms:[...bottoms],widths:[...widths]});
  }
  cache?.remember({signature,keys,layout:result,checkpoints});
  let offset = 0;
  for (const frame of frames) {
    const start = offset, columnEnds: number[] = [], frameSlots = slots.flatMap((slot,index) => slot.frame.id === frame.id ? [index] : []);
    for (const index of frameSlots) {
      offset = ends.get(index) ?? offset; columnEnds.push(offset);
      const slot = slots[index]!, bottom = bottoms.get(index) ?? slot.top;
      if (frame.mode === 'fixed' && frame.verticalAlign !== 'top') {
        const slack = Math.max(0,slot.bottom-bottom);
        let shift = frame.verticalAlign === 'center' ? slack/2 : slack;
        const lines = result.lines.filter(line => line.frameId === frame.id && line.column === slot.column);
        if (frame.grid && lines.some(line => prepared[story.paragraphs.findIndex(paragraph => paragraph.id === line.paragraphId)]!.settings.baselineGrid)) shift = Math.floor(shift/frame.grid.step)*frame.grid.step;
        for (const line of lines) shiftTextLine(line,shift);
      }
    }
    const bottom = Math.max(frame.inset.top,...frameSlots.map(index => bottoms.get(index) ?? frame.inset.top));
    result.frames.push({ id:frame.id,start,end:offset,geometryKey:textFrameKey(frame),clip:frame.mode==='fixed',width:frame.mode === 'auto-width' ? Math.max(1,(widths.get(frame.id) ?? 0)+frame.inset.left+frame.inset.right) : frame.width,
      height:frame.mode === 'auto-height' || frame.mode === 'auto-width' ? bottom+frame.inset.bottom : frame.height,columnEnds });
    if (frame.hidden || frame.locked) result.diagnostics.push({ start,end:offset,code:frame.hidden ? 'frame-hidden' : 'frame-locked',severity:'info',storyId:story.id,frameId:frame.id,message:frame.hidden ? 'This hidden frame still owns its place in the story.' : 'This locked frame still owns its place in the story.' });
  }
  if (result.overset) result.diagnostics.push({ ...result.overset,code:'overset',severity:'error',storyId:story.id,frameId:frames.at(-1)!.id,message:'Text continues beyond the last frame.' });
  return result;
}
/** A failed resource never yields an apparently settled partial story. */
export async function composeText(request: TextLayoutRequestV1, services: TextLayoutServicesV1, cache?:TextCompositionCache): Promise<TextLayoutV1> {
  const doc = parseTextDocument(request.document), story = doc.stories.find(story => story.id === request.storyId);
  if (!story) throw new TextSourceError('story-missing','The requested text story is missing.');
  const frames = admitFrames(story,request.frames);
  if (!frames.length) {
    const result = emptyLayout(story); result.overset = { start:0,end:story.source.length };
    result.diagnostics.push({ ...result.overset,code:'story-unplaced',severity:'error',storyId:story.id,message:'This story has no text frame. Place it to recover its text.' }); return result;
  }
  // A single paragraph has no settled prefix to retain between source edits.
  const workspace = story.paragraphs.length > 1 ? cache : undefined;
  const prepared: Prepared[] = [],keys:string[]=[];
  for (const paragraph of story.paragraphs) {
    if(workspace){const value=await workspace.prepare(doc,story,paragraph,services,request.artwork);prepared.push(value.prepared);keys.push(value.key);}
    else prepared.push(await prepareTextParagraph(doc,story,paragraph,services,request.artwork));
  }
  if(frames[0]!.mode==='path'){const {composePathText}=await import('./text-path.ts');const result=await composePathText(story,frames[0]!,prepared[0]!,emptyLayout(story));result.documentHash=await sha256Hex(new TextEncoder().encode(JSON.stringify(doc)));return result;}
  const wrap=prepareTextWrap(request.wrap,frames);
  let result = await composeFrames(story,frames,prepared,undefined,wrap,workspace,keys);
  const last = frames.at(-1)!;
  if (!result.overset && last.columns.balance && last.columns.count > 1) {
    let low = 0, high = last.height-last.inset.top-last.inset.bottom;
    for (let attempt = 0; attempt < 16 && high-low > .01; attempt++) {
      const height = (low+high)/2, trial = await composeFrames(story,frames,prepared,height,wrap);
      if (trial.overset || trial.diagnostics.some(item => item.code === 'keep-impossible') && !result.diagnostics.some(item => item.code === 'keep-impossible')) low = height;
      else { high = height; result = trial; }
    }
  }
  const shrink=frames[0]!.shrink;
  if(shrink&&(result.overset||result.diagnostics.some(notice=>notice.code==='line-width'))){
    const resolver=textStyleResolver(doc),sizes=story.paragraphs.flatMap(paragraph=>[paragraph.start,...story.spans.flatMap(span=>[span.start,span.end]).filter(at=>at>=paragraph.start&&at<paragraph.end)].map(at=>resolver.character(story,paragraph,at).size??16)),minimum=shrink.minSize/Math.min(...sizes);
    if(minimum<1){
      const trial=async(factor:number)=>composeText({...request,document:scaleTextStory(doc,story.id,factor,false),frames:frames.map(({shrink:_shrink,...frame})=>frame),artwork:request.artwork?.map(item=>({...item,width:item.width*factor,...(item.inkWidth===undefined?{}:{inkWidth:item.inkWidth*factor}),ascent:item.ascent*factor,descent:item.descent*factor}))},services);
      const fits=(layout:TextLayoutV1)=>!layout.overset&&!layout.diagnostics.some(notice=>notice.code==='line-width');let low=minimum,high=1,best=await trial(low),applied=low;
      if(fits(best))for(let attempt=0;attempt<12&&high-low>.0001;attempt++){const factor=(low+high)/2,candidate=await trial(factor);if(fits(candidate)){low=factor;best=candidate;applied=factor;}else high=factor;}
      result=best;result.frames[0]!.appliedScale=applied;result.frames[0]!.geometryKey=textFrameKey(frames[0]!);result.diagnostics.push({start:0,end:story.source.length,storyId:story.id,frameId:frames[0]!.id,code:'text-shrink',severity:'info',message:`Shrink to fit applied ${Math.round(applied*1000)/10}% of the authored text size.`});
    }
  }
  result.documentHash = await sha256Hex(new TextEncoder().encode(JSON.stringify(doc)));
  return result;
}
