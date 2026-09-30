// SPDX-License-Identifier: MPL-2.0
/** Single-part RGB(A) scanline OpenEXR, NONE/ZIPS/ZIP, HALF/FLOAT/UINT. */
import { halfToFloat, type DeepFrame, type PixelSpace } from './pixels.ts';
import { deepDimensions, DEEP_MAX_BYTES, validateDeepFrame } from './deep-image.ts';
import { inflateDeep } from './deep-png.ts';

export function readDeepExr(bytes: Uint8Array): DeepFrame | null {
  if (bytes.length < 8) return null;
  const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.length);
  if (v.getUint32(0, true) !== 0x01312f76) return null;
  if (bytes.length > DEEP_MAX_BYTES || (v.getUint32(4, true) & ~0x400) !== 2) throw new Error('HDR editing supports single-part scanline OpenEXR.');
  let at = 8;
  const name = (limit = bytes.length): string => {
    const start = at; while (at < limit && bytes[at]) at++;
    if (at >= limit || at - start > 255) throw new Error('Invalid OpenEXR attribute name.');
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(start, at++));
  };
  const attrs = new Map<string, { type: string; start: number; size: number }>();
  while (at < bytes.length && bytes[at]) {
    const key = name(), type = name(); if (at + 4 > bytes.length) throw new Error('Truncated OpenEXR header.');
    const size = v.getUint32(at, true); at += 4;
    if (at + size > bytes.length || attrs.has(key) || attrs.size > 256 || size > 4 * 1024 * 1024) throw new Error('Invalid OpenEXR attribute.');
    attrs.set(key, { type, start: at, size }); at += size;
  }
  if (at >= bytes.length) throw new Error('Truncated OpenEXR header.'); at++;
  const table = at;
  const attribute = (key: string, type: string, size?: number) => { const item = attrs.get(key);
    if (!item || item.type !== type || size !== undefined && item.size !== size) throw new Error(`Unsupported OpenEXR ${key}.`); return item; };
  const dataWindow = attribute('dataWindow', 'box2i', 16);
  const xmin = v.getInt32(dataWindow.start, true), ymin = v.getInt32(dataWindow.start + 4, true);
  const width = v.getInt32(dataWindow.start + 8, true) - xmin + 1, height = v.getInt32(dataWindow.start + 12, true) - ymin + 1;
  deepDimensions(width, height);
  const display = attrs.get('displayWindow');
  if (display && (display.size !== 16 || !bytes.subarray(display.start, display.start + 16).every((b, i) => b === bytes[dataWindow.start + i]))) throw new Error('OpenEXR with a different display window needs flattening before import.');
  const compression = bytes[attribute('compression', 'compression', 1).start]!;
  if (![0,2,3].includes(compression)) throw new Error('Use NONE, ZIPS or ZIP compression for editable OpenEXR.');
  const lines = compression === 3 ? 16 : 1;
  const channelList = attribute('channels', 'chlist'); at = channelList.start;
  const channels: { component: number; type: number; bytes: number }[] = [];
  while (at < channelList.start + channelList.size && bytes[at]) {
    const key = name(channelList.start + channelList.size);
    if (at + 16 > channelList.start + channelList.size) throw new Error('Truncated OpenEXR channel.');
    const type = v.getInt32(at, true), component = ['R','G','B','A'].indexOf(key);
    if (component < 0 || ![0,1,2].includes(type) || v.getInt32(at + 8, true) !== 1 || v.getInt32(at + 12, true) !== 1 || channels.some(c => c.component === component)) throw new Error('HDR editing supports full-resolution RGB and alpha OpenEXR channels.');
    channels.push({ component, type, bytes: type === 1 ? 2 : 4 }); at += 16;
  }
  if (at !== channelList.start + channelList.size - 1 || bytes[at] !== 0) throw new Error('Invalid OpenEXR channel terminator.');
  if (![0,1,2].every(c => channels.some(channel => channel.component === c))) throw new Error('OpenEXR needs RGB channels.');
  let space: PixelSpace = 'srgb-linear';
  const chroma = attrs.get('chromaticities');
  if (chroma) {
    if (chroma.type !== 'chromaticities' || chroma.size !== 32) throw new Error('Invalid OpenEXR chromaticities.');
    const value = Array.from({ length: 8 }, (_, i) => v.getFloat32(chroma.start + i * 4, true));
    const choices: [PixelSpace, number[]][] = [ ['srgb-linear', [.64,.33,.3,.6,.15,.06,.3127,.329]], ['display-p3-linear', [.68,.32,.265,.69,.15,.06,.3127,.329]], ['rec2020-linear', [.708,.292,.17,.797,.131,.046,.3127,.329]] ];
    const match = choices.find(([, coords]) => coords.every((n, i) => Math.abs(n - value[i]!) < 1e-5));
    if (!match) throw new Error('Convert this OpenEXR to linear sRGB, Display P3 or Rec.2020 before import.'); space = match[0];
  }
  const count = Math.ceil(height / lines); if (table + count * 8 > bytes.length) throw new Error('Truncated OpenEXR offset table.');
  const rgba = new Float32Array(width * height * 4); for (let i = 3; i < rgba.length; i += 4) rgba[i] = 1;
  const seen = new Set<number>(), rowBytes = channels.reduce((n, channel) => n + channel.bytes * width, 0);
  for (let chunk = 0; chunk < count; chunk++) {
    const offset = Number(v.getBigUint64(table + chunk * 8, true));
    if (!Number.isSafeInteger(offset) || offset < table + count * 8 || offset + 8 > bytes.length) throw new Error('Invalid OpenEXR chunk offset.');
    const y = v.getInt32(offset, true) - ymin, size = v.getUint32(offset + 4, true);
    if (y < 0 || y >= height || y % lines || seen.has(y) || offset + 8 + size > bytes.length) throw new Error('Invalid OpenEXR scanline block.'); seen.add(y);
    const rows = Math.min(lines, height - y), expected = rows * rowBytes;
    let raw = bytes.subarray(offset + 8, offset + 8 + size);
    if (compression && size < expected) {
      const predicted = inflateDeep(raw, expected);
      for (let i = 1; i < predicted.length; i++) predicted[i] = (predicted[i - 1]! + predicted[i]! - 128) & 255;
      raw = new Uint8Array(expected); let a = 0, b = Math.ceil(expected / 2);
      for (let i = 0; i < expected; i++) raw[i] = predicted[i % 2 ? b++ : a++]!;
    }
    if (raw.length !== expected) throw new Error('OpenEXR block length mismatch.');
    const rv = new DataView(raw.buffer, raw.byteOffset, raw.length); let pos = 0;
    for (let row = 0; row < rows; row++) for (const channel of channels) for (let x = 0; x < width; x++) {
      rgba[((y + row) * width + x) * 4 + channel.component] = channel.type === 1 ? halfToFloat(rv.getUint16(pos, true)) : channel.type === 2 ? rv.getFloat32(pos, true) : rv.getUint32(pos, true); pos += channel.bytes;
    }
  }
  // OpenEXR stores associated RGB. Keep zero-alpha emission instead of dividing by zero.
  for (let i = 0; i < rgba.length; i += 4) { const alpha = rgba[i + 3]!;
    if (alpha > 0) for (let c = 0; c < 3; c++) rgba[i + c] = rgba[i + c]! / alpha;
  }
  const frame: DeepFrame = { width, height, data: rgba, space }; validateDeepFrame(frame); return frame;
}
