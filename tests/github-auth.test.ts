// SPDX-License-Identifier: MPL-2.0
/**
 * GitHub sign-in (plans/74 social sign-on) over real HTTP, with a stubbed
 * fetchImpl standing in for github.com and api.github.com. GitHub is OAuth
 * 2.0, not OIDC: no discovery, no id_token. What is pinned here: the
 * authorize redirect carries PKCE and the two scopes, the code exchange sends
 * the secret and verifier, the subject is the numeric id (never the login),
 * the email is the verified primary or else the first verified address, and
 * every failure is an HTML page rather than a JSON 500. Admission and
 * bootstrap owners are the same shared path the OIDC callback uses.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { linkByEmailFor, parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { GitHubSignInError, mapGitHubUser } from '../server/src/iam/github.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const SECRET_ENV = 'LW_TEST_GITHUB_SECRET';
const SECRET = 'gh-client-secret-not-a-real-one';
const ACCESS_TOKEN = 'gho_test_access_token_value';
process.env[SECRET_ENV] = SECRET;

interface GitHubScript {
  token?: () => Response;
  user?: Record<string, unknown>;
  emails?: unknown;
}

interface Seen {
  tokenBody?: URLSearchParams;
  tokenAccept?: string | null;
  apiCalls: Array<{ url: string; auth: string | null; accept: string | null; ua: string | null }>;
}

/** github.com and api.github.com as one fetchImpl, scripted per test. */
function githubFetch(script: GitHubScript, seen: Seen): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const headers = new Headers(init?.headers);
    if (url === 'https://github.com/login/oauth/access_token') {
      seen.tokenBody = new URLSearchParams(String(init?.body ?? ''));
      seen.tokenAccept = headers.get('accept');
      return script.token ? script.token() : Response.json({ access_token: ACCESS_TOKEN, token_type: 'bearer', scope: 'read:user,user:email' });
    }
    if (url === 'https://api.github.com/user' || url === 'https://api.github.com/user/emails') {
      seen.apiCalls.push({ url, auth: headers.get('authorization'), accept: headers.get('accept'), ua: headers.get('user-agent') });
      if (headers.get('authorization') !== `Bearer ${ACCESS_TOKEN}`) return new Response('{"message":"Bad credentials"}', { status: 401 });
      return url.endsWith('/emails')
        ? Response.json(script.emails ?? [])
        : Response.json(script.user ?? { id: 4242, login: 'octo', name: 'Octo Cat' });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function boot(idpExtra: Record<string, unknown>, fetchImpl: typeof fetch) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-gh-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Social Team', baseUrl: 'http://team.example', pack },
    rateLimit: { enabled: false },
    idp: {
      issuer: 'https://accounts.google.test', clientId: 'g-client', displayName: 'Google',
      additional: [{ id: 'github', kind: 'github', clientId: 'gh-client', displayName: 'GitHub', clientSecretRef: SECRET_ENV }],
      ...idpExtra,
    },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sGh', link: 'lGh' }, fetchImpl });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

/** Start at /api/auth/login?idp=github, then come back to the callback as GitHub would. */
async function signIn(base: string, opts: { state?: string; accept?: string } = {}) {
  const started = await fetch(`${base}/api/auth/login?idp=github&returnTo=%2Fadmin`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location') as string);
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  const done = await fetch(`${base}/api/auth/callback?code=gh-code&state=${opts.state ?? authorize.searchParams.get('state')}`, {
    headers: { cookie: stateCookie, ...(opts.accept ? { accept: opts.accept } : {}) }, redirect: 'manual',
  });
  const session = done.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
  return { done, session, authorize };
}

test('happy path: verified primary email, numeric subject, PKCE and the two scopes', async () => {
  const seen: Seen = { apiCalls: [] };
  const { base, store } = await boot({}, githubFetch({
    user: { id: 4242, login: 'octo', name: 'Octo Cat', email: null },
    emails: [
      { email: 'octo@users.noreply.github.com', primary: false, verified: true },
      { email: 'Octo@Example.com', primary: true, verified: true },
    ],
  }, seen));

  // Advertised with its kind, and on the chooser under its display name.
  const cfg = (await (await fetch(`${base}/api/auth/config`)).json()) as { providers: Array<{ id: string; name: string; kind: string }> };
  assert.deepEqual(cfg.providers.map((p) => [p.id, p.kind]), [['primary', 'oidc'], ['github', 'github']]);
  const chooser = await (await fetch(`${base}/api/auth/login?returnTo=%2Fadmin`)).text();
  assert.ok(chooser.includes('Sign in with GitHub'));

  const { done, session, authorize } = await signIn(base);
  assert.equal(authorize.origin + authorize.pathname, 'https://github.com/login/oauth/authorize');
  assert.equal(authorize.searchParams.get('client_id'), 'gh-client');
  assert.equal(authorize.searchParams.get('redirect_uri'), 'http://team.example/api/auth/callback');
  assert.equal(authorize.searchParams.get('scope'), 'read:user user:email');
  assert.equal(authorize.searchParams.get('code_challenge_method'), 'S256');
  assert.equal(authorize.searchParams.get('allow_signup'), 'true');
  assert.equal(authorize.searchParams.get('nonce'), null, 'OAuth 2.0 has no nonce');

  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/admin');
  assert.ok(session, 'a session cookie is minted');

  // The exchange: JSON accept, secret, verifier matching the challenge.
  assert.equal(seen.tokenAccept, 'application/json');
  assert.equal(seen.tokenBody?.get('client_id'), 'gh-client');
  assert.equal(seen.tokenBody?.get('client_secret'), SECRET);
  assert.equal(seen.tokenBody?.get('code'), 'gh-code');
  assert.equal(seen.tokenBody?.get('redirect_uri'), 'http://team.example/api/auth/callback');
  const verifier = seen.tokenBody?.get('code_verifier') as string;
  assert.equal(createHash('sha256').update(verifier).digest('base64url'), authorize.searchParams.get('code_challenge'));
  for (const call of seen.apiCalls) {
    assert.equal(call.auth, `Bearer ${ACCESS_TOKEN}`);
    assert.equal(call.accept, 'application/vnd.github+json');
    assert.ok(call.ua, 'GitHub requires a User-Agent');
  }

  const who = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session as string } })).json()) as { user?: { sub: string; email: string; groups: string[] } };
  assert.equal(who.user?.sub, 'github:4242', 'the numeric id, namespaced; never the login');
  assert.equal(who.user?.email, 'Octo@Example.com', 'the verified primary wins over an earlier verified address');
  assert.deepEqual(who.user?.groups, [], 'GitHub has no groups');
  const row = (await store.listUsers()).find((u) => u.sub === 'github:4242');
  assert.equal(row?.firstname, 'Octo');
  assert.equal(row?.lastname, 'Cat');
  const auditText = JSON.stringify(await store.listAudit());
  assert.ok(auditText.includes('"idp":"github"'));
  assert.ok(!auditText.includes(ACCESS_TOKEN) && !auditText.includes(SECRET), 'no token or secret reaches the audit log');
});

