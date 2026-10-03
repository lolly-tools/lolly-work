// SPDX-License-Identifier: MPL-2.0
/**
 * Email and password sign-in (plans/74) over real HTTP, on the memory store.
 * Pinned here: the configuration rules for `kind: "password"`, the chooser
 * and the server-rendered forms, the signed double-submit form token, the
 * one generic failure for an unknown email, a wrong password and a locked
 * credential, the lockout after ten failures and its reset on success, the
 * admin-issued one-time links (role, CSRF, admission, single use, expiry,
 * a new link revoking the old), and that a password sign-in finishes through
 * the same path as OIDC and GitHub: admission, invitations, linking by email,
 * "Disable access" and the safe returnTo all apply. Admin sessions come from
 * the dev provider.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { startupChecks } from '../server/src/setup/checks.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import type { Store } from '../server/src/store/types.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PASSWORD_ENTRY = { id: 'email', kind: 'password' };
const GOOGLE = { issuer: 'https://accounts.google.test', clientId: 'g-client', displayName: 'Google' };
const DEV = { enabled: true, users: [
  { email: 'owner@test', groups: ['owner'] },
  { email: 'admin@test', groups: ['admin'] },
  { email: 'member@test', groups: [] },
] };
const MISMATCH = 'That email and password do not match.';
const PW = 'a long enough passphrase';

function configJson(over: Record<string, unknown>, idp: Record<string, unknown>): string {
  return JSON.stringify({
    instance: { name: 'Password Team', baseUrl: 'https://team.example', pack: './packs/demo' },
    rateLimit: { enabled: false },
    dev: DEV,
    ...over,
    idp: { ...GOOGLE, additional: [PASSWORD_ENTRY], ...idp },
  });
}

async function boot(opts: { idp?: Record<string, unknown>; over?: Record<string, unknown> } = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pw-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const raw = JSON.parse(configJson(opts.over ?? {}, opts.idp ?? {})) as Record<string, Record<string, unknown>>;
  raw.instance!.pack = pack;
  const config = parseConfig(JSON.stringify(raw));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sPw', link: 'lPw' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

const cookieOf = (res: Response, name: string): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith(`${name}=`))?.split(';')[0];

async function devLogin(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return cookieOf(res, 'lw_session') as string;
}

/** Open a form page: its form cookie, the csrf field and the HTML. */
async function openForm(base: string, path: string) {
  const res = await fetch(`${base}${path}`, { redirect: 'manual' });
  const html = await res.text();
  const csrf = /name="csrf" value="([^"]+)"/.exec(html)?.[1] ?? '';
  return { res, html, csrf, cookie: cookieOf(res, 'lw_form') ?? '' };
}

function postForm(base: string, path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', ...(cookie ? { cookie } : {}), ...headers },
    body: new URLSearchParams(fields).toString(),
  });
}

async function login(base: string, email: string, password: string, returnTo = '/admin') {
  const form = await openForm(base, `/api/auth/login?idp=email&returnTo=${encodeURIComponent(returnTo)}`);
  return postForm(base, '/api/auth/password/login', { email, password, returnTo, csrf: form.csrf }, form.cookie);
}

function issueLink(base: string, cookie: string, email: string, purpose = 'setup', headers: Record<string, string> = {}) {
  return fetch(`${base}/api/v1/admin/password-links`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify({ email, purpose }),
  });
}

async function linkFor(base: string, admin: string, email: string, purpose = 'setup'): Promise<string> {
  const res = await issueLink(base, admin, email, purpose);
  assert.equal(res.status, 201, await res.clone().text());
  return ((await res.json()) as { url: string }).url;
}

/** Open the link's page and post a new password. */
async function setPassword(base: string, url: string, password: string, confirm = password) {
  const u = new URL(url);
  const form = await openForm(base, `${u.pathname}${u.search}`);
  assert.equal(form.res.status, 200, form.html);
  return postForm(base, '/api/auth/password/set', { token: u.searchParams.get('token') ?? '', password, confirm, csrf: form.csrf }, form.cookie);
}

