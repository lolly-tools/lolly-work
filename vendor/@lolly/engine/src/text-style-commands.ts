// SPDX-License-Identifier: MPL-2.0
/** Style commands retain source, literal ranges and no-break constraints. */
import type { TextDocumentV1, TextRangeV1, TextStoryV1, TextNamedStyleV1 } from '@lolly-tools/core';
import { formatStoryRange, storyParagraphIds } from './text-edits.ts';
import { parseTextDocument } from './text-story-document.ts';
import { TextSourceError } from './text-source.ts';
export interface TextStyleCommand { kind: 'paragraph' | 'character'; style?: string | null; reset?: boolean }
export function styleTextRange(textDocument: TextDocumentV1, story: TextStoryV1, range: TextRangeV1, command: TextStyleCommand): TextStoryV1 {
  if (command.style && textDocument.styles.find(style => style.id === command.style)?.kind !== command.kind) throw new TextSourceError('style-kind', 'Choose a style of the requested kind.');
  const ids = new Set(storyParagraphIds(story, range));
  if (command.kind === 'paragraph') return { ...story, revision: story.revision + 1, paragraphs: story.paragraphs.map(paragraph => {
    if (!ids.has(paragraph.id)) return paragraph;
    const next = { ...paragraph };
    if (command.style === null) delete next.style;
    else if (command.style !== undefined) next.style = command.style;
    if (command.reset) delete next.paragraph;
    return next;
  }) };
  return formatStoryRange(story, range, { ...(command.style === undefined ? {} : { style: command.style }), ...(command.reset ? { character: null } : {}) });
}

/** A definition change recomposes every dependent story in one document transaction. */
export function defineTextStyle(textDocument:TextDocumentV1,definition:TextNamedStyleV1):TextDocumentV1 {
  const old=textDocument.styles.find(style=>style.id===definition.id);
  if(old&&old.kind!==definition.kind)throw new TextSourceError('style-kind','An existing style must retain its kind.');
  const affected=new Set([definition.id]);let changed=true;
  while(changed){changed=false;for(const style of textDocument.styles)if(style.basedOn&&affected.has(style.basedOn)&&!affected.has(style.id)){affected.add(style.id);changed=true;}}
  return parseTextDocument({...textDocument,styles:old?textDocument.styles.map(style=>style.id===definition.id?definition:style):[...textDocument.styles,definition],stories:textDocument.stories.map(story=>affected.has(story.defaultStyle??'')||story.paragraphs.some(paragraph=>affected.has(paragraph.style??''))||story.spans.some(span=>affected.has(span.style??''))?{...story,revision:story.revision+1}:story)});
}
/** Enter can advance the paragraph style; paste and soft breaks keep their authored settings. */
export function nextParagraphStyle(textDocument:TextDocumentV1,before:TextStoryV1,after:TextStoryV1,at:number):TextStoryV1 {
  const previous=before.paragraphs.find(paragraph=>paragraph.start<=at&&paragraph.end>=at),style=textDocument.styles.find(style=>style.id===(previous?.style??before.defaultStyle));
  if(!style?.next)return after;
  const oldIds=new Set(before.paragraphs.map(paragraph=>paragraph.id));
  return {...after,paragraphs:after.paragraphs.map(paragraph=>oldIds.has(paragraph.id)?paragraph:{...paragraph,style:style.next,paragraph:undefined})};
}
