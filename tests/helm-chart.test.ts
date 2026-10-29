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
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, parseAllDocuments } from 'yaml';
import { parseConfig } from '../server/src/config/instance.ts';

const CHART = fileURLToPath(new URL('../deploy/helm', import.meta.url));
const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const noHelm = helm.error || helm.status !== 0 ? 'install helm to run (no cluster needed)' : false;
if (process.env.LW_REQUIRE_HELM_TESTS === '1' && noHelm) throw new Error('Helm qualification requires a working Helm binary');

const SECRETS = ['--set', 'secrets.sessionSecret=aaaa', '--set', 'secrets.linkSecret=bbbb'];
const WORKER = [
  '--set', 'renderWorker.enabled=true', '--set', 'renderWorker.tls.existingSecret=worker-tls', '--set', 'renderWorker.tls.caSecret=worker-ca',
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

// One number for everything people install (Andy, 2026-10-27): the chart's own version
// is the Lolly release, the same as appVersion and Work's package.json. Read without
// helm, so the check runs everywhere.
test('the chart carries the release version: version equals appVersion equals Work', () => {
  const work = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const chart = parse(readFileSync(join(CHART, 'Chart.yaml'), 'utf8'));
  assert.match(work, /^\d+\.\d+\.\d+$/);
  assert.equal(chart.appVersion, work, 'Chart.yaml appVersion');
  assert.equal(chart.version, work, 'Chart.yaml version');
});

// The render worker and the admission adapter ship as their own images, so their packages
// carry the release number too (Andy, 2026-10-29). The appliance and the ready-made package
// take theirs from deploy/marketplaces/release.json, which marketplace-cohort.ts writes from
// the published release, so they follow once a release is pinned and are not checked here.
test('the render worker and admission adapter carry the release version', () => {
  const work = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  for (const path of ['../workers/render/package.json', '../services/admission/package.json']) {
    assert.equal(JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8')).version, work, path);
  }
});

test('chart application version matches Work and defaults server, migration and worker images together', { skip: noHelm }, () => {
  const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  const chart = parse(readFileSync(join(CHART, 'Chart.yaml'), 'utf8'));
  assert.equal(chart.appVersion, appVersion);
  const values = parse(readFileSync(join(CHART, 'values.yaml'), 'utf8'));
  const r = render([...SECRETS, ...WORKER]); assert.ok(r.ok, r.err);
  const docs = manifests(r.out), app = deployment(r.out), worker = deployment(r.out, true);
  const migration = docs.find(doc => doc.kind === 'Job');
  assert.equal(app.spec.template.spec.containers[0].image, `${values.image.repository}:${appVersion}`);
  assert.equal(migration.spec.template.spec.containers[0].image, app.spec.template.spec.containers[0].image);
  assert.equal(worker.spec.template.spec.containers[0].image, `${values.renderWorker.image.repository}:${appVersion}`);
});

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
  assert.deepEqual(cfg.policy.activity, { mode: 'off', auditSessionUpdates: false });
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

test('render browser requires HTTPS or explicit loopback while the worker API stays private', { skip: noHelm }, () => {
  const enabled = ['--set', 'renderWorker.enabled=true', '--set', 'renderWorker.tls.existingSecret=worker-tls', '--set', 'renderWorker.tls.caSecret=worker-ca', '--set', 'renderWorker.secret=cccc'];
  for (const base of ['https://lolly.ing', 'https://shell.internal:8443/lolly',
    'https://[2001:db8::1]:8443', 'http://localhost:8787', 'http://127.0.0.1:8787', 'http://[::1]:8787']) {
    const r = render([...SECRETS, ...enabled, '--set-json', `renderWorker.webBase=${JSON.stringify(base)}`,
      '--set-string', 'config.render.worker.url=https://lolly-lolly-work-render-worker.default.svc:8791']);
    assert.ok(r.ok, `${base}: ${r.err}`);
    const env = deployment(r.out, true).spec.template.spec.containers[0].env;
    assert.equal(env.find((item: { name: string; value: string }) => item.name === 'LOLLY_WEB_BASE').value, base);
    const cfg = JSON.parse(manifests(r.out).find(d => d.kind === 'ConfigMap').data['instance.json']);
    assert.equal(cfg.render.worker.url, 'https://lolly-lolly-work-render-worker.default.svc:8791');
  }
  for (const base of ['', 'http://lolly-work.lolly-private.svc.cluster.local', 'http://10.4.27.58:8787',
    'http://lolly.ing', 'http://localhost.evil.test', 'http://127.1', 'http://2130706433',
    'ftp://lolly.ing', '//lolly.ing', 'https://owner:secret@lolly.ing',
    'https://lolly.ing?token=secret', 'https://lolly.ing#fragment', 'https://lolly.ing\\evil',
    ' https://lolly.ing', 'https://', 'https://lolly.ing:bad', 'https://lolly.ing:65536']) {
    const r = render([...SECRETS, ...enabled, '--set-json', `renderWorker.webBase=${JSON.stringify(base)}`]);
    assert.equal(r.ok, false, base);
    assert.match(r.err, /renderWorker.webBase must be a HTTPS shell URL/);
    assert.ok(!r.err.includes('owner:secret'), 'refusal must not echo URL credentials');
  }
  const nonString = render([...SECRETS, ...WORKER, '--set', 'renderWorker.webBase=true']);
  assert.equal(nonString.ok, false); assert.match(nonString.err, /renderWorker.webBase must be a HTTPS shell URL/);
  assert.ok(render([...SECRETS, '--set-string', 'renderWorker.webBase=http://unused-service']).ok,
    'disabled workers do not change the default and evaluation topology');
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

test('worker NetworkPolicy is enabled by default and permits explicit disablement', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER]);
  assert.ok(r.ok, r.err);
  assert.ok(policyNamed(r.out, 'render-worker'));
  const disabled = render([...SECRETS, ...WORKER, '--set', 'renderWorker.networkPolicy.enabled=false']);
  assert.ok(disabled.ok, disabled.err);
  assert.ok(!policyNamed(disabled.out, 'render-worker'));
  const worker = deployment(r.out, true).spec.template.spec;
  assert.equal(worker.containers[0].securityContext.readOnlyRootFilesystem, true);
  assert.equal(worker.volumes.find((volume: { name: string }) => volume.name === 'tmp').emptyDir.sizeLimit, '1Gi');
});

test('worker browser startup is bounded without weakening container hardening', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...WORKER]); assert.ok(r.ok, r.err);
  const pod = deployment(r.out, true).spec.template.spec;
  const container = pod.containers[0];
  assert.equal(container.env.find((entry: { name: string }) => entry.name === 'LW_RENDER_BROWSER_STARTUP_TIMEOUT_MS').value, '30000');
  assert.equal(pod.securityContext.runAsUser, 1000);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.readOnlyRootFilesystem, true);
  assert.deepEqual(container.securityContext.capabilities.drop, ['ALL']);
  assert.equal(container.securityContext.seccompProfile.type, 'RuntimeDefault');
  const custom = render([...SECRETS, ...WORKER, '--set', 'renderWorker.browserStartupTimeoutMs=1000']);
  assert.ok(custom.ok, custom.err);
  for (const value of ['0', '999', '120001', '1.5', 'false', 'unbounded']) {
    const invalid = render([...SECRETS, ...WORKER, '--set', `renderWorker.browserStartupTimeoutMs=${value}`]);
    assert.equal(invalid.ok, false); assert.match(invalid.err, /browserStartupTimeoutMs/);
  }
});

