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

import { randomBytes, scryptSync } from 'node:crypto';

import { parseConfig } from '../server/src/config/instance.ts';
import { startupChecks } from '../server/src/setup/checks.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import type { Store } from '../server/src/store/types.ts';
import { resolveSignIn } from '../server/src/iam/identities.ts';
import { runPasswordLinkCommand } from '../server/src/iam/password-link-cli.ts';
import { withScryptSlot } from '../server/src/lib/crypto.ts';

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
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store, config };
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

/** A form post shaped like a browser's from one of these pages: a real
 *  Origin (strict-origin keeps it) and Sec-Fetch-Site. `headers` overrides. */
function postForm(base: string, path: string, fields: Record<string, string>, cookie: string, headers: Record<string, string> = {}) {
  return fetch(`${base}${path}`, {
    method: 'POST', redirect: 'manual',
    headers: {
      'content-type': 'application/x-www-form-urlencoded', origin: base, 'sec-fetch-site': 'same-origin',
      ...(cookie ? { cookie } : {}), ...headers,
    },
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
  // Not no-referrer: a form post from a no-referrer page carries Origin: null,
  // which the CSRF check refuses (see the browser-shaped post test below).
  assert.equal(form.res.headers.get('referrer-policy'), 'strict-origin');
  assert.ok(form.cookie.startsWith('lw_form='), 'the signed half of the form token');
  assert.match(form.res.headers.getSetCookie().join('\n'), /lw_form=[^;]+; Path=\/api\/auth; HttpOnly; SameSite=Strict/);
  assert.ok(form.csrf.length >= 20);
  assert.ok(form.html.includes('action="/api/auth/password/login"'));
  assert.ok(form.html.includes('name="returnTo" value="/admin"'));
  assert.ok(form.html.includes('No password yet, or forgot it? Ask the person who invited you for a sign-in link.'));
  assert.ok(form.html.includes('Other ways to sign in'));
  assert.ok(!/<script/i.test(form.html));

  // A reload keeps the nonce, so two open tabs do not invalidate each other.
  const again = await fetch(`${base}/api/auth/login?idp=email`, { headers: { cookie: form.cookie } });
  assert.ok((await again.text()).includes(`value="${form.csrf}"`));

  // Not something a member links by hand. A profile that draws a "Link"
  // button for every provider (the OSS shell reads /api/auth/config) opens
  // a page the person can read, with the way back, never raw JSON.
  const member = await devLogin(base, 'member@test');
  const ids = (await (await fetch(`${base}/api/v1/me/identities`, { headers: { cookie: member } })).json()) as { available: Array<{ id: string }> };
  assert.deepEqual(ids.available.map((a) => a.id), ['primary']);
  const link = await fetch(`${base}/api/auth/link?idp=email&returnTo=%2Fprofile`, { headers: { cookie: member }, redirect: 'manual' });
  assert.equal(link.status, 400);
  assert.match(link.headers.get('content-type') ?? '', /text\/html/);
  const linkPage = await link.text();
  assert.ok(linkPage.includes('Ask one of them for a sign-in link.'), linkPage);
  assert.ok(linkPage.includes('href="/profile"'), 'the way back');
  assert.ok(!linkPage.includes('NOT_LINKABLE'));
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
  assert.equal(page.res.headers.get('referrer-policy'), 'strict-origin', 'the token never leaves in a Referer, and the post keeps its Origin');
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
  // Stored unverified: the address is one an admin typed, so no later sign-in
  // through another provider ever joins this account by it.
  const rows = await store.listIdentities(user.id);
  assert.deepEqual(rows.map((r) => [r.idp, r.emailVerified]), [['email', false]]);
  assert.equal(cred.ownerIssued, false, 'issued by an admin');

  // Single use: the same link again, opened or posted, no longer works.
  const reopened = await fetch(`${base}${u.pathname}${u.search}`);
  assert.equal(reopened.status, 410);
  assert.ok((await reopened.text()).includes('This link no longer works'));
  assert.equal(reopened.headers.get('referrer-policy'), 'no-referrer', 'the dead-link page carries no form');
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

test('a password sign-in joins the existing person who holds that verified email; only an owner adds one', async () => {
  const { base, store } = await boot({
    idp: { additional: [PASSWORD_ENTRY, { id: 'github', kind: 'github', clientId: 'gh', displayName: 'GitHub', clientSecretRef: 'LW_TEST_PW_GH' }] },
  });
  const kim = await store.upsertUserBySub({ sub: 'github:77', email: 'kim@partner.example', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.linkIdentity({ identitySub: 'github:77', userId: kim.id, idp: 'github', email: 'kim@partner.example', emailVerified: true, linkedAt: now, lastLoginAt: now });
  const admin = await devLogin(base, 'admin@test');
  const owner = await devLogin(base, 'owner@test');

  // The person detail reports no password yet, and the address to use.
  const before = (await (await fetch(`${base}/api/v1/users/${kim.id}/identities`, { headers: { cookie: admin } })).json()) as { password: { set: boolean; email: string } };
  assert.deepEqual(before.password, { set: false, email: 'kim@partner.example' });

  // Whoever holds the link gets Kim's account, so an admin may not add a
  // password to an account that already signs in another way.
  const refused = await issueLink(base, admin, 'kim@partner.example');
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'OWNER_ONLY');

  const set = await enrol(base, owner, 'kim@partner.example');
  assert.equal(await sessionEmail(base, cookieOf(set, 'lw_session')), 'kim@partner.example');
  assert.equal((await store.findUsersByEmail('kim@partner.example')).length, 1, 'no second account');
  assert.deepEqual((await store.listIdentities(kim.id)).map((r) => r.idp).sort(), ['email', 'github']);
  assert.ok((await auditOf(store)).some((e) => e.action === 'identity.link' && e.payload?.via === 'email' && e.payload?.provider === 'password'));

  const afterSet = (await (await fetch(`${base}/api/v1/users/${kim.id}/identities`, { headers: { cookie: admin } })).json()) as { password: { set: boolean } };
  assert.equal(afterSet.password.set, true);
  // Kim's account now has a password, so an admin may reset it.
  assert.equal((await issueLink(base, admin, 'kim@partner.example', 'reset')).status, 201);
});

test('a password row is never a join target: a later sign-in elsewhere gets its own account', async () => {
  const { base, store } = await boot();
  // A link for an address nobody holds yet makes a password account...
  await enrol(base, await devLogin(base, 'admin@test'), 'lou@partner.example');
  const lou = (await store.findUsersByEmail('lou@partner.example'))[0]!;
  // ...which a GitHub sign-in with the same verified address does not join:
  // the address was typed by an admin, not proven by a mailbox.
  const later = await resolveSignIn(store, { sub: 'github:5', email: 'lou@partner.example', emailVerified: true, linkByEmail: true });
  assert.equal(later.via, 'new');
  assert.equal((await store.listIdentities(lou.id)).every((r) => !r.emailVerified), true);
});

test('every password route rides the auth rate-limit bucket', async () => {
  const { base } = await boot({ over: { rateLimit: { enabled: true, auth: { capacity: 2, refillPerSec: 0.0001 } } } });
  const post = () => fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'a@x.example', password: 'whatever whatever' }) });
  assert.equal((await post()).status, 400);
  assert.equal((await post()).status, 400);
  assert.equal((await post()).status, 429);
  assert.equal((await fetch(`${base}/api/auth/password/set?token=${'A'.repeat(43)}`)).status, 429);
});

