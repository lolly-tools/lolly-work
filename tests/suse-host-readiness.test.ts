import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { test } from 'node:test';

const root = resolve(new URL('..', import.meta.url).pathname);
const script = resolve(root, 'deploy/suse/host-readiness.py');
const python = process.env.PYTHON ?? 'python3';

function fixture() {
  return {
    system: 'Linux', architecture: 'x86_64', hostname: 'rehearsal', effectiveUid: 0,
    os: { ID: 'sles', VERSION_ID: '16.0' }, cpus: 4,
    memoryBytes: 8 * 1024 ** 3, freeVarBytes: 50 * 1024 ** 3, freeBuildBytes: 50 * 1024 ** 3,
    cgroupControllers: ['cpu', 'memory', 'pids'], swapActive: false,
    clusterPaths: [], existingOwners: [], occupiedPorts: [], firewallRunning: true,
    selinux: 'Enforcing', missingTools: [], inspectionErrors: [],
    unprivilegedOwner: true, subordinateIds: true,
  };
}

function evaluate(facts: Record<string, unknown>, profile = 'k3s', optimized = false) {
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('readiness',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
receipt=m.evaluate(json.load(sys.stdin),sys.argv[2],'rehearsal')
print(json.dumps(receipt))`;
  const result = spawnSync(python, ['-I', '-B', ...(optimized ? ['-O'] : []), '-c', code, script, profile], {
    input: JSON.stringify(facts), encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  return JSON.parse(result.stdout) as { status: string; readOnly: boolean; checks: Array<{ code: string; passed: boolean }> };
}

test('new SUSE host passes the selected gate without claiming deployment acceptance', () => {
  for (const profile of ['k3s', 'rke2', 'podman-build']) {
    const receipt = evaluate(fixture(), profile);
    assert.equal(receipt.status, 'ready');
    assert.equal(receipt.readOnly, true);
  }
});

const refusals: Array<[string, string, unknown]> = [
  ['different host', 'hostname', 'production'],
  ['non-Linux host', 'system', 'Darwin'],
  ['wrong cluster architecture', 'architecture', 'aarch64'],
  ['unreviewed OS', 'os', { ID: 'ubuntu', VERSION_ID: '24.04' }],
  ['missing OS version', 'os', { ID: 'sles' }],
  ['non-version OS value', 'os', { ID: 'sles', VERSION_ID: '$(echo forbidden)' }],
  ['non-admin inspection', 'effectiveUid', 1000],
  ['failed inspection', 'inspectionErrors', ['systemctl']],
  ['missing tool', 'missingTools', ['firewall-cmd']],
  ['missing cgroup controller', 'cgroupControllers', ['cpu', 'pids']],
  ['existing cluster data', 'clusterPaths', ['/var/lib/rancher/k3s']],
  ['existing application owner', 'existingOwners', ['lolly-work.service']],
  ['occupied control-plane port', 'occupiedPorts', [6443]],
  ['stopped firewall', 'firewallRunning', false],
  ['active swap', 'swapActive', true],
  ['permissive SELinux', 'selinux', 'Permissive'],
  ['insufficient CPUs', 'cpus', 2],
  ['insufficient RAM', 'memoryBytes', 4 * 1024 ** 3],
  ['insufficient disk', 'freeVarBytes', 10 * 1024 ** 3],
];
for (const [name, field, value] of refusals) {
  test(`cluster gate refuses ${name} with and without Python optimization`, () => {
    for (const optimized of [false, true]) {
      assert.equal(evaluate({ ...fixture(), [field]: value }, 'k3s', optimized).status, 'blocked');
    }
  });
}

test('missing observations fail closed, rather than assuming an empty host', () => {
  assert.equal(evaluate({}).status, 'blocked');
  const facts: Record<string, unknown> = fixture();
  delete facts.existingOwners;
  assert.equal(evaluate(facts).status, 'blocked');
});

test('Podman build gate permits arm64 but requires an unprivileged mapped owner', () => {
  assert.equal(evaluate({ ...fixture(), architecture: 'aarch64' }, 'podman-build').status, 'ready');
  assert.equal(evaluate({ ...fixture(), unprivilegedOwner: false }, 'podman-build').status, 'blocked');
  assert.equal(evaluate({ ...fixture(), subordinateIds: false }, 'podman-build').status, 'blocked');
  assert.equal(evaluate({ ...fixture(), freeBuildBytes: 1024 ** 3 }, 'podman-build').status, 'blocked');
});

test('OS metadata is parsed as data without running shell expressions', () => {
  const code = `import importlib.util,json,sys
s=importlib.util.spec_from_file_location('readiness',sys.argv[1]);m=importlib.util.module_from_spec(s);s.loader.exec_module(m)
print(json.dumps(m.os_release(sys.stdin.read())))`;
  const result = spawnSync(python, ['-I', '-B', '-c', code, script], {
    input: 'ID=sles\nVERSION_ID="$(echo must-not-execute)"\nUNUSED="secret-sentinel"\n', encoding: 'utf8',
  });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { ID: 'sles', VERSION_ID: '$(echo must-not-execute)' });
  assert.ok(!result.stdout.includes('secret-sentinel'));
});

test('CLI rejects shell text in host selection before any inspection', () => {
  const result = spawnSync(python, ['-I', script, '--profile', 'k3s', '--expect-host', '$(echo forbidden)'], { encoding: 'utf8' });
  assert.equal(result.status, 2);
  assert.equal(result.stdout, '');
});

test('real CLI emits a blocked receipt for a different selected host', () => {
  const result = spawnSync(python, ['-I', '-B', script, '--profile', 'k3s', '--expect-host', 'definitely-not-lolly-host-fixture'], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr);
  const receipt = JSON.parse(result.stdout) as { readOnly: boolean; status: string; checks: Array<{ code: string; passed: boolean }> };
  assert.equal(receipt.readOnly, true);
  assert.equal(receipt.status, 'blocked');
  assert.equal(receipt.checks.find((c) => c.code === 'host-identity')?.passed, false);
});

test('adapters reuse the shared gate and expose no implicit runtime installation', () => {
  const ansible = readFileSync(resolve(root, 'deploy/ansible/host-readiness.yml'), 'utf8');
  const salt = readFileSync(resolve(root, 'deploy/salt/host-readiness.sls'), 'utf8');
  assert.match(ansible, /ansible\.builtin\.script/);
  assert.match(ansible, /check_mode: false/);
  assert.match(ansible, /changed_when: false/);
  assert.doesNotMatch(ansible, /^\s+lolly_host_profile:/m, 'play defaults must not override inventory profile selection');
  assert.match(salt, /python_shell: false/);
  assert.match(salt, /stateful: true/);
  assert.match(salt, /- name: {{ command \| tojson }}/, 'Salt high-state command name must remain a scalar');
  for (const adapter of [ansible, salt]) {
    assert.match(adapter, /host-readiness\.py/);
    assert.doesNotMatch(adapter, /(?:pkg\.installed|ansible\.builtin\.package|k3s-bootstrap\.sh|helm upgrade|systemctl start)/);
  }
});