test('worker TLS key stays in the worker while both endpoints receive the public trust bundle', { skip: noHelm }, () => {
  for (const key of ['existingSecret', 'caSecret']) {
    const refused = render([...SECRETS, ...WORKER, '--set', `renderWorker.tls.${key}=`]);
    assert.equal(refused.ok, false); assert.match(refused.err, /renderWorker.tls/);
  }
  const r = render([...SECRETS, ...WORKER]); assert.ok(r.ok, r.err);
  const worker = deployment(r.out, true).spec.template.spec;
  const app = deployment(r.out).spec.template.spec;
  assert.equal(worker.containers[0].readinessProbe.httpGet.scheme, 'HTTPS');
  assert.equal(worker.containers[0].livenessProbe.httpGet.scheme, 'HTTPS');
  assert.equal(worker.containers[0].env.find((entry: { name: string }) => entry.name === 'LW_RENDER_DEPLOYMENT_MODE').value, 'production');
  assert.equal(worker.containers[0].env.find((entry: { name: string }) => entry.name === 'LW_RENDER_TLS_SERVER_NAME').value, 'lolly-lolly-work-render-worker.default.svc');
  assert.equal(app.containers[0].env.find((entry: { name: string }) => entry.name === 'NODE_EXTRA_CA_CERTS').value, '/run/render-trust/ca.crt');
  assert.ok(!app.volumes.some((volume: { name: string }) => volume.name === 'render-tls'));
  assert.equal(worker.volumes.find((volume: { name: string }) => volume.name === 'render-tls').secret.secretName, 'worker-tls');
  assert.equal(app.volumes.find((volume: { name: string }) => volume.name === 'render-trust').secret.secretName, 'worker-ca');
  for (const pod of [worker, app]) assert.equal(pod.containers[0].volumeMounts.find((mount: { name: string }) => mount.name === 'render-trust').readOnly, true);
});

