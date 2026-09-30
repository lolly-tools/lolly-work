// SPDX-License-Identifier: MPL-2.0
/** Atomic story ownership commands. Containers never own copies of the source. */
import type { TextDocumentV1, TextFrameV1, TextLayoutV1, TextStoryV1 } from '@lolly-tools/core';
import { parseTextDocument } from './text-story-document.ts';
import { importTextFragment, sliceTextDocument } from './text-fragment.ts';
import { replaceStoryRange } from './text-edits.ts';
import { sourceBreaks, TextSourceError } from './text-source.ts';
import { sha256Hex } from './bytes.ts';
import { textFrameKey, parseTextFrame } from './text-frame.ts';
export interface TextThreadSnapshot { document: TextDocumentV1; frames: TextFrameV1[] }
const owner = (snapshot: TextThreadSnapshot, frameId: string): TextStoryV1 => {
  const story = snapshot.document.stories.find(story => story.frameIds.includes(frameId));
  if (!story) throw new TextSourceError('frame-owner','This text frame has no story.'); return story;
};
function admitted(snapshot: TextThreadSnapshot): TextThreadSnapshot {
  const textDocument = parseTextDocument(snapshot.document), ids = new Map(snapshot.frames.map(frame => [frame.id,frame]));
  const names = new Set(textDocument.stories.flatMap(story => story.frameIds));
  if (ids.size !== snapshot.frames.length || names.size !== ids.size || textDocument.stories.some(story => story.frameIds.some(id => ids.get(id)?.storyId !== story.id)))
    throw new TextSourceError('frame-owner','Every frame must belong to exactly one authored story.');
  return { document: textDocument,frames:snapshot.frames.map(parseTextFrame) };
}
function mutable(snapshot: TextThreadSnapshot, ids: readonly string[]): void {
  if (snapshot.frames.some(frame => ids.includes(frame.id) && frame.locked)) throw new TextSourceError('frame-locked','Unlock these text frames before changing their links or geometry.');
}
export function removeTextFrames(snapshot: TextThreadSnapshot, ids: readonly string[]): TextThreadSnapshot {
  const current = admitted(snapshot); mutable(current,ids); const removed = new Set(ids);
  current.document.stories = current.document.stories.map(story => {
    const frameIds = story.frameIds.filter(id => !removed.has(id));
    return frameIds.length === story.frameIds.length ? story : { ...story,revision:story.revision+1,frameIds };
  });
  current.frames = current.frames.filter(frame => !removed.has(frame.id)); return admitted(current);
}
export function deleteTextStory(snapshot: TextThreadSnapshot, id: string): TextThreadSnapshot {
  const current = admitted(snapshot), story = current.document.stories.find(story => story.id === id);
  if (!story) throw new TextSourceError('story-missing','This story no longer exists.'); mutable(current,story.frameIds);
  current.document.stories = current.document.stories.filter(item => item.id !== id); current.frames = current.frames.filter(frame => frame.storyId !== id); return admitted(current);
}
/** Empty target frames can be inserted; nonempty stories require an explicit join. */
export function linkTextFrames(snapshot: TextThreadSnapshot, sourceId: string, targetId: string, join: boolean, fresh: () => string): TextThreadSnapshot {
  const current = admitted(snapshot), source = owner(current,sourceId), target = owner(current,targetId);
  if (source.id === target.id) throw new TextSourceError('thread-cycle','These frames already belong to the same story.');
  const affected = [...source.frameIds,...target.frameIds]; mutable(current,affected);
  if (current.frames.some(frame => affected.includes(frame.id) && frame.mode === 'path')) throw new TextSourceError('thread-path','Detach text from its path before linking frames.');
  if ((target.source || target.frameIds.length > 1) && !join) throw new TextSourceError('join-required','Preview and join these stories to retain both sources.');
  if (target.frameIds[0] !== targetId) throw new TextSourceError('thread-target','Choose the first frame of the target story.');
  let merged = source;
  if (target.source) {
    const imported = importTextFragment(current.document,sliceTextDocument(current.document,target,{ start:0,end:target.source.length }),fresh);
    const insertion = imported.insertion, separator = '\n';
    merged = replaceStoryRange(source,{ start:source.source.length,end:source.source.length },{
      source:separator+insertion.source,
      breaks:[...sourceBreaks(separator),...(insertion.breaks ?? []).map(item => ({ ...item,start:item.start+separator.length }))],
      spans:insertion.spans?.map(span => ({ ...span,start:span.start+separator.length,end:span.end+separator.length })),
      paragraphs:insertion.paragraphs?.map(paragraph => ({ ...paragraph,start:paragraph.start+separator.length })),
      inlines:insertion.inlines?.map(inline => ({ ...inline,offset:inline.offset+separator.length })),
    },{paragraphId:fresh}).story;
  } else merged = { ...source,revision:source.revision+1 };
  const at = source.frameIds.indexOf(sourceId)+1;
  merged = { ...merged,frameIds:[...source.frameIds.slice(0,at),...target.frameIds,...source.frameIds.slice(at)] };
  current.document.stories = current.document.stories.filter(story => story.id !== target.id).map(story => story.id === source.id ? merged : story);
  current.frames = current.frames.map(frame => affected.includes(frame.id) ? { ...frame,storyId:source.id,mode:'fixed',shrink:undefined } : frame);
  return admitted(current);
}
async function settledStory(snapshot: TextThreadSnapshot, story: TextStoryV1, layout: TextLayoutV1): Promise<void> {
  if (layout.storyId !== story.id || layout.revision !== story.revision || layout.frames.map(frame => frame.id).join('\0') !== story.frameIds.join('\0')
    || layout.documentHash !== await sha256Hex(new TextEncoder().encode(JSON.stringify(snapshot.document)))
    || layout.frames.some(frame => { const current = snapshot.frames.find(item => item.id === frame.id); return !current || frame.geometryKey !== textFrameKey(current); }))
    throw new TextSourceError('layout-stale','Finish layout for the current frames before changing this story.');
}
function slicedStory(textDocument: TextDocumentV1, story: TextStoryV1, start: number, end: number, id: string, fresh: () => string): TextStoryV1 {
  const copied = sliceTextDocument(textDocument,story,{start,end}).stories[0]!;
  return { ...copied,id,revision:0,paragraphs:copied.paragraphs.map(paragraph => ({ ...paragraph,id:fresh() })),inlines:copied.inlines.map(inline => ({ ...inline,id:fresh() })) };
}
export async function splitTextThread(snapshot: TextThreadSnapshot, after: string, layout: TextLayoutV1, fresh: () => string): Promise<TextThreadSnapshot> {
  const current = admitted(snapshot), story = owner(current,after), index = story.frameIds.indexOf(after);
  if (index === story.frameIds.length-1) throw new TextSourceError('thread-end','This frame has no following text frame to disconnect.');
  mutable(current,story.frameIds); await settledStory(current,story,layout);
  const boundary = layout.frames[index]!.end;
  const left = slicedStory(current.document,story,0,boundary,story.id,fresh), right = slicedStory(current.document,story,boundary,story.source.length,fresh(),fresh);
  left.revision = story.revision+1; left.frameIds = story.frameIds.slice(0,index+1); right.frameIds = story.frameIds.slice(index+1);
  current.document.stories = current.document.stories.map(item => item.id === story.id ? left : item).concat(right);
  current.frames = current.frames.map(frame => right.frameIds.includes(frame.id) ? { ...frame,storyId:right.id } : frame); return admitted(current);
}
/** Each contiguous selected part becomes independent; a complete chain retains overset text. */
export async function duplicateTextFrames(snapshot: TextThreadSnapshot, copies: ReadonlyMap<string,string>, layouts: ReadonlyMap<string,TextLayoutV1>, fresh: () => string): Promise<TextThreadSnapshot> {
  const current = admitted(snapshot), used = new Set(current.frames.map(frame => frame.id));
  for (const [old,id] of copies) {
    if (!used.has(old) || used.has(id)) throw new TextSourceError('duplicate-id','Text copies need distinct new frame ids.'); used.add(id);
  }
  for (const story of snapshot.document.stories) {
    const groups: string[][] = [];
    for (const [index,id] of story.frameIds.entries()) if (copies.has(id)) {
      if (!index || !copies.has(story.frameIds[index-1]!)) groups.push([]); groups.at(-1)!.push(id);
    }
    for (const group of groups) {
      const id = fresh(); let cloned: TextStoryV1;
      if (group.length === story.frameIds.length) cloned = { ...structuredClone(story),id,revision:0,paragraphs:story.paragraphs.map(paragraph => ({ ...structuredClone(paragraph),id:fresh() })),inlines:story.inlines.map(inline => ({ ...structuredClone(inline),id:fresh() })) };
      else {
        const layout = layouts.get(story.id); if (!layout) throw new TextSourceError('layout-stale','Finish layout before copying visible text from selected frames.'); await settledStory(snapshot,story,layout);
        cloned = slicedStory(current.document,story,layout.frames.find(frame => frame.id === group[0])!.start,layout.frames.find(frame => frame.id === group.at(-1))!.end,id,fresh);
      }
      cloned.frameIds = group.map(id => copies.get(id)!); current.document.stories.push(cloned);
      for (const id of group) current.frames.push({ ...structuredClone(snapshot.frames.find(frame => frame.id === id)!),id:copies.get(id)!,storyId:cloned.id,locked:false });
    }
  }
  return admitted(current);
}
export function placeTextStory(snapshot: TextThreadSnapshot, storyId: string, frame: TextFrameV1): TextThreadSnapshot {
  const current = admitted(snapshot), story = current.document.stories.find(story => story.id === storyId);
  if (!story || story.frameIds.length || frame.storyId !== storyId || current.frames.some(item => item.id === frame.id)) throw new TextSourceError('story-placement','Choose an unplaced story and a new frame.');
  story.frameIds = [frame.id]; story.revision++; current.frames.push(structuredClone(frame)); return admitted(current);
}
export function insertTextFrame(snapshot: TextThreadSnapshot, after: string, frame: TextFrameV1): TextThreadSnapshot {
  const current = admitted(snapshot), story = owner(current,after); mutable(current,story.frameIds);
  if (frame.storyId !== story.id || current.frames.some(item=>item.id===frame.id) || frame.mode === 'path' || current.frames.some(item=>item.storyId===story.id && item.mode==='path'))
    throw new TextSourceError('frame-owner','Continue this story into a new rectangular frame.');
  story.frameIds.splice(story.frameIds.indexOf(after)+1,0,frame.id); story.revision++;
  current.frames = current.frames.map(item=>item.storyId===story.id?{...item,mode:'fixed',shrink:undefined}:item); current.frames.push({...frame,mode:'fixed',shrink:undefined}); return admitted(current);
}

/** Explicitly remove one settled range from its thread and give it an independent source. */
export async function detachTextFrame(snapshot:TextThreadSnapshot,id:string,layout:TextLayoutV1,fresh:()=>string):Promise<TextThreadSnapshot>{
  const current=admitted(snapshot),story=owner(current,id);mutable(current,story.frameIds);await settledStory(current,story,layout);
  if(story.frameIds.length===1)return current;
  const frame=layout.frames.find(frame=>frame.id===id)!,detached=slicedStory(current.document,story,frame.start,frame.end,fresh(),fresh);detached.frameIds=[id];
  const remaining=replaceStoryRange(story,{start:frame.start,end:frame.end},{source:''},{paragraphId:fresh}).story;remaining.frameIds=story.frameIds.filter(frameId=>frameId!==id);
  current.document.stories=current.document.stories.map(item=>item.id===story.id?remaining:item).concat(detached);
  current.frames=current.frames.map(frame=>frame.id===id?{...frame,storyId:detached.id}:frame);return admitted(current);
}
