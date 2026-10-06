// SPDX-License-Identifier: MPL-2.0
/**
 * The lolly.ing VM kit (deploy/vm), for openSUSE Leap 16 with SELinux
 * enforcing and root locked: the compose file keeps the server private, labels
 * every bind mount, gives the collab drain its time and never polls Neon on a
 * clock; the example configuration parses, passes the production checks and
 * keeps live co-editing on; the env example names every secret the scripts and
 * the configuration expect, and no value; bootstrap-opensuse.sh writes only an
 * empty second disk, and only when told which; provision.sh refuses anything
 * but openSUSE; push.sh and secrets.sh work as sles with sudo.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';

import { parseConfig } from '../server/src/config/instance.ts';
import { startupChecks } from '../server/src/setup/checks.ts';

const VM = join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'vm');
const read = (name: string): string => readFileSync(join(VM, name), 'utf8');
const SCRIPTS = ['bootstrap-opensuse.sh', 'provision.sh', 'push.sh', 'secrets.sh', 'smoke.sh'];

/** A directory of executable stand-ins, first on PATH. */
function stubs(files: Record<string, string>): { dir: string; bin: string; calls: string } {
  const dir = mkdtempSync(join(tmpdir(), 'lw-vm-'));
  const bin = join(dir, 'bin');
  mkdirSync(bin);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(join(bin, name), `#!/bin/sh\n${body}\n`);
    chmodSync(join(bin, name), 0o755);
  }
  const calls = join(dir, 'calls.log');
  writeFileSync(calls, '');
  return { dir, bin, calls };
}

/** The bind mounts of a service: short-syntax volumes whose source is a path. */
const bindMounts = (volumes: string[] = []): string[] => volumes.filter((v) => /^[./~]/.test(v));

test('push refuses a failed release capability check before any remote copy or restart', () => {
  const { bin, calls } = stubs({
    node: 'echo "release capability check refused" >&2\nexit 1',
    ssh: 'echo "ssh $*" >> "$CALLS"',
    rsync: 'echo "rsync $*" >> "$CALLS"',
  });
  const result = spawnSync('bash', [join(VM, 'push.sh'), 'sles@192.0.2.1'], {
    encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, CALLS: calls },
  });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /release capability check refused/);
  assert.equal(readFileSync(calls, 'utf8'), '', 'no remote effects before the candidate qualifies');
});

interface Service {
  build?: { context: string; dockerfile: string };
  image?: string;
  env_file?: string;
  environment?: Record<string, string>;
  volumes?: string[];
  ports?: string[];
  healthcheck?: { test: string[] };
  stop_grace_period?: string;
  restart?: string;
}

test('compose: the server is private, drains on stop and never polls the database on a clock', () => {
  const compose = YAML.parse(read('docker-compose.yml')) as { services: Record<string, Service>; volumes: Record<string, unknown> };
  assert.deepEqual(Object.keys(compose.services).sort(), ['caddy', 'render-worker', 'server'], 'no database service: Neon holds the data');
  const server = compose.services.server!;
  assert.deepEqual(server.build, { context: './src', dockerfile: 'deploy/compose/Dockerfile' });
  assert.equal(server.env_file, '.env');
  assert.equal(server.environment?.LW_CONFIG, '/app/instance.json');
  assert.equal(server.environment?.LW_BACKGROUND_POLL_MS, '${LW_BACKGROUND_POLL_MS:-0}');
  assert.ok(server.volumes?.includes('./instance.json:/app/instance.json:ro,Z'));
  assert.ok(server.volumes?.includes('./packs/lolly-ing:/app/packs/lolly-ing:ro,Z'));
  assert.ok(server.volumes?.includes('./src/engine-pin.json:/app/engine-pin.json:ro,Z'));
  assert.deepEqual(server.ports, ['127.0.0.1:8787:8787'], 'only the VM itself reaches the server port');
  assert.equal(server.stop_grace_period, '60s', 'main.ts drain() saves live rooms after SIGTERM');
  assert.equal(server.restart, 'unless-stopped');
  assert.ok(!server.healthcheck?.test.join(' ').includes('/healthz'), 'every HTTP request reads the database; the check must not');

  const caddy = compose.services.caddy!;
  assert.equal(caddy.image, 'caddy:2');
  assert.deepEqual(caddy.ports, ['80:80', '443:443', '443:443/udp']);
  assert.ok(caddy.volumes?.includes('caddy_data:/data') && caddy.volumes.includes('caddy_config:/config'));
  assert.ok(caddy.volumes?.includes('./caddy:/etc/caddy:ro,z'),
    'a directory mount, so caddy reload reads the copied file; shared, since caddy validate runs in a second container');
  assert.equal(caddy.env_file, 'caddy.env');
  assert.ok('caddy_data' in compose.volumes && 'caddy_config' in compose.volumes);
});

