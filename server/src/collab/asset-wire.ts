// SPDX-License-Identifier: MPL-2.0
import type { CanvasCheckpoint, CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { decodeCanvasAsset } from '@lolly-tools/core/canvas-asset-v1';

/** Older shells retain their locally restored asset objects. Never replace those
 * with an extension string they cannot materialize; ordinary fields still arrive. */
export function canvasAssetOps(ops: readonly CanvasOp[], interactionVersion?: number): CanvasOp[] {
  if (interactionVersion === 1) return [...ops];
  return ops.flatMap<CanvasOp>(op => {
    if (op.k === 'field' && decodeCanvasAsset(op.value)) return [];
    if (op.k === 'add') return [{ ...op, row: Object.fromEntries(Object.entries(op.row).filter(([, value]) => !decodeCanvasAsset(value))) }];
    return [op];
  });
}

export function canvasAssetCheckpoint(value: CanvasCheckpoint, interactionVersion?: number): CanvasCheckpoint {
  if (interactionVersion === 1) return value;
  const rows = (entries: CanvasCheckpoint['boxes']): CanvasCheckpoint['boxes'] => entries.map(([id, row]) => [id,
    { ...row, fields: row.fields.filter(([, register]) => !decodeCanvasAsset(register.value)) }]);
  return { ...value, boxes: rows(value.boxes), collections: value.collections.map(([id, boxes]) => [id, rows(boxes)]) };
}
