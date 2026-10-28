// SPDX-License-Identifier: MPL-2.0
/**
 * Ask the cluster's admission chain about Work's pods before installing them.
 *
 *   helm template lolly-work deploy/helm -n lolly-work -f my-values.yaml \
 *     | node scripts/kubewarden-preflight.ts --namespace lolly-work [--probes]
 *
 * Each pod template in the rendered chart (Deployments and the migration Job) is
 * sent as a Pod with `kubectl create --dry-run=server`, so every validating and
 * mutating webhook answers and nothing is created. With --probes it also sends
 * copies of the control-plane pod that each break one requirement in
 * deploy/kubewarden/lolly-work-requirements.json, plus an unsigned and an
 * unlisted image; the policy set must refuse every one. Exit status 1 means a
 * Work pod was refused or a probe was admitted. Needs kubectl and a kubeconfig.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
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

function ask(pod: Doc): { admitted: boolean; message: string } {
  const r = spawnSync('kubectl', ['create', '--dry-run=server', '-o', 'name', '-f', '-'], { input: stringify(pod), encoding: 'utf8' });
  if (r.error) throw r.error;
  return { admitted: r.status === 0, message: (r.status === 0 ? r.stdout : r.stderr).trim().replace(/\s+/g, ' ') };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  const namespace = args[args.indexOf('--namespace') + 1];
  if (!args.includes('--namespace') || !namespace) {
    console.error('usage: helm template ... | node scripts/kubewarden-preflight.ts --namespace <namespace> [--probes]');
    process.exit(2);
  }
  const pods = podsFromRender(readFileSync(0, 'utf8'), namespace);
  if (!pods.length) { console.error('no pod templates in the rendered input'); process.exit(2); }
  let failed = false;
  for (const pod of pods) {
    const answer = ask(pod);
    console.log(`${answer.admitted ? 'ADMITTED' : 'REFUSED '}  ${pod.metadata.name}${answer.admitted ? '' : `: ${answer.message}`}`);
    if (!answer.admitted) failed = true;
  }
  if (args.includes('--probes')) {
    const control = pods.find(pod => pod.metadata.labels['app.kubernetes.io/component'] === 'control-plane');
    if (!control) { console.error('--probes needs the control-plane Deployment in the rendered input'); process.exit(2); }
    for (const probe of probes(control)) {
      const answer = ask(probe.pod);
      // A probe counts only when an admission policy refused it, not for an
      // unrelated reason such as a quota or a missing namespace.
      const byPolicy = /admission webhook "[^"]+" denied the request/.test(answer.message);
      console.log(`${answer.admitted ? 'ADMITTED' : byPolicy ? 'REFUSED ' : 'ERROR   '}  probe: ${probe.expect}${answer.admitted ? '' : `: ${answer.message}`}`);
      if (answer.admitted || !byPolicy) failed = true;
    }
  }
  process.exit(failed ? 1 : 0);
}
