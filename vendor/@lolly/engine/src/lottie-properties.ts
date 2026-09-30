// SPDX-License-Identifier: MPL-2.0
/** Numeric Lottie tracks retain their own frame times, dimensions and easing. */
import { cubicBezierAt } from './keyframes.ts';
import { lottieNumber, lottieObject, type LottieObject, type LottieValue } from './lottie-model.ts';

export type LottieEase = [number, number, number, number];
export function numericVector(value: unknown): number[] {
  const values = typeof value === 'number' ? [value] : value;
  if (!Array.isArray(values) || !values.length || values.length > 4) throw new Error('This property is not an editable numeric track.');
  return values.map(n => lottieNumber(n, 'Property value', -1e9, 1e9));
}
export function propertyKeys(property: LottieObject): LottieObject[] {
  if (property.a !== 1) return [];
  if (!Array.isArray(property.k) || !property.k.length) throw new Error('Invalid animation keys.');
  const keys = property.k.map(k => lottieObject(k, 'Keyframe'));
  for (let i = 0; i < keys.length; i++) {
    const frame = lottieNumber(keys[i]!.t, 'Key frame', -8640000, 8640000);
    if (i && frame <= Number(keys[i - 1]!.t)) throw new Error('Editing duplicate or unordered key times is unavailable.');
    numericVector(keys[i]!.s ?? keys[i - 1]?.e);
  }
  return keys;
}
function component(value: LottieValue | undefined, dimension: number, fallback: number): number {
  const n = Array.isArray(value) ? value[dimension] ?? value[0] : value;
  return typeof n === 'number' && Number.isFinite(n) ? n : fallback;
}
export function keyEase(key: LottieObject, dimension = 0): LottieEase {
  const outgoing = key.o && typeof key.o === 'object' && !Array.isArray(key.o) ? key.o : {};
  const incoming = key.i && typeof key.i === 'object' && !Array.isArray(key.i) ? key.i : {};
  return [component(outgoing.x, dimension, 0), component(outgoing.y, dimension, 0), component(incoming.x, dimension, 1), component(incoming.y, dimension, 1)];
}
/** Separate nonspatial position axes so players retain each axis's temporal curve. */
export function separateLottiePosition(property: LottieObject): LottieObject {
  if (property.a !== 1 || !Array.isArray(property.k)) return property;
  const keys = property.k as LottieObject[];
  if (keys.some(key => key.to || key.ti)) return property;
  const dimensions = Array.isArray(keys[0]?.s) ? keys[0]!.s.length : 0;
  if (dimensions < 2 || dimensions > 3 || !independentLottieAxes(property)) return property;
  const result: LottieObject = { s: true };
  for (let d = 0; d < dimensions; d++) result[['x', 'y', 'z'][d]!] = {
    ...property, k: keys.map(key => {
      const next = { ...key };
      for (const field of ['s', 'e']) if (Array.isArray(key[field])) next[field] = [key[field][d]!];
      if (key.o || key.i) {
        const [x1, y1, x2, y2] = keyEase(key, d);
        next.o = { x: x1, y: y1 }; next.i = { x: x2, y: y2 };
      }
      return next;
    }),
  };
  return result;
}
export function independentLottieAxes(property: LottieObject): boolean {
  if (property.a !== 1 || !Array.isArray(property.k)) return false;
  return (property.k as LottieObject[]).some(key => {
    if (key.h === 1 || !Array.isArray(key.s)) return false;
    const first = keyEase(key);
    return key.s.some((_, d) => keyEase(key, d).some((v, i) => v !== first[i]));
  });
}
function spatialPoint(start: number[], end: number[], out: number[], into: number[], u: number): number[] {
  return start.map((v, d) => (1 - u) ** 3 * v + 3 * (1 - u) ** 2 * u * (v + (out[d] ?? 0)) + 3 * (1 - u) * u * u * (end[d]! + (into[d] ?? 0)) + u ** 3 * end[d]!);
}
/** Spatial interpolation uses the player's 150-sample arc-length convention. */
function spatialValue(start: number[], end: number[], key: LottieObject, progress: number): number[] {
  const out = numericVector(key.to), into = numericVector(key.ti);
  const points = [start], lengths = [0];
  for (let i = 1; i < 150; i++) {
    const point = spatialPoint(start, end, out, into, i / 149), before = points[i - 1]!;
    lengths.push(lengths[i - 1]! + Math.hypot(...point.map((v, d) => v - before[d]!)));
    points.push(point);
  }
  const distance = Math.max(0, Math.min(1, progress)) * lengths[149]!;
  let at = 1;
  while (at < 149 && lengths[at]! < distance) at++;
  const width = lengths[at]! - lengths[at - 1]!, fraction = width ? (distance - lengths[at - 1]!) / width : 0;
  return start.map((_, d) => points[at - 1]![d]! + (points[at]![d]! - points[at - 1]![d]!) * fraction);
}
export function lottieKeyIndex(keys: LottieObject[], frame: number): number {
  let low = 0, high = keys.length - 1;
  while (low < high) { const mid = Math.ceil((low + high) / 2); if (Number(keys[mid]!.t) <= frame) low = mid; else high = mid - 1; }
  return low;
}
export function sampleLottieProperty(property: LottieObject, frame: number, validatedKeys?: LottieObject[]): number[] {
  if (property.a !== 1) return numericVector(property.k);
  const keys = validatedKeys ?? propertyKeys(property), at = lottieKeyIndex(keys, frame);
  const key = keys[at]!, next = keys[at + 1];
  const start = numericVector(key.s ?? keys[at - 1]?.e);
  if (!next || frame <= Number(key.t) || key.h === 1) return start;
  const end = numericVector(next.s ?? key.e), u = (frame - Number(key.t)) / (Number(next.t) - Number(key.t));
  if (end.length !== start.length) throw new Error('Property dimensions change between keys.');
  if (key.to && key.ti) return spatialValue(start, end, key, cubicBezierAt(...keyEase(key), u));
  return start.map((v, d) => v + (end[d]! - v) * cubicBezierAt(...keyEase(key, d), u));
}
export function setKeyEase(key: LottieObject, points: LottieEase, dimensions: number, dimension: number): void {
  if (!Number.isInteger(dimension) || dimension < 0 || dimension >= dimensions) throw new Error('Invalid easing dimension.');
  points.forEach((n, i) => { lottieNumber(n, 'Easing control', i % 2 === 0 ? 0 : -100, i % 2 === 0 ? 1 : 100); });
  const curves = Array.from({ length: dimensions }, (_, d) => d === dimension ? points : keyEase(key, d));
  key.o = { x: curves.map(c => c[0]), y: curves.map(c => c[1]) };
  key.i = { x: curves.map(c => c[2]), y: curves.map(c => c[3]) };
  delete key.h;
}
function linearKey(frame: number, value: number[]): LottieObject {
  return { t: frame, s: value, o: { x: 0, y: 0 }, i: { x: 1, y: 1 } };
}
function splitEase(points: LottieEase, fraction: number): [LottieEase, LottieEase] {
  const lerp = (a: number[], b: number[], u: number): number[] => a.map((v, d) => v + (b[d]! - v) * u);
  const p0 = [0, 0], p1 = points.slice(0, 2), p2 = points.slice(2), p3 = [1, 1];
  let low = 0, high = 1, parameter = fraction;
  for (let i = 0; i < 55; i++) {
    parameter = (low + high) / 2;
    const x = 3 * (1 - parameter) ** 2 * parameter * points[0] + 3 * (1 - parameter) * parameter ** 2 * points[2] + parameter ** 3;
    if (x < fraction) low = parameter; else high = parameter;
  }
  const a = lerp(p0, p1, parameter), b = lerp(p1, p2, parameter), c = lerp(p2, p3, parameter);
  const d = lerp(a, b, parameter), e = lerp(b, c, parameter), split = lerp(d, e, parameter);
  if (Math.abs(split[1]!) < 1e-10 || Math.abs(1 - split[1]!) < 1e-10) throw new Error('A key at this easing extremum cannot preserve the curve. Choose another frame.');
  const left: LottieEase = [a[0]! / fraction, a[1]! / split[1]!, d[0]! / fraction, d[1]! / split[1]!];
  const right: LottieEase = [(e[0]! - fraction) / (1 - fraction), (e[1]! - split[1]!) / (1 - split[1]!), (c[0]! - fraction) / (1 - fraction), (c[1]! - split[1]!) / (1 - split[1]!)];
  return [left, right];
}
export function writeLottieKey(property: LottieObject, frame: number, value: number[], interval: [number, number]): void {
  const wasAnimated = property.a === 1;
  const keys = wasAnimated ? propertyKeys(property) : [linearKey(interval[0], numericVector(property.k)), linearKey(interval[1], numericVector(property.k))];
  keys.forEach((key, i) => { if (!key.s) key.s = numericVector(keys[i - 1]?.e); });
  const exact = keys.findIndex(k => Number(k.t) === frame);
  if (exact >= 0) keys[exact]!.s = value;
  else {
    const previous = keys.findLast(k => Number(k.t) < frame);
    const next = keys.find(k => Number(k.t) > frame), inserted = linearKey(frame, value);
    if (previous?.to || previous?.ti) throw new Error('Insert keys on curved position paths at existing keys. Spatial path subdivision is not available.');
    if (previous?.h === 1) inserted.h = 1;
    else if (previous && next) {
      const curves = value.map((_, d) => splitEase(keyEase(previous, d), (frame - Number(previous.t)) / (Number(next.t) - Number(previous.t))));
      curves.forEach(([left, right], d) => { setKeyEase(previous, left, value.length, d); setKeyEase(inserted, right, value.length, d); });
    } else if (previous && !previous.o) { previous.o = { x: 0, y: 0 }; previous.i = { x: 1, y: 1 }; }
    keys.push(inserted);
    keys.sort((a, b) => Number(a.t) - Number(b.t));
  }
  // Legacy exports use e in addition to the next key's s. Keep both consistent.
  for (let i = 0; i < keys.length - 1; i++) if (keys[i]!.e !== undefined) keys[i]!.e = keys[i + 1]!.s;
  property.a = 1;
  property.k = keys;
}
export function deleteLottieKey(property: LottieObject, frame: number, scalar: boolean): void {
  const keys = propertyKeys(property), at = keys.findIndex(k => Number(k.t) === frame);
  if (at < 0) throw new Error('No keyframe at this source frame.');
  const fallback = numericVector(keys[at]!.s ?? keys[at - 1]?.e);
  // Materialise old terminal values before removing their predecessor.
  keys.forEach((key, i) => { if (!key.s) key.s = numericVector(keys[i - 1]?.e); });
  keys.splice(at, 1);
  if (keys.length < 2) {
    const value = keys.length ? numericVector(keys[0]!.s) : fallback;
    property.a = 0; property.k = scalar ? value[0]! : value;
  } else {
    for (let i = 0; i < keys.length - 1; i++) if (keys[i]!.e !== undefined) keys[i]!.e = keys[i + 1]!.s;
    property.k = keys;
  }
}