// ── review fixes (plans/74) ───────────────────────────────────────────────────

test('a browser-shaped post: the Origin strict-origin keeps passes; the Origin: null a no-referrer page sends is refused', async () => {
  const { base } = await boot();
  const admin = await devLogin(base, 'admin@test');
  // Setting the password from the link page, as a browser posts it.
  const url = new URL(await linkFor(base, admin, 'max@partner.example'));
  const page = await openForm(base, `${url.pathname}${url.search}`);
  const fields = { token: url.searchParams.get('token')!, password: PW, confirm: PW, csrf: page.csrf };
  // What a browser sends from a page served with Referrer-Policy: no-referrer
  // (Fetch, "append a request Origin header"): this is why the forms do not.
  const opaque = await postForm(base, '/api/auth/password/set', fields, page.cookie, { origin: 'null' });
  assert.equal(opaque.status, 403);
  assert.equal(((await opaque.json()) as { error: { code: string } }).error.code, 'CSRF_BLOCKED');
  const set = await postForm(base, '/api/auth/password/set', fields, page.cookie, { origin: base });
  assert.equal(set.status, 303);
  // And signing in from the form.
  const form = await openForm(base, '/api/auth/login?idp=email');
  const login = await postForm(base, '/api/auth/password/login', { email: 'max@partner.example', password: PW, returnTo: '/', csrf: form.csrf }, form.cookie, { origin: base });
  assert.equal(login.status, 303);
  // The device confirmation form posts with the session cookie the same way.
  const activate = await fetch(`${base}/activate`, { headers: { cookie: admin } });
  assert.equal(activate.headers.get('referrer-policy'), 'strict-origin');
});