test('worker accepts a reviewed local seccomp profile and refuses an unconfined policy', { skip: noHelm }, () => {
  const approved = render([...SECRETS, ...WORKER, '--set-json', 'renderWorker.seccompProfile={"type":"Localhost","localhostProfile":"lolly/chromium.json"}']);
  assert.ok(approved.ok, approved.err);
  assert.deepEqual(deployment(approved.out, true).spec.template.spec.containers[0].securityContext.seccompProfile,
    { type: 'Localhost', localhostProfile: 'lolly/chromium.json' });
  for (const profile of [{ type: 'Unconfined' }, { type: 'Localhost', localhostProfile: '../profile.json' }, { type: 'Localhost' }]) {
    const refused = render([...SECRETS, ...WORKER, '--set-json', `renderWorker.seccompProfile=${JSON.stringify(profile)}`]);
    assert.equal(refused.ok, false); assert.match(refused.err, /seccompProfile/);
  }
});

test('worker names an AppArmor profile only when asked, for AppArmor nodes on Kubernetes 1.30+', { skip: noHelm }, () => {
  const plain = render([...SECRETS, ...WORKER]); assert.ok(plain.ok, plain.err);
  assert.equal(deployment(plain.out, true).spec.template.spec.containers[0].securityContext.appArmorProfile, undefined, 'SELinux nodes need the field left out');
  const localhost = ['--set-json', 'renderWorker.appArmorProfile={"type":"Localhost","localhostProfile":"lolly-chromium"}'];
  const approved = render([...SECRETS, ...WORKER, ...localhost, '--set-json', 'renderWorker.seccompProfile={"type":"Localhost","localhostProfile":"lolly/chromium.json"}', '--kube-version', '1.30.0']);
  assert.ok(approved.ok, approved.err);
  const context = deployment(approved.out, true).spec.template.spec.containers[0].securityContext;
  assert.deepEqual(context.appArmorProfile, { type: 'Localhost', localhostProfile: 'lolly-chromium' });
  assert.deepEqual(context.seccompProfile, { type: 'Localhost', localhostProfile: 'lolly/chromium.json' });
  assert.equal(deployment(approved.out).spec.template.spec.containers[0].securityContext.appArmorProfile, undefined, 'the control plane is unchanged');
  const old = render([...SECRETS, ...WORKER, ...localhost, '--kube-version', '1.29.9']);
  assert.equal(old.ok, false); assert.match(old.err, /appArmorProfile requires Kubernetes 1\.30/);
  for (const profile of [{ type: 'Unconfined' }, { type: 'Localhost' }, { type: 'Localhost', localhostProfile: '../lolly-chromium' }, { localhostProfile: 'lolly-chromium' }]) {
    const refused = render([...SECRETS, ...WORKER, '--set-json', `renderWorker.appArmorProfile=${JSON.stringify(profile)}`, '--kube-version', '1.35.0']);
    assert.equal(refused.ok, false, JSON.stringify(profile)); assert.match(refused.err, /appArmorProfile/);
  }
});

