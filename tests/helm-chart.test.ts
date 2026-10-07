/**
 * Offline validation of the Helm chart - the "build it blind" leg (plans/22 §6.5:
 * the RKE2 cluster arrives after the code does, so every render-time property we
 * can check without a cluster is pinned here). Follows the store-postgres pattern:
 * skipped, not failed, where the tool is absent - helm needs no cluster to
 * `template`, so any dev laptop or CI runner with helm installed re-validates the
 * chart on every run.
 *
 * What a `helm template` CAN prove: the templates render, the YAML is well-formed,
 * and the topology invariants hold (worker off by default; HPA owns scale when on;
 * readiness is the /readyz saturation gate while liveness stays load-independent - 
 * plans/23 §3.C). What it can NOT prove: admission, RBAC, ingress behaviour - that
 * is day-one-on-cluster work, runbook'd in deploy/helm/DAY-ONE-RKE2.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseAllDocuments } from 'yaml';
import { parseConfig } from '../server/src/config/instance.ts';

const CHART = fileURLToPath(new URL('../deploy/helm', import.meta.url));
const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const noHelm = helm.error || helm.status !== 0 ? 'install helm to run (no cluster needed)' : false;
if (process.env.LW_REQUIRE_HELM_TESTS === '1' && noHelm) throw new Error('Helm qualification requires a working Helm binary');

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

/** The rendered docs, split on document boundaries (no YAML dep - structural
 *  checks below are regex-on-text, which is enough for presence/absence). */
const docsOf = (out: string): string[] => out.split(/\n---/);
const workerDeployment = (out: string): string | undefined =>
  docsOf(out).find((d) => /kind: Deployment/.test(d) && /name: \S*render-worker/.test(d));
const manifests = (out: string) => parseAllDocuments(out).map(doc => doc.toJSON());
const deployment = (out: string, worker = false) => manifests(out).find(doc =>
  doc?.kind === 'Deployment' && (doc.metadata.labels?.['app.kubernetes.io/component'] === 'render-worker') === worker);
const SMALL = ['-f', `${CHART}/values-small-suse.yaml`];

test('raw instance config remains exact with mounted pack and shell', { skip: noHelm }, () => {
  const directory = mkdtempSync(join(tmpdir(), 'lolly-helm-raw-config-'));
  try {
    const raw = JSON.stringify({ instance: { baseUrl: 'https://work.example.test', pack: '/app/packs/custom', shellDir: '/app/shell' }, catalogProviders: [{ id: 'custom-provider' }] }, null, 2);
    const config = join(directory, 'instance.json');
    writeFileSync(config, raw, { mode: 0o600 });
    const r = render([...SECRETS, '--set-file', `config=${config}`,
      '--set', 'pack.type=existingClaim', '--set', 'pack.existingClaim=custom-pack',
      '--set', 'shell.enabled=true', '--set', 'shell.type=existingClaim', '--set', 'shell.existingClaim=custom-shell']);
    assert.ok(r.ok, r.err);
    const actual = manifests(r.out).find(doc => doc?.kind === 'ConfigMap').data['instance.json'];
    assert.equal(actual, raw, 'raw operator config must not gain defaults or lose extension fields');
    assert.deepEqual(JSON.parse(actual), JSON.parse(raw));
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('control-plane Service never selects render workers or migration pods and keeps upgrade selectors stable', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER]); assert.ok(r.ok, r.err);
  const docs = manifests(r.out), app = deployment(r.out), worker = deployment(r.out, true);
  const service = docs.find(d => d.kind === 'Service' && d.metadata.labels?.['app.kubernetes.io/component'] !== 'render-worker');
  const job = docs.find(d => d.kind === 'Job');
  const matches = (labels: Record<string, string>) => Object.entries(service.spec.selector)
    .every(([key, value]) => labels[key] === value);
  assert.ok(matches(app.spec.template.metadata.labels));
  assert.ok(!matches(worker.spec.template.metadata.labels), 'member traffic must not reach the browser worker');
  assert.ok(!matches(job.spec.template.metadata.labels), 'migration pods are not application endpoints');
  assert.equal(app.spec.selector.matchLabels['app.kubernetes.io/component'], undefined,
    'existing Deployment immutable selectors stay upgrade-compatible');
  const override = render([...SECRETS, '--set-json', 'podLabels={"app.kubernetes.io/component":"render-worker"}']);
  assert.equal(override.ok, false);
  assert.match(override.err, /component is reserved/);
});

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

