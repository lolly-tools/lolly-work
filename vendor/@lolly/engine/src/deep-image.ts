// SPDX-License-Identifier: MPL-2.0
/** Shared precision limits and transfer functions for deep stills and video. */
import { convertSpace, srgbToLinear, linearToSrgb, type DeepFrame, type PixelSpace } from './pixels.ts';
export const DEEP_MAX_PIXELS = 8_388_608;
export const DEEP_MAX_BYTES = 128 * 1024 * 1024;
export const HDR_WHITE_NITS = 203;
export function deepDimensions(width: number, height: number): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > 16384 || height > 16384 || width * height > DEEP_MAX_PIXELS) throw new Error('HDR editing is limited to 8.4 megapixels and 16384 pixels per edge.');
}
export function validateDeepFrame(frame: DeepFrame): void {
  deepDimensions(frame.width, frame.height);
  if (!(frame.data instanceof Float32Array) || frame.data.length !== frame.width * frame.height * 4) throw new Error('Invalid HDR pixel buffer.');
  if (!['srgb-linear', 'display-p3-linear', 'rec2020-linear'].includes(frame.space)) throw new Error('HDR editing requires a linear RGB working space.');
  for (let i = 0; i < frame.data.length; i++) if (!Number.isFinite(frame.data[i]) || Math.abs(frame.data[i]!) > 1e6 || i % 4 === 3 && (frame.data[i]! < 0 || frame.data[i]! > 1)) throw new Error('HDR pixels must be finite and within the editing range.');
}
/** ST 2084 EOTF in nits, with the same constants as pqEncode. */
export function pqDecode(signal: number): number {
  const p = Math.max(0, Math.min(1, signal)) ** (1 / (2523 / 32));
  return 10000 * (Math.max(p - 3424 / 4096, 0) / Math.max(2413 / 128 - 2392 / 128 * p, 1e-12)) ** (1 / (2610 / 16384));
}
/** BT.2100 HLG OETF inverse, before the system gamma is applied to luminance. */
export function hlgScene(signal: number): number {
  const a = .17883277, b = 1 - 4 * a, c = .5 - a * Math.log(4 * a);
  return signal <= .5 ? signal * signal / 3 : (Math.exp((signal - c) / a) + b) / 12;
}
export function decodeTransfer(frame: DeepFrame, transfer: number, gamma?: number): DeepFrame {
  const data = new Float32Array(frame.data);
  for (let i = 0; i < data.length; i += 4) {
    for (let c = 0; c < 3; c++) {
      const v = data[i + c]!;
      data[i + c] = transfer === 16 ? pqDecode(v) / HDR_WHITE_NITS : transfer === 18 ? hlgScene(v)
        : transfer === 8 ? v : gamma ? Math.max(0, v) ** (1 / gamma)
          : transfer === 1 || transfer === 6 || transfer === 14 || transfer === 15 ? (v < .081 ? v / 4.5 : ((v + .099) / 1.099) ** (1 / .45)) : srgbToLinear(v);
    }
    if (transfer === 18) {
      const luma = Math.max(0, .2627 * data[i]! + .678 * data[i + 1]! + .0593 * data[i + 2]!);
      const scale = 1000 / HDR_WHITE_NITS * luma ** .2;
      data[i] = data[i]! * scale; data[i + 1] = data[i + 1]! * scale; data[i + 2] = data[i + 2]! * scale;
    }
  }
  return { ...frame, data };
}
export function cicpSpace(primaries: number): PixelSpace {
  if (primaries === 1) return 'srgb-linear';
  if (primaries === 9) return 'rec2020-linear';
  if (primaries === 12) return 'display-p3-linear';
  throw new Error(`Unsupported HDR colour primaries: ${primaries}.`);
}
/** Preview only. A highlight shoulder preserves ordering above diffuse white. */
export function deepPreview(frame: DeepFrame, exposure = 0): Uint8ClampedArray {
  validateDeepFrame(frame);
  if (!Number.isFinite(exposure) || Math.abs(exposure) > 24) throw new Error('Invalid preview exposure.');
  const source = convertSpace(frame, 'srgb-linear'); const out = new Uint8ClampedArray(source.data.length);
  const gain = 2 ** exposure;
  for (let i = 0; i < out.length; i += 4) {
    const r = Math.max(0, source.data[i]! * gain), g = Math.max(0, source.data[i + 1]! * gain), b = Math.max(0, source.data[i + 2]! * gain);
    const peak = Math.max(r, g, b); const mapped = peak <= .75 ? peak : .75 + .25 * (1 - Math.exp(-4 * (peak - .75)));
    const scale = peak ? mapped / peak : 1;
    out[i] = linearToSrgb(r * scale) * 255; out[i + 1] = linearToSrgb(g * scale) * 255; out[i + 2] = linearToSrgb(b * scale) * 255;
    out[i + 3] = source.data[i + 3]! * 255;
  }
  return out;
}
