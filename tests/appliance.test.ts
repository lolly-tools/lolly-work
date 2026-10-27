// SPDX-License-Identifier: MPL-2.0
/**
 * The appliance (deploy/appliance, plan 324 M1): both runtime profiles (k3s and
 * podman) come from the one release definition, its pins agree with the K3s
 * kit, its image description keeps the Leap 16.1 Immutable base plus what each
 * profile adds, and the updater (lolly-update) verifies releases with the
 * identities Lolly Work's workflows sign with. Runs the generator and the
 * updater's pure functions, which need only Python 3; nothing is downloaded or
 * built.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, readlinkSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { parse } from 'yaml';

const ROOT = new URL('..', import.meta.url).pathname;
const read = (path: string): string => readFileSync(join(ROOT, path), 'utf8');
const release = JSON.parse(read('deploy/marketplaces/release.json')) as Record<string, any>;
const lock = JSON.parse(read('deploy/appliance/appliance.lock.json')) as Record<string, any>;
const workConfig = JSON.parse(read('deploy/appliance/work-config.json')) as Record<string, any>;
const kiwi = read('deploy/appliance/kiwi/lolly-appliance.kiwi');
const overlay = 'deploy/appliance/kiwi/root';
const k3sOverlay = 'deploy/appliance/kiwi/root-k3s';
const podmanOverlay = 'deploy/appliance/kiwi/root-podman';
const updater = 'deploy/appliance/kiwi/root/usr/sbin/lolly-update';
const python = spawnSync('python3', ['--version']).status === 0;
const skip = python ? false : 'python3 is not installed';
const pinOf = (ref: string): string => { const m = /^(.+?)(?::[^:@/]+)?@(sha256:[a-f0-9]{64})$/.exec(ref)!; return `${m[1]}@${m[2]}`; };

interface Generated { dir: string; root: string; files: Record<string, string>; plan: any; summary: any }

function generate(arch: string, profile = 'k3s'): Generated {
  const dir = mkdtempSync(join(tmpdir(), `lolly-appliance-${profile}-`));
  const root = join(dir, 'root');
  execFileSync('python3', ['-B', join(ROOT, 'deploy/appliance/generate.py'), '--arch', arch, '--profile', profile,
    '--overlay', root, '--plan', join(dir, 'images.json')], { stdio: 'pipe' });
  const where = profile === 'k3s' ? 'var/lib/rancher/k3s/server/manifests' : 'var/lib/lolly/quadlet';
  const files: Record<string, string> = {};
  for (const name of readdirSync(join(root, where))) files[name] = readFileSync(join(root, where, name), 'utf8');
  const summary = JSON.parse(readFileSync(join(root, 'usr/share/lolly-appliance/release.json'), 'utf8'));
  files['release.json'] = JSON.stringify(summary);
  return { dir, root, files, plan: JSON.parse(readFileSync(join(dir, 'images.json'), 'utf8')), summary };
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

/** Run a Python snippet with lolly-update loaded as module `u`. */
function withUpdater(snippet: string, args: string[] = []): string {
  const program = `import importlib.machinery, importlib.util, json, sys
loader = importlib.machinery.SourceFileLoader('lolly_update', ${JSON.stringify(join(ROOT, updater))})
spec = importlib.util.spec_from_loader('lolly_update', loader)
u = importlib.util.module_from_spec(spec)
loader.exec_module(u)
${snippet}`;
  return execFileSync('python3', ['-B', '-c', program, ...args], { encoding: 'utf8' });
}

/** Keys of a nested object as dotted paths (arrays are leaves). */
function paths(value: unknown, prefix = ''): string[] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [prefix];
  return Object.entries(value as Record<string, unknown>).flatMap(([key, child]) => paths(child, prefix ? `${prefix}.${key}` : key));
}

