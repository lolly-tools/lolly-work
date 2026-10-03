/**
 * Multi-IdP (plans/36 §3) over real HTTP, with a stubbed fetchImpl standing
 * in for the second issuer: discovery, the authorize redirect, the code
 * exchange, a genuinely RS256-signed id_token verified against a stub JWKS.
 * What matters and is pinned: the same house that starts a flow finishes it
 * (the id rides the signed state token), an additional IdP's subs are
 * namespaced so two issuers can never collide into one row, the primary's
 * semantics are byte-untouched, and with several houses configured the plain
 * login URL serves a chooser - so existing clients need no change at all.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

// ── a stub issuer: keys, discovery, token endpoint ───────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };

const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');

function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  const sig = createSign('sha256').update(`${head}.${body}`).sign(privateKey);
  return `${head}.${body}.${b64u(sig)}`;
}

/** The whole second issuer as a fetchImpl. `nonceRef` is filled by the test
 *  from the authorize redirect, exactly as a browser would carry it across. */
function issuerFetch(issuer: string, clientId: string, nonceRef: { nonce: string }, claims: Record<string, unknown>): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url === `${issuer}/jwks`) return Response.json({ keys: [JWK] });
    if (url === `${issuer}/token`) {
      return Response.json({
        id_token: signIdToken({
          iss: issuer, aud: clientId, sub: 'jdoe', nonce: nonceRef.nonce,
          exp: Math.floor(Date.now() / 1000) + 300,
          mail: 'jdoe@subsidiary.example', roles: ['admin'], given_name: 'Jo',
        }),
      });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function boot(fetchImpl: typeof fetch): Promise<{ base: string; store: ReturnType<typeof createMemoryStore> }> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-idp-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Two Houses', baseUrl: 'http://hub.example', pack },
    rateLimit: { enabled: false },
    idp: {
      issuer: 'https://idp-a.example', clientId: 'lolly-a', displayName: 'House A',
      additional: [{
        id: 'b', issuer: 'https://idp-b.example', clientId: 'lolly-b', displayName: 'House B',
        // Deliberately different claim vocabulary - proves per-IdP mapping.
        groupsClaim: 'roles', claimMap: { email: 'mail' },
      }],
    },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sM2', link: 'lM2' }, fetchImpl });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

// ── the flow ─────────────────────────────────────────────────────────────────

test('the whole second-house flow: chooser -> authorize -> callback -> namespaced member', async () => {
  const nonceRef = { nonce: '' };
  const { base, store } = await boot(issuerFetch('https://idp-b.example', 'lolly-b', nonceRef, {}));

  // Both houses advertise.
  const cfg = (await (await fetch(`${base}/api/auth/config`)).json()) as { providers: Array<{ id: string; name: string; loginPath: string }> };
  assert.deepEqual(cfg.providers.map((p) => p.id), ['primary', 'b']);
  const manifest = (await (await fetch(`${base}/api/v1/instance`)).json()) as { providers: Array<{ name: string }> };
  assert.deepEqual(manifest.providers.map((p) => p.name), ['House A', 'House B']);

  // The plain login URL - what every existing client links - serves the chooser.
  const chooser = await fetch(`${base}/api/auth/login?returnTo=%2Fadmin`);
  assert.equal(chooser.status, 200);
  const page = await chooser.text();
  assert.ok(page.includes('Sign in with House A') && page.includes('Sign in with House B'));
  assert.ok(page.includes('idp=b&amp;returnTo=%2Fadmin'), 'the choice carries the returnTo (entity-escaped in the href)');

  // Choosing house B redirects to ITS authorize endpoint with ITS client id.
  const started = await fetch(`${base}/api/auth/login?idp=b&returnTo=%2Fadmin`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location') as string);
  assert.equal(authorize.origin, 'https://idp-b.example');
  assert.equal(authorize.searchParams.get('client_id'), 'lolly-b');
  nonceRef.nonce = authorize.searchParams.get('nonce') as string;
  const state = authorize.searchParams.get('state') as string;
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;

  // The callback finishes against house B and mints an ordinary session.
  const done = await fetch(`${base}/api/auth/callback?code=xyz&state=${state}`, {
    headers: { cookie: stateCookie }, redirect: 'manual',
  });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/admin');
  const session = (done.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
  const who = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session } })).json()) as { kind: string; user?: { sub: string; role: string } };
  assert.equal(who.kind, 'member');
  assert.equal(who.user?.sub, 'b:jdoe', "an additional house's sub is namespaced");
  assert.equal(who.user?.role, 'admin', "house B's own groupsClaim ('roles') fed the role");
  const row = (await store.listUsers()).find((u) => u.sub === 'b:jdoe');
  assert.equal(row?.email, 'jdoe@subsidiary.example', "house B's own claimMap ('mail') fed the email");
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.login' && JSON.stringify(e.payload).includes('"idp":"b"')));
});

