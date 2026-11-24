// SPDX-License-Identifier: MPL-2.0
/**
 * The Kubewarden policy set (deploy/kubewarden) against what Work's pods need.
 * lolly-work-requirements.json is generated from the chart, so a chart change that
 * needs a new volume type, capability or profile fails here until the requirements
 * and the policies agree again. Rendering needs helm; the policy checks do not.
 * Admission itself was qualified on a cluster; see deploy/kubewarden/README.md.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { parseAllDocuments } from 'yaml';
import { REQUIREMENTS_FILE, buildRequirements, serialise } from '../scripts/kubewarden-requirements.ts';
import { UNSIGNED_IMAGE, buildReport, kubewardenVersion, noDecision, podsFromRender, probes, refusedBy } from '../scripts/kubewarden-preflight.ts';
import { ADMISSION_REPORT_MAX_BYTES, admissionCheck, parseAdmissionReport, podAdmissionCheck } from '../server/src/setup/admission-report.ts';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const helm = spawnSync('helm', ['version', '--short'], { encoding: 'utf8' });
const noHelm = helm.error || helm.status !== 0 ? 'install helm to regenerate the requirements (no cluster needed)' : false;

type Doc = Record<string, any>;
const load = (path: string): Doc[] => parseAllDocuments(readFileSync(new URL(path, import.meta.url), 'utf8')).map(d => d.toJSON());
const policies = load('../deploy/kubewarden/policies.yaml');
const userNamespaceOption = load('../deploy/kubewarden/options/render-worker-user-namespace.yaml');
const requirements: Doc = JSON.parse(readFileSync(REQUIREMENTS_FILE, 'utf8'));
const policy = (name: string): Doc => {
  const found = policies.find(p => p.metadata.name === name);
  assert.ok(found, `policy ${name}`);
  return found;
};
const components: Doc[] = Object.values(requirements.components);
const options: Doc[] = components.flatMap(c => c.options);
const all = (key: string): unknown[] => [...components.map(c => c.default[key]), ...options.map(o => o.changes[key]).filter(v => v !== undefined)];

test('requirements file matches the chart, the worker egress rule and the release workflow', { skip: noHelm }, () => {
  assert.equal(readFileSync(REQUIREMENTS_FILE, 'utf8'), serialise(buildRequirements()),
    'run node scripts/kubewarden-requirements.ts --write, then review the policies');
});

test('every policy is a published Kubewarden policy pinned by tag and digest, enforcing in the labelled namespace', () => {
  for (const p of [...policies, ...userNamespaceOption]) {
    assert.equal(p.apiVersion, 'policies.kubewarden.io/v1');
    assert.equal(p.kind, 'ClusterAdmissionPolicy');
    assert.match(p.metadata.name, /^lolly-work-[a-z-]+$/);
    assert.equal(p.metadata.labels['app.kubernetes.io/part-of'], 'lolly-work-policy-set');
    assert.match(p.spec.module, /^registry:\/\/ghcr\.io\/kubewarden\/policies\/[a-z-]+:v\d+\.\d+\.\d+@sha256:[a-f0-9]{64}$/, p.metadata.name);
    assert.equal(p.spec.mode, 'protect');
    assert.deepEqual(p.spec.namespaceSelector, { matchLabels: { 'lolly.tools/policy-set': 'lolly-work' } });
    assert.deepEqual(p.spec.rules.map((r: Doc) => r.resources), [['pods']]);
  }
  assert.equal(new Set(policies.map(p => p.metadata.name)).size, policies.length);
  const sameModule = new Map<string, string>();
  for (const p of [...policies, ...userNamespaceOption]) {
    const [name, pin] = p.spec.module.split(':v');
    assert.equal(sameModule.get(name) ?? pin, pin, `${name} is pinned to one version everywhere`);
    sameModule.set(name, pin);
  }
});

test('the policies admit exactly the volume types, capabilities and identities the chart needs', () => {
  const volumes = new Set(all('volumeTypes').flat() as string[]);
  const allowedVolumes: string[] = policy('lolly-work-volumes').spec.settings.allowedTypes;
  assert.deepEqual([...allowedVolumes].sort(), [...volumes].filter(type => type !== 'hostPath').sort(),
    'every chart volume type except the single-node hostPath option');
  assert.ok(volumes.has('hostPath') && !allowedVolumes.includes('hostPath'));
  assert.ok(options.some(o => o.changes.automountServiceAccountToken === true) && !allowedVolumes.includes('projected'),
    'a mounted ServiceAccount token stays a deliberate change');

  for (const name of ['lolly-work-capabilities', 'lolly-work-capabilities-render-worker']) {
    const settings = policy(name).spec.settings;
    assert.deepEqual(settings.allowed_capabilities, []);
    assert.deepEqual(settings.required_drop_capabilities, ['ALL']);
  }
  for (const component of components) {
    assert.deepEqual(component.default.capabilities, { drop: ['ALL'], add: [] });
    assert.equal(component.default.privileged, false);
    assert.equal(component.default.readOnlyRootFilesystem, true);
    assert.deepEqual(component.default.allowPrivilegeEscalation, [false]);
    assert.equal(component.default.runAsNonRoot, true);
    for (const key of ['hostNetwork', 'hostPID', 'hostIPC']) assert.equal(component.default[key], false);
    assert.deepEqual(component.default.hostPorts, []);
  }
  const userNamespace = options.find(o => o.values.includes('renderWorker.userNamespace.enabled=true'));
  const widened = userNamespaceOption.find(p => p.metadata.name === 'lolly-work-capabilities-render-worker');
  const cel = userNamespaceOption.find(p => p.metadata.name === 'lolly-work-capabilities-need-user-namespace');
  assert.ok(userNamespace && widened && cel, 'the user-namespace option and both of its policies');
  assert.deepEqual(widened.spec.settings.allowed_capabilities, userNamespace.changes.capabilities.add);
  assert.deepEqual(widened.spec.objectSelector, policy('lolly-work-capabilities-render-worker').spec.objectSelector);
  assert.equal(userNamespace.changes.hostUsers, false);
  assert.match(cel.spec.settings.validations[0].expression, /object\.spec\.hostUsers == false/);

  const users = new Set(all('runAsUser').flat()), groups = new Set(all('runAsGroup').flat()), fsGroups = new Set(all('fsGroup'));
  const userGroup = policy('lolly-work-user-group').spec.settings;
  const within = (ranges: { min: number; max: number }[], id: unknown) => ranges.some(r => typeof id === 'number' && id >= r.min && id <= r.max);
  for (const id of users) assert.ok(within(userGroup.run_as_user.ranges, id), `UID ${id}`);
  for (const id of groups) assert.ok(within(userGroup.run_as_group.ranges, id), `GID ${id}`);
  for (const id of fsGroups) assert.ok(within(policy('lolly-work-fsgroup').spec.settings.ranges, id), `fsGroup ${id}`);
  assert.equal(userGroup.validate_only, undefined, 'validate_only refuses valid IDs in user-group-psp v1.1.5');
  assert.equal(policy('lolly-work-user-group').spec.mutating, true);
  assert.equal(policy('lolly-work-privilege-escalation').spec.settings.default_allow_privilege_escalation, false);
  assert.deepEqual(policy('lolly-work-host-namespaces').spec.settings,
    { allow_host_ipc: false, allow_host_network: false, allow_host_pid: false, allow_host_ports: [] });
});

test('seccomp and AppArmor allow the runtime default and the reviewed profiles only', () => {
  const seccomp = new Set(all('seccompProfiles').flat() as string[]);
  const localSeccomp = [...seccomp].filter(p => p.startsWith('Localhost/')).map(p => p.slice('Localhost/'.length));
  const settings = policy('lolly-work-seccomp').spec.settings;
  assert.deepEqual(settings.localhost_profiles, localSeccomp);
  assert.deepEqual(settings.profile_types, ['RuntimeDefault', 'Localhost']);
  assert.deepEqual(settings.allowed_profiles, ['runtime/default', ...localSeccomp.map(p => `localhost/${p}`)]);
  assert.ok(!seccomp.has('Unconfined'));

  const appArmor = new Set(all('appArmorProfiles').flat() as string[]);
  const localAppArmor = [...appArmor].filter(p => p.startsWith('Localhost/')).map(p => p.slice('Localhost/'.length));
  assert.deepEqual(localAppArmor, ['lolly-chromium']);
  const rule = policy('lolly-work-apparmor');
  assert.match(rule.spec.module, /\/cel-policy:/, 'the field-based profile needs CEL; apparmor-psp reads annotations only');
  const expressions = rule.spec.settings.validations.map((v: Doc) => v.expression).join('\n');
  for (const profile of localAppArmor) assert.ok(expressions.includes(`'${profile}'`) && expressions.includes(`'localhost/${profile}'`));
  assert.match(expressions, /appArmorProfile/);
  assert.match(expressions, /container\.apparmor\.security\.beta\.kubernetes\.io\//);
});

test('image sources and signatures follow the release workflow identity', () => {
  const signed: Doc[] = requirements.images.signed;
  const repositories = signed.map(image => image.repository).sort();
  assert.deepEqual(policy('lolly-work-image-sources').spec.settings.images.allow.slice().sort(), repositories);
  for (const component of components) for (const image of component.default.images) assert.ok(repositories.includes(image), image);
  const verify = policy('lolly-work-image-signatures');
  assert.equal(verify.spec.mutating, true);
  assert.equal(verify.spec.settings.modifyImagesWithDigest, true);
  assert.ok(verify.spec.timeoutEvalSeconds >= 5, 'a first verification fetches remote trust material');
  for (const image of signed) {
    const entry = verify.spec.settings.signatures.find((s: Doc) => s.image === `${image.repository}*`);
    assert.ok(entry, image.repository);
    assert.deepEqual(entry.keylessPrefix, [{ issuer: image.signature.issuer, url_prefix: image.signature.subjectPrefix }]);
    assert.ok(image.signature.subject.startsWith(image.signature.subjectPrefix));
    assert.ok(image.signature.subjectPrefix.endsWith('/'), 'the policy appends "/" to a prefix that lacks one');
  }
  assert.match(UNSIGNED_IMAGE, new RegExp(`^${repositories.find(r => r.endsWith('-server'))!.replaceAll('.', '\\.')}@sha256:[a-f0-9]{64}$`));
});

test('the worker NetworkPolicy refuses the same addresses as the worker code', () => {
  const worker = requirements.network['render-worker'];
  assert.deepEqual(worker.egressPublic.ipv4Except, worker.deniedInCode.ipv4);
  for (const range of worker.deniedInCode.ipv6) assert.ok(worker.egressPublic.ipv6Except.includes(range), range);
  assert.ok(worker.egressPublic.ipv4Except.includes('169.254.0.0/16'), 'cloud metadata stays unreachable');
  assert.deepEqual(worker.ingress, [{ fromComponent: 'control-plane', ports: [{ protocol: 'TCP', port: 8791 }] }]);
});

test('preflight sends each pod template as a Pod and each probe breaks one requirement', () => {
  const rendered = `
apiVersion: apps/v1
kind: Deployment
metadata: { name: lolly-work }
spec:
  template:
    metadata: { labels: { app.kubernetes.io/component: control-plane } }
    spec:
      serviceAccountName: lolly-work
      securityContext: { runAsUser: 1000, runAsNonRoot: true, seccompProfile: { type: RuntimeDefault } }
      containers:
        - name: server
          image: ghcr.io/lolly-tools/lolly-work-server:1.1.2
          securityContext: { allowPrivilegeEscalation: false, readOnlyRootFilesystem: true, capabilities: { drop: [ALL] } }
      volumes: [{ name: tmp, emptyDir: {} }]
---
apiVersion: batch/v1
kind: Job
metadata: { name: lolly-work-migrate }
spec:
  template:
    metadata: { labels: { app.kubernetes.io/component: migrate } }
    spec: { restartPolicy: Never, containers: [{ name: migrate, image: ghcr.io/lolly-tools/lolly-work-server:1.1.2 }] }
`;
  const pods = podsFromRender(rendered, 'lolly-work');
  assert.deepEqual(pods.map(p => [p.metadata.name, p.metadata.namespace, p.spec.restartPolicy]),
    [['lolly-work-preflight', 'lolly-work', 'Always'], ['lolly-work-migrate-preflight', 'lolly-work', 'Never']]);
  assert.equal(pods[0]!.spec.serviceAccountName, undefined, 'the chart account does not exist before installation');
  const base = pods[0]!;
  const list = probes(base);
  assert.equal(new Set(list.map(p => p.pod.metadata.name)).size, list.length);
  for (const probe of list) {
    assert.notDeepEqual(probe.pod.spec, base.spec, probe.expect);
    assert.deepEqual(probe.pod.metadata.labels, base.metadata.labels);
  }
  assert.deepEqual(base.spec.containers[0].securityContext.capabilities, { drop: ['ALL'] }, 'probes copy, never change, the base pod');
});

const activePolicy = (name: string, over: Doc = {}): Doc => ({
  metadata: { name }, spec: { module: `registry://ghcr.io/kubewarden/policies/${name}:v1.0.0`, mode: 'protect' },
  status: { policyStatus: 'active', mode: 'protect' }, ...over,
});
const cleanRun = () => buildReport({
  checkedAt: '2026-11-23T20:00:00.000Z', namespace: 'lolly-work',
  policyServers: [{ metadata: { name: 'default' }, spec: { image: 'ghcr.io/kubewarden/adm-controller/policy-server:v1.39.0' } }],
  policies: [activePolicy('lolly-work-volumes'), activePolicy('lolly-work-privileged')],
  pods: [{ name: 'lolly-work-preflight', admitted: true }],
  probes: [{ expect: 'privileged container', refused: true, by: 'clusterwide-lolly-work-privileged.kubewarden.admission' }],
});

test('the preflight record names Kubewarden, its version and each policy, and is clean only when every answer is', () => {
  assert.equal(kubewardenVersion('ghcr.io/kubewarden/adm-controller/policy-server:v1.39.0'), '1.39.0');
  assert.equal(kubewardenVersion('registry.example/policy-server:v1.39.0-rc.4@sha256:' + 'a'.repeat(64)), '1.39.0-rc.4');
  assert.equal(kubewardenVersion('registry.example/policy-server:latest'), null);
  assert.equal(refusedBy('Error from server: admission webhook "clusterwide-lolly-work-volumes.kubewarden.admission" denied the request: no'), 'clusterwide-lolly-work-volumes.kubewarden.admission');
  assert.equal(refusedBy('Error from server (Forbidden): exceeded quota'), null);
  // A Policy Server past its evaluation limit refuses without deciding; the preflight asks again.
  assert.equal(noDecision('admission webhook "kw.cap.lolly-work-image-sources.kubewarden.admission" denied the request: Policy execution interrupted because it exceeded the allowed execution time'), true);
  assert.equal(noDecision('admission webhook "kw.cap.lolly-work-apparmor.kubewarden.admission" denied the request without explanation'), true);
  assert.equal(noDecision('Internal error occurred: failed calling webhook "kw.cap.lolly-work-volumes.kubewarden.admission": context deadline exceeded'), true);
  assert.equal(noDecision('admission webhook "kw.cap.lolly-work-privileged.kubewarden.admission" denied the request: Privileged container is not allowed'), false);

  const report = cleanRun();
  assert.equal(report.source, 'kubewarden');
  assert.equal(report.kubewarden.version, '1.39.0');
  assert.deepEqual(report.policies.map(p => p.name), ['lolly-work-privileged', 'lolly-work-volumes']);
  assert.equal(report.ok, true);

  const base = { checkedAt: report.checkedAt, namespace: 'lolly-work', policyServers: [], pods: report.pods, probes: report.probes };
  assert.equal(buildReport({ ...base, policies: [] }).ok, false, 'a cluster without the set is never a clean record');
  assert.equal(buildReport({ ...base, policies: [activePolicy('lolly-work-volumes', { status: { policyStatus: 'pending', mode: 'protect' } })] }).ok, false);
  assert.equal(buildReport({ ...base, policies: [activePolicy('lolly-work-volumes', { status: { policyStatus: 'active', mode: 'monitor' } })] }).ok, false, 'monitor mode refuses nothing');
  assert.equal(buildReport({ ...base, policies: [activePolicy('lolly-work-volumes')], pods: [{ name: 'p', admitted: false }] }).ok, false);
  assert.equal(buildReport({ ...base, policies: [activePolicy('lolly-work-volumes')], probes: [{ expect: 'root user', refused: false, by: null }] }).ok, false);
  assert.equal(buildReport({ ...base, policies: [activePolicy('lolly-work-volumes')] }).kubewarden.version, null, 'no Policy Server read, no version claimed');
});

test('Setup shows the Kubewarden record as a dated record, and nothing when none is configured', () => {
  const now = Date.parse('2026-11-25T00:00:00Z');
  assert.equal(podAdmissionCheck({}, now), null, 'an install without Kubewarden shows no line');

  const record = parseAdmissionReport(JSON.stringify(cleanRun()));
  assert.ok(record);
  assert.deepEqual(admissionCheck(record, now), { id: 'pod-admission', status: 'pass',
    message: 'Reported by Kubewarden 1.39.0 for namespace lolly-work on 2026-11-23: 2 of 2 policies active and enforcing, 1 of 1 Lolly Work pod admitted, 1 of 1 test pod refused. This is the record your platform team made with the preflight, not a live reading.' });

  const stale = admissionCheck(record, Date.parse('2027-03-01T00:00:00Z'));
  assert.equal(stale.status, 'warning');
  assert.match(stale.message, /The record is 97 days old/);

  // The counts are recomputed: a record that calls itself clean while a policy is pending is not shown as clean.
  const forged = { ...cleanRun(), ok: true };
  forged.policies[0]!.active = false;
  const lowered = admissionCheck(parseAdmissionReport(JSON.stringify(forged)), now);
  assert.equal(lowered.status, 'warning');
  assert.match(lowered.message, /1 of 2 policies active and enforcing.*The record is not clean/);

  const noProbes = admissionCheck(parseAdmissionReport(JSON.stringify({ ...cleanRun(), probes: [] })), now);
  assert.equal(noProbes.status, 'pass');
  assert.match(noProbes.message, /no test pods sent/);

  for (const bad of ['', 'not json', '[]', JSON.stringify({ ...cleanRun(), source: 'other' }), JSON.stringify({ ...cleanRun(), version: 2 }),
    JSON.stringify({ ...cleanRun(), namespace: '<b>x</b>' }), JSON.stringify({ ...cleanRun(), checkedAt: 'yesterday' }), JSON.stringify({ ...cleanRun(), policies: 'all' })]) {
    assert.equal(parseAdmissionReport(bad), null, bad.slice(0, 40));
  }
  assert.equal(parseAdmissionReport(JSON.stringify({ ...cleanRun(), kubewarden: { version: '<script>' } }))!.version, null, 'a version that is not a version is left out');

  const dir = mkdtempSync(join(tmpdir(), 'lw-admission-'));
  const file = join(dir, 'report.json');
  writeFileSync(file, JSON.stringify(cleanRun()));
  assert.equal(podAdmissionCheck({ LW_ADMISSION_REPORT_FILE: file }, now)!.status, 'pass');
  assert.match(podAdmissionCheck({ LW_ADMISSION_REPORT_FILE: join(dir, 'missing.json') }, now)!.message, /could not be read/);
  writeFileSync(file, ' '.repeat(ADMISSION_REPORT_MAX_BYTES + 1));
  assert.match(podAdmissionCheck({ LW_ADMISSION_REPORT_FILE: file }, now)!.message, /could not be read/);
});

test('the chart mounts the record only when a ConfigMap is named, and the policy set admits the mount', { skip: noHelm }, () => {
  const render = (...args: string[]) => {
    const r = spawnSync('helm', ['template', 'lolly', new URL('../deploy/helm', import.meta.url).pathname,
      '--set', 'secrets.sessionSecret=test', '--set', 'secrets.linkSecret=test', ...args], { encoding: 'utf8' });
    assert.equal(r.status, 0, r.stderr);
    return parseAllDocuments(r.stdout).map(d => d.toJSON()).find((doc: Doc) => doc?.kind === 'Deployment' && doc.metadata.labels['app.kubernetes.io/component'] !== 'render-worker')!.spec.template.spec;
  };
  assert.ok(!JSON.stringify(render()).includes('admission'), 'off by default');
  const spec = render('--set', 'admissionReport.existingConfigMap=lolly-work-admission');
  const volume = spec.volumes.find((v: Doc) => v.name === 'admission-report');
  assert.deepEqual(volume.configMap, { name: 'lolly-work-admission', optional: true, items: [{ key: 'report.json', path: 'report.json' }] });
  assert.ok(policy('lolly-work-volumes').spec.settings.allowedTypes.includes('configMap'));
  const server = spec.containers[0];
  const mount = server.volumeMounts.find((m: Doc) => m.name === 'admission-report');
  assert.deepEqual(mount, { name: 'admission-report', mountPath: '/run/admission-report', readOnly: true });
  assert.equal(mount.subPath, undefined, 'a subPath mount would never see an updated ConfigMap');
  assert.equal(server.env.find((e: Doc) => e.name === 'LW_ADMISSION_REPORT_FILE').value, '/run/admission-report/report.json');
  assert.equal(spec.automountServiceAccountToken, false, 'the record needs no Kubernetes API access');
});
