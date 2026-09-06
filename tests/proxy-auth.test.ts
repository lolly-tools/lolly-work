/**
 * Reverse-proxy sign-in (server/src/iam/proxy-auth.ts, GET /api/auth/proxy):
 * the authenticating proxy in front of the instance states who the person is
 * in request headers, the shared secret proves the request came through it,
 * and an optional LDAP read fills attributes and groups. Exercised end to end
 * over HTTP with the memory store, and against the fake directory in
 * fake-ldap.ts for the YunoHost shape (memberOf groups, app permissions).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { createServer as createHttpServer, type Server as HttpServer } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig, loadSecrets, type Secrets } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { rateLimitSurface } from '../server/src/observability/rate-limit.ts';
import { startFakeLdap, type FakeLdap } from './fake-ldap.ts';

const servers: HttpServer[] = [];
const directories: FakeLdap[] = [];
after(async () => {
  for (const s of servers) s.close();
  for (const d of directories) await d.close();
});

const SECRET = 'proxy-shared-secret-0123456789';
const YUNOHOST_HEADERS = { 'x-lw-proxy-auth': SECRET, ynh_user: 'alice', ynh_user_email: 'alice@example.test', ynh_user_fullname: 'Alice Liddell' };

async function boot(over: Record<string, unknown>, secrets: Secrets = { session: 's', link: 'l', proxyAuth: SECRET }) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-proxy-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Proxy Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    ...over,
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets });
  const server = createHttpServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { store, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

const PROXY = { enabled: true, displayName: 'YunoHost' };

const signIn = (base: string, headers: Record<string, string>, query = '') =>
  fetch(`${base}/api/auth/proxy${query}`, { headers, redirect: 'manual' });

const sessionCookie = (res: Response): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];

async function whoami(base: string, cookie: string) {
  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return (await res.json() as { user: { sub: string; email: string; groups: string[]; role: string } }).user;
}

test('config: the provider must be described, and it satisfies the gated-access requirement on its own', () => {
  const base = { instance: { pack: '.' }, rateLimit: { enabled: false } };
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { enabled: true } })), /proxyAuth.displayName/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, secretRef: 'lower' } })), /secretRef/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, headers: { user: '' } } })), /headers.user/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, directory: { userDn: 'uid=alice,ou=users' } } })), /\{user\}/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, directory: { groupMap: [{ attribute: 'memberOf', pattern: '(' }] } } })), /does not compile/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, directory: { groupMap: [{ attribute: 'memberOf', pattern: 'cn=.*' }] } } })), /capture group/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, directory: { url: 'ldaps://x' } } })), /ldap:\/\//);
  assert.throws(() => parseConfig(JSON.stringify(base)), /gated access needs idp.issuer or proxyAuth.enabled/);
  const cfg = parseConfig(JSON.stringify({ ...base, proxyAuth: { ...PROXY, headers: { user: 'Remote-User' }, directory: { groupMap: [] } } }));
  assert.equal(cfg.proxyAuth.headers.user, 'remote-user', 'header names are lowercased for lookup');
  assert.equal(cfg.proxyAuth.headers.email, 'ynh_user_email', 'unset header names keep the SSOwat defaults');
  assert.equal(cfg.proxyAuth.directory?.url, 'ldap://127.0.0.1:389');
  assert.equal(cfg.proxyAuth.directory?.attributes.email, 'mail');
});

test('secrets: the env var proxyAuth.secretRef names is required in production when the provider is on', () => {
  const cfg = parseConfig(JSON.stringify({ instance: { pack: '.' }, proxyAuth: { ...PROXY, secretRef: 'MY_PROXY_SECRET', directory: { bindDn: 'cn=reader', bindPasswordRef: 'MY_BIND_PW' } } }));
  const env = { NODE_ENV: 'production', LW_SESSION_SECRET: 's', LW_LINK_SECRET: 'l' } as unknown as NodeJS.ProcessEnv;
  assert.throws(() => loadSecrets(env, cfg), /MY_PROXY_SECRET is required in production/);
  const loaded = loadSecrets({ ...env, MY_PROXY_SECRET: 'abc', MY_BIND_PW: 'pw' } as unknown as NodeJS.ProcessEnv, cfg);
  assert.equal(loaded.proxyAuth, 'abc');
  assert.equal(loaded.proxyAuthBind, 'pw');
  assert.equal(loadSecrets(env).proxyAuth, undefined, 'without the config the ref cannot resolve and nothing is required');
});

test('the route is absent unless the provider is on, and it rides the auth rate-limit bucket', async () => {
  const { base } = await boot({ dev: { enabled: true, users: [{ email: 'd@test' }] } });
  assert.equal((await signIn(base, YUNOHOST_HEADERS)).status, 404);
  assert.equal(rateLimitSurface('GET', '/api/auth/proxy'), 'auth');
});

test('the shared secret gates everything: absent or wrong is 403 with an audit row and no cookie', async () => {
  const { base, store } = await boot({ proxyAuth: PROXY });
  const noSecret = await signIn(base, { ynh_user: 'alice' });
  assert.equal(noSecret.status, 403);
  assert.equal((await noSecret.json() as { error: { code: string } }).error.code, 'PROXY_SECRET_MISMATCH');
  assert.equal(sessionCookie(noSecret), undefined);
  const wrong = await signIn(base, { ...YUNOHOST_HEADERS, 'x-lw-proxy-auth': 'not-it' });
  assert.equal(wrong.status, 403);
  const rejected = (await store.listAudit()).filter((e) => e.action === 'auth.proxy.rejected');
  assert.equal(rejected.length, 2);
  assert.equal(JSON.stringify(rejected).includes('not-it'), false, 'the presented value is never recorded');

  // A correct secret but no identity header: the proxy let an anonymous request through.
  const anonymous = await signIn(base, { 'x-lw-proxy-auth': SECRET });
  assert.equal(anonymous.status, 401);
  assert.equal((await anonymous.json() as { error: { code: string } }).error.code, 'PROXY_NO_USER');
});

test('headers alone sign a member in: sub proxy:<user>, name split, member role, safe returnTo', async () => {
  const { base, store } = await boot({ proxyAuth: PROXY });
  const res = await signIn(base, YUNOHOST_HEADERS, '?returnTo=%2Fadmin%23%2Foverview');
  assert.equal(res.status, 302);
  assert.equal(res.headers.get('location'), '/admin#/overview');
  const cookie = sessionCookie(res);
  assert.ok(cookie, 'a member session was minted');
  const me = await whoami(base, cookie);
  assert.equal(me.sub, 'proxy:alice');
  assert.equal(me.email, 'alice@example.test');
  assert.deepEqual(me.groups, []);
  assert.equal(me.role, 'member');
  const row = await store.getUserBySub('proxy:alice');
  assert.equal(row?.firstname, 'Alice');
  assert.equal(row?.lastname, 'Liddell');
  const login = (await store.listAudit()).find((e) => e.action === 'auth.login');
  assert.deepEqual(login?.payload, { provider: 'proxy', directory: 'off' });

  const offsite = await signIn(base, YUNOHOST_HEADERS, '?returnTo=https%3A%2F%2Fevil.example%2F');
  assert.equal(offsite.headers.get('location'), '/', 'an off-site returnTo is not followed');
});

test('groups union: the proxy\'s groups header, static grants, and the role that falls out', async () => {
  const { base } = await boot({ proxyAuth: { ...PROXY, headers: { user: 'remote-user', email: 'remote-email', name: 'remote-name', groups: 'remote-groups' }, groups: { bob: ['owner'] } } });
  const alice = await signIn(base, { 'x-lw-proxy-auth': SECRET, 'remote-user': 'alice', 'remote-email': 'a@x', 'remote-groups': 'marketing, approver,, alice' });
  const me = await whoami(base, sessionCookie(alice)!);
  assert.deepEqual(me.groups, ['marketing', 'approver'], 'blank entries and the user\'s own name are dropped');
  assert.equal(me.role, 'approver');
  const bob = await signIn(base, { 'x-lw-proxy-auth': SECRET, 'remote-user': 'bob' });
  const him = await whoami(base, sessionCookie(bob)!);
  assert.deepEqual(him.groups, ['owner']);
  assert.equal(him.role, 'owner', 'the install-time owner grant makes an owner without a directory');
  assert.equal(him.email, 'bob', 'no mail anywhere: the login stands in');
});

test('the directory read (YunoHost shape): memberOf and app permissions become groups, attributes fill the blanks', async () => {
  const fake = await startFakeLdap({ entries: {
    'uid=alice,ou=users,dc=yunohost,dc=org': {
      mail: ['alice@directory.test'], givenName: ['Alice'], sn: ['Liddell'], cn: ['Alice Liddell'],
      memberOf: ['cn=alice,ou=groups,dc=yunohost,dc=org', 'cn=all_users,ou=groups,dc=yunohost,dc=org', 'cn=marketing,ou=groups,dc=yunohost,dc=org'],
      permission: ['cn=lollywork.main,ou=permission,dc=yunohost,dc=org', 'cn=lollywork.admin,ou=permission,dc=yunohost,dc=org', 'cn=nextcloud.main,ou=permission,dc=yunohost,dc=org'],
    },
  } });
  directories.push(fake);
  const directory = {
    url: fake.url,
    groupMap: [
      { attribute: 'memberOf', pattern: '^cn=([^,]+),ou=groups,dc=yunohost,dc=org$' },
      { attribute: 'permission', pattern: '^cn=lollywork\\.(owner|admin|approver|author),ou=permission,dc=yunohost,dc=org$' },
    ],
  };
  const { base, store } = await boot({ proxyAuth: { ...PROXY, directory } });
  // Only the login header: everything else comes from the directory.
  const res = await signIn(base, { 'x-lw-proxy-auth': SECRET, ynh_user: 'alice' });
  assert.equal(res.status, 302);
  const me = await whoami(base, sessionCookie(res)!);
  assert.equal(me.email, 'alice@directory.test');
  assert.deepEqual(me.groups, ['all_users', 'marketing', 'admin'], 'alice (own group), lollywork.main and nextcloud.main are not groups');
  assert.equal(me.role, 'admin');
  const row = await store.getUserBySub('proxy:alice');
  assert.equal(row?.firstname, 'Alice');
  assert.equal(row?.lastname, 'Liddell');
  assert.deepEqual(fake.searches.at(-1), {
    baseDn: 'uid=alice,ou=users,dc=yunohost,dc=org', scope: 0,
    attributes: ['mail', 'givenName', 'sn', 'cn', 'memberOf', 'permission'],
  });
  assert.deepEqual(fake.binds.at(-1), { dn: '', password: '' }, 'anonymous bind by default');
  const login = (await store.listAudit()).filter((e) => e.action === 'auth.login').at(-1);
  assert.deepEqual(login?.payload, { provider: 'proxy', directory: 'read' });

  // Header values win over directory values when both exist.
  const header = await signIn(base, { 'x-lw-proxy-auth': SECRET, ynh_user: 'alice', ynh_user_email: 'alice@header.test' });
  assert.equal((await whoami(base, sessionCookie(header)!)).email, 'alice@header.test');

  // A login the proxy vouches for but the directory does not know signs in with no groups at all.
  const ghost = await signIn(base, { 'x-lw-proxy-auth': SECRET, ynh_user: 'ghost,ou=admins' });
  assert.equal(ghost.status, 302);
  assert.equal(fake.searches.at(-1)?.baseDn, 'uid=ghost\\,ou\\=admins,ou=users,dc=yunohost,dc=org', 'the login is escaped into its RDN');
  assert.deepEqual((await whoami(base, sessionCookie(ghost)!)).groups, []);
});

test('a configured directory that does not answer fails the sign-in closed (502), never a lesser session', async () => {
  const probe = createServer();
  await new Promise<void>((r) => probe.listen(0, '127.0.0.1', () => r()));
  const port = (probe.address() as { port: number }).port;
  await new Promise<void>((r) => probe.close(() => r()));
  const { base, store } = await boot({ proxyAuth: { ...PROXY, groups: { alice: ['owner'] }, directory: { url: `ldap://127.0.0.1:${port}`, groupMap: [], timeoutMs: 1000 } } });
  const res = await signIn(base, YUNOHOST_HEADERS);
  assert.equal(res.status, 502);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'DIRECTORY_UNAVAILABLE');
  assert.equal(sessionCookie(res), undefined, 'no session - not even with the static owner grant');
  const rejected = (await store.listAudit()).find((e) => e.action === 'auth.proxy.rejected');
  assert.equal(rejected?.payload?.code, 'DIRECTORY_UNAVAILABLE');
  assert.match(String(rejected?.payload?.cause), /connect/);
});

test('the provider is advertised wherever sign-in is described, and a real IdP takes precedence', async () => {
  const { base } = await boot({ proxyAuth: PROXY });
  const cfg = await (await fetch(`${base}/api/auth/config`)).json() as Record<string, unknown>;
  assert.equal(cfg.provider, 'proxy');
  assert.equal(cfg.providerName, 'YunoHost');
  assert.equal(cfg.loginPath, '/api/auth/proxy');
  const card = await (await fetch(`${base}/api/v1/instance`)).json() as Record<string, unknown>;
  assert.equal(card.provider, 'proxy');
  assert.equal(card.providerName, 'YunoHost');
  assert.equal(card.loginPath, '/api/auth/proxy');

  const both = await boot({ proxyAuth: PROXY, idp: { issuer: 'https://id.example.test', clientId: 'lw', displayName: 'Example ID' } });
  const withIdp = await (await fetch(`${both.base}/api/auth/config`)).json() as Record<string, unknown>;
  assert.equal(withIdp.provider, 'oidc');
  assert.equal(withIdp.loginPath, '/api/auth/login');

  const proxyOverDev = await boot({ proxyAuth: PROXY, dev: { enabled: true, users: [{ email: 'd@test' }] } });
  const cfg2 = await (await fetch(`${proxyOverDev.base}/api/auth/config`)).json() as Record<string, unknown>;
  assert.equal(cfg2.provider, 'proxy', 'the accountable path wins over the dev bypass');
});

