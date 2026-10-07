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
else if(a.includes('--get-target'))v=mode==='accept'?'ACCEPT':'default';
else if(a.includes('--list-rich-rules'))v=mode==='rich'?'rule family=ipv4 accept':'';
else if(a.includes('--list-forward-ports'))v=mode==='forward'?'port=8443:proto=tcp:toport=6443':'';
else if(a.includes('--list-interfaces'))v=mode==='trusted-interface'?'ens3':'';
else if(a.includes('--list-sources'))v=mode==='global-source'?'0.0.0.0/0 10.42.0.0/16 10.43.0.0/16':'10.42.0.0/16 10.43.0.0/16';
else if(a.includes('--list-services'))v='ssh http https';
else if(a.includes('--list-ports'))v=mode==='node-port'?'30000-32767/tcp':mode==='permanent-api'&&a.includes('--permanent')?'6443/tcp':'';
else if(a.includes('--query-source'))status=mode==='pod-closed'?1:0;
else if(a.includes('--query-port'))status=mode==='query-error'?2:mode==='api'&&a.includes('6443')?0:1;
else status=2;
if(v)console.log(v);process.exit(status);\n`,
  );
  chmodSync(file, 0o700);
  return { PATH: `${dir}:${process.env.PATH}` };
}

test('restricted firewall keeps pod/service paths without public API/NodePorts', () =>
  sandbox((dir) => {
    const result = bash('source "$K3S_TEST_BOOTSTRAP"; validate_network ens3', [], firewall(dir, 'safe'));
    assert.equal(result.status, 0, result.stderr);
  }));

for (const mode of [
  'accept',
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
      { sshSourceCidrs: ['0.0.0.0/0'] },
      { reviewedAt: '2020-01-01T00:00:00Z' },
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
    d['work-pods'].items[0].spec.containers[0].image = 'registry.example/lolly:latest';
  },
  'inline credential': (d) => {
    d['work-pods'].items[0].spec.containers[0].env = [{ name: 'DATABASE_URL', value: 'credential-sentinel' }];
  },
  'cross-role secret': (d) => {
    d['public-pods'].items[0].spec.containers[0].env = [
      { name: 'LW_SESSION_SECRET', valueFrom: { secretKeyRef: { name: 'work-secret', key: 'session' } } },
    ];
  },
  'service-account token': (d) => {
    d['work-accounts'].items[0].automountServiceAccountToken = true;
  },
  'public NodePort': (d) => {
    d['public-services'].items[0].spec.type = 'NodePort';
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
    d['work-pods'].items[0].status.conditions[0].status = 'False';
  },
  'host filesystem': (d) => {
    d['work-pods'].items[0].spec.volumes = [{ hostPath: { path: '/' } }];
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
