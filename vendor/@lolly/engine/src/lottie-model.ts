// SPDX-License-Identifier: MPL-2.0
/** Bounded, platform-independent admission of linear Lottie compositions. */
export type LottieValue = null | boolean | number | string | LottieObject | LottieValue[];
export interface LottieObject { [key: string]: LottieValue | undefined }
export interface LottieAnimation extends LottieObject {
  w: number; h: number; fr: number; ip: number; op: number; layers: LottieObject[];
  assets?: LottieObject[];
}
export const LOTTIE_LIMITS = Object.freeze({
  inputBytes: 64 * 1024 * 1024, expandedBytes: 128 * 1024 * 1024,
  jsonBytes: 32 * 1024 * 1024, members: 2048, depth: 64, nodes: 500000,
  layers: 2000, keys: 100000, dimension: 16384, durationMs: 3600000,
});
export function lottieObject(value: unknown, context: string): LottieObject {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${context}: expected an object.`);
  return value as LottieObject;
}
export function lottieNumber(value: unknown, context: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) {
    throw new Error(`${context}: expected a finite number from ${min} to ${max}.`);
  }
  return value;
}
export function readLottieJson(bytes: Uint8Array, context: string): LottieObject {
  if (bytes.length > LOTTIE_LIMITS.jsonBytes) throw new Error(`${context}: JSON exceeds 32 MiB.`);
  const value: unknown = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  let nodes = 0;
  const pending = [{ value, depth: 0 }];
  while (pending.length) {
    const item = pending.pop()!;
    if (++nodes > LOTTIE_LIMITS.nodes || item.depth > LOTTIE_LIMITS.depth) throw new Error(`${context}: JSON complexity limit exceeded.`);
    if (typeof item.value === 'number' && !Number.isFinite(item.value)) throw new Error(`${context}: non-finite number.`);
    if (item.value && typeof item.value === 'object') for (const child of Object.values(item.value)) pending.push({ value: child, depth: item.depth + 1 });
  }
  return lottieObject(value, context);
}
/** Validate references, supported rendering features and resource complexity. */
export function admitLottieAnimation(value: LottieObject, label = 'Animation'): LottieAnimation {
  const w = lottieNumber(value.w, `${label} width`, 1, LOTTIE_LIMITS.dimension);
  const h = lottieNumber(value.h, `${label} height`, 1, LOTTIE_LIMITS.dimension);
  const fr = lottieNumber(value.fr, `${label} frame rate`, 1, 240);
  const ip = lottieNumber(value.ip, `${label} in-point`, -864000, 864000);
  const op = lottieNumber(value.op, `${label} out-point`, ip + 0.000001, ip + fr * 3600);
  if (!Array.isArray(value.layers)) throw new Error(`${label}: missing animation layers.`);
  if (value.ddd || value.slots || value.fonts || value.chars) throw new Error(`${label}: 3D, slots and font-dependent animations are not supported. Use video export for this source.`);
  const assets = (value.assets ?? []) as LottieValue;
  if (!Array.isArray(assets)) throw new Error(`${label}: invalid assets.`);
  if (assets.filter(asset => asset && typeof asset === 'object' && !Array.isArray(asset) && typeof asset.p === 'string').length > 1000) throw new Error(`${label}: too many image references.`);
  const byId = new Map<string, LottieObject>();
  for (const entry of assets) {
    const asset = lottieObject(entry, `${label} asset`);
    if (typeof asset.id !== 'string' || !asset.id || byId.has(asset.id)) throw new Error(`${label}: missing or duplicate asset id.`);
    if (asset.fr !== undefined && asset.fr !== fr) throw new Error(`${label}: independently rated precompositions are not supported.`);
    byId.set(asset.id, asset);
  }
  let layerCount = 0, keyCount = 0;
  function inspectProperties(object: LottieObject): void {
    if (typeof object.ty === 'string' && !['gr', 'tr', 'sh', 'rc', 'el', 'fl', 'st', 'gf', 'gs', 'tm'].includes(object.ty)) throw new Error(`${label}: unsupported shape operation ${object.ty}. Export video instead.`);
    if (typeof object.x === 'string') throw new Error(`${label}: expressions are not supported.`);
    if (object.sid) throw new Error(`${label}: themed slots are not supported.`);
    if (object.a === 1 && Array.isArray(object.k)) {
      keyCount += object.k.length;
      if (keyCount > LOTTIE_LIMITS.keys) throw new Error(`${label}: keyframe limit exceeded.`);
      for (const key of object.k) lottieNumber(lottieObject(key, `${label} keyframe`).t, `${label} key time`, -8640000, 8640000);
    }
    for (const child of Object.values(object)) {
      if (Array.isArray(child)) for (const item of child) {
        if (item && typeof item === 'object' && !Array.isArray(item)) inspectProperties(item);
      }
      else if (child && typeof child === 'object') inspectProperties(child);
    }
  }
  function inspectLayers(list: LottieValue, ancestry: string[]): void {
    if (!Array.isArray(list)) throw new Error(`${label}: invalid precomposition layers.`);
    const parents = new Map<number, number>();
    const indices = new Set<number>();
    for (const item of list) {
      const layer = lottieObject(item, `${label} layer`);
      if (++layerCount > LOTTIE_LIMITS.layers) throw new Error(`${label}: layer limit exceeded.`);
      if (typeof layer.ty !== 'number' || ![0, 1, 2, 3, 4].includes(layer.ty)) throw new Error(`${label}: layer ${String(layer.nm ?? layer.ind)} uses unsupported type ${String(layer.ty)}.`);
      if (layer.ddd || layer.ao || layer.tt || layer.td || layer.bm || layer.masksProperties || (Array.isArray(layer.ef) && layer.ef.length)) {
        throw new Error(`${label}: layer ${String(layer.nm ?? layer.ind)} uses 3D, masks, mattes, auto-orientation, blends or effects. Export video instead.`);
      }
      for (const field of ['ip', 'op', 'st']) if (layer[field] !== undefined) lottieNumber(layer[field], `${label} layer ${field}`, -8640000, 8640000);
      if (layer.sr !== undefined) lottieNumber(layer.sr, `${label} stretch`, 0.0001, 10000);
      if (typeof layer.ind === 'number') {
        if (indices.has(layer.ind)) throw new Error(`${label}: duplicate layer index.`);
        indices.add(layer.ind);
        if (typeof layer.parent === 'number') parents.set(layer.ind, layer.parent);
      }
      inspectProperties(layer);
      if (layer.ty === 0 || layer.ty === 2) {
        const id = String(layer.refId ?? '');
        const asset = byId.get(id);
        if (!asset) throw new Error(`${label}: missing asset ${id}.`);
        if (layer.ty === 0) {
          if (ancestry.includes(id) || ancestry.length >= 32) throw new Error(`${label}: cyclic or excessively nested precomposition ${id}.`);
          inspectLayers(asset.layers!, [...ancestry, id]);
        } else if (typeof asset.p !== 'string') throw new Error(`${label}: image ${id} has no resource.`);
      }
    }
    for (const id of parents.keys()) {
      const seen = new Set<number>([id]);
      let parent = parents.get(id);
      while (parent !== undefined) {
        if (!indices.has(parent) || seen.has(parent)) throw new Error(`${label}: missing or cyclic parent layer.`);
        seen.add(parent); parent = parents.get(parent);
      }
    }
  }
  inspectLayers(value.layers, []);
  return { ...value, w, h, fr, ip, op, layers: value.layers as LottieObject[], assets: assets as LottieObject[] };
}
