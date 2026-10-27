// SPDX-License-Identifier: MPL-2.0
/**
 * The benchmark's load client. Runs inside the cluster as a Job in Work's image
 * (manifests.ts clientJob), so no laptop network sits in the measurement.
 *
 * It signs in through the bench instance's dev provider, submits the plan's
 * renders to the durable API at their arrival offsets (open loop: a slow
 * server does not slow the arrivals), samples /metrics once a second, waits
 * until every render has settled, and prints one JSON result. Latency comes
 * from the database's own timestamps (created_at to finished_at), so client
 * polling never rounds it.
 */
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import type { BenchJob } from './corpus.ts';

interface Plan { runId: string; jobs: BenchJob[]; offsetsMs: number[]; deadlineMs: number }
const plan = JSON.parse(readFileSync(process.env.BENCH_PLAN!, 'utf8')) as Plan;
const WORK = process.env.WORK_URL!;
const { Client } = createRequire('/app/package.json')('pg') as typeof import('pg');
const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const log = (message: string) => console.error(`[bench-client] ${message}`);

async function ready(): Promise<void> {
  for (let i = 0; i < 300; i++) {
    try { if ((await fetch(`${WORK}/healthz`, { signal: AbortSignal.timeout(2000) })).ok) return; } catch { /* starting */ }
    await delay(1000);
  }
  throw new Error('Work did not become ready');
}

async function signIn(): Promise<string> {
  const res = await fetch(`${WORK}/api/auth/dev?email=bench%40bench.invalid`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  if (!cookie) throw new Error(`dev sign-in failed (${res.status})`);
  return cookie.split(';')[0]!;
}

/** /metrics samples: the peak of each render series, and the final counters. */
const peaks: Record<string, number> = {};
let finalCounters: Record<string, number> = {};
async function scrape(): Promise<Record<string, number>> {
  const text = await (await fetch(`${WORK}/metrics`, { headers: { authorization: `Bearer ${process.env.LW_METRICS_TOKEN}` }, signal: AbortSignal.timeout(5000) })).text();
  const values: Record<string, number> = {};
  for (const line of text.split('\n')) {
    if (!line.startsWith('lw_render_')) continue;
    const at = line.lastIndexOf(' ');
    values[line.slice(0, at)] = Number(line.slice(at + 1));
  }
  return values;
}

async function main(): Promise<void> {
  await ready();
  const cookie = await signIn();
  const db = new Client({ connectionString: process.env.DATABASE_URL });
  await db.connect();
  let sampling = true;
  const sampler = (async () => {
    while (sampling) {
      try {
        const values = await scrape();
        for (const [series, value] of Object.entries(values)) if (!series.includes('_total')) peaks[series] = Math.max(peaks[series] ?? 0, value);
      } catch { /* a missed sample is not a result */ }
      await delay(1000);
    }
  })();

  const accepted: { seq: number; id: string }[] = [];
  const refused: { seq: number; status: number }[] = [];
  const started = Date.now();
  let inFlight = 0;
  const submit = async (job: BenchJob): Promise<void> => {
    while (inFlight >= 32) await delay(2);
    inFlight++;
    try {
      const res = await fetch(`${WORK}/api/v1/renders`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
        body: JSON.stringify({ toolId: job.toolId, format: job.format, inputs: job.inputs }) });
      const body = await res.json().catch(() => ({})) as { id?: string };
      if (res.status === 202 && body.id) accepted.push({ seq: job.seq, id: body.id });
      else refused.push({ seq: job.seq, status: res.status });
    } catch { refused.push({ seq: job.seq, status: 0 }); }
    finally { inFlight--; }
  };
  await Promise.all(plan.jobs.map(async (job, i) => {
    const wait = started + plan.offsetsMs[i]! - Date.now();
    if (wait > 0) await delay(wait);
    await submit(job);
  }));
  const submittedMs = Date.now() - started;
  log(`submitted ${accepted.length} (refused ${refused.length}) in ${submittedMs} ms`);

  const ids = accepted.map((a) => a.id);
  const deadline = started + plan.deadlineMs;
  for (;;) {
    const { rows } = await db.query(`select count(*)::integer as n from renders where id = any($1) and state in ('succeeded','failed','cancelled')`, [ids]);
    if (rows[0].n >= ids.length || Date.now() > deadline) break;
    await delay(500);
  }
  sampling = false;
  await sampler;
  try { finalCounters = Object.fromEntries(Object.entries(await scrape()).filter(([series]) => series.includes('_total'))); } catch { /* optional */ }
  const { rows } = await db.query(
    `select id, state, attempt, error->>'code' as code,
       (extract(epoch from created_at) * 1000)::float8 as created, (extract(epoch from finished_at) * 1000)::float8 as finished
     from renders where id = any($1)`, [ids]);
  await db.end();
  const bySeq = new Map(accepted.map((a) => [a.id, a.seq]));
  const result = {
    runId: plan.runId, submittedMs, refused,
    rows: rows.map((r: Record<string, unknown>) => {
      const job = plan.jobs[bySeq.get(r.id as string)!]!;
      return { id: r.id, pool: job.pool, entry: job.entry, state: r.state, attempt: Number(r.attempt),
        createdAt: Number(r.created), finishedAt: r.finished === null ? null : Number(r.finished), errorCode: r.code ?? null };
    }),
    metricsPeaks: peaks, metricsCounters: finalCounters,
  };
  console.log(`BENCH_RESULT ${JSON.stringify(result)}`);
}

main().catch((error) => { log((error as Error).message); process.exit(1); });