test('worker user namespace scopes SYS_ADMIN and SYS_CHROOT to hostUsers: false and makes the worker check it', { skip: noHelm }, () => {
  const off = deployment(render([...SECRETS, ...WORKER]).out, true).spec.template.spec;
  assert.equal(off.hostUsers, undefined);
  assert.equal(off.containers[0].securityContext.capabilities.add, undefined);
  assert.ok(!off.containers[0].env.some((entry: { name: string }) => entry.name === 'LW_RENDER_REQUIRE_USER_NAMESPACE'));
  const on = render([...SECRETS, ...WORKER, '--set', 'renderWorker.userNamespace.enabled=true', '--kube-version', '1.35.0']);
  assert.ok(on.ok, on.err);
  const pod = deployment(on.out, true).spec.template.spec, container = pod.containers[0];
  assert.equal(pod.hostUsers, false);
  assert.deepEqual(container.securityContext.capabilities, { drop: ['ALL'], add: ['SYS_ADMIN', 'SYS_CHROOT'] });
  assert.equal(container.securityContext.allowPrivilegeEscalation, false);
  assert.equal(container.securityContext.runAsNonRoot, true);
  assert.equal(container.securityContext.seccompProfile.type, 'RuntimeDefault');
  assert.equal(container.env.find((entry: { name: string }) => entry.name === 'LW_RENDER_REQUIRE_USER_NAMESPACE').value, '1');
  assert.equal(deployment(on.out).spec.template.spec.hostUsers, undefined);
  const old = render([...SECRETS, ...WORKER, '--set', 'renderWorker.userNamespace.enabled=true', '--kube-version', '1.32.0']);
  assert.equal(old.ok, false); assert.match(old.err, /userNamespace requires Kubernetes 1\.33/);
  const invalid = render([...SECRETS, ...WORKER, '--set-string', 'renderWorker.userNamespace.enabled=yes', '--kube-version', '1.35.0']);
  assert.equal(invalid.ok, false); assert.match(invalid.err, /userNamespace/);
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
  const appVersion = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version;
  assert.equal(deployment(original.out).spec.template.spec.containers[0].image, `ghcr.io/lolly-tools/lolly-work-server:${appVersion}`);
  assert.equal(deployment(original.out, true).spec.template.spec.containers[0].image, `ghcr.io/lolly-tools/lolly-work-render-worker:${appVersion}`);
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
  assert.equal(job.metadata.annotations['helm.sh/hook-delete-policy'], 'before-hook-creation',
    'the last migration Job and its logs stay until the next upgrade, and Helm waits for its deletion before creating the next one');
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

// Plan 324 M2: suggested alerts and a dashboard, both off by default, reading only what /metrics exports.
const MONITORING = ['--set', 'metrics.prometheusRule.enabled=true', '--set', 'metrics.grafanaDashboard.enabled=true'];
const ruleOf = (out: string) => manifests(out).find(doc => doc?.kind === 'PrometheusRule');
const alertsOf = (out: string): { alert: string; expr: string; labels: Record<string, string>; annotations: Record<string, string> }[] =>
  ruleOf(out).spec.groups.flatMap((group: { rules: unknown[] }) => group.rules);
/** Metric names the server can emit: scrape-time gauges in app.ts, counters and blob lines in metrics.ts. */
function exportedMetrics(): Set<string> {
  const source = ['server/src/api/app.ts', 'server/src/observability/metrics.ts'].map(serverSource).join('\n');
  return new Set([...source.matchAll(/(?:name: |inc\()'(lw_[a-z0-9_]+)'/g)].map(match => match[1]!));
}
/** Server sources read as text, by path from the repository root (they are not imported). */
const serverSource = (path: string): string => readFileSync(join(CHART, '../..', path), 'utf8');
const metricNames = (text: string): string[] => [...new Set(text.match(/\blw_[a-z0-9_]+/g) ?? [])];

test('alerts and dashboard stay off by default', { skip: noHelm }, () => {
  const r = render(SECRETS); assert.ok(r.ok, r.err);
  assert.equal(ruleOf(r.out), undefined);
  assert.ok(!manifests(r.out).some(doc => doc?.kind === 'ConfigMap' && doc.metadata.name.endsWith('-dashboard')));
});

test('suggested alerts read only exported metrics and registered routes, scoped to this release', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...MONITORING]); assert.ok(r.ok, r.err);
  const alerts = alertsOf(r.out);
  const exported = exportedMetrics();
  assert.ok(exported.has('lw_audit_chain_intact') && exported.has('lw_http_requests_total'), 'the source scan finds the exported metrics');
  assert.equal(new Set(alerts.map(a => a.alert)).size, alerts.length);
  const app = serverSource('server/src/api/app.ts');
  for (const alert of alerts) {
    assert.match(alert.alert, /^LollyWork[A-Za-z]+$/);
    assert.ok(['critical', 'warning'].includes(alert.labels.severity!), alert.alert);
    assert.ok(alert.annotations.summary && alert.annotations.description, `${alert.alert} explains itself`);
    for (const name of metricNames(alert.expr)) assert.ok(exported.has(name), `${alert.alert} reads ${name}, which Work does not export`);
    for (const selector of alert.expr.match(/lw_[a-z0-9_]+\{[^}]*\}/g) ?? []) {
      assert.ok(selector.includes('job="lolly-lolly-work",namespace="default"'), `${alert.alert}: ${selector} is not scoped to the release`);
    }
    for (const route of alert.expr.match(/\/[a-z0-9/:]+(?=["|])/g) ?? []) {
      assert.ok(app.includes(`'${route}'`), `${alert.alert} names route ${route}, which no handler registers`);
    }
    assert.ok(!alert.expr.includes('__'), `${alert.alert} kept a placeholder`);
  }
  assert.match(alerts.find(a => a.alert === 'LollyWorkRateLimitBucketsHigh')!.expr, /> 0\.8 \* 50000$/);
});

test('alert options: labels, a custom selector, disabled alerts and the configured bucket limit', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...MONITORING,
    '--set-json', 'metrics.prometheusRule.alertLabels={"team":"platform"}',
    '--set-json', 'metrics.prometheusRule.disabled=["LollyWorkBlobReadsNearOffload"]',
    '--set-string', 'metrics.prometheusRule.seriesSelector=job="work"',
    '--set', 'config.rateLimit.maxBuckets=20000', '--set', 'metrics.prometheusRule.namespace=monitoring']);
  assert.ok(r.ok, r.err);
  const alerts = alertsOf(r.out);
  assert.ok(!alerts.some(a => a.alert === 'LollyWorkBlobReadsNearOffload'));
  for (const alert of alerts) {
    assert.equal(alert.labels.team, 'platform');
    assert.ok(alert.labels.severity);
    for (const selector of alert.expr.match(/lw_[a-z0-9_]+\{[^}]*\}/g) ?? []) assert.ok(selector.startsWith(selector.split('{')[0] + '{job="work"'), selector);
  }
  assert.equal(ruleOf(r.out).metadata.namespace, 'monitoring');
  assert.match(alerts.find(a => a.alert === 'LollyWorkRateLimitBucketsHigh')!.expr, /> 0\.8 \* 20000$/);
  const directory = mkdtempSync(join(tmpdir(), 'lolly-helm-rules-config-'));
  try {
    const config = join(directory, 'instance.json');
    writeFileSync(config, JSON.stringify({ rateLimit: { maxBuckets: 7000 } }), { mode: 0o600 });
    const raw = render([...SECRETS, ...MONITORING, '--set-file', `config=${config}`]); assert.ok(raw.ok, raw.err);
    assert.match(alertsOf(raw.out).find(a => a.alert === 'LollyWorkRateLimitBucketsHigh')!.expr, /> 0\.8 \* 7000$/, 'a raw instance.json is read too');
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
  const unknown = render([...SECRETS, ...MONITORING, '--set-json', 'metrics.prometheusRule.disabled=["LollyWorkTypo"]']);
  assert.equal(unknown.ok, false); assert.match(unknown.err, /unknown alert "LollyWorkTypo"/);
  const names = alertsOf(render([...SECRETS, ...MONITORING]).out).map(a => a.alert);
  const none = render([...SECRETS, ...MONITORING, '--set-json', `metrics.prometheusRule.disabled=${JSON.stringify(names)}`]);
  assert.equal(none.ok, false); assert.match(none.err, /leaves no alerts/);
});