test('internal policy overlay produces a valid gated config and preserves environment settings', { skip: noHelm }, () => {
  const r = render([
    '-f', `${CHART}/values-internal.yaml`,
    '--set', 'existingSecret=internal-test-secrets',
    '--set', 'config.instance.baseUrl=https://work.example.test',
    '--set', 'config.idp.issuer=https://idp.example.test',
    '--set', 'config.idp.clientId=internal-test-client',
    '--set', 'config.policy.retention.auditDays=180',
  ]);
  assert.ok(r.ok, r.err);
  const configMap = parseAllDocuments(r.out).map(doc => doc.toJSON())
    .find(doc => doc?.kind === 'ConfigMap' && doc.data?.['instance.json']);
  assert.ok(configMap, 'the chart must deliver an instance config');
  const cfg = parseConfig(configMap.data['instance.json']);
  assert.equal(cfg.instance.baseUrl, 'https://work.example.test');
  assert.equal(cfg.idp.clientId, 'internal-test-client');
  assert.equal(cfg.policy.defaultAccessMode, 'gated');
  assert.equal(cfg.dev.enabled, false);
  assert.equal(cfg.proxyAuth.enabled, false);
  assert.equal(cfg.policy.telemetry, 'off');
  assert.equal(cfg.policy.guestLinks.enabled, false);
  assert.equal(cfg.policy.nearby.enabled, false);
  assert.equal(cfg.policy.retention.auditDays, 180, 'retain the environment-approved schedule');
  assert.ok(cfg.policy.sessionTtlHours <= 24);
  assert.equal(cfg.render.allowHooksInFastPath, false);
  assert.equal(cfg.audit.headLog.onBoot, true);
  assert.ok(!parseAllDocuments(r.out).some(doc => doc.toJSON()?.kind === 'Secret'), 'use the external secret');

  const missingIdp = JSON.parse(configMap.data['instance.json']);
  missingIdp.idp.issuer = '';
  missingIdp.idp.clientId = '';
  assert.throws(() => parseConfig(JSON.stringify(missingIdp)), /gated access needs idp.issuer/);
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

// plans/58 WP0: the render worker's NetworkPolicy, and the app policy no longer covering it.
const policyNamed = (out: string, suffix: string): string | undefined =>
  docsOf(out).find((d) => /kind: NetworkPolicy/.test(d) && new RegExp(`name: \\S*${suffix}\\s`).test(d));

test('worker NetworkPolicy is opt-in and off by default', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER]);
  assert.ok(r.ok, r.err);
  assert.ok(!policyNamed(r.out, 'render-worker'), 'no worker policy unless renderWorker.networkPolicy.enabled');
});

test('worker NetworkPolicy: control-plane ingress only, egress to DNS and public addresses, extraEgress templated', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER,
    '--set', 'renderWorker.networkPolicy.enabled=true',
    '--set-json', 'renderWorker.networkPolicy.extraEgress=[{"to":[{"podSelector":{"matchLabels":{"app":"lolly-web"}}}],"ports":[{"protocol":"TCP","port":8080}]}]',
  ]);
  assert.ok(r.ok, r.err);
  const np = policyNamed(r.out, 'render-worker');
  assert.ok(np, 'worker policy renders when enabled');
  assert.match(np!, /podSelector:\s*matchLabels:[\s\S]*?app\.kubernetes\.io\/component: render-worker/, 'selects the worker pods');
  assert.match(np!, /policyTypes:\s*- Ingress\s*- Egress/, 'restricts both directions');
  const parsed = manifests(r.out).find(doc => doc?.kind === 'NetworkPolicy' && doc.metadata.name.endsWith('render-worker'));
  const selector = parsed.spec.ingress[0].from[0].podSelector.matchLabels;
  const matches = (labels: Record<string, string>) => Object.entries(selector).every(([key, value]) => labels[key] === value);
  assert.ok(matches(deployment(r.out).spec.template.metadata.labels), 'render dispatch must accept the actual control-plane labels');
  assert.ok(!matches(deployment(r.out, true).spec.template.metadata.labels), 'workers cannot dispatch authenticated renders to each other');
  assert.ok(!matches(manifests(r.out).find(doc => doc?.kind === 'Job').spec.template.metadata.labels), 'migration pods cannot dispatch renders');
  assert.equal(parsed.spec.ingress[0].ports[0].port, 8791);
  for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16', '169.254.0.0/16', '127.0.0.0/8', '100.64.0.0/10', 'fc00::/7', 'fe80::/10']) {
    assert.ok(np!.includes(`- ${cidr}`), `${cidr} carved out of public egress`);
  }
  assert.match(np!, /k8s-app: kube-dns[\s\S]*?port: 53/, 'cluster DNS is reachable');
  assert.match(np!, /port: 8080[\s\S]*?app: lolly-web|app: lolly-web[\s\S]*?port: 8080/, 'extraEgress reaches the policy (toYaml sorts its keys)');
});

