/**
 * The YunoHost package under deploy/yunohost/ is mirrored verbatim to the
 * `lolly-work_ynh` app repository, where YunoHost's own CI installs it on a real
 * host. Nothing here can run that install. What this file holds instead is the
 * contract between the package and the server it configures:
 *
 *   - the templates the install script renders (instance.json, .env) use only
 *     placeholders YunoHost substitutes from install questions, resources and the
 *     settings the scripts write - and the rendered instance.json PARSES, with the
 *     proxy sign-in and the LDAP directory block pointing at what SSOwat and a
 *     YunoHost slapd actually provide;
 *   - the rendered configuration boots the app and a YunoHost-shaped sign-in
 *     (SSOwat's headers, the shared secret, a directory entry with `memberOf` and
 *     this app's `permission` DNs) signs in as the right member with the right role -
 *     the `__APP__`-derived group pattern included;
 *   - the manifest declares the permissions the nginx/SSOwat design relies on, its
 *     pins are self-consistent, and the scripts parse as bash and use only 2.1
 *     helper names;
 *   - the nginx location file includes the same three files the scripts write,
 *     and every location that sets a header opts into the header set on purpose.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type Secrets } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { startFakeLdap, type FakeLdap } from './fake-ldap.ts';
import { pinManifest, readPins, renderTemplate, tarballName, RELEASE_HOST } from '../scripts/yunohost-release.ts';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const PKG = join(ROOT, 'deploy', 'yunohost');
const read = (p: string): string => readFileSync(join(PKG, p), 'utf8');

const manifest = read('manifest.toml');
const nginx = read('conf/nginx.conf');

/** What an install of `lolly-work` on `work.example.org` gives the templates. */
const SAMPLE = {
  app: 'lolly-work', domain: 'work.example.org', port: '8787', install_dir: '/var/www/lolly-work',
  data_dir: '/home/yunohost.app/lolly-work', instance_name: 'Example Org', db_user: 'lolly_work', db_pwd: 'pw',
  db_name: 'lolly_work', session_secret: 's'.repeat(64), link_secret: 'l'.repeat(64), proxy_secret: 'p'.repeat(48),
  access_mode: 'gated', telemetry: 'standard', guest_links: 'true', hooks_fast_path: 'true',
};

const servers: Server[] = [];
const directories: FakeLdap[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of directories) await d.close();
});

test('templates: only placeholders the scripts can fill', () => {
  // Everything the scripts define: install questions + resources + the settings
  // install/upgrade write. A placeholder outside this set renders literally.
  const known = new Set(Object.keys(SAMPLE).map((k) => k.toUpperCase()));
  for (const file of ['conf/instance.json', 'conf/.env', 'conf/systemd.service', 'conf/nginx.conf', 'conf/proxy.inc', 'conf/shell-headers.inc']) {
    const used = [...read(file).matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]!);
    const unknown = used.filter((p) => !known.has(p) && !['PATH_WITH_NODEJS', 'NODEJS_DIR'].includes(p));
    assert.deepEqual(unknown, [], `${file} uses placeholders nothing defines: ${unknown.join(', ')}`);
  }
  // The settings the template needs are the ones install writes and upgrade defaults.
  for (const key of ['access_mode', 'telemetry', 'guest_links', 'hooks_fast_path', 'session_secret', 'link_secret', 'proxy_secret']) {
    assert.match(read('scripts/install'), new RegExp(`ynh_app_setting_set --key=${key} `), `install must write the ${key} setting`);
  }
  for (const key of ['access_mode', 'telemetry', 'guest_links', 'hooks_fast_path', 'instance_name']) {
    assert.match(read('scripts/upgrade'), new RegExp(`ynh_app_setting_set_default --key=${key} `), `upgrade must default the ${key} setting`);
  }
  // The config panel edits exactly those settings, and reapplies the template.
  const panel = read('config_panel.toml');
  for (const key of ['instance_name', 'access_mode', 'guest_links', 'telemetry', 'hooks_fast_path']) assert.match(panel, new RegExp(`\\[main\\.[a-z]+\\.${key}\\]`));
  assert.match(read('scripts/config'), /lollywork_add_config/);
});

