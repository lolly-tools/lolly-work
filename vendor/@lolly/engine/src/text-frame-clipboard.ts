// SPDX-License-Identifier: MPL-2.0
/** Portable frame copies carry independent text and exact font pins, never live story references. */
import type { TextDocumentV1, TextStoryV1 } from '@lolly-tools/core';
import type { TextThreadSnapshot } from './text-thread-commands.ts';
import type { TextLayoutReceipt } from './text-layout-cache.ts';
import { textLayoutKey } from './text-layout-cache.ts';
import { sliceTextDocument, importTextFragment } from './text-fragment.ts';
import { createTextStory, parseTextDocument } from './text-story-document.ts';
import { replaceStoryRange } from './text-edits.ts';
import { TextSourceError } from './text-source.ts';
export function captureTextFrames(snapshot: TextThreadSnapshot, ids: ReadonlySet<string>, receipts: ReadonlyMap<string,TextLayoutReceipt>, fresh: () => string): TextDocumentV1 {
  const textDocument: TextDocumentV1 = {version:1,stories:[],styles:[],fonts:[]};
  for (const story of snapshot.document.stories) {
    const groups: string[][] = [];
    for (const [index,id] of story.frameIds.entries()) if (ids.has(id)) {
      if (!index || !ids.has(story.frameIds[index-1]!)) groups.push([]); groups.at(-1)!.push(id);
    }
    for (const group of groups) {
      let start = 0, end = story.source.length;
      if (group.length!==story.frameIds.length) {
        const receipt = receipts.get(story.id);
        if (!receipt || receipt.key!==textLayoutKey({document:snapshot.document,storyId:story.id,frames:snapshot.frames.filter(frame=>frame.storyId===story.id)}))
          throw new TextSourceError('layout-stale','Wait for text layout to finish, then copy the selected frames again.');
        const first=receipt.layout.frames.find(frame=>frame.id===group[0]),last=receipt.layout.frames.find(frame=>frame.id===group.at(-1));
        if (!first || !last) throw new TextSourceError('layout-stale','The selected frames have no settled text range.');
        start=first.start;end=last.end;
      }
      const fragment = sliceTextDocument(snapshot.document,story,{start,end}), copied=fragment.stories[0]!;
      textDocument.stories.push({...copied,id:fresh(),frameIds:group,paragraphs:copied.paragraphs.map(paragraph=>({...paragraph,id:fresh()})),inlines:copied.inlines.map(inline=>({...inline,id:fresh()}))});
      for (const font of fragment.fonts) if (!textDocument.fonts.some(item=>item.id===font.id)) textDocument.fonts.push(font);
    }
  }
  return parseTextDocument(textDocument);
}
export function pasteTextFrames(snapshot: TextThreadSnapshot, clipboard: TextThreadSnapshot, copies: ReadonlyMap<string,string>, fresh: () => string): TextThreadSnapshot {
  const current=structuredClone(snapshot), used=new Set(current.frames.map(frame=>frame.id));
  for (const frame of clipboard.frames) {
    const id=copies.get(frame.id);
    if (!id || used.has(id)) throw new TextSourceError('duplicate-id','Pasted text frames need independent ids.'); used.add(id);
  }
  for (const source of parseTextDocument(clipboard.document).stories) {
    const fragment=sliceTextDocument(clipboard.document,source,{start:0,end:source.source.length});
    const imported=importTextFragment(current.document,fragment,fresh);current.document=imported.document;
    const id=fresh(), empty=createTextStory(id,'',()=>fresh());
    const story: TextStoryV1=replaceStoryRange(empty,{start:0,end:0},imported.insertion,{paragraphId:fresh}).story;
    story.frameIds=source.frameIds.map(id=>copies.get(id)!);current.document.stories.push(story);
    for (const frame of clipboard.frames.filter(frame=>frame.storyId===source.id)) current.frames.push({...frame,id:copies.get(frame.id)!,storyId:id,locked:false});
  }
  current.document=parseTextDocument(current.document);return current;
}