test('a burst of parallel guesses gets ten real checks at most; the right password after them is refused', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'nia@partner.example');
  // Each wrong guess is let go once its attempt is counted, without waiting
  // for its answer, so all ten are still in flight when the right one comes.
  const reserve = store.reservePasswordAttempt.bind(store);
  let counted: (() => void) | null = null;
  store.reservePasswordAttempt = async (...args) => {
    const r = await reserve(...args);
    counted?.();
    return r;
  };
  const wrong: Array<Promise<Response>> = [];
  for (let i = 0; i < 10; i++) {
    const seen = new Promise<void>((r) => { counted = r; });
    wrong.push(login(base, 'nia@partner.example', `wrong guess number ${i}`));
    await seen;
  }
  const right = await login(base, 'nia@partner.example', PW);
  assert.equal(right.status, 400, 'locked by the attempts before it, though none had been answered');
  assert.equal(cookieOf(right, 'lw_session'), undefined);
  for (const r of await Promise.all(wrong)) assert.equal(r.status, 400);
  const reasons = (await auditOf(store)).filter((e) => e.action === 'auth.password.fail').map((e) => e.payload?.reason);
  assert.equal(reasons.filter((r) => r === 'wrong-password').length, 10);
  assert.deepEqual(reasons.filter((r) => r === 'locked'), ['locked']);
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.password.locked').length, 1);
  // Many more at once: none of them is checked while the lock holds.
  const more = await Promise.all(Array.from({ length: 12 }, (_, i) => login(base, 'nia@partner.example', i === 11 ? PW : `more guesses ${i}`)));
  assert.ok(more.every((r) => r.status === 400));
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.password.fail' && e.payload?.reason === 'wrong-password').length, 10);
  const cred = await store.getPasswordCredential('nia@partner.example');
  assert.ok(cred?.lockedUntil && Date.parse(cred.lockedUntil) - Date.now() <= 15 * 60_000, 'guesses during the lock do not renew it');
});

test('an owner signs in with a password only when an owner issued the link that set it', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  const owner = await devLogin(base, 'owner@test');
  await enrol(base, admin, 'ola@partner.example');
  const ola = (await store.findUsersByEmail('ola@partner.example'))[0]!;
  assert.equal((await login(base, 'ola@partner.example', PW)).status, 303);

  // Promoted to owner: the password an admin's link set (and the admin may
  // know) no longer opens the account.
  await store.setLocalGroups(ola.id, ['owner']);
  const refused = await login(base, 'ola@partner.example', PW);
  assert.equal(refused.status, 403);
  assert.ok((await refused.text()).includes('Ask an owner for a new sign-in link'));
  assert.equal(cookieOf(refused, 'lw_session'), undefined);
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.denied').at(-1)?.payload?.reason, 'owner-link-required');
  // An admin may not issue one for an owner; an owner may, and that one works.
  assert.equal((await issueLink(base, admin, 'ola@partner.example', 'reset')).status, 403);
  const reset = await setPassword(base, await linkFor(base, owner, 'ola@partner.example', 'reset'), 'an owner chose this one');
  assert.equal(reset.status, 303);
  assert.equal((await store.getPasswordCredential('ola@partner.example'))?.ownerIssued, true);
  const ok = await login(base, 'ola@partner.example', 'an owner chose this one');
  assert.equal(ok.status, 303);
  assert.equal(await sessionEmail(base, cookieOf(ok, 'lw_session')), 'ola@partner.example');
});

