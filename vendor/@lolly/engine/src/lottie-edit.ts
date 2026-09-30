// SPDX-License-Identifier: MPL-2.0
/** Instance-local revisions over immutable Lottie source documents. */
import { sha256Hex } from './bytes.ts';
import { admitLottieAnimation, lottieNumber, lottieObject, readLottieJson, type LottieAnimation, type LottieObject, type LottieValue } from './lottie-model.ts';
import { deleteLottieKey, numericVector, propertyKeys, sampleLottieProperty, setKeyEase, writeLottieKey, type LottieEase } from './lottie-properties.ts';

export interface LottieLayerAddress { asset: string; index: number }
export interface LottieLayerView extends LottieLayerAddress {
  key: string; name: string; depth: number; ancestors: LottieLayerAddress[]; layer: LottieObject;
}
export interface LottieTrack {
  id: string; name: string; property: LottieObject; scalar: boolean; staticOnly: boolean; color: boolean;
}
export type LottieEdit = { target: LottieLayerAddress } & (
  | { kind: 'layer'; patch: { nm?: string; hd?: boolean; ip?: number; op?: number } }
  | { kind: 'value'; track: string; value: number[] }
  | { kind: 'key'; track: string; frame: number; value: number[] }
  | { kind: 'delete'; track: string; frame: number }
  | { kind: 'ease'; track: string; frame: number; dimension: number; ease: LottieEase | 'hold' }
);
interface Revision { version: 1; source: string; edits: LottieEdit[] }
export const LOTTIE_REVISION_LIMITS = Object.freeze({ bytes: 262144, edits: 512 });
const sourceHashes = new WeakMap<LottieAnimation, Promise<string>>();
function sourceHash(source: LottieAnimation): Promise<string> {
  let result = sourceHashes.get(source);
  if (!result) { result = sha256Hex(new TextEncoder().encode(JSON.stringify(source))); sourceHashes.set(source, result); }
  return result;
}
export function lottieLayer(source: LottieAnimation, address: LottieLayerAddress): LottieObject {
  if (typeof address.asset !== 'string' || !Number.isInteger(address.index) || address.index < 0) throw new Error('Invalid animation layer address.');
  const composition = address.asset === '' ? source : source.assets?.find(a => a.id === address.asset);
  const layers = composition?.layers;
  if (!Array.isArray(layers) || !layers[address.index]) throw new Error('Animation layer no longer exists.');
  return lottieObject(layers[address.index], 'Layer');
}
/** Reused precompositions appear at each occurrence but keep their source identity. */
export function lottieLayers(source: LottieAnimation): LottieLayerView[] {
  const result: LottieLayerView[] = [];
  function walk(asset: string, ancestors: LottieLayerAddress[], prefix: string): void {
    if (ancestors.length > 32) throw new Error('Animation nesting limit exceeded.');
    const composition = asset ? source.assets?.find(a => a.id === asset) : source;
    if (!Array.isArray(composition?.layers)) return;
    composition.layers.forEach((item, index) => {
      if (result.length >= 2000) throw new Error('Animation layer view limit exceeded.');
      const layer = lottieObject(item, 'Layer'), address = { asset, index }, key = `${prefix}/${index}`;
      result.push({ ...address, key, name: String(layer.nm || `Layer ${index + 1}`), depth: ancestors.length, ancestors, layer });
      if (layer.ty === 0) walk(String(layer.refId), [...ancestors, address], key);
    });
  }
  walk('', [], '');
  return result;
}
/** Only these source properties are writable; no arbitrary object paths are accepted. */
export function lottieTracks(layer: LottieObject): LottieTrack[] {
  const tracks: LottieTrack[] = [];
  const add = (id: string, name: string, value: LottieValue | undefined, scalar: boolean, staticOnly = false, color = false): void => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return;
    tracks.push({ id, name, property: value, scalar, staticOnly, color });
  };
  const transform = layer.ks && typeof layer.ks === 'object' && !Array.isArray(layer.ks) ? layer.ks : {};
  const position = transform.p;
  if (position && typeof position === 'object' && !Array.isArray(position) && position.s) {
    add('p.x', 'Position X', position.x, true); add('p.y', 'Position Y', position.y, true);
  } else add('p', 'Position', position, false);
  add('a', 'Anchor', transform.a, false); add('s', 'Scale', transform.s, false);
  add('r', 'Rotation', transform.r, true); add('o', 'Opacity', transform.o, true);
  function shapes(items: LottieValue | undefined, prefix: string, names: string[], depth: number): void {
    if (!Array.isArray(items) || depth > 32) return;
    items.forEach((item, index) => {
      const shape = lottieObject(item, 'Shape'), id = `${prefix}/${index}`, name = String(shape.nm || `${shape.ty} ${index + 1}`);
      if (shape.ty === 'gr') shapes(shape.it, id, [...names, name], depth + 1);
      if (shape.ty === 'fl' || shape.ty === 'st') {
        const label = [...names, name].join(' / ');
        add(`${id}/c`, `${label}: Color`, shape.c, false, true, true);
        add(`${id}/o`, `${label}: Opacity`, shape.o, true, true);
        if (shape.ty === 'st') add(`${id}/w`, `${label}: Width`, shape.w, true, true);
      }
    });
  }
  shapes(layer.shapes, 'shapes', [], 0);
  return tracks;
}
/** Composition frame of a nested occurrence at a root source frame. */
export function lottieLayerFrame(source: LottieAnimation, ancestors: LottieLayerAddress[], rootFrame: number): number {
  let frame = rootFrame;
  for (const address of ancestors) {
    const layer = lottieLayer(source, address);
    if (layer.tm) {
      frame = sampleLottieProperty(lottieObject(layer.tm, 'Time remap'), frame)[0]! * source.fr;
      if (frame === layer.op) frame--;
    } else frame = (frame - Number(layer.st ?? 0)) / Number(layer.sr ?? 1);
  }
  return frame;
}
/** Seeking from a property track is unique only through unremapped ancestors. */
export function lottieRootFrame(source: LottieAnimation, ancestors: LottieLayerAddress[], frame: number): number | null {
  for (const address of [...ancestors].reverse()) {
    const layer = lottieLayer(source, address);
    if (layer.tm) return null;
    frame = frame * Number(layer.sr ?? 1) + Number(layer.st ?? 0);
  }
  return frame;
}
function revisionFrom(encoded: string): Revision {
  if (encoded.length > LOTTIE_REVISION_LIMITS.bytes) throw new Error('Animation edits exceed 256 KiB.');
  const bytes = new TextEncoder().encode(encoded);
  if (bytes.length > LOTTIE_REVISION_LIMITS.bytes) throw new Error('Animation edits exceed 256 KiB.');
  const value = readLottieJson(bytes, 'Animation edits');
  if (value.version !== 1 || typeof value.source !== 'string' || !/^[a-f0-9]{64}$/.test(value.source) || !Array.isArray(value.edits) || value.edits.length > LOTTIE_REVISION_LIMITS.edits) throw new Error('Invalid animation revision.');
  return value as unknown as Revision;
}
function applyEdit(source: LottieAnimation, raw: LottieEdit): void {
  const edit = lottieObject(raw, 'Animation edit');
  const target = lottieObject(edit.target, 'Layer address');
  const layer = lottieLayer(source, target as unknown as LottieLayerAddress);
  if (edit.kind === 'layer') {
    const patch = lottieObject(edit.patch, 'Layer edit');
    for (const [field, value] of Object.entries(patch)) {
      if (field === 'nm' && typeof value === 'string' && value.length <= 200) layer.nm = value;
      else if (field === 'hd' && typeof value === 'boolean') layer.hd = value;
      else if (field === 'ip' || field === 'op') layer[field] = lottieNumber(value, 'Layer frame', -8640000, 8640000);
      else throw new Error('Unsupported layer edit.');
    }
    if (Number(layer.op ?? source.op) <= Number(layer.ip ?? source.ip)) throw new Error('Layer out frame must be after its in frame.');
    return;
  }
  const track = lottieTracks(layer).find(t => t.id === edit.track);
  if (!track) throw new Error('This animation property is not editable.');
  const property = track.property, dimensions = sampleLottieProperty(property, source.ip).length;
  if (track.staticOnly && (property.a === 1 || edit.kind !== 'value')) throw new Error('Only static fill and stroke properties are editable.');
  let value: number[] = [];
  if (edit.kind === 'value' || edit.kind === 'key') {
    value = numericVector(edit.value);
    if (value.length !== dimensions) throw new Error('Property dimensions must be preserved.');
    if (track.color && value.some(v => v < 0 || v > 1)) throw new Error('Color channels must be from zero to one.');
  }
  if (edit.kind === 'value') {
    if (property.a === 1) throw new Error('Choose a keyframe to edit an animated property.');
    property.k = track.scalar ? value[0]! : value;
    return;
  }
  const frame = lottieNumber(edit.frame, 'Source frame', -8640000, 8640000);
  if (edit.kind === 'key') writeLottieKey(property, frame, value, [Number(layer.ip ?? source.ip), Number(layer.op ?? source.op)]);
  else if (edit.kind === 'delete') deleteLottieKey(property, frame, track.scalar);
  else if (edit.kind === 'ease') {
    const keys = propertyKeys(property), at = keys.findIndex(k => k.t === frame), key = keys[at];
    if (!key || !keys[at + 1]) throw new Error('Select a keyframe with a following segment to edit easing.');
    if (edit.ease === 'hold') key.h = 1;
    else {
      const ease = numericVector(edit.ease);
      if (ease.length !== 4) throw new Error('Easing needs four control values.');
      setKeyEase(key, ease as LottieEase, key.to ? 1 : dimensions, Number(edit.dimension));
    }
  } else throw new Error('Unknown animation edit.');
}
export async function applyLottieEdits(source: LottieAnimation, encoded: string): Promise<LottieAnimation> {
  if (!encoded) return source;
  const revision = revisionFrom(encoded);
  if (revision.source !== await sourceHash(source)) throw new Error('Animation edits belong to a different source. Reset the internal edits before replacing it.');
  const copy = structuredClone(source);
  for (const edit of revision.edits) applyEdit(copy, edit);
  return admitLottieAnimation(copy, 'Edited animation');
}
/** One string replacement is one ordinary document undo step; the source stays intact. */
export async function appendLottieEdit(source: LottieAnimation, encoded: string, edit: LottieEdit): Promise<string> {
  const revision: Revision = encoded ? revisionFrom(encoded) : { version: 1, source: await sourceHash(source), edits: [] };
  const previous = revision.edits.at(-1);
  if (previous && JSON.stringify(previous) === JSON.stringify(edit)) return encoded;
  const sameTarget = previous && previous.target.asset === edit.target.asset && previous.target.index === edit.target.index;
  const sameWrite = sameTarget && previous.kind === edit.kind && (
    edit.kind === 'layer' && previous.kind === 'layer' ? Object.keys(edit.patch).join() === Object.keys(previous.patch).join()
      : edit.kind !== 'layer' && previous.kind !== 'layer' && previous.track === edit.track &&
        (edit.kind === 'value' || (previous.kind !== 'value' && previous.frame === edit.frame &&
          (edit.kind !== 'ease' || (previous.kind === 'ease' && previous.dimension === edit.dimension))))
  );
  if (sameWrite) revision.edits[revision.edits.length - 1] = edit;
  else revision.edits.push(edit);
  const result = JSON.stringify(revision);
  await applyLottieEdits(source, result);
  return result;
}
