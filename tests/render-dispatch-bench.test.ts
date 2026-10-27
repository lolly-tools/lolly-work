// SPDX-License-Identifier: MPL-2.0
/**
 * The push-against-pull benchmark harness (scripts/render-dispatch-bench):
 * the corpus and arrivals are fixed by the seed, the summaries are exact, and
 * the two modes differ in the deployment only where dispatch differs.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { arrivals, jobs, CORPUS, CORPORA } from '../scripts/render-dispatch-bench/corpus.ts';
import { percentile, summarise, summariseByPool, type RenderRow } from '../scripts/render-dispatch-bench/stats.ts';
import { instanceConfig, manifests, type BenchSpec } from '../scripts/render-dispatch-bench/manifests.ts';
import { parseConfig } from '../server/src/config/instance.ts';

test('the corpus and its arrivals are the same for the same seed, and mix both pools', () => {
  assert.deepEqual(jobs(50, 7), jobs(50, 7));
  assert.deepEqual(arrivals(50, 7, 2), arrivals(50, 7, 2));
  assert.notDeepEqual(jobs(50, 7), jobs(50, 8));
  const sample = jobs(400, 324);
  const share = sample.filter((j) => j.pool === 'tier-b').length / sample.length;
  const expected = CORPUS.filter((e) => e.pool === 'tier-b').reduce((n, e) => n + e.weight, 0) / CORPUS.reduce((n, e) => n + e.weight, 0);
  assert.ok(Math.abs(share - expected) < 0.08, `tier-b share ${share} near ${expected}`);
  assert.deepEqual(arrivals(5, 1, null), [0, 0, 0, 0, 0], 'saturation arrives at once');
  assert.ok(jobs(100, 9, CORPORA.light).every((j) => j.pool === 'tier-a' && j.toolId === 'bench-card'), 'the light corpus never boots the shell');
  const poisson = arrivals(2000, 3, 4);
  const meanGap = poisson.at(-1)! / (poisson.length - 1);
  assert.ok(Math.abs(meanGap - 250) < 25, `mean gap ${meanGap} ms at 4/s`);
});

test('percentiles are nearest-rank and summaries count only settled successes for latency', () => {
  const sorted = Array.from({ length: 100 }, (_, i) => i + 1);
  assert.equal(percentile(sorted, 50), 50);
  assert.equal(percentile(sorted, 95), 95);
  assert.equal(percentile(sorted, 99), 99);
  assert.equal(percentile([], 50), null);
  const row = (id: string, pool: string, created: number, finished: number | null, state = 'succeeded', attempt = 1, errorCode: string | null = null): RenderRow =>
    ({ id, pool, entry: 'e', state, attempt, createdAt: created, finishedAt: finished, errorCode });
  const rows = [row('a', 'tier-a', 0, 1000), row('b', 'tier-b', 0, 3000, 'succeeded', 2), row('c', 'tier-b', 1000, 2000, 'failed', 3, 'RENDER_BUSY')];
  const all = summarise(rows);
  assert.deepEqual({ ...all }, { renders: 3, succeeded: 2, failed: 1, p50: 1, p95: 3, p99: 3, mean: 2, throughput: 0.667, completion: 0.667, p95Delivered: Infinity, retries: 3, errors: { RENDER_BUSY: 1 } });
  assert.deepEqual(Object.keys(summariseByPool(rows)), ['all', 'tier-a', 'tier-b']);
});

test('push and pull deployments differ only in dispatch, and the bench config is a valid Work config', () => {
  const base: BenchSpec = { namespace: 'lw-bench', workImage: 'w', workerImage: 'r', postgresImage: 'p', mode: 'push', workers: 4, slots: 4,
    runnerConcurrency: 16, workerTimeoutMs: 60000, shellHostPath: '/bench/shell', seccompProfile: 'lolly/chromium.json',
    secrets: { session: 's', link: 'l', worker: 'k', metrics: 'm', dbPassword: 'd', catalogKeyPem: 'pem', tlsCert: 'c', tlsKey: 'k', caCert: 'a' } };
  const push = manifests(base).split('\n---\n').map((d) => JSON.parse(d));
  const pull = manifests({ ...base, mode: 'pull' }).split('\n---\n').map((d) => JSON.parse(d));
  const env = (docs: any[]) => docs.find((d) => d.kind === 'Deployment' && d.metadata.name === 'render-worker').spec.template.spec.containers[0].env.map((e: { name: string }) => e.name);
  assert.ok(!env(push).includes('LW_RENDER_PULL_URL'));
  assert.ok(env(pull).includes('LW_RENDER_PULL_URL'));
  const worker = push.find((d) => d.kind === 'Deployment' && d.metadata.name === 'render-worker').spec;
  assert.equal(worker.replicas, 4);
  assert.deepEqual(worker.template.spec.containers[0].securityContext.seccompProfile, { type: 'Localhost', localhostProfile: 'lolly/chromium.json' });
  const strip = (docs: any[]) => JSON.stringify(docs, (key, value) => (key === 'bench/rollout' || key === 'instance.json' ? undefined : value)).replace(/,?\{"name":"LW_RENDER_PULL_URL","value":"[^"]*"\}/, '');
  assert.equal(strip(push), strip(pull), 'nothing else changes between the modes');
  for (const mode of ['push', 'pull'] as const) {
    const config = parseConfig(JSON.stringify(instanceConfig({ ...base, mode })));
    assert.equal(config.render.worker.dispatch, mode);
    assert.equal(config.render.worker.timeoutMs, 60000);
  }
});
