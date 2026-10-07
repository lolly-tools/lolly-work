import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bootstrap = join(root, 'deploy/suse/k3s-bootstrap.sh');
const qualify = join(root, 'deploy/suse/k3s-qualify.sh');
const lock = JSON.parse(readFileSync(join(root, 'deploy/suse/k3s.lock.json'), 'utf8'));

function first<T>(items: T[]): T {
  const item = items[0];
  assert.ok(item, 'expected fixture item');
  return item;
}

function bash(code: string, args: string[] = [], env: Record<string, string> = {}) {
  return spawnSync('bash', ['-c', code, 'test', ...args], {
    encoding: 'utf8',
    env: { ...process.env, K3S_TEST_BOOTSTRAP: bootstrap, K3S_TEST_QUALIFY: qualify, ...env },
  });
}

function sandbox(run: (dir: string) => void) {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-k3s-test-'));
  try {
    run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

test('release lock fixes the chart minor, immutable installer commit and official binary', () => {
  assert.equal(lock.version, 'v1.34.12+k3s1');
  assert.equal(lock.architecture, 'amd64');
  assert.equal(lock.kubernetesMinor, '1.34');
  assert.match(lock.binary.url, /^https:\/\/github\.com\/k3s-io\/k3s\/releases\/download\//);
  assert.ok(lock.installer.url.includes(lock.releaseCommit));
  for (const item of [lock.binary, lock.installer]) assert.match(item.sha256, /^[a-f0-9]{64}$/);
  const result = bash('source "$K3S_TEST_BOOTSTRAP"; read_release_lock');
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(lock.binary.sha256));
});

test('configuration preserves pod API routing while encryption and disabled ingress are explicit', () => {
  const result = bash(
    '"$K3S_TEST_BOOTSTRAP" config --provider evroc --node-ip 192.168.20.2 --candidate-host rehearsal',
  );
  assert.equal(result.status, 0, result.stderr);
  const config = JSON.parse(result.stdout);
  assert.equal(config['bind-address'], '0.0.0.0');
  assert.equal(config['advertise-address'], '192.168.20.2');
  assert.equal(config['secrets-encryption'], true);
  assert.equal(config['write-kubeconfig-mode'], '0600');
  assert.equal(config['cluster-init'], true);
  assert.deepEqual(config.disable, ['traefik', 'servicelb']);
  assert.equal(config['etcd-snapshot-retention'], 8);
});

for (const address of [
  '1.2.3.4',
  '127.0.0.1',
  '10.42.0.3',
  '10.43.0.3',
  '$(touch /tmp/lolly-k3s-invalid)',
  '::1',
]) {
  test(`configuration refuses unsupported or overlapping node address ${address}`, () => {
    const result = bash('source "$K3S_TEST_BOOTSTRAP"; emit_config "$1" rehearsal', [address]);
    assert.notEqual(result.status, 0);
  });
}

test('no-argument invocation fails closed before any downloads or host changes', () => {
  const result = bash('"$K3S_TEST_BOOTSTRAP"');
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('provider must be'));
});

test('host inspection refuses adopting an existing Compose or cluster owner', () => {
  for (const unit of ['docker.service', 'caddy.service', 'k3s.service', 'rke2-server.service']) {
    const result = bash('source "$K3S_TEST_BOOTSTRAP"; validate_existing_units "$1"', [`${unit} enabled`]);
    assert.notEqual(result.status, 0);
  }
  assert.equal(
    bash('source "$K3S_TEST_BOOTSTRAP"; validate_existing_units "sshd.service enabled"').status,
    0,
  );
});

function policyScaffold() {
  return {
    path: '/var/lib/rancher/k3s',
    canonical: '/var/lib/rancher/k3s',
    entries: [
      '',
      'agent',
      'agent/containerd',
      'agent/containerd/io.containerd.snapshotter.v1.overlayfs',
      'agent/containerd/io.containerd.snapshotter.v1.overlayfs/snapshots',
      'data',
    ].map((relative) => ({ relative, type: 'directory', uid: 0, mode: 0o755 })),
  };
}

test('SUSE policy may prepare only its exact empty root-owned directory scaffold', () => {
  const result = bash('source "$K3S_TEST_BOOTSTRAP"; validate_policy_scaffold_entries "$1"', [
    JSON.stringify(policyScaffold()),
  ]);
  assert.equal(result.status, 0, result.stderr);
});

const invalidScaffolds: Record<string, (fixture: ReturnType<typeof policyScaffold>) => void> = {
  'initialized file': (f) => {
    f.entries.push({ relative: 'data/cluster.db', type: 'other', uid: 0, mode: 0o600 });
  },
  symlink: (f) => {
    first(f.entries).type = 'other';
  },
  'symlink parent': (f) => {
    f.canonical = '/srv/shared-k3s';
  },
  'wrong owner': (f) => {
    first(f.entries).uid = 1000;
  },
  'writable directory': (f) => {
    first(f.entries).mode = 0o777;
  },
  'unexpected directory': (f) => {
    f.entries.push({ relative: 'server', type: 'directory', uid: 0, mode: 0o700 });
  },
};
for (const [name, change] of Object.entries(invalidScaffolds))
  test(`policy scaffold refuses ${name}`, () => {
    const fixture = policyScaffold();
    change(fixture);
    assert.notEqual(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_policy_scaffold_entries "$1"', [JSON.stringify(fixture)])
        .status,
      0,
    );
  });

test('data path exception refuses a missing policy RPM before reading the filesystem', () => {
  const result = bash(
    'source "$K3S_TEST_BOOTSTRAP"; rpm() { return 1; }; validate_policy_scaffold /var/lib/rancher/k3s',
  );
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('installed SUSE k3s-selinux'));
});