test('an unknown ?idp= is refused; the primary alone never serves a chooser', async () => {
  const nonceRef = { nonce: '' };
  const { base } = await boot(issuerFetch('https://idp-b.example', 'lolly-b', nonceRef, {}));
  assert.equal((await fetch(`${base}/api/auth/login?idp=nope`, { redirect: 'manual' })).status, 404);

  // A single-house instance keeps the old behaviour exactly: straight redirect.
  const pack = await mkdtemp(join(tmpdir(), 'lw-idp-one-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const single = parseConfig(JSON.stringify({
    instance: { name: 'One House', baseUrl: 'http://hub.example', pack },
    rateLimit: { enabled: false },
    idp: { issuer: 'https://idp-b.example', clientId: 'lolly-b', displayName: 'Only' },
  }));
  const app = buildApp({ config: single, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 's1H', link: 'l1H' }, fetchImpl: issuerFetch('https://idp-b.example', 'lolly-b', nonceRef, {}) });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const oneBase = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const direct = await fetch(`${oneBase}/api/auth/login`, { redirect: 'manual' });
  assert.equal(direct.status, 302, 'no chooser with one house - the old path, byte-identical');
});

test('config validation: reserved ids, duplicates, and the required displayName', () => {
  const base = { instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' }, dev: { enabled: true } };
  const withIdp = (additional: unknown) => JSON.stringify({
    ...base, idp: { issuer: 'https://a.example', clientId: 'c', displayName: 'A', additional },
  });
  assert.throws(() => parseConfig(withIdp([{ id: 'primary', issuer: 'https://b.example', clientId: 'c', displayName: 'B' }])), /reserved/);
  assert.throws(() => parseConfig(withIdp([
    { id: 'b', issuer: 'https://b.example', clientId: 'c', displayName: 'B' },
    { id: 'b', issuer: 'https://c.example', clientId: 'c', displayName: 'C' },
  ])), /duplicate/);
  assert.throws(() => parseConfig(withIdp([{ id: 'b', issuer: 'https://b.example', clientId: 'c' }])), /displayName/);
  assert.throws(() => parseConfig(JSON.stringify({
    ...base, idp: { additional: [{ id: 'b', issuer: 'https://b.example', clientId: 'c', displayName: 'B' }] },
  })), /primary/);
  assert.throws(() => parseConfig(withIdp([{ id: 'b', issuer: 'https://b.example', clientId: 'c', displayName: 'B', clientSecretRef: 'lower case' }])), /UPPER_SNAKE/);

  const ok = parseConfig(withIdp([{ id: 'b', issuer: 'https://b.example', clientId: 'c', displayName: 'B' }]));
  assert.equal(ok.idp.additional[0]?.groupsClaim, 'groups', 'defaults inherit from the primary');
  assert.equal(ok.idp.additional[0]?.claimMap.email, 'email');
});

// ── admission and bootstrap owners (plans/74 W-ID-1) ─────────────────────────
// The same stub issuer, but the test chooses the claims per sign-in, so one
// boot can play a listed person, a stranger and a wrong-tenant account.

const GOOGLE = 'https://accounts.google.test';
const ENTRA = 'https://login.entra.test/0f5d2a1e-1111-2222-3333-444455556666/v2.0';
const TENANT = '0f5d2a1e-1111-2222-3333-444455556666';

function claimsFetch(clientIds: Record<string, string>, current: { nonce: string; claims: Record<string, unknown> }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    for (const issuer of Object.keys(clientIds)) {
      if (url === `${issuer}/.well-known/openid-configuration`) {
        return Response.json({ issuer, authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks` });
      }
      if (url === `${issuer}/jwks`) return Response.json({ keys: [JWK] });
      if (url === `${issuer}/token`) {
        return Response.json({
          id_token: signIdToken({
            iss: issuer, aud: clientIds[issuer], nonce: current.nonce,
            exp: Math.floor(Date.now() / 1000) + 300, ...current.claims,
          }),
        });
      }
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function bootGated(idp: Record<string, unknown>, fetchImpl: typeof fetch) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-adm-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Gated Team', baseUrl: 'http://team.example', pack },
    rateLimit: { enabled: false },
    idp,
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sAdm', link: 'lAdm' }, fetchImpl });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

/** Start at /api/auth/login, carry the nonce into the claims, finish at the callback. */
async function signIn(base: string, current: { nonce: string; claims: Record<string, unknown> }, claims: Record<string, unknown>, idp = 'primary') {
  const started = await fetch(`${base}/api/auth/login?idp=${idp}&returnTo=%2Fadmin`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location') as string);
  current.nonce = authorize.searchParams.get('nonce') as string;
  current.claims = claims;
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  const done = await fetch(`${base}/api/auth/callback?code=xyz&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: stateCookie }, redirect: 'manual',
  });
  const session = done.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
  return { done, session, authorize };
}

const googleIdp = (extra: Record<string, unknown> = {}) => ({
  issuer: GOOGLE, clientId: 'g-client', displayName: 'Google',
  roleGroups: { owner: ['lolly-owners'] },
  admission: { emails: ['ana@example.com'], domains: ['team.example'] },
  bootstrapOwners: ['ana@example.com'],
  ...extra,
});

test('admission: an unlisted Google-style identity is refused with a 403 page and leaves no user row', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp(), claimsFetch({ [GOOGLE]: 'g-client' }, current));
  const { done, session } = await signIn(base, current, { sub: 'g-1', email: 'Stranger@gmail.test', email_verified: true });
  assert.equal(done.status, 403);
  assert.equal(session, undefined, 'no session cookie');
  assert.match(done.headers.get('content-type') ?? '', /text\/html/);
  const page = await done.text();
  assert.ok(page.includes('Stranger@gmail.test'), 'the page names the account');
  assert.ok(page.includes('name="viewport"'), 'phone-friendly');
  assert.ok(page.includes('/api/auth/login?idp=primary&amp;prompt=select_account'), 'offers a different account');
  assert.ok(!page.includes('ana@example.com') && !page.includes('team.example'), 'never reveals the lists');
  assert.equal((await store.listUsers()).length, 0, 'no user row was created');
  const denied = (await store.listAudit()).find((e) => e.action === 'auth.denied');
  assert.equal(denied?.actor, 'anonymous');
  assert.deepEqual(denied?.payload, { provider: 'oidc', idp: 'primary', reason: 'not-invited', email: 'stranger@gmail.test' });
});