test('instance.json: renders to a configuration the server accepts, shaped for YunoHost', () => {
  const rendered = renderTemplate(read('conf/instance.json'), SAMPLE);
  const cfg = parseConfig(rendered);
  assert.equal(cfg.instance.baseUrl, 'https://work.example.org', 'https: the Secure cookie flag follows baseUrl');
  assert.equal(cfg.instance.shellDir, '/var/www/lolly-work/shell');
  assert.equal(cfg.instance.pack, '/home/yunohost.app/lolly-work/pack');
  assert.equal(cfg.policy.defaultAccessMode, 'gated');
  assert.equal(cfg.dev.enabled, false, 'the passwordless dev provider must be off on a real instance');
  assert.equal(cfg.idp.issuer, '');
  assert.equal(cfg.rateLimit.trustedProxyHops, 1, 'nginx is in front: one proxy hop or every limit sees 127.0.0.1');
  // The SSOwat contract: YNH_USER / YNH_USER_EMAIL / YNH_USER_FULLNAME, lowercased
  // as Node exposes them, and the shared secret's env var name.
  assert.equal(cfg.proxyAuth.enabled, true);
  assert.equal(cfg.proxyAuth.displayName, 'YunoHost');
  assert.equal(cfg.proxyAuth.secretRef, 'LW_PROXY_AUTH_SECRET');
  assert.deepEqual(cfg.proxyAuth.headers, { user: 'ynh_user', email: 'ynh_user_email', name: 'ynh_user_fullname', groups: '' });
  // The directory: YunoHost's slapd, anonymous read, the two attributes it fills.
  const d = cfg.proxyAuth.directory!;
  assert.equal(d.url, 'ldap://127.0.0.1:389');
  assert.equal(d.userDn, 'uid={user},ou=users,dc=yunohost,dc=org');
  assert.equal(d.groupMap.length, 2);
  const perm = new RegExp(d.groupMap[1]!.pattern);
  assert.equal(perm.exec('cn=lolly-work.owner,ou=permission,dc=yunohost,dc=org')?.[1], 'owner');
  assert.equal(perm.exec('cn=lolly-work.main,ou=permission,dc=yunohost,dc=org'), null, 'main is access, not a role');
  assert.equal(perm.exec('cn=other-app.owner,ou=permission,dc=yunohost,dc=org'), null, 'another app\'s permission is not ours');
  assert.equal(new RegExp(d.groupMap[0]!.pattern).exec('cn=marketing,ou=groups,dc=yunohost,dc=org')?.[1], 'marketing');
  // A second instance renders its own app id into the pattern.
  const second = parseConfig(renderTemplate(read('conf/instance.json'), { ...SAMPLE, app: 'lolly-work__2' }));
  assert.match(second.proxyAuth.directory!.groupMap[1]!.pattern, /lolly-work__2\\\./);
  // The .env feeds the same process: the secret the config names is one it sets.
  const env = renderTemplate(read('conf/.env'), SAMPLE);
  assert.match(env, /^LW_PROXY_AUTH_SECRET=p{48}$/m);
  assert.match(env, /^DATABASE_URL=postgres:\/\/lolly_work:pw@127\.0\.0\.1:5432\/lolly_work$/m);
  assert.match(env, /^NODE_ENV=production$/m, 'production is what makes a missing secret fatal');
  assert.match(env, /^LW_CONFIG=\/var\/www\/lolly-work\/instance\.json$/m);
});