test('data path exception refuses an unrelated policy RPM vendor', () => {
  const result = bash(
    'source "$K3S_TEST_BOOTSTRAP"; rpm() { if [[ "$*" == "-q k3s-selinux" ]]; then return 0; fi; printf "%s" "Other vendor"; }; validate_policy_scaffold /var/lib/rancher/k3s',
  );
  assert.notEqual(result.status, 0);
  assert.ok(result.stderr.includes('reviewed SUSE policy RPM'));
});

test('caller Python optimization cannot disable configuration safety checks', () => {
  const result = bash('source "$K3S_TEST_BOOTSTRAP"; emit_config 1.2.3.4 rehearsal', [], {
    PYTHONOPTIMIZE: '2',
  });
  assert.notEqual(result.status, 0);
});

test('verified installer receives no caller token/proxy and never starts/enables the service', () => {
  const result = bash(
    'source "$K3S_TEST_BOOTSTRAP"; env() { printf "%s\\n" "$@"; }; run_verified_installer "$1" /private/pinned-install.sh',
    [lock.version],
    {
      K3S_TOKEN: 'caller-token-sentinel',
      HTTP_PROXY: 'caller-proxy-sentinel',
    },
  );
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.startsWith('-i\n'));
  for (const setting of [
    'INSTALL_K3S_SKIP_DOWNLOAD=true',
    'INSTALL_K3S_SKIP_SELINUX_RPM=true',
    'INSTALL_K3S_SKIP_START=true',
    'INSTALL_K3S_SKIP_ENABLE=true',
  ])
    assert.ok(result.stdout.includes(setting));
  assert.ok(!result.stdout.includes('sentinel'));
});

