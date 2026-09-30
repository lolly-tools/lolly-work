// SPDX-License-Identifier: MPL-2.0
/** Bounded PNG 8/16 ingest, including Adam7, ICC and PQ/HLG cICP. */
import { unzlibSync } from 'fflate';
import { crc32 } from './zip-crypto.ts';
import { adler32 } from './deflate.ts';
import { unfilterPng } from './png-unfilter.ts';
import { convertSpace, type DeepFrame } from './pixels.ts';
import { parseIccProfile } from './icc.ts';
import { applyIccToFrame, ICC_DEVICE_SPACE } from './icc-pixels.ts';
import { cicpSpace, decodeTransfer, deepDimensions, DEEP_MAX_BYTES } from './deep-image.ts';

export function inflateDeep(bytes: Uint8Array, expected: number): Uint8Array {
  if (expected > DEEP_MAX_BYTES || bytes.length < 6) throw new Error('HDR image exceeds its decompression budget.');
  const output = unzlibSync(bytes, { out: new Uint8Array(expected + 1) });
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (output.length !== expected || adler32(output) !== view.getUint32(bytes.length - 4)) throw new Error('Corrupt or oversized compressed HDR pixels.');
  return output;
}

export function readDeepPng(bytes: Uint8Array): DeepFrame | null {
  if (bytes.length < 8 || ![137,80,78,71,13,10,26,10].every((b, i) => bytes[i] === b)) return null;
  if (bytes.length > DEEP_MAX_BYTES) throw new Error('PNG exceeds the HDR input limit.');
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  let width = 0, height = 0, depth = 0, color = 0, interlace = 0, gamma: number | undefined, srgb = false, ended = false;
  let chroma: number[] | undefined, oriented = false;
  let icc: Uint8Array | undefined, cicp: Uint8Array | undefined, trns: Uint8Array | undefined;
  const data: Uint8Array[] = []; let length = 0;
  for (let at = 8; at + 12 <= bytes.length;) {
    const size = view.getUint32(at), end = at + 12 + size;
    if (end > bytes.length || size > DEEP_MAX_BYTES) throw new Error('Truncated PNG chunk.');
    const type = String.fromCharCode(...bytes.subarray(at + 4, at + 8));
    const chunk = bytes.subarray(at + 8, end - 4);
    if (crc32(bytes.subarray(at + 4, end - 4)) !== view.getUint32(end - 4)) throw new Error('PNG chunk checksum mismatch.');
    if (type === 'IHDR') {
      if (at !== 8 || size !== 13) throw new Error('Invalid PNG header.');
      width = view.getUint32(at + 8); height = view.getUint32(at + 12); depth = chunk[8]!; color = chunk[9]!; interlace = chunk[12]!;
      deepDimensions(width, height);
      if (![1,2,4,8,16].includes(depth) || ![0,2,3,4,6].includes(color)) throw new Error('Invalid PNG sample format.');
      if (chunk[10] || chunk[11] || interlace > 1) throw new Error('Unsupported PNG coding.');
    } else if (type === 'IDAT') { data.push(chunk); length += size; }
    else if (type === 'cICP') { if (size !== 4) throw new Error('Invalid PNG cICP.'); cicp = chunk; }
    else if (type === 'gAMA') {
      if (size !== 4 || !view.getUint32(at + 8)) throw new Error('Invalid PNG gamma.');
      gamma = view.getUint32(at + 8) / 100000;
    } else if (type === 'cHRM') {
      if (size !== 32) throw new Error('Invalid PNG chromaticities.');
      chroma = Array.from({length:8},(_,i)=>view.getUint32(at+8+i*4)/100000);
    } else if (type === 'eXIf') {
      if (size < 8 || !((chunk[0] === 73 && chunk[1] === 73) || (chunk[0] === 77 && chunk[1] === 77))) throw new Error('Invalid PNG EXIF.');
      const ev = new DataView(chunk.buffer,chunk.byteOffset,chunk.length), le = chunk[0] === 73, offset = ev.getUint32(4,le);
      if (offset + 2 > size) throw new Error('Invalid PNG EXIF directory.');
      const count = ev.getUint16(offset,le);
      if (count > 512 || offset + 2 + count*12 > size) throw new Error('Invalid PNG EXIF directory.');
      for(let i=0;i<count;i++){const p=offset+2+i*12;if(ev.getUint16(p,le)===274) oriented=ev.getUint16(p+8,le)!==1;}
    }
    else if (type === 'sRGB') srgb = true;
    else if (type === 'tRNS') trns = chunk;
    else if (type === 'iCCP') {
      const zero = chunk.indexOf(0);
      if (zero < 1 || zero > 79 || chunk[zero + 1] !== 0) throw new Error('Invalid PNG ICC profile.');
      const compressedProfile = chunk.subarray(zero + 2);
      if (compressedProfile.length < 6) throw new Error('Truncated PNG ICC profile.');
      icc = unzlibSync(compressedProfile, { out: new Uint8Array(4 * 1024 * 1024 + 1) });
      if (icc.length > 4 * 1024 * 1024) throw new Error('PNG ICC profile exceeds 4 MiB.');
      if (adler32(icc) !== new DataView(compressedProfile.buffer,compressedProfile.byteOffset,compressedProfile.length).getUint32(compressedProfile.length-4)) throw new Error('PNG ICC checksum mismatch.');
    } else if (type === 'acTL') throw new Error('Animated PNG needs a timed image decoder.');
    else if (type === 'IEND') { if (size) throw new Error('Invalid PNG end chunk.'); ended = true; break; }
    at = end;
  }
  if (!width || !height || !ended || !length) throw new Error('Incomplete PNG image.');
  if (oriented) throw new Error('Apply the PNG EXIF orientation before HDR editing.');
  if (![8,16].includes(depth) || color === 3) {
    if (icc || cicp || chroma || gamma && gamma !== .45455) throw new Error('Convert this colour-managed palette PNG to RGB before HDR editing.');
    return null;
  }
  const channels = color === 0 ? 1 : color === 2 ? 3 : color === 4 ? 2 : 4;
  const bpp = channels * depth / 8;
  const passes = interlace ? [[0,0,8,8],[4,0,8,8],[0,4,4,8],[2,0,4,4],[0,2,2,4],[1,0,2,2],[0,1,1,2]] : [[0,0,1,1]];
  const sizes = passes.map(([x,y,dx,dy]) => [Math.max(0, Math.ceil((width - x!) / dx!)), Math.max(0, Math.ceil((height - y!) / dy!))]);
  const expected = sizes.reduce((sum, [w,h]) => sum + (w && h ? (w * bpp + 1) * h : 0), 0);
  const compressed = new Uint8Array(length); let at = 0;
  for (const part of data) { compressed.set(part, at); at += part.length; }
  const inflated = inflateDeep(compressed, expected);
  const rgba = new Float32Array(width * height * 4); at = 0;
  const max = depth === 16 ? 65535 : 255;
  const transparent = trns ? new DataView(trns.buffer, trns.byteOffset, trns.byteLength) : undefined;
  for (let p = 0; p < passes.length; p++) {
    const [x,y,dx,dy] = passes[p]!, [w,h] = sizes[p]!; if (!w || !h) continue;
    const size = (w * bpp + 1) * h;
    const raw = unfilterPng(inflated.subarray(at, at + size), w, h, bpp); at += size;
    if (!raw) throw new Error('Invalid PNG row filters.');
    const sample = (i: number) => depth === 16 ? raw[i * 2]! * 256 + raw[i * 2 + 1]! : raw[i]!;
    for (let py = 0; py < h; py++) for (let px = 0; px < w; px++) {
      const s = (py * w + px) * channels, d = ((y! + py * dy!) * width + x! + px * dx!) * 4;
      const gray = color === 0 || color === 4;
      for (let c = 0; c < 3; c++) rgba[d + c] = sample(s + (gray ? 0 : c)) / max;
      rgba[d + 3] = color === 4 || color === 6 ? sample(s + channels - 1) / max : 1;
      if (transparent && (color === 0 || color === 2)) {
        if (transparent.byteLength !== channels * 2) throw new Error('Invalid PNG transparency key.');
        let match = true; for (let c = 0; c < channels; c++) if (sample(s + c) !== transparent.getUint16(c * 2)) match = false;
        if (match) rgba[d + 3] = 0;
      }
    }
  }
  const frame: DeepFrame = { width, height, data: rgba, space: 'srgb-linear' };
  if (cicp) {
    if (cicp[2] !== 0 || cicp[3] !== 1 || ![1,6,8,13,14,15,16,18].includes(cicp[1]!)) throw new Error('Unsupported PNG colour encoding.');
    return decodeTransfer({ ...frame, space: cicpSpace(cicp[0]!) }, cicp[1]!);
  }
  if (icc) {
    const profile = parseIccProfile(icc); const pcs = profile && applyIccToFrame({ ...frame, space: ICC_DEVICE_SPACE }, profile, 'toPcs', 'relative');
    if (!pcs) throw new Error('The PNG colour profile cannot be converted at full precision.');
    return convertSpace(pcs, 'srgb-linear');
  }
  if (chroma && !srgb) {
    const choices: [DeepFrame['space'],number[]][] = [['srgb-linear',[.3127,.329,.64,.33,.3,.6,.15,.06]],['display-p3-linear',[.3127,.329,.68,.32,.265,.69,.15,.06]],['rec2020-linear',[.3127,.329,.708,.292,.17,.797,.131,.046]]];
    const match = choices.find(([,values])=>values.every((n,i)=>Math.abs(n-chroma![i]!)<.00002));
    if (!match) throw new Error('Convert this PNG to sRGB, Display P3 or Rec.2020 before HDR editing.');
    frame.space = match[0];
  }
  return decodeTransfer(frame, 13, srgb ? undefined : gamma);
}