test('compose: rendering is isolated from identity and database secrets, with bounded resources', () => {
  const worker = YAML.parse(read('docker-compose.yml')).services['render-worker'];
  assert.equal(worker.env_file, undefined);
  assert.deepEqual(Object.keys(worker.environment).sort(), ['LOLLY_WEB_BASE', 'LW_RENDER_MAX_CONCURRENT', 'LW_RENDER_WORKER_SECRET']);
  assert.equal(worker.environment.LOLLY_WEB_BASE, 'https://lolly.ing');
  assert.equal(worker.environment.LW_RENDER_MAX_CONCURRENT, 2);
  assert.equal(worker.ports, undefined);
  assert.equal(worker.volumes, undefined);
  assert.equal(worker.read_only, true);
  assert.deepEqual(worker.cap_drop, ['ALL']);
  assert.deepEqual(worker.security_opt, ['no-new-privileges:true']);
  assert.equal(worker.mem_limit, '1536m');
  assert.equal(worker.cpus, 1.5);
  assert.equal(worker.pids_limit, 256);
});

test('compose: every bind mount carries an SELinux label, and only Caddy publishes a port beyond the VM', () => {
  // openSUSE runs SELinux enforcing and Docker with selinux-enabled: a bind
  // mount without :z or :Z is unreadable inside the container. Docker's
  // published ports bypass firewalld, so nothing but Caddy may listen outside.
  const compose = YAML.parse(read('docker-compose.yml')) as { services: Record<string, Service> };
  let mounts = 0;
  for (const [name, service] of Object.entries(compose.services)) {
    for (const mount of bindMounts(service.volumes)) {
      mounts++;
      const options = mount.split(':')[2]?.split(',') ?? [];
      assert.ok(options.includes('z') || options.includes('Z'), `${name}: ${mount} has an SELinux label`);
      assert.ok(options.includes('ro'), `${name}: ${mount} is read-only`);
    }
    for (const port of service.ports ?? []) {
      if (name === 'caddy') assert.match(port, /^(80:80|443:443(\/udp)?)$/, `caddy publishes ${port}`);
      else assert.match(port, /^127\.0\.0\.1:/, `${name} publishes ${port} on loopback only, never 0.0.0.0`);
    }
  }
  assert.equal(mounts, 5, 'instance.json, the pack, engine-pin.json, shell releases and the Caddy directory');
  assert.ok(!/^\s*-\s*"?(0\.0\.0\.0:)?8787:/m.test(read('docker-compose.yml')), 'the server port is never published publicly');
});

test('instance.json.example: production-ready for lolly.ing, live co-editing on, Neon-friendly', () => {
  const raw = JSON.parse(read('instance.json.example')) as Record<string, any>;
  const config = parseConfig(read('instance.json.example'));
  assert.equal(config.instance.baseUrl, 'https://lolly.ing');
  assert.equal(config.instance.pack, 'packs/lolly-ing');
  assert.equal(config.instance.homeView, 'projects', 'members open on their Projects');
  assert.equal(config.idp.issuer, 'https://accounts.google.com');
  assert.deepEqual(config.idp.bootstrapOwners, ['andyfitz@gmail.com']);
  assert.deepEqual(config.idp.admission?.emails, ['andyfitz@gmail.com']);
  assert.equal(config.idp.additional[0]?.clientSecretRef, 'LW_IDP_GITHUB_SECRET');
  assert.equal(config.rateLimit.trustedProxyHops, 1, 'Caddy is the one proxy hop');
  assert.equal(config.audit.headLog.intervalMinutes, 0, 'no hourly database read');
  assert.equal(config.blobs.driver, 'pg');
  assert.equal(config.dev.enabled, false);
  assert.ok(!('liveCollab' in raw) && !JSON.stringify(raw).includes('collab.join'), 'nothing turns live co-editing off');
  assert.ok(!/secret"\s*:/i.test(read('instance.json.example')), 'no secret values, only references');
  const checks = startupChecks(config, { session: 'x'.repeat(48), link: 'y'.repeat(48) }, true,
    { NODE_ENV: 'production', LW_IDP_GITHUB_SECRET: 'set' });
  assert.deepEqual(checks.filter((c) => c.status === 'fail' || c.status === 'warning').map((c) => c.id), []);
});

test('.env.example names every secret the scripts and the configuration use, with no value', () => {
  const lines = read('.env.example').split('\n').filter((l) => /^[A-Z_]+=/.test(l));
  for (const line of lines) assert.match(line, /^[A-Z_]+=$/, `${line.split('=')[0]} has no value in the example`);
  const names = lines.map((l) => l.slice(0, -1));
  const config = parseConfig(read('instance.json.example'));
  const expected = ['DATABASE_URL', 'LW_SESSION_SECRET', 'LW_LINK_SECRET', 'LW_IDP_CLIENT_SECRET', 'LW_CATALOG_SIGNING_KEY',
    ...config.idp.additional.flatMap((idp) => (idp.clientSecretRef ? [idp.clientSecretRef] : []))];
  for (const name of expected) assert.ok(names.includes(name), `${name} is listed`);
  const managed = /managed="([^"]+)"/.exec(read('secrets.sh'))?.[1]?.split(' ') ?? [];
  assert.deepEqual([...managed].sort(), [...new Set(expected)].sort(), 'secrets.sh writes exactly these');
  assert.match(read('.env.example'), /^# LW_BACKGROUND_POLL_MS=0$/m);
});

test('the shell scripts stop on the first error and never print a secret', () => {
  for (const name of SCRIPTS) {
    const text = read(name);
    assert.match(text, /^#!\/usr\/bin\/env bash\n/, name);
    assert.match(text, /^set -euo pipefail$/m, name);
    assert.ok(statSync(join(VM, name)).mode & 0o100, `${name} is executable`);
    assert.equal(spawnSync('bash', ['-n', join(VM, name)]).status, 0, `${name} parses`);
  }
  const secrets = read('secrets.sh');
  assert.ok(secrets.includes('read -rs'), 'secrets are read without echo');
  assert.ok(!/echo "\$(google|database|github|signing_key|session|link)"/.test(secrets), 'no value is echoed');
  assert.ok(!/set -x/.test(secrets));
});

test('push.sh: no command on the VM can swallow the rest of the deploy script, and docker runs through sudo', () => {
  const push = read('push.sh');
  // Fed to `bash -s`, bash reads the script as it runs; docker compose run and
  // exec attach standard input by default and would eat the rest, exit 0.
  assert.ok(!/^ssh .*bash -s/m.test(push), 'the remote script is not read from standard input');
  assert.match(push, /^ssh -n "\$target" "bash -c \\"\\\$\(echo \$encoded \| base64 -d\)\\" push-remote \$tls \$render_worker"$/m);
  for (const line of push.split('\n').filter((l) => /^ssh /.test(l))) assert.match(line, /^ssh -n /, `standard input closed: ${line}`);
  const attaching = push.split('\n').filter((l) => /^\s*(if )?docker compose (run|exec)\b/.test(l));
  assert.equal(attaching.length, 3, 'caddy validate, worker health and caddy reload');
  for (const line of attaching) assert.match(line, /<\/dev\/null/, `standard input is closed for: ${line.trim()}`);

  // Run the remote script against stand-ins that read standard input as the
  // real attach does, both as push.sh sends it and fed on standard input. The
  // sudo stand-in insists on -n (no password prompt on a session without a
  // terminal) and marks what it runs, so every docker call shows it came
  // through sudo.
  const script = /<<'REMOTE_SCRIPT' \|\| true\n([\s\S]*?)\nREMOTE_SCRIPT\n/.exec(push)?.[1];
  assert.ok(script, 'the remote script is found');
  const { dir, bin, calls } = stubs({
    docker: 'echo "${VIA_SUDO:+sudo }docker $*" >> "$CALLS"\ncase "$2" in run|exec) cat >/dev/null ;; esac',
    curl: 'echo "curl $*" >> "$CALLS"',
    sudo: '[ "$1" = -n ] || { echo "sudo without -n: $*" >&2; exit 1; }\nshift\nexport VIA_SUDO=1\nexec "$@"',
  });
  // What rsync brings from a machine with umask 077 (macOS's openrsync
  // ignores --chmod): the image's node user could read none of it.
  const copied = {
    files: ['src/engine-pin.json', 'src/server/src/main.ts', 'packs/lolly-ing/catalog/index.json', 'instance.json'],
    dirs: ['src', 'src/server', 'src/server/src', 'packs/lolly-ing', 'packs/lolly-ing/catalog'],
  };
  const closeUp = () => {
    for (const d of copied.dirs) mkdirSync(join(dir, d), { recursive: true });
    for (const f of copied.files) { writeFileSync(join(dir, f), '{}'); chmodSync(join(dir, f), 0o600); }
    for (const d of copied.dirs) chmodSync(join(dir, d), 0o700);
  };
  writeFileSync(join(dir, '.env'), '');
  const local = script.replaceAll('/opt/lolly-ing', dir);
  const env = { PATH: `${bin}:${process.env.PATH}`, CALLS: calls };
  const expected = [
    'sudo docker compose config --quiet',
    'sudo docker compose run --rm --no-deps caddy caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile',
    'sudo docker compose build server',
    'sudo docker compose up -d --no-deps --force-recreate server',
    'curl -fsS -o /dev/null http://127.0.0.1:8787/healthz',
    'sudo docker compose up -d --no-deps caddy',
    'sudo docker compose exec -T caddy caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile',
    'curl -fsS -k -o /dev/null --resolve lolly.ing:443:127.0.0.1 https://lolly.ing/healthz',
  ];
  for (const [how, args, input] of [
    ['bash -c (as push.sh sends it)', ['-c', local, 'push-remote', 'internal'], 'whatever ssh might forward\n'.repeat(64)],
    ['bash -s (script on standard input)', ['-s', '--', 'internal'], local],
  ] as const) {
    writeFileSync(calls, '');
    chmodSync(join(dir, '.env'), 0o644);
    closeUp();
    const run = spawnSync('bash', [...args], { input, env, encoding: 'utf8' });
    assert.equal(run.status, 0, `${how}: ${run.stderr}`);
    assert.match(run.stdout, /healthy through Caddy/, how);
    assert.deepEqual(readFileSync(calls, 'utf8').trim().split('\n'), expected, how);
    assert.equal(readFileSync(join(dir, 'caddy.env'), 'utf8'), 'LW_CADDY_GLOBAL=local_certs\n', how);
    assert.equal(statSync(join(dir, '.env')).mode & 0o777, 0o600, `${how}: .env is put back to 0600`);
    for (const f of copied.files) assert.equal(statSync(join(dir, f)).mode & 0o044, 0o044, `${how}: ${f} is readable by the node user`);
    for (const d of copied.dirs) assert.equal(statSync(join(dir, d)).mode & 0o055, 0o055, `${how}: ${d} can be listed by the node user`);
  }
  // The modes are set on the VM, not left to rsync's --chmod.
  assert.ok(!/rsync[^\n]*--chmod/.test(push), 'no rsync --chmod: macOS openrsync ignores it');
  assert.ok(script.indexOf('chmod -R go+rX src packs/lolly-ing') < script.indexOf('docker compose build server'),
    'readable before the image is built from src/');
});

test('push.sh and secrets.sh log in as sles (LOLLY_VM_USER), never root, and check the VM user can deploy', () => {
  for (const name of ['push.sh', 'secrets.sh']) {
    const text = read(name);
    assert.ok(text.includes('*) target=${LOLLY_VM_USER:-sles}@$target ;;'), `${name}: a bare address logs in as sles`);
    // root cannot log in on the Leap image: say so before anything else runs.
    const args = name === 'push.sh' ? ['root@192.0.2.1'] : ['root@192.0.2.1', '/nonexistent.pem'];
    const run = spawnSync('bash', [join(VM, name), ...args], { encoding: 'utf8', env: { PATH: process.env.PATH } });
    assert.equal(run.status, 1, name);
    assert.match(run.stderr, /root cannot log in on the VM: use sles@<vm-ip>, or just <vm-ip>/, name);
  }
  const push = read('push.sh');
  assert.match(push, /ssh -n "\$target" "test -d \$REMOTE && test -w \$REMOTE"/, 'the deploy user owns /opt/lolly-ing');
  assert.match(push, /ssh -n "\$target" 'sudo -n true'/, 'passwordless sudo is checked before copying');
  assert.match(push, /^docker\(\) \{ sudo -n docker "\$@"; \}$/m, 'docker runs through sudo -n on the VM');
  assert.ok(!/--rsync-path/.test(push), 'files go over as the deploy user, not as root');

  // secrets.sh: the script travels base64-encoded on the command line and the
  // values on standard input; the file is the deploy user's, mode 0600.
  const secrets = read('secrets.sh');
  assert.match(secrets, /^\} \| ssh "\$target" "bash -c \\"\\\$\(echo \$encoded \| base64 -d\)\\""$/m);
  assert.match(secrets, /\[ -w "\$dir" \] \|\|/, 'refuses a directory the deploy user cannot write');
  assert.match(secrets, /^umask 077$/m);
  assert.match(secrets, /^chmod 600 "\$tmp"$/m);
  assert.ok(!/sudo/.test(secrets.split('REMOTE')[1] ?? ''), 'the remote writer needs no root');
});

test('provision.sh is one group, so `bash -s` reads all of it before running any of it', () => {
  for (const name of ['provision.sh', 'bootstrap-opensuse.sh']) {
    const lines = read(name).trimEnd().split('\n');
    assert.equal(lines.at(-1), '}', name);
    const open = lines.indexOf('{');
    assert.ok(open > lines.indexOf('set -euo pipefail'), `${name}: the group opens after the shell options`);
    assert.ok(lines.slice(0, open).every((l) => l === '' || l.startsWith('#') || l === 'set -euo pipefail'), `${name}: no command runs before the group`);
  }
});

/** An os-release file with these fields. */
function osRelease(dir: string, fields: Record<string, string>): string {
  const file = join(dir, `os-release-${Object.values(fields).join('-').replace(/\W+/g, '_')}`);
  writeFileSync(file, Object.entries(fields).map(([k, v]) => `${k}="${v}"`).join('\n') + '\n');
  return file;
}

test('provision.sh refuses anything but openSUSE Leap 16 or Tumbleweed, before it touches the machine', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lw-provision-'));
  const run = (file: string) => spawnSync('bash', [join(VM, 'provision.sh')],
    { encoding: 'utf8', env: { PATH: process.env.PATH, LOLLY_OS_RELEASE: file } });
  for (const fields of [
    { ID: 'ubuntu', VERSION_ID: '24.04', PRETTY_NAME: 'Ubuntu 24.04.3 LTS' },
    { ID: 'debian', VERSION_ID: '12', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' },
    { ID: 'opensuse-leap', VERSION_ID: '15.6', PRETTY_NAME: 'openSUSE Leap 15.6' },
    { ID: 'sles', VERSION_ID: '16.0', PRETTY_NAME: 'SUSE Linux Enterprise Server 16.0' },
  ]) {
    const result = run(osRelease(dir, fields));
    assert.equal(result.status, 1, fields.PRETTY_NAME);
    assert.match(result.stderr, /written for openSUSE Leap 16/, fields.PRETTY_NAME);
    assert.ok(result.stderr.includes(fields.PRETTY_NAME), `names what it found: ${result.stderr}`);
  }
  assert.match(run(join(dir, 'missing')).stderr, /cannot read/);
  // Accepted systems get as far as the root check, which a test never passes.
  if (process.getuid?.() !== 0) {
    for (const fields of [
      { ID: 'opensuse-leap', VERSION_ID: '16.0', PRETTY_NAME: 'openSUSE Leap 16.0' },
      { ID: 'opensuse-tumbleweed', VERSION_ID: '20261001', PRETTY_NAME: 'openSUSE Tumbleweed' },
    ]) {
      const result = run(osRelease(dir, fields));
      assert.equal(result.status, 1, fields.PRETTY_NAME);
      assert.match(result.stderr, /run as root through sudo: ssh sles@<vm-ip> 'sudo bash -s' < deploy\/vm\/provision\.sh/);
    }
  }
});

test('provision.sh: firewalld before Docker, labelled swap, os-update, ssh checked before reload, a deploy directory for sles', () => {
  const text = read('provision.sh');
  const at = (needle: string): number => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `provision.sh has: ${needle}`);
    return i;
  };
  assert.ok(!/apt-get|\bufw\b|dpkg/.test(text), 'no Debian or Ubuntu tooling');
  // The Cloud image is 1.4 GiB; a / that did not grow at first boot would run
  // out of space part-way through. Refused before anything changes.
  const guard = at('if [ "${root_kib:-0}" -lt $((15 * 1024 * 1024)) ]; then');
  assert.ok(at('root_kib=$(df -Pk / |') < guard);
  assert.ok(guard < at('zyp refresh'), 'the size of / is checked before the first change');
  assert.match(text, /sudo growpart \/dev\/\$\{root_disk:-<disk>\} \$\{root_part:-<partition number>\} && sudo \$grow_fs/);
  at("xfs) grow_fs='xfs_growfs /' ;;");
  for (const pkg of ['docker', 'docker-compose', 'docker-buildx', 'firewalld', 'os-update', 'policycoreutils-python-utils', 'rsync', 'openssl']) {
    assert.match(text, new RegExp(`zyp install [^\\n]*(\\\\\\n[^\\n]*)?\\b${pkg}\\b`), `installs ${pkg}`);
  }
  assert.ok(at('systemctl enable --now firewalld') < at('systemctl enable --now docker'), 'Docker starts after firewalld');
  for (const rule of ['--add-service="$service"', '--add-port=443/udp']) at(rule);
  assert.match(text, /for service in ssh http https; do/);
  assert.ok(at('semanage fcontext -a -t swapfile_t /swapfile') < at('swapon /swapfile'), 'the swap file is labelled first');
  assert.ok(at('restorecon /swapfile') < at('swapon /swapfile'));
  at('UPDATE_CMD="security"');
  at('systemctl enable --now os-update.timer');
  at("echo 'preserve_hostname: true' > /etc/cloud/cloud.cfg.d/99-host.cfg");
  at('hostnamectl set-hostname "$host"');
  for (const line of ['PasswordAuthentication no', 'KbdInteractiveAuthentication no', 'PermitRootLogin no', 'AuthenticationMethods publickey']) {
    assert.match(text, new RegExp(`^${line}$`, 'm'), line);
  }
  at('/etc/ssh/sshd_config.d/00-hardening.conf');
  assert.ok(at('$home/.ssh/authorized_keys') < at('cat > "$conf.new"'), 'the user has a key before keys-only is written');
  assert.ok(at('if ! sshd -t; then') < at('systemctl reload sshd'), 'sshd -t before the reload');
  assert.ok(at("grep -qx 'pubkeyauthentication yes'") < at('systemctl reload sshd'), 'key logins confirmed before the reload');
  at('usermod -aG docker "$user"');
  assert.match(text, /install -d -m 0700 -o "\$user" -g "\$group" "\$dir"/);
  assert.match(text, /for dir in \/opt\/lolly-ing /);
  assert.match(text, /chmod 0600 \/opt\/lolly-ing\/\.env/);
});