test('the app NetworkPolicy does not select the render worker pods', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER, '--set', 'networkPolicy.enabled=true']);
  assert.ok(r.ok, r.err);
  const app = docsOf(r.out).find((d) => /kind: NetworkPolicy/.test(d) && !/component: render-worker\n/.test(d.split('spec:')[0]!));
  assert.ok(app, 'app policy renders');
  assert.match(app!, /key: app\.kubernetes\.io\/component\s*operator: NotIn\s*values: \[render-worker\]/, 'its open egress cannot add to the worker\'s policy');
});

test('immutable digests pin app, migration and worker while tag defaults still work', { skip: noHelm }, () => {
  const digest = `sha256:${'a'.repeat(64)}`;
  const workerDigest = `sha256:${'b'.repeat(64)}`;
  const r = render([...SECRETS, ...WORKER,
    '--set', `image.digest=${digest}`, '--set', 'image.tag=ignored',
    '--set', `renderWorker.image.digest=${workerDigest}`, '--set', 'renderWorker.image.tag=ignored',
  ]);
  assert.ok(r.ok, r.err);
  const app = deployment(r.out);
  const worker = deployment(r.out, true);
  const migration = manifests(r.out).find(doc => doc?.kind === 'Job');
  assert.equal(app.spec.template.spec.containers[0].image, `ghcr.io/lolly-tools/lolly-work-server@${digest}`);
  assert.equal(migration.spec.template.spec.containers[0].image, app.spec.template.spec.containers[0].image);
  assert.equal(worker.spec.template.spec.containers[0].image, `ghcr.io/lolly-tools/lolly-work-render-worker@${workerDigest}`);

  const original = render([...SECRETS, ...WORKER]);
  assert.ok(original.ok, original.err);
  assert.equal(deployment(original.out).spec.template.spec.containers[0].image, 'ghcr.io/lolly-tools/lolly-work-server:0.2.0');
  assert.equal(deployment(original.out, true).spec.template.spec.containers[0].image, 'ghcr.io/lolly-tools/lolly-work-render-worker:0.2.0');
  const tagged = render([...SECRETS, ...WORKER, '--set', 'image.tag=custom', '--set', 'renderWorker.image.tag=worker-custom']);
  assert.ok(tagged.ok, tagged.err);
  assert.equal(deployment(tagged.out).spec.template.spec.containers[0].image, 'ghcr.io/lolly-tools/lolly-work-server:custom');
  assert.equal(deployment(tagged.out, true).spec.template.spec.containers[0].image, 'ghcr.io/lolly-tools/lolly-work-render-worker:worker-custom');
});

test('malformed digests refuse to render rather than falling back to a tag', { skip: noHelm }, () => {
  for (const name of ['image', 'renderWorker.image']) {
    for (const value of ['latest', `sha256:${'a'.repeat(63)}`, `sha256:${'A'.repeat(64)}`, `sha256:${'g'.repeat(64)}`, 'true']) {
      const r = render([...SECRETS, ...WORKER, '--set', `${name}.digest=${value}`]);
      assert.equal(r.ok, false, `${name}.digest=${value} must fail`);
      assert.match(r.err, new RegExp(`${name.replace('.', '\\.')}\\.digest must`));
    }
  }
  const migrationOnly = render([...SECRETS, '--set', 'image.digest=invalid']);
  assert.equal(migrationOnly.ok, false, 'the app/migration pin is checked even when the worker is off');
});