async function sessionEmail(base: string, session: string | undefined): Promise<string | null> {
  if (!session) return null;
  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie: session } });
  return res.ok ? ((await res.json()) as { user: { email: string } }).user.email : null;
}

/** An account with a password: invitation (when admission is on), link, set. */
async function enrol(base: string, admin: string, email: string, password = PW) {
  const set = await setPassword(base, await linkFor(base, admin, email), password);
  assert.equal(set.status, 303, await set.clone().text());
  return set;
}

const auditOf = async (store: Store) => store.listAudit();

// ── configuration ─────────────────────────────────────────────────────────────

test('config: kind password needs no issuer, client or secret, and defaults its label', () => {
  const cfg = parseConfig(configJson({}, {}));
  const entry = cfg.idp.additional[0]!;
  assert.equal(entry.kind, 'password');
  assert.equal(entry.displayName, 'Email and password');
  assert.equal(entry.issuer, '');
  assert.equal(entry.clientId, '');
  assert.equal(parseConfig(configJson({}, { additional: [{ ...PASSWORD_ENTRY, label: 'Email' }] })).idp.additional[0]!.displayName, 'Email');
  assert.equal(parseConfig(configJson({}, { additional: [{ ...PASSWORD_ENTRY, displayName: 'Work email' }] })).idp.additional[0]!.displayName, 'Work email');

  // Email and password may stand alone, gated, with no issuer at all.
  const alone = parseConfig(configJson({ dev: { enabled: false } }, { issuer: '', clientId: '', displayName: '' }));
  assert.equal(alone.idp.issuer, '');
  assert.equal(alone.policy.defaultAccessMode, 'gated');
  // Every other additional entry still needs the primary.
  assert.throws(() => parseConfig(configJson({}, { issuer: '', additional: [PASSWORD_ENTRY, { id: 'gh', kind: 'github', clientId: 'x', displayName: 'GitHub', clientSecretRef: 'GH' }] })),
    /needs the primary idp.issuer/);

  // Setup treats the entry as complete: identity passes, no secret is missing.
  const checks = startupChecks(alone, { session: 'x'.repeat(32), link: 'y'.repeat(32) }, true, { NODE_ENV: 'production' });
  assert.equal(checks.find((c) => c.id === 'identity')?.status, 'pass');
  assert.equal(checks.find((c) => c.id === 'idp-secrets'), undefined);
});

test('config: one password entry at most, and nothing that does not apply', () => {
  const withEntry = (extra: Record<string, unknown>) => configJson({}, { additional: [{ ...PASSWORD_ENTRY, ...extra }] });
  assert.throws(() => parseConfig(configJson({}, { additional: [PASSWORD_ENTRY, { id: 'email2', kind: 'password' }] })), /one kind password entry at most/);
  for (const k of ['issuer', 'clientId', 'clientSecretRef', 'hostedDomain', 'tenantId']) {
    assert.throws(() => parseConfig(withEntry({ [k]: k === 'hostedDomain' ? 'example.com' : 'X' })), /does not apply to kind password/, k);
  }
  assert.throws(() => parseConfig(withEntry({ scopes: ['openid'] })), /does not apply to kind password/);
  assert.throws(() => parseConfig(withEntry({ emailVerification: 'trusted' })), /can only be "claim"/);
  assert.throws(() => parseConfig(withEntry({ label: '' })), /label must be a short name/);
  assert.throws(() => parseConfig(withEntry({ label: 'A', displayName: 'B' })), /label and displayName differently/);
  assert.throws(() => parseConfig(configJson({}, { additional: [{ id: 'password', issuer: 'https://x.test', clientId: 'c', displayName: 'X' }] })),
    /reserved for kind password/);
  assert.throws(() => parseConfig(configJson({}, { additional: [{ id: 'kc', issuer: 'https://x.test', clientId: 'c', displayName: 'X', label: 'Y' }] })),
    /label is for kind password/);
});

// ── chooser and forms ─────────────────────────────────────────────────────────

