// SPDX-License-Identifier: MPL-2.0
/** Tab fields follow authored stops measured from the paragraph's writing edge. */
import type { TextParagraphStyleV1 } from '@lolly-tools/core';
import type { TextParagraphPiece } from './text-paragraph.ts';
export function positionTextTabs(pieces:TextParagraphPiece[],settings:TextParagraphStyleV1,source:string,direction:'ltr'|'rtl'):number {
  const ordered=direction==='rtl'?[...pieces].reverse():pieces;let distance=0;
  for(const [index,piece] of ordered.entries()){
    if(piece.tab){
      const field:TextParagraphPiece[]=[];for(const following of ordered.slice(index+1)){if(following.tab)break;field.push(following);}
      const fieldWidth=field.reduce((sum,item)=>sum+item.advance,0),stop=settings.tabs?.find(stop=>stop.position>distance+.001);
      const unit=Math.max(1,(piece.style.size??16)*2),position=stop?.position??(Math.floor(distance/unit)+1)*unit;
      let aligned=0;
      if(stop?.align==='center')aligned=fieldWidth/2;else if(stop?.align==='end')aligned=fieldWidth;else if(stop?.align==='decimal'){
        const decimal=new Intl.NumberFormat(settings.language==='und'?undefined:settings.language).formatToParts(1.1).find(part=>part.type==='decimal')?.value??'.';
        for(const item of field){const at=source.slice(item.start,item.end).indexOf(decimal);if(at<0){aligned+=item.advance;continue;}const caret=item.carets.find(caret=>caret.offset===item.start+at);aligned+=caret?direction==='rtl'?item.x+item.advance-caret.x:caret.x-item.x:0;break;}
      }
      piece.advance=Math.max(0,position-distance-aligned);piece.tab.leader=stop?.leader;
    }
    piece.tabDistance=distance;distance+=piece.advance;
  }
  for(const piece of pieces){const x=direction==='rtl'?distance-piece.tabDistance!-piece.advance:piece.tabDistance!,dx=x-piece.x;
    piece.carets=piece.tab?[{offset:piece.start,x:direction==='rtl'?x+piece.advance:x},{offset:piece.end,x:direction==='rtl'?x:x+piece.advance}]:piece.carets.map(caret=>({...caret,x:caret.x+dx}));piece.x=x;delete piece.tabDistance;}
  return distance;
}