test('Grafana dashboard ConfigMap carries the sidecar label and reads only exported metrics', { skip: noHelm }, () => {
  const r = render([...SECRETS, ...MONITORING, '--set-json', 'metrics.grafanaDashboard.annotations={"grafana_folder":"Lolly"}']);
  assert.ok(r.ok, r.err);
  const map = manifests(r.out).find(doc => doc?.kind === 'ConfigMap' && doc.metadata.name.endsWith('-dashboard'));
  assert.equal(map.metadata.labels.grafana_dashboard, '1');
  assert.equal(map.metadata.annotations.grafana_folder, 'Lolly');
  const dashboard = JSON.parse(map.data['lolly-work.json']);
  assert.deepEqual(dashboard, JSON.parse(readFileSync(join(CHART, 'dashboards/lolly-work.json'), 'utf8')));
  assert.equal(dashboard.uid, 'lolly-work');
  assert.deepEqual(dashboard.templating.list.map((v: { name: string }) => v.name), ['datasource', 'namespace', 'job']);
  const exported = exportedMetrics();
  const panels = dashboard.panels.filter((panel: { type: string }) => panel.type !== 'row');
  assert.ok(panels.length >= 15);
  for (const panel of panels) {
    assert.ok(panel.title && panel.description, `panel ${panel.id} has a title and a description`);
    for (const target of panel.targets) {
      assert.ok(metricNames(target.expr).length, `${panel.title} reads a Work metric`);
      for (const name of metricNames(target.expr)) assert.ok(exported.has(name), `${panel.title} reads ${name}, which Work does not export`);
      assert.match(target.expr, /namespace="\$namespace",job="\$job"/, `${panel.title} follows the dashboard variables`);
    }
  }
});

