// SPDX-License-Identifier: MPL-2.0
/** Project time stays in seconds; frame arithmetic always goes through this module. */
export interface Rational { numerator: number; denominator: number }
export const PROJECT_RATES = [24, 25, 30, 50, 60] as const;
export const DEFAULT_RATE: Rational = Object.freeze({ numerator: 30, denominator: 1 });

export function projectRate(value: unknown): Rational {
  const n = Number(value);
  return PROJECT_RATES.some(rate => rate === n) ? { numerator: n, denominator: 1 } : DEFAULT_RATE;
}
function valid(rate: Rational): boolean {
  return Number.isSafeInteger(rate.numerator) && rate.numerator > 0
    && Number.isSafeInteger(rate.denominator) && rate.denominator > 0;
}
export function frameAt(sec: number, rate: Rational = DEFAULT_RATE): number {
  if (!Number.isFinite(sec)) return 0;
  const r = valid(rate) ? rate : DEFAULT_RATE;
  return Math.round(sec * r.numerator / r.denominator);
}
export function timeOfFrame(frame: number, rate: Rational = DEFAULT_RATE): number {
  if (!Number.isFinite(frame)) return 0;
  const r = valid(rate) ? rate : DEFAULT_RATE;
  return Math.round(frame) * r.denominator / r.numerator;
}
export function quantise(sec: number, rate: Rational = DEFAULT_RATE): number {
  return timeOfFrame(frameAt(sec, rate), rate);
}
/** Round once for the existing millisecond wire, after resolving the frame. */
export function frameSeconds(sec: number, rate: Rational = DEFAULT_RATE): number {
  return Math.round(quantise(sec, rate) * 1000) / 1000;
}