test('a link is judged again when it is used: a sign-in made meanwhile, or an issuer who lost the role, kills it', async () => {
  const { base, store } = await boot();
  const owner = await devLogin(base, 'owner@test');
  const admin = await devLogin(base, 'admin@test');

  // Issued for a new address; the person then signs in with GitHub.
  const early = new URL(await linkFor(base, admin, 'pia@partner.example'));
  const pia = await store.upsertUserBySub({ sub: 'github:31', email: 'pia@partner.example', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.linkIdentity({ identitySub: 'github:31', userId: pia.id, idp: 'github', email: 'pia@partner.example', emailVerified: true, linkedAt: now, lastLoginAt: now });
  assert.equal((await fetch(`${base}${early.pathname}${early.search}`)).status, 410, 'an admin may not add a password to that account now');
  const form = await openForm(base, '/api/auth/login?idp=email');
  const post = await postForm(base, '/api/auth/password/set', { token: early.searchParams.get('token')!, password: PW, confirm: PW, csrf: form.csrf }, form.cookie);
  assert.equal(post.status, 410);
  assert.equal(await store.getPasswordCredential('pia@partner.example'), null);
  assert.deepEqual((await auditOf(store)).filter((e) => e.action === 'auth.password.link.refused').at(-1)?.payload,
    { provider: 'password', idp: 'email', email: 'pia@partner.example', reason: 'OWNER_ONLY' });

  // Issued by an admin who is then disabled.
  const later = await linkFor(base, admin, 'quin@partner.example');
  const adminUser = (await store.findUsersByEmail('admin@test'))[0]!;
  const off = await fetch(`${base}/api/v1/users/${adminUser.id}/disabled`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  assert.equal(off.status, 200);
  const laterUrl = new URL(later);
  assert.equal((await fetch(`${base}${laterUrl.pathname}${laterUrl.search}`)).status, 410, 'the issuer may no longer issue it');
  const form2 = await openForm(base, '/api/auth/login?idp=email');
  const post2 = await postForm(base, '/api/auth/password/set', { token: laterUrl.searchParams.get('token')!, password: PW, confirm: PW, csrf: form2.csrf }, form2.cookie);
  assert.equal(post2.status, 410);
  assert.equal(await store.getPasswordCredential('quin@partner.example'), null);
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.password.link.refused').at(-1)?.payload?.reason, 'issuer-unavailable');
});

test('an admin may add a password to their own account', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  const me = (await store.findUsersByEmail('admin@test'))[0]!;
  const now = new Date().toISOString();
  // Their Google sign-in (the primary IdP) proves the address.
  await store.linkIdentity({ identitySub: 'g-44', userId: me.id, idp: 'primary', email: 'admin@test', emailVerified: true, linkedAt: now, lastLoginAt: now });
  const set = await enrol(base, admin, 'admin@test');
  assert.equal(await sessionEmail(base, cookieOf(set, 'lw_session')), 'admin@test');
  assert.ok((await store.listIdentities(me.id)).some((r) => r.idp === 'email'), 'joined their own account');
});

test('removing the password sign-in deletes the password: it does not link back in', async () => {
  const { base, store } = await boot();
  const owner = await devLogin(base, 'owner@test');
  const rae = await store.upsertUserBySub({ sub: 'g-12', email: 'rae@partner.example', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.linkIdentity({ identitySub: 'g-12', userId: rae.id, idp: 'primary', email: 'rae@partner.example', emailVerified: true, linkedAt: now, lastLoginAt: now });
  await enrol(base, owner, 'rae@partner.example');
  assert.equal((await login(base, 'rae@partner.example', PW)).status, 303);

  const detail = (await (await fetch(`${base}/api/v1/users/${rae.id}/identities`, { headers: { cookie: owner } })).json()) as { identities: Array<{ idp: string; subjectHash: string }> };
  const row = detail.identities.find((i) => i.idp === 'email')!;
  const removed = await fetch(`${base}/api/v1/users/${rae.id}/identities/email/${row.subjectHash}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(removed.status, 204);
  assert.equal(await store.getPasswordCredential('rae@partner.example'), null);
  const again = await login(base, 'rae@partner.example', PW);
  assert.equal(again.status, 400);
  assert.ok((await again.text()).includes(MISMATCH));
  assert.deepEqual((await store.listIdentities(rae.id)).map((r) => r.idp), ['primary'], 'not linked back');
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.password.remove').at(-1)?.payload?.email, 'rae@partner.example');
  const after = (await (await fetch(`${base}/api/v1/users/${rae.id}/identities`, { headers: { cookie: owner } })).json()) as { password: { set: boolean } };
  assert.equal(after.password.set, false);

  // The person removing it from their own profile does the same.
  const set = await enrol(base, owner, 'rae@partner.example');
  const self = cookieOf(set, 'lw_session')!;
  const mine = (await (await fetch(`${base}/api/v1/me/identities`, { headers: { cookie: self } })).json()) as { identities: Array<{ idp: string; subjectHash: string }> };
  const own = mine.identities.find((i) => i.idp === 'email')!;
  assert.equal((await fetch(`${base}/api/v1/me/identities/email/${own.subjectHash}`, { method: 'DELETE', headers: { cookie: self } })).status, 204);
  assert.equal(await store.getPasswordCredential('rae@partner.example'), null);
});

test('a new password ends the sessions the old one opened', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  await enrol(base, admin, 'sam@partner.example');
  const old = cookieOf(await login(base, 'sam@partner.example', PW), 'lw_session');
  assert.equal(await sessionEmail(base, old), 'sam@partner.example');
  const reset = await setPassword(base, await linkFor(base, admin, 'sam@partner.example', 'reset'), 'a brand new passphrase');
  assert.equal(reset.status, 303);
  assert.equal(await sessionEmail(base, old), null, 'the old session is refused');
  assert.equal(await sessionEmail(base, cookieOf(reset, 'lw_session')), 'sam@partner.example', 'this browser stays signed in');
  assert.equal((await login(base, 'sam@partner.example', PW)).status, 400, 'the old password is gone');
  assert.equal((await auditOf(store)).filter((e) => e.action === 'auth.password.set').at(-1)?.payload?.sessionsRevoked, true);
});

test('"Disable access" revokes outstanding links, so re-enabling does not bring one back', async () => {
  const { base, store } = await boot();
  const admin = await devLogin(base, 'admin@test');
  await enrol(base, admin, 'tia@partner.example');
  const pending = new URL(await linkFor(base, admin, 'tia@partner.example', 'reset'));
  const tia = (await store.findUsersByEmail('tia@partner.example'))[0]!;
  const toggle = (disabled: boolean) => fetch(`${base}/api/v1/users/${tia.id}/disabled`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ disabled }) });
  assert.equal((await toggle(true)).status, 200);
  assert.equal((await toggle(false)).status, 200);
  assert.equal((await fetch(`${base}${pending.pathname}${pending.search}`)).status, 410);
  assert.equal((await auditOf(store)).find((e) => e.action === 'user.disable')?.payload?.passwordLinksRevoked, 1);
});

test('an admin can unlock a locked password without a new one', async () => {
  const { base } = await boot();
  const admin = await devLogin(base, 'admin@test');
  await enrol(base, admin, 'uma@partner.example');
  for (let i = 0; i < 10; i++) await login(base, 'uma@partner.example', `wrong guess number ${i}`);
  assert.equal((await login(base, 'uma@partner.example', PW)).status, 400);
  const users = (await (await fetch(`${base}/api/v1/users?q=uma`, { headers: { cookie: admin } })).json()) as { users: Array<{ id: string; email: string }> };
  const uma = users.users.find((u) => u.email === 'uma@partner.example')!;
  const detail = (await (await fetch(`${base}/api/v1/users/${uma.id}/identities`, { headers: { cookie: admin } })).json()) as { password: { lockedUntil?: string } };
  assert.ok(detail.password.lockedUntil, 'the person detail says it is locked');
  assert.equal((await fetch(`${base}/api/v1/users/${uma.id}/password/unlock`, { method: 'POST', headers: { cookie: await devLogin(base, 'member@test') } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/users/${uma.id}/password/unlock`, { method: 'POST', headers: { cookie: admin } })).status, 204);
  assert.equal((await login(base, 'uma@partner.example', PW)).status, 303);
});

test('a rate-limited sign-in page is a page, not JSON; an API caller keeps JSON', async () => {
  const { base } = await boot({ over: { rateLimit: { enabled: true, auth: { capacity: 1, refillPerSec: 0.0001 } } } });
  assert.equal((await fetch(`${base}/api/auth/login?idp=email`, { headers: { accept: 'text/html' } })).status, 200);
  const limited = await fetch(`${base}/api/auth/login?idp=email&returnTo=%2Fadmin`, { headers: { accept: 'text/html,application/xhtml+xml' } });
  assert.equal(limited.status, 429);
  assert.match(limited.headers.get('content-type') ?? '', /text\/html/);
  assert.ok(Number(limited.headers.get('retry-after')) > 0);
  const html = await limited.text();
  assert.ok(html.includes('Too many sign-in attempts from your network'));
  assert.ok(html.includes('href="/api/auth/login?idp=email&amp;returnTo=%2Fadmin"'), 'try again where they were');
  const api = await fetch(`${base}/api/auth/password/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
  assert.equal(api.status, 429);
  assert.equal(((await api.json()) as { error: { code: string } }).error.code, 'RATE_LIMITED');
});

test('a full password-check queue answers 503 at once and counts nothing', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'admin@test'), 'val@partner.example');
  // Two derivations running and 32 waiting: the cap in lib/crypto.ts.
  let open!: () => void;
  const gate = new Promise<void>((r) => { open = r; });
  const held = Array.from({ length: 34 }, () => withScryptSlot(() => gate));
  try {
    await assert.rejects(withScryptSlot(async () => {}), /too many password checks/);
    const api = await fetch(`${base}/api/auth/password/login`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ email: 'val@partner.example', password: PW }),
    });
    assert.equal(api.status, 503);
    assert.equal(api.headers.get('retry-after'), '2');
    assert.equal(((await api.json()) as { error: { code: string } }).error.code, 'BUSY');
    const page = await login(base, 'val@partner.example', PW);
    assert.equal(page.status, 503);
    assert.ok((await page.text()).includes('Too many people are signing in right now.'));
    assert.equal((await store.getPasswordCredential('val@partner.example'))?.failedCount, 0, 'nothing counted');
  } finally {
    open();
    await Promise.all(held);
  }
  assert.equal((await login(base, 'val@partner.example', PW)).status, 303);
});

test('with the dev provider on and no issuer, the gate offers dev sign-in and the password form beside it', async () => {
  const { base } = await boot({ idp: { issuer: '', clientId: '', displayName: '' } });
  const cfg = (await (await fetch(`${base}/api/auth/config`)).json()) as { provider: string; providers: Array<{ id: string; kind: string }> };
  assert.equal(cfg.provider, 'dev');
  assert.deepEqual(cfg.providers.map((p) => p.kind), ['password']);
});

test('the operator can print a first owner\'s link on an instance whose only sign-in is a password', async () => {
  const { base, store, config } = await boot({
    idp: { issuer: '', clientId: '', displayName: '', bootstrapOwners: ['boss@partner.example'] }, over: { dev: { enabled: false } },
  });
  const lines: string[] = [];
  const errs: string[] = [];
  const io = { config, store, out: (l: string) => lines.push(l), err: (l: string) => errs.push(l) };
  assert.equal(await runPasswordLinkCommand(['--email', 'someone@partner.example'], {}, io), 2, 'only a bootstrap owner');
  assert.match(errs.at(-1) ?? '', /not listed in idp.bootstrapOwners/);
  assert.equal(await runPasswordLinkCommand(['--email', 'nope'], {}, io), 1);
  assert.equal(await runPasswordLinkCommand(['--email', ' Boss@Partner.example '], {}, io), 0, errs.join('\n'));
  const url = lines.find((l) => l.startsWith('https://team.example/api/auth/password/set?token='))!;
  assert.ok(url, lines.join('\n'));
  assert.ok(!JSON.stringify(await auditOf(store)).includes(new URL(url).searchParams.get('token')!), 'the token is printed, never stored');
  assert.equal((await auditOf(store)).at(-1)?.actor, 'operator');

  const set = await setPassword(base, url, PW);
  assert.equal(set.status, 303, await set.clone().text());
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: cookieOf(set, 'lw_session')! } })).json() as { user: { email: string; role: string } };
  assert.deepEqual([session.user.email, session.user.role], ['boss@partner.example', 'owner']);
  assert.equal((await store.getPasswordCredential('boss@partner.example'))?.ownerIssued, true);
  // Without a password entry there is nothing to do.
  const noPw = parseConfig(JSON.stringify({ ...JSON.parse(configJson({}, { additional: [] })), instance: { name: 'x', baseUrl: 'https://x.example', pack: './packs/demo' } }));
  assert.equal(await runPasswordLinkCommand(['--email', 'boss@partner.example'], {}, { ...io, config: noPw }), 1);
});

test('a sign-in against a hash made under weaker settings stores a fresh one, keeping where it came from', async () => {
  const { base, store } = await boot();
  await enrol(base, await devLogin(base, 'owner@test'), 'wyn@partner.example');
  const salt = randomBytes(16);
  const weak = `scrypt$14$8$1$${salt.toString('base64url')}$${scryptSync(PW.normalize('NFKC'), salt, 32, { N: 2 ** 14, r: 8, p: 1 }).toString('base64url')}`;
  const before = (await store.getPasswordCredential('wyn@partner.example'))!;
  await store.putPasswordCredential({ id: before.id, email: before.email, hash: weak, at: new Date().toISOString(), ownerIssued: true });
  assert.equal((await login(base, 'wyn@partner.example', PW)).status, 303);
  const after = (await store.getPasswordCredential('wyn@partner.example'))!;
  assert.ok(after.hash.startsWith('scrypt$15$8$1$'), after.hash);
  assert.equal(after.ownerIssued, true);
  assert.equal((await login(base, 'wyn@partner.example', PW)).status, 303, 'the new hash verifies');
});

test('restricted evaluation on a password-only instance: a dev owner issues the first link, and that sign-in proves the setup', async () => {
  const { base } = await boot({
    idp: { issuer: '', clientId: '', displayName: '', bootstrapOwners: ['real@partner.example'], admission: { domains: ['partner.example'] } },
    over: { deployment: { mode: 'evaluation' } },
  });
  const devOwner = await devLogin(base, 'owner@test');
  const set = await enrol(base, devOwner, 'real@partner.example');
  const owner = cookieOf(set, 'lw_session')!;
  const setup = (await (await fetch(`${base}/api/v1/system/setup/configuration`, { headers: { cookie: owner } })).json()) as { account: { role: string; signIn: { provider: string } | null } };
  assert.equal(setup.account.role, 'owner');
  assert.equal(setup.account.signIn?.provider, 'password', 'a real owner sign-in under these settings');
});