test('unverified-only emails are refused on every instance, with no user row', async () => {
  // GitHub lets anyone add any address without proving it. An open instance
  // (no admission block) must refuse it too, or the unproven address becomes
  // a user's stored email that project invites and the disabled sweep trust.
  for (const idpExtra of [{ admission: { domains: ['example.com'] } }, {}]) {
    const seen: Seen = { apiCalls: [] };
    const { base, store } = await boot(idpExtra, githubFetch({
      user: { id: 8, login: 'octo', email: 'octo@example.com' },
      emails: [{ email: 'octo@example.com', primary: true, verified: false }],
    }, seen));
    const { done, session } = await signIn(base);
    assert.equal(done.status, 403);
    assert.equal(session, undefined);
    assert.match(done.headers.get('content-type') ?? '', /text\/html/);
    assert.match(await done.text(), /did not share a verified email address/);
    assert.equal((await store.listUsers()).length, 0, 'no user row carries the unproven address');
    assert.ok((await store.listAudit()).some((e) => e.action === 'auth.failed' && JSON.stringify(e.payload).includes('no-email')));
  }
});

test('no email at all: an HTML page and an auth.failed row, never a JSON 500', async () => {
  const seen: Seen = { apiCalls: [] };
  const { base, store } = await boot({}, githubFetch({ user: { id: 7, login: 'quiet', email: null }, emails: [] }, seen));
  const { done, session } = await signIn(base);
  assert.equal(done.status, 403);
  assert.equal(session, undefined);
  assert.match(done.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await done.text(), /did not share a verified email address/);
  assert.equal((await store.listUsers()).length, 0);
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.failed' && JSON.stringify(e.payload).includes('no-email')));
});