test('instance.json: the rendered configuration boots and a YunoHost sign-in arrives as the owner', async () => {
  // A YunoHost user entry as slapd serves it: cn/mail plus the memberOf overlay
  // and the permission attribute the app's role permissions become.
  const dir = await startFakeLdap({
    entries: {
      'uid=alice,ou=users,dc=yunohost,dc=org': {
        cn: ['Alice Liddell'], mail: ['alice@example.org'], givenName: ['Alice'], sn: ['Liddell'],
        memberOf: ['cn=alice,ou=groups,dc=yunohost,dc=org', 'cn=all_users,ou=groups,dc=yunohost,dc=org', 'cn=marketing,ou=groups,dc=yunohost,dc=org'],
        permission: ['cn=lolly-work.main,ou=permission,dc=yunohost,dc=org', 'cn=lolly-work.owner,ou=permission,dc=yunohost,dc=org', 'cn=nextcloud.main,ou=permission,dc=yunohost,dc=org'],
      },
    },
  });
  directories.push(dir);
  const pack = await mkdtemp(join(tmpdir(), 'lw-ynh-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const shell = await mkdtemp(join(tmpdir(), 'lw-ynh-shell-'));
  await writeFile(join(shell, 'index.html'), '<!doctype html><title>shell</title>');
  // Render the real template, then point the two paths and the directory at this test.
  const doc = JSON.parse(renderTemplate(read('conf/instance.json'), SAMPLE)) as Record<string, any>;
  doc.instance.pack = pack;
  doc.instance.shellDir = shell;
  doc.proxyAuth.directory.url = dir.url;
  doc.rateLimit.enabled = false;
  const config = parseConfig(JSON.stringify(doc));
  const secrets: Secrets = { session: 's', link: 'l', proxyAuth: SAMPLE.proxy_secret };
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets });
  const server = createHttpServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const auth = await (await fetch(`${base}/api/auth/config`)).json() as Record<string, unknown>;
  assert.equal(auth.provider, 'proxy');
  assert.equal(auth.providerName, 'YunoHost');
  assert.equal(auth.loginPath, '/api/auth/proxy');
  assert.equal(auth.mode, 'gated');

  // Exactly what nginx + SSOwat put on the request.
  const ssowat = { 'x-lw-proxy-auth': SAMPLE.proxy_secret, ynh_user: 'alice', ynh_user_email: 'alice@example.org', ynh_user_fullname: 'Alice Liddell', authorization: 'Basic ' + Buffer.from('alice:-').toString('base64') };
  const res = await fetch(`${base}/api/auth/proxy?returnTo=/admin`, { headers: ssowat, redirect: 'manual' });
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin');
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
  assert.ok(cookie, 'a member session was minted');
  const who = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: cookie! } })).json() as { user: { email: string; role: string; groups: string[] } };
  assert.equal(who.user.email, 'alice@example.org');
  assert.equal(who.user.role, 'owner', 'the lolly-work.owner permission is the owner role');
  assert.ok(who.user.groups.includes('marketing'), 'a YunoHost group is a lolly-work group');
  assert.ok(who.user.groups.includes('all_users'));
  assert.ok(!who.user.groups.includes('alice'), 'the per-user primary group is dropped');
  assert.ok(!who.user.groups.includes('main'), 'the access permission is not a group');
  assert.equal(dir.searches[0]?.baseDn, 'uid=alice,ou=users,dc=yunohost,dc=org');

  // Without the secret nginx adds, the same headers are worth nothing.
  const { 'x-lw-proxy-auth': _drop, ...bare } = ssowat;
  assert.equal((await fetch(`${base}/api/auth/proxy`, { headers: bare, redirect: 'manual' })).status, 403);
});

