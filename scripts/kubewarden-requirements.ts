// SPDX-License-Identifier: MPL-2.0
/**
 * What Lolly Work's pods need from an admission policy, derived from the chart.
 *
 *   node scripts/kubewarden-requirements.ts            print the requirements
 *   node scripts/kubewarden-requirements.ts --write    rewrite deploy/kubewarden/lolly-work-requirements.json
 *   node scripts/kubewarden-requirements.ts --check    exit 1 when the committed file is stale
 *
 * Every pod fact comes from `helm template` output: the default install, then one
 * chart option at a time. A component's `default` is what it needs with nothing
 * turned on; each `options` entry lists only the facts that option changes. The
 * render worker's egress comes from its NetworkPolicy and from the address ranges
 * its own code refuses (workers/render/src/egress.ts). The signing identity comes
 * from the release workflow that signs both images. Needs helm on PATH.
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse, parseAllDocuments } from 'yaml';

const root = fileURLToPath(new URL('..', import.meta.url));
const chart = join(root, 'deploy/helm');
export const REQUIREMENTS_FILE = join(root, 'deploy/kubewarden/lolly-work-requirements.json');

/** Rendering pins the Kubernetes version so options gated on it render the same everywhere. */
const KUBE = ['--kube-version', '1.35.0'];
const SECRETS = ['--set', 'secrets.sessionSecret=requirements', '--set', 'secrets.linkSecret=requirements'];
const WORKER = [
  '--set', 'renderWorker.enabled=true', '--set', 'renderWorker.secret=requirements',
  '--set', 'renderWorker.tls.existingSecret=worker-tls', '--set', 'renderWorker.tls.caSecret=worker-ca',
  '--set', 'renderWorker.webBase=https://shell.example.test',
];
const SECCOMP_LOCALHOST = ['--set-json', 'renderWorker.seccompProfile={"type":"Localhost","localhostProfile":"lolly/chromium.json"}'];

interface Variant { values: string[]; args: string[]; withWorker?: boolean }
/** One chart option per entry. A worker option is compared with the worker topology,
 *  so it lists only what it adds to an install that already runs the worker. */
const OPTIONS: Variant[] = [
  { values: ['renderWorker.enabled=true'], args: WORKER },
  { values: ['renderWorker.seccompProfile={type: Localhost, localhostProfile: lolly/chromium.json}'], args: SECCOMP_LOCALHOST, withWorker: true },
  { values: ['renderWorker.appArmorProfile={type: Localhost, localhostProfile: lolly-chromium}'], args: ['--set-json', 'renderWorker.appArmorProfile={"type":"Localhost","localhostProfile":"lolly-chromium"}'], withWorker: true },
  { values: ['renderWorker.userNamespace.enabled=true'], args: ['--set', 'renderWorker.userNamespace.enabled=true'], withWorker: true },
  { values: ['pack.type=emptyDir', 'pack.image=<pack.image>'], args: ['--set', 'pack.type=emptyDir', '--set', 'pack.image=registry.example.test/pack:release'] },
  { values: ['shell.enabled=true', 'shell.type=emptyDir', 'shell.image=<shell.image>'], args: ['--set', 'shell.enabled=true', '--set', 'shell.type=emptyDir', '--set', 'shell.image=registry.example.test/shell:release'] },
  { values: ['pack.type=pvc or existingClaim (shell.type likewise)'], args: ['--set', 'pack.type=pvc'] },
  { values: ['pack.type=hostPath (shell.type likewise; single node only)'], args: ['--set', 'pack.type=hostPath', '--set', 'pack.hostPath=/srv/lolly/pack'] },
  { values: ['serviceAccount.automountServiceAccountToken=true'], args: ['--set', 'serviceAccount.automountServiceAccountToken=true'] },
];

const PLACEHOLDER_IMAGES: Record<string, string> = { 'registry.example.test/pack': '<pack.image>', 'registry.example.test/shell': '<shell.image>' };

