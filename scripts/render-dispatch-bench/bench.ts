// SPDX-License-Identifier: MPL-2.0
/**
 * Push against pull for the render worker (plan 324 M3, decision D5): the
 * orchestrator. See README.md beside this file for the cluster it expects.
 *
 *   node scripts/render-dispatch-bench/bench.ts --kubeconfig=<file> --catalog-key=<pem> --out=<dir>
 *     [--corpus=mixed|light] [--workers=1,4,16] [--modes=push,pull] [--loads=saturation,medium,light]
 *     [--slots=4] [--seed=324] [--light-jobs=60] [--medium-jobs=100] [--burst-per-slot=6]
 *     [--light-share=0.15] [--medium-share=0.6] [--worker-timeout-ms=60000]
 *     [--seccomp=lolly/chromium.json] [--apparmor=lolly-chromium] [--keys=<dir, default --out>]
 *
 * For each worker count it deploys push, measures saturation (a burst), then
 * runs medium and light as Poisson arrivals at fixed shares of push's measured
 * throughput; then deploys pull and runs the same three plans, with the same
 * jobs and arrival times. Every run starts from an empty render table after an
 * unrecorded warm-up. Raw results and summaries land in --out, never in the
 * repository.
 */
import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { arrivals, CORPORA, jobs, type CorpusName, type Load } from './corpus.ts';
import { clientJob, manifests, type BenchSecrets, type BenchSpec } from './manifests.ts';
import { summariseByPool, type RenderRow, type Summary } from './stats.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const NS = 'lw-bench';
const arg = (name: string, fallback?: string): string => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (hit) return hit.slice(name.length + 3);
  if (fallback === undefined) throw new Error(`--${name} is required`);
  return fallback;
};
const list = (name: string, fallback: string) => arg(name, fallback).split(',').map((v) => v.trim()).filter(Boolean);
const out = resolve(arg('out'));
const kubeconfig = resolve(arg('kubeconfig'));
const seed = Number(arg('seed', '324'));
const corpusName = arg('corpus', 'mixed') as CorpusName;
if (!CORPORA[corpusName]) throw new Error('--corpus must be mixed or light');
const slots = Number(arg('slots', '4'));
const workerCounts = list('workers', '1,4,16').map(Number);
const modes = list('modes', 'push,pull') as ('push' | 'pull')[];
const loads = list('loads', 'saturation,medium,light') as Load[];
const lightJobs = Number(arg('light-jobs', '60'));
const mediumJobs = Number(arg('medium-jobs', '100'));
const burstPerSlot = Number(arg('burst-per-slot', '6'));
const lightShare = Number(arg('light-share', '0.15'));
const mediumShare = Number(arg('medium-share', '0.6'));
const workerTimeoutMs = Number(arg('worker-timeout-ms', '60000'));
mkdirSync(out, { recursive: true });

const kubectl = (args: string[], input?: string): string =>
  execFileSync('kubectl', args, { env: { ...process.env, KUBECONFIG: kubeconfig }, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...(input !== undefined ? { input } : {}) });
