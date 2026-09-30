// SPDX-License-Identifier: MPL-2.0
/** JPEG XL identity and bounded operation policy. Codec execution belongs to shells. */
export const JXL_LIMITS = { inputBytes: 128 * 1024 * 1024, decodePixels: 16_000_000, encodePixels: 8_000_000, edge: 16384, budgetMs: 120000 } as const;
export interface JxlInfo {
  width: number; height: number; encodedWidth: number; encodedHeight: number;
  bitsPerSample: number; exponentBits: number; alphaBits: number; orientation: number;
  animated: boolean; extraChannels: number; intensityTarget: number; colorChannels: number;
  premultiplied: boolean; transferFunction: number; primaries: number; whitePoint: number;
  icc: boolean; reconstruction: boolean; hdr: boolean;
}
export interface JxlEncodeOptions { lossless?: boolean; quality?: number; effort?: number }
export type JxlRequest =
  | { operation: 'probe' | 'decode' | 'decode16' | 'decodeFloat' | 'restore'; bytes: Uint8Array }
  | { operation: 'encode'; bytes: Uint8Array; width: number; height: number; options?: JxlEncodeOptions; sample?: 0 | 1 | 2 | 3; orientation?: number }
  | { operation: 'recompress'; bytes: Uint8Array; effort?: number };
export interface JxlResult { bytes: Uint8Array; info?: JxlInfo; peakCodecBytes: number; heapBytes: number }
export function isJxl(bytes: Uint8Array): boolean {
  return bytes[0] === 0xff && bytes[1] === 0x0a || bytes.length >= 12 && [0, 0, 0, 12, 0x4a, 0x58, 0x4c, 0x20, 13, 10, 0x87, 10].every((v, i) => bytes[i] === v);
}
export function validateJxlRequest(request: JxlRequest): void {
  if (!(request.bytes instanceof Uint8Array) || !request.bytes.length || request.bytes.length > JXL_LIMITS.inputBytes) throw new Error('JPEG XL operations accept nonempty inputs up to 128 MiB.');
  if (request.operation === 'encode') {
    const { width, height, options = {}, sample = 0, orientation = 1 } = request;
    if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1 || width > JXL_LIMITS.edge || height > JXL_LIMITS.edge || width * height > JXL_LIMITS.encodePixels) throw new Error('JPEG XL encoding is limited to 8 megapixels and 16384 pixels per edge.');
    if (![0, 1, 2, 3].includes(sample) || request.bytes.length !== width * height * 4 * (sample === 3 ? 2 : 2 ** sample)) throw new Error('JPEG XL pixels do not match the declared sample type and dimensions.');
    if (!Number.isInteger(orientation) || orientation < 1 || orientation > 8) throw new Error('Invalid JPEG XL orientation.');
    if (options.lossless !== undefined && typeof options.lossless !== 'boolean') throw new Error('JPEG XL lossless must be a boolean.');
    if (!Number.isFinite(options.quality ?? 0.9) || (options.quality ?? 0.9) < 0.1 || (options.quality ?? 0.9) > 1) throw new Error('JPEG XL quality must be between 0.1 and 1.');
    checkEffort(options.effort);
  } else if (request.operation === 'recompress') {
    if (request.bytes[0] !== 0xff || request.bytes[1] !== 0xd8) throw new Error('Reversible compression requires original JPEG bytes.');
    checkEffort(request.effort);
  } else if (!['probe', 'decode', 'decode16', 'decodeFloat', 'restore'].includes(request.operation) || !isJxl(request.bytes)) throw new Error('These bytes are not a supported JPEG XL input.');
}
function checkEffort(effort = 5): void {
  if (!Number.isInteger(effort) || effort < 1 || effort > 7) throw new Error('JPEG XL effort must be between 1 and 7.');
}