test('chooser lists the password entry; the form renders with a form token and strict headers', async () => {
  const { base } = await boot();
  const cfg = (await (await fetch(`${base}/api/auth/config`)).json()) as { provider: string; providers: Array<{ id: string; kind: string; name: string; loginPath: string }> };
  assert.equal(cfg.provider, 'oidc');
  assert.deepEqual(cfg.providers.map((p) => [p.id, p.kind, p.name]), [['primary', 'oidc', 'Google'], ['email', 'password', 'Email and password']]);

  const chooser = await (await fetch(`${base}/api/auth/login?returnTo=%2Fadmin`)).text();
  assert.ok(chooser.includes('Sign in with Google'));
  assert.ok(chooser.includes('Sign in with email and password'));
  assert.ok(chooser.includes('href="/api/auth/login?idp=email&amp;returnTo=%2Fadmin"'));

  const form = await openForm(base, '/api/auth/login?idp=email&returnTo=%2Fadmin');
  assert.equal(form.res.status, 200);
  assert.match(form.res.headers.get('content-security-policy') ?? '', /form-action 'self'/);
  assert.match(form.res.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  assert.equal(form.res.headers.get('cache-control'), 'no-store');
  assert.equal(form.res.headers.get('referrer-policy'), 'no-referrer');
  assert.ok(form.cookie.startsWith('lw_form='), 'the signed half of the form token');
  assert.match(form.res.headers.getSetCookie().join('\n'), /lw_form=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Strict/);
  assert.ok(form.csrf.length >= 20);
  assert.ok(form.html.includes('action="/api/auth/password/login"'));
  assert.ok(form.html.includes('name="returnTo" value="/admin"'));
  assert.ok(form.html.includes('Forgot your password? Ask the person who invited you for a new sign-in link.'));
  assert.ok(form.html.includes('Other ways to sign in'));
  assert.ok(!/<script/i.test(form.html));

  // A reload keeps the nonce, so two open tabs do not invalidate each other.
  const again = await fetch(`${base}/api/auth/login?idp=email`, { headers: { cookie: form.cookie } });
  assert.ok((await again.text()).includes(`value="${form.csrf}"`));

  // Not something a member links by hand.
  const member = await devLogin(base, 'member@test');
  const ids = (await (await fetch(`${base}/api/v1/me/identities`, { headers: { cookie: member } })).json()) as { available: Array<{ id: string }> };
  assert.deepEqual(ids.available.map((a) => a.id), ['primary']);
  const link = await fetch(`${base}/api/auth/link?idp=email`, { headers: { cookie: member }, redirect: 'manual' });
  assert.equal(link.status, 400);
});

test('password as the only sign-in: /api/auth/login is the form itself', async () => {
  const { base } = await boot({ idp: { issuer: '', clientId: '', displayName: '' }, over: { dev: { enabled: false } } });
  const cfg = (await (await fetch(`${base}/api/auth/config`)).json()) as { provider: string; loginPath: string; providers: Array<{ id: string }> };
  assert.equal(cfg.provider, 'password');
  assert.equal(cfg.loginPath, '/api/auth/login');
  assert.deepEqual(cfg.providers.map((p) => p.id), ['email']);
  const form = await openForm(base, '/api/auth/login?returnTo=%2Fadmin');
  assert.equal(form.res.status, 200);
  assert.ok(form.html.includes('action="/api/auth/password/login"'));
  assert.ok(!form.html.includes('Other ways to sign in'), 'nowhere else to go');
  assert.equal((await fetch(`${base}/api/auth/callback?code=x&state=y`)).status, 404, 'no OIDC callback without an issuer');
});

// ── links ─────────────────────────────────────────────────────────────────────

test('links: an admin session, user.invite and same-site requests only', async () => {
  const { base } = await boot();
  assert.equal((await fetch(`${base}/api/v1/admin/password-links`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.example', purpose: 'setup' }),
  })).status, 401);
  assert.equal((await issueLink(base, await devLogin(base, 'member@test'), 'a@x.example')).status, 403);

  const admin = await devLogin(base, 'admin@test');
  const blocked = await issueLink(base, admin, 'a@x.example', 'setup', { origin: 'https://evil.example' });
  assert.equal(blocked.status, 403);
  assert.equal(((await blocked.json()) as { error: { code: string } }).error.code, 'CSRF_BLOCKED');
  const crossSite = await issueLink(base, admin, 'a@x.example', 'setup', { 'sec-fetch-site': 'cross-site' });
  assert.equal(crossSite.status, 403);

  const bad = async (body: unknown, field: string) => {
    const res = await fetch(`${base}/api/v1/admin/password-links`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal(res.status, 400);
    assert.equal(((await res.json()) as { error: { field: string } }).error.field, field);
  };
  await bad({ email: 'not-an-address', purpose: 'setup' }, 'email');
  await bad({ email: 'a@x.example', purpose: 'other' }, 'purpose');

  const ok = await issueLink(base, admin, ' A@X.example ', 'setup');
  assert.equal(ok.status, 201);
  assert.equal(ok.headers.get('cache-control'), 'no-store');
  const body = (await ok.json()) as { url: string; expiresAt: string };
  assert.deepEqual(Object.keys(body).sort(), ['expiresAt', 'url']);
  const url = new URL(body.url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://team.example/api/auth/password/set');
  assert.match(url.searchParams.get('token') ?? '', /^[A-Za-z0-9_-]{43}$/);
  const days = (Date.parse(body.expiresAt) - Date.now()) / 86_400_000;
  assert.ok(days > 6.99 && days <= 7, `expires in seven days (${days})`);
});

test('links: only for an address admission lets in now, and owner-bound ones are owner-only', async () => {
  const { base } = await boot({ idp: { admission: { domains: ['partner.example'] }, bootstrapOwners: ['boss@partner.example'] } });
  const admin = await devLogin(base, 'admin@test');
  const owner = await devLogin(base, 'owner@test');

  const refused = await issueLink(base, admin, 'stranger@elsewhere.example');
  assert.equal(refused.status, 409);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'NOT_ADMITTED');
  assert.equal((await issueLink(base, admin, 'someone@partner.example')).status, 201, 'a listed domain');

  // An open invitation admits an address the lists do not.
  await fetch(`${base}/api/v1/invitations`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ emails: ['guest@elsewhere.example'] }) });
  assert.equal((await issueLink(base, admin, 'guest@elsewhere.example')).status, 201);

  // A bootstrap owner's address and an owner's account are owner-only.
  assert.equal((await issueLink(base, admin, 'boss@partner.example')).status, 403);
  assert.equal((await issueLink(base, owner, 'boss@partner.example')).status, 201);
  assert.equal((await issueLink(base, admin, 'owner@test')).status, 403);
});

