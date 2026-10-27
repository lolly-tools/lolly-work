// SPDX-License-Identifier: MPL-2.0
/**
 * The fixed corpus for the push-against-pull benchmark (plan 324 M3, D5).
 * The same seed gives the same jobs in the same order and the same arrival
 * times, so push and pull see identical work.
 *
 * tier-a jobs render in Work's jsdom path; their PNG output is rasterised by
 * the worker's Chromium, the default once a worker is set. Today's Lolly
 * catalogue has almost no hook-less tool with an SVG template (battlecards and
 * the like are HTML, which the jsdom path cannot export), so tier-a uses
 * `bench-card`, a hook-less SVG card added to the benchmark's shell build
 * (README.md). tier-b jobs are hooked tools: the worker renders them in the
 * real shell, and a PNG adds a second worker call to rasterise.
 *
 *  - `mixed`: half tier-a, half tier-b, like an automation queue.
 *  - `light`: tier-a only, mostly PNG: short Chromium jobs (rasterise), so
 *    dispatch and balancing are a large share of each render. It is the corpus
 *    that fits 16 workers on one laptop-sized node.
 */
export type Pool = 'tier-a' | 'tier-b';
export type CorpusName = 'mixed' | 'light';
export interface CorpusEntry { id: string; pool: Pool; toolId: string; format: 'svg' | 'png'; weight: number; inputs: (n: number) => Record<string, unknown> }
export interface BenchJob { seq: number; entry: string; pool: Pool; toolId: string; format: 'svg' | 'png'; inputs: Record<string, unknown> }
export type Load = 'light' | 'medium' | 'saturation';

const card = (format: 'svg' | 'png', weight: number): CorpusEntry => ({ id: `bench-card-${format}`, pool: 'tier-a', toolId: 'bench-card', format, weight,
  inputs: (n) => ({ title: `Bench card ${n}`, subtitle: `Render ${n} of the fixed corpus` }) });

export const CORPORA: Readonly<Record<CorpusName, readonly CorpusEntry[]>> = {
  mixed: [
    card('svg', 3), card('png', 2),
    { id: 'qr-code-svg', pool: 'tier-b', toolId: 'qr-code', format: 'svg', weight: 2, inputs: (n) => ({ url: `https://example.com/bench/${n}` }) },
    { id: 'qr-code-png', pool: 'tier-b', toolId: 'qr-code', format: 'png', weight: 1, inputs: (n) => ({ url: `https://example.com/bench/${n}` }) },
    { id: 'chart-svg', pool: 'tier-b', toolId: 'chart', format: 'svg', weight: 1, inputs: (n) => ({ heading: `Bench chart ${n}` }) },
    { id: 'color-palette-svg', pool: 'tier-b', toolId: 'color-palette', format: 'svg', weight: 1, inputs: (n) => ({ steps: 5 + (n % 4) }) },
  ],
  light: [card('svg', 1), card('png', 3)],
};
/** The mixed corpus, the default. */
export const CORPUS = CORPORA.mixed;

/** mulberry32: small, fast and the same on every Node. */
export function random(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function jobs(count: number, seed: number, corpus: readonly CorpusEntry[] = CORPUS): BenchJob[] {
  const next = random(seed);
  const total = corpus.reduce((sum, e) => sum + e.weight, 0);
  return Array.from({ length: count }, (_, seq) => {
    let pick = next() * total;
    const entry = corpus.find((e) => (pick -= e.weight) < 0) ?? corpus[corpus.length - 1]!;
    return { seq, entry: entry.id, pool: entry.pool, toolId: entry.toolId, format: entry.format, inputs: entry.inputs(seq) };
  });
}

/** Arrival offsets in ms: Poisson at `rate` per second, or all at once for saturation. */
export function arrivals(count: number, seed: number, rate: number | null): number[] {
  if (rate === null) return Array.from({ length: count }, () => 0);
  const next = random(seed ^ 0x5bd1e995);
  let t = 0;
  return Array.from({ length: count }, () => {
    const at = t;
    t += -Math.log(1 - next()) / rate * 1000;
    return Math.round(at);
  });
}
