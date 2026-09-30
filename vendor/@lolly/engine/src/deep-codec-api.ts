// SPDX-License-Identifier: MPL-2.0
/** Shared codec operations. Hosts supply byte access and their SDR/JXL decoders. */
import type { CodecAPI, CodecFrame, RasterSource } from '@lolly-tools/core/host-v1';
import { encodeExr, encodeRadiance, encodePng16, encodeDither8 } from './deep-encode.ts';
import { decodeDeepImage, type DeepDecodeIO } from './deep-decode.ts';
import { deepPreview, validateDeepFrame } from './deep-image.ts';
import { composeDeep } from './deep-compose.ts';
import type { DeepFrame } from './pixels.ts';
const deep = (frame: CodecFrame): DeepFrame => ({ ...frame, space: frame.space ?? 'srgb-linear' });
export function createDeepCodec(io: DeepDecodeIO & { bytes(source: RasterSource): Promise<Uint8Array> }): CodecAPI {
  return {
    png16: async (f,o) => encodePng16(deep(f),o), exr: async (f,o) => encodeExr(deep(f),o),
    radiance: async (f,o) => encodeRadiance(deep(f),o), dither8: async (f,o) => encodeDither8(deep(f),o),
    decode: async source => (await decodeDeepImage(await io.bytes(source), io)) as CodecFrame,
    preview: async (frame, exposure) => ({ width: frame.width, height: frame.height, data: deepPreview(deep(frame), exposure) }),
    compose: async (width,height,layers) => composeDeep(width,height,layers.map(l => ({ ...l, frame: deep(l.frame) }))) as CodecFrame,
    validate: async frame => { validateDeepFrame(deep(frame)); },
  };
}