const BOOTSTRAP_STUBS = {
  id: '[ "$1" = -u ] && { echo 0; exit 0; }\nexec /usr/bin/id "$@"',
  uname: '[ "$1" = -m ] && { echo x86_64; exit 0; }\nexec /usr/bin/uname "$@"',
  findmnt: [
    'for last; do :; done',
    'case "$*" in',
    '  "-n -o SOURCE /") echo /dev/vda1 ;;',
    '  "-rn -S "*) [ -n "$FAKE_MOUNTED" ] && [ "$last" = "$FAKE_MOUNTED" ] && { echo "/mnt $FAKE_MOUNTED ext4"; exit 0; }; exit 1 ;;',
    '  *) echo "findmnt stand-in: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'),
  lsblk: [
    'for last; do :; done',
    'case "$*" in',
    '  "-nrsp -o NAME,TYPE /dev/vda1") printf "/dev/vda1 part\\n/dev/vda disk\\n" ;;',
    '  "-dnrbp -o NAME,TYPE,SIZE,RO") printf "/dev/vda disk 10737418240 0\\n/dev/sr0 rom 1048576 1\\n/dev/zram0 disk 1073741824 0\\n%s" "$FAKE_DISKS" ;;',
    '  "-dnbr -o SIZE /dev/vda") echo 10737418240 ;;',
    '  "-nrp -o NAME "*) echo "$last"; printf "%s" "$FAKE_CHILDREN" ;;',
    '  "-o NAME,SIZE,TYPE,FSTYPE,LABEL "*) printf "NAME SIZE TYPE FSTYPE LABEL\\n%s 50G disk\\n%s" "$last" "$FAKE_CHILDREN" ;;',
    '  *) echo "lsblk stand-in: $*" >&2; exit 1 ;;',
    'esac',
  ].join('\n'),
  blkid: '[ -n "$FAKE_SIGNATURE" ] || exit 2\nfor last; do :; done\nprintf "DEVNAME=%s\\n%s\\n" "$last" "$FAKE_SIGNATURE"',
  // Nothing past the plan may run in these tests.
  ...Object.fromEntries(['apt-get', 'curl', 'qemu-img', 'sha256sum', 'sfdisk', 'blockdev', 'udevadm', 'systemctl', 'poweroff', 'sync', 'dd', 'wipefs']
    .map((name) => [name, `echo "${name} $*" >> "$CALLS"; exit 97`])),
};

