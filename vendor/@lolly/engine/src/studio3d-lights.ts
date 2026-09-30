// SPDX-License-Identifier: MPL-2.0
/** Light placement on the preview: orbit a source about the subject and save it where the rig keeps it. */
import type { StudioSceneV1, StudioVector3 } from '@lolly-tools/core';

export type StudioValues = Record<string, unknown>;
/** Every light aims here; a placed light keeps its distance from this point. */
export const STUDIO_LIGHT_TARGET: StudioVector3 = [0, 1.5, 0];
export const STUDIO_LIGHT_RANGE = 30;
export const STUDIO_PRESET_LIGHT_POSITIONS: Record<'key' | 'fill' | 'rim', StudioVector3> = {
  key: [-3.6, 6.8, 4],
  fill: [5, 3, 4],
  rim: [3, 5, -3],
};
/** The reflection card sits this far from the key so it follows a moved key light. */
export const STUDIO_KEY_CARD_OFFSET: StudioVector3 = [-0.4, -2.8, -1];

const round = (n: number): number => Math.round(n * 1000) / 1000;
const clampRange = (n: number): number =>
  Math.max(-STUDIO_LIGHT_RANGE, Math.min(STUDIO_LIGHT_RANGE, round(n)));

/**
 * Turn a light about the target by azimuth and elevation degrees, keeping its distance.
 * Elevation stops short of the poles so the source never sits exactly above the subject
 * and loses its heading.
 */
export function studioOrbitLight(
  position: StudioVector3,
  azimuthDegrees: number,
  elevationDegrees: number,
  target: StudioVector3 = STUDIO_LIGHT_TARGET
): StudioVector3 {
  const dx = position[0] - target[0],
    dy = position[1] - target[1],
    dz = position[2] - target[2];
  const radius = Math.max(0.5, Math.hypot(dx, dy, dz));
  const azimuth = Math.atan2(dx, dz) + (azimuthDegrees * Math.PI) / 180;
  const elevation = Math.max(
    (-80 * Math.PI) / 180,
    Math.min((88 * Math.PI) / 180, Math.asin(dy / radius) + (elevationDegrees * Math.PI) / 180)
  );
  return [
    clampRange(target[0] + Math.sin(azimuth) * Math.cos(elevation) * radius),
    clampRange(target[1] + Math.sin(elevation) * radius),
    clampRange(target[2] + Math.cos(azimuth) * Math.cos(elevation) * radius),
  ];
}

/** Move a light along its line to the target; the distance stays between 1 and the range. */
export function studioScaleLightDistance(
  position: StudioVector3,
  factor: number,
  target: StudioVector3 = STUDIO_LIGHT_TARGET
): StudioVector3 {
  const d = [position[0] - target[0], position[1] - target[1], position[2] - target[2]];
  const radius = Math.max(0.5, Math.hypot(d[0]!, d[1]!, d[2]!));
  const next = Math.max(1, Math.min(STUDIO_LIGHT_RANGE, radius * factor)) / radius;
  return [
    clampRange(target[0] + d[0]! * next),
    clampRange(target[1] + d[1]! * next),
    clampRange(target[2] + d[2]! * next),
  ];
}

/** The lights a person can place: every rig light except the card that follows the key. */
export function studioPlaceableLights(scene: StudioSceneV1): number[] {
  return scene.lights.flatMap((light, i) => (light.id === 'key-card' ? [] : [i]));
}

/**
 * Save one light's position where its rig keeps it: a preset rig stores `keyPosition`,
 * `fillPosition` or `rimPosition`; a custom rig edits that row of `lights`.
 */
export function studioLightEdit(
  values: StudioValues,
  scene: StudioSceneV1,
  index: number,
  position: StudioVector3
): { id: string; value: unknown } {
  const light = scene.lights[index];
  if (!light || light.id === 'key-card') throw new Error('That light cannot be moved.');
  const [x, y, z] = position.map(clampRange) as StudioVector3;
  if (values.studio === 'custom') {
    const rows = Array.isArray(values.lights) ? (values.lights as StudioValues[]) : [];
    const row = Number(light.id.replace('light-', '')) - 1;
    if (!rows[row]) throw new Error('That light is not in the custom rig.');
    return { id: 'lights', value: rows.map((r, i) => (i === row ? { ...r, x, y, z } : r)) };
  }
  if (!['key', 'fill', 'rim'].includes(light.id)) throw new Error('That light cannot be moved.');
  return { id: `${light.id}Position`, value: { x, y, z } };
}