function firewall(dir: string, mode: string) {
  const file = join(dir, 'firewall-cmd');
  writeFileSync(
    file,
    `#!${process.execPath}\nconst a=process.argv.slice(2).join(' ');const mode=${JSON.stringify(mode)};let v='';let status=0;
if(mode==='command-error')process.exit(2);
if(a.includes('--state'))v='running';
else if(a.includes('--get-zone-of-interface'))v='public';
else if(a.includes('--get-active-zones'))v='public\\n  interfaces: ens3\\ntrusted\\n  sources: 10.42.0.0/16 10.43.0.0/16';
else if(a.includes('--get-target')){if(!a.includes('--permanent'))process.exit(2);v=mode==='accept'?'ACCEPT':mode==='unknown-target'?'unexpected':mode==='target-mismatch'||mode==='drop'?'DROP':mode==='reject'?'REJECT':'default';}
else if(a.includes('--list-all'))v=mode==='missing-target'?'public':mode==='duplicate-target'?'public\\n  target: default\\n  target: default':'public\\n  target: '+(mode==='accept'?'ACCEPT':mode==='unknown-target'?'unexpected':mode==='drop'?'DROP':mode==='reject'?'REJECT':'default');
else if(a.includes('--list-rich-rules'))v=mode==='rich'?'rule family=ipv4 accept':'';
else if(a.includes('--list-forward-ports'))v=mode==='forward'?'port=8443:proto=tcp:toport=6443':'';
else if(a.includes('--list-interfaces'))v=mode==='trusted-interface'?'ens3':'';
else if(a.includes('--list-sources'))v=mode==='global-source'?'0.0.0.0/0 10.42.0.0/16 10.43.0.0/16':'10.42.0.0/16 10.43.0.0/16';
else if(a.includes('--list-services'))v='ssh http https';
else if(a.includes('--list-ports'))v=mode==='node-port'?'30000-32767/tcp':mode==='permanent-api'&&a.includes('--permanent')?'6443/tcp':mode==='http3'?'443/udp':mode==='vpn'?'8472/udp':'';
else if(a.includes('--query-source'))status=mode==='pod-closed'?1:0;
else if(a.includes('--query-port'))status=mode==='query-error'?2:mode==='api'&&a.includes('6443')?0:1;
else status=2;
if(v)console.log(v);process.exit(status);\n`,
  );
  chmodSync(file, 0o700);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test('qualification commands use the verified binary independently of the sudo path', () => {
  const source = readFileSync(qualify, 'utf8');
  assert.ok(source.includes('verify_file /usr/local/bin/k3s "$binary_sha"'));
  assert.ok(source.includes('encryption_status=$(/usr/local/bin/k3s secrets-encrypt status)'));
  assert.ok(
    source.includes(
      'local kube=(/usr/local/bin/k3s kubectl --kubeconfig "$kubeconfig" --context "$context")',
    ),
  );
  assert.ok(!source.includes('encryption_status=$(k3s '));
  assert.ok(!source.includes('local kube=(kubectl '));
});

function selinux(dir: string, mode: string) {
  const log = join(dir, 'selinux-calls.jsonl');
  for (const tool of ['rpm', 'semodule', 'matchpathcon', 'restorecon', 'getenforce']) {
    const file = join(dir, tool);
    writeFileSync(
      file,
      `#!${process.execPath}\nconst fs=require('node:fs');const a=process.argv.slice(2);const tool=${JSON.stringify(tool)};const mode=${JSON.stringify(mode)};
fs.appendFileSync(${JSON.stringify(log)},JSON.stringify({tool,args:a})+'\\n');
if(tool==='rpm')process.exit(mode==='modified-rpm'?1:0);
if(tool==='semodule'){if(mode==='module-query-error')process.exit(2);console.log(mode==='missing-module'?'200 container pp':'200 container pp\\n200 k3s pp');}
if(tool==='matchpathcon'){if(mode==='context-query-error')process.exit(2);if(a.includes('-V'))process.exit(mode==='readback-failure'?1:0);console.log('system_u:object_r:'+(mode==='wrong-context'?'var_lib_t':a.some(x=>x.endsWith('/snapshots'))?'container_file_t':'container_runtime_exec_t')+':s0');}
if(tool==='restorecon')process.exit(mode==='restore-failure'?1:0);
if(tool==='getenforce')console.log(mode==='permissive'?'Permissive':'Enforcing');\n`,
    );
    chmodSync(file, 0o700);
  }
  return { PATH: `${dir}:${process.env.PATH}` };
}

test('enforcing staging verifies the loaded package policy and applies only its exact paths', () =>
  sandbox((dir) => {
    const result = bash('source "$K3S_TEST_BOOTSTRAP"; label_installed_selinux', [], selinux(dir, 'safe'));
    assert.equal(result.status, 0, result.stderr);
    const calls = readFileSync(join(dir, 'selinux-calls.jsonl'), 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as { tool: string; args: string[] });
    const restore = calls.find((call) => call.tool === 'restorecon');
    assert.ok(restore);
    assert.deepEqual(restore.args, [
      '-R',
      '/usr/local/bin/k3s',
      '/etc/systemd/system/k3s.service',
      '/var/lib/rancher/k3s',
    ]);
    assert.ok(calls.some((call) => call.tool === 'matchpathcon' && call.args.includes('-V')));
    const source = readFileSync(bootstrap, 'utf8');
    assert.ok(
      source.indexOf('run_verified_installer "$version"') < source.indexOf('then label_installed_selinux'),
    );
  }));

for (const mode of [
  'modified-rpm',
  'missing-module',
  'module-query-error',
  'context-query-error',
  'wrong-context',
  'restore-failure',
  'readback-failure',
  'permissive',
])
  test(`enforcing staging refuses ${mode}`, () =>
    sandbox((dir) => {
      const result = bash('source "$K3S_TEST_BOOTSTRAP"; label_installed_selinux', [], selinux(dir, mode));
      assert.notEqual(result.status, 0);
    }));

for (const mode of ['safe', 'http3', 'drop', 'reject'])
  test(`restricted firewall keeps pod/service paths in ${mode} profile`, () =>
    sandbox((dir) => {
      const result = bash('source "$K3S_TEST_BOOTSTRAP"; validate_network ens3', [], firewall(dir, mode));
      assert.equal(result.status, 0, result.stderr);
    }));

for (const mode of [
  'accept',
  'missing-target',
  'duplicate-target',
  'target-mismatch',
  'unknown-target',
  'rich',
  'forward',
  'trusted-interface',
  'global-source',
  'node-port',
  'api',
  'permanent-api',
  'pod-closed',
  'command-error',
  'query-error',
  'vpn',
]) {
  test(`firewall guard refuses ${mode}`, () =>
    sandbox((dir) => {
      const result = bash('source "$K3S_TEST_BOOTSTRAP"; validate_network ens3', [], firewall(dir, mode));
      assert.notEqual(result.status, 0);
    }));
}

function providerReview(dir: string, change: Record<string, unknown> = {}) {
  const file = join(dir, 'provider-review.json');
  writeFileSync(
    file,
    JSON.stringify({
      provider: 'upcloud',
      controlPlanePublic: false,
      nodePortsPublic: false,
      dualStackReviewed: true,
      publicUdpPorts: [],
      publicTcpPorts: [22, 80, 443],
      sshSourceCidrs: ['203.0.113.9/32'],
      statelessFirewall: true,
      hostConnectionTrackingRequired: true,
      kernelEphemeralPortRange: { start: 32768, end: 60999 },
      statelessReturnRules: [
        {
          family: 'IPv4',
          protocol: 'tcp',
          sourcePort: 443,
          sourceCidrs: ['0.0.0.0/0'],
          destinationPortRange: { start: 32768, end: 60999 },
        },
        {
          family: 'IPv4',
          protocol: 'tcp',
          sourcePort: 53,
          sourceCidrs: ['94.237.127.9/32'],
          destinationPortRange: { start: 32768, end: 60999 },
        },
        {
          family: 'IPv4',
          protocol: 'udp',
          sourcePort: 53,
          sourceCidrs: ['94.237.127.9/32'],
          destinationPortRange: { start: 32768, end: 60999 },
        },
      ],
      reviewedAt: new Date().toISOString(),
      reviewedRulesSha256: 'a'.repeat(64),
      ...change,
    }),
    { mode: 0o600 },
  );
  return file;
}

test('provider review must be current, private and restricted', () =>
  sandbox((dir) => {
    const file = providerReview(dir);
    assert.equal(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" upcloud', [file]).status,
      0,
    );
    for (const change of [
      { controlPlanePublic: true },
      { dualStackReviewed: false },
      { publicTcpPorts: [22, 6443] },
      { publicUdpPorts: [8472] },
      { sshSourceCidrs: ['0.0.0.0/0'] },
      { reviewedAt: '2020-01-01T00:00:00Z' },
      { statelessFirewall: false },
      { hostConnectionTrackingRequired: false },
      { statelessReturnRules: [] },
      { kernelEphemeralPortRange: { start: 30000, end: 60999 } },
    ]) {
      providerReview(dir, change);
      assert.notEqual(
        bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" upcloud', [file]).status,
        0,
      );
    }
    providerReview(dir);
    chmodSync(file, 0o644);
    assert.notEqual(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" upcloud', [file]).status,
      0,
    );
  }));

test('UpCloud return review matches actual kernel ports and refuses broad resolver peers', () =>
  sandbox((dir) => {
    const file = providerReview(dir);
    assert.equal(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_ephemeral_range "$1" "32768 60999"', [file]).status,
      0,
    );
    assert.notEqual(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_ephemeral_range "$1" "49152 65535"', [file]).status,
      0,
    );
    const record = JSON.parse(readFileSync(file, 'utf8'));
    record.statelessReturnRules[1].sourceCidrs = ['0.0.0.0/0'];
    writeFileSync(file, JSON.stringify(record));
    assert.notEqual(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" upcloud', [file]).status,
      0,
    );
  }));

test('stateful Evroc provider review does not assume UpCloud return semantics', () =>
  sandbox((dir) => {
    const file = providerReview(dir, {
      provider: 'evroc',
      statelessFirewall: false,
      statelessReturnRules: [],
    });
    assert.equal(bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" evroc', [file]).status, 0);
  }));

test('provider permits reviewed optional HTTP3 while control-plane UDP stays closed', () =>
  sandbox((dir) => {
    const file = providerReview(dir, { publicUdpPorts: [443] });
    assert.equal(
      bash('source "$K3S_TEST_BOOTSTRAP"; validate_provider_review "$1" upcloud', [file]).status,
      0,
    );
  }));

function edgeFixture() {
  const image = `registry.example/edge@sha256:${'b'.repeat(64)}`;
  const review = {
    namespace: 'edge',
    reviewedAt: new Date().toISOString(),
    hostNetworkDirectPorts: true,
    nodeName: 'candidate',
    nodePrivateIp: '10.4.27.58',
    workTrustedProxyPeer: '10.4.27.58',
    podName: 'edge-pod',
    containerName: 'edge',
    serviceAccountName: 'edge',
    image,
    publicContentHostPaths: [] as Array<{ path: string; type: string; mountPath: string; readOnly: boolean }>,
    secretRefs: ['edge-tls'],
  };
  const pod = {
    metadata: { name: 'edge-pod' },
    spec: {
      nodeName: 'candidate',
      hostNetwork: true,
      dnsPolicy: 'ClusterFirstWithHostNet',
      hostPID: false,
      hostIPC: false,
      shareProcessNamespace: false,
      securityContext: { sysctls: [] as Array<{ name: string; value: string }> },
      serviceAccountName: 'edge',
      automountServiceAccountToken: false,
      initContainers: [] as Array<{ name: string }>,
      ephemeralContainers: [] as Array<{ name: string }>,
      volumes: [] as Array<{
        name: string;
        hostPath?: { path: string; type: string };
        projected?: { sources: Array<{ serviceAccountToken: object }> };
      }>,
      containers: [
        {
          name: 'edge',
          image,
          securityContext: {
            runAsNonRoot: true,
            runAsUser: 1000,
            allowPrivilegeEscalation: false,
            privileged: false,
            readOnlyRootFilesystem: true,
            procMount: 'Default',
            seccompProfile: { type: 'RuntimeDefault' },
            capabilities: { drop: ['ALL'], add: ['NET_BIND_SERVICE'] },
          },
          ports: [
            { protocol: 'TCP', containerPort: 80 },
            { protocol: 'TCP', containerPort: 443 },
            { protocol: 'UDP', containerPort: 443 },
          ],
          env: [] as Array<{ name: string; value: string }>,
          volumeMounts: [] as Array<{ name: string; mountPath: string; readOnly: boolean }>,
        },
      ],
    },
    status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
  };
  const data = {
    'edge-namespace': {
      metadata: {
        name: 'edge',
        labels: {
          'pod-security.kubernetes.io/enforce': 'privileged',
          'pod-security.kubernetes.io/enforce-version': 'v1.34',
          'pod-security.kubernetes.io/audit': 'restricted',
          'pod-security.kubernetes.io/audit-version': 'v1.34',
          'pod-security.kubernetes.io/warn': 'restricted',
          'pod-security.kubernetes.io/warn-version': 'v1.34',
        },
      },
    },
    'edge-pods': { items: [pod] },
    'edge-services': { items: [] as Array<{ spec: { type: string } }> },
    'edge-accounts': { items: [{ metadata: { name: 'edge' }, automountServiceAccountToken: false }] },
    'edge-rolebindings': { items: [] as Array<object> },
    'edge-clusterrolebindings': {
      items: [] as Array<{ subjects: Array<{ kind: string; namespace?: string; name: string }> }>,
    },
    'edge-node': {
      metadata: { name: 'candidate' },
      status: { addresses: [{ type: 'InternalIP', address: '10.4.27.58' }] },
    },
  };
  return { data, review, pod, container: first(pod.spec.containers) };
}

function validateEdgeFixture(dir: string, fixture: ReturnType<typeof edgeFixture>) {
  for (const [name, value] of Object.entries(fixture.data))
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  writeFileSync(join(dir, 'edge-review.json'), JSON.stringify(fixture.review), { mode: 0o600 });
  return bash('source "$K3S_TEST_QUALIFY"; validate_edge_files "$1" work public edge "$1/edge-review.json"', [
    dir,
  ]);
}

test('separate edge exception verifies the exact non-root host listener and fixed private peer', () =>
  sandbox((dir) => {
    const result = validateEdgeFixture(dir, edgeFixture());
    assert.equal(result.status, 0, result.stderr);
    const summary = JSON.parse(readFileSync(join(dir, 'edge-summary.json'), 'utf8'));
    assert.equal(summary.workTrustedProxyPeer, '10.4.27.58');
    assert.equal(summary.networkPolicyApplies, false);
    assert.ok(summary.remainingAcceptance.length >= 3);
  }));

const invalidEdges: Record<string, (fixture: ReturnType<typeof edgeFixture>) => void> = {
  'missing acknowledgement': (f) => {
    f.review.hostNetworkDirectPorts = false;
  },
  'stale review': (f) => {
    f.review.reviewedAt = '2020-01-01T00:00:00Z';
  },
  'broad pod trust': (f) => {
    f.review.workTrustedProxyPeer = '10.42.0.0/16';
  },
  'wrong node peer': (f) => {
    first(f.data['edge-node'].status.addresses).address = '10.4.27.59';
  },
  'wrong node': (f) => {
    f.pod.spec.nodeName = 'production';
  },
  'missing PSA audit': (f) => {
    f.data['edge-namespace'].metadata.labels['pod-security.kubernetes.io/audit'] = 'privileged';
  },
  'second pod': (f) => {
    f.data['edge-pods'].items.push(structuredClone(f.pod));
  },
  root: (f) => {
    f.container.securityContext.runAsUser = 0;
  },
  'extra capability': (f) => {
    f.container.securityContext.capabilities.add.push('SYS_ADMIN');
  },
  'privileged container': (f) => {
    f.container.securityContext.privileged = true;
  },
  'writable root': (f) => {
    f.container.securityContext.readOnlyRootFilesystem = false;
  },
  'wrong seccomp': (f) => {
    f.container.securityContext.seccompProfile.type = 'Unconfined';
  },
  'host process access': (f) => {
    f.pod.spec.hostPID = true;
  },
  'process security override': (f) => {
    f.container.securityContext.procMount = 'Unmasked';
  },
  'sysctl override': (f) => {
    f.pod.spec.securityContext.sysctls.push({ name: 'net.ipv4.ip_forward', value: '1' });
  },
  'extra init container': (f) => {
    f.pod.spec.initContainers.push({ name: 'root-copy' });
  },
  'service account token': (f) => {
    f.pod.spec.automountServiceAccountToken = true;
  },
  'projected token': (f) => {
    f.pod.spec.volumes.push({ name: 'token', projected: { sources: [{ serviceAccountToken: {} }] } });
  },
  'role binding': (f) => {
    f.data['edge-rolebindings'].items.push({});
  },
  'cluster role binding': (f) => {
    f.data['edge-clusterrolebindings'].items.push({
      subjects: [{ kind: 'ServiceAccount', namespace: 'edge', name: 'edge' }],
    });
  },
  'service account group binding': (f) => {
    f.data['edge-clusterrolebindings'].items.push({
      subjects: [{ kind: 'Group', name: 'system:serviceaccounts' }],
    });
  },
  'additional host port': (f) => {
    f.container.ports.push({ protocol: 'TCP', containerPort: 6443 });
  },
  NodePort: (f) => {
    f.data['edge-services'].items.push({ spec: { type: 'NodePort' } });
  },
  'inline credential': (f) => {
    f.container.env.push({ name: 'LW_SESSION_SECRET', value: 'edge-credential-sentinel' });
  },
  'sensitive host path': (f) => {
    f.pod.spec.volumes.push({ name: 'private', hostPath: { path: '/etc/rancher', type: 'Directory' } });
  },
  unready: (f) => {
    first(f.pod.status.conditions).status = 'False';
  },
};
for (const [name, change] of Object.entries(invalidEdges))
  test(`edge qualification refuses ${name}`, () =>
    sandbox((dir) => {
      const fixture = edgeFixture();
      change(fixture);
      const result = validateEdgeFixture(dir, fixture);
      assert.notEqual(result.status, 0);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('edge-credential-sentinel'));
    }));

type Namespace = 'work' | 'public';
type Peer = {
  namespaceSelector?: { matchLabels: Record<string, string> };
  podSelector?: Record<string, string>;
  ipBlock?: { cidr: string; except?: string[] };
};
type Pod = {
  metadata: { name: string };
  spec: {
    serviceAccountName: string;
    containers: Array<{
      name: string;
      image: string;
      securityContext: {
        runAsNonRoot: boolean;
        allowPrivilegeEscalation: boolean;
        capabilities: { drop: string[] };
      };
      env: Array<{
        name: string;
        value?: string;
        valueFrom?: { secretKeyRef: { name: string; key: string } };
      }>;
    }>;
    volumes?: Array<{ hostPath: { path: string } }>;
  };
  status: { phase: string; conditions: Array<{ type: string; status: string }> };
};
type Fixture = {
  version: { serverVersion: { gitVersion: string } };
  namespaces: { items: Array<{ metadata: { name: string; labels: Record<string, string> } }> };
  images: Record<Namespace, { images: string[]; secretRefs: string[] }>;
} & Record<
  `${Namespace}-accounts`,
  { items: Array<{ metadata: { name: string }; automountServiceAccountToken: boolean }> }
> &
  Record<`${Namespace}-services`, { items: Array<{ spec: { type: string } }> }> &
  Record<`${Namespace}-pods`, { items: Pod[] }> &
  Record<
    `${Namespace}-policies`,
    {
      items: Array<{
        spec: {
          podSelector: Record<string, string>;
          policyTypes: string[];
          egress?: Array<{ to?: Peer[]; ports?: Array<{ port: number; protocol: string }> }>;
        };
      }>;
    }
  >;
function clusterFixture(): Fixture {
  const digest = `registry.example/lolly@sha256:${'a'.repeat(64)}`;
  const data: Partial<Fixture> = {
    version: { serverVersion: { gitVersion: lock.version } },
    namespaces: {
      items: ['work', 'public'].map((name) => ({
        metadata: {
          name,
          labels: {
            'pod-security.kubernetes.io/enforce': 'restricted',
            'pod-security.kubernetes.io/enforce-version': 'v1.34',
          },
        },
      })),
    },
  };
  for (const ns of ['work', 'public'] as const) {
    data[`${ns}-accounts`] = { items: [{ metadata: { name: 'app' }, automountServiceAccountToken: false }] };
    data[`${ns}-policies`] = {
      items: [
        { spec: { podSelector: {}, policyTypes: ['Ingress', 'Egress'] } },
        {
          spec: {
            podSelector: {},
            policyTypes: ['Egress'],
            egress: [
              {
                to: [
                  { namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'kube-system' } } },
                ],
                ports: [
                  { port: 53, protocol: 'TCP' },
                  { port: 53, protocol: 'UDP' },
                ],
              },
            ],
          },
        },
      ],
    };
    data[`${ns}-services`] = { items: [{ spec: { type: 'ClusterIP' } }] };
    data[`${ns}-pods`] = {
      items: [
        {
          metadata: { name: `${ns}-pod` },
          spec: {
            serviceAccountName: 'app',
            containers: [
              {
                name: 'server',
                image: digest,
                securityContext: {
                  runAsNonRoot: true,
                  allowPrivilegeEscalation: false,
                  capabilities: { drop: ['ALL'] },
                },
                env: [
                  {
                    name: 'LW_SESSION_SECRET',
                    valueFrom: { secretKeyRef: { name: `${ns}-secret`, key: 'session' } },
                  },
                ],
              },
            ],
          },
          status: { phase: 'Running', conditions: [{ type: 'Ready', status: 'True' }] },
        },
      ],
    };
  }
  data.images = {
    work: { images: [digest], secretRefs: ['work-secret'] },
    public: { images: [digest], secretRefs: ['public-secret'] },
  };
  return data as Fixture;
}