test('private registry credentials reach app, migration, worker and OCI init containers', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER,
    '--set-json', 'imagePullSecrets=[{"name":"private-registry"}]',
    '--set', 'pack.type=emptyDir', '--set', 'pack.image=registry.example.test/pack:release',
    '--set', 'shell.enabled=true', '--set', 'shell.type=emptyDir', '--set', 'shell.image=registry.example.test/shell:release',
  ]);
  assert.ok(r.ok, r.err);
  const pods = manifests(r.out).filter(doc => ['Deployment', 'Job'].includes(doc?.kind)).map(doc => doc.spec.template.spec);
  assert.equal(pods.length, 3);
  for (const pod of pods) assert.deepEqual(pod.imagePullSecrets, [{ name: 'private-registry' }]);
  assert.deepEqual(deployment(r.out).spec.template.spec.initContainers.map((container: { name: string }) => container.name), ['pack-from-image', 'shell-from-image']);

  const override = render([...SECRETS, ...WORKER,
    '--set-json', 'imagePullSecrets=[{"name":"app-registry"}]',
    '--set-json', 'renderWorker.imagePullSecrets=[{"name":"worker-registry"}]',
  ]);
  assert.ok(override.ok, override.err);
  assert.deepEqual(deployment(override.out, true).spec.template.spec.imagePullSecrets, [{ name: 'worker-registry' }]);
  assert.deepEqual(deployment(override.out).spec.template.spec.imagePullSecrets, [{ name: 'app-registry' }]);
  const publicWorker = render([...SECRETS, ...WORKER,
    '--set-json', 'imagePullSecrets=[{"name":"app-registry"}]', '--set-json', 'renderWorker.imagePullSecrets=[]',
  ]);
  assert.ok(publicWorker.ok, publicWorker.err);
  assert.equal(deployment(publicWorker.out, true).spec.template.spec.imagePullSecrets, undefined, 'an empty override must not inherit credentials');
  const invalid = render([...SECRETS, ...WORKER, '--set', 'renderWorker.imagePullSecrets=not-a-list']);
  assert.equal(invalid.ok, false);
  assert.match(invalid.err, /renderWorker.imagePullSecrets must/);
});

test('worker placement can isolate browser bursts without moving the collaboration owner', { skip: noHelm }, () => {
  const affinity = { nodeAffinity: { requiredDuringSchedulingIgnoredDuringExecution: { nodeSelectorTerms: [{ matchExpressions: [{ key: 'workload', operator: 'In', values: ['render'] }] }] } } };
  const spread = [{ maxSkew: 1, topologyKey: 'kubernetes.io/hostname', whenUnsatisfiable: 'ScheduleAnyway', labelSelector: { matchLabels: { 'app.kubernetes.io/component': 'render-worker' } } }];
  const tolerations = [{ key: 'render', operator: 'Equal', value: 'true', effect: 'NoSchedule' }];
  const r = render([...SECRETS, ...WORKER,
    '--set-json', 'renderWorker.nodeSelector={"workload":"render"}',
    '--set-json', `renderWorker.tolerations=${JSON.stringify(tolerations)}`,
    '--set-json', `renderWorker.affinity=${JSON.stringify(affinity)}`,
    '--set-json', `renderWorker.topologySpreadConstraints=${JSON.stringify(spread)}`,
  ]);
  assert.ok(r.ok, r.err);
  const worker = deployment(r.out, true).spec.template.spec;
  assert.deepEqual(worker.nodeSelector, { workload: 'render' });
  assert.deepEqual(worker.tolerations, tolerations);
  assert.deepEqual(worker.affinity, affinity);
  assert.deepEqual(worker.topologySpreadConstraints, spread);
  assert.equal(deployment(r.out).spec.template.spec.nodeSelector, undefined);
});

