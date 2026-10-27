// SPDX-License-Identifier: MPL-2.0
/**
 * Markdown tables and the D5 check from one or more runs.json files written by
 * bench.ts. Prints to stdout; where it goes is the caller's choice.
 *
 *   node scripts/render-dispatch-bench/report.ts <out>/runs.json [<rep2>/runs.json ...]
 *
 * Each runs.json is one repetition set; the D5 table counts the repetitions
 * in which each check held, and pull meets D5 for a configuration only when
 * every repetition holds every check.
 *
 * D5 (plan 324): pull becomes the default only where it matches push at p50
 * under light load AND beats push on p95 and throughput under saturation.
 * "Matches" here means pull's p50 is no more than 10% (or 50 ms, whichever is
 * larger) above push's; "beats" means strictly better. Throughput counts only
 * renders that succeeded, over the time until every render settled, and a
 * mode that completed fewer of the burst's renders cannot win on throughput:
 * failing work fast is not throughput.
 *
 * Summaries are recomputed from the raw-*.json files beside runs.json when
 * they are there, so a change to stats.ts applies to past runs too.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { summariseByPool, type RenderRow, type Summary } from './stats.ts';

interface RunRecord { corpus: string; slots?: number; workers: number; mode: string; load: string; rate: number | null; jobs: number; summary: Record<string, Summary>; refused: number; restarts: Record<string, number> }

export function matches(pull: number | null, push: number | null): boolean {
  if (pull === null || push === null) return false;
  return pull <= push + Math.max(0.1 * push, 0.05);
}

type Check = { light: boolean | null; p95: boolean | null; throughput: boolean | null };

/** One repetition's D5 checks. p95 counts a failed render as never delivered. */
export function d5(records: readonly RunRecord[], corpus: string, workers: number, slots = 4): Check & { verdict: string } {
  const get = (mode: string, load: string) => records.find((r) => r.corpus === corpus && r.workers === workers && (r.slots ?? 4) === slots && r.mode === mode && r.load === load)?.summary.all;
  const lp = get('push', 'light'), ll = get('pull', 'light'), sp = get('push', 'saturation'), sl = get('pull', 'saturation');
  const light = lp && ll ? matches(ll.p50, lp.p50) : null;
  const delivered = (s: Summary) => s.p95Delivered ?? Infinity;
  const p95 = sp && sl ? delivered(sl) < delivered(sp) : null;
  const throughput = sp && sl && sp.throughput !== null && sl.throughput !== null
    ? sl.succeeded > sp.succeeded || (sl.succeeded === sp.succeeded && sl.throughput > sp.throughput) : null;
  const verdict = light === null || p95 === null || throughput === null ? 'incomplete'
    : light && p95 && throughput ? 'pull meets D5' : 'push stays';
  return { light, p95, throughput, verdict };
}

/** Across repetitions (one runs.json each): how many held. Pull "meets D5" for a
 *  configuration only when every repetition holds every check. */
export function d5Across(sets: readonly (readonly RunRecord[])[], corpus: string, workers: number, slots: number): string[] {
  const checks = sets.map((set) => d5(set, corpus, workers, slots));
  const tally = (key: keyof Check) => {
    const known = checks.filter((c) => c[key] !== null);
    return { held: known.filter((c) => c[key]).length, of: known.length };
  };
  const t = { light: tally('light'), p95: tally('p95'), throughput: tally('throughput') };
  const all = (x: { held: number; of: number }) => x.of > 0 && x.held === x.of;
  const verdict = !t.light.of || !t.p95.of || !t.throughput.of ? 'incomplete'
    : all(t.light) && all(t.p95) && all(t.throughput) ? 'pull meets D5' : 'not met';
  return [`${t.light.held}/${t.light.of}`, `${t.p95.held}/${t.p95.of}`, `${t.throughput.held}/${t.throughput.of}`, verdict];
}

const fmt = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '-' : `${v}${unit}`);

export function report(sets: readonly (readonly RunRecord[])[]): string {
  const records = sets.flatMap((set, i) => set.map((r) => ({ ...r, set: i + 1 })));
  const lines: string[] = [];
  for (const corpus of [...new Set(records.map((r) => r.corpus))]) {
    lines.push(`### Corpus: ${corpus}`, '');
    lines.push('| Set | Workers x slots | Load | Mode | OK / renders | Throughput (ok/s) | p50 (s) | p95 (s) | p99 (s) | p95 incl. failures (s) | Retries | Failures | tier-a p50 / p95 | tier-b p50 / p95 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    const order = ['light', 'medium', 'saturation'];
    const rows = records.filter((r) => r.corpus === corpus)
      .sort((a, b) => a.workers - b.workers || (a.slots ?? 4) - (b.slots ?? 4) || order.indexOf(a.load) - order.indexOf(b.load) || a.set - b.set || a.mode.localeCompare(b.mode));
    for (const r of rows) {
      const a = r.summary.all!, ta = r.summary['tier-a'], tb = r.summary['tier-b'];
      const failures = Object.entries(a.errors).map(([code, n]) => `${code} ${n}`).join(', ') || '0';
      const delivered = a.p95Delivered === Infinity || a.p95Delivered === null ? 'not delivered' : String(a.p95Delivered);
      lines.push(`| ${r.set} | ${r.workers} x ${r.slots ?? 4} | ${r.load}${r.rate ? ` (${r.rate}/s)` : ''} | ${r.mode} | ${a.succeeded} / ${a.renders} | ${fmt(a.throughput)} | ${fmt(a.p50)} | ${fmt(a.p95)} | ${fmt(a.p99)} | ${delivered} | ${a.retries} | ${failures} | ${ta ? `${fmt(ta.p50)} / ${fmt(ta.p95)}` : '-'} | ${tb ? `${fmt(tb.p50)} / ${fmt(tb.p95)}` : '-'} |`);
    }
    lines.push('', `D5 across ${sets.length} repetition set(s): how many repetitions held each check.`, '',
      '| Workers x slots | light p50 matches | saturation p95 better (failures count as not delivered) | saturation throughput better | D5 |', '|---|---|---|---|---|');
    for (const key of [...new Set(rows.map((r) => `${r.workers}x${r.slots ?? 4}`))]) {
      const [workers, slots] = key.split('x').map(Number) as [number, number];
      lines.push(`| ${workers} x ${slots} | ${d5Across(sets, corpus, workers, slots).join(' | ')} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

/** Re-summarise each run from its raw rows, when the raw file is beside runs.json. */
export function refresh(records: RunRecord[], dir: string): RunRecord[] {
  return records.map((r) => {
    const slots = r.slots ?? 4;
    const raw = join(dir, `raw-${r.corpus}-${r.mode}-${r.workers}${slots === 4 ? '' : `x${slots}`}-${r.load}.json`);
    if (!existsSync(raw)) return r;
    return { ...r, summary: summariseByPool((JSON.parse(readFileSync(raw, 'utf8')) as { rows: RenderRow[] }).rows) };
  });
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const sets = process.argv.slice(2).map((file) => refresh(JSON.parse(readFileSync(file, 'utf8')) as RunRecord[], dirname(file)));
  console.log(report(sets));
}
