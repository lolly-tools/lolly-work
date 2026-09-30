// SPDX-License-Identifier: MPL-2.0
/** Inline vectors keep their source's bidi and break semantics while occupying one source unit. */
import type { TextRangeV1, TextStoryV1 } from '@lolly-tools/core';
import { TextSourceError, TEXT_SOURCE_MAX_UNITS } from './text-source.ts';
export function textSemanticSource(story:TextStoryV1,range:TextRangeV1={start:0,end:story.source.length}){
  const inlines=new Map(story.inlines.map(inline=>[inline.offset,inline.originalText||'\ufffc'])),forward=new Map<number,number>(),backward=new Map<number,number>();let source='';
  for(let at=range.start;at<range.end;){forward.set(at,source.length);backward.set(source.length,at);const inline=inlines.get(at),text=inline??String.fromCodePoint(story.source.codePointAt(at)!);source+=text;at+=inline!==undefined?1:text.length;if(source.length>TEXT_SOURCE_MAX_UNITS)throw new TextSourceError('inline-source-limit','The expanded inline text exceeds the supported story size. Split it into separate stories.');}
  forward.set(range.end,source.length);backward.set(source.length,range.end);
  return {source,forward,backward};
}