test('a token error is an HTML page; GitHub\'s own description never reaches it', async () => {
  for (const token of [
    () => Response.json({ error: 'bad_verification_code', error_description: 'internal detail XYZZY' }),
    () => new Response('upstream down', { status: 500 }),
  ]) {
    const seen: Seen = { apiCalls: [] };
    const { base, store } = await boot({}, githubFetch({ token }, seen));
    const { done, session } = await signIn(base);
    assert.equal(done.status, 502);
    assert.equal(session, undefined);
    assert.match(done.headers.get('content-type') ?? '', /text\/html/);
    const page = await done.text();
    assert.match(page, /GitHub did not finish the sign-in/);
    assert.ok(page.includes('Try again') && page.includes('idp=github'), 'a way to start again');
    assert.ok(!page.includes('XYZZY'));
    assert.equal(seen.apiCalls.length, 0, 'no API read without a token');
    assert.ok((await store.listAudit()).some((e) => e.action === 'auth.failed' && JSON.stringify(e.payload).includes('"reason":"token"')));
  }
});

test('a state mismatch is refused before GitHub is asked anything', async () => {
  const seen: Seen = { apiCalls: [] };
  const { base } = await boot({}, githubFetch({}, seen));
  const api = await signIn(base, { state: 'forged' });
  assert.equal(api.done.status, 400);
  assert.equal(((await api.done.json()) as { error: { code: string } }).error.code, 'BAD_STATE', 'an API caller keeps the JSON code');
  const browser = await signIn(base, { state: 'forged', accept: 'text/html,application/xhtml+xml' });
  assert.equal(browser.done.status, 400);
  assert.match(browser.done.headers.get('content-type') ?? '', /text\/html/, 'a browser gets the page');
  assert.equal(seen.tokenBody, undefined);
  assert.equal(seen.apiCalls.length, 0);
});

test('admission by listed email, and the bootstrap owner joins the owner group', async () => {
  const seen: Seen = { apiCalls: [] };
  const { base, store } = await boot({
    admission: { emails: ['founder@example.com'] },
    bootstrapOwners: ['founder@example.com'],
  }, githubFetch({
    user: { id: 99, login: 'founder' },
    // Primary unverified, a later address verified: the verified one is used.
    emails: [
      { email: 'old@example.net', primary: true, verified: false },
      { email: 'Founder@Example.com', primary: false, verified: true },
    ],
  }, seen));
  const { done, session } = await signIn(base);
  assert.equal(done.status, 302);
  const who = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session as string } })).json()) as { user?: { sub: string; role: string; email: string } };
  assert.equal(who.user?.sub, 'github:99');
  assert.equal(who.user?.email, 'Founder@Example.com');
  assert.equal(who.user?.role, 'owner');
  const row = (await store.listUsers()).find((u) => u.sub === 'github:99');
  assert.equal(row?.firstname, 'founder', 'the login stands in for a missing name');
  const audit = await store.listAudit();
  assert.ok(audit.some((e) => e.action === 'auth.bootstrap-owner' && JSON.stringify(e.payload).includes('"idp":"github"')));
  assert.ok(audit.some((e) => e.action === 'auth.login' && JSON.stringify(e.payload).includes('"admittedVia":"email"')));
  // GitHub is OAuth 2.0, not OIDC: every row of this sign-in says so.
  for (const action of ['auth.login', 'auth.bootstrap-owner']) {
    assert.equal((audit.find((e) => e.action === action)?.payload as { provider?: string }).provider, 'github', action);
  }

  // A refusal is filed under GitHub too.
  const other = await boot({ admission: { emails: ['founder@example.com'] } }, githubFetch({
    user: { id: 100, login: 'stranger' }, emails: [{ email: 'stranger@example.net', primary: true, verified: true }],
  }, { apiCalls: [] }));
  assert.equal((await signIn(other.base)).done.status, 403);
  const denied = (await other.store.listAudit()).find((e) => e.action === 'auth.denied');
  assert.equal((denied?.payload as { provider?: string; idp?: string }).provider, 'github');
});

