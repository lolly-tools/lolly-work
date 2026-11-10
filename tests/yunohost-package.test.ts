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
import { generateKeyPairSync } from 'node:crypto';
import { createServer as createHttpServer, type Server } from 'node:http';
import { existsSync, readFileSync, readdirSync, statSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig, type Secrets } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { csrfVerdict } from '../server/src/iam/csrf.ts';
import { INVITE_PAGE_HEADERS } from '../server/src/access/invite-routes.ts';
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
  // Set by lollywork_add_shell_headers, the open-source package's models host.
  lolly_csp_models_host: ' https://lolli.li',
  catalog_signing_key: JSON.stringify(generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ format: 'jwk' })),
  catalog_generation: '4',
  nextcloud_providers: '[]', nextcloud_destinations: '[]', nextcloud_private_origins: '[]', nextcloud_credential: '',
  catalog_public_key: readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'yunohost', 'conf', 'catalog-public-key.json'), 'utf8').trim(),
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
  for (const key of ['access_mode', 'telemetry', 'guest_links', 'hooks_fast_path', 'session_secret', 'link_secret', 'proxy_secret',
    'catalog_signing_key', 'catalog_generation']) {
    assert.match(read('scripts/install'), new RegExp(`ynh_app_setting_set --key=${key} `), `install must write the ${key} setting`);
  }
  // The models host is not a setting either: this package always serves the hosted models.
  assert.match(read('scripts/_common.sh'), /local lolly_csp_models_host=" https:\/\/lolli\.li"/);
  // catalog_public_key is not a setting: lollywork_add_config reads the pinned file.
  assert.match(read('scripts/_common.sh'), /catalog_public_key=\$\(tr -d '\\n' < "\$YNH_APP_BASEDIR\/conf\/catalog-public-key\.json"\)/);
  for (const key of ['access_mode', 'telemetry', 'guest_links', 'hooks_fast_path', 'instance_name']) {
    assert.match(read('scripts/upgrade'), new RegExp(`ynh_app_setting_set_default --key=${key} `), `upgrade must default the ${key} setting`);
  }
  // The config panel edits exactly those settings, and reapplies the template.
  const panel = read('config_panel.toml');
  for (const key of ['instance_name', 'access_mode', 'guest_links', 'telemetry', 'hooks_fast_path']) assert.match(panel, new RegExp(`\\[main\\.[a-z]+\\.${key}\\]`));
  assert.match(read('scripts/config'), /lollywork_add_config/);
});

test('catalogue signing: every install and upgrade publishes a signed catalogue', () => {
  // Without LW_CATALOG_SIGNING_KEY the server answers 404 for tools/index.sig.json and
  // /api/v1/catalog/public-key, so the key-pinned web app lists no tools (1.1.3~ynh1).
  assert.match(read('conf/.env'), /^LW_CATALOG_SIGNING_KEY='__CATALOG_SIGNING_KEY__'$/m);
  const install = read('scripts/install');
  assert.match(install, /catalog_signing_key=\$\(lollywork_new_catalog_key\)/);
  assert.ok(install.indexOf('lollywork_shell_catalog_seq') > install.indexOf('--source_id="shell"'), 'the generation is read after the shell is unpacked');
  const upgrade = read('scripts/upgrade');
  assert.match(upgrade, /if \[ -z "\$\{catalog_signing_key:-\}" \]; then\n\s+catalog_signing_key=\$\(lollywork_new_catalog_key\)/, 'upgrade gives an older install a key and keeps an existing one');
  assert.match(upgrade, /if \[ "\$shell_seq" -gt "\$\{catalog_generation:-0\}" \]; then/, 'the generation never goes down');
  // The pinned publisher key is the one the ready-made package pins, public only.
  const pinned = JSON.parse(SAMPLE.catalog_public_key) as Record<string, string>;
  const release = JSON.parse(readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'deploy', 'marketplaces', 'release.json'), 'utf8')) as { sourceCatalogPublicKey: Record<string, string> };
  assert.deepEqual(pinned, { kty: 'EC', crv: 'P-256', x: release.sourceCatalogPublicKey.x, y: release.sourceCatalogPublicKey.y });
  assert.ok(!('d' in pinned));
  // The rendered configuration carries both, so production mode can publish.
  const doc = JSON.parse(renderTemplate(read('conf/instance.json'), SAMPLE)) as { instance: Record<string, unknown> };
  assert.equal(doc.instance.catalogPublicationGeneration, 4);
  assert.deepEqual(doc.instance.catalogPublicKey, pinned);
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

  // nginx puts the server's own Referrer-Policy back on the control plane's routes
  // (the Referrer-Policy test below), so every answer carries one: no-referrer by
  // default, and strict-origin on a page whose forms must keep their Origin.
  for (const path of ['/healthz', '/api/auth/config', '/l/no-such-link', '/render/no-such-tool']) {
    assert.equal((await fetch(`${base}${path}`)).headers.get('referrer-policy'), 'no-referrer', path);
  }
  assert.equal((await fetch(`${base}/l/invite/no-such-token`)).headers.get('referrer-policy'), 'strict-origin');
});

