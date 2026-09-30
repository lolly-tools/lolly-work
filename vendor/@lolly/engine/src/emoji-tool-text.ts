// SPDX-License-Identifier: MPL-2.0
/** Mixed vector text for tools that sample artwork or paint their own canvas. */
import type { EmojiAPI, EmojiTextRenderOpts, TextAPI } from '@lolly-tools/core/host-v1';
import type { TextLayoutRequestV1, TextLayoutV1 } from '@lolly-tools/core';
import { sha256Hex } from './bytes.ts';
import type { EmojiStyleV1 } from '@lolly-tools/core/emoji-v1';
import { readEmojiPack, type VerifiedEmojiPack } from './emoji-pack.ts';
import { prepareEmojiText, type EmojiArtworkCache } from './emoji-inline.ts';
import { requiresEmojiBidiLayout } from './emoji-segment.ts';
import { escapeXml } from './xml-escape.ts';
import type { EmojiLineSource } from './emoji-line.ts';

export function createEmojiToolText(api: EmojiAPI, text: TextAPI | undefined, selected: () => EmojiStyleV1 | null) {
  const packs = new Map<string, Promise<VerifiedEmojiPack | null>>();
  const artwork: EmojiArtworkCache = new Map();
  let used = false;
  const sources = new Map<string,EmojiLineSource[]>();
  let census: EmojiLineSource[] = [];
  async function packsFor(style:EmojiStyleV1|null):Promise<VerifiedEmojiPack[]> {
    const admitted:VerifiedEmojiPack[]=[];
    for(const pin of style?[style.primary,...style.fallbacks]:[]) {
      const key=JSON.stringify(pin);let pending=packs.get(key);
      if(!pending){pending=(async()=>{const bytes=await api.manifest(pin);if(!bytes)return null;const value=await readEmojiPack(bytes,pin);return value.ok?value.pack:null;})();packs.set(key,pending);}
      const pack=await pending;if(pack)admitted.push(pack);
    }
    return admitted;
  }
  const io={loadArtwork:async(pin:Parameters<EmojiAPI['artwork']>[0],asset:Parameters<EmojiAPI['artwork']>[1])=>{const bytes=await api.artwork(pin,asset);if(!bytes)throw new Error('Emoji artwork is unavailable.');return bytes;},parseXml:api.parseXml as Parameters<typeof prepareEmojiText>[3]['parseXml']};
  return {
    async layoutRuns(request:TextLayoutRequestV1):Promise<TextLayoutV1> {
      used=true;
      if(!text?.layoutRuns)throw new Error('This engine cannot compose text paragraphs.');
      const style=selected(),{prepareParagraphEmoji}=await import('./text-emoji.ts');
      const prepared=await prepareParagraphEmoji(request,style,await packsFor(style),io,artwork);
      const layout=await text.layoutRuns(prepared.request);
      layout.diagnostics.push(...prepared.diagnostics);
      const key=await sha256Hex(new TextEncoder().encode(JSON.stringify([prepared.story,style])));
      census=[];
      for(const [index,frame] of layout.frames.entries()){
        const visible=prepared.census.map(source=>({...source,occurrences:source.occurrences.filter(range=>range.start>=frame.start&&range.end<=frame.end)})).filter(source=>source.occurrences.length);
        const marker=`paragraph-${key}-${index}`;sources.set(marker,visible);census.push(...visible);
        const missing=prepared.diagnostics.filter(issue=>issue.start>=frame.start&&issue.end<=frame.end).length;
        if(frame.svg)frame.svg=frame.svg.replace('<svg ',`<svg data-emoji-tool-source="${marker}"${missing ? ` data-text-emoji-missing="${missing}"` : ''} `);
      }
      layout.emojiSources=structuredClone(census);
      while(sources.size>512)sources.delete(sources.keys().next().value!);
      for(const item of prepared.request.artwork)if(item.sha256 && !layout.resources.some(resource=>resource.id===item.id&&resource.sha256===item.sha256))layout.resources.push({id:item.id,sha256:item.sha256});
      return layout;
    },
    async renderSvg(source:string):Promise<string> {
      used=true;
      if(typeof source!=='string'||source.length>4*1024*1024||/<!DOCTYPE|<!ENTITY/i.test(source))throw new Error('SVG text exceeds the supported input budget.');
      const doc=api.parseXml(source) as {documentElement:{localName:string;outerHTML:string};querySelector(selector:string):unknown};
      if(doc.documentElement?.localName!=='svg'||doc.querySelector('parsererror'))throw new Error('Invalid SVG text source.');
      const style=selected();
      const result=await (await import('./emoji-svg-text.ts')).applyEmojiToSvgText(doc.documentElement,style,await packsFor(style),io,text,{cache:artwork});
      census=result.census;
      return doc.documentElement.outerHTML;
    },
    get used() { return used; },
    censusFor(texts:readonly string[]) { return [...new Set(texts)].flatMap(text => sources.get(text) ?? []); },
    get census() { return census; },
    clear() { census = []; sources.clear(); },
    async renderText(opts: EmojiTextRenderOpts): Promise<{svg:string;width:number;height:number;baseline:number;advanceWidth:number}> {
      used = true;
      const style = selected();
      if (typeof opts.text !== 'string' || opts.text.length > 4096 || requiresEmojiBidiLayout(opts.text) || /[\r\n\u2028\u2029]/.test(opts.text)) throw new Error('Artwork text needs one bounded left-to-right line.');
      const size = opts.fontSize ?? 200, spacing = opts.letterSpacing ?? 0;
      if (!Number.isFinite(size) || size < 1 || size > 1024 || !Number.isFinite(spacing) || Math.abs(spacing) > size) throw new Error('Artwork text has unsupported sizing.');
      const prepared = await prepareEmojiText(opts.text,style,await packsFor(style),io,{cache:artwork,prefix:'tooltext'});
      const fill = opts.fill && /^#[0-9a-f]{3,8}$/i.test(opts.fill) ? opts.fill : '#000000';
      let font: Awaited<ReturnType<NonNullable<TextAPI['fontUrl']>>> = null;
      if (text?.fontUrl) font = await text.fontUrl(opts.fontFamily || 'SUSE',{weight:opts.fontWeight ?? 700});
      let outputSize = 0;
      let x = 0, top = -size, bottom = size * .3;
      const parts: string[] = [];
      const num = (v:number):string => String(Math.round(v*1e6)/1e6);
      for (const segment of prepared.segments) {
        if (segment.kind === 'text') {
          if (!font || !text) throw new Error('The selected face is unavailable for artwork text.');
          const run = await text.toPath({text:segment.text,fontUrl:font.url,fontSize:size,variations:font.variations,letterSpacing:spacing,preserveWhitespaceAdvance:true});
          if (run.notdef) throw new Error('The selected face does not cover this artwork text.');
          parts.push(`<path transform="translate(${num(x)} 0)" fill="${fill}" d="${escapeXml(run.d)}"/>`);
          x += run.advanceWidth;
          if (run.bbox) { top = Math.min(top,run.bbox.y1); bottom = Math.max(bottom,run.bbox.y2); }
        } else if (segment.kind === 'emoji') {
          const m = segment.metrics, y = (m.descentEm-m.heightEm)*size;
          parts.push(segment.markup.replace(/<svg\b[^>]*>/, tag => tag.replace(/ (?:width|height|x|y)="[^"]*"/g,'').replace('<svg',`<svg x="${num(x)}" y="${num(y)}" width="${num(m.widthEm*size)}" height="${num(m.heightEm*size)}"`)));
          x += m.advanceEm*size+spacing; top = Math.min(top,y); bottom = Math.max(bottom,m.descentEm*size);
        } else {
          parts.push(`<rect x="${num(x+size*.1)}" y="${num(-size*.75)}" width="${num(size*.7)}" height="${num(size*.8)}" fill="none" stroke="${fill}" stroke-width="${num(size*.05)}"/>`); x += size;
        }
        outputSize += parts.at(-1)?.length ?? 0;
        if (x > 16384 || x < 0 || outputSize > 4*1024*1024) throw new Error('Artwork text exceeds the layout budget.');
      }
      census = prepared.census; sources.set(opts.text,census);
      if (sources.size > 64) sources.delete(sources.keys().next().value!);
      const width = Math.max(1,Math.ceil(x+2)), height = Math.max(1,Math.ceil(bottom-top+2));
      return { width,height,baseline:1-top,advanceWidth:x,svg:`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="-1 ${num(top-1)} ${width} ${height}" color="${fill}">${parts.join('')}</svg>` };
    },
  };
}