test('admission: a listed email is admitted; a listed domain only with email_verified', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp({ bootstrapOwners: [] }), claimsFetch({ [GOOGLE]: 'g-client' }, current));

  const listed = await signIn(base, current, { sub: 'g-ana', email: 'ANA@example.com', email_verified: true });
  assert.equal(listed.done.status, 302);
  assert.ok(listed.session);
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.login' && (e.payload as { admittedVia?: string }).admittedVia === 'email'));

  const unverified = await signIn(base, current, { sub: 'g-bo', email: 'bo@team.example', email_verified: false });
  assert.equal(unverified.done.status, 403);
  assert.ok((await unverified.done.text()).includes('has not confirmed this email'));
  const missing = await signIn(base, current, { sub: 'g-cy', email: 'cy@team.example' });
  assert.equal(missing.done.status, 403, 'a missing email_verified claim is not verified');

  const verified = await signIn(base, current, { sub: 'g-bo', email: 'bo@team.example', email_verified: true });
  assert.equal(verified.done.status, 302);
  assert.deepEqual((await store.listUsers()).map((u) => u.sub).sort(), ['g-ana', 'g-bo']);
  const who = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: verified.session as string } })).json()) as { user?: { role: string } };
  assert.equal(who.user?.role, 'member');
});

test('admission: a Google hosted-domain mismatch is refused, even for a listed email', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp({ hostedDomain: 'example.com' }), claimsFetch({ [GOOGLE]: 'g-client' }, current));
  const wrong = await signIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true, hd: 'elsewhere.test' });
  assert.equal(wrong.done.status, 403);
  assert.equal(wrong.authorize.searchParams.get('hd'), 'example.com', 'hostedDomain is sent as the hd param');
  const personal = await signIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true });
  assert.equal(personal.done.status, 403, 'no hd claim at all (a personal account) is refused');
  assert.equal((await store.listUsers()).length, 0);
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.denied' && (e.payload as { reason?: string }).reason === 'hosted-domain'));
  const right = await signIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true, hd: 'example.com' });
  assert.equal(right.done.status, 302);
});