test('both profiles and both architectures are generated from release.json and nothing is copied by hand', { skip }, () => {
  const server = /^(.+)@(sha256:[a-f0-9]{64})$/.exec(release.serverImage)!;
  const postgres = /^(.+?)(?::([^:@/]+))?@(sha256:[a-f0-9]{64})$/.exec(release.postgresImage)!;
  const caddy = /^(.+?)(?::([^:@/]+))?@(sha256:[a-f0-9]{64})$/.exec(release.caddyImage)!;
  for (const arch of ['x86_64', 'aarch64']) {
    const k3s = generate(arch, 'k3s');
    try {
      assert.deepEqual(Object.keys(k3s.files).sort(), ['00-lolly-namespace.yaml', 'lolly-https.yaml', 'lolly-postgres.yaml', 'lolly-work.yaml', 'release.json']);
      const chart = k3s.files['lolly-work.yaml']!;
      assert.match(chart, /^kind: HelmChart$/m);
      assert.ok(chart.includes(`repository: "${server[1]}"`) && chart.includes(`digest: "${server[2]}"`), arch);
      assert.match(chart, /existingSecret: lolly-work-secrets/);
      assert.ok(k3s.files['lolly-postgres.yaml']!.includes(`image: "${postgres[1]}@${postgres[3]}"`), arch);
      for (const text of Object.values(k3s.files)) assert.doesNotMatch(text, /@[A-Z_]+@/);
      assert.deepEqual(k3s.plan.images.map((image: any) => `${image.repository}@${image.digest}`), [release.serverImage, `${postgres[1]}@${postgres[3]}`]);
      assert.equal(k3s.plan.goarch, arch === 'x86_64' ? 'amd64' : 'arm64');
      assert.equal(k3s.plan.profile, 'k3s');
      assert.ok(release.qualifiedArchitectures.includes(k3s.plan.goarch));
      assert.equal(k3s.summary.work.version, release.version);
      assert.equal(k3s.summary.k3s.version, lock.k3s.version);
      assert.equal(k3s.summary.profile, 'k3s');
      assert.equal(k3s.summary.image, `lolly-appliance-${release.version}-${arch}`);
    } finally {
      rmSync(k3s.dir, { recursive: true, force: true });
    }
    const podman = generate(arch, 'podman');
    try {
      assert.deepEqual(Object.keys(podman.files).sort(), ['lolly-caddy.container', 'lolly-postgres.container', 'lolly-work.container', 'lolly.network', 'release.json']);
      const image = (unit: string) => /^Image=(\S+)$/m.exec(podman.files[unit]!)![1];
      assert.equal(image('lolly-work.container'), `${server[1]}@${server[2]}`);
      assert.equal(image('lolly-postgres.container'), `${postgres[1]}@${postgres[3]}`);
      assert.equal(image('lolly-caddy.container'), `${caddy[1]}@${caddy[3]}`);
      for (const text of Object.values(podman.files)) assert.doesNotMatch(text, /@[A-Z_]+@/);
      // The units live outside the root snapshots and are linked from /etc.
      for (const unit of ['lolly.network', 'lolly-postgres.container', 'lolly-work.container', 'lolly-caddy.container']) {
        const link = join(podman.root, 'etc/containers/systemd', unit);
        assert.ok(lstatSync(link).isSymbolicLink(), unit);
        assert.equal(readlinkSync(link), `/var/lib/lolly/quadlet/${unit}`);
      }
      assert.deepEqual(podman.plan.images.map((entry: any) => `${entry.repository}@${entry.digest}`),
        [release.serverImage, `${postgres[1]}@${postgres[3]}`, `${caddy[1]}@${caddy[3]}`]);
      for (const entry of podman.plan.images) assert.match(entry.archive, /^var\/lib\/lolly\/images\/[a-z0-9.-]+\.tar$/);
      assert.equal(podman.plan.profile, 'podman');
      assert.equal(podman.summary.profile, 'podman');
      assert.equal(podman.summary.image, `lolly-appliance-podman-${release.version}-${arch}`);
      assert.equal(podman.summary.work.serverImage, `${server[1]}@${server[2]}`);
      assert.equal(podman.summary.k3s, undefined);
      // Both profiles start lolly-update from release.json itself.
      const definition = JSON.parse(readFileSync(join(podman.root, 'usr/share/lolly-appliance/release-definition.json'), 'utf8'));
      assert.deepEqual(definition, release);
    } finally {
      rmSync(podman.dir, { recursive: true, force: true });
    }
  }
});

