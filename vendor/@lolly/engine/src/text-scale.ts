// SPDX-License-Identifier: MPL-2.0
/** Explicit typography scaling keeps literal text and named-style identity intact. */
import type { TextCharacterV1,TextDocumentV1,TextFrameV1,TextParagraphStyleV1 } from '@lolly-tools/core';
import { textStyleResolver } from './text-styles.ts';
import { TextSourceError } from './text-source.ts';
import { transformTextPath } from './text-spacing.ts';
function scaleCharacter(value:TextCharacterV1,factor:number):TextCharacterV1{return {...value,size:(value.size??16)*factor,...(value.tracking===undefined?{}:{tracking:value.tracking*factor}),...(value.baselineShift===undefined?{}:{baselineShift:value.baselineShift*factor})};}
export function scaleTextStory(textDocument:TextDocumentV1,id:string,factor:number,allDistances=true):TextDocumentV1 {
  if(!Number.isFinite(factor)||factor<=0||factor>100)throw new TextSourceError('text-scale','Choose a positive text scale no greater than 100 times its original size.');
  const resolver=textStyleResolver(textDocument),story=textDocument.stories.find(story=>story.id===id);if(!story)throw new TextSourceError('story-missing','The text story is missing.');
  function settings(value:TextParagraphStyleV1):TextParagraphStyleV1{const result={...value,character:scaleCharacter(value.character??{},factor)};if(allDistances){
    for(const key of ['spaceBefore','spaceAfter','indentStart','indentEnd','firstIndent'] as const)if(value[key]!==undefined)result[key]=value[key]!*factor;
    if(value.tabs)result.tabs=value.tabs.map(tab=>({...tab,position:tab.position*factor}));if(value.dropCap)result.dropCap={...value.dropCap,gap:value.dropCap.gap*factor};
    for(const key of ['ruleBefore','ruleAfter'] as const)if(value[key])result[key]={...value[key]!,width:value[key]!.width*factor,offset:value[key]!.offset*factor};
  }return result;}
  const next={...story,paragraphs:story.paragraphs.map(paragraph=>({...paragraph,paragraph:settings(resolver.paragraph(story,paragraph))})),spans:story.spans.map(span=>{const paragraph=story.paragraphs.find(paragraph=>paragraph.start<=span.start&&paragraph.end>=span.start)??story.paragraphs.at(-1)!;return {...span,character:scaleCharacter(resolver.character(story,paragraph,span.start),factor)};}),inlines:story.inlines.map(inline=>({...inline,width:inline.width*factor,ascent:inline.ascent*factor,descent:inline.descent*factor}))};
  return {...textDocument,stories:textDocument.stories.map(story=>story.id===id?next:story)};
}
export function scaleTextFrame(frame:TextFrameV1,factor:number):TextFrameV1 {
  const path=frame.path?{...frame.path,d:transformTextPath(frame.path.d,{a:factor,b:0,c:0,d:factor,e:0,f:0}),start:frame.path.start*factor,end:frame.path.end*factor,baseline:frame.path.baseline*factor}:undefined;
  return {...frame,width:frame.width*factor,height:frame.height*factor,inset:{top:frame.inset.top*factor,right:frame.inset.right*factor,bottom:frame.inset.bottom*factor,left:frame.inset.left*factor},columns:{...frame.columns,gutter:frame.columns.gutter*factor},...(frame.grid?{grid:{step:frame.grid.step*factor,offset:frame.grid.offset*factor}}:{}),...(frame.firstBaseline===undefined?{}:{firstBaseline:frame.firstBaseline*factor}),...(frame.shrink?{shrink:{minSize:frame.shrink.minSize*factor}}:{}),...(path?{path}:{})};
}