test('admission: an Entra tenant mismatch is refused; a trusted tenant-pinned IdP needs no email_verified', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp({
    additional: [{
      id: 'microsoft', issuer: ENTRA, clientId: 'ms-client', displayName: 'Microsoft',
      tenantId: TENANT, emailVerification: 'trusted', groupsClaim: 'roles', claimMap: { email: 'preferred_username' },
    }],
  }), claimsFetch({ [GOOGLE]: 'g-client', [ENTRA]: 'ms-client' }, current));
  const wrong = await signIn(base, current, { sub: 'm-1', preferred_username: 'ana@example.com', tid: '9188040d-6c67-4c5b-b112-36a304b66dad' }, 'microsoft');
  assert.equal(wrong.done.status, 403);
  assert.ok((await wrong.done.text()).includes('/api/auth/login?prompt=select_account'), 'with several IdPs the switch link goes to the chooser');
  assert.equal((await store.listUsers()).length, 0);
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.denied' && (e.payload as { reason?: string; idp?: string }).reason === 'tenant'
    && (e.payload as { idp?: string }).idp === 'microsoft'));
  const right = await signIn(base, current, { sub: 'm-1', preferred_username: 'ana@example.com', tid: TENANT }, 'microsoft');
  assert.equal(right.done.status, 302);
  assert.equal((await store.listUsers())[0]?.sub, 'microsoft:m-1');
});

test('admission: disabling a person refuses the same email through another IdP, old row or new', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp({
    additional: [{
      id: 'microsoft', issuer: ENTRA, clientId: 'ms-client', displayName: 'Microsoft',
      tenantId: TENANT, emailVerification: 'trusted', groupsClaim: 'roles', claimMap: { email: 'preferred_username' },
    }],
  }), claimsFetch({ [GOOGLE]: 'g-client', [ENTRA]: 'ms-client' }, current));
  const viaMs = await signIn(base, current, { sub: 'm-bo', preferred_username: 'bo@team.example', tid: TENANT }, 'microsoft');
  assert.equal(viaMs.done.status, 302);
  const row = await store.getUserBySub('microsoft:m-bo');
  await store.setUserDisabled(row!.id, new Date().toISOString());

  const sameSub = await signIn(base, current, { sub: 'm-bo', preferred_username: 'bo@team.example', tid: TENANT }, 'microsoft');
  assert.equal(sameSub.done.status, 403);
  // A personal Google account registered to the same address, never seen before.
  const otherIdp = await signIn(base, current, { sub: 'g-bo', email: 'Bo@team.example', email_verified: true });
  assert.equal(otherIdp.done.status, 403, 'the domain list would admit this address, but the person is disabled');
  assert.equal(otherIdp.session, undefined);
  assert.equal(await store.getUserBySub('g-bo'), null, 'no fresh row for the disabled person');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'auth.denied' && (e.payload as { reason?: string }).reason === 'disabled').length, 2);

  await store.setUserDisabled(row!.id, null);
  assert.equal((await signIn(base, current, { sub: 'g-bo', email: 'bo@team.example', email_verified: true })).done.status, 302, 're-enabling lets them in again');
});