// promtool runs where it is installed; helm qualification installs a checksum-pinned copy.
const promtool = spawnSync('promtool', ['--version'], { encoding: 'utf8' });
const noPromtool = promtool.error || promtool.status !== 0 ? 'install promtool to check and unit-test the alert rules' : false;
if (process.env.LW_REQUIRE_HELM_TESTS === '1' && noPromtool) throw new Error('Helm qualification requires promtool for the alert rules');

test('alert rules pass promtool check and their unit tests', { skip: noPromtool }, () => {
  const r = spawnSync('helm', ['template', 'lolly-work', CHART, '-n', 'lolly-work', ...SECRETS, '--set', 'metrics.prometheusRule.enabled=true'], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const directory = mkdtempSync(join(tmpdir(), 'lolly-promtool-'));
  try {
    writeFileSync(join(directory, 'rules.yaml'), JSON.stringify({ groups: ruleOf(r.stdout).spec.groups }));
    writeFileSync(join(directory, 'rules.test.yaml'), readFileSync(join(CHART, 'files/prometheus-rules.test.yaml')));
    const check = spawnSync('promtool', ['check', 'rules', '--lint=all', '--lint-fatal', 'rules.yaml'], { cwd: directory, encoding: 'utf8' });
    assert.equal(check.status, 0, check.stdout + check.stderr);
    const unit = spawnSync('promtool', ['test', 'rules', 'rules.test.yaml'], { cwd: directory, encoding: 'utf8' });
    assert.equal(unit.status, 0, unit.stdout + unit.stderr);
    const tested = new Set([...readFileSync(join(CHART, 'files/prometheus-rules.test.yaml'), 'utf8').matchAll(/alertname: (\w+)/g)].map(m => m[1]));
    for (const alert of alertsOf(r.stdout)) assert.ok(tested.has(alert.alert), `${alert.alert} has a promtool unit test`);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});

test('OpenTelemetry export is off by default and sets the standard variables on the server only when on', { skip: noHelm }, () => {
  const envNames = (doc: { spec: { template: { spec: { containers: { env?: { name: string }[] }[] } } } }) =>
    doc.spec.template.spec.containers.flatMap(c => (c.env ?? []).map(e => e.name));
  const off = render([...SECRETS, ...WORKER]);
  assert.ok(off.ok, off.err);
  assert.doesNotMatch(off.out, /OTEL_/, 'nothing is set, so the server exports nothing');

  const on = render([...SECRETS, ...WORKER, '--set', 'otel.enabled=true', '--set', 'otel.endpoint=http://otel-collector.observability.svc:4318',
    '--set', 'otel.protocol=http/json', '--set', 'otel.serviceName=work-eu', '--set', 'otel.logs=false',
    '--set-json', 'otel.resourceAttributes={"deployment.environment.name":"prod one","team":"brand,web"}',
    '--set', 'otel.sampler=parentbased_traceidratio', '--set', 'otel.samplerArg=0.25',
    '--set', 'otel.headersSecret.name=otlp-auth', '--set', 'otel.headersSecret.key=headers']);
  assert.ok(on.ok, on.err);
  const app = deployment(on.out);
  const env = Object.fromEntries(app.spec.template.spec.containers[0].env.map((e: { name: string; value?: string; valueFrom?: unknown }) => [e.name, e.value ?? e.valueFrom]));
  assert.equal(env.OTEL_EXPORTER_OTLP_ENDPOINT, 'http://otel-collector.observability.svc:4318');
  assert.equal(env.OTEL_EXPORTER_OTLP_PROTOCOL, 'http/json');
  assert.equal(env.OTEL_SERVICE_NAME, 'work-eu');
  assert.equal(env.OTEL_RESOURCE_ATTRIBUTES, 'deployment.environment.name=prod%20one,team=brand%2Cweb', 'percent-encoded, as the variable defines');
  assert.equal(env.OTEL_TRACES_EXPORTER, 'otlp');
  assert.equal(env.OTEL_METRICS_EXPORTER, 'otlp');
  assert.equal(env.OTEL_LOGS_EXPORTER, 'none');
  assert.equal(env.OTEL_TRACES_SAMPLER_ARG, '0.25');
  assert.deepEqual(env.OTEL_EXPORTER_OTLP_HEADERS, { secretKeyRef: { name: 'otlp-auth', key: 'headers' } }, 'the header value comes from a Secret, never from values');
  const migration = manifests(on.out).find(doc => doc?.kind === 'Job');
  assert.ok(!envNames(migration).some(n => n.startsWith('OTEL_')), 'the migrate Job exports nothing');
  assert.ok(!envNames(deployment(on.out, true)).some(n => n.startsWith('OTEL_')), 'nor does the render worker');

  const missing = render([...SECRETS, '--set', 'otel.enabled=true']);
  assert.equal(missing.ok, false);
  assert.match(missing.err, /otel.endpoint is required/);
  for (const bad of ['otel.protocol=grpc', 'otel.sampler=sometimes', 'otel.samplerArg=1.5', 'otel.endpoint=collector:4318', 'otel.compression=zstd']) {
    const r = render([...SECRETS, '--set', 'otel.enabled=true', '--set', 'otel.endpoint=http://c:4318', '--set', bad]);
    assert.equal(r.ok, false, `${bad} must be refused by values.schema.json`);
  }
});