test('set: the link page, then a password, signs the person in once; the link is spent', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  const url = await linkFor(base, admin, 'Ana@Partner.example');
  const u = new URL(url);

  const page = await openForm(base, `${u.pathname}${u.search}`);
  assert.equal(page.res.status, 200);
  assert.equal(page.res.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(page.res.headers.get('cache-control'), 'no-store');
  assert.ok(page.html.includes('value="ana@partner.example"'));
  assert.match(page.html, /name="email"[^>]*readonly/);
  assert.ok(page.html.includes('Set your password'));

  // A rule failure re-renders and does not spend the link.
  const short = await setPassword(base, url, 'too short');
  assert.equal(short.status, 400);
  assert.ok((await short.text()).includes('Use at least 12 characters.'));
  const mismatch = await setPassword(base, url, PW, `${PW}!`);
  assert.equal(mismatch.status, 400);
  assert.ok((await mismatch.text()).includes('The two passwords do not match.'));
  assert.equal((await setPassword(base, url, 'ana@partner.example')).status, 400, 'not the email address');

  const set = await setPassword(base, url, PW);
  assert.equal(set.status, 303);
  assert.equal(set.headers.get('location'), '/');
  assert.equal(set.headers.get('referrer-policy'), 'no-referrer');
  assert.equal(set.headers.get('cache-control'), 'no-store');
  assert.equal(await sessionEmail(base, cookieOf(set, 'lw_session')), 'ana@partner.example');

  const cred = await store.getPasswordCredential('ana@partner.example');
  assert.ok(cred && cred.hash.startsWith('scrypt$15$8$1$'));
  const user = (await store.findUsersByEmail('ana@partner.example'))[0]!;
  assert.equal(user.sub, `password:${cred.id}`);
  const rows = await store.listIdentities(user.id);
  assert.deepEqual(rows.map((r) => [r.idp, r.emailVerified]), [['email', true]]);

  // Single use: the same link again, opened or posted, no longer works.
  const reopened = await fetch(`${base}${u.pathname}${u.search}`);
  assert.equal(reopened.status, 410);
  assert.ok((await reopened.text()).includes('This link no longer works'));
  const form = await openForm(base, '/api/auth/login?idp=email');
  const replay = await postForm(base, '/api/auth/password/set', { token: u.searchParams.get('token')!, password: 'another long passphrase', confirm: 'another long passphrase', csrf: form.csrf }, form.cookie);
  assert.equal(replay.status, 410);
  assert.equal(cookieOf(replay, 'lw_session'), undefined);

  const actions = (await auditOf(store)).map((e) => e.action);
  assert.ok(actions.includes('auth.password.link.issue'));
  assert.ok(actions.includes('auth.password.set'));
  assert.ok(actions.includes('auth.login'));
  // Never a password, hash or token in the audit chain.
  const chain = JSON.stringify(await auditOf(store));
  assert.ok(!chain.includes(PW));
  assert.ok(!chain.includes(u.searchParams.get('token')!));
  assert.ok(!chain.includes(sha256Hex(u.searchParams.get('token')!)));
  assert.ok(!chain.includes(cred.hash));
});

