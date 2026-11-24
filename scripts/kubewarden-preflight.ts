// SPDX-License-Identifier: MPL-2.0
/**
 * Ask the cluster's admission chain about Work's pods before installing them.
 *
 *   helm template lolly-work deploy/helm -n lolly-work -f my-values.yaml \
 *     | node scripts/kubewarden-preflight.ts --namespace lolly-work [--probes] [--report <file>]
 *
 * Each pod template in the rendered chart (Deployments and the migration Job) is
 * sent as a Pod with `kubectl create --dry-run=server`, so every validating and
 * mutating webhook answers and nothing is created. With --probes it also sends
 * copies of the control-plane pod that each break one requirement in
 * deploy/kubewarden/lolly-work-requirements.json, plus an unsigned and an
 * unlisted image; the policy set must refuse every one. Exit status 1 means a
 * Work pod was refused or a probe was admitted. Needs kubectl and a kubeconfig.
 *
 * --report <file> also writes what Kubewarden answered as JSON: its version, the
 * state of each policy in the set, and which pods it admitted or refused. The
 * chart can mount that file (admissionReport.existingConfigMap) so the Setup page
 * shows the record to administrators. It holds names and fixed words only, never
 * a webhook's message. It needs read access to Kubewarden's policy objects.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parseAllDocuments, stringify } from 'yaml';

type Doc = Record<string, any>;

/** A published lolly-work-server build from before release signing: it has no signature. */
export const UNSIGNED_IMAGE = 'ghcr.io/lolly-tools/lolly-work-server@sha256:18871c56d894c2bcd801874071e38ffff327f75d602f3e8c960fa830669969db';

export function podsFromRender(text: string, namespace: string): Doc[] {
  const pods: Doc[] = [];
  for (const doc of parseAllDocuments(text).map(d => d.toJSON()).filter(Boolean)) {
    if (!['Deployment', 'StatefulSet', 'DaemonSet', 'Job'].includes(doc.kind)) continue;
    const template = doc.spec.template;
    // The chart's ServiceAccount does not exist before installation, and the
    // built-in ServiceAccount check would refuse the pod for that alone.
    const { serviceAccountName: _account, ...spec } = template.spec;
    pods.push({
      apiVersion: 'v1', kind: 'Pod',
      metadata: { name: `${doc.metadata.name}-preflight`.slice(0, 63), namespace, labels: template.metadata?.labels ?? {} },
      spec: { ...spec, ...(doc.kind === 'Job' ? {} : { restartPolicy: 'Always' }) },
    });
  }
  return pods;
}

/** Copies of a compliant pod that each break exactly one requirement. */
export function probes(base: Doc): { expect: string; pod: Doc }[] {
  const copy = (name: string, change: (spec: Doc) => void): Doc => {
    const pod = structuredClone(base);
    pod.metadata.name = `preflight-probe-${name}`;
    change(pod.spec);
    return pod;
  };
  const main = (spec: Doc) => spec.containers[0];
  return [
    { expect: 'privileged container', pod: copy('privileged', s => { main(s).securityContext = { ...main(s).securityContext, privileged: true, allowPrivilegeEscalation: true }; }) },
    { expect: 'added capability NET_ADMIN', pod: copy('capability', s => { main(s).securityContext.capabilities = { drop: ['ALL'], add: ['NET_ADMIN'] }; }) },
    { expect: 'root user', pod: copy('root', s => { s.securityContext = { ...s.securityContext, runAsUser: 0, runAsNonRoot: false }; }) },
    { expect: 'writable root filesystem', pod: copy('writable-root', s => { main(s).securityContext.readOnlyRootFilesystem = false; }) },
    { expect: 'host network', pod: copy('host-network', s => { s.hostNetwork = true; }) },
    { expect: 'hostPath volume', pod: copy('host-path', s => { s.volumes = [...s.volumes, { name: 'host', hostPath: { path: '/', type: 'Directory' } }]; }) },
    { expect: 'unconfined seccomp', pod: copy('unconfined', s => { s.securityContext = { ...s.securityContext, seccompProfile: { type: 'Unconfined' } }; }) },
    { expect: 'unsigned image', pod: copy('unsigned', s => { main(s).image = UNSIGNED_IMAGE; }) },
    { expect: 'image outside the allowed list', pod: copy('unlisted-image', s => { main(s).image = 'docker.io/library/busybox:1.37'; }) },
  ];
}

