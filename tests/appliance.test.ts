// SPDX-License-Identifier: MPL-2.0
/**
 * The appliance (deploy/appliance, plan 324 M1): its K3s manifests come from the
 * one release definition, its pins agree with the K3s kit, and its image
 * description keeps the Leap 16.1 Immutable base plus what the k3s profile adds.
 * Runs the generator, which needs only Python 3; nothing is downloaded or built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const release = JSON.parse(read('deploy/marketplaces/release.json')) as Record<string, any>;
const lock = JSON.parse(read('deploy/appliance/appliance.lock.json')) as Record<string, any>;
const kiwi = read('deploy/appliance/kiwi/lolly-appliance.kiwi');
const overlay = 'deploy/appliance/kiwi/root';
const python = spawnSync('python3', ['--version']).status === 0;

function generate(arch: string): { dir: string; files: Record<string, string>; plan: any } {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-appliance-'));
  execFileSync('python3', ['-B', join(ROOT, 'deploy/appliance/generate.py'), '--arch', arch,
    '--overlay', join(dir, 'root'), '--plan', join(dir, 'images.json')], { stdio: 'pipe' });
  const manifests = join(dir, 'root/var/lib/rancher/k3s/server/manifests');
  const files: Record<string, string> = {};
  for (const name of readdirSync(manifests)) files[name] = readFileSync(join(manifests, name), 'utf8');
  files['release.json'] = readFileSync(join(dir, 'root/usr/share/lolly-appliance/release.json'), 'utf8');
  return { dir, files, plan: JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8')) };
}

/** Names and contents of a ustar/pax archive (enough for a packaged chart). */
function untar(buffer: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  let offset = 0, longName = '';
  while (offset + 512 <= buffer.length) {
    const header = buffer.subarray(offset, offset + 512);
    if (header.every(byte => byte === 0)) break;
    const name = header.subarray(0, 100).toString('utf8').replace(/\0.*$/s, '');
    const prefix = header.subarray(345, 500).toString('utf8').replace(/\0.*$/s, '');
    const size = parseInt(header.subarray(124, 136).toString('utf8').trim(), 8) || 0;
    const type = String.fromCharCode(header[156]!);
    const body = buffer.subarray(offset + 512, offset + 512 + size);
    if (type === 'x') {
      const path = /\d+ path=([^\n]+)\n/.exec(body.toString('utf8'));
      longName = path ? path[1]! : '';
    } else if (type === '0' || type === '\0') {
      out.set(longName || (prefix ? `${prefix}/${name}` : name), Buffer.from(body));
      longName = '';
    }
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return out;
}

const skip = python ? false : 'python3 is not installed';

test('both architectures are generated from release.json and nothing is copied by hand', { skip }, () => {
  const server = /^(.+)@(sha256:[a-f0-9]{64})$/.exec(release.serverImage)!;
  const postgres = /^(.+?)(?::([^:@/]+))?@(sha256:[a-f0-9]{64})$/.exec(release.postgresImage)!;
  for (const arch of ['x86_64', 'aarch64']) {
    const { dir, files, plan } = generate(arch);
    try {
      assert.deepEqual(Object.keys(files).sort(), ['00-lolly-namespace.yaml', 'lolly-https.yaml', 'lolly-postgres.yaml', 'lolly-work.yaml', 'release.json']);
      const chart = files['lolly-work.yaml']!;
      assert.match(chart, /^kind: HelmChart$/m);
      assert.ok(chart.includes(`repository: "${server[1]}"`) && chart.includes(`digest: "${server[2]}"`), arch);
      assert.match(chart, /existingSecret: lolly-work-secrets/);
      assert.match(chart, /mode: production/);
      assert.match(chart, /catalogPublicationGeneration: 1/);
      assert.ok(files['lolly-postgres.yaml']!.includes(`image: "${postgres[1]}@${postgres[3]}"`), arch);
      for (const text of Object.values(files)) assert.doesNotMatch(text, /@[A-Z_]+@/);
      assert.deepEqual(plan.images.map((image: any) => `${image.repository}@${image.digest}`),
        [release.serverImage, `${postgres[1]}@${postgres[3]}`]);
      assert.equal(plan.goarch, arch === 'x86_64' ? 'amd64' : 'arm64');
      assert.ok(release.qualifiedArchitectures.includes(plan.goarch));
      const summary = JSON.parse(files['release.json']!);
      assert.equal(summary.work.version, release.version);
      assert.equal(summary.k3s.version, lock.k3s.version);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

test('the embedded chart is the repository chart, and the values hold no secret', { skip }, () => {
  const { dir, files } = generate('x86_64');
  try {
    const chart = files['lolly-work.yaml']!;
    const content = /chartContent: (\S+)/.exec(chart)![1]!;
    const entries = untar(gunzipSync(Buffer.from(content, 'base64')));
    assert.equal(entries.get('lolly-work/Chart.yaml')!.toString('utf8'), read('deploy/helm/Chart.yaml'));
    assert.equal(entries.get('lolly-work/values.yaml')!.toString('utf8'), read('deploy/helm/values.yaml'));
    assert.ok(entries.has('lolly-work/templates/deployment.yaml'));
    const values = chart.split('valuesContent: |-\n')[1]!;
    assert.doesNotMatch(values, /sessionSecret|linkSecret|password:|DATABASE_URL|BEGIN .*PRIVATE KEY/);
    // Generation is deterministic: the same inputs give the same manifest.
    const again = generate('x86_64');
    try { assert.equal(again.files['lolly-work.yaml'], chart); } finally { rmSync(again.dir, { recursive: true, force: true }); }
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the image takes the release\'s Lolly version, never one of its own', { skip }, () => {
  assert.equal((kiwi.match(/<version>@LOLLY_VERSION@<\/version>/g) ?? []).length, 2);
  assert.doesNotMatch(kiwi, /<version>\d/);
  const dir = mkdtempSync(join(tmpdir(), 'lolly-appliance-kiwi-'));
  try {
    execFileSync('python3', ['-B', join(ROOT, 'deploy/appliance/generate.py'), '--arch', 'x86_64',
      '--overlay', join(dir, 'root'), '--kiwi', join(dir, 'desc')], { stdio: 'pipe' });
    const rendered = readFileSync(join(dir, 'desc/lolly-appliance.kiwi'), 'utf8');
    assert.equal((rendered.match(new RegExp(`<version>${release.version.replaceAll('.', '\\.')}</version>`, 'g')) ?? []).length, 2);
    assert.doesNotMatch(rendered, /@[A-Z_]+@/);
    const summary = JSON.parse(readFileSync(join(dir, 'root/usr/share/lolly-appliance/release.json'), 'utf8'));
    assert.equal(summary.version, release.version);
    assert.equal(summary.image, `lolly-appliance-${release.version}-x86_64`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
  const build = read('deploy/appliance/build.sh');
  assert.match(build, /base=lolly-appliance-\$version-\$arch/);
  assert.match(read('.github/workflows/appliance.yml'), /raw=lolly-appliance-\$version-x86_64\.raw/);
});

test('the K3s pins agree with the K3s kit, and every download has a checksum', () => {
  const kit = JSON.parse(read('deploy/suse/k3s.lock.json')) as Record<string, any>;
  assert.equal(lock.k3s.version, kit.version);
  assert.equal(lock.k3s.releaseCommit, kit.releaseCommit);
  const amd64 = kit.architectures?.amd64 ?? (kit.architecture === 'amd64' ? kit : undefined);
  if (amd64) assert.equal(lock.k3s.architectures.x86_64.binary.sha256, amd64.binary.sha256);
  if (kit.architectures?.arm64) assert.equal(lock.k3s.architectures.aarch64.binary.sha256, kit.architectures.arm64.binary.sha256);
  for (const arch of ['x86_64', 'aarch64']) {
    for (const part of ['binary', 'airgapImages']) {
      const pin = lock.k3s.architectures[arch][part];
      assert.match(pin.sha256, /^[a-f0-9]{64}$/, `${arch} ${part}`);
      assert.ok(pin.url.startsWith(`https://github.com/k3s-io/k3s/releases/download/${encodeURIComponent(lock.k3s.version)}/`), `${arch} ${part}`);
    }
  }
  assert.match(lock.k3sSelinux.sha256, /^[a-f0-9]{64}$/);
  assert.ok(lock.k3sSelinux.url.startsWith('https://rpm.rancher.io/k3s/stable/common/microos/noarch/k3s-selinux-'));
});

test('the image keeps the Leap 16.1 Immutable base and adds K3s, Cockpit and a config partition', () => {
  assert.match(kiwi, /<image schemaversion="7\.5" name="lolly-appliance"/);
  for (const arch of ['x86_64', 'aarch64']) {
    assert.match(kiwi, new RegExp(`<profile name="k3s" description="[^"]*" arch="${arch}">\\s*<requires profile="platform-${arch}"/>`));
  }
  for (const name of ['patterns-base-immutable_base', 'patterns-base-selinux', 'Leap_immutable-release', 'ignition',
    'k3s-selinux', 'cockpit', 'cockpit-tukit', 'firewalld', 'dracut-kiwi-oem-repart']) {
    assert.ok(kiwi.includes(`<package name="${name}"`), name);
  }
  assert.ok(kiwi.includes('<package name="combustion &gt;= 1.2"/>'));
  assert.doesNotMatch(kiwi, /<package name="(jeos-firstboot|cloud-init|usbguard)"|apparmor/i);
  assert.equal((kiwi.match(/btrfs_root_is_readonly_snapshot="true"/g) ?? []).length, 2);
  assert.equal((kiwi.match(/<partition name="config" size="16" partition_name="p\.lxconfig" filesystem="fat16" label="ignition" mountpoint="\/var\/lib\/lolly\/config-partition"\/>/g) ?? []).length, 2);
  assert.equal((kiwi.match(/security=selinux selinux=1/g) ?? []).length, 2);
  const config = read('deploy/appliance/kiwi/config.sh');
  assert.match(config, /SELINUX=enforcing/);
  assert.match(config, /config-partition" \{ \$4 = \$4",noauto,nofail" \}/);
  assert.match(config, /systemctl enable cockpit\.socket/);
  assert.match(config, /service name=\\"cockpit\\" accept/);
  assert.doesNotMatch(config, /--add-service=cockpit|--add-port=6443/);
});

test('first-boot services decrypt exactly the credentials the first boot creates', () => {
  const common = read(`${overlay}/usr/libexec/lolly-appliance/common.sh`);
  const names = /^CREDENTIALS="([^"]+)"/m.exec(common)![1]!.split(' ').sort();
  const unit = read(`${overlay}/usr/lib/systemd/system/lolly-appliance-secrets.service`);
  const loaded = [...unit.matchAll(/^LoadCredentialEncrypted=([a-z-]+):\/var\/lib\/lolly\/credentials\/\1\.cred$/gm)].map(m => m[1]!).sort();
  assert.deepEqual(loaded, names);
  const firstboot = read(`${overlay}/usr/libexec/lolly-appliance/firstboot`);
  for (const name of names) assert.ok(firstboot.includes(name), name);
  assert.match(firstboot, /systemd-creds encrypt --with-key=auto/);
  for (const script of ['console', 'firstboot', 'instance', 'secrets']) {
    assert.ok(statSync(join(ROOT, `${overlay}/usr/libexec/lolly-appliance/${script}`)).mode & 0o111, script);
  }
  assert.ok(statSync(join(ROOT, `${overlay}/usr/sbin/lolly-appliance`)).mode & 0o111);
  const k3s = read(`${overlay}/usr/lib/systemd/system/k3s.service`);
  assert.match(k3s, /^After=.*lolly-appliance-firstboot\.service.*lolly-appliance-instance\.service/m);
  assert.match(read(`${overlay}/etc/rancher/k3s/config.yaml`), /^selinux: true$/m);
  assert.match(read(`${overlay}/etc/rancher/k3s/config.yaml`), /^secrets-encryption: true$/m);
});