type Doc = Record<string, any>;

function render(args: string[]): Doc[] {
  const r = spawnSync('helm', ['template', 'lolly', chart, ...KUBE, ...SECRETS, ...args], { encoding: 'utf8' });
  if (r.error || r.status !== 0) throw new Error(`helm template failed: ${r.error?.message ?? r.stderr}`);
  return parseAllDocuments(r.stdout).map(doc => doc.toJSON()).filter(Boolean);
}

const uniq = <T>(values: T[]): T[] => [...new Set(values.map(v => JSON.stringify(v)))].map(v => JSON.parse(v)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
const repositoryOf = (image: string): string => image.replace(/@sha256:[a-f0-9]{64}$/, '').replace(/:[^/:]+$/, '');
const profileName = (profile?: { type: string; localhostProfile?: string }): string =>
  !profile ? 'unset' : profile.type === 'Localhost' ? `Localhost/${profile.localhostProfile}` : profile.type;

/** The admission-relevant facts of one pod template, over its containers and init containers. */
export function podFacts(spec: Doc): Doc {
  const pod = spec.securityContext ?? {};
  const all: Doc[] = [...(spec.initContainers ?? []), ...spec.containers];
  const effective = (c: Doc, key: string) => c.securityContext?.[key] ?? pod[key];
  return {
    containers: spec.containers.map((c: Doc) => c.name),
    initContainers: (spec.initContainers ?? []).map((c: Doc) => c.name),
    images: uniq(all.map(c => repositoryOf(c.image))),
    runAsNonRoot: all.every(c => effective(c, 'runAsNonRoot') === true),
    runAsUser: uniq(all.map(c => effective(c, 'runAsUser') ?? null)),
    runAsGroup: uniq(all.map(c => effective(c, 'runAsGroup') ?? null)),
    fsGroup: pod.fsGroup ?? null,
    supplementalGroups: pod.supplementalGroups ?? [],
    privileged: all.some(c => c.securityContext?.privileged === true),
    allowPrivilegeEscalation: uniq(all.map(c => c.securityContext?.allowPrivilegeEscalation ?? null)),
    readOnlyRootFilesystem: all.every(c => c.securityContext?.readOnlyRootFilesystem === true),
    capabilities: {
      drop: uniq(all.flatMap(c => c.securityContext?.capabilities?.drop ?? [])),
      add: uniq(all.flatMap(c => c.securityContext?.capabilities?.add ?? [])),
    },
    seccompProfiles: uniq(all.map(c => profileName(c.securityContext?.seccompProfile ?? pod.seccompProfile))),
    appArmorProfiles: uniq(all.map(c => profileName(c.securityContext?.appArmorProfile ?? pod.appArmorProfile))),
    hostNetwork: spec.hostNetwork ?? false,
    hostPID: spec.hostPID ?? false,
    hostIPC: spec.hostIPC ?? false,
    hostPorts: uniq(all.flatMap(c => (c.ports ?? []).map((p: Doc) => p.hostPort).filter((p: unknown) => p !== undefined))),
    // Absent means the pod shares the node's user namespace.
    hostUsers: spec.hostUsers ?? true,
    automountServiceAccountToken: spec.automountServiceAccountToken ?? true,
    volumeTypes: uniq((spec.volumes ?? []).map((v: Doc) => Object.keys(v).find(k => k !== 'name'))),
    containerPorts: uniq(all.flatMap(c => (c.ports ?? []).map((p: Doc) => p.containerPort))),
  };
}

const componentOf = (doc: Doc): string | undefined => doc.spec?.template?.metadata?.labels?.['app.kubernetes.io/component'];
function pods(docs: Doc[]): Map<string, Doc> {
  const out = new Map<string, Doc>();
  for (const doc of docs) {
    if (!['Deployment', 'Job'].includes(doc.kind)) continue;
    const component = componentOf(doc);
    if (!component) throw new Error(`${doc.kind} ${doc.metadata?.name} has no component label`);
    out.set(component, { kind: doc.kind, ...podFacts(doc.spec.template.spec) });
  }
  return out;
}

function changes(base: Doc, next: Doc): Doc {
  const delta: Doc = {};
  for (const key of Object.keys(next)) if (JSON.stringify(base[key]) !== JSON.stringify(next[key])) delta[key] = next[key];
  return delta;
}

/** The address ranges the worker's own code refuses, read from its source. */
export function workerDeniedRanges(): { ipv4: string[]; ipv6: string[] } {
  const source = readFileSync(join(root, 'workers/render/src/egress.ts'), 'utf8');
  const blocks = new Map<string, string[]>();
  for (const match of source.matchAll(/for \(const \[network, prefix\] of \[([\s\S]*?)\] as const\) blocked\.addSubnet\(network, prefix, '(ipv4|ipv6)'\)/g)) {
    blocks.set(match[2]!, [...match[1]!.matchAll(/\['([^']+)', (\d+)\]/g)].map(m => `${m[1]}/${m[2]}`));
  }
  const ipv4 = blocks.get('ipv4'), ipv6 = blocks.get('ipv6');
  if (!ipv4?.length || !ipv6?.length) throw new Error('workers/render/src/egress.ts: blocked address ranges not found');
  return { ipv4, ipv6 };
}

/** Keyless identity both images are signed with, read from the release workflow. */
export function signingIdentity(): { issuer: string; subject: string; subjectPrefix: string; images: string[] } {
  const workflow = readFileSync(join(root, '.github/workflows/release.yml'), 'utf8');
  const sources: string[] = parse(readFileSync(join(chart, 'Chart.yaml'), 'utf8')).sources;
  const repository = sources.find(url => /^https:\/\/github\.com\/[^/]+\/lolly-work$/.test(url));
  if (!repository) throw new Error('Chart.yaml sources must name the lolly-work repository');
  const issuers = new Set([...workflow.matchAll(/--certificate-oidc-issuer (\S+)/g)].map(m => m[1]));
  const identities = new Set([...workflow.matchAll(/--certificate-identity "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/(\.github\/workflows\/[\w.-]+)@refs\/tags\/v\$VERSION"/g)].map(m => m[1]));
  if (issuers.size !== 1 || identities.size !== 1) throw new Error('release.yml must verify every image against one issuer and one workflow identity');
  const owner = new URL(repository).pathname.split('/')[1];
  const images = [...workflow.matchAll(/IMAGE="ghcr\.io\/\$\{GITHUB_REPOSITORY_OWNER\}\/([\w-]+)"/g)].map(m => `ghcr.io/${owner}/${m[1]}`);
  const workflowPath = [...identities][0];
  return {
    issuer: [...issuers][0]!,
    subject: `${repository}/${workflowPath}@refs/tags/v<version>`,
    subjectPrefix: `${repository}/${workflowPath}@refs/tags/`,
    images: uniq(images),
  };
}

export function buildRequirements(): Doc {
  const chartYaml = parse(readFileSync(join(chart, 'Chart.yaml'), 'utf8'));
  const light = pods(render([]));
  const withWorker = pods(render(WORKER));
  const bases = new Map<string, { values: string[]; facts: Doc }>();
  for (const [component, facts] of light) bases.set(component, { values: [], facts });
  for (const [component, facts] of withWorker) if (!bases.has(component)) bases.set(component, { values: ['renderWorker.enabled=true'], facts });

  const components: Doc = {};
  for (const [component, base] of [...bases].sort(([a], [b]) => a.localeCompare(b))) {
    components[component] = { kind: base.facts.kind, enabledBy: base.values, default: { ...base.facts, kind: undefined }, options: [] as Doc[] };
  }
  for (const option of OPTIONS) {
    const reference = option.withWorker ? withWorker : light;
    for (const [component, facts] of pods(render(option.withWorker ? [...WORKER, ...option.args] : option.args))) {
      const entry = components[component];
      if (!entry) throw new Error(`option ${option.values.join(' ')} renders an unknown component ${component}`);
      if (JSON.stringify(entry.enabledBy) === JSON.stringify(option.values)) continue;
      const delta = changes(reference.get(component) ?? bases.get(component)!.facts, facts);
      // The example copy images stand for whatever image the operator names.
      if (delta.images) delta.images = delta.images.map((image: string) => PLACEHOLDER_IMAGES[image] ?? image);
      if (Object.keys(delta).length) entry.options.push({ values: option.values, changes: delta });
    }
  }
  for (const entry of Object.values(components)) delete entry.default.kind;

  const policyDocs = render([...WORKER, '--set', 'networkPolicy.enabled=true']).filter(doc => doc.kind === 'NetworkPolicy');
  const workerPolicy = policyDocs.find(doc => doc.metadata.name.endsWith('-render-worker'));
  const appPolicy = policyDocs.find(doc => !doc.metadata.name.endsWith('-render-worker'));
  if (!workerPolicy || !appPolicy) throw new Error('both NetworkPolicies must render');
  const publicRules = workerPolicy.spec.egress.filter((rule: Doc) => rule.to.some((peer: Doc) => peer.ipBlock));
  const identity = signingIdentity();
  const values = parse(readFileSync(join(chart, 'values.yaml'), 'utf8'));
  const chartImages = [values.image.repository, values.renderWorker.image.repository].sort();
  if (JSON.stringify(chartImages) !== JSON.stringify(identity.images)) throw new Error(`chart images ${chartImages} differ from the signed release images ${identity.images}`);

  return {
    $comment: 'Generated by scripts/kubewarden-requirements.ts from deploy/helm, workers/render/src/egress.ts and .github/workflows/release.yml. Do not edit by hand; run it with --write.',
    chart: { name: chartYaml.name, version: chartYaml.version, appVersion: chartYaml.appVersion },
    components,
    network: {
      'control-plane': {
        ingress: appPolicy.spec.ingress.flatMap((rule: Doc) => rule.ports),
        egress: values.networkPolicy.allowAllEgress ? 'unrestricted (networkPolicy.allowAllEgress: true)' : 'operator rules',
      },
      'render-worker': {
        ingress: workerPolicy.spec.ingress.map((rule: Doc) => ({ fromComponent: rule.from[0].podSelector.matchLabels['app.kubernetes.io/component'], ports: rule.ports })),
        egressDns: workerPolicy.spec.egress.find((rule: Doc) => rule.ports.some((p: Doc) => p.port === 53)).ports,
        egressPublic: {
          ports: publicRules.flatMap((rule: Doc) => rule.ports),
          ipv4Except: publicRules[0].to.find((peer: Doc) => peer.ipBlock?.cidr === '0.0.0.0/0').ipBlock.except,
          ipv6Except: publicRules[0].to.find((peer: Doc) => peer.ipBlock?.cidr === '::/0').ipBlock.except,
        },
        deniedInCode: workerDeniedRanges(),
      },
    },
    images: {
      signed: identity.images.map(repository => ({
        repository,
        signature: { kind: 'sigstore-keyless', issuer: identity.issuer, subject: identity.subject, subjectPrefix: identity.subjectPrefix },
      })),
      operatorSupplied: ['pack.image', 'shell.image'],
    },
  };
}

const serialise = (requirements: Doc): string => `${JSON.stringify(requirements, null, 2)}\n`;

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const text = serialise(buildRequirements());
  if (process.argv.includes('--write')) {
    writeFileSync(REQUIREMENTS_FILE, text);
  } else if (process.argv.includes('--check')) {
    if (readFileSync(REQUIREMENTS_FILE, 'utf8') !== text) {
      console.error('deploy/kubewarden/lolly-work-requirements.json is stale: run node scripts/kubewarden-requirements.ts --write and review the Kubewarden policies');
      process.exit(1);
    }
  } else {
    process.stdout.write(text);
  }
}

export { serialise };