test('bootstrap-opensuse.sh writes only the one empty second disk, and only when told to', () => {
  const { dir, bin, calls } = stubs(BOOTSTRAP_STUBS);
  const debian = osRelease(dir, { ID: 'debian', VERSION_ID: '12', PRETTY_NAME: 'Debian GNU/Linux 12 (bookworm)' });
  const GiB = 1024 ** 3;
  const run = (args: string[], fake: Record<string, string> = {}, os = debian, ran = '') => {
    writeFileSync(calls, '');
    const result = spawnSync('bash', [join(VM, 'bootstrap-opensuse.sh'), ...args], {
      encoding: 'utf8',
      env: {
        PATH: `${bin}:${process.env.PATH}`, CALLS: calls, LOLLY_OS_RELEASE: os, LOLLY_BOOTSTRAP_DIR: join(dir, 'image'),
        FAKE_DISKS: `/dev/vdb disk ${50 * GiB} 0\n`, FAKE_CHILDREN: '', FAKE_SIGNATURE: '', FAKE_MOUNTED: '', ...fake,
      },
    });
    assert.equal(readFileSync(calls, 'utf8'), ran, ran ? `got as far as: ${ran}` : `nothing past the plan ran: ${args.join(' ')}`);
    return result;
  };

  // The plan: the one empty disk is named, and nothing is written.
  const plan = run([]);
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /System disk, left alone: \/dev\/vda \(10\.0 GiB\)/);
  assert.match(plan.stdout, /Target disk: \/dev\/vdb \(50\.0 GiB\)/);
  assert.match(plan.stdout, /ERASE \/dev\/vdb and write openSUSE Leap 16\.0 Minimal-VM \(Cloud\)/);
  assert.ok(plan.stdout.includes('https://download.opensuse.org/distribution/leap/16.0/appliances/Leap-16.0-Minimal-VM.x86_64-Cloud.qcow2'));
  assert.ok(plan.stdout.includes('.qcow2.sha256'));
  assert.match(plan.stdout, /Nothing written\. To go ahead, name the disk:\n {2}ssh root@<ip> 'bash -s -- \/dev\/vdb' < deploy\/vm\/bootstrap-opensuse\.sh/);
  assert.match(plan.stdout, /log in as sles@<ip>/);

  const tumbleweed = run(['--tumbleweed']);
  assert.equal(tumbleweed.status, 0, tumbleweed.stderr);
  assert.ok(tumbleweed.stdout.includes('https://download.opensuse.org/tumbleweed/appliances/openSUSE-Tumbleweed-Minimal-VM.x86_64-Cloud.qcow2'));
  assert.match(tumbleweed.stdout, /'bash -s -- --tumbleweed \/dev\/vdb'/);
  assert.match(tumbleweed.stdout, /log in as opensuse@<ip>/);

  // Refusals, with --yes too: confirming never overrides a check.
  const refusals: [string, string[], Record<string, string>, RegExp][] = [
    ['no second disk', ['--yes'], { FAKE_DISKS: '' }, /need exactly one disk besides the system disk, found 0/],
    ['two candidate disks', ['--yes'], { FAKE_DISKS: `/dev/vdb disk ${50 * GiB} 0\n/dev/vdc disk ${50 * GiB} 0\n` }, /found 2/],
    ['a partitioned disk', ['--yes'], { FAKE_CHILDREN: '/dev/vdb1\n' }, /partitions or devices on it: \/dev\/vdb1/],
    ['a disk with a signature', ['--yes'], { FAKE_SIGNATURE: 'PTTYPE=gpt' }, /carries a signature: PTTYPE=gpt/],
    ['a filesystem on the whole disk', ['/dev/vdb'], { FAKE_SIGNATURE: 'TYPE=ext4' }, /carries a signature: TYPE=ext4/],
    ['a small disk', ['--yes'], { FAKE_DISKS: `/dev/vdb disk ${10 * GiB} 0\n` }, /has 10\.0 GiB; at least 20 GiB is needed/],
    ['a read-only disk', ['--yes'], { FAKE_DISKS: `/dev/vdb disk ${50 * GiB} 1\n` }, /read-only/],
    ['a mounted disk', ['--yes'], { FAKE_MOUNTED: '/dev/vdb' }, /\/dev\/vdb is mounted/],
    ['another device named', ['/dev/vdc'], {}, /\/dev\/vdc is not the one empty disk found \(\/dev\/vdb\)/],
    ['the system disk named', ['/dev/vda'], {}, /\/dev\/vda is not the one empty disk found/],
    ['an unknown argument', ['--force'], {}, /unknown argument --force/],
    // --overwrite accepts an earlier write, nothing else: never with --yes,
    // never a disk in use, never a second candidate or the system disk.
    ['--overwrite with --yes', ['--overwrite', '--yes'], {}, /--overwrite erases what the disk holds: name the disk/],
    ['--overwrite, a partition mounted', ['--overwrite', '/dev/vdb'], { FAKE_CHILDREN: '/dev/vdb1\n/dev/vdb3\n', FAKE_MOUNTED: '/dev/vdb3' },
      /\/dev\/vdb3 is mounted/],
    ['--overwrite, two candidate disks', ['--overwrite', '/dev/vdb'],
      { FAKE_DISKS: `/dev/vdb disk ${50 * GiB} 0\n/dev/vdc disk ${50 * GiB} 0\n`, FAKE_SIGNATURE: 'PTTYPE=gpt' }, /found 2/],
    ['--overwrite, the system disk named', ['--overwrite', '/dev/vda'], { FAKE_SIGNATURE: 'PTTYPE=gpt' }, /\/dev\/vda is not the one empty disk found/],
    ['--overwrite, a small disk', ['--overwrite', '/dev/vdb'], { FAKE_DISKS: `/dev/vdb disk ${10 * GiB} 0\n` }, /at least 20 GiB is needed/],
  ];
  for (const [what, args, fake, message] of refusals) {
    const result = run(args, fake);
    assert.equal(result.status, 1, `${what}: ${result.stdout}`);
    assert.match(result.stderr, message, what);
    assert.match(result.stderr, /Nothing written|unknown argument/, what);
  }

  // A disk holding an earlier write: refused, with the way out named; with
  // --overwrite, the plan lists what it holds and erases nothing.
  const earlier = { FAKE_CHILDREN: '/dev/vdb1\n/dev/vdb2\n/dev/vdb3\n', FAKE_SIGNATURE: 'PTTYPE=gpt' };
  const refused = run(['/dev/vdb'], earlier);
  assert.equal(refused.status, 1);
  assert.match(refused.stderr, /see --overwrite/);
  const overwritePlan = run(['--overwrite'], earlier);
  assert.equal(overwritePlan.status, 0, overwritePlan.stderr);
  assert.match(overwritePlan.stdout, /Target disk: \/dev\/vdb \(50\.0 GiB\), not mounted, not in use\. It holds, all to be erased:\n.*\n {4}\/dev\/vdb 50G disk\n {4}\/dev\/vdb1\n/);
  assert.match(overwritePlan.stdout, /ERASE \/dev\/vdb: wipe its signatures \(wipefs -a\), then write openSUSE Leap 16\.0/);
  assert.match(overwritePlan.stdout, /'bash -s -- --overwrite \/dev\/vdb' < deploy\/vm\/bootstrap-opensuse\.sh/);
  const tumbleweedOverwrite = run(['--tumbleweed', '--overwrite'], earlier);
  assert.match(tumbleweedOverwrite.stdout, /'bash -s -- --tumbleweed --overwrite \/dev\/vdb'/);
  // Named, it goes ahead: the first thing it runs is the package install (a
  // stand-in that fails here), long before wipefs or qemu-img.
  const go = run(['--overwrite', '/dev/vdb'], earlier, debian, 'apt-get update -q\n');
  assert.equal(go.status, 97, go.stderr);

  // Anywhere but the Debian bootstrap server it stops before looking at disks.
  const leap = run(['--yes'], {}, osRelease(dir, { ID: 'opensuse-leap', VERSION_ID: '16.0', PRETTY_NAME: 'openSUSE Leap 16.0' }));
  assert.equal(leap.status, 1);
  assert.match(leap.stderr, /run this on the Debian 12 server .* it erases a disk\. This is openSUSE Leap 16\.0/);
  assert.equal(leap.stdout, '');
});