test('set: a new link revokes the earlier unused one; an expired link fails', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  const first = await linkFor(base, admin, 'bo@partner.example');
  const second = await linkFor(base, admin, 'bo@partner.example', 'reset');
  const firstUrl = new URL(first);
  assert.equal((await fetch(`${base}${firstUrl.pathname}${firstUrl.search}`)).status, 410, 'the earlier link is gone');
  const set = await setPassword(base, second, PW);
  assert.equal(set.status, 303);

  const token = 'E'.repeat(43);
  await store.createPasswordLink({
    tokenHash: sha256Hex(token), email: 'cy@partner.example', purpose: 'setup', createdBy: 'user:x',
    createdAt: new Date(Date.now() - 8 * 86_400_000).toISOString(), expiresAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  assert.equal((await fetch(`${base}/api/auth/password/set?token=${token}`)).status, 410);
  assert.equal((await fetch(`${base}/api/auth/password/set?token=garbage`)).status, 410);
});

// ── sign-in ───────────────────────────────────────────────────────────────────

test('login: success mints a session and honours a same-origin returnTo; an off-origin one falls back to /', async () => {
  const { base } = await boot();
  const admin = await devLogin(base, 'admin@test');
  await enrol(base, admin, 'dee@partner.example');

  const ok = await login(base, ' Dee@Partner.Example ', PW, '/admin#/users');
  assert.equal(ok.status, 303);
  assert.equal(ok.headers.get('location'), '/admin#/users');
  assert.equal(await sessionEmail(base, cookieOf(ok, 'lw_session')), 'dee@partner.example');
  assert.match(ok.headers.getSetCookie().join('\n'), /lw_form=; Path=\/api\/auth/, 'the form cookie is cleared');

  for (const evil of ['https://evil.example/x', '//evil.example/x', '/\\evil.example']) {
    const off = await login(base, 'dee@partner.example', PW, evil);
    assert.equal(off.status, 303);
    assert.equal(off.headers.get('location'), '/', evil);
  }

  // JSON for an API caller: no form token, the cookie on the answer.
  const api = await fetch(`${base}/api/auth/password/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dee@partner.example', password: PW, returnTo: '/admin' }),
  });
  assert.equal(api.status, 200);
  assert.deepEqual(await api.json(), { ok: true, returnTo: '/admin' });
  assert.equal(await sessionEmail(base, cookieOf(api, 'lw_session')), 'dee@partner.example');
  const apiBad = await fetch(`${base}/api/auth/password/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'dee@partner.example', password: 'wrong wrong wrong' }),
  });
  assert.equal(apiBad.status, 400);
  assert.deepEqual(((await apiBad.json()) as { error: { code: string; message: string } }).error, { code: 'INVALID_CREDENTIALS', message: MISMATCH });
  assert.equal((await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: 'x' })).status, 415);
});

