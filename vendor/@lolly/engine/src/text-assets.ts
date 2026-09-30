// SPDX-License-Identifier: MPL-2.0
/** Font dependencies inside a serialized text document remain visible to asset walkers. */
export function mapTextFontAssets(value:unknown,visit:(id:string)=>string):unknown{
  const serialized=typeof value==='string';if(serialized&&value.length>8*1024*1024)return value;
  let document:unknown;try{document=serialized?JSON.parse(value):value;}catch{return value;}
  if(!document||typeof document!=='object'||Array.isArray(document))return value;
  const record=document as Record<string,unknown>;
  if(record.version!==1||!Array.isArray(record.fonts)||record.fonts.length>512)return value;
  let changed=false;
  const fonts=record.fonts.map(font=>{
    if(!font||typeof font!=='object'||Array.isArray(font))return font;
    const source=font.source;
    if(!source||typeof source!=='object'||Array.isArray(source)||source.kind!=='asset'||typeof source.id!=='string'||source.id.length>2048)return font;
    const id=visit(source.id);if(id===source.id)return font;changed=true;return {...font,source:{...source,id}};
  });
  return changed?(serialized?JSON.stringify({...record,fonts}):{...record,fonts}):value;
}
export function textFontAssetIds(value:unknown):string[]{const ids=new Set<string>();mapTextFontAssets(value,id=>{ids.add(id);return id;});return [...ids];}
