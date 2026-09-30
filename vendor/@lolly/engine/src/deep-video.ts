// SPDX-License-Identifier: MPL-2.0
/** WebCodecs raw planes to linear float, before any browser canvas conversion. */
import { halfToFloat, type DeepFrame } from './pixels.ts';
import { deepDimensions, decodeTransfer, cicpSpace, validateDeepFrame } from './deep-image.ts';
export interface VideoPlanes {
  width: number; height: number; format: string; bytes: Uint8Array;
  layout: readonly { offset: number; stride: number }[];
  colorSpace: { primaries?: string | null; transfer?: string | null; matrix?: string | null; fullRange?: boolean | null };
}
export function decodeVideoPlanes(input: VideoPlanes): DeepFrame {
  const { width, height, bytes, layout, format, colorSpace: color } = input; deepDimensions(width,height);
  const primaries = ({ bt709:1, bt2020:9, smpte432:12 } as Record<string,number>)[color.primaries ?? 'bt709'];
  const transfer = ({ bt709:1, smpte170m:6, 'iec61966-2-1':13, linear:8, pq:16, smpte2084:16, hlg:18, 'arib-std-b67':18 } as Record<string,number>)[color.transfer ?? 'bt709'];
  if (!primaries || !transfer) throw new Error('This video colour space is not supported for HDR editing.');
  const rgba = new Float32Array(width*height*4), view = new DataView(bytes.buffer,bytes.byteOffset,bytes.length);
  const plane = (index:number,w:number,h:number,bpp:number) => {
    const p = layout[index];
    if (!p || !Number.isInteger(p.offset) || p.offset < 0 || !Number.isInteger(p.stride) || p.stride < w*bpp || p.offset+(h-1)*p.stride+w*bpp > bytes.length) throw new Error('Invalid raw video plane.');
    return p;
  };
  if (/^(RGBA|RGBX|BGRA|BGRX|RGBAF16)$/.test(format)) {
    const half = format === 'RGBAF16', p = plane(0,width,height,half?8:4), bgr = format.startsWith('BG');
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const at=p.offset+y*p.stride+x*(half?8:4),d=(y*width+x)*4;
      for(let c=0;c<4;c++) rgba[d+c]=c===3&&format.endsWith('X')?1:half?halfToFloat(view.getUint16(at+c*2,true)):bytes[at+(c<3&&bgr?2-c:c)]!/255;
    }
  } else {
    const match = /^I(420|422|444)(A)?(?:P(10|12))?$/.exec(format), nv12 = format === 'NV12';
    if (!match && !nv12) throw new Error(`Raw ${format} video cannot be edited at full precision.`);
    const bits=Number(match?.[3]??8), bps=bits>8?2:1, subsampling=match?.[1]??'420';
    const sx=subsampling==='444'?1:2,sy=subsampling==='420'?2:1,cw=Math.ceil(width/sx),ch=Math.ceil(height/sy);
    const yp=plane(0,width,height,bps),up=plane(1,cw,ch,nv12?2:bps),vp=nv12?up:plane(2,cw,ch,bps),ap=match?.[2]?plane(3,width,height,bps):null;
    const read=(at:number)=>bps===2?view.getUint16(at,true):bytes[at]!;
    const max=(1<<bits)-1,scale=1<<(bits-8),full=color.fullRange===true;
    const matrix=color.matrix??'bt709';
    const coeff=matrix==='bt2020-ncl'?[.2627,.0593]:matrix==='bt709'?[.2126,.0722]:matrix==='smpte170m'||matrix==='bt470bg'?[.299,.114]:null;
    if(!coeff)throw new Error(`HDR editing cannot decode the ${matrix} YUV matrix.`);
    const [kr,kb]=coeff as [number,number],kg=1-kr-kb;
    for(let y=0;y<height;y++)for(let x=0;x<width;x++) {
      const yy=read(yp.offset+y*yp.stride+x*bps),cx=Math.floor(x/sx),cy=Math.floor(y/sy);
      const u=nv12?bytes[up.offset+cy*up.stride+cx*2]!:read(up.offset+cy*up.stride+cx*bps);
      const v=nv12?bytes[vp.offset+cy*vp.stride+cx*2+1]!:read(vp.offset+cy*vp.stride+cx*bps);
      const Y=full?yy/max:(yy-16*scale)/(219*scale),U=(u-128*scale)/(full?max:224*scale),V=(v-128*scale)/(full?max:224*scale);
      const r=Y+2*(1-kr)*V,b=Y+2*(1-kb)*U,at=(y*width+x)*4;
      rgba[at]=r;rgba[at+1]=(Y-kr*r-kb*b)/kg;rgba[at+2]=b;rgba[at+3]=ap?read(ap.offset+y*ap.stride+x*bps)/max:1;
    }
  }
  const frame=decodeTransfer({width,height,data:rgba,space:cicpSpace(primaries)},transfer);validateDeepFrame(frame);return frame;
}