test('manifest: whole domain, Node 24, Postgres, and the permission layout the sign-in relies on', () => {
  assert.match(manifest, /^packaging_format = 2$/m);
  assert.match(manifest, /^id = "lolly-work"$/m);
  assert.match(manifest, /^helpers_version = "2\.1"$/m);
  assert.match(manifest, /^\s*full_domain = true$/m);
  assert.match(manifest, /^\s*\[resources\.nodejs\]\s*\n(?:\s*#.*\n)*\s*version = "24"$/m, 'the server needs Node 24');
  assert.match(manifest, /^\s*type = "postgresql"$/m);
  assert.match(manifest, /^ldap = true$/m);
  assert.match(manifest, /^sso = true$/m);
  assert.match(manifest, /^\s*\[install\.admin\]/m, 'the first owner is an install question');
  // /api/auth/proxy sits on its own protected permission: longer than /api, so it
  // wins SSOwat's longest-match, and never openable to visitors.
  assert.match(manifest, /^\s*sso\.url = "\/api\/auth\/proxy"$/m);
  assert.match(manifest, /^\s*sso\.protected = true$/m);
  assert.match(manifest, /^\s*sso\.auth_header = true$/m);
  assert.match(manifest, /^\s*main\.auth_header = true$/m);
  // The API is public to SSOwat (the server authenticates it) and stays so.
  assert.match(manifest, /^\s*api\.url = "\/api"$/m);
  assert.match(manifest, /^\s*api\.allowed = "visitors"$/m);
  assert.match(manifest, /^\s*api\.auth_header = false$/m);
  assert.match(manifest, /^\s*api\.protected = true$/m);
  // The four roles exist as permissions with no URL, named as the template's pattern expects.
  for (const role of ['owner', 'admin', 'approver', 'author']) {
    assert.match(manifest, new RegExp(`^\\s*${role}\\.show_tile = false$`, 'm'), `${role} permission missing`);
    assert.doesNotMatch(manifest, new RegExp(`^\\s*${role}\\.url =`, 'm'), `${role} must not be a URL permission`);
  }
  assert.match(manifest, /^\s*admin\.allowed = "admins"$/m);
  assert.match(read('scripts/install'), /lollywork_grant_first_owner/);
  assert.match(read('scripts/_common.sh'), /ynh_permission_update --permission="owner" --add="\$admin"/);
});

test('manifest: the two release pins are self-consistent', () => {
  const pins = readPins(manifest);
  assert.match(pins.version, /^\d+\.\d+\.\d+$/);
  assert.equal(pins.version, (JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string }).version, 'the manifest tracks package.json');
  assert.equal(pins.main.url, `${RELEASE_HOST}/${tarballName(pins.version)}`);
  assert.match(pins.main.sha256, /^[0-9a-f]{64}$/);
  assert.match(pins.shell.url, new RegExp(`^${RELEASE_HOST}/lolly-web-\\d+\\.\\d+\\.\\d+\\.tar\\.gz$`));
  assert.match(pins.shell.sha256, /^[0-9a-f]{64}$/);
  const pinned = pinManifest(manifest, { version: '9.9.9', ynhRev: 2, main: { url: `${RELEASE_HOST}/${tarballName('9.9.9')}`, sha256: 'ab'.repeat(32) }, shell: { url: `${RELEASE_HOST}/lolly-web-8.8.8.tar.gz`, sha256: 'cd'.repeat(32) } });
  const back = readPins(pinned);
  assert.equal(back.version, '9.9.9');
  assert.equal(back.ynhRev, 2);
  assert.equal(back.main.sha256, 'ab'.repeat(32));
  assert.equal(back.shell.url, `${RELEASE_HOST}/lolly-web-8.8.8.tar.gz`);
});

const SCRIPTS = ['install', 'upgrade', 'remove', 'backup', 'restore', 'change_url', 'config'];

test('scripts: present, executable, valid bash, helpers-2.1 names only', () => {
  const legacy = ['ynh_add_nginx_config', 'ynh_add_config', 'ynh_secure_remove', 'ynh_systemd_action', 'ynh_exec_warn_less', 'ynh_install_nodejs', 'ynh_use_nodejs', 'ynh_add_systemd_config', 'ynh_script_progression --', 'ynh_backup --src_path', 'ynh_restore_file', 'ynh_psql_test_if_first_run', 'ynh_exec_as '];
  for (const name of [...SCRIPTS, '_common.sh']) {
    const p = join(PKG, 'scripts', name);
    assert.ok(existsSync(p), `scripts/${name} missing`);
    assert.ok(statSync(p).mode & 0o111, `scripts/${name} is not executable`);
    const r = spawnSync('bash', ['-n', p], { encoding: 'utf8' });
    assert.equal(r.status, 0, `scripts/${name} does not parse: ${r.stderr}`);
    const s = readFileSync(p, 'utf8');
    for (const old of legacy) assert.ok(!s.includes(old), `scripts/${name} uses the pre-2.1 helper "${old}"`);
  }
  for (const name of SCRIPTS) {
    const s = read(`scripts/${name}`);
    const common = name === 'backup' || name === 'restore' ? 'source ../settings/scripts/_common.sh' : 'source _common.sh';
    assert.ok(s.includes(common), `${name} must source _common.sh as "${common}"`);
  }
  // Both sources land, in the order the seed step needs; the includes precede nginx.
  const install = read('scripts/install');
  assert.ok(install.indexOf('ynh_setup_source --dest_dir="$install_dir"') < install.indexOf('--source_id="shell"'));
  assert.ok(install.indexOf('lollywork_seed_pack') > install.indexOf('--source_id="shell"'));
  const common = read('scripts/_common.sh');
  assert.ok(common.indexOf('proxy.inc') < common.indexOf('ynh_config_add_nginx'), 'the includes must exist before nginx -t runs');
  assert.match(read('scripts/upgrade'), /--keep="instance\.json \.env shell"/, 'upgrade must keep the admin-editable files and the shell');
  assert.match(read('scripts/backup'), /ynh_psql_dump_db > db\.sql/);
  assert.match(read('scripts/restore'), /ynh_psql_db_shell < \.\/db\.sql/);
  assert.match(read('scripts/change_url'), /lollywork_add_config/, 'baseUrl must follow the domain');
});

test('nginx: the includes the scripts write, and a deliberate header set per location', () => {
  const placeholders = new Set([...nginx.matchAll(/__([A-Z_]+)__/g)].map((m) => m[1]));
  assert.deepEqual(placeholders, new Set(['DOMAIN', 'APP']));
  assert.match(nginx, /__APP__\.proxy\.inc;/);
  assert.match(nginx, /__APP__\.shell-headers\.inc;/);
  assert.match(read('scripts/_common.sh'), /proxy_inc="\/etc\/nginx\/conf\.d\/\$domain\.d\/\$app\.proxy\.inc"/);
  assert.match(read('scripts/_common.sh'), /shell_headers_inc="\/etc\/nginx\/conf\.d\/\$domain\.d\/\$app\.shell-headers\.inc"/);
  assert.doesNotMatch(nginx, /#(sub|root)_path_only/, 'full_domain: no sub-path markers');
  assert.doesNotMatch(nginx, /add_header/, 'YunoHost uses more_set_headers; mixing modules duplicates headers');
  const locations = [...nginx.matchAll(/location\s+(?:=|\^~)?\s*([^\s{]+)\s*\{([^{}]*)\}/g)].map((m) => ({ path: m[1]!, body: m[2]! }));
  assert.ok(locations.length >= 10);
  for (const l of locations) {
    assert.match(l.body, /__APP__\.proxy\.inc;/, `${l.path} does not hand off through proxy.inc`);
    // Each location either takes the shell's header set or puts the upstream's
    // CSP back: never nothing, because nothing means YunoHost's server-level
    // policy overwrites the control plane's own on that route.
    assert.ok(/shell-headers\.inc;|\$upstream_http_content_security_policy/.test(l.body), `${l.path} leaves YunoHost's server-level CSP in place, which would clobber the upstream's own policy`);
  }
  // The shell gets the app's policy; the control plane's own routes do not.
  const shellLocs = locations.filter((l) => /shell-headers\.inc;/.test(l.body)).map((l) => l.path);
  assert.deepEqual(shellLocs, ['/']);
  for (const p of ['/api/', '/admin', '/activate', '/l/', '/render/', '/connect/', '/scim', '/healthz', '/metrics']) {
    assert.ok(locations.some((l) => l.path === p), `no pass-through location for ${p}`);
  }
  // proxy.inc carries the shared secret and the WebSocket upgrade.
  const proxy = read('conf/proxy.inc');
  assert.match(proxy, /proxy_set_header X-Lw-Proxy-Auth "__PROXY_SECRET__";/);
  assert.match(proxy, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:__PORT__;/);
});

test('nginx: the shell header set is the open-source package\'s, when that checkout is beside this one', (t) => {
  const oss = join(ROOT, '..', 'lolly', 'deploy', 'yunohost', 'conf', 'security-headers.inc');
  if (!existsSync(oss)) return t.skip('no ../lolly checkout beside this repo to compare against');
  const lines = (s: string): string[] => s.split('\n').filter((l) => l.startsWith('more_set_headers'));
  assert.deepEqual(lines(read('conf/shell-headers.inc')), lines(readFileSync(oss, 'utf8')));
});

test('systemd: runs the server as the app user on the resource-provided Node, hardened', () => {
  const unit = read('conf/systemd.service');
  assert.match(unit, /^User=__APP__$/m);
  assert.match(unit, /^ExecStart=__NODEJS_DIR__\/node server\/src\/main\.ts$/m);
  assert.match(unit, /^Environment="PATH=__PATH_WITH_NODEJS__"$/m);
  assert.match(unit, /^EnvironmentFile=__INSTALL_DIR__\/\.env$/m);
  assert.match(unit, /^After=network\.target postgresql\.service$/m);
  assert.match(unit, /^NoNewPrivileges=yes$/m);
  assert.match(unit, /^ProtectSystem=full$/m, 'full leaves /home (the pack) writable; strict would need ReadWritePaths');
  assert.match(unit, /^PrivateTmp=yes$/m);
  assert.match(unit, /^TimeoutStopSec=\d+$/m, 'collab rooms drain on SIGTERM');
});

test('package: the files YunoHost and its catalog expect, and nothing stray', () => {
  for (const f of ['LICENSE', 'README.md', 'tests.toml', 'config_panel.toml', 'doc/DESCRIPTION.md', 'doc/ADMIN.md', 'doc/PRE_INSTALL.md', 'doc/POST_INSTALL.md']) {
    assert.ok(existsSync(join(PKG, f)), `${f} missing`);
  }
  assert.equal(read('LICENSE'), readFileSync(join(ROOT, 'LICENSE'), 'utf8'));
  assert.match(read('tests.toml'), /install\.subdir/);
  const allowed = new Set(['LICENSE', 'README.md', 'conf', 'config_panel.toml', 'doc', 'manifest.toml', 'scripts', 'tests.toml']);
  for (const entry of readdirSync(PKG)) assert.ok(allowed.has(entry), `unexpected ${entry} in deploy/yunohost/`);
});