test('small SUSE profile bounds scratch, OCI copies and browser concurrency without claiming HA', { skip: noHelm }, () => {
  const light = render([...SMALL, ...SECRETS]);
  assert.ok(light.ok, light.err);
  assert.equal(deployment(light.out, true), undefined, 'browser resources remain opt-in');
  const r = render([...SMALL, ...SECRETS, ...WORKER,
    '--set', 'pack.type=emptyDir', '--set', 'pack.image=registry.example.test/pack:release',
    '--set', 'shell.enabled=true', '--set', 'shell.type=emptyDir', '--set', 'shell.image=registry.example.test/shell:release',
  ]);
  assert.ok(r.ok, r.err);
  const app = deployment(r.out);
  const pod = app.spec.template.spec;
  const worker = deployment(r.out, true);
  assert.equal(app.spec.replicas, 1);
  assert.equal(app.spec.strategy.type, 'Recreate');
  assert.equal(pod.terminationGracePeriodSeconds, 60);
  assert.equal(pod.containers[0].resources.requests['ephemeral-storage'], '2Gi');
  assert.equal(pod.containers[0].resources.limits['ephemeral-storage'], '6Gi');
  for (const [name, size] of [['tmp', '256Mi'], ['pack', '1Gi'], ['shell', '2Gi']]) {
    assert.deepEqual(pod.volumes.find((volume: { name: string }) => volume.name === name).emptyDir, { sizeLimit: size });
  }
  for (const init of pod.initContainers) {
    assert.equal(init.resources.requests.memory, '32Mi');
    assert.equal(init.resources.limits.memory, '128Mi');
    assert.ok(init.resources.requests['ephemeral-storage']);
    assert.ok(init.resources.limits['ephemeral-storage']);
  }
  const browser = worker.spec.template.spec;
  assert.equal(worker.spec.replicas, 1);
  assert.equal(browser.containers[0].env.find((env: { name: string }) => env.name === 'LW_RENDER_MAX_CONCURRENT').value, '1');
  assert.equal(browser.containers[0].resources.limits['ephemeral-storage'], '2Gi');
  assert.deepEqual(browser.volumes.find((volume: { name: string }) => volume.name === 'tmp').emptyDir, { sizeLimit: '1Gi' });
  assert.ok(!manifests(r.out).some(doc => doc?.kind === 'PersistentVolumeClaim'), 'reproducible release copies need no replicated storage');
  assert.ok(!manifests(r.out).some(doc => doc?.kind === 'HorizontalPodAutoscaler'));
  const hpa = render([...SMALL, ...SECRETS, ...WORKER, '--set', 'renderWorker.autoscaling.enabled=true']);
  assert.ok(hpa.ok, hpa.err);
  assert.equal(manifests(hpa.out).find(doc => doc?.kind === 'HorizontalPodAutoscaler').spec.maxReplicas, 2);
});

test('multiple collaboration owners remain refused and evaluation scratch defaults remain unchanged', { skip: noHelm }, () => {
  const unsafe = render([...SMALL, ...SECRETS, '--set', 'replicaCount=2']);
  assert.equal(unsafe.ok, false);
  assert.match(unsafe.err, /requires replicaCount=1/);
  const evalProfile = render(['-f', `${CHART}/values-eval.yaml`]);
  assert.ok(evalProfile.ok, evalProfile.err);
  const pod = deployment(evalProfile.out).spec.template.spec;
  assert.deepEqual(pod.volumes.find((volume: { name: string }) => volume.name === 'tmp').emptyDir, {});
  assert.equal(pod.containers[0].resources.requests['ephemeral-storage'], undefined);
  assert.ok(!manifests(evalProfile.out).some(doc => doc?.kind === 'Job'));
});

test('active scratch and release-copy bounds reject invalid quantities before installation', { skip: noHelm }, () => {
  const active = [...SECRETS, ...WORKER,
    '--set', 'pack.type=emptyDir', '--set', 'pack.image=registry.example.test/pack:release',
    '--set', 'shell.enabled=true', '--set', 'shell.type=emptyDir', '--set', 'shell.image=registry.example.test/shell:release',
  ];
  for (const name of ['tmp.sizeLimit', 'pack.emptyDir.sizeLimit', 'shell.emptyDir.sizeLimit', 'renderWorker.tmp.sizeLimit']) {
    for (const value of ['0', '0Gi', '-1Gi', '250m', '1.5Gi', '1e3', 'not-a-size']) {
      const r = render([...active, '--set-string', `${name}=${value}`]);
      assert.equal(r.ok, false, `${name}=${value} must fail before installation`);
      assert.ok(r.err.includes(`${name} must`), r.err);
    }
    for (const value of ['1', 'true', 'null']) {
      const r = render([...active, '--set-json', `${name}=${value}`]);
      assert.equal(r.ok, false, `${name} must be a string`);
      assert.ok(r.err.includes(`${name} must`), r.err);
    }
  }
  for (const value of ['128', '64Ki', '512Mi', '2Gi', '1Ti', '1Pi', '1Ei', '2k', '3M', '4G', '5T', '6P', '7E']) {
    const r = render([...SECRETS, '--set-string', `tmp.sizeLimit=${value}`]);
    assert.ok(r.ok, `${value}: ${r.err}`);
    assert.equal(deployment(r.out).spec.template.spec.volumes.find((volume: { name: string }) => volume.name === 'tmp').emptyDir.sizeLimit, value);
  }
});

