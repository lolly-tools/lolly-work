// SPDX-License-Identifier: MPL-2.0
/** Several subjects in one photograph: stable ids, selection, numerical edits and overlap guidance. */
import type { StudioObjectV1, StudioSceneV1, StudioVector3 } from '@lolly-tools/core';

export type StudioValues = Record<string, unknown>;
export const STUDIO_ARRANGEMENT_LIMIT = 16;
/** Positions stay inside the lit, shadowed part of the stage. */
export const STUDIO_ARRANGEMENT_EXTENT = 6;

function record(value: unknown): StudioValues {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as StudioValues) : {};
}

export function studioArrangementRows(values: StudioValues): StudioValues[] {
  if (!Array.isArray(values.objects) || !values.objects.length)
    throw new Error('Add at least one object to the arrangement.');
  if (values.objects.length > STUDIO_ARRANGEMENT_LIMIT)
    throw new Error(`Use up to ${STUDIO_ARRANGEMENT_LIMIT} objects in one arrangement.`);
  return values.objects.map(record);
}

/** Stable ids: an authored id wins, otherwise the row's position names it. Duplicates are refused. */
export function studioObjectId(row: StudioValues, index: number, taken: Set<string>): string {
  const authored = String(row.id ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  const id = authored || `object-${index + 1}`;
  if (taken.has(id))
    throw new Error(`Objects ${[...taken].indexOf(id) + 1} and ${index + 1} share the id "${id}".`);
  taken.add(id);
  return id;
}

export function studioObjectName(row: StudioValues, index: number): string {
  return (
    String(row.name || '')
      .trim()
      .slice(0, 120) || `Object ${index + 1}`
  );
}

export function studioActiveObject(values: StudioValues): number {
  const rows = studioArrangementRows(values);
  const n = Number(values.activeObject);
  return Math.max(0, Math.min(rows.length - 1, Number.isFinite(n) ? Math.trunc(n) - 1 : 0));
}

/** Every subject the renderer places, in order. A single-object scene is one entry. */
export function studioSceneObjects(scene: StudioSceneV1): StudioObjectV1[] {
  if (scene.objects?.length) return scene.objects;
  return [
    {
      id: 'object',
      name: 'Object',
      source: scene.source,
      transform: scene.transform,
      grounded: true,
      visible: true,
      bindings: scene.materials.bindings ?? { a: '', b: '' },
    },
  ];
}

/** A gesture or key edits one object's row; the saved arrangement keeps every other value. */
export function studioObjectEdit(
  values: StudioValues,
  index: number,
  patch: Partial<Record<'x' | 'y' | 'z' | 'rotX' | 'rotY' | 'rotZ' | 'scale', number>>
): { id: string; value: unknown } {
  const rows = studioArrangementRows(values);
  if (index < 0 || index >= rows.length) throw new Error('That object is not in the arrangement.');
  const bounded: StudioValues = {};
  for (const [key, raw] of Object.entries(patch)) {
    if (!Number.isFinite(raw)) continue;
    const limit =
      key === 'scale' ? [0.1, 5] : key.startsWith('rot') ? [-360, 360] : [-STUDIO_ARRANGEMENT_EXTENT, STUDIO_ARRANGEMENT_EXTENT];
    bounded[key] = Math.round(Math.max(limit[0]!, Math.min(limit[1]!, raw as number)) * 1000) / 1000;
  }
  return {
    id: 'objects',
    value: rows.map((row, i) => (i === index ? { ...row, ...bounded } : row)),
  };
}

export function studioObjectSelect(
  values: StudioValues,
  index: number
): { id: string; value: unknown } {
  const rows = studioArrangementRows(values);
  return { id: 'activeObject', value: Math.max(1, Math.min(rows.length, index + 1)) };
}

export interface StudioObjectBox {
  id: string;
  name: string;
  min: StudioVector3;
  max: StudioVector3;
}

/**
 * Pairwise axis-aligned overlap. Touching objects are fine; a shared volume above two
 * percent of the smaller object is reported so intersecting geometry is never a surprise.
 */
export function studioOverlaps(boxes: StudioObjectBox[]): string[] {
  const volume = (b: StudioObjectBox): number =>
    Math.max(0, b.max[0] - b.min[0]) * Math.max(0, b.max[1] - b.min[1]) * Math.max(0, b.max[2] - b.min[2]);
  const notes: string[] = [];
  for (let i = 0; i < boxes.length; i++)
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!,
        b = boxes[j]!;
      let shared = 1;
      for (let axis = 0; axis < 3; axis++)
        shared *= Math.max(
          0,
          Math.min(a.max[axis]!, b.max[axis]!) - Math.max(a.min[axis]!, b.min[axis]!)
        );
      const smaller = Math.min(volume(a), volume(b));
      if (smaller > 0 && shared / smaller > 0.02)
        notes.push(
          `${a.name} and ${b.name} overlap by about ${Math.round((shared / smaller) * 100)}% of the smaller object. Move or scale one of them if that is unintended.`
        );
    }
  return notes;
}

/** The whole arrangement turns about the centre of its footprint, not about the first object. */
export function studioArrangementPivot(boxes: StudioObjectBox[]): StudioVector3 {
  if (!boxes.length) return [0, 0, 0];
  let x0 = Infinity,
    x1 = -Infinity,
    z0 = Infinity,
    z1 = -Infinity;
  for (const box of boxes) {
    x0 = Math.min(x0, box.min[0]);
    x1 = Math.max(x1, box.max[0]);
    z0 = Math.min(z0, box.min[2]);
    z1 = Math.max(z1, box.max[2]);
  }
  return [(x0 + x1) / 2, 0, (z0 + z1) / 2];
}
