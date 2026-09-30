// SPDX-License-Identifier: MPL-2.0
/** Original-byte HDR decode. Hosts supply only codecs that need a platform. */
import { readDeepPng } from './deep-png.ts';
import { readDeepTiff } from './deep-tiff.ts';
import { readDeepExr } from './deep-exr.ts';
import { readRadiance } from './radiance.ts';
import { isJxl, type JxlRequest, type JxlResult } from './jxl.ts';
import { DEEP_MAX_BYTES, HDR_WHITE_NITS, deepDimensions, validateDeepFrame } from './deep-image.ts';
import { type DeepFrame, fromU8Srgb } from './pixels.ts';
export interface DeepDecodeIO {
  jxl(request: JxlRequest): Promise<JxlResult>;
  sdr(bytes: Uint8Array): Promise<{ width: number; height: number; data: Uint8ClampedArray }>;
}
export async function decodeDeepImage(bytes: Uint8Array, io: DeepDecodeIO): Promise<DeepFrame> {
  if (!bytes.length || bytes.length > DEEP_MAX_BYTES) throw new Error('HDR image inputs must be between 1 byte and 128 MiB.');
  let frame: DeepFrame | null = null;
  if (isJxl(bytes)) {
    const { info } = await io.jxl({ operation: 'probe', bytes });
    if (!info || info.animated) throw new Error('Choose a still JPEG XL image for HDR editing.');
    deepDimensions(info.width, info.height);
    const result = await io.jxl({ operation: 'decodeFloat', bytes });
    if (result.bytes.byteLength !== info.width * info.height * 16) throw new Error('Invalid float JPEG XL frame.');
    const data = new Float32Array(result.bytes.slice().buffer);
    // libjxl normalises PQ/HLG to the image intensity target. Our diffuse white is 203 nits.
    if (info.transferFunction === 16 || info.transferFunction === 18) {
      const scale = info.intensityTarget / HDR_WHITE_NITS;
      if (!Number.isFinite(scale) || scale <= 0) throw new Error('JPEG XL has no usable HDR intensity target.');
      for (let i = 0; i < data.length; i += 4) for (let c = 0; c < 3; c++) data[i + c] = data[i + c]! * scale;
    }
    frame = { width: info.width, height: info.height, data, space: 'srgb-linear' };
  } else frame = readDeepPng(bytes) ?? readDeepTiff(bytes) ?? readDeepExr(bytes) ?? readRadiance(bytes);
  if (!frame) {
    // Only inherently SDR inputs may cross an 8-bit decoder boundary.
    const jpeg = bytes[0] === 255 && bytes[1] === 216;
    if (jpeg && /hdr-gain-map|hdrgm:|urn:iso:std:iso:ts:21496/.test(new TextDecoder().decode(bytes.subarray(0,1024*1024)))) throw new Error('JPEG gain maps need an HDR decoder. Convert this image to HDR PNG or JPEG XL before editing.');
    const png = bytes[0] === 137 && bytes[1] === 80 && bytes[24]! <= 8;
    const svg = /<svg[\s>]/.test(new TextDecoder().decode(bytes.subarray(0, 4096)));
    if (!jpeg && !png && !svg) throw new Error('HDR editing accepts PNG, JPEG XL, EXR, Radiance and TIFF originals, plus SDR JPEG and SVG. Convert other formats first.');
    const decoded = await io.sdr(bytes); deepDimensions(decoded.width, decoded.height);
    frame = fromU8Srgb(decoded.data, decoded.width, decoded.height);
  }
  validateDeepFrame(frame); return frame;
}