test('bootstrap owner: a listed, verified owner email gets the owner group and role, audited', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated(googleIdp(), claimsFetch({ [GOOGLE]: 'g-client' }, current));
  const { done, session } = await signIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true });
  assert.equal(done.status, 302);
  const who = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session as string } })).json()) as { user?: { role: string; groups: string[] } };
  assert.equal(who.user?.role, 'owner');
  assert.ok(who.user?.groups.includes('lolly-owners'), 'the first roleGroups.owner name is unioned in');
  const row = (await store.listUsers()).find((u) => u.sub === 'g-ana');
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.bootstrap-owner' && e.subject === `user:${row?.id}`));

  // A disabled account is refused at its next sign-in, owner or not.
  await store.setUserDisabled(row!.id, new Date().toISOString());
  const again = await signIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true });
  assert.equal(again.done.status, 403);
  assert.ok((await again.done.text()).includes('This account is turned off on'));

  // Not on the bootstrap list: an admitted person stays a member.
  const bo = await signIn(base, current, { sub: 'g-bo', email: 'bo@team.example', email_verified: true });
  const boWho = (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: bo.session as string } })).json()) as { user?: { role: string } };
  assert.equal(boWho.user?.role, 'member');
});

test('authorize URL: configured scopes and allowlisted authParams are sent; prompt from the link is limited', async () => {
  const current = { nonce: '', claims: {} };
  const { base } = await bootGated(googleIdp({
    scopes: ['openid', 'email', 'profile', 'offline_access'],
    authParams: { prompt: 'consent', login_hint: 'ana@example.com', acr_values: 'urn:mfa' },
  }), claimsFetch({ [GOOGLE]: 'g-client' }, current));
  const started = await fetch(`${base}/api/auth/login?idp=primary`, { redirect: 'manual' });
  const url = new URL(started.headers.get('location') as string);
  assert.equal(url.searchParams.get('scope'), 'openid email profile offline_access');
  assert.equal(url.searchParams.get('prompt'), 'consent');
  assert.equal(url.searchParams.get('login_hint'), 'ana@example.com');
  assert.equal(url.searchParams.get('acr_values'), 'urn:mfa');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://team.example/api/auth/callback');

  const picked = new URL((await fetch(`${base}/api/auth/login?idp=primary&prompt=select_account`, { redirect: 'manual' })).headers.get('location') as string);
  assert.equal(picked.searchParams.get('prompt'), 'select_account', 'the switch-account link asks for the picker');
  const odd = new URL((await fetch(`${base}/api/auth/login?idp=primary&prompt=none&hd=evil.test`, { redirect: 'manual' })).headers.get('location') as string);
  assert.equal(odd.searchParams.get('prompt'), 'consent', 'an unlisted prompt value from the link is ignored');
  assert.equal(odd.searchParams.get('hd'), null, 'query parameters other than prompt never reach the IdP');

  // Defaults: no extras configured -> the scope the code always sent.
  const plainCurrent = { nonce: '', claims: {} };
  const plain = await bootGated({ issuer: GOOGLE, clientId: 'g-client', displayName: 'Google' }, claimsFetch({ [GOOGLE]: 'g-client' }, plainCurrent));
  const plainUrl = new URL((await fetch(`${plain.base}/api/auth/login`, { redirect: 'manual' })).headers.get('location') as string);
  assert.equal(plainUrl.searchParams.get('scope'), 'openid profile email');
  assert.equal(plainUrl.searchParams.get('prompt'), null);
});

test('no admission policy: any verified sign-in is admitted, as before', async () => {
  const current = { nonce: '', claims: {} };
  const { base, store } = await bootGated({ issuer: GOOGLE, clientId: 'g-client', displayName: 'Google' }, claimsFetch({ [GOOGLE]: 'g-client' }, current));
  const { done } = await signIn(base, current, { sub: 'g-x', email: 'anyone@gmail.test' });
  assert.equal(done.status, 302);
  assert.equal((await store.listUsers()).length, 1);
});