test('both profiles run the same Lolly Work settings, which cover every chart default and hold no secret', { skip }, () => {
  const chartDefaults = (parse(read('deploy/helm/values.yaml')) as Record<string, any>).config;
  const covered = new Set(paths(workConfig));
  for (const key of paths(chartDefaults)) assert.ok(covered.has(key), `work-config.json lacks the chart default ${key}, so Helm would add it on k3s only`);
  assert.equal(workConfig.deployment.mode, 'production');
  assert.equal(workConfig.policy.telemetry, 'off');
  assert.equal(workConfig.policy.guestLinks.enabled, false);
  assert.doesNotMatch(JSON.stringify(workConfig), /secret|postgres:\/\/|PRIVATE KEY/i);
  const k3s = generate('x86_64', 'k3s');
  const podman = generate('x86_64', 'podman');
  try {
    const values = parse(k3s.files['lolly-work.yaml']!.split('valuesContent: |-\n')[1]!.replace(/^ {4}/gm, '')) as Record<string, any>;
    assert.deepEqual(values.config, workConfig);
    assert.deepEqual(JSON.parse(readFileSync(join(podman.root, 'usr/share/lolly-appliance/work-config.json'), 'utf8')), workConfig);
    assert.deepEqual(JSON.parse(readFileSync(join(k3s.root, 'usr/share/lolly-appliance/work-config.json'), 'utf8')), workConfig);
    assert.match(podman.files['lolly-work.container']!, /LW_CONFIG=\/run\/lolly\/instance\.json/);
  } finally {
    for (const g of [k3s, podman]) rmSync(g.dir, { recursive: true, force: true });
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
  assert.match(build, /base=lolly-appliance-\$profile-\$version-\$arch/);
  assert.match(build, /kiwi-ng --profile "\$profile"/);
  assert.match(build, /cp -a "\$here\/kiwi\/root-\$profile\/\." "\$work\/desc\/root\/"/);
  const workflow = read('.github/workflows/appliance.yml');
  assert.match(workflow, /profile: \[k3s, podman\]/);
  assert.match(workflow, /raw=lolly-appliance-\$version-x86_64\.raw/);
  assert.match(workflow, /raw=lolly-appliance-podman-\$version-x86_64\.raw/);
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

test('the image keeps the Leap 16.1 Immutable base and each profile adds only what it runs', () => {
  assert.match(kiwi, /<image schemaversion="7\.5" name="lolly-appliance"/);
  // XML forbids "--" inside a comment, and KIWI then refuses the whole description.
  for (const [, comment] of kiwi.matchAll(/<!--([\s\S]*?)-->/g)) assert.doesNotMatch(comment!, /--/);
  for (const profile of ['k3s', 'podman']) {
    for (const arch of ['x86_64', 'aarch64']) {
      assert.match(kiwi, new RegExp(`<profile name="${profile}" description="[^"]*" arch="${arch}">\\s*<requires profile="platform-${arch}"/>`));
    }
  }
  for (const name of ['patterns-base-immutable_base', 'patterns-base-selinux', 'Leap_immutable-release', 'ignition',
    'cockpit', 'cockpit-tukit', 'firewalld', 'dracut-kiwi-oem-repart', 'cosign', 'python3-base', 'container-selinux']) {
    assert.ok(kiwi.includes(`<package name="${name}"`), name);
  }
  assert.match(kiwi, /<packages type="image" profiles="k3s">\s*<package name="k3s-selinux"\/>\s*<\/packages>/);
  assert.match(kiwi, /<packages type="image" profiles="podman">\s*<package name="cockpit-podman"\/>\s*<\/packages>/);
  assert.ok(kiwi.includes('<package name="combustion &gt;= 1.2"/>'));
  assert.doesNotMatch(kiwi, /<package name="(jeos-firstboot|cloud-init|usbguard)"|apparmor/i);
  assert.equal((kiwi.match(/btrfs_root_is_readonly_snapshot="true"/g) ?? []).length, 2);
  assert.equal((kiwi.match(/<partition name="config" size="16" partition_name="p\.lxconfig" filesystem="fat16" label="ignition" mountpoint="\/var\/lib\/lolly\/config-partition"\/>/g) ?? []).length, 2);
  assert.equal((kiwi.match(/security=selinux selinux=1/g) ?? []).length, 2);
  const config = read('deploy/appliance/kiwi/config.sh');
  assert.match(config, /SELINUX=enforcing/);
  assert.doesNotMatch(config, /setenforce|SELINUX=permissive|apparmor/i);
  assert.match(config, /config-partition" \{ \$4 = \$4",noauto,nofail" \}/);
  assert.match(config, /systemctl enable cockpit\.socket/);
  assert.match(config, /systemctl enable lolly-update\.timer/);
  assert.match(config, /systemctl enable transactional-update\.timer rebootmgr\.service health-checker\.service/);
  assert.match(config, /service name=\\"cockpit\\" accept/);
  assert.doesNotMatch(config, /--add-service=cockpit|--add-port=6443/);
  // Each profile trusts its own container network, and only that.
  assert.match(config, /--zone=trusted --add-source=10\.42\.0\.0\/16 --add-source=10\.43\.0\.0\/16/);
  const network = read('deploy/appliance/podman/lolly.network');
  const subnet = /^Subnet=(\S+)$/m.exec(network)![1]!;
  assert.match(config, new RegExp(`--zone=trusted --add-source=${subnet.replaceAll('.', '\\.').replace('/', '\\/')}`));
  // The k3s-only files stay out of the podman image and the other way round.
  for (const path of ['usr/lib/systemd/system/k3s.service', 'etc/rancher/k3s/config.yaml', 'usr/libexec/lolly-appliance/secrets']) {
    assert.ok(statSync(join(ROOT, k3sOverlay, path)).isFile(), path);
    assert.throws(() => statSync(join(ROOT, overlay, path)), path);
  }
  for (const path of ['usr/libexec/lolly-appliance/container-files', 'usr/libexec/lolly-appliance/network', 'usr/libexec/lolly-appliance/images']) {
    assert.ok(statSync(join(ROOT, podmanOverlay, path)).mode & 0o111, path);
  }
});

test('first-boot services decrypt exactly the credentials the first boot creates, on both profiles', () => {
  const common = read(`${overlay}/usr/libexec/lolly-appliance/common.sh`);
  const names = /^CREDENTIALS="([^"]+)"/m.exec(common)![1]!.split(' ').sort();
  const loadedBy = (text: string) => [...text.matchAll(/^LoadCredentialEncrypted=([a-z-]+):\/var\/lib\/lolly\/credentials\/\1\.cred$/gm)].map(m => m[1]!);
  assert.deepEqual(loadedBy(read(`${k3sOverlay}/usr/lib/systemd/system/lolly-appliance-secrets.service`)).sort(), names);
  // podman: each container's unit decrypts what that container needs, and together all of them.
  const units = Object.fromEntries(['postgres', 'work', 'caddy'].map(name => [name, read(`deploy/appliance/podman/lolly-${name}.container.in`)]));
  assert.deepEqual(loadedBy(units.postgres!), ['lolly-postgres-password']);
  assert.deepEqual(loadedBy(units.caddy!), ['lolly-tls-key']);
  assert.deepEqual([...new Set(Object.values(units).flatMap(loadedBy))].sort(), names);
  const files = read(`${podmanOverlay}/usr/libexec/lolly-appliance/container-files`);
  for (const [name, text] of Object.entries(units)) {
    // No podman secrets (podman writes their values under /var), a tmpfs handover instead.
    assert.doesNotMatch(text, /^Secret=/m, name);
    assert.match(text, new RegExp(`^ExecStartPre=/usr/libexec/lolly-appliance/container-files ${name}$`, 'm'));
    assert.match(text, new RegExp(`^ExecStopPost=/usr/libexec/lolly-appliance/container-files clean ${name}$`, 'm'));
    assert.match(text, new RegExp(`^Volume=/run/lolly/containers/${name}:/run/lolly:ro$`, 'm'));
    const level = /^SecurityLabelLevel=(\S+)$/m.exec(text)![1]!;
    assert.match(files, new RegExp(`^  ${name}\\) uid=\\d+; level=${level} ;;$`, 'm'), name);
    assert.match(text, /^ReadOnly=true$/m);
    assert.match(text, /^DropCapability=ALL$/m);
    assert.match(text, /^NoNewPrivileges=true$/m);
    assert.match(text, /^Pull=never$/m);
    assert.doesNotMatch(text, /^(SecurityLabelDisable|Privileged)=|label=disable/im);
  }
  assert.match(files, /chcon -R -u system_u -r object_r -t container_file_t -l "\$level" "\$dir"/);
  // Only Caddy keeps a capability: its binary's file capability, without which it cannot start.
  assert.deepEqual(Object.entries(units).flatMap(([name, text]) => [...text.matchAll(/^AddCapability=(.+)$/gm)].map(m => `${name}:${m[1]}`)), ['caddy:NET_BIND_SERVICE']);
  assert.match(units.postgres!, /^Volume=\/var\/lib\/lolly\/postgres:\/var\/lib\/postgresql\/data:Z$/m);
  const firstboot = read(`${overlay}/usr/libexec/lolly-appliance/firstboot`);
  for (const name of names) assert.ok(firstboot.includes(name), name);
  assert.match(firstboot, /systemd-creds encrypt --with-key=auto/);
  for (const script of ['console', 'firstboot', 'instance']) {
    assert.ok(statSync(join(ROOT, `${overlay}/usr/libexec/lolly-appliance/${script}`)).mode & 0o111, script);
  }
  for (const program of ['lolly-appliance', 'lolly-update']) assert.ok(statSync(join(ROOT, `${overlay}/usr/sbin/${program}`)).mode & 0o111, program);
  const k3s = read(`${k3sOverlay}/usr/lib/systemd/system/k3s.service`);
  assert.match(k3s, /^After=.*lolly-appliance-firstboot\.service.*lolly-appliance-instance\.service/m);
  assert.match(read(`${k3sOverlay}/etc/rancher/k3s/config.yaml`), /^selinux: true$/m);
  assert.match(read(`${k3sOverlay}/etc/rancher/k3s/config.yaml`), /^secrets-encryption: true$/m);
});

test('the podman network takes the host interface\'s MTU at each boot', () => {
  const network = read('deploy/appliance/podman/lolly.network');
  assert.match(network, /^Options=mtu=\$\{LOLLY_MTU\}$/m);
  assert.match(network, /^NetworkDeleteOnStop=true$/m);
  assert.match(network, /^EnvironmentFile=\/run\/lolly\/network\.env$/m);
  assert.match(network, /^Requires=lolly-appliance-network\.service$/m);
  const script = read(`${podmanOverlay}/usr/libexec/lolly-appliance/network`);
  assert.match(script, /ip -o route get 1\.1\.1\.1/);
  assert.match(script, /\/sys\/class\/net\/\$dev\/mtu/);
  assert.match(script, /printf 'LOLLY_MTU=%s\\n' "\$mtu" > \/run\/lolly\/network\.env\.new/);
  assert.match(read(`${podmanOverlay}/usr/lib/systemd/system/lolly-appliance-network.service`), /^Before=lolly-network\.service$/m);
  for (const name of ['postgres', 'work', 'caddy']) assert.match(read(`deploy/appliance/podman/lolly-${name}.container.in`), /^Network=lolly\.network$/m);
});

test('lolly-update verifies with the identities Lolly Work\'s workflows sign with', { skip }, () => {
  const source = read(updater);
  const releaseWorkflow = read('.github/workflows/release.yml');
  assert.match(releaseWorkflow, /--certificate-identity "\$GITHUB_SERVER_URL\/\$GITHUB_REPOSITORY\/\.github\/workflows\/release\.yml@refs\/tags\/v\$VERSION"/);
  assert.match(read('.github/workflows/publish-helm.yml'), /cosign sign-blob --yes --bundle/);
  const identities = JSON.parse(withUpdater('print(json.dumps({"release": u.release_identity("1.1.3"), "chart": u.CHART_IDENTITY, "issuer": u.ISSUER, "server": u.SERVER}))'));
  assert.equal(identities.release, 'https://github.com/lolly-tools/lolly-work/.github/workflows/release.yml@refs/tags/v1.1.3');
  assert.equal(identities.chart, 'https://github.com/lolly-tools/lolly-work/.github/workflows/publish-helm.yml@refs/heads/main');
  assert.equal(identities.issuer, 'https://token.actions.githubusercontent.com');
  assert.equal(identities.server, pinOf(release.serverImage).split('@')[0]);
  // Never a regexp identity, never an insecure flag, never a relaxed TLS context for remote calls.
  assert.doesNotMatch(source, /certificate-identity-regexp|insecure-ignore|--allow-insecure|allow_insecure|_create_unverified_context/);
  assert.match(source, /def https_context\(\) -> ssl\.SSLContext:\n(?:\s+#.*\n)*\s+return ssl\.create_default_context\(\)/);
  // The only unverified TLS context is the local health check, pinned to this machine's certificate.
  assert.equal((source.match(/CERT_NONE/g) ?? []).length, 1);
  assert.match(source, /hashlib\.sha256\(tls\.getpeercert\(binary_form=True\)\)\.hexdigest\(\) != expected/);
  const order = JSON.parse(withUpdater('print(json.dumps(sorted(["1.1.2", "1.1.10", "1.2.0-rc.1", "1.2.0", "1.1.3-rc.2", "1.1.3-rc.10", "1.1.3"], key=u.version_key)))'));
  assert.deepEqual(order, ['1.1.2', '1.1.3-rc.2', '1.1.3-rc.10', '1.1.3', '1.1.10', '1.2.0-rc.1', '1.2.0']);
  const pending = withUpdater(`
import subprocess
ok = u.parse_pending(subprocess.CompletedProcess([], 0, "schema current\\n", ""))
some = u.parse_pending(subprocess.CompletedProcess([], 1, "", "pending (2): 0071_a.sql, 0072_b.sql\\n"))
try:
    u.parse_pending(subprocess.CompletedProcess([], 1, "", "migrate: connect ECONNREFUSED\\n"))
    unknown = "accepted"
except u.UpdateError:
    unknown = "refused"
print(json.dumps([ok, some, unknown]))`);
  assert.deepEqual(JSON.parse(pending), [[], ['0071_a.sql', '0072_b.sql'], 'refused']);
});

test('lolly-update changes only the image pins, and a revert puts back the same bytes', { skip }, () => {
  const next = 'ghcr.io/lolly-tools/lolly-work-server:9.9.9@sha256:' + 'a'.repeat(64);
  const nextPostgres = 'docker.io/library/postgres:17@sha256:' + 'b'.repeat(64);
  for (const profile of ['podman', 'k3s']) {
    const g = generate('aarch64', profile);
    try {
      const result = JSON.parse(withUpdater(`
import os
root = sys.argv[1]
runtime = u.Podman if sys.argv[2] == "podman" else u.K3s
paths = [f"{runtime.QUADLET}/{unit}.container" for unit in runtime.UNITS.values()] if runtime is u.Podman else [runtime.WORK, runtime.POSTGRES]
files = {path: open(root + path).read() for path in paths}
pins = runtime.pins(files)
target = {"schemaVersion": 1, "version": "9.9.9", "serverImage": sys.argv[3], "postgresImage": sys.argv[4], "caddyImage": pins["caddyImage"] or sys.argv[4]}
new = runtime.render(files, target)
back = runtime.render(new, {"schemaVersion": 1, "version": sys.argv[5], "serverImage": pins["serverImage"], "postgresImage": pins["postgresImage"], "caddyImage": pins["caddyImage"] or pins["postgresImage"]})
changed = {path: [line for line in new[path].splitlines() if line not in files[path].splitlines()] for path in paths}
print(json.dumps({"pins": pins, "after": runtime.pins(new), "changed": changed, "roundTrip": back == files}))`,
      [g.root, profile, next, nextPostgres, release.version]));
      assert.equal(result.after.serverImage, pinOf(next), profile);
      assert.equal(result.after.postgresImage, pinOf(nextPostgres), profile);
      assert.equal(result.roundTrip, true, profile);
      for (const lines of Object.values(result.changed) as string[][]) {
        for (const line of lines) assert.match(line, /9\.9\.9|sha256:(a|b){64}/, `${profile}: ${line}`);
      }
    } finally {
      rmSync(g.dir, { recursive: true, force: true });
    }
  }
});

test('host updates and application updates keep to their own windows, and health-checker judges new snapshots', () => {
  const at = (text: string, pattern: RegExp) => { const [h, m] = pattern.exec(text)!.slice(1).map(Number); return h! * 60 + m!; };
  const hostUpdate = at(read(`${overlay}/usr/lib/systemd/system/transactional-update.timer.d/50-lolly-appliance.conf`), /^OnCalendar=\*-\*-\* (\d\d):(\d\d):00$/m);
  const appUpdate = at(read(`${overlay}/usr/lib/systemd/system/lolly-update.timer`), /^OnCalendar=\*-\*-\* (\d\d):(\d\d):00$/m);
  const reboot = at(read(`${overlay}/etc/rebootmgr.conf`), /^window-start=(\d\d):(\d\d)$/m);
  assert.ok(hostUpdate + 30 < appUpdate && appUpdate + 30 < reboot, `${hostUpdate} < ${appUpdate} < ${reboot}`);
  assert.match(read(`${overlay}/etc/rebootmgr.conf`), /^strategy=maint-window$/m);
  assert.match(read(`${overlay}/usr/etc/transactional-update.conf.d/50-lolly-appliance.conf`), /^REBOOT_METHOD=rebootmgr$/m);
  const plugin = `${overlay}/usr/libexec/health-checker/lolly-appliance.sh`;
  assert.ok(statSync(join(ROOT, plugin)).mode & 0o111);
  const text = read(plugin);
  assert.match(text, /^\s+check\) check ;;$/m);
  assert.match(text, /^\s+stop\) stop_lolly ;;$/m);
  assert.match(text, /LAST_WORKING_BTRFS_ID/);
  assert.match(text, /http_code \/healthz/);
  assert.match(text, /http_code \/readyz/);
  assert.match(text, /get --raw=\/readyz/);
  assert.match(read(`${overlay}/usr/lib/systemd/system/lolly-update.service`), /^ExecStart=\/usr\/sbin\/lolly-update run$/m);
});
