// SPDX-License-Identifier: MPL-2.0
/** Append-only Design text fields share one source document and independent frame geometry. */
import type { TextCharacterV1, TextDocumentV1, TextFontResourceV1, TextFrameV1, TextSpanV1, TextParagraphStyleV1 } from '@lolly-tools/core';
import { createTextStory, parseTextDocument, serializeTextDocument } from './text-story-document.ts';
import { parseTextFrame } from './text-frame.ts';
import { emojiTextPath } from './emoji-text-path.ts';
import { transformTextPath } from './text-spacing.ts';
import { TextSourceError } from './text-source.ts';
export type TextFrameSettingsV1 = Omit<TextFrameV1, 'id' | 'storyId' | 'width' | 'height' | 'hidden' | 'locked'>;
export interface DesignTextBox { id?: unknown; textStory?: unknown; textFrame?: unknown; text?: unknown; w?: unknown; h?: unknown; hidden?: unknown; locked?: unknown; [key:string]:unknown }
export const defaultTextFrameSettings = (mode: TextFrameV1['mode'] = 'fixed'): TextFrameSettingsV1 => ({ mode, inset:{top:0,right:0,bottom:0,left:0}, columns:{count:1,gutter:0,balance:false}, verticalAlign:'top' });
/** An authored resize fixes that dimension; subsequent composition never restores the old auto size. */
export function resizeDesignTextFrames<T extends DesignTextBox>(before: readonly T[], after: T[]): T[] {
  const previous = new Map(before.map(box => [box.id, box]));
  return after.map(box => {
    const old = previous.get(box.id);
    if (!old?.textStory || old.textStory !== box.textStory || old.textFrame !== box.textFrame) return box;
    const width = Math.abs(Number(box.w) - Number(old.w)) > .001, height = Math.abs(Number(box.h) - Number(old.h)) > .001;
    if (!width && !height) return box;
    const frame = designTextFrame(box);
    if (frame.path) {
      const path = frame.path, d = transformTextPath(path.d, {a:Number(box.w)/Number(old.w),b:0,c:0,d:Number(box.h)/Number(old.h),e:0,f:0});
      const scale = emojiTextPath(d).length / emojiTextPath(path.d).length;
      return {...box,textFrame:JSON.stringify({...JSON.parse(String(box.textFrame)),path:{...path,d,start:path.start*scale,end:path.end*scale}})};
    }
    const mode = frame.mode === 'auto-width' ? height ? 'fixed' : 'auto-height' : frame.mode === 'auto-height' && height ? 'fixed' : frame.mode;
    if (mode === frame.mode) return box;
    return { ...box, textFrame: JSON.stringify({ ...JSON.parse(String(box.textFrame)), mode }) };
  });
}
export function designTextFrame(box: DesignTextBox): TextFrameV1 {
  if(typeof box.textFrame !== 'string' || box.textFrame.length > 1024*1024) throw new TextSourceError('frame-settings', 'The text frame settings are missing or too large.');
  let settings: unknown;
  try {settings=JSON.parse(box.textFrame);} catch {throw new TextSourceError('frame-settings', 'The text frame settings are not valid JSON.');}
  if(!settings || typeof settings !== 'object' || Array.isArray(settings) || ['id','storyId','width','height','hidden','locked'].some(key=>key in settings)) throw new TextSourceError('frame-settings','Text frame identity and size belong to the Design box.');
  return parseTextFrame({...settings,id:box.id,storyId:box.textStory,width:Number(box.w),height:Number(box.h),...([true,'true',1,'1'].includes(box.hidden as string | number | boolean)?{hidden:true}:{}),...([true,'true',1,'1'].includes(box.locked as string | number | boolean)?{locked:true}:{})});
}
export function readDesignText(input: unknown, boxes: readonly DesignTextBox[]): { document:TextDocumentV1; frames:TextFrameV1[] } {
  const doc=parseTextDocument(input==null || input==='' ? {version:1,stories:[],styles:[],fonts:[]} : input);
  const frames=boxes.filter(box=>box.textStory!=null && box.textStory!=='').map(designTextFrame);
  const owners=new Map(doc.stories.flatMap(story=>story.frameIds.map(id=>[id,story.id] as const)));
  if(new Set(frames.map(frame=>frame.id)).size!==frames.length) throw new TextSourceError('frame-owner','Text frame ids must be unique.');
  for(const frame of frames) {
    if(owners.get(frame.id)!==frame.storyId)throw new TextSourceError('frame-owner','The text frame and story must agree on ownership.');
    if(boxes.find(box=>box.id===frame.id)?.text)throw new TextSourceError('source-owner','Composed text cannot also have a writable legacy text value.');
    owners.delete(frame.id);
  }
  if(owners.size)throw new TextSourceError('frame-missing','A story names a text frame that is missing from this design.');
  return {document:doc,frames};
}
/** The caller reads legacy formatting before this explicit, undoable source migration. */
export function upgradeDesignText(input:unknown,boxes:readonly DesignTextBox[],boxId:string,options:{storyId:string;source:string;character:TextCharacterV1;fonts:TextFontResourceV1[];spans?:TextSpanV1[];paragraph?:TextParagraphStyleV1;settings?:TextFrameSettingsV1}) {
  const current=readDesignText(input,boxes),index=boxes.findIndex(box=>box.id===boxId),box=boxes[index];
  if(!box || box.textStory)throw new TextSourceError('upgrade-target','Choose one legacy text object to upgrade.');
  if(current.document.stories.some(story=>story.id===options.storyId))throw new TextSourceError('duplicate-id','The new text story needs a unique id.');
  const story=createTextStory(options.storyId,options.source,i=>`${options.storyId}-p${i}`,'soft');story.frameIds=[boxId];story.spans=structuredClone(options.spans??[]);
  for(const paragraph of story.paragraphs)paragraph.paragraph={...structuredClone(options.paragraph),character:structuredClone(options.character)};
  current.document.stories.push(story);
  for(const font of options.fonts){const existing=current.document.fonts.find(item=>item.id===font.id);if(existing && JSON.stringify(existing)!==JSON.stringify(font))throw new TextSourceError('font-conflict','An existing font id has different pinned bytes.');if(!existing)current.document.fonts.push(structuredClone(font));}
  const next=structuredClone([...boxes]);next[index]={...next[index],text:'',textStory:story.id,textFrame:JSON.stringify(options.settings??defaultTextFrameSettings())};
  const textDocument=serializeTextDocument(current.document);readDesignText(textDocument,next);
  return {textDocument,boxes:next};
}
