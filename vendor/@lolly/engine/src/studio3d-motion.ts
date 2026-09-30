// SPDX-License-Identifier: MPL-2.0
/**
 * What the subject does over the loop (plan 267, lane A).
 *
 * One pure function answers it: `studioObjectPose(scene, time, clipSeconds)` returns
 * the pose of the subject at one moment as a change from where the recipe places it.
 * The host applies that change on top of the row it already reads, so the engine owns
 * how every loop moves, and web, CLI and MCP draw the same frames.
 *
 * Three rules hold for every kind, and the tests pin all three:
 *
 * 1. At phase 0 the pose is exactly the rest pose. A poster, a contact sheet and the
 *    empty-frame check all sample time 0, so a loop that started anywhere else would
 *    change what a still of an animated document looks like.
 * 2. Nothing here reads a clock or a random number. The pose is closed form in the
 *    phase, so two hosts asked for the same moment return the same numbers.
 * 3. A loop travels no further than it says: `lift` never passes 4 studio units, which
 *    is what keeps the subject inside the shadow frustum at the largest amount.
 *
 * `hover`, `pulse` and `wobble` run continuously. `pop`, `coin`, `jump`, `spinland`
 * and `burst` play once over the front of the loop and then hold the rest pose for
 * `motion.rest` of it, so an object that has come down sits before it goes again.
 *
 * `motion.amount` scales how far a loop travels. `burst` is the exception: the pose
 * carries how far the shatter has gone, from 0 for the whole object to 1 for fully
 * flown apart, and the host multiplies its own spread by `motion.amount`.
 */
import type { StudioMotionKind, StudioPoseV1, StudioSceneV1 } from '@lolly-tools/core';
import { studioTime } from './studio3d.ts';

export type { StudioPoseV1 } from '@lolly-tools/core';

/** Every loop the subject can run, in the order the manifest offers them. */
export const STUDIO_MOTION_KINDS = [
  'still',
  'turntable',
  'hover',
  'pulse',
  'wobble',
  'pop',
  'coin',
  'jump',
  'spinland',
  'burst',
] as const satisfies readonly StudioMotionKind[];

/** The kinds that play once and then hold the rest pose for the rest of the loop. */
export const STUDIO_ONE_SHOT_KINDS = ['pop', 'coin', 'jump', 'spinland', 'burst'] as const;

/**
 * How high any loop may lift the subject, in studio units. The shadow frustum is built
 * from the footprint, so a lift past this would leave the subject's shadow behind.
 */
export const STUDIO_POSE_MAX_LIFT = 4;

/** The smallest a squash may make the subject, so a volume-preserving scale stays finite. */
const MIN_SCALE = 0.05;

function rest(): StudioPoseV1 {
  return { spin: 0, tilt: [0, 0], lift: 0, scale: [1, 1, 1], burst: 0 };
}

function freeze(pose: StudioPoseV1): StudioPoseV1 {
  Object.freeze(pose.tilt);
  Object.freeze(pose.scale);
  return Object.freeze(pose);
}

/**
 * Where the recipe puts the subject: no turn, no tilt, no lift, its own scale, whole.
 * Frozen, because it is shared; `studioObjectPose` always returns a fresh pose.
 */
export const STUDIO_POSE_REST: StudioPoseV1 = freeze(rest());

function clamp(value: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback;
  return value < min ? min : value > max ? max : value;
}

function clamp01(u: number): number {
  return u < 0 ? 0 : u > 1 ? 1 : u;
}

function radians(degrees: number): number {
  return (degrees * Math.PI) / 180;
}

/** A smooth 0 to 1 that starts and ends at a standstill. */
export function smoothstep(u: number): number {
  const t = clamp01(u);
  return t * t * (3 - 2 * t);
}

/**
 * One half of a sine over a window: 0 at both edges and outside it, 1 in the middle.
 * Every squash and crouch here is written as a bump, which is what makes the pose
 * exactly the rest pose at the start and the end of a loop rather than nearly so.
 */
export function bump(value: number, from: number, to: number): number {
  if (!(to > from)) return 0;
  const u = (value - from) / (to - from);
  return u <= 0 || u >= 1 ? 0 : Math.sin(Math.PI * u);
}

/**
 * An ease out that passes its target and settles back on it: 0 at 0, exactly 1 at 1,
 * with a swell of `overshoot` added two thirds of the way through. The peak sits a
 * little under 1 plus the overshoot, because the ease has not quite arrived by then.
 */
export function backOut(u: number, overshoot: number): number {
  const t = clamp01(u);
  const settle = 1 - (1 - t) ** 3;
  const swell = 6.75 * t * t * (1 - t);
  return settle + overshoot * swell;
}

/**
 * An ease in that dips below 0 before it rises, which is the wind-up before a move:
 * 0 at 0, exactly 1 at 1, and `depth` below zero a third of the way through.
 */
export function anticipate(u: number, depth: number): number {
  const t = clamp01(u);
  return smoothstep(t) - depth * 6.75 * t * (1 - t) ** 2;
}

/** The three-stage bounce: 0 to 1, landing and bouncing twice on the way. */
export function bounceOut(u: number): number {
  const t = clamp01(u);
  const n = 7.5625;
  const d = 2.75;
  if (t < 1 / d) return n * t * t;
  if (t < 2 / d) {
    const x = t - 1.5 / d;
    return n * x * x + 0.75;
  }
  if (t < 2.5 / d) {
    const x = t - 2.25 / d;
    return n * x * x + 0.9375;
  }
  const x = t - 2.625 / d;
  return n * x * x + 0.984375;
}