test('login: a wrong password and an unknown email get the same 400; the email is kept, the password never echoed', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'eve@partner.example');
  const wrong = await login(base, 'eve@partner.example', 'not the right passphrase');
  const unknown = await login(base, 'nobody@partner.example', 'not the right passphrase');
  assert.equal(wrong.status, 400);
  assert.equal(unknown.status, 400);
  const [a, b] = [await wrong.text(), await unknown.text()];
  assert.ok(a.includes(MISMATCH) && b.includes(MISMATCH));
  assert.equal(a.replace('eve@partner.example', 'X').replace(/name="csrf" value="[^"]+"/, ''),
    b.replace('nobody@partner.example', 'X').replace(/name="csrf" value="[^"]+"/, ''), 'the two pages differ only in the email typed');
  assert.ok(a.includes('value="eve@partner.example"'));
  assert.ok(!a.includes('not the right passphrase'));
  assert.equal(cookieOf(wrong, 'lw_session'), undefined);

  const fails = (await auditOf(store)).filter((e) => e.action === 'auth.password.fail').map((e) => e.payload);
  assert.deepEqual(fails[0], { provider: 'password', idp: 'email', reason: 'wrong-password', email: 'eve@partner.example' });
  assert.deepEqual(fails[1], { provider: 'password', idp: 'email', reason: 'unknown-email', emailHash: sha256Hex('nobody@partner.example').slice(0, 16) });
});

test('login: ten failures lock the credential; the right password is then refused the same way', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'flo@partner.example');
  for (let i = 0; i < 10; i++) assert.equal((await login(base, 'flo@partner.example', `wrong guess number ${i}`)).status, 400);
  const cred = await store.getPasswordCredential('flo@partner.example');
  assert.ok(cred?.lockedUntil && Date.parse(cred.lockedUntil) > Date.now() + 14 * 60_000, 'locked for fifteen minutes');
  const locked = await login(base, 'flo@partner.example', PW);
  assert.equal(locked.status, 400);
  assert.ok((await locked.text()).includes(MISMATCH));
  assert.equal(cookieOf(locked, 'lw_session'), undefined);
  const rows = await auditOf(store);
  assert.equal(rows.filter((e) => e.action === 'auth.password.locked').length, 1);
  assert.equal(rows.filter((e) => e.action === 'auth.password.fail').at(-1)?.payload?.reason, 'locked');
});

test('login: success resets the failure count', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'gus@partner.example');
  for (let round = 0; round < 2; round++) {
    for (let i = 0; i < 9; i++) await login(base, 'gus@partner.example', `wrong guess number ${i}`);
    assert.equal((await store.getPasswordCredential('gus@partner.example'))?.failedCount, 9);
    assert.equal((await login(base, 'gus@partner.example', PW)).status, 303, `round ${round}`);
    assert.equal((await store.getPasswordCredential('gus@partner.example'))?.failedCount, 0);
  }
});

test('login: a missing or forged form token is refused', async () => {
  const { base } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'hal@partner.example');
  const form = await openForm(base, '/api/auth/login?idp=email');
  const noField = await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW }, form.cookie);
  assert.equal(noField.status, 403);
  assert.equal(cookieOf(noField, 'lw_session'), undefined);
  const noCookie = await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW, csrf: form.csrf }, '');
  assert.equal(noCookie.status, 403);
  const wrongField = await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW, csrf: `${form.csrf}x` }, form.cookie);
  assert.equal(wrongField.status, 403);
  const forged = await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW, csrf: 'abc' }, 'lw_form=abc.def');
  assert.equal(forged.status, 403);
  const crossSite = await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW, csrf: form.csrf }, form.cookie, { origin: 'https://evil.example' });
  assert.equal(crossSite.status, 403, 'the dispatch-wide Origin check runs too');
  assert.equal((await postForm(base, '/api/auth/password/login', { email: 'hal@partner.example', password: PW, csrf: form.csrf }, form.cookie)).status, 303);
});