test('manifest: whole domain, Node 24, Postgres, and the permission layout the sign-in relies on', () => {
  assert.match(manifest, /^packaging_format = 2$/m);
  assert.match(manifest, /^id = "lolly-work"$/m);
  assert.match(manifest, /^helpers_version = "2\.1"$/m);
  assert.doesNotMatch(manifest, /^\s*\[install\.path\]/m, 'no path question: the app reserves a whole domain');
  assert.match(manifest, /^\s*\[resources\.nodejs\]\s*\n(?:\s*#.*\n)*\s*version = "24"$/m, 'the server needs Node 24');
  assert.match(manifest, /^\s*type = "postgresql"$/m);
  assert.match(manifest, /^\s*\[resources\.apt\]\s*\n\s*packages = "postgresql"$/m);
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
  assert.match(manifest, /^\s*api\.additional_urls = \["\/scim", "\/healthz", "\/readyz", "\/metrics", "\/l", "\/render", "\/connect", "\/ws", "\/brand", "\/\.well-known\/lolly-brand\.json"\]$/m);
  assert.doesNotMatch(manifest, /"re:/, 'permission prefixes follow the current manifest schema');
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
  assert.ok([tarballName(pins.version), tarballName(pins.version, pins.ynhRev)]
    .some(name => pins.main.url === `${RELEASE_HOST}/${name}`), 'the archive URL matches its exact version and optional packaging revision');
  assert.match(pins.main.sha256, /^[0-9a-f]{64}$/);
  assert.match(pins.shell.url, new RegExp(`^${RELEASE_HOST}/lolly-web-\\d+\\.\\d+\\.\\d+(?:-ynh[1-9]\\d*)?\\.tar\\.gz$`));
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
  assert.match(read('scripts/_common.sh'), /lollywork_add_nginx_includes\(\) \{\n\s+ynh_config_add --template="proxy\.inc"/);
  for (const name of ['install', 'upgrade']) {
    const s = read(`scripts/${name}`);
    // package_check decides the app is a web app (and so runs the URL checks and the
    // change-URL test) with `grep '^ynh_config_add_nginx' scripts/install`.
    assert.match(s, /^ynh_config_add_nginx$/m, `${name} must call ynh_config_add_nginx at the top level`);
    assert.ok(s.indexOf('lollywork_add_nginx_includes') < s.search(/^ynh_config_add_nginx$/m), `${name}: the includes must exist before nginx -t runs`);
  }
  assert.match(read('scripts/upgrade'), /--keep="instance\.json \.env shell"/, 'upgrade must keep the admin-editable files and the shell');
  assert.match(read('scripts/backup'), /ynh_psql_dump_db > db\.sql/);
  assert.match(read('scripts/restore'), /ynh_psql_db_shell < \.\/db\.sql/);
  assert.match(read('scripts/change_url'), /lollywork_add_config/, 'baseUrl must follow the domain');
  assert.match(read('config_panel.toml'), /choices = \["gated", "per-tool", "open"\]/, 'access-mode values use the schema-supported list form');
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
  for (const p of ['/api/', '/admin', '/activate', '/l/', '/render/', '/connect/', '/scim', '/healthz', '/readyz', '/ws/', '/metrics']) {
    assert.ok(locations.some((l) => l.path === p), `no pass-through location for ${p}`);
  }
  // proxy.inc carries the shared secret and the WebSocket upgrade.
  const proxy = read('conf/proxy.inc');
  assert.match(proxy, /proxy_set_header X-Lw-Proxy-Auth "__PROXY_SECRET__";/);
  assert.match(proxy, /proxy_set_header Upgrade \$http_upgrade;/);
  assert.match(proxy, /proxy_pass http:\/\/127\.0\.0\.1:__PORT__;/);
});

test('nginx: the control plane keeps the server\'s Referrer-Policy, so a form post keeps its Origin', () => {
  // The chain this pins. A form post from a no-referrer page carries `Origin: null`
  // (Fetch, "append a request Origin header"), and the CSRF check refuses that Origin
  // once the post carries a cookie, as the invitation, access request, link password
  // and sign-in forms all do. The server sends strict-origin on those pages for that
  // reason; a fixed no-referrer in nginx replaced it and every such form answered 403.
  const site = ['https://work.example.org'];
  assert.match(csrfVerdict('POST', { cookie: 'lw_form=x', origin: 'null' }, site) ?? '', /opaque origin/);
  assert.equal(csrfVerdict('POST', { cookie: 'lw_form=x', origin: 'https://work.example.org' }, site), null);
  assert.equal(INVITE_PAGE_HEADERS['referrer-policy'], 'strict-origin');
  const locations = [...nginx.matchAll(/location\s+(?:=|\^~|~)?\s*([^\s{]+)\s*\{([^{}]*)\}/g)].map((m) => ({ path: m[1]!, body: m[2]! }));
  const controlPlane = locations.filter((l) => !/shell-headers\.inc;/.test(l.body));
  assert.ok(controlPlane.some((l) => l.path === '/api/') && controlPlane.some((l) => l.path === '/l/'));
  for (const l of controlPlane) {
    const policies = [...l.body.matchAll(/more_set_headers "Referrer-Policy: ([^"]*)";/g)].map((m) => m[1]);
    assert.deepEqual(policies, ['$upstream_http_referrer_policy'], `${l.path} must put back the server's Referrer-Policy, never a fixed one`);
  }
});

test('nginx: the shell header set is the open-source package\'s, directive by directive, when a Lolly checkout is at hand', (t) => {
  // LOLLY_OSS_DIR names the checkout (the weekly engine-drift run clones one); otherwise a
  // ../lolly beside this repository is used. Without either there is nothing to compare.
  const oss = join(process.env.LOLLY_OSS_DIR ?? join(ROOT, '..', 'lolly'), 'deploy', 'yunohost', 'conf', 'security-headers.inc');
  if (!existsSync(oss)) return t.skip('no Lolly checkout to compare against: set LOLLY_OSS_DIR or place ../lolly beside this repo');
  const headers = (s: string) => new Map([...s.matchAll(/^more_set_headers "([^:]+): (.*)";$/gm)].map((m) => [m[1]!, m[2]!]));
  const ours = headers(read('conf/shell-headers.inc')), theirs = headers(readFileSync(oss, 'utf8'));
  assert.deepEqual([...ours.keys()], [...theirs.keys()], 'the same headers in the same order');
  const directives = (csp: string) => new Map(csp.split(';').map((d) => d.trim()).filter(Boolean).map((d) => [d.split(' ')[0]!, d]));
  for (const [name, value] of theirs) {
    if (name !== 'Content-Security-Policy') { assert.equal(ours.get(name), value, name); continue; }
    const mine = directives(ours.get(name)!), base = directives(value);
    assert.deepEqual([...mine.keys()], [...base.keys()], 'the same CSP directives in the same order');
    for (const [key, directive] of base) {
      // connect-src is the one directive an install extends: the open-source template leaves
      // a placeholder for storage origins, which this package lists after the shared base.
      if (key === 'connect-src') {
        const shared = directive.replace('__LOLLY_CSP_EXTRA_CONNECT_SRC__', '');
        assert.ok(mine.get(key) === shared || mine.get(key)!.startsWith(shared + ' '), `connect-src starts with the open-source base: ${shared}`);
      } else assert.equal(mine.get(key), directive, key);
    }
  }
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

// The Nextcloud connection: detection, prefilled settings, and the instance.json
// fragments the server accepts. Bash functions run for real; `yunohost` and the
// settings helpers are stand-ins for a host.
const NEXTCLOUD_HELPERS = String.raw`
set -e
ynh_print_info() { echo "info: $*" >&2; }
ynh_print_warn() { echo "warn: $*" >&2; }
ynh_app_setting_set() { echo "set ${'$'}{1#--key=}=${'$'}{2#--value=}" >> "$LOLLY_TEST_DIR/settings"; }
ynh_app_setting_set_default() {
    local key="${'$'}{1#--key=}"
    if [[ -z "${'$'}{!key:-}" ]]; then printf -v "$key" '%s' "${'$'}{2#--value=}"; ynh_app_setting_set "$@"; fi
}
yunohost() { cat "$LOLLY_TEST_DIR/apps.json"; }
source "$PKG/scripts/_common.sh"
`;

function nextcloudRun(body: string, appsJson: string, env: Record<string, string> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-work-nextcloud-'));
  writeFileSync(join(dir, 'apps.json'), appsJson);
  writeFileSync(join(dir, 'settings'), '');
  const result = spawnSync('bash', ['-c', NEXTCLOUD_HELPERS + body], {
    encoding: 'utf8', env: { ...process.env, PKG, LOLLY_TEST_DIR: dir, app: 'lolly-work', domain: 'work.example.org', ...env },
  });
  const settings = readFileSync(join(dir, 'settings'), 'utf8');
  rmSync(dir, { recursive: true, force: true });
  return { ...result, settings };
}

const APPS = JSON.stringify({ apps: [
  { id: 'wordpress', domain_path: 'blog.example.org/' },
  { id: 'nextcloud', domain_path: 'cloud.example.org/' },
] });
const CONNECTED = {
  nextcloud_enabled: 'true', nextcloud_url: 'https://cloud.example.org', nextcloud_username: 'lolly-federation',
  nextcloud_app_password: 'abcde-fghij-klmno-pqrst-uvwxy', nextcloud_catalog_folder: 'Lolly brand',
  nextcloud_catalog_groups: 'brand marketing', nextcloud_delivery_folder: 'Lolly delivery/Approved', nextcloud_delivery_groups: 'admins',
};

test('nextcloud: a Nextcloud app on the same server is detected and its address prefilled, nothing switched on', () => {
  const r = nextcloudRun('lollywork_nextcloud_defaults', APPS);
  assert.equal(r.status, 0, r.stderr);
  assert.match(r.settings, /^set nextcloud_url=https:\/\/cloud\.example\.org$/m);
  assert.match(r.settings, /^set nextcloud_enabled=false$/m);
  assert.match(r.stderr, /Found Nextcloud at https:\/\/cloud\.example\.org/);
  const sub = nextcloudRun('lollywork_detect_nextcloud', JSON.stringify({ apps: [{ id: 'nextcloud__2', domain_path: 'example.org/nextcloud' }] }));
  assert.equal(sub.stdout, 'https://example.org/nextcloud');
  const none = nextcloudRun('lollywork_detect_nextcloud', JSON.stringify({ apps: [{ id: 'wordpress', domain_path: 'blog.example.org/' }] }));
  assert.equal(none.stdout, '');
  const garbled = nextcloudRun('lollywork_detect_nextcloud', 'not json');
  assert.equal(garbled.status, 0);
  assert.equal(garbled.stdout, '');
  // An address the admin already entered is not overwritten by detection.
  const kept = nextcloudRun('lollywork_nextcloud_defaults', APPS, { nextcloud_url: 'https://other.example.net' });
  assert.doesNotMatch(kept.settings, /nextcloud_url=/);
});

test('nextcloud: the settings render a WebDAV catalog source and delivery destination the server accepts', () => {
  const r = nextcloudRun(`lollywork_nextcloud_vars
printf '%s\n' "$nextcloud_providers" "$nextcloud_destinations" "$nextcloud_private_origins" "$nextcloud_credential"`, APPS, CONNECTED);
  assert.equal(r.status, 0, r.stderr);
  const [providers, destinations, origins, credential] = r.stdout.trim().split('\n') as [string, string, string, string];
  assert.equal(credential, 'lolly-federation:abcde-fghij-klmno-pqrst-uvwxy');
  const rendered = renderTemplate(read('conf/instance.json'), {
    ...SAMPLE, nextcloud_providers: providers, nextcloud_destinations: destinations, nextcloud_private_origins: origins, nextcloud_credential: credential,
  });
  const cfg = parseConfig(rendered);
  assert.equal(cfg.catalogProviders.length, 1);
  const source = cfg.catalogProviders[0]!;
  assert.equal(source.kind, 'webdav');
  assert.equal(source.credentialRef, 'LW_PROVIDER_NEXTCLOUD');
  assert.deepEqual(source.options, { baseUrl: 'https://cloud.example.org', flavor: 'nextcloud', username: 'lolly-federation', root: 'Lolly brand', recursive: true });
  assert.deepEqual(source.exposure, { groups: ['brand', 'marketing'] });
  assert.equal(cfg.delivery.destinations.length, 1);
  const destination = cfg.delivery.destinations[0]!;
  assert.equal(destination.kind, 'webdav');
  assert.equal(destination.credentialRef, 'LW_DESTINATION_NEXTCLOUD');
  assert.deepEqual(destination.options, { url: 'https://cloud.example.org/remote.php/dav/files/lolly-federation/Lolly%20delivery/Approved' });
  assert.deepEqual(destination.groups, ['admins']);
  assert.deepEqual(cfg.network.providers.allowedPrivateOrigins, ['https://cloud.example.org'], 'a Nextcloud on this host resolves to a private address');
  // The credential reaches both environment variables, and never the JSON.
  const env = renderTemplate(read('conf/.env'), { ...SAMPLE, nextcloud_credential: credential });
  assert.match(env, /^LW_PROVIDER_NEXTCLOUD='lolly-federation:abcde-fghij-klmno-pqrst-uvwxy'$/m);
  assert.match(env, /^LW_DESTINATION_NEXTCLOUD='lolly-federation:abcde-fghij-klmno-pqrst-uvwxy'$/m);
  assert.ok(!rendered.includes('abcde-fghij'));
});

test('nextcloud: off, incomplete or empty delivery folder never breaks the configuration', () => {
  const off = nextcloudRun(`lollywork_nextcloud_vars\nprintf '%s|%s|%s|%s' "$nextcloud_providers" "$nextcloud_destinations" "$nextcloud_private_origins" "$nextcloud_credential"`, APPS, { ...CONNECTED, nextcloud_enabled: 'false' });
  assert.equal(off.stdout, '[]|[]|[]|');
  const partial = nextcloudRun(`lollywork_nextcloud_vars\nprintf '%s|%s' "$nextcloud_providers" "$nextcloud_credential"`, APPS, { ...CONNECTED, nextcloud_app_password: '' });
  assert.equal(partial.status, 0, partial.stderr);
  assert.equal(partial.stdout, '[]|');
  assert.match(partial.stderr, /incomplete/);
  const noDelivery = nextcloudRun(`lollywork_nextcloud_vars\nprintf '%s|%s' "$nextcloud_providers" "$nextcloud_destinations"`, APPS, { ...CONNECTED, nextcloud_delivery_folder: '' });
  assert.match(noDelivery.stdout, /"kind":"webdav".*\|\[\]$/);
});

test('nextcloud: values that could change the JSON, the URL or the credential are refused', () => {
  for (const [key, value] of [
    ['nextcloud_url', 'http://cloud.example.org'], ['nextcloud_url', 'https://user:pw@cloud.example.org'], ['nextcloud_url', 'https://cloud.example.org/?x=1'],
    ['nextcloud_username', 'a:b'], ['nextcloud_username', 'a"b'], ['nextcloud_app_password', "ab'cdefghi"], ['nextcloud_app_password', 'short'],
    ['nextcloud_catalog_folder', '../etc'], ['nextcloud_catalog_folder', 'a"b'], ['nextcloud_delivery_folder', 'a/../b'],
    ['nextcloud_catalog_groups', 'a" b'], ['nextcloud_delivery_groups', 'Admins;'],
  ] as const) {
    const r = nextcloudRun('lollywork_nextcloud_check', APPS, { ...CONNECTED, [key]: value });
    assert.notEqual(r.status, 0, `${key}=${value} was accepted`);
  }
  assert.equal(nextcloudRun('lollywork_nextcloud_check', APPS, CONNECTED).status, 0);
});

test('nextcloud: the config panel, scripts and template are wired together', () => {
  const panel = read('config_panel.toml');
  for (const key of ['nextcloud_enabled', 'nextcloud_url', 'nextcloud_username', 'nextcloud_app_password', 'nextcloud_catalog_folder', 'nextcloud_catalog_groups', 'nextcloud_delivery_folder', 'nextcloud_delivery_groups']) {
    assert.match(panel, new RegExp(`\\[main\\.nextcloud\\.${key}\\]`));
  }
  assert.match(panel, /\[main\.nextcloud\.nextcloud_app_password\][^[]*type = "password"/);
  assert.match(read('scripts/install'), /lollywork_nextcloud_defaults/);
  assert.match(read('scripts/upgrade'), /lollywork_nextcloud_defaults/);
  assert.match(read('scripts/config'), /get__nextcloud_detected/);
  assert.match(read('scripts/_common.sh'), /yunohost app list --output-as json/);
});