test('unused volume bounds do not change the light topology', { skip: noHelm }, () => {
  const r = render([...SECRETS,
    '--set', 'pack.emptyDir.sizeLimit=invalid', '--set', 'shell.emptyDir.sizeLimit=invalid',
    '--set', 'renderWorker.tmp.sizeLimit=invalid',
  ]);
  assert.ok(r.ok, r.err);
  assert.equal(deployment(r.out, true), undefined);
  assert.equal(deployment(r.out).spec.template.spec.initContainers, undefined);
});

test('PostgreSQL CA reaches application and migration Job without reaching the browser worker', { skip: noHelm }, () => {
  const volumes = [{ name: 'postgres-ca', configMap: { name: 'lolly-postgres-ca' } }];
  const mounts = [{ name: 'postgres-ca', mountPath: '/etc/lolly/postgres', readOnly: true }];
  const r = render([...SECRETS, ...WORKER,
    '--set-json', `extraVolumes=${JSON.stringify(volumes)}`,
    '--set-json', `extraVolumeMounts=${JSON.stringify(mounts)}`,
    '--set-json', `migrate.extraVolumes=${JSON.stringify(volumes)}`,
    '--set-json', `migrate.extraVolumeMounts=${JSON.stringify(mounts)}`,
  ]);
  assert.ok(r.ok, r.err);
  const job = manifests(r.out).find(doc => doc?.kind === 'Job');
  for (const pod of [deployment(r.out).spec.template.spec, job.spec.template.spec]) {
    assert.deepEqual(pod.volumes.find((volume: { name: string }) => volume.name === 'postgres-ca'), volumes[0]);
    assert.deepEqual(pod.containers[0].volumeMounts.find((mount: { name: string }) => mount.name === 'postgres-ca'), mounts[0]);
    assert.ok(pod.volumes.some((volume: { name: string }) => volume.name === 'tmp'), 'scratch remains available');
    assert.ok(pod.containers[0].env.some((env: { name: string }) => env.name === 'DATABASE_URL' && 'valueFrom' in env));
  }
  const browser = deployment(r.out, true).spec.template.spec;
  assert.ok(!browser.volumes.some((volume: { name: string }) => volume.name === 'postgres-ca'));
  assert.ok(!browser.containers[0].env.some((env: { name: string }) => env.name === 'DATABASE_URL'));
});

test('migration-specific mounts are opt-in and evaluation never creates a migration Job', { skip: noHelm }, () => {
  const defaults = render(SECRETS);
  assert.ok(defaults.ok, defaults.err);
  const pod = manifests(defaults.out).find(doc => doc?.kind === 'Job').spec.template.spec;
  assert.deepEqual(pod.volumes, [{ name: 'tmp', emptyDir: {} }]);
  assert.deepEqual(pod.containers[0].volumeMounts, [{ name: 'tmp', mountPath: '/tmp' }]);
  const evalProfile = render(['-f', `${CHART}/values-eval.yaml`,
    '--set-json', 'migrate.extraVolumes=[{"name":"postgres-ca","configMap":{"name":"ca"}}]',
    '--set-json', 'migrate.extraVolumeMounts=[{"name":"postgres-ca","mountPath":"/etc/lolly/postgres","readOnly":true}]',
  ]);
  assert.ok(evalProfile.ok, evalProfile.err);
  assert.ok(!manifests(evalProfile.out).some(doc => doc?.kind === 'Job'));
});

