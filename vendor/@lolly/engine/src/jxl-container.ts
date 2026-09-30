// SPDX-License-Identifier: MPL-2.0
/** Bounded uncompressed metadata boxes. Image parsing stays in libjxl. */
import { isJxl, JXL_LIMITS } from './jxl.ts';
const signature = new Uint8Array([0, 0, 0, 12, 74, 88, 76, 32, 13, 10, 135, 10]);
const text = new TextEncoder();
const MAX_METADATA = 1024 * 1024;
function box(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(8 + data.length);
  new DataView(out.buffer).setUint32(0, out.length);
  out.set(text.encode(type), 4); out.set(data, 8); return out;
}
/** Reads only complete, uncompressed XML boxes, never a Brotli metadata payload. */
export function jxlXmp(bytes: Uint8Array): string | null {
  if (!isJxl(bytes) || bytes[0] === 255 || bytes.length > JXL_LIMITS.inputBytes) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let at = 12, count = 0; at + 8 <= bytes.length && count < 4096; count++) {
    let size = view.getUint32(at); let header = 8;
    const type = new TextDecoder().decode(bytes.subarray(at + 4, at + 8));
    if (size === 1) {
      if (at + 16 > bytes.length) return null;
      const wide = view.getBigUint64(at + 8);
      if (wide > BigInt(bytes.length)) return null;
      size = Number(wide); header = 16;
    } else if (size === 0) size = bytes.length - at;
    if (size < header || size > bytes.length - at) return null;
    if (type === 'xml ') return size - header <= MAX_METADATA ? new TextDecoder().decode(bytes.subarray(at + header, at + size)) : null;
    at += size;
  }
  return null;
}
/** Wraps a newly encoded codestream, retaining its explicit sRGB colour description. */
export function jxlWithXmp(codestream: Uint8Array, xmp?: string | null): Uint8Array {
  if (!xmp) return codestream;
  if (codestream[0] !== 255 || codestream[1] !== 10) throw new Error('JPEG XL metadata needs a new codestream.');
  const xml = text.encode(xmp);
  if (xml.length > MAX_METADATA) throw new Error('JPEG XL metadata exceeds 1 MiB.');
  const parts = [signature, box('ftyp', new Uint8Array([106, 120, 108, 32, 0, 0, 0, 0, 106, 120, 108, 32])), box('xml ', xml), box('jxlc', codestream)];
  const size = parts.reduce((n, part) => n + part.length, 0);
  if (size > JXL_LIMITS.inputBytes) throw new Error('JPEG XL output exceeds 128 MiB.');
  const out = new Uint8Array(size); let at = 0;
  for (const part of parts) { out.set(part, at); at += part.length; }
  return out;
}