function validateFixture(dir: string, data: Fixture) {
  for (const [name, value] of Object.entries(data))
    writeFileSync(join(dir, `${name}.json`), JSON.stringify(value), { mode: 0o600 });
  return bash(
    'source "$K3S_TEST_QUALIFY"; validate_cluster_files "$1" work public work-pod "$1/images.json" "$2" "$1/result.json"',
    [dir, lock.version],
  );
}

test('cluster checks pass bounded fixtures while explicitly refusing to claim promotion readiness', () =>
  sandbox((dir) => {
    const result = validateFixture(dir, clusterFixture());
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(readFileSync(join(dir, 'result.json'), 'utf8'));
    assert.equal(report.promotionReady, false);
    assert.ok(report.remainingAcceptance.length >= 5);
    assert.equal(statSync(join(dir, 'result.json')).mode & 0o777, 0o600);
  }));

test('qualification receipt never overwrites existing evidence', () =>
  sandbox((dir) => {
    writeFileSync(join(dir, 'result.json'), 'retained evidence');
    const result = validateFixture(dir, clusterFixture());
    assert.notEqual(result.status, 0);
    assert.equal(readFileSync(join(dir, 'result.json'), 'utf8'), 'retained evidence');
  }));

const invalidFixtures: Record<string, (data: Fixture) => void> = {
  'floating image': (d) => {
    first(first(d['work-pods'].items).spec.containers).image = 'registry.example/lolly:latest';
  },
  'inline credential': (d) => {
    first(first(d['work-pods'].items).spec.containers).env = [
      { name: 'DATABASE_URL', value: 'credential-sentinel' },
    ];
  },
  'cross-role secret': (d) => {
    first(first(d['public-pods'].items).spec.containers).env = [
      { name: 'LW_SESSION_SECRET', valueFrom: { secretKeyRef: { name: 'work-secret', key: 'session' } } },
    ];
  },
  'service-account token': (d) => {
    first(d['work-accounts'].items).automountServiceAccountToken = true;
  },
  'public NodePort': (d) => {
    first(d['public-services'].items).spec.type = 'NodePort';
  },
  'missing default deny': (d) => {
    d['public-policies'].items.shift();
  },
  'missing DNS egress': (d) => {
    d['work-policies'].items.pop();
  },
  'deny undone by wildcard egress': (d) => {
    d['work-policies'].items.push({ spec: { podSelector: {}, policyTypes: ['Egress'], egress: [{}] } });
  },
  'public egress to private namespace': (d) => {
    d['public-policies'].items.push({
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [
          {
            to: [{ namespaceSelector: { matchLabels: { 'kubernetes.io/metadata.name': 'work' } } }],
            ports: [{ protocol: 'TCP', port: 80 }],
          },
        ],
      },
    });
  },
  'unrestricted external egress': (d) => {
    d['public-policies'].items.push({
      spec: {
        podSelector: {},
        policyTypes: ['Egress'],
        egress: [{ to: [{ ipBlock: { cidr: '0.0.0.0/0' } }], ports: [{ protocol: 'TCP', port: 443 }] }],
      },
    });
  },
  'unready pod': (d) => {
    first(first(d['work-pods'].items).status.conditions).status = 'False';
  },
  'host filesystem': (d) => {
    first(d['work-pods'].items).spec.volumes = [{ hostPath: { path: '/' } }];
  },
  'different server version': (d) => {
    d.version.serverVersion.gitVersion = 'v1.37.1+k3s1';
  },
};
for (const [name, change] of Object.entries(invalidFixtures)) {
  test(`cluster qualification refuses ${name} without printing credential values`, () =>
    sandbox((dir) => {
      const data = clusterFixture();
      change(data);
      const result = validateFixture(dir, data);
      assert.notEqual(result.status, 0);
      assert.ok(!`${result.stdout}${result.stderr}`.includes('credential-sentinel'));
    }));
}

test('checksums reject corrupted bytes', () =>
  sandbox((dir) => {
    const file = join(dir, 'artifact');
    writeFileSync(file, 'reviewed bytes');
    const sha = createHash('sha256').update('different bytes').digest('hex');
    writeFileSync(
      join(dir, 'sha256sum'),
      `#!${process.execPath}\nconst fs=require('node:fs'),c=require('node:crypto');console.log(c.createHash('sha256').update(fs.readFileSync(process.argv.at(-1))).digest('hex')+'  '+process.argv.at(-1));\n`,
      { mode: 0o700 },
    );
    const result = bash('source "$K3S_TEST_BOOTSTRAP"; verify_file "$1" "$2"', [file, sha], {
      PATH: `${dir}:${process.env.PATH}`,
    });
    assert.notEqual(result.status, 0);
    assert.ok(result.stderr.includes('checksum mismatch'));
  }));