test('fresh-install migration hooks use an existing account and keep cleanup ordering independent of the app account', { skip: noHelm }, () => {
  const r = render(SECRETS);
  assert.ok(r.ok, r.err);
  const docs = manifests(r.out);
  const job = docs.find(doc => doc?.kind === 'Job');
  const app = deployment(r.out).spec.template.spec;
  const account = docs.find(doc => doc?.kind === 'ServiceAccount');
  assert.equal(job.spec.template.spec.serviceAccountName, 'default');
  assert.equal(app.serviceAccountName, account.metadata.name);
  assert.notEqual(job.spec.template.spec.serviceAccountName, app.serviceAccountName,
    'the pre-install hook cannot wait for an ordinary resource Helm creates after hooks');
  assert.equal(job.spec.template.spec.automountServiceAccountToken, false);
  assert.equal(job.metadata.annotations['helm.sh/hook'], 'pre-install,pre-upgrade');
  assert.equal(job.metadata.annotations['helm.sh/hook-delete-policy'], 'before-hook-creation');
  const secret = docs.find(doc => doc?.kind === 'Secret');
  assert.ok(Number(secret.metadata.annotations['helm.sh/hook-weight']) < Number(job.metadata.annotations['helm.sh/hook-weight']));
  assert.equal(docs.filter(doc => doc?.kind === 'ServiceAccount').length, 1,
    'only the ordinary app account is managed; no orphan hook account');
  assert.equal(account.metadata.annotations?.['helm.sh/hook'], undefined);

  const reused = render([...SECRETS, '--set', 'serviceAccount.create=false', '--set', 'serviceAccount.name=precreated-work']);
  assert.ok(reused.ok, reused.err);
  assert.equal(manifests(reused.out).find(doc => doc?.kind === 'Job').spec.template.spec.serviceAccountName, 'precreated-work');
  assert.equal(deployment(reused.out).spec.template.spec.serviceAccountName, 'precreated-work');
  assert.ok(!manifests(reused.out).some(doc => doc?.kind === 'ServiceAccount'));

  const separate = render([...SECRETS, '--set', 'migrate.serviceAccountName=precreated-migration']);
  assert.ok(separate.ok, separate.err);
  assert.equal(manifests(separate.out).find(doc => doc?.kind === 'Job').spec.template.spec.serviceAccountName, 'precreated-migration');
  assert.equal(deployment(separate.out).spec.template.spec.serviceAccountName, app.serviceAccountName);
});

test('worker DNS trust is namespace-scoped and HTTPS-only egress excludes special IPv6 addresses', { skip: noHelm }, () => {
  const active = [...SECRETS, ...WORKER, '--set', 'renderWorker.networkPolicy.enabled=true'];
  const r = render([...SMALL, ...active]);
  assert.ok(r.ok, r.err);
  const policy = manifests(r.out).find(doc => doc?.kind === 'NetworkPolicy' && doc.metadata.name.endsWith('render-worker'));
  const dns = policy.spec.egress.find((rule: { ports: { port: number }[] }) => rule.ports.some(port => port.port === 53));
  assert.deepEqual(dns.to, [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } }, podSelector: { matchLabels: { 'k8s-app': 'kube-dns' } } }]);
  const publicRule = policy.spec.egress.find((rule: { to: { ipBlock?: { cidr: string } }[] }) => rule.to.some(peer => peer.ipBlock?.cidr === '::/0'));
  assert.deepEqual(publicRule.ports, [{ protocol: 'TCP', port: 443 }]);
  const ipv6 = publicRule.to.find((peer: { ipBlock: { cidr: string } }) => peer.ipBlock.cidr === '::/0').ipBlock;
  for (const range of ['::/128', '::1/128', '::fffe:0:0/95', 'fc00::/7', 'fe80::/10']) assert.ok(ipv6.except.includes(range));
  assert.ok(!ipv6.except.includes('::ffff:0:0/96'), 'Kubernetes rejects the mapped IPv4 exception under an IPv6 CIDR');
  const disabled = render([...active, '--set-json', 'renderWorker.networkPolicy.publicPorts=[]']);
  assert.ok(disabled.ok, disabled.err);
  const closed = manifests(disabled.out).find(doc => doc?.kind === 'NetworkPolicy' && doc.metadata.name.endsWith('render-worker'));
  assert.ok(!closed.spec.egress.some((rule: { to: { ipBlock?: unknown }[] }) => rule.to.some(peer => peer.ipBlock)));
  for (const value of ['null', '443', '[22]', '["443"]', '[true]']) {
    const invalid = render([...active, '--set-json', `renderWorker.networkPolicy.publicPorts=${value}`]);
    assert.equal(invalid.ok, false, value);
    assert.match(invalid.err, /networkPolicy.publicPorts/);
  }
  const unscopedDns = render([...active, '--set-json', 'renderWorker.networkPolicy.dnsNamespaceLabels=null']);
  assert.equal(unscopedDns.ok, false);
  assert.match(unscopedDns.err, /dnsNamespaceLabels/);
});