/**
 * True when the answer is a Policy Server that ran out of time or could not be
 * reached, which decides nothing about the pod. Kubewarden words an evaluation
 * past its limit as "exceeded the allowed execution time" or as a refusal
 * "without explanation".
 */
export function noDecision(message: string): boolean {
  return /exceeded the allowed execution time|denied the request without explanation|failed calling webhook|context deadline exceeded/.test(message);
}

function askOnce(pod: Doc): { admitted: boolean; message: string } {
  const r = spawnSync('kubectl', ['create', '--dry-run=server', '-o', 'name', '-f', '-'], { input: stringify(pod), encoding: 'utf8' });
  if (r.error) throw r.error;
  return { admitted: r.status === 0, message: (r.status === 0 ? r.stdout : r.stderr).trim().replace(/\s+/g, ' ') };
}

/** Asks up to three times while the answer is a timeout. `timedOut` stays true when no decision ever came. */
function ask(pod: Doc): { admitted: boolean; message: string; timedOut: boolean } {
  let answer = askOnce(pod);
  for (let attempt = 1; attempt < 3 && !answer.admitted && noDecision(answer.message); attempt++) {
    spawnSync('sleep', ['3']);
    answer = askOnce(pod);
  }
  return { ...answer, timedOut: !answer.admitted && noDecision(answer.message) };
}

export interface AdmissionReport {
  version: 1; source: 'kubewarden'; checkedAt: string; namespace: string;
  kubewarden: { version: string | null; policyServers: { name: string; image: string }[] };
  policies: { name: string; module: string; mode: string; active: boolean }[];
  pods: { name: string; admitted: boolean }[];
  probes: { expect: string; refused: boolean; by: string | null }[];
  ok: boolean;
}

/** `ghcr.io/kubewarden/policy-server:v1.39.0@sha256:...` gives `1.39.0`; an image with no release tag gives null. */
export function kubewardenVersion(image: string): string | null {
  return /:v(\d+\.\d+\.\d+(?:-[0-9A-Za-z.]+)?)(?:@|$)/.exec(image)?.[1] ?? null;
}

/** The policy named in an admission refusal, or null when something else refused the pod. */
export function refusedBy(message: string): string | null {
  return /admission webhook "([^"]+)" denied the request/.exec(message)?.[1] ?? null;
}

/**
 * The record of one preflight run. `ok` needs every policy of the set active and
 * enforcing, every Work pod admitted and, when probes ran, each one refused by
 * an admission policy. A set with no policy in the cluster is never `ok`.
 */
export function buildReport(input: {
  checkedAt: string; namespace: string; policyServers: Doc[]; policies: Doc[];
  pods: { name: string; admitted: boolean }[]; probes: { expect: string; refused: boolean; by: string | null }[];
}): AdmissionReport {
  const policyServers = input.policyServers.map(server => ({ name: String(server.metadata?.name ?? ''), image: String(server.spec?.image ?? '') }));
  const versions = new Set(policyServers.map(server => kubewardenVersion(server.image)));
  const policies = input.policies.map(policy => ({
    name: String(policy.metadata?.name ?? ''), module: String(policy.spec?.module ?? ''),
    mode: String(policy.status?.mode ?? policy.spec?.mode ?? 'unknown'), active: policy.status?.policyStatus === 'active',
  })).sort((a, b) => a.name.localeCompare(b.name));
  return {
    version: 1, source: 'kubewarden', checkedAt: input.checkedAt, namespace: input.namespace,
    kubewarden: { version: versions.size === 1 ? [...versions][0]! : null, policyServers },
    policies, pods: input.pods, probes: input.probes,
    ok: policies.length > 0 && policies.every(policy => policy.active && policy.mode === 'protect')
      && input.pods.length > 0 && input.pods.every(pod => pod.admitted) && input.probes.every(probe => probe.refused && !!probe.by),
  };
}

