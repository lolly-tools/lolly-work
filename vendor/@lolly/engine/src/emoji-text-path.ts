// SPDX-License-Identifier: MPL-2.0
/** Bounded path sampling for mixed text and emoji on an SVG baseline. */
import { parseSvgPath } from './svg-path.ts';
import { pathFromSubPaths } from './geom/path.ts';
import { evalCubic } from './geom/bezier.ts';

export interface EmojiPathSample { x: number; y: number; angle: number }
export interface EmojiTextPath { length: number; at(distance: number): EmojiPathSample }
export function emojiTextPath(d: string): EmojiTextPath {
  if (d.length > 32_768) throw new Error('SVG text path exceeds the layout budget.');
  const paths = pathFromSubPaths(parseSvgPath(d));
  if (paths.length !== 1 || !paths[0]?.curves.length || paths[0].curves.length > 512) throw new Error('SVG text needs one bounded continuous path.');
  const points: Array<{x:number;y:number;s:number}> = [];
  let length = 0;
  for (const curve of paths[0].curves) {
    if (curve.some(value => !Number.isFinite(value) || Math.abs(value) > 1e6)) throw new Error('SVG text path coordinates are unsupported.');
    // A fixed sample count bounds work even for a hostile curve. Cubic arc
    // approximations use the same points in the browser and headless shells.
    for (let i = points.length ? 1 : 0; i <= 64; i++) {
      const p = evalCubic(curve, i / 64), last = points.at(-1);
      if (last) length += Math.hypot(p.x - last.x, p.y - last.y);
      points.push({ ...p, s: length });
    }
  }
  if (!(length > 0)) throw new Error('SVG text needs a nonempty path.');
  return { length, at(distance) {
    if (!Number.isFinite(distance)) throw new Error('Invalid SVG text path offset.');
    let lo = 0, hi = points.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (points[mid]!.s < distance) lo = mid; else hi = mid; }
    const a = points[lo]!, b = points[hi]!;
    const t = (distance - a.s) / (b.s - a.s || 1);
    return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, angle: Math.atan2(b.y - a.y, b.x - a.x) * 180 / Math.PI };
  } };
}