const say = (message: string) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}] ${message}`);

/** Benchmark-only credentials, generated once per output directory. */
function secrets(): BenchSecrets {
  const keys = resolve(arg('keys', out));
  mkdirSync(keys, { recursive: true });
  const file = join(keys, 'secrets.json');
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const tls = join(keys, 'tls');
  mkdirSync(tls, { recursive: true });
  const ssl = (...a: string[]) => execFileSync('openssl', a, { cwd: tls, stdio: 'pipe' });
  ssl('req', '-x509', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-days', '7', '-subj', '/CN=lw-bench CA',
    '-keyout', 'ca.key', '-out', 'ca.crt', '-addext', 'basicConstraints=critical,CA:TRUE', '-addext', 'keyUsage=critical,keyCertSign,cRLSign');
  const names = [`render-worker.${NS}.svc`, `render-worker.${NS}.svc.cluster.local`];
  writeFileSync(join(tls, 'leaf.ext'), `subjectAltName=${names.map((n) => `DNS:${n}`).join(',')}\nbasicConstraints=CA:FALSE\nkeyUsage=digitalSignature\nextendedKeyUsage=serverAuth\n`);
  ssl('req', '-newkey', 'ec', '-pkeyopt', 'ec_paramgen_curve:prime256v1', '-nodes', '-subj', `/CN=${names[0]}`, '-keyout', 'tls.key', '-out', 'tls.csr');
  ssl('x509', '-req', '-in', 'tls.csr', '-CA', 'ca.crt', '-CAkey', 'ca.key', '-CAcreateserial', '-days', '7', '-extfile', 'leaf.ext', '-out', 'tls.crt');
  const value: BenchSecrets = {
    session: randomBytes(32).toString('hex'), link: randomBytes(32).toString('hex'), worker: randomBytes(32).toString('hex'),
    metrics: randomBytes(24).toString('hex'), dbPassword: randomBytes(16).toString('hex'),
    catalogKeyPem: readFileSync(resolve(arg('catalog-key')), 'utf8'),
    tlsCert: readFileSync(join(tls, 'tls.crt'), 'utf8'), tlsKey: readFileSync(join(tls, 'tls.key'), 'utf8'), caCert: readFileSync(join(tls, 'ca.crt'), 'utf8'),
  };
  writeFileSync(file, JSON.stringify(value), { mode: 0o600 });
  return value;
}

function deploy(spec: BenchSpec): void {
  kubectl(['apply', '-f', '-'], manifests(spec));
  for (const name of ['postgres', 'work', 'render-worker']) kubectl(['-n', NS, 'rollout', 'status', `deploy/${name}`, '--timeout=900s']);
  // A worker is ready once its browser is up; rollout status has waited for that.
  kubectl(['apply', '-f', '-'], kubectl(['create', 'configmap', 'bench-client', '-n', NS, `--from-file=client.ts=${join(HERE, 'client.ts')}`, '--dry-run=client', '-o', 'json']));
}

function psql(sql: string): string {
  return kubectl(['-n', NS, 'exec', 'deploy/postgres', '--', 'psql', '-U', 'bench', '-d', 'bench', '-tAc', sql]);
}

interface ClientResult { runId: string; submittedMs: number; refused: { seq: number; status: number }[]; rows: RenderRow[]; metricsPeaks: Record<string, number>; metricsCounters: Record<string, number>; errorsSeen?: Record<string, number> }

function runPlan(runId: string, count: number, rate: number | null, image: string): ClientResult {
  const planJobs = jobs(count, seed + count, CORPORA[corpusName]);
  const offsetsMs = arrivals(count, seed + count, rate);
  const plan = { runId, jobs: planJobs, offsetsMs, deadlineMs: (offsetsMs.at(-1) ?? 0) + 15 * 60_000 };
  const name = `bench-${runId}`.toLowerCase().replace(/[^a-z0-9-]/g, '-').slice(0, 60);
  kubectl(['-n', NS, 'delete', 'job', name, '--ignore-not-found', '--wait=true']);
  kubectl(['apply', '-f', '-'], kubectl(['create', 'configmap', name, '-n', NS, '--from-literal=plan.json=' + JSON.stringify(plan), '--dry-run=client', '-o', 'json']));
  kubectl(['apply', '-f', '-'], clientJob(NS, image, name));
  const timeout = Math.ceil(plan.deadlineMs / 1000) + 120;
  try { kubectl(['-n', NS, 'wait', '--for=condition=complete', `job/${name}`, `--timeout=${timeout}s`]); }
  catch (error) { say(`client ${name} did not complete: ${kubectl(['-n', NS, 'logs', `job/${name}`, '--tail=20'])}`); throw error; }
  const logs = kubectl(['-n', NS, 'logs', `job/${name}`]);
  const line = logs.split('\n').find((l) => l.startsWith('BENCH_RESULT '));
  if (!line) throw new Error(`client ${name} printed no result`);
  kubectl(['-n', NS, 'delete', 'job', name, '--wait=false']);
  kubectl(['-n', NS, 'delete', 'configmap', name]);
  return JSON.parse(line.slice('BENCH_RESULT '.length));
}

/** CPU seconds Work's container has used (cgroup v2), to compare what each mode costs the one Work replica. */
function workCpuSeconds(): number | null {
  try {
    const stat = kubectl(['-n', NS, 'exec', 'deploy/work', '--', 'cat', '/sys/fs/cgroup/cpu.stat']);
    const usec = /usage_usec (\d+)/.exec(stat)?.[1];
    return usec ? Number(usec) / 1e6 : null;
  } catch { return null; }
}

function restarts(): Record<string, number> {
  const pods = JSON.parse(kubectl(['-n', NS, 'get', 'pods', '-o', 'json'])) as { items: { metadata: { name: string }; status: { containerStatuses?: { restartCount: number }[] } }[] };
  return Object.fromEntries(pods.items.filter((p) => !p.metadata.name.startsWith('bench-'))
    .map((p) => [p.metadata.name, (p.status.containerStatuses ?? []).reduce((n, c) => n + c.restartCount, 0)]));
}

interface RunRecord { corpus: string; slots?: number; workCpuSeconds?: number | null; workers: number; mode: string; load: Load; rate: number | null; jobs: number; summary: Record<string, Summary>; refused: number; metricsPeaks: Record<string, number>; metricsCounters: Record<string, number>; errorsSeen: Record<string, number>; restarts: Record<string, number> }
const recordsFile = join(out, 'runs.json');
const records: RunRecord[] = existsSync(recordsFile) ? JSON.parse(readFileSync(recordsFile, 'utf8')) : [];
const save = () => writeFileSync(recordsFile, JSON.stringify(records, null, 2));

const sec = secrets();
const workImage = arg('work-image', 'lw-bench/work:dev');
for (const workers of workerCounts) {
  let capacity: number | null = null;
  for (const mode of modes) {
    const spec: BenchSpec = { namespace: NS, workImage, workerImage: arg('worker-image', 'lw-bench/worker:dev'), postgresImage: arg('postgres-image', 'postgres:17-alpine'),
      mode, workers, slots, runnerConcurrency: Math.min(128, workers * slots), workerTimeoutMs, shellHostPath: arg('shell', '/bench/shell'),
      seccompProfile: arg('seccomp', 'lolly/chromium.json'), ...(arg('apparmor', '') ? { appArmorProfile: arg('apparmor', '') } : {}), secrets: sec };
    say(`deploy ${mode} with ${workers} worker(s) x ${slots} slots, runner concurrency ${spec.runnerConcurrency}`);
    deploy(spec);
    say('warm-up');
    runPlan(`warm-${corpusName}-${mode}-${workers}`, Math.max(16, 2 * workers * slots), null, workImage);
    for (const load of loads) {
      const same = (r: RunRecord) => r.corpus === corpusName && r.workers === workers && (r.slots ?? 4) === slots;
      if (records.some((r) => same(r) && r.mode === mode && r.load === load)) { say(`skip ${corpusName}/${mode}/${workers}/${load}: recorded`); continue; }
      const pushSat = records.find((r) => same(r) && r.mode === 'push' && r.load === 'saturation');
      capacity = pushSat?.summary.all?.throughput ?? capacity;
      if (load !== 'saturation' && !capacity) throw new Error('run push saturation first: light and medium rates are shares of its throughput');
      const rate = load === 'saturation' ? null : Number(((load === 'light' ? lightShare : mediumShare) * capacity!).toFixed(3));
      const count = load === 'saturation' ? Math.max(80, burstPerSlot * workers * slots) : load === 'medium' ? mediumJobs : lightJobs;
      psql('truncate renders cascade');
      say(`run ${corpusName}/${mode}/${workers}/${load}: ${count} renders${rate ? ` at ${rate}/s` : ' at once'}`);
      const tag = `${corpusName}-${mode}-${workers}${slots === 4 ? '' : `x${slots}`}-${load}`;
      const cpuBefore = workCpuSeconds();
      const result = runPlan(tag, count, rate, workImage);
      const cpuAfter = workCpuSeconds();
      writeFileSync(join(out, `raw-${tag}.json`), JSON.stringify(result));
      const summary = summariseByPool(result.rows);
      records.push({ corpus: corpusName, slots, workCpuSeconds: cpuBefore !== null && cpuAfter !== null ? Number((cpuAfter - cpuBefore).toFixed(2)) : null, workers, mode, load, rate, jobs: count, summary, refused: result.refused.length,
        metricsPeaks: result.metricsPeaks, metricsCounters: result.metricsCounters, errorsSeen: result.errorsSeen ?? {}, restarts: restarts() });
      save();
      const a = summary.all!;
      say(`  ${a.succeeded}/${a.renders} ok, failed ${a.failed}, p50 ${a.p50}s p95 ${a.p95}s p99 ${a.p99}s, ${a.throughput}/s, retries ${a.retries}`);
    }
  }
}
say(`done: ${recordsFile}`);