test('bootstrap-opensuse.sh checks the download and the disk again before writing, then powers off', () => {
  const text = read('bootstrap-opensuse.sh');
  const at = (needle: string): number => {
    const i = text.indexOf(needle);
    assert.ok(i >= 0, `bootstrap-opensuse.sh has: ${needle}`);
    return i;
  };
  const write = at('qemu-img convert -p -f qcow2 -O raw "$work/$image" "$target"');
  assert.ok(at('if [ "$confirm" != 1 ] && [ -z "$device" ]; then') < at('apt-get install -y'), 'the plan stops before anything is installed');
  assert.ok(at('| sha256sum -c -') < write, 'SHA-256 checked before writing');
  assert.ok(at('[ "$format" = qcow2 ]') < write && at('[ "$needed" -le "$size" ]') < write, 'qcow2, and it fits');
  assert.ok(text.lastIndexOf('problems=$(target_problems)') < write, 'the disk is looked at again just before writing');
  assert.ok(at('[ -b "$target" ]') < write);
  for (const check of ['blkid -p', 'findmnt -rn -S', '/proc/swaps', '/holders', 'MIN_BYTES=$((20 * 1024 * 1024 * 1024))']) at(check);
  assert.ok(at('systemctl poweroff') > write, 'powers off after writing');
  assert.ok(at('[ -n "$pttype" ] || die') < at('systemctl poweroff'), 'not without a partition table on the disk');
  assert.ok(!/\bdd\b|mkfs/.test(text), 'qemu-img writes the disk');
  // wipefs, once, for --overwrite only: after the last look at the disk, just
  // before the write, and without -f, so it too refuses a device in use.
  assert.equal(text.match(/^\s*wipefs /gm)?.length, 1, 'one wipefs command');
  const wipe = at('wipefs -a "$target" </dev/null');
  assert.ok(text.lastIndexOf('problems=$(target_problems)') < wipe && wipe < write);
  assert.match(text, /\nif \[ "\$overwrite" = 1 \]; then\n(?: {2}[^\n]*\n)*? {2}wipefs -a "\$target" <\/dev\/null\n/, 'only under --overwrite');
  assert.ok(at('if [ "$overwrite" = 1 ] && [ "$confirm" = 1 ]; then') < at('apt-get install -y'), '--overwrite never with --yes');
});

