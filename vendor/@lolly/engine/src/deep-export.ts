// SPDX-License-Identifier: MPL-2.0
/** Encode a real float render without rasterising its display preview. */
import type { CodecFrame, ExportMeta } from '@lolly-tools/core/host-v1';
import { convertSpace, type DeepFrame, linearToSrgb } from './pixels.ts';
import { validateDeepFrame, deepPreview } from './deep-image.ts';
import { encodeExr, encodeRadiance, encodePng16 } from './deep-encode.ts';
import { pqEncodeFrame, pqToU16 } from './hdr.ts';
import { packPng } from './png.ts';
import { packTiff } from './tiff.ts';
import { pqBt2020IccProfile } from './color.ts';
import { insertPngMeta, insertPngXmp, insertPngIcc, buildExportXmp } from './image-meta.ts';
import { parseDimension, toPixels, isPhysical } from './units.ts';
import { resizeDeep } from './deep-compose.ts';
import { jxlWithXmp } from './jxl-container.ts';
import type { JxlRequest, JxlResult } from './jxl.ts';
export interface DeepExportOptions { width?: number | string; height?: number | string; scale?: number; hdr?: boolean | number; depth?: 8 | 16 | 'float' | 'auto'; quality?: number; dpi?: number; meta?: ExportMeta; c2pa?: boolean }
export interface DeepExportIO { jxl(request: JxlRequest): Promise<JxlResult>; sdr?(data: Uint8ClampedArray, width: number, height: number, format: string, options: DeepExportOptions): Promise<Blob> }
export async function exportDeepFrame(input: CodecFrame, format: string, opts: DeepExportOptions, io: DeepExportIO): Promise<Blob> {
  let frame: DeepFrame = { ...input, space: input.space ?? 'srgb-linear' }; validateDeepFrame(frame);
  const w = parseDimension(opts.width), h = parseDimension(opts.height), dpi = opts.dpi ?? (isPhysical(w) || isPhysical(h) ? 300 : 96);
  if (opts.width != null && !w || opts.height != null && !h || !Number.isFinite(dpi) || dpi <= 0) throw new Error('Invalid HDR export dimensions.');
  const scale = w || h ? 1 : opts.scale ?? 1;
  const width = w ? toPixels(w,dpi) : h ? Math.round(toPixels(h,dpi)*frame.width/frame.height) : Math.round(frame.width*scale);
  const height = h ? toPixels(h,dpi) : w ? Math.round(toPixels(w,dpi)*frame.height/frame.width) : Math.round(frame.height*scale);
  if (width !== frame.width || height !== frame.height) frame = resizeDeep(frame,width,height);
  opts = { ...opts, dpi };
  let bytes: Uint8Array, mime: string;
  const hdr = !!opts.hdr, pq = () => pqToU16(pqEncodeFrame(frame));
  if (format === 'exr') { bytes = encodeExr(frame, { pixelType: opts.depth === 'float' ? 'float' : 'half' }); mime = 'image/x-exr'; }
  else if (format === 'hdr' || format === 'rgbe') {
    for (let i=3;i<frame.data.length;i+=4) if (frame.data[i]! < .99999) throw new Error('Radiance needs an opaque background. Use EXR to retain transparency.');
    bytes = encodeRadiance(frame); mime = 'image/vnd.radiance'; }
  else if (format === 'png') {
    bytes = hdr ? packPng(pq(), { width: frame.width, height: frame.height, channels: 4, depth: 16, dpi: opts.dpi, cicp: { primaries: 9, transfer: 16, matrix: 0, fullRange: 1 } })
      : opts.depth === 8 ? packPng(deepPreview(frame), { width: frame.width, height: frame.height, depth: 8, dpi: opts.dpi }) : encodePng16(displayFrame(frame), { dpi: opts.dpi });
    if (hdr) bytes = await insertPngIcc(bytes, pqBt2020IccProfile(), 'Rec2100 PQ');
    bytes = insertPngXmp(insertPngMeta(bytes, opts.meta), opts.meta); mime = 'image/png';
  } else if (format === 'jxl' || format === 'jxl-lossless') {
    if (opts.c2pa) throw new Error('JPEG XL Content Credentials are unavailable. Choose HDR PNG for a signed export.');
    const pixels = hdr ? pq() : sdr16(frame);
    const result = await io.jxl({ operation: 'encode', width: frame.width, height: frame.height, bytes: new Uint8Array(pixels.buffer), sample: hdr ? 3 : 1, options: { lossless: format === 'jxl-lossless', quality: opts.quality } });
    bytes = jxlWithXmp(result.bytes, buildExportXmp(opts.meta)); mime = 'image/jxl';
  } else if (format === 'tiff') {
    const linear = convertSpace(frame, 'srgb-linear'), floats = opts.depth === 'float';
    const values = floats ? linear.data : hdr ? pq() : sdr16(frame);
    const rgb = floats ? new Float32Array(frame.width*frame.height*3) : new Uint16Array(frame.width*frame.height*3);
    for (let p = 0; p < frame.width*frame.height; p++) {
      if (frame.data[p*4+3]! < .99999) throw new Error('Float TIFF export needs an opaque background. Use PNG or EXR to retain transparency.');
      for (let c = 0; c < 3; c++) rgb[p*3+c] = values[p*4+c]!;
    }
    bytes = packTiff(rgb, { width: frame.width, height: frame.height, depth: floats ? 'float32' : 16, dpi: opts.dpi, meta: opts.meta, ...(hdr && !floats ? { icc: pqBt2020IccProfile() } : {}) }); mime = 'image/tiff';
  } else {
    if (hdr) throw new Error('Choose PNG, JPEG XL, TIFF, OpenEXR or Radiance for a true HDR still.');
    if (!io.sdr) throw new Error(`SDR conversion to ${format} is unavailable in this shell.`);
    return io.sdr(deepPreview(frame), frame.width, frame.height, format, opts);
  }
  return new Blob([bytes as BlobPart], { type: mime });
}
/** SDR display mapping stays float until the selected encoder quantises it. */
function displayFrame(frame: DeepFrame): DeepFrame {
  const source = convertSpace(frame, 'srgb-linear'), data = new Float32Array(source.data);
  for (let i = 0; i < data.length; i += 4) {
    const peak = Math.max(0, data[i]!, data[i+1]!, data[i+2]!);
    const mapped = peak <= .75 ? peak : .75+.25*(1-Math.exp(-4*(peak-.75))), scale = peak ? mapped/peak : 1;
    for (let c = 0; c < 3; c++) data[i+c] = Math.max(0, data[i+c]!) * scale;
  }
  return { ...source, data };
}
function sdr16(frame: DeepFrame): Uint16Array {
  const mapped = displayFrame(frame), data = new Uint16Array(mapped.data.length);
  for (let i = 0; i < data.length; i++) data[i] = Math.round(Math.min(1, Math.max(0, i%4 === 3 ? mapped.data[i]! : linearToSrgb(mapped.data[i]!))) * 65535);
  return data;
}
