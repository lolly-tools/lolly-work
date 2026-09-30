// SPDX-License-Identifier: MPL-2.0
/** Bounded classic TIFF RGB/gray strips at 8/16-bit integer or 32-bit float. */
import { inflateDeep } from './deep-png.ts';
import { convertSpace, type DeepFrame } from './pixels.ts';
import { deepDimensions, DEEP_MAX_BYTES, decodeTransfer, cicpSpace, validateDeepFrame } from './deep-image.ts';
import { parseIccProfile } from './icc.ts';
import { applyIccToFrame, ICC_DEVICE_SPACE } from './icc-pixels.ts';

export function readDeepTiff(bytes: Uint8Array): DeepFrame | null {
  if (bytes.length < 8 || !((bytes[0] === 73 && bytes[1] === 73) || (bytes[0] === 77 && bytes[1] === 77))) return null;
  const le = bytes[0] === 73, v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (v.getUint16(2, le) !== 42) throw new Error('HDR editing supports classic TIFF, not BigTIFF.');
  if (bytes.length > DEEP_MAX_BYTES) throw new Error('TIFF exceeds the HDR input limit.');
  const ifd = v.getUint32(4, le); if (ifd < 8 || ifd + 2 > bytes.length) throw new Error('Invalid TIFF directory.');
  const count = v.getUint16(ifd, le);
  if (count > 512 || ifd + 2 + count * 12 + 4 > bytes.length) throw new Error('Invalid TIFF directory size.');
  if (v.getUint32(ifd + 2 + count * 12, le)) throw new Error('Choose one page before HDR editing a multipage TIFF.');
  const tags = new Map<number, { type: number; count: number; at: number; size: number }>();
  const sizes: Record<number, number> = { 1:1, 2:1, 3:2, 4:4, 5:8, 7:1, 9:4, 11:4, 12:8 };
  for (let i = 0; i < count; i++) {
    const offset = ifd + 2 + i * 12, tag = v.getUint16(offset, le), type = v.getUint16(offset + 2, le), n = v.getUint32(offset + 4, le);
    const unit = sizes[type]; if (!unit) continue;
    const size = unit * n, at = size <= 4 ? offset + 8 : v.getUint32(offset + 8, le);
    if (!Number.isSafeInteger(size) || at + size > bytes.length || tags.has(tag)) throw new Error('Invalid TIFF field.');
    tags.set(tag, { type, count: n, at, size });
  }
  const list = (tag: number, fallback: number[] = []): number[] => { const item = tags.get(tag); if (!item) return fallback;
    if (![1,3,4].includes(item.type) || item.count > 65536) throw new Error(`Unsupported TIFF field ${tag}.`);
    return Array.from({ length: item.count }, (_, i) => item.type === 1 ? bytes[item.at + i]! : item.type === 3 ? v.getUint16(item.at + i * 2, le) : v.getUint32(item.at + i * 4, le)); };
  const one = (tag: number, fallback = 0) => list(tag, [fallback])[0]!;
  const width = one(256), height = one(257); deepDimensions(width, height);
  const spp = one(277, 1), depth = list(258, [8]), sample = list(339, [1]);
  const bits = depth[0]!, kind = sample[0]!, photo = one(262, 1), compression = one(259, 1), predictor = one(317, 1), orientation = one(274, 1);
  if (![1,2].includes(photo) || ![1,2,3,4].includes(spp) || photo === 2 && spp < 3 || photo === 1 && spp > 2
    || depth.some(n => n !== bits) || sample.some(n => n !== kind) || !([8,16].includes(bits) && kind === 1 || bits === 32 && kind === 3)
    || one(284, 1) !== 1 || ![1,8,32946].includes(compression) || ![1,2].includes(predictor) || kind === 3 && predictor !== 1 || orientation < 1 || orientation > 8 || tags.has(322)) {
    throw new Error('Use stripped RGB/gray TIFF with no compression or Deflate, at 8/16-bit integer or 32-bit float.');
  }
  const offsets = list(273), lengths = list(279), rows = one(278, height), extra = one(338, 0);
  if (!rows || offsets.length !== Math.ceil(height / rows) || lengths.length !== offsets.length) throw new Error('Invalid TIFF strips.');
  const hasAlpha = spp === 2 || spp === 4;
  if (hasAlpha && ![1,2].includes(extra)) throw new Error('TIFF alpha must declare associated or unassociated samples.');
  const rgba = new Float32Array(width * height * 4), bps = bits / 8;
  for (let strip = 0; strip < offsets.length; strip++) {
    const start = offsets[strip]!, size = lengths[strip]!, lines = Math.min(rows, height - strip * rows), expected = lines * width * spp * bps;
    if (start + size > bytes.length) throw new Error('Truncated TIFF strip.');
    const raw = compression === 1 ? bytes.slice(start, start + size) : inflateDeep(bytes.subarray(start, start + size), expected);
    if (raw.length !== expected) throw new Error('TIFF strip length mismatch.');
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.length), max = bits === 16 ? 65535 : 255;
    if (predictor === 2) for (let y = 0; y < lines; y++) for (let x = 1; x < width; x++) for (let c = 0; c < spp; c++) {
      const at = (y * width * spp + x * spp + c) * bps, previous = at - spp * bps;
      if (bits === 16) rv.setUint16(at, (rv.getUint16(at, le) + rv.getUint16(previous, le)) & 65535, le); else raw[at] = (raw[at]! + raw[previous]!) & 255;
    }
    const value = (i: number) => bits === 32 ? rv.getFloat32(i * 4, le) : bits === 16 ? rv.getUint16(i * 2, le) / max : raw[i]! / max;
    for (let p = 0; p < lines * width; p++) {
      const d = (strip * rows * width + p) * 4, s = p * spp;
      const alpha = hasAlpha ? value(s + spp - 1) : 1;
      for (let c = 0; c < 3; c++) { const n = value(s + (photo === 1 ? 0 : c)); rgba[d + c] = extra === 1 && alpha > 0 ? n / alpha : n; }
      rgba[d + 3] = alpha;
    }
  }
  let frame: DeepFrame = { width, height, data: rgba, space: 'srgb-linear' };
  const iccTag = tags.get(34675);
  if (iccTag) {
    if (iccTag.size > 4 * 1024 * 1024) throw new Error('TIFF ICC profile exceeds 4 MiB.');
    const icc = bytes.subarray(iccTag.at, iccTag.at + iccTag.size), profile = parseIccProfile(icc);
    let cicp: Uint8Array | undefined;
    if (icc.length >= 132) { const iv = new DataView(icc.buffer, icc.byteOffset, icc.length), n = iv.getUint32(128);
      if (n <= 1024 && 132 + n * 12 <= icc.length) for (let i = 0; i < n; i++) {
        const at = 132 + i * 12; if (iv.getUint32(at) !== 0x63696370) continue;
        const start = iv.getUint32(at + 4), size = iv.getUint32(at + 8);
        if (size === 12 && start + size <= icc.length && iv.getUint32(start) === 0x63696370) cicp = icc.subarray(start + 8, start + 12);
      }
    }
    if (cicp) {
      if (cicp[2] || cicp[3] !== 1 || ![1,6,8,13,14,15,16,18].includes(cicp[1]!)) throw new Error('Unsupported TIFF cICP.');
      frame = decodeTransfer({ ...frame, space: cicpSpace(cicp[0]!) }, cicp[1]!);
    } else {
      const pcs = profile && applyIccToFrame({ ...frame, space: ICC_DEVICE_SPACE }, profile, 'toPcs', 'relative');
      if (!pcs) throw new Error('The TIFF profile cannot be converted at full precision.'); frame = convertSpace(pcs, 'srgb-linear');
    }
  } else if (kind !== 3) frame = decodeTransfer(frame, 13);
  if (orientation !== 1) {
    const swap = orientation >= 5, w = swap ? height : width, h = swap ? width : height, data = new Float32Array(rgba.length);
    for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) {
      const dx = orientation === 2 || orientation === 3 ? width - 1 - x : orientation === 5 || orientation === 8 ? y : orientation === 6 || orientation === 7 ? height - 1 - y : x;
      const dy = orientation === 3 || orientation === 4 ? height - 1 - y : orientation === 5 || orientation === 6 ? x : orientation === 7 || orientation === 8 ? width - 1 - x : y;
      data.set(frame.data.subarray((y * width + x) * 4, (y * width + x) * 4 + 4), (dy * w + dx) * 4);
    }
    frame = { ...frame, width: w, height: h, data };
  }
  validateDeepFrame(frame); return frame;
}