test('the runbook brings the Vercel rollback up to this code before the DNS cut', () => {
  // A build from before plan 74's boot fixes hangs its cold starts on a migration
  // lock the Neon pooler keeps: DNS back at it would be no rollback at all.
  const readme = read('README.md');
  const redeploy = readme.indexOf('vercel deploy --prod');
  assert.ok(redeploy > 0 && redeploy < readme.indexOf('**Cut DNS.**'), 'redeploy Vercel, then cut DNS');
  assert.ok(readme.indexOf('LW_BACKGROUND_POLL_MS production') < readme.indexOf('**Cut DNS.**'));
  const rollback = readme.slice(readme.indexOf('## Rollback'), readme.indexOf('## Operating'));
  assert.match(rollback, /--resolve lolly\.ing:443:76\.76\.21\.21 https:\/\/lolly\.ing\/api\/v1\/instance/);
  assert.match(rollback, /engineVersion/);
});

test('the runbook puts openSUSE on the server through Debian, works as sles, and deletes the Debian disk last', () => {
  const readme = read('README.md');
  const runbook = readme.slice(readme.indexOf('## Runbook'), readme.indexOf('### Session and link secrets'));
  const order = [
    '**Deploy server**', '**Frankfurt**', '`CLOUDNATIVE-2xCPU-4GB`', '**50 GB, MaxIOPS**', '**Debian 12**',
    '~/.ssh/id_ed25519.pub', '**Metadata service on**',
    "ssh root@<ip> 'bash -s' < deploy/vm/bootstrap-opensuse.sh",
    "ssh root@<ip> 'bash -s -- /dev/vdb' < deploy/vm/bootstrap-opensuse.sh",
    '**detach** the 10 GB Debian disk', '**start** the server', 'ssh-keygen -R <ip>',
    "ssh sles@<ip> 'sudo bash -s' < deploy/vm/provision.sh",
    'deploy/vm/secrets.sh sles@<ip>', 'deploy/vm/push.sh sles@<ip> --internal-tls', 'deploy/vm/smoke.sh <ip> --insecure',
    'vercel deploy --prod', '**Lower the DNS TTL.**', '**Cut DNS.**', 'deploy/vm/push.sh sles@<ip>\n',
    '**Acceptance.**', '**Delete the Debian disk.**',
  ];
  let last = -1;
  for (const step of order) {
    const i = runbook.indexOf(step, last + 1);
    assert.ok(i > last, `in order: ${step}`);
    last = i;
  }
  // The checks after first boot include the size of /: the image is 1.4 GiB.
  assert.match(runbook, /getenforce; df -h \/'/);
  assert.ok(runbook.indexOf('ssh -t sles@<ip> sudo passwd sles') > runbook.indexOf("'sudo bash -s' < deploy/vm/provision.sh"),
    'sles gets a console password once provisioned');
  // A way back while the Debian disk is kept: the first-boot wizard, and a
  // second write through the same checks.
  const recovery = runbook.slice(runbook.indexOf('### If Leap does not come up'));
  assert.ok(recovery.length < runbook.length, 'there is a recovery section');
  assert.match(runbook, /\[If Leap does not come up\]\(#if-leap-does-not-come-up\)/);
  assert.match(recovery, /jeos-firstboot/);
  assert.ok(recovery.indexOf("ssh root@<ip> 'bash -s -- --overwrite' < deploy/vm/bootstrap-opensuse.sh")
    < recovery.indexOf("ssh root@<ip> 'bash -s -- --overwrite /dev/vdb' < deploy/vm/bootstrap-opensuse.sh"), 'the plan first');
  assert.ok(!/wipefs/.test(readme), 'no hand-run wipefs: --overwrite keeps the checks');
  // Root logs in only to the Debian server, for the bootstrap.
  for (const line of readme.split('\n').filter((l) => l.includes('root@'))) {
    assert.match(line, /bootstrap-opensuse\.sh/, `root only for the bootstrap: ${line}`);
  }
  assert.ok(!/ubuntu/i.test(readme), 'no Ubuntu left in the runbook');
  const docs = readFileSync(join(VM, '..', '..', 'docs', 'deployment.md'), 'utf8');
  const vm = docs.slice(docs.indexOf('## Single VM with Caddy'), docs.indexOf('## Vercel'));
  assert.ok(vm.includes('bootstrap-opensuse.sh') && !/ubuntu/i.test(vm), 'docs/deployment.md describes the openSUSE kit');
});