test('admission still applies: a revoked invitation refuses the next password sign-in', async () => {
  const { base, store } = await boot({ idp: { admission: { emails: [] } } });
  const admin = await devLogin(base, 'admin@test');
  const made = await fetch(`${base}/api/v1/invitations`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ emails: ['ivy@elsewhere.example'] }) });
  const invitationId = ((await made.json()) as { invitations: Array<{ id: string }> }).invitations[0]!.id;
  await enrol(base, admin, 'ivy@elsewhere.example');
  assert.equal((await store.getInvitation(invitationId))?.acceptedAt !== undefined, true, 'the sign-in accepted the invitation');
  assert.equal((await login(base, 'ivy@elsewhere.example', PW)).status, 303);

  await fetch(`${base}/api/v1/invitations/${invitationId}`, { method: 'DELETE', headers: { cookie: admin } });
  const refused = await login(base, 'ivy@elsewhere.example', PW);
  assert.equal(refused.status, 403);
  assert.ok((await refused.text()).includes('has not been invited'));
  assert.equal(cookieOf(refused, 'lw_session'), undefined);
  assert.deepEqual((await auditOf(store)).filter((e) => e.action === 'auth.denied').at(-1)?.payload,
    { provider: 'password', idp: 'email', reason: 'not-invited', email: 'ivy@elsewhere.example' });
});

test('"Disable access" stops password sign-in, and a disabled account gets no new link', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  await enrol(base, admin, 'jo@partner.example');
  const user = (await store.findUsersByEmail('jo@partner.example'))[0]!;
  const off = await fetch(`${base}/api/v1/users/${user.id}/disabled`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  assert.equal(off.status, 200);
  const refused = await login(base, 'jo@partner.example', PW);
  assert.equal(refused.status, 403);
  assert.ok((await refused.text()).includes('has been disabled'));
  assert.equal(cookieOf(refused, 'lw_session'), undefined);
  assert.equal((await issueLink(base, admin, 'jo@partner.example', 'reset')).status, 409);
});

test('a password sign-in joins the existing person who holds that verified email', async () => {
  const { base, store } = await boot({
    idp: { additional: [PASSWORD_ENTRY, { id: 'github', kind: 'github', clientId: 'gh', displayName: 'GitHub', clientSecretRef: 'LW_TEST_PW_GH' }] },
  });
  const kim = await store.upsertUserBySub({ sub: 'github:77', email: 'kim@partner.example', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.linkIdentity({ identitySub: 'github:77', userId: kim.id, idp: 'github', email: 'kim@partner.example', emailVerified: true, linkedAt: now, lastLoginAt: now });
  const admin = await devLogin(base, 'admin@test');

  // The person detail reports no password yet, and the address to use.
  const before = (await (await fetch(`${base}/api/v1/users/${kim.id}/identities`, { headers: { cookie: admin } })).json()) as { password: { set: boolean; email: string } };
  assert.deepEqual(before.password, { set: false, email: 'kim@partner.example' });

  const set = await enrol(base, admin, 'kim@partner.example');
  assert.equal(await sessionEmail(base, cookieOf(set, 'lw_session')), 'kim@partner.example');
  assert.equal((await store.findUsersByEmail('kim@partner.example')).length, 1, 'no second account');
  assert.deepEqual((await store.listIdentities(kim.id)).map((r) => r.idp).sort(), ['email', 'github']);
  assert.ok((await auditOf(store)).some((e) => e.action === 'identity.link' && e.payload?.via === 'email' && e.payload?.provider === 'password'));

  const afterSet = (await (await fetch(`${base}/api/v1/users/${kim.id}/identities`, { headers: { cookie: admin } })).json()) as { password: { set: boolean } };
  assert.equal(afterSet.password.set, true);
});

test('every password route rides the auth rate-limit bucket', async () => {
  const { base } = await boot({ over: { rateLimit: { enabled: true, auth: { capacity: 2, refillPerSec: 0.0001 } } } });
  const post = () => fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.example', password: 'whatever whatever' }) });
  assert.equal((await post()).status, 400);
  assert.equal((await post()).status, 400);
  assert.equal((await post()).status, 429);
  assert.equal((await fetch(`${base}/api/auth/password/set?token=${'A'.repeat(43)}`)).status, 429);
});
