// SPDX-License-Identifier: MPL-2.0
/** Validate a small already-rendered stamp before a host paints it. */
import type { RasterFrame } from '@lolly-tools/core/host-v1';
export function validateLabelArtwork(frame: RasterFrame): void {
  if (!Number.isSafeInteger(frame.width) || !Number.isSafeInteger(frame.height) || frame.width < 1 || frame.height < 1 || frame.width*frame.height > 1_048_576 || !(frame.data instanceof Uint8ClampedArray) || frame.data.length !== frame.width*frame.height*4) throw new Error('Invalid label artwork.');
}