/** The loop fractions of the bounce ease the subject touches down at. */
const BOUNCE_LANDINGS = [1 / 2.75, 2.25 / 2.75];

/** A parabola over a window: 0 at both ends, 1 in the middle: a hop, up and down. */
function arc(u: number): number {
  const t = clamp01(u);
  return 4 * t * (1 - t);
}

/** How far a loop travels upward, kept inside the shadow frustum at every amount. */
function travel(units: number, amount: number): number {
  return Math.min(STUDIO_POSE_MAX_LIFT, units * amount);
}

/** A squash of `drop` on the up axis, widened on the other two so the volume holds. */
function squash(pose: StudioPoseV1, drop: number): void {
  const up = Math.max(MIN_SCALE, 1 - drop);
  const side = 1 / Math.sqrt(up);
  pose.scale = [side, up, side];
}

/**
 * The subject's pose at one moment of the loop.
 *
 * `time` is the moment the caller wants on the same clock `studioTime` reads: with
 * `clipSeconds` it is a fraction of the clip, without it a fraction of the loop. The
 * result is always a fresh object, and at phase 0 it equals `STUDIO_POSE_REST`.
 */
export function studioObjectPose(
  scene: StudioSceneV1,
  time: number,
  clipSeconds?: number
): StudioPoseV1 {
  const motion = scene.motion;
  const kind = motion.kind;
  if (kind === 'still') return rest();
  // The turntable is the loop this tool shipped with: its turn is studioTime, to the
  // last bit, so every turntable document renders exactly as it always has.
  if (kind === 'turntable') {
    const turning = rest();
    turning.spin = studioTime(scene, time, clipSeconds);
    return turning;
  }

  const seconds = Number.isFinite(time)
    ? Math.max(0, time) * (clipSeconds && clipSeconds > 0 ? clipSeconds : motion.seconds)
    : 0;
  const p = (seconds / motion.seconds) % 1;
  const amount = clamp(motion.amount, 0.25, 2, 1);
  const pose = rest();

  if (kind === 'hover') {
    // A float up and down with a small sway, both starting from the rest pose.
    pose.lift = 0.25 * amount * ((1 - Math.cos(2 * Math.PI * p)) / 2);
    pose.spin = radians(6) * amount * Math.sin(2 * Math.PI * p);
    return pose;
  }
  if (kind === 'pulse') {
    // A breath: the whole subject evenly, so a logo keeps its proportions.
    const s = 1 + 0.06 * amount * Math.sin(2 * Math.PI * p);
    pose.scale = [s, s, s];
    return pose;
  }
  if (kind === 'wobble') {
    // Three rocks that settle over the loop. The damping is a polynomial, not an
    // exponential, because two engines need not agree on the last bit of exp().
    const damping = (1 - p) ** 2;
    pose.tilt = [0, radians(8) * amount * Math.sin(2 * Math.PI * 3 * p) * damping];
    return pose;
  }

  // The one-shot loops: the move over the front of the loop, then the rest pose.
  const held = clamp(motion.rest, 0, 0.9, 0.25);
  const active = 1 - held;
  if (!(active > 0)) return pose;
  const q = p / active;
  if (q >= 1) return pose;

  if (kind === 'pop') {
    // A wind-up, a collapse, then back past its own size and settled. Even, like pulse.
    const collapse = Math.min(0.9, 0.35 * amount);
    const s =
      q < 0.45
        ? 1 - collapse * anticipate(q / 0.45, 0.18)
        : 1 - collapse * (1 - backOut((q - 0.45) / 0.55, 0.43));
    const even = Math.max(MIN_SCALE, s);
    pose.scale = [even, even, even];
    return pose;
  }
  if (kind === 'coin') {
    // One whole flip on the way up and down, then a small squash on the landing.
    const flight = clamp01(q / 0.8);
    pose.lift = travel(1.2, amount) * arc(flight);
    pose.tilt = [flight >= 1 ? 0 : 2 * Math.PI * flight, 0];
    squash(pose, 0.12 * amount * bump(q, 0.8, 1));
    return pose;
  }
  if (kind === 'jump') {
    // Crouch, stretch through the arc, squash on landing, then one small settle.
    pose.lift = travel(1.6, amount) * arc((q - 0.2) / 0.65);
    const drop =
      0.18 * amount * bump(q, 0, 0.2) +
      0.22 * amount * bump(q, 0.85, 0.95) +
      0.07 * amount * bump(q, 0.95, 1) -
      0.1 * amount * bump(q, 0.2, 0.85);
    squash(pose, drop);
    return pose;
  }
  if (kind === 'spinland') {
    // Up, then a fall that bounces to a stop, turning once on the way down.
    const from = 0.3;
    const span = 1 - from;
    const lands = BOUNCE_LANDINGS.map((stage) => from + span * stage);
    const height = travel(3, amount);
    pose.lift =
      q < from ? height * smoothstep(q / from) : height * (1 - bounceOut((q - from) / span));
    pose.spin = 2 * Math.PI * clamp01(q / lands[0]!);
    squash(
      pose,
      0.22 * amount * bump(q, lands[0]!, lands[0]! + 0.09) +
        0.09 * amount * bump(q, lands[1]!, lands[1]! + 0.05)
    );
    return pose;
  }
  // burst: a crouch, then out and back. How far the fragments fly is the host's own
  // spread times motion.amount; this is only how far through the effect the loop is.
  pose.burst = (1 - Math.cos(2 * Math.PI * q)) / 2;
  squash(pose, 0.1 * amount * bump(q, 0, 0.14));
  return pose;
}
