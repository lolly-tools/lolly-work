/**
 * Offline validation of the Helm chart — the "build it blind" leg (plans/22 §6.5:
 * the RKE2 cluster arrives after the code does, so every render-time property we
 * can check without a cluster is pinned here). Follows the store-postgres pattern:
 * skipped, not failed, where the tool is absent — helm needs no cluster to
 * `template`, so any dev laptop or CI runner with helm installed re-validates the
 * chart on every run.
 *
 * What a `helm template` CAN prove: the templates render, the YAML is well-formed,
 * and the topology invariants hold (worker off by default; HPA owns scale when on;
 * readiness is the /readyz saturation gate while liveness stays load-independent —
 * plans/23 §3.C). What it can NOT prove: admission, RBAC, ingress behaviour — that
 * is day-one-on-cluster work, runbook'd in deploy/helm/DAY-ONE-RKE2.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CHART = fileURLToPath(new URL('../deploy/helm', import.meta.url));
const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const noHelm = helm.error || helm.status !== 0 ? 'install helm to run (no cluster needed)' : false;

const SECRETS = ['--set', 'secrets.sessionSecret=aaaa', '--set', 'secrets.linkSecret=bbbb'];
const WORKER = [
  '--set', 'renderWorker.enabled=true',
  '--set', 'renderWorker.webBase=https://lolly.tools',
  '--set', 'renderWorker.secret=cccc',
];

function render(args: string[]): { out: string; err: string; ok: boolean } {
  const r = spawnSync('helm', ['template', 'lolly', CHART, ...args], { encoding: 'utf8' });
  return { out: r.stdout ?? '', err: r.stderr ?? '', ok: r.status === 0 };
}

/** The rendered docs, split on document boundaries (no YAML dep — structural
 *  checks below are regex-on-text, which is enough for presence/absence). */
const docsOf = (out: string): string[] => out.split(/\n---/);
const workerDeployment = (out: string): string | undefined =>
  docsOf(out).find((d) => /kind: Deployment/.test(d) && /name: \S*render-worker/.test(d));

test('chart lints clean', { skip: noHelm }, () => {
  const r = spawnSync('helm', ['lint', CHART], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stdout + r.stderr);
});

test('missing required secrets refuse to render — the fail-closed guard', { skip: noHelm }, () => {
  const r = render([]);
  assert.equal(r.ok, false, 'a secretless render must fail, not produce a broken deploy');
  assert.match(r.err, /sessionSecret is required/);
});

test('default topology is light: renders valid, no worker anywhere', { skip: noHelm }, () => {
  const r = render(SECRETS);
  assert.ok(r.ok, r.err);
  assert.ok(docsOf(r.out).length >= 5, 'core manifests render');
  assert.ok(!workerDeployment(r.out), 'renderWorker.enabled defaults to false — no Chromium in a default install');
  assert.ok(!/HorizontalPodAutoscaler/.test(r.out), 'no worker ⇒ no worker HPA');
});

test('worker topology: /readyz readiness vs /healthz liveness, concurrency env, static replicas', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER]);
  assert.ok(r.ok, r.err);
  const dep = workerDeployment(r.out);
  assert.ok(dep, 'worker Deployment renders when enabled');
  assert.match(dep!, /livenessProbe:[\s\S]*?path: \/healthz/, 'liveness stays load-independent');
  assert.match(dep!, /readinessProbe:[\s\S]*?path: \/readyz/, 'readiness is the saturation gate (plans/23 §3.C)');
  assert.match(dep!, /LW_RENDER_MAX_CONCURRENT[\s\S]*?value: "4"/, 'per-pod cap reaches the pod');
  assert.match(dep!, /^\s*replicas:/m, 'without the HPA, the Deployment owns its replica count');
});

test('values-eval renders the one-command tyre-kick: no migrate Job, one replica, hooks fast path on, default ingress class', { skip: noHelm }, () => {
  // The field-demo contract (docs/deployment.md "Evaluation in one command",
  // verified live on k3s 2026-08-11): no Postgres ⇒ the migrate Job must NOT
  // render (it would block the install against a nonexistent DATABASE_URL).
  const r = render(['-f', `${CHART}/values-eval.yaml`]);
  assert.ok(r.ok, r.err);
  assert.ok(!/kind: Job/.test(r.out), 'memory-store eval renders no migrate Job');
  assert.match(r.out, /replicas: 1/, 'one replica — the memory store is per-process');
  assert.match(r.out, /allowHooksInFastPath[":]+\s*true/, 'the bundled demo pack is hooked; fast-path hooks must be on');
  const ingress = docsOf(r.out).find((d) => /kind: Ingress/.test(d));
  assert.ok(ingress, 'eval serves through the cluster ingress');
  assert.ok(!/ingressClassName/.test(ingress!), 'no class pinned — Traefik on k3s, nginx on RKE2, by cluster default');
});

test('worker + HPA: the Deployment drops static replicas and the HPA targets it', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER, '--set', 'renderWorker.autoscaling.enabled=true']);
  assert.ok(r.ok, r.err);
  const dep = workerDeployment(r.out);
  assert.ok(dep, 'worker Deployment renders');
  assert.ok(!/^\s*replicas:/m.test(dep!), 'HPA owns scale — a static replicas line would fight it on every apply');
  const hpa = docsOf(r.out).find((d) => /kind: HorizontalPodAutoscaler/.test(d));
  assert.ok(hpa, 'HPA renders');
  assert.match(hpa!, /scaleTargetRef:[\s\S]*?name: \S*render-worker/, 'the HPA targets the worker Deployment');
});
