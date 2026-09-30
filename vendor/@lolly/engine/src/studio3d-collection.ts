// SPDX-License-Identifier: MPL-2.0
/** One studio shared by a bounded collection, with explicit per-item overrides. */
import { studioObjectId } from './studio3d-arrangement.ts';

export type StudioValues = Record<string, unknown>;
export interface StudioCollectionRow {
  index: number;
  /** Stable id: the authored one, or the position when the row has none. */
  id: string;
  name: string;
  filename: string;
  ownFraming: boolean;
  values: StudioValues;
}
export const STUDIO_COLLECTION_LIMIT = 24;

function record(value: unknown): StudioValues {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as StudioValues) : {};
}
const enabled = (value: unknown): boolean => value === true || value === 'true' || value === 1;
function number(value: unknown, fallback: number, min: number, max: number): number {
  const n =
    typeof value === 'number'
      ? value
      : typeof value === 'string' && value.trim()
        ? Number(value)
        : NaN;
  return Number.isFinite(n) ? Math.max(min, Math.min(max, n)) : fallback;
}

function items(values: StudioValues): StudioValues[] {
  if (!Array.isArray(values.subjects) || !values.subjects.length)
    throw new Error('Add at least one item to the collection.');
  if (values.subjects.length > STUDIO_COLLECTION_LIMIT)
    throw new Error(`Use up to ${STUDIO_COLLECTION_LIMIT} items in one collection.`);
  return values.subjects.map(record);
}

/**
 * Stable ids by the arrangement's rule: an authored id wins, otherwise the position names
 * the row, and two rows may not share one. An override is addressed by the id, so an item
 * keeps what was set for it when the collection is reordered.
 */
function subjectIds(rows: StudioValues[]): string[] {
  const taken = new Set<string>();
  return rows.map((row, index) => {
    // A fresh set normalises the row alone; the duplicate report below names items.
    const id = studioObjectId(row, index, new Set());
    if (taken.has(id))
      throw new Error(`Items ${[...taken].indexOf(id) + 1} and ${index + 1} share the id "${id}".`);
    taken.add(id);
    return id;
  });
}

/** The stable id of every item, in saved order. */
export function studioSubjectIds(values: StudioValues): string[] {
  return subjectIds(items(values));
}

export function studioActiveIndex(values: StudioValues): number {
  const rows = items(values);
  const n = Number(values.activeSubject);
  return Math.max(0, Math.min(rows.length - 1, Number.isFinite(n) ? Math.trunc(n) - 1 : 0));
}

function itemValues(values: StudioValues, item: StudioValues): StudioValues {
  const kind =
    item.kind === 'model'
      ? 'model'
      : item.kind === 'primitive'
        ? 'primitive'
        : item.kind === 'text'
          ? 'text'
          : 'artwork';
  // Per-item corrections sit between the shared values and the framing: they bring twelve
  // unlike silhouettes to one apparent size without touching the studio everything shares.
  // A row at the defaults writes nothing, so a saved collection renders as it always did.
  const scale = number(item.scale, 1, 0.5, 2);
  const offsetX = number(item.offsetX, 0, -5, 5),
    offsetY = number(item.offsetY, 0, -5, 5);
  const transform = record(values.transform),
    position = record(values.position);
  const corrections: StudioValues = {};
  if (scale !== 1)
    corrections.transform = { ...transform, scale: number(transform.scale, 1, 0.1, 5) * scale };
  if (offsetX || offsetY)
    corrections.position = {
      x: number(position.x, 0, -5, 5) + offsetX,
      y: number(position.y, 0.1, -5, 5) + offsetY,
      z: number(position.z, 0, -5, 5),
    };
  const camera = record(values.camera);
  const framing: StudioValues = { ...camera };
  if (enabled(item.ownFraming))
    for (const key of ['azimuth', 'elevation', 'fov', 'zoom', 'panX', 'panY', 'panZ']) {
      if (item[key] !== undefined && item[key] !== '') framing[key] = item[key];
    }
  return {
    ...values,
    source: kind,
    subjects: [],
    activeSubject: 1,
    upload: undefined,
    primitive: item.primitive || 'badge',
    artwork: kind === 'artwork' ? item.asset : undefined,
    modelAsset: kind === 'model' ? item.asset : undefined,
    modelFormat: item.modelFormat || 'auto',
    // A Words item sets its own line in the shared typesetting; its own font, when it
    // names one instead of inheriting, is the only type setting an item may differ in.
    ...(kind === 'text'
      ? {
          words: item.text,
          ...(item.font && item.font !== 'inherit' ? { wordFont: item.font } : {}),
        }
      : {}),
    ...corrections,
    camera: framing,
    focusDistance: enabled(item.ownFocus) ? item.focusDistance : values.focusDistance,
    materialSlotA: item.roleA || '',
    materialSlotB: item.roleB || '',
  };
}