test('mapGitHubUser: the email rule and the subject rule', () => {
  assert.throws(() => mapGitHubUser({ login: 'no-id' }, []), (e: unknown) => e instanceof GitHubSignInError && e.reason === 'profile');
  assert.throws(() => mapGitHubUser({ id: 1, login: 'x' }, []), (e: unknown) => e instanceof GitHubSignInError && e.reason === 'no-email');
  assert.throws(() => mapGitHubUser({ id: 1, login: 'x' }, [{ email: 'a@b.example', primary: true, verified: false }]),
    (e: unknown) => e instanceof GitHubSignInError && e.reason === 'no-email', 'an unverified address is never used');
  assert.throws(() => mapGitHubUser({ id: 2, login: 'y', email: 'pub@b.example' }, []),
    (e: unknown) => e instanceof GitHubSignInError && e.reason === 'no-email', 'nor is the public profile email');
  const id = mapGitHubUser({ id: 3, login: '12345' }, [{ email: 'c@b.example', primary: true, verified: true }]);
  assert.equal(id.sub, '3', 'a numeric-looking login never stands in for the id');
  assert.equal(id.emailVerified, true);
  const skipNoreply = mapGitHubUser({ id: 4, login: 'z' }, [
    { email: 'old@b.example', primary: true, verified: false },
    { email: '4+z@users.noreply.github.com', primary: false, verified: true },
    { email: 'real@b.example', primary: false, verified: true },
  ]);
  assert.equal(skipNoreply.email, 'real@b.example', 'a verified mailbox beats the noreply address');
});

test('config: kind github takes no issuer, needs a secret ref, and linkByEmail defaults by emailVerification', () => {
  const base = { instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' }, dev: { enabled: true } };
  const withIdp = (gh: Record<string, unknown>) => JSON.stringify({
    ...base, idp: { issuer: 'https://a.example', clientId: 'c', displayName: 'A', additional: [{ id: 'github', kind: 'github', clientId: 'g', displayName: 'GitHub', clientSecretRef: 'GH_SECRET', ...gh }] },
  });
  assert.throws(() => parseConfig(withIdp({ issuer: 'https://github.com' })), /takes no issuer/);
  assert.throws(() => parseConfig(withIdp({ clientSecretRef: undefined })), /clientSecretRef/);
  assert.throws(() => parseConfig(withIdp({ hostedDomain: 'example.com' })), /does not apply to kind github/);
  assert.throws(() => parseConfig(withIdp({ kind: 'saml' })), /kind must be one of/);
  assert.throws(() => parseConfig(withIdp({ linkByEmail: 'yes' })), /linkByEmail must be true or false/);
  // GitHub accepts addresses nobody proved, so "trusted" would turn them into
  // verified ones for admission, bootstrap owners and linking.
  assert.throws(() => parseConfig(withIdp({ emailVerification: 'trusted' })), /emailVerification can only be "claim"/);
  assert.throws(() => parseConfig(withIdp({ emailVerification: 'trusted', linkByEmail: true })), /emailVerification can only be "claim"/);
  assert.equal(parseConfig(withIdp({ emailVerification: 'claim' })).idp.additional[0]?.emailVerification, 'claim');
  // A trusted IdP with no pin may not link by email (nOAuth); a pinned one may.
  const entra = (extra: Record<string, unknown>) => JSON.stringify({
    ...base, idp: { issuer: 'https://a.example', clientId: 'c', displayName: 'A', additional: [{
      id: 'entra', issuer: 'https://login.microsoftonline.com/organizations/v2.0', clientId: 'e', displayName: 'Microsoft',
      emailVerification: 'trusted', linkByEmail: true, ...extra }] },
  });
  assert.throws(() => parseConfig(entra({})), /linkByEmail cannot be true for an emailVerification "trusted" IdP/);
  assert.equal(parseConfig(entra({ tenantId: '11111111-2222-3333-4444-555555555555' })).idp.additional[0]?.linkByEmail, true);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, idp: { issuer: 'https://a.example', clientId: 'c', displayName: 'A', emailVerification: 'trusted', linkByEmail: true } })),
    /idp\.linkByEmail cannot be true/);
  const ok = parseConfig(withIdp({}));
  const gh = ok.idp.additional[0];
  assert.equal(gh?.kind, 'github');
  assert.equal(gh?.issuer, '');
  assert.equal(linkByEmailFor(gh!), true, 'claim (the default) links by verified email');
  assert.equal(linkByEmailFor({ emailVerification: 'trusted' }), false, 'trusted does not link unless asked');
  assert.equal(linkByEmailFor({ emailVerification: 'trusted', linkByEmail: true }), true);
  assert.equal(linkByEmailFor({ linkByEmail: false }), false);
});
