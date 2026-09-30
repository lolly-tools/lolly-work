// SPDX-License-Identifier: MPL-2.0
/** Linear-light compositing with premultiplied interpolation and straight storage. */
import { type DeepFrame, convertSpace, createDeepFrame } from './pixels.ts';
import { deepDimensions, validateDeepFrame } from './deep-image.ts';
export type DeepMatrix = readonly [number, number, number, number, number, number];
export interface DeepLayer { frame: DeepFrame; matrix?: DeepMatrix; opacity?: number; blend?: string; mask?: Uint8ClampedArray }
const clamp = (n: number): number => Math.max(0, Math.min(1, n));
export const DEEP_BLENDS = ['source-over', 'normal', 'multiply', 'screen', 'overlay', 'darken', 'lighten', 'difference', 'exclusion', 'plus-lighter'] as const;
function blendChannel(a: number, b: number, mode: string): number {
  switch (mode) {
    case 'multiply': return a * b;
    case 'screen': return a + b - a * b;
    case 'overlay': return a <= .5 ? 2 * a * b : 1 - 2 * (1 - a) * (1 - b);
    case 'darken': return Math.min(a, b);
    case 'lighten': return Math.max(a, b);
    case 'difference': return Math.abs(a - b);
    case 'exclusion': return a + b - 2 * a * b;
    default: return b;
  }
}
/** Mutates the destination only. Matrix maps source pixel edges into destination edges. */
export function drawDeep(target: DeepFrame, layer: DeepLayer): void {
  const { frame, opacity = 1, blend = 'source-over', mask } = layer;
  if (!DEEP_BLENDS.includes(blend as typeof DEEP_BLENDS[number])) throw new Error(`HDR compositing does not support ${blend}.`);
  if (!Number.isFinite(opacity) || opacity < 0 || opacity > 1) throw new Error('Invalid HDR layer opacity.');
  if (mask && mask.length !== target.width * target.height) throw new Error('Invalid HDR coverage mask.');
  const [a,b,c,d,e,f] = layer.matrix ?? [1,0,0,1,0,0];
  if (![a,b,c,d,e,f].every(Number.isFinite)) throw new Error('Invalid HDR layer transform.');
  const determinant = a * d - b * c; if (Math.abs(determinant) < 1e-12 || !opacity) return;
  const source = convertSpace(frame, target.space), src = source.data, dst = target.data;
  const corners = [[e,f],[a*frame.width+e,b*frame.width+f],[c*frame.height+e,d*frame.height+f],[a*frame.width+c*frame.height+e,b*frame.width+d*frame.height+f]];
  const left = Math.max(0, Math.floor(Math.min(...corners.map(p => p[0]!)))), top = Math.max(0, Math.floor(Math.min(...corners.map(p => p[1]!))));
  const right = Math.min(target.width, Math.ceil(Math.max(...corners.map(p => p[0]!)))), bottom = Math.min(target.height, Math.ceil(Math.max(...corners.map(p => p[1]!))));
  for (let y = top; y < bottom; y++) for (let x = left; x < right; x++) {
    const sx = (d * (x + .5 - e) - c * (y + .5 - f)) / determinant, sy = (-b * (x + .5 - e) + a * (y + .5 - f)) / determinant;
    if (sx < 0 || sx >= frame.width || sy < 0 || sy >= frame.height) continue;
    const fx = Math.max(0, Math.min(frame.width - 1, sx - .5)), fy = Math.max(0, Math.min(frame.height - 1, sy - .5));
    const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(x0+1, frame.width-1), y1 = Math.min(y0+1, frame.height-1), u = fx-x0, v = fy-y0;
    const ids = [(y0*frame.width+x0)*4,(y0*frame.width+x1)*4,(y1*frame.width+x0)*4,(y1*frame.width+x1)*4], weights = [(1-u)*(1-v),u*(1-v),(1-u)*v,u*v];
    let sa = 0; const rgb = [0,0,0];
    for (let k = 0; k < 4; k++) { const id = ids[k]!, wa = clamp(src[id+3]!) * weights[k]!; sa += wa;
      for (let ch = 0; ch < 3; ch++) rgb[ch] = rgb[ch]! + src[id+ch]! * wa;
    }
    if (!sa) continue;
    for (let ch = 0; ch < 3; ch++) rgb[ch] = rgb[ch]! / sa;
    sa *= opacity * (mask ? mask[y*target.width+x]! / 255 : 1);
    const at = (y*target.width+x)*4, da = clamp(dst[at+3]!), outA = blend === 'plus-lighter' ? Math.min(1, sa+da) : sa+da*(1-sa);
    for (let ch = 0; ch < 3; ch++) { const back = dst[at+ch]!, front = rgb[ch]!;
      const premul = blend === 'plus-lighter' ? front*sa+back*da : (1-sa)*da*back+(1-da)*sa*front+sa*da*blendChannel(back,front,blend);
      dst[at+ch] = outA ? premul/outA : 0;
    }
    dst[at+3] = outA;
  }
}
export function composeDeep(width: number, height: number, layers: readonly DeepLayer[], space: DeepFrame['space'] = 'srgb-linear'): DeepFrame {
  deepDimensions(width, height);
  if (layers.length > 256) throw new Error('HDR compositing accepts at most 256 layers.');
  const frame = createDeepFrame(width, height, space);
  for (const layer of layers) { validateDeepFrame(layer.frame); drawDeep(frame, layer); }
  return frame;
}
export function resizeDeep(frame: DeepFrame, width: number, height: number): DeepFrame {
  return composeDeep(width, height, [{ frame, matrix: [width/frame.width,0,0,height/frame.height,0,0] }], frame.space);
}