/** Evaluates the selected item without changing the saved shared values. */
export function studioActiveValues(values: StudioValues): StudioValues {
  if (values.source !== 'collection') return values;
  return itemValues(values, items(values)[studioActiveIndex(values)]!);
}

/** Ordered, collision-free filenames and standalone rows for the normal batch renderer. */
export function studioCollectionRows(values: StudioValues): StudioCollectionRow[] {
  const rows = items(values);
  const ids = subjectIds(rows);
  return rows.map((item, index) => {
    const name =
      String(item.name || `Item ${index + 1}`)
        .trim()
        .slice(0, 120) || `Item ${index + 1}`;
    const slug =
      name
        .normalize('NFKD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 70) || 'item';
    return {
      index,
      id: ids[index]!,
      name,
      // Numbered by position, so a delivered set reads in the order the sheet shows.
      filename: `${String(index + 1).padStart(2, '0')}-${slug}.png`,
      ownFraming: enabled(item.ownFraming),
      values: itemValues(values, item),
    };
  });
}

/**
 * Change one item, found by its stable id rather than by its position now. Every
 * saved override goes through here, so reordering the collection cannot move one
 * item's framing onto another.
 */
export function studioSubjectEdit(
  values: StudioValues,
  id: string,
  patch: StudioValues
): { id: string; value: unknown } {
  const rows = items(values);
  const at = subjectIds(rows).indexOf(id);
  if (at < 0) throw new Error(`No item in this collection has the id "${id}".`);
  return { id: 'subjects', value: rows.map((item, i) => (i === at ? { ...item, ...patch } : item)) };
}

/** A gesture changes this item's framing; shared camera controls stay shared. */
export function studioCameraEdit(
  values: StudioValues,
  camera: StudioValues
): { id: string; value: unknown } {
  if (values.source !== 'collection') return { id: 'camera', value: camera };
  return studioSubjectEdit(values, studioSubjectIds(values)[studioActiveIndex(values)]!, {
    ownFraming: true,
    azimuth: camera.azimuth,
    elevation: camera.elevation,
    fov: camera.fov,
    zoom: camera.zoom,
    panX: camera.panX ?? 0,
    panY: camera.panY ?? 0,
    panZ: camera.panZ ?? 0,
  });
}

/** Focus picking affects only the active collection item. Zero returns to automatic focus. */
export function studioFocusEdit(
  values: StudioValues,
  distance: number
): { id: string; value: unknown } {
  if (values.source !== 'collection') return { id: 'focusDistance', value: distance };
  return studioSubjectEdit(values, studioSubjectIds(values)[studioActiveIndex(values)]!, {
    ownFocus: true,
    focusDistance: distance,
  });
}

export function studioCollectionSize(values: StudioValues): { width: number; height: number } {
  const size = record(values.collectionSize);
  const edge = (value: unknown): number => {
    const n = Number(value);
    return Math.max(64, Math.min(4096, Number.isFinite(n) && n > 0 ? Math.round(n) : 1024));
  };
  const width = edge(size.width),
    height = edge(size.height);
  if (width * height > 12_000_000) throw new Error('Keep each image below 12 million pixels.');
  return { width, height };
}

/** The long side a contact-sheet preview renders at: the saved size, capped. */
export const STUDIO_SHEET_PIXELS = 512;

/** The preview size for one item: the saved image size, reduced to the sheet's cap. */
export function studioSheetSize(size: { width: number; height: number }): {
  width: number;
  height: number;
} {
  const scale = Math.min(1, STUDIO_SHEET_PIXELS / Math.max(size.width, size.height));
  return {
    width: Math.max(1, Math.round(size.width * scale)),
    height: Math.max(1, Math.round(size.height * scale)),
  };
}
