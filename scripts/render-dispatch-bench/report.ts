// SPDX-License-Identifier: MPL-2.0
/**
 * Markdown tables and the D5 check from one or more runs.json files written by
 * bench.ts. Prints to stdout; where it goes is the caller's choice.
 *
 *   node scripts/render-dispatch-bench/report.ts <out>/runs.json [...more]
 *
 * D5 (plan 324): pull becomes the default only where it matches push at p50
 * under light load AND beats push on p95 and throughput under saturation.
 * "Matches" here means pull's p50 is no more than 10% (or 50 ms, whichever is
 * larger) above push's; "beats" means strictly better.
 */
import { readFileSync } from 'node:fs';
import type { Summary } from './stats.ts';

interface RunRecord { corpus: string; workers: number; mode: string; load: string; rate: number | null; jobs: number; summary: Record<string, Summary>; refused: number; restarts: Record<string, number> }

export function matches(pull: number | null, push: number | null): boolean {
  if (pull === null || push === null) return false;
  return pull <= push + Math.max(0.1 * push, 0.05);
}

export function d5(records: readonly RunRecord[], corpus: string, workers: number): { light: boolean | null; p95: boolean | null; throughput: boolean | null; verdict: string } {
  const get = (mode: string, load: string) => records.find((r) => r.corpus === corpus && r.workers === workers && r.mode === mode && r.load === load)?.summary.all;
  const lp = get('push', 'light'), ll = get('pull', 'light'), sp = get('push', 'saturation'), sl = get('pull', 'saturation');
  const light = lp && ll ? matches(ll.p50, lp.p50) : null;
  const p95 = sp && sl && sp.p95 !== null && sl.p95 !== null ? sl.p95 < sp.p95 : null;
  const throughput = sp && sl && sp.throughput !== null && sl.throughput !== null ? sl.throughput > sp.throughput : null;
  const verdict = light === null || p95 === null || throughput === null ? 'incomplete'
    : light && p95 && throughput ? 'pull meets D5' : 'push stays';
  return { light, p95, throughput, verdict };
}

const fmt = (v: number | null | undefined, unit = '') => (v === null || v === undefined ? '-' : `${v}${unit}`);

export function report(records: readonly RunRecord[]): string {
  const lines: string[] = [];
  for (const corpus of [...new Set(records.map((r) => r.corpus))]) {
    lines.push(`### Corpus: ${corpus}`, '');
    lines.push('| Workers | Load | Mode | OK / renders | Throughput (/s) | p50 (s) | p95 (s) | p99 (s) | Retries | Failures | tier-a p50 / p95 | tier-b p50 / p95 |');
    lines.push('|---|---|---|---|---|---|---|---|---|---|---|---|');
    const order = ['light', 'medium', 'saturation'];
    const rows = records.filter((r) => r.corpus === corpus)
      .sort((a, b) => a.workers - b.workers || order.indexOf(a.load) - order.indexOf(b.load) || a.mode.localeCompare(b.mode));
    for (const r of rows) {
      const a = r.summary.all!, ta = r.summary['tier-a'], tb = r.summary['tier-b'];
      const failures = Object.entries(a.errors).map(([code, n]) => `${code} ${n}`).join(', ') || '0';
      lines.push(`| ${r.workers} | ${r.load}${r.rate ? ` (${r.rate}/s)` : ''} | ${r.mode} | ${a.succeeded} / ${a.renders} | ${fmt(a.throughput)} | ${fmt(a.p50)} | ${fmt(a.p95)} | ${fmt(a.p99)} | ${a.retries} | ${failures} | ${ta ? `${fmt(ta.p50)} / ${fmt(ta.p95)}` : '-'} | ${tb ? `${fmt(tb.p50)} / ${fmt(tb.p95)}` : '-'} |`);
    }
    lines.push('', '| Workers | light p50 matches | saturation p95 better | saturation throughput better | D5 |', '|---|---|---|---|---|');
    for (const workers of [...new Set(rows.map((r) => r.workers))]) {
      const v = d5(records, corpus, workers);
      const yn = (b: boolean | null) => (b === null ? '-' : b ? 'yes' : 'no');
      lines.push(`| ${workers} | ${yn(v.light)} | ${yn(v.p95)} | ${yn(v.throughput)} | ${v.verdict} |`);
    }
    lines.push('');
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const records = process.argv.slice(2).flatMap((file) => JSON.parse(readFileSync(file, 'utf8')) as RunRecord[]);
  console.log(report(records));
}
