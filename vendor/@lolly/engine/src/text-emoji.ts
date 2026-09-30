// SPDX-License-Identifier: MPL-2.0
/** Pinned paragraph emoji use the existing artwork admission, treatment and source census. */
import type { EmojiStyleV1, TextArtworkV1, TextDiagnosticV1, TextLayoutRequestV1 } from '@lolly-tools/core';
import type { VerifiedEmojiPack } from './emoji-pack.ts';
import { prepareEmojiText, type EmojiTextIO, type EmojiArtworkCache } from './emoji-inline.ts';
import { parseTextDocument } from './text-story-document.ts';
import { textStyleResolver } from './text-styles.ts';
import { TextSourceError } from './text-source.ts';
import { parseColor, formatColor } from './css-color.ts';
/** Prepared single-ink paints inherit the character colour, including its alpha. */
function textInk(markup:string,color:string):string {
  const parsed = parseColor(color)!;
  const rgb = /^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(color) ? color.slice(0,7) : formatColor({ ...parsed, alpha: 1 });
  const alpha = parsed.alpha;
  return markup.replace(/<[^>]+>/g,tag=>{
    for(const paint of ['fill','stroke'])if(tag.includes(`${paint}="currentColor"`)){
      tag=tag.replace(`${paint}="currentColor"`,`${paint}="${rgb}"`);
      if(alpha!==1){const opacity=new RegExp(` ${paint}-opacity="([^"]+)"`),match=opacity.exec(tag),value=Math.round(alpha*Number(match?.[1]??1)*1e6)/1e6;
        tag=match?tag.replace(opacity,` ${paint}-opacity="${value}"`):tag.replace(/\/?>$/,ending=>` ${paint}-opacity="${value}"${ending}`);}
    }
    return tag;
  });
}
export async function prepareParagraphEmoji(request:TextLayoutRequestV1,style:EmojiStyleV1|null,packs:readonly VerifiedEmojiPack[],io:EmojiTextIO,cache:EmojiArtworkCache) {
  const doc=parseTextDocument(request.document),story=doc.stories.find(story=>story.id===request.storyId);
  if(!story)throw new TextSourceError('story-missing','The requested text story is missing.');
  const prepared=await prepareEmojiText(story.source,style,packs,io,{cache,prefix:'composed'}),styles=textStyleResolver(doc),artwork:TextArtworkV1[]=[];
  const diagnostics:TextDiagnosticV1[]=[];
  let offset=0,paragraphIndex=0;
  for(const segment of prepared.segments){
    if(segment.kind==='emoji'||segment.kind==='unresolved'){
      while(story.paragraphs[paragraphIndex]!.end<offset && paragraphIndex+1<story.paragraphs.length)paragraphIndex++;
      const character=styles.character(story,story.paragraphs[paragraphIndex]!,offset),size=character.size??16;
      if(segment.kind==='unresolved'){
        const color=formatColor(parseColor(character.color??'#000000')!);
        artwork.push({start:offset,end:offset+segment.text.length,id:`unresolved-${offset}`,sha256:'',width:size,ascent:size*.8,descent:size*.2,svg:`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><rect x="10" y="10" width="80" height="80" fill="none" stroke="${color}" stroke-width="5"/></svg>`});
        diagnostics.push({start:offset,end:offset+segment.text.length,code:'emoji-missing',severity:'warning',storyId:story.id,message:`Emoji is unavailable: ${segment.reason}. Choose an available set or fallback.`});
      }else{
      const m=segment.metrics;
      artwork.push({start:offset,end:offset+segment.text.length,id:segment.source.assetId,sha256:segment.source.artworkChecksum.replace(/^sha256:/,''),
        svg:textInk(segment.markup,character.color??'#000000'),width:m.advanceEm*size,inkWidth:m.widthEm*size,ascent:(m.heightEm-m.descentEm)*size,descent:m.descentEm*size});
      }
    }
    offset+=segment.text.length;
  }
  return {request:{...request,document:doc,artwork:[...request.artwork??[],...artwork]},census:[...prepared.census,...story.inlines.flatMap(inline=>(inline.emojiSources??[]).map(source=>({...source,occurrences:[{start:inline.offset,end:inline.offset+1}]})))],diagnostics,story};
}
