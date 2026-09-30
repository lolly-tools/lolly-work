// SPDX-License-Identifier: MPL-2.0
/** Display case preserves authored offsets, including characters that expand when capitalised. */
import type { TextCharacterV1, TextShapedRunV1 } from '@lolly-tools/core';
import { emojiGraphemes } from './emoji-segment.ts';
export function textDisplaySource(source:string,mode:TextCharacterV1['case'],language='und') {
  const change=(text:string)=>mode==='upper'?text.toLocaleUpperCase(language==='und'?undefined:language):mode==='lower'?text.toLocaleLowerCase(language==='und'?undefined:language):text;
  let text='';const ranges=emojiGraphemes(source).map(range=>{const start=text.length;text+=change(source.slice(range.start,range.end));return {...range,displayStart:start,displayEnd:text.length};});
  const complete=change(source);if(complete.length!==text.length)throw new Error('This display-case mapping needs a separate text run.');
  return {text:complete,ranges};
}
export function mapTextDisplayRun(run:TextShapedRunV1,source:string,start:number,map:ReturnType<typeof textDisplaySource>):TextShapedRunV1 {
  const logical=(at:number,end=false)=>{const range=map.ranges.find(range=>end?at>range.displayStart&&at<=range.displayEnd:at>=range.displayStart&&at<range.displayEnd);return start+(range?(end?range.end:range.start):source.length);};
  const groups:TextShapedRunV1['clusters']=[];
  const carets=run.clusters.flatMap(cluster=>cluster.carets).flatMap(caret=>{const at=caret.offset-start;const edge=map.ranges.find(range=>range.displayStart===at||range.displayEnd===at);return edge?[{offset:start+(edge.displayStart===at?edge.start:edge.end),x:caret.x}]:[];});
  for(const cluster of [...run.clusters].sort((a,b)=>a.start-b.start)){const a=logical(cluster.start-start),b=logical(cluster.end-start,true),previous=groups.at(-1);
    if(previous&&previous.end>a){previous.end=Math.max(previous.end,b);previous.x=Math.min(previous.x,cluster.x);previous.advance+=cluster.advance;previous.d+=cluster.d;}
    else groups.push({...cluster,start:a,end:b,carets:[]});
  }
  for(const cluster of groups){const mapped=carets.filter(caret=>caret.offset>=cluster.start&&caret.offset<=cluster.end&&caret.x>=cluster.x-.001&&caret.x<=cluster.x+cluster.advance+.001);cluster.carets=[...new Map(mapped.map(caret=>[caret.offset,caret])).values()];}
  return {...run,text:source,start,end:start+source.length,clusters:groups,missing:run.missing.map(range=>({start:logical(range.start-start),end:logical(range.end-start,true)}))};
}