function list(resource: string, selector?: string): Doc[] {
  const r = spawnSync('kubectl', ['get', resource, ...(selector ? ['-l', selector] : []), '-o', 'json'], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`kubectl get ${resource}: ${r.stderr.trim().replace(/\s+/g, ' ')}`);
  return JSON.parse(r.stdout).items ?? [];
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const namespace = args[args.indexOf('--namespace') + 1];
  if (!args.includes('--namespace') || !namespace) {
    console.error('usage: helm template ... | node scripts/kubewarden-preflight.ts --namespace <namespace> [--probes] [--report <file>]');
    process.exit(2);
  }
  const reportFile = args.includes('--report') ? args[args.indexOf('--report') + 1] : undefined;
  if (args.includes('--report') && (!reportFile || reportFile.startsWith('--'))) { console.error('--report needs a file name'); process.exit(2); }
  const podAnswers: AdmissionReport['pods'] = [], probeAnswers: AdmissionReport['probes'] = [];
  const pods = podsFromRender(readFileSync(0, 'utf8'), namespace);
  if (!pods.length) { console.error('no pod templates in the rendered input'); process.exit(2); }
  let failed = false;
  for (const pod of pods) {
    const answer = ask(pod);
    console.log(`${answer.admitted ? 'ADMITTED' : answer.timedOut ? 'TIMEOUT ' : 'REFUSED '}  ${pod.metadata.name}${answer.admitted ? '' : `: ${answer.message}`}`);
    podAnswers.push({ name: pod.metadata.name, admitted: answer.admitted });
    if (!answer.admitted) failed = true;
  }
  if (args.includes('--probes')) {
    const control = pods.find(pod => pod.metadata.labels['app.kubernetes.io/component'] === 'control-plane');
    if (!control) { console.error('--probes needs the control-plane Deployment in the rendered input'); process.exit(2); }
    for (const probe of probes(control)) {
      const answer = ask(probe.pod);
      // A probe counts only when an admission policy refused it, not for an
      // unrelated reason such as a quota or a missing namespace.
      // A timeout is not a refusal by a rule either.
      const byPolicy = !!refusedBy(answer.message) && !answer.timedOut;
      probeAnswers.push({ expect: probe.expect, refused: !answer.admitted && byPolicy, by: byPolicy ? refusedBy(answer.message) : null });
      console.log(`${answer.admitted ? 'ADMITTED' : answer.timedOut ? 'TIMEOUT ' : byPolicy ? 'REFUSED ' : 'ERROR   '}  probe: ${probe.expect}${answer.admitted ? '' : `: ${answer.message}`}`);
      if (answer.admitted || !byPolicy) failed = true;
    }
  }
  if (reportFile) {
    const report = buildReport({
      checkedAt: new Date().toISOString(), namespace,
      policyServers: list('policyservers.policies.kubewarden.io'),
      policies: list('clusteradmissionpolicies.policies.kubewarden.io', 'app.kubernetes.io/part-of=lolly-work-policy-set'),
      pods: podAnswers, probes: probeAnswers,
    });
    writeFileSync(reportFile, `${JSON.stringify(report, null, 2)}\n`);
    console.log(`REPORT    ${reportFile}: Kubewarden ${report.kubewarden.version ?? '(version not read)'}, ${report.policies.filter(p => p.active).length} of ${report.policies.length} policies active${report.ok ? '' : '; not a clean record'}`);
    if (!report.ok) failed = true;
  }
  process.exit(failed ? 1 : 0);
}
