// SPDX-License-Identifier: MPL-2.0
/** Whole-content template fields inherit the authored first paragraph and character style. */
import type { TextDocumentV1,TextCharacterV1,TextBreakV1 } from './text-v1.ts';
export function writeDesignText(document:TextDocumentV1,box:Record<string,unknown>,property:string,value:unknown):boolean{
  const story=document.stories.find(story=>story.id===box.textStory);if(!story)throw new Error('The template text story is missing.');
  if(property==='text'){
    const source=String(value??'');if(source===story.source)return true;if(source.length>64000||source.includes('\ufffc'))throw new Error('The supplied template text exceeds its supported source limits.');
    const first=story.paragraphs[0]!,span=story.spans.find(span=>span.start===0),breaks:TextBreakV1[]=[];
    for(const match of source.matchAll(/\r\n|[\r\n\v\f\u0085\u2028\u2029]/g))breaks.push({start:match.index,length:match[0].length as 1|2,kind:match[0]==='\u2028'?'soft':'paragraph'});
    let start=0,index=0;const paragraphs:typeof story.paragraphs=[],used=new Set([first.id]);
    const paragraphId=()=>{if(!index)return first.id;let id=`${story.id.slice(0,96)}-field-${index}`;while(used.has(id))id+='x';used.add(id);return id;};
    for(const separator of breaks.filter(item=>item.kind==='paragraph')){paragraphs.push({...first,id:paragraphId(),start,end:separator.start});start=separator.start+separator.length;index++;}
    paragraphs.push({...first,id:paragraphId(),start,end:source.length});
    story.source=source;story.breaks=breaks;story.paragraphs=paragraphs;story.inlines=[];story.spans=source&&span?[{...span,start:0,end:source.length}]:[];story.revision++;return true;
  }
  const field:Record<string,keyof TextCharacterV1>={fontSize:'size',weight:'weight',fg:'color',font:'font'};const key=field[property];if(!key)return false;
  let chosen:unknown=property==='fontSize'||property==='weight'?Number(value):value;
  if(property==='font'){const font=document.fonts.find(font=>font.id===value||font.family===value);if(!font)throw new Error('Choose a font embedded in this template.');chosen=font.id;}
  const patch:TextCharacterV1={[key]:chosen};
  function namedAxes(id:string|undefined,seen=new Set<string>()):Record<string,number>{
    if(!id)return {};if(seen.has(id)||seen.size>=32)throw new Error('The template text style inheritance is invalid.');seen.add(id);
    const style=document.styles.find(item=>item.id===id);if(!style)throw new Error('The template text style is missing.');
    return {...namedAxes(style.basedOn,seen),...style.paragraph?.character?.axes,...style.character?.axes};
  }
  if(property==='weight'){
    for(const paragraph of story.paragraphs){const axes={...namedAxes(story.defaultStyle),...namedAxes(paragraph.style),...paragraph.paragraph?.character?.axes};if(axes.wght!==undefined)paragraph.paragraph={...paragraph.paragraph,character:{...paragraph.paragraph?.character,axes:{...paragraph.paragraph?.character?.axes,wght:Number(chosen)}}};}
    for(const span of story.spans)if(({...namedAxes(span.style),...span.character?.axes}).wght!==undefined)span.character={...span.character,axes:{...span.character?.axes,wght:Number(chosen)}};
  }
  story.paragraphs=story.paragraphs.map(paragraph=>({...paragraph,paragraph:{...paragraph.paragraph,character:{...paragraph.paragraph?.character,...patch}}}));
  story.spans=story.spans.map(span=>({...span,character:{...span.character,...patch}}));story.revision++;return true;
}
