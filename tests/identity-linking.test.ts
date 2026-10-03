// SPDX-License-Identifier: MPL-2.0
/**
 * One person, many sign-ins (plans/74) over real HTTP. A Google-style OIDC
 * issuer (RS256 id_tokens against a stub JWKS) and GitHub (OAuth 2.0) are
 * both stubbed in one fetchImpl, scripted per sign-in. Pinned here:
 *   - a verified email links a second sign-in to the same user, who keeps
 *     their projects, and the session keeps the account's own sub;
 *   - an unverified email never links, and an ambiguous one links nothing;
 *   - a signed-in member links any account by running the IdP, and an
 *     identity that belongs to someone else is refused;
 *   - unlink rules (never the account's own sign-in, never the last one);
 *   - a pre-existing user (no identity row) is found by users.sub;
 *   - a sign-in linked to a disabled person is refused.
 * The Postgres backfill of migration 0039 runs when LW_TEST_DATABASE_URL is set.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { cp, mkdtemp, mkdir, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { subjectHash } from '../server/src/iam/identities.ts';
import type { Store } from '../server/src/store/types.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const GOOGLE = 'https://accounts.google.test';
const SECRET_ENV = 'LW_TEST_LINK_GITHUB_SECRET';
process.env[SECRET_ENV] = 'gh-link-secret-not-real';
const GH_TOKEN = 'gho_link_test_token';

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createSign('sha256').update(`${head}.${body}`).sign(privateKey))}`;
}

/** What the next sign-in at each IdP returns. Tests rewrite it between flows. */
interface Script {
  google: { sub: string; email: string; email_verified?: boolean; groups?: string[]; hd?: string };
  github: { id: number; login: string; emails: Array<{ email: string; primary: boolean; verified: boolean }> };
  nonce: string;
}

function idpFetch(script: Script): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    if (url === `${GOOGLE}/.well-known/openid-configuration`) {
      return Response.json({ issuer: GOOGLE, authorization_endpoint: `${GOOGLE}/authorize`, token_endpoint: `${GOOGLE}/token`, jwks_uri: `${GOOGLE}/jwks` });
    }
    if (url === `${GOOGLE}/jwks`) return Response.json({ keys: [JWK] });
    if (url === `${GOOGLE}/token`) {
      return Response.json({
        id_token: signIdToken({
          iss: GOOGLE, aud: 'g-client', nonce: script.nonce, exp: Math.floor(Date.now() / 1000) + 300,
          given_name: 'Ana', family_name: 'Lima', ...script.google,
        }),
      });
    }
    if (url === 'https://github.com/login/oauth/access_token') return Response.json({ access_token: GH_TOKEN, token_type: 'bearer' });
    if (url === 'https://api.github.com/user' || url === 'https://api.github.com/user/emails') {
      if (new Headers(init?.headers).get('authorization') !== `Bearer ${GH_TOKEN}`) return new Response('{}', { status: 401 });
      return url.endsWith('/emails')
        ? Response.json(script.github.emails)
        : Response.json({ id: script.github.id, login: script.github.login, name: 'Ana Lima', email: null });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function boot(idpExtra: Record<string, unknown> = {}, seed?: (store: Store) => Promise<void>) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-link-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Linked Team', baseUrl: 'http://team.example', pack },
    rateLimit: { enabled: false },
    idp: {
      issuer: GOOGLE, clientId: 'g-client', displayName: 'Google',
      bootstrapOwners: ['owner@example.com'],
      additional: [{ id: 'github', kind: 'github', clientId: 'gh-client', displayName: 'GitHub', clientSecretRef: SECRET_ENV }],
      ...idpExtra,
    },
  }));
  const store = createMemoryStore();
  if (seed) await seed(store);
  const script: Script = {
    google: { sub: 'g-1', email: 'ana@example.com', email_verified: true },
    github: { id: 101, login: 'ana-gh', emails: [{ email: 'ana@example.com', primary: true, verified: true }] },
    nonce: '',
  };
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sLink', link: 'lLink' }, fetchImpl: idpFetch(script) });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store, script };
}

/** Run one IdP round trip. `start` is the path that begins it (login or link);
 *  `session` rides along when a signed-in person starts a link. */
async function roundTrip(base: string, script: Script, start: string, session?: string) {
  const started = await fetch(`${base}${start}`, { redirect: 'manual', headers: session ? { cookie: session } : {} });
  assert.equal(started.status, 302, `start ${start}`);
  const authorize = new URL(started.headers.get('location') as string);
  if (authorize.origin === GOOGLE) script.nonce = authorize.searchParams.get('nonce') as string;
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  const done = await fetch(`${base}/api/auth/callback?code=c&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: [stateCookie, session].filter(Boolean).join('; ') }, redirect: 'manual',
  });
  const minted = done.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];
  return { done, session: minted, authorize };
}
const signIn = (base: string, script: Script, idp: 'primary' | 'github') =>
  roundTrip(base, script, `/api/auth/login?idp=${idp}&returnTo=%2Fhome`);
const linkWhileSignedIn = (base: string, script: Script, idp: string, session: string) =>
  roundTrip(base, script, `/api/auth/link?idp=${idp}&returnTo=%2Fprofile`, session);

async function me(base: string, session: string) {
  return (await (await fetch(`${base}/api/auth/session`, { headers: { cookie: session } })).json()) as { user?: { sub: string; email: string; role: string } };
}
type IdentityRow = { idp: string; subjectHash: string; email: string | null; canUnlink: boolean; unlinkBlocked?: string; displayName: string; linkedAt: string; lastLoginAt: string | null };
async function myIdentities(base: string, session: string) {
  const res = await fetch(`${base}/api/v1/me/identities`, { headers: { cookie: session } });
  assert.equal(res.status, 200);
  return (await res.json()) as { identities: IdentityRow[]; available: Array<{ id: string; linkPath: string }> };
}

test('one person, two sign-ins: a verified email links GitHub to the Google account', async () => {
  const { base, store, script } = await boot();
  const google = await signIn(base, script, 'primary');
  assert.equal(google.done.status, 302);
  const googleSession = google.session as string;
  const created = await fetch(`${base}/api/v1/projects`, {
    method: 'POST', headers: { cookie: googleSession, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Spring launch' }),
  });
  assert.equal(created.status, 201);
  const project = (await created.json()) as { id: string };

  const github = await signIn(base, script, 'github');
  assert.equal(github.done.status, 302);
  const ghSession = github.session as string;
  assert.equal((await me(base, ghSession)).user?.sub, 'g-1', "the session carries the account's own sub");
  assert.equal((await store.listUsers()).length, 1, 'one person, one user row');
  const user = (await store.getUserBySub('g-1'))!;
  assert.equal((await store.getUserByIdentity('github:101'))?.id, user.id);
  assert.equal(user.firstname, 'Ana', 'the linked sign-in left the profile alone');

  // Same projects, whichever sign-in was used.
  const listed = (await (await fetch(`${base}/api/v1/projects`, { headers: { cookie: ghSession } })).json()) as { projects: Array<{ id: string }> };
  assert.ok(listed.projects.some((p) => p.id === project.id));

  const link = (await store.listAudit()).find((e) => e.action === 'identity.link');
  assert.equal(link?.actor, `user:${user.id}`);
  assert.deepEqual(link?.payload, { via: 'email', provider: 'github', idp: 'github', email: 'ana@example.com' });

  // The profile view: two sign-ins, the account's own one stays.
  const { identities, available } = await myIdentities(base, ghSession);
  assert.deepEqual(identities.map((i) => [i.idp, i.displayName, i.email, i.canUnlink]), [
    ['primary', 'Google', 'ana@example.com', false],
    ['github', 'GitHub', 'ana@example.com', true],
  ]);
  assert.equal(identities[0]?.unlinkBlocked, 'account');
  assert.equal(identities[1]?.subjectHash, subjectHash('github:101'));
  assert.ok(!JSON.stringify(identities).includes('github:101'), 'a raw subject never travels');
  assert.deepEqual(available.map((a) => a.id), ['primary', 'github']);
  assert.equal(available[1]?.linkPath, '/api/auth/link?idp=github');

  // A second sign-in through GitHub finds the row directly: no second link row.
  await signIn(base, script, 'github');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'identity.link').length, 1);
});

test('an unverified email never links, in either direction', async () => {
  const { base, store, script } = await boot();
  // Google says the address is unverified: the row cannot be a link target.
  script.google = { sub: 'g-2', email: 'ana@example.com', email_verified: false };
  await signIn(base, script, 'primary');
  const github = await signIn(base, script, 'github');
  assert.equal(github.done.status, 302);
  assert.equal((await me(base, github.session as string)).user?.sub, 'github:101', 'a fresh account');
  assert.equal((await store.listUsers()).length, 2);

  // GitHub with only an unverified address neither links to the verified
  // account nor gets one of its own carrying that address.
  const fresh = await boot();
  await signIn(fresh.base, fresh.script, 'primary');
  fresh.script.github = { id: 202, login: 'other', emails: [{ email: 'ana@example.com', primary: true, verified: false }] };
  const unverified = await signIn(fresh.base, fresh.script, 'github');
  assert.equal(unverified.done.status, 403);
  assert.equal(unverified.session, undefined);
  assert.equal(await fresh.store.getUserByIdentity('github:202'), null);
  assert.equal((await fresh.store.findUsersByEmail('ana@example.com')).length, 1, 'only the real account holds the address');
  assert.ok(!(await fresh.store.listAudit()).some((e) => e.action === 'identity.link'));
});

test('linkByEmail: false keeps an IdP out of email linking', async () => {
  const { base, store, script } = await boot({
    additional: [{ id: 'github', kind: 'github', clientId: 'gh-client', displayName: 'GitHub', clientSecretRef: SECRET_ENV, linkByEmail: false }],
  });
  await signIn(base, script, 'primary');
  const github = await signIn(base, script, 'github');
  assert.equal((await me(base, github.session as string)).user?.sub, 'github:101');
  assert.equal((await store.listUsers()).length, 2);
});

test('an unpinned IdP never joins an account proven only through a pinned one', async () => {
  // Google pinned to the company domain. A GitHub account that still lists
  // the address as verified (a reassigned mailbox, a person offboarded only
  // at Google) must not reach the person who holds it now.
  const { base, store, script } = await boot({ hostedDomain: 'example.com' });
  script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true, hd: 'example.com' };
  const google = await signIn(base, script, 'primary');
  assert.equal(google.done.status, 302);
  const ana = (await store.getUserBySub('g-1'))!;

  const github = await signIn(base, script, 'github');
  assert.equal(github.done.status, 302);
  assert.equal((await me(base, github.session as string)).user?.sub, 'github:101', 'an account of its own, as before linking');
  assert.notEqual((await store.getUserByIdentity('github:101'))?.id, ana.id);
  assert.ok(!(await store.listAudit()).some((e) => e.action === 'identity.link'));
  const held = (await store.listAudit()).find((e) => e.action === 'identity.link-held');
  assert.deepEqual(held?.payload, { provider: 'github', idp: 'github', email: 'ana@example.com', reason: 'pinned' });

  // The person can still add GitHub by hand, proving both sides in one browser.
  script.github = { id: 102, login: 'ana-real', emails: [{ email: 'ana@example.com', primary: true, verified: true }] };
  const linked = await linkWhileSignedIn(base, script, 'github', google.session as string);
  assert.equal(linked.done.status, 302);
  assert.equal((await store.getUserByIdentity('github:102'))?.id, ana.id);
});

test('an email two accounts already prove links nothing and is audited', async () => {
  const { base, store, script } = await boot({}, async (s) => {
    const at = '2026-10-01T00:00:00.000Z';
    for (const sub of ['seed-a', 'seed-b']) {
      const u = await s.upsertUserBySub({ sub, email: 'ana@example.com', groups: [], role: 'member' });
      await s.linkIdentity({ identitySub: sub, userId: u.id, idp: 'primary', email: 'ana@example.com', emailVerified: true, linkedAt: at });
    }
  });
  const github = await signIn(base, script, 'github');
  assert.equal(github.done.status, 302);
  assert.equal((await me(base, github.session as string)).user?.sub, 'github:101', 'its own account');
  assert.equal((await store.listUsers()).length, 3);
  const ambiguous = (await store.listAudit()).find((e) => e.action === 'identity.link-ambiguous');
  assert.deepEqual(ambiguous?.payload, { provider: 'github', idp: 'github', email: 'ana@example.com', candidates: 2 });
  assert.ok(!(await store.listAudit()).some((e) => e.action === 'identity.link'));
});

test('a signed-in member links an account with a different email; a stolen link is refused', async () => {
  const { base, store, script } = await boot();
  const google = await signIn(base, script, 'primary');
  const session = google.session as string;
  const owner = (await store.getUserBySub('g-1'))!;

  // Not signed in: the link route asks for a session first.
  assert.equal((await fetch(`${base}/api/auth/link?idp=github`, { redirect: 'manual' })).status, 401);

  script.github = { id: 303, login: 'ana-personal', emails: [{ email: 'ana.personal@mail.test', primary: true, verified: true }] };
  const linked = await linkWhileSignedIn(base, script, 'github', session);
  assert.equal(linked.done.status, 302);
  assert.equal(linked.done.headers.get('location'), '/profile');
  assert.equal(linked.session, undefined, 'a link mints no new session');
  assert.equal(linked.authorize.searchParams.get('prompt'), 'select_account', 'the account picker by default');
  assert.equal((await store.getUserByIdentity('github:303'))?.id, owner.id);
  const audit = (await store.listAudit()).find((e) => e.action === 'identity.link');
  assert.deepEqual(audit?.payload, { via: 'self', idp: 'github', email: 'ana.personal@mail.test' });

  // Signing in with that GitHub account now reaches the same person.
  const again = await signIn(base, script, 'github');
  assert.equal((await me(base, again.session as string)).user?.sub, 'g-1');

  // Someone else signs in with their own GitHub account first...
  script.github = { id: 404, login: 'bea', emails: [{ email: 'bea@mail.test', primary: true, verified: true }] };
  await signIn(base, script, 'github');
  const bea = (await store.getUserByIdentity('github:404'))!;
  assert.notEqual(bea.id, owner.id);
  // ...so Ana cannot pull it into her account.
  const stolen = await linkWhileSignedIn(base, script, 'github', session);
  assert.equal(stolen.done.status, 409);
  assert.match(stolen.done.headers.get('content-type') ?? '', /text\/html/);
  assert.match(await stolen.done.text(), /already signs in as someone else/);
  assert.equal((await store.getUserByIdentity('github:404'))?.id, bea.id, 'unchanged');
  assert.ok((await store.listAudit()).some((e) => e.action === 'identity.link-refused'));

  // A Google account that is someone's own users.sub is refused the same way.
  const seeded = await store.upsertUserBySub({ sub: 'g-other', email: 'carla@mail.test', groups: [], role: 'member' });
  script.google = { sub: 'g-other', email: 'carla@mail.test', email_verified: true };
  const stolenSub = await linkWhileSignedIn(base, script, 'primary', session);
  assert.equal(stolenSub.done.status, 409);
  assert.equal(await store.getUserByIdentity('g-other'), null);
  assert.equal((await store.getUserBySub('g-other'))?.id, seeded.id);

});

test('a link started by one session cannot be finished by another', async () => {
  const { base, store, script } = await boot();
  const ana = (await signIn(base, script, 'primary')).session as string;
  script.google = { sub: 'g-dan', email: 'dan@mail.test', email_verified: true };
  const dan = (await signIn(base, script, 'primary')).session as string;
  script.github = { id: 505, login: 'x', emails: [{ email: 'x@mail.test', primary: true, verified: true }] };
  const started = await fetch(`${base}/api/auth/link?idp=github&returnTo=%2Fprofile`, { redirect: 'manual', headers: { cookie: ana } });
  const authorize = new URL(started.headers.get('location') as string);
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  const done = await fetch(`${base}/api/auth/callback?code=c&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: `${stateCookie}; ${dan}` }, redirect: 'manual',
  });
  assert.equal(done.status, 401);
  assert.equal(await store.getUserByIdentity('github:505'), null);
});

test('a link that GitHub does not finish offers to retry the link, not a sign-in', async () => {
  const { base, store, script } = await boot();
  const ana = (await signIn(base, script, 'primary')).session as string;
  const started = await fetch(`${base}/api/auth/link?idp=github&returnTo=%2Fprofile`, { redirect: 'manual', headers: { cookie: ana } });
  const authorize = new URL(started.headers.get('location') as string);
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  // The person cancelled at GitHub: back with an error and no code.
  const done = await fetch(`${base}/api/auth/callback?error=access_denied&state=${authorize.searchParams.get('state')}`, {
    headers: { cookie: `${stateCookie}; ${ana}` }, redirect: 'manual',
  });
  assert.equal(done.status, 400);
  const page = await done.text();
  assert.ok(page.includes('/api/auth/link?idp=github'), 'Try again restarts the link');
  assert.ok(!page.includes('/api/auth/login'), 'never a sign-in that would replace the session');
  assert.ok(page.includes('Sign-in not added'));
  assert.equal(done.headers.getSetCookie().some((c) => c.startsWith('lw_session=')), false);
  assert.equal((await store.listUsers()).length, 1);
});

test('unlink: never the account sign-in, never the last one; admins can unlink for others', async () => {
  const { base, store, script } = await boot();
  let ana = (await signIn(base, script, 'primary')).session as string;
  script.github = { id: 606, login: 'ana2', emails: [{ email: 'ana2@mail.test', primary: true, verified: true }] };
  await linkWhileSignedIn(base, script, 'github', ana);
  const { identities } = await myIdentities(base, ana);
  const google = identities.find((i) => i.idp === 'primary')!;
  const github = identities.find((i) => i.idp === 'github')!;

  const delAccount = await fetch(`${base}/api/v1/me/identities/primary/${google.subjectHash}`, { method: 'DELETE', headers: { cookie: ana } });
  assert.equal(delAccount.status, 409);
  assert.equal(((await delAccount.json()) as { error: { code: string } }).error.code, 'ACCOUNT_SIGN_IN');
  assert.equal((await fetch(`${base}/api/v1/me/identities/github/0000000000000000`, { method: 'DELETE', headers: { cookie: ana } })).status, 404);
  assert.equal((await fetch(`${base}/api/v1/me/identities/primary/${github.subjectHash}`, { method: 'DELETE', headers: { cookie: ana } })).status, 404,
    'the idp must match too');
  // A session minted through the GitHub sign-in, which is about to be removed.
  const viaGithub = (await signIn(base, script, 'github')).session as string;
  assert.equal((await me(base, viaGithub)).user?.sub, 'g-1');
  const delGh = await fetch(`${base}/api/v1/me/identities/github/${github.subjectHash}`, { method: 'DELETE', headers: { cookie: ana } });
  assert.equal(delGh.status, 204);
  assert.equal(await store.getUserByIdentity('github:606'), null);
  const unlink = (await store.listAudit()).find((e) => e.action === 'identity.unlink');
  assert.deepEqual(unlink?.payload, { by: 'self', idp: 'github', email: 'ana2@mail.test', sessionsRevoked: true });
  // Removing a sign-in puts out the sessions it made (every session carries
  // the account's sub, so all of them end) and keeps this device signed in.
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie: viaGithub } })).status, 401, 'the removed sign-in session ends');
  assert.equal((await fetch(`${base}/api/auth/session`, { headers: { cookie: ana } })).status, 401, 'so does every older one');
  ana = (delGh.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
  assert.equal((await me(base, ana)).user?.sub, 'g-1', 'the person who pressed Remove stays signed in');
  assert.equal((await fetch(`${base}/api/v1/me/identities`)).status, 401);

  // An account whose own sign-in has no row (SCIM, or created before 0039 in
  // a memory store) keeps its one linked sign-in.
  const scim = await store.upsertUserBySub({ sub: 'scim:zoe', email: 'zoe@example.com', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'github:707', userId: scim.id, idp: 'github', email: 'zoe@mail.test', emailVerified: true, linkedAt: new Date().toISOString() });

  // Admin side: a member gets 403, the owner sees and removes.
  assert.equal((await fetch(`${base}/api/v1/users/${scim.id}/identities`, { headers: { cookie: ana } })).status, 403);
  script.google = { sub: 'g-owner', email: 'owner@example.com', email_verified: true };
  const owner = (await signIn(base, script, 'primary')).session as string;
  assert.equal((await me(base, owner)).user?.role, 'owner');
  const listed = (await (await fetch(`${base}/api/v1/users/${scim.id}/identities`, { headers: { cookie: owner } })).json()) as { identities: IdentityRow[] };
  assert.deepEqual(listed.identities.map((i) => [i.idp, i.email, i.canUnlink, i.unlinkBlocked]), [['github', 'zoe@mail.test', false, 'last']]);
  const last = await fetch(`${base}/api/v1/users/${scim.id}/identities/github/${subjectHash('github:707')}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(last.status, 409);
  assert.equal(((await last.json()) as { error: { code: string } }).error.code, 'LAST_SIGN_IN');
  await store.linkIdentity({ identitySub: 'github:708', userId: scim.id, idp: 'github', emailVerified: false, linkedAt: new Date().toISOString() });
  const zoeEpoch = (await store.getUser(scim.id))!.sessionEpoch;
  const removed = await fetch(`${base}/api/v1/users/${scim.id}/identities/github/${subjectHash('github:707')}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(removed.status, 204);
  assert.ok((await store.getUser(scim.id))!.sessionEpoch > zoeEpoch, "an admin removal ends the person's sessions too");
  assert.equal(removed.headers.getSetCookie().length, 0, 'the admin keeps their own session as it was');
  assert.equal((await me(base, owner)).user?.role, 'owner');
  assert.ok((await store.listAudit()).some((e) => e.action === 'identity.unlink' && (e.payload as { by?: string }).by === 'admin' && e.subject === `user:${scim.id}`));
});

test('a user from before 0039 is found by users.sub and gets an identity row', async () => {
  let legacyId = '';
  const { base, store, script } = await boot({}, async (s) => {
    legacyId = (await s.upsertUserBySub({ sub: 'g-1', email: 'ana@example.com', groups: ['designers'], role: 'member' })).id;
  });
  assert.deepEqual(await store.listIdentities(legacyId), [], 'seeded with no identity row');
  const google = await signIn(base, script, 'primary');
  assert.equal((await me(base, google.session as string)).user?.sub, 'g-1');
  assert.equal((await store.listUsers()).length, 1);
  const rows = await store.listIdentities(legacyId);
  assert.deepEqual(rows.map((r) => [r.identitySub, r.idp, r.email, r.emailVerified]), [['g-1', 'primary', 'ana@example.com', true]]);
  assert.ok(rows[0]?.lastLoginAt);
  assert.ok(!(await store.listAudit()).some((e) => e.action === 'identity.link'), 'finding your own row is not a link');
  // Having signed in once, the account is now a link target for GitHub.
  const github = await signIn(base, script, 'github');
  assert.equal((await me(base, github.session as string)).user?.sub, 'g-1');
});

test('a linked sign-in keeps the work IdP groups and is refused when the person is disabled', async () => {
  const { base, store, script } = await boot();
  script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true, groups: ['admin'] };
  await signIn(base, script, 'primary');
  const gh = await signIn(base, script, 'github');
  assert.equal((await me(base, gh.session as string)).user?.role, 'admin', 'GitHub has no groups, and did not clear them');
  const user = (await store.getUserBySub('g-1'))!;
  assert.deepEqual(user.idpGroups, ['admin']);
  await store.setUserDisabled(user.id, new Date().toISOString());
  const refused = await signIn(base, script, 'github');
  assert.equal(refused.done.status, 403);
  assert.equal(refused.session, undefined);
});

test('under an admission policy, a linked sign-in is admitted on the member standing', async () => {
  const { base, store, script } = await boot({ admission: { domains: ['example.com'] } });
  const ana = (await signIn(base, script, 'primary')).session as string;
  script.github = { id: 808, login: 'ana-home', emails: [{ email: 'ana@home.test', primary: true, verified: true }] };
  // Before linking, the personal address is not on the list.
  const before = await signIn(base, script, 'github');
  assert.equal(before.done.status, 403);
  await linkWhileSignedIn(base, script, 'github', ana);
  const after = await signIn(base, script, 'github');
  assert.equal(after.done.status, 302);
  assert.equal((await me(base, after.session as string)).user?.sub, 'g-1');
  const login = (await store.listAudit()).filter((e) => e.action === 'auth.login').at(-1);
  assert.equal((login?.payload as { admittedVia?: string }).admittedVia, 'linked');
});

/** Pretend a sign-in was last used `days` ago, as if the person had not
 *  signed in through it since (what a deleted work account looks like). */
async function age(store: Store, identitySub: string, days: number) {
  const row = (await store.getUserByIdentity(identitySub).then((u) => u && store.listIdentities(u.id)))?.find((r) => r.identitySub === identitySub);
  assert.ok(row, identitySub);
  await store.linkIdentity({ ...row, lastLoginAt: new Date(Date.now() - days * 86_400_000).toISOString() });
}

test('a linked sign-in does not outlive the work account: standing and groups lapse after the window', async () => {
  const { base, store, script } = await boot({ admission: { domains: ['example.com'] } });
  script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true, groups: ['admin'] };
  const ana = (await signIn(base, script, 'primary')).session as string;
  script.github = { id: 811, login: 'ana-home', emails: [{ email: 'ana@home.test', primary: true, verified: true }] };
  await linkWhileSignedIn(base, script, 'github', ana);
  const fresh = await signIn(base, script, 'github');
  assert.equal(fresh.done.status, 302, 'admitted on the account standing while the work sign-in is recent');
  assert.equal((await me(base, fresh.session as string)).user?.role, 'admin');

  // The work IdP deleted Ana a month ago; only her personal GitHub is left.
  await age(store, 'g-1', 31);
  const stale = await signIn(base, script, 'github');
  assert.equal(stale.done.status, 403, 'the personal address alone is not on the lists');
  assert.equal(stale.session, undefined);
  const denied = (await store.listAudit()).filter((e) => e.action === 'auth.denied').at(-1);
  assert.equal((denied?.payload as { reason?: string }).reason, 'not-invited');

  // A shorter window is the operator's to set.
  const strict = await boot({ admission: { domains: ['example.com'] }, linkedStandingDays: 1 });
  strict.script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true };
  const s2 = (await signIn(strict.base, strict.script, 'primary')).session as string;
  strict.script.github = { id: 812, login: 'ana-home', emails: [{ email: 'ana@home.test', primary: true, verified: true }] };
  await linkWhileSignedIn(strict.base, strict.script, 'github', s2);
  await age(strict.store, 'g-1', 2);
  assert.equal((await signIn(strict.base, strict.script, 'github')).done.status, 403);
});

test('IdP groups lapse when the IdP that sent them has not been seen for the window', async () => {
  const { base, store, script } = await boot();
  script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true, groups: ['admin'] };
  await signIn(base, script, 'primary');
  const recent = await signIn(base, script, 'github');
  assert.equal((await me(base, recent.session as string)).user?.role, 'admin', 'carried over while the work sign-in is recent');

  await age(store, 'g-1', 31);
  const lapsed = await signIn(base, script, 'github');
  assert.equal(lapsed.done.status, 302);
  assert.equal((await me(base, lapsed.session as string)).user?.role, 'member', 'GitHub cannot keep groups it never sent');
  assert.deepEqual((await store.getUserBySub('g-1'))?.idpGroups, []);

  // Signing in at the work IdP again restores them, for every sign-in.
  assert.equal((await me(base, (await signIn(base, script, 'primary')).session as string)).user?.role, 'admin');
  assert.equal((await me(base, (await signIn(base, script, 'github')).session as string)).user?.role, 'admin');
});

test('groups from a work IdP linked to an account GitHub created reach every sign-in', async () => {
  const { base, store, script } = await boot();
  // Bob's account is created by GitHub, which sends no groups.
  script.github = { id: 42, login: 'bob', emails: [{ email: 'bob@mail.test', primary: true, verified: true }] };
  const bob = (await signIn(base, script, 'github')).session as string;
  assert.equal((await me(base, bob)).user?.sub, 'github:42');
  // He adds his work IdP, which says he is an admin.
  script.google = { sub: 'g-bob', email: 'bob@corp.test', email_verified: true, groups: ['admin'] };
  const linked = await linkWhileSignedIn(base, script, 'primary', bob);
  assert.equal(linked.done.status, 302);
  assert.equal((await me(base, (await signIn(base, script, 'primary')).session as string)).user?.role, 'admin',
    'the work IdP grants its role although the account was not created by it');
  assert.equal((await me(base, (await signIn(base, script, 'github')).session as string)).user?.role, 'admin',
    'and a GitHub sign-in does not clear it');
  // The work IdP drops the group: the next work sign-in takes it away everywhere.
  script.google = { sub: 'g-bob', email: 'bob@corp.test', email_verified: true, groups: [] };
  assert.equal((await me(base, (await signIn(base, script, 'primary')).session as string)).user?.role, 'member');
  assert.equal((await me(base, (await signIn(base, script, 'github')).session as string)).user?.role, 'member');
  assert.equal((await store.listUsers()).length, 1);
});

test('an invitation for a newly linked address is accepted by the existing account, groups and all', async () => {
  const { base, store, script } = await boot();
  script.google = { sub: 'g-owner', email: 'owner@example.com', email_verified: true };
  const owner = (await signIn(base, script, 'primary')).session as string;
  const json = { 'content-type': 'application/json' };
  assert.equal((await fetch(`${base}/api/v1/groups`, { method: 'POST', headers: { cookie: owner, ...json }, body: JSON.stringify({ name: 'brand' }) })).status, 201);
  script.google = { sub: 'g-1', email: 'ana@example.com', email_verified: true };
  const ana = (await signIn(base, script, 'primary')).session as string;
  const invited = await fetch(`${base}/api/v1/invitations`, {
    method: 'POST', headers: { cookie: owner, ...json }, body: JSON.stringify({ emails: ['ana@home.test'], groups: ['brand'] }),
  });
  assert.equal(invited.status, 201);
  script.github = { id: 909, login: 'ana-home', emails: [{ email: 'ana@home.test', primary: true, verified: true }] };
  await linkWhileSignedIn(base, script, 'github', ana);
  const viaGithub = await signIn(base, script, 'github');
  assert.equal((await me(base, viaGithub.session as string)).user?.sub, 'g-1');
  const user = (await store.getUserBySub('g-1'))!;
  assert.deepEqual(user.localGroups, ['brand'], "the invitation's groups joined the existing account");
  const inv = await store.findActiveInvitation('ana@home.test');
  assert.equal(inv?.acceptedUserId, user.id);
});

test('linking a sign-in that proves an invited address accepts the invitation then, once (plans/75 A11)', async () => {
  const { base, store, script } = await boot();
  const ana = (await signIn(base, script, 'primary')).session as string;
  const user = (await store.getUserBySub('g-1'))!;
  await store.createInvitation({ id: 'inv_home', email: 'ana@home.test', groups: [], invitedBy: 'user:someone', createdAt: new Date().toISOString() });
  script.github = { id: 910, login: 'ana-home', emails: [{ email: 'ana@home.test', primary: true, verified: true }] };
  const linked = await linkWhileSignedIn(base, script, 'github', ana);
  assert.equal(linked.done.status, 302);
  assert.equal((await store.getInvitation('inv_home'))?.acceptedUserId, user.id, 'accepted when the link is made, not at a later sign-in');
  const accepts = (await store.listAudit()).filter((e) => e.action === 'invite.accept');
  assert.equal(accepts.length, 1);
  assert.equal((accepts[0]!.payload as { via?: string }).via, 'link');
  // The welcome reaches the account that linked.
  assert.ok((await store.listMessages()).some((m) => m.id === 'msg_welcome_inv_home' && m.audience.users?.includes(user.id)));
  // Signing in through the linked GitHub account later accepts nothing more.
  await signIn(base, script, 'github');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'invite.accept').length, 1);

  // An invitation this account wrote itself is never accepted by linking.
  await store.createInvitation({ id: 'inv_mine', email: 'ana@side.test', groups: [], invitedBy: `user:${user.id}`, createdAt: new Date().toISOString() });
  script.github = { id: 911, login: 'ana-side', emails: [{ email: 'ana@side.test', primary: true, verified: true }] };
  await linkWhileSignedIn(base, script, 'github', ana);
  assert.equal((await store.getInvitation('inv_mine'))?.acceptedAt, undefined);
});

// ── Postgres: the 0039 backfill on a seeded database ─────────────────────────

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('migration 0039 backfills one identity row per existing user', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  const { default: pg } = await import('pg');
  const { runMigrations } = await import('../server/src/store/migrate.ts');
  const { createPostgresStore } = await import('../server/src/store/postgres.ts');
  const admin = new pg.Client({ connectionString: pgUrl });
  await admin.connect();
  try {
    // The shared suite lock (tests/pg-test-schema.ts SUITE_LOCK_KEY), so this
    // never drops the schema under another gated suite.
    await admin.query('select pg_advisory_lock($1)', [0x1011_0003]);
    await admin.query('drop schema public cascade; create schema public;');
    const before = await mkdtemp(join(tmpdir(), 'lw-mig-'));
    for (const f of await readdir('./migrations')) {
      if (f.endsWith('.sql') && f < '0039') await cp(join('./migrations', f), join(before, f));
    }
    await runMigrations(pgUrl as string, before);
    await admin.query(`insert into users (id, sub, email, groups, idp_groups, role, created_at, last_seen_at) values
      ('u1', 'google-sub-1', 'Ana@Example.com', '["admins"]', '["admins"]', 'member', '2026-01-01T00:00:00Z', '2026-09-01T00:00:00Z'),
      ('u2', 'github:42', 'bea@mail.test', '[]', '[]', 'member', '2026-02-01T00:00:00Z', '2026-09-02T00:00:00Z'),
      ('u3', 'proxy:carla', '', '[]', '[]', 'member', '2026-03-01T00:00:00Z', '2026-09-03T00:00:00Z')`);
    const applied = await runMigrations(pgUrl as string);
    assert.ok(applied.includes('0039_user_identities.sql'));
    const store = await createPostgresStore(pgUrl as string);
    try {
      const u1 = await store.listIdentities('u1');
      assert.deepEqual(u1.map((r) => [r.identitySub, r.idp, r.email, r.emailVerified]), [['google-sub-1', 'primary', 'ana@example.com', false]]);
      assert.equal(u1[0]?.linkedAt, '2026-01-01T00:00:00.000Z');
      assert.equal(u1[0]?.lastLoginAt, '2026-09-01T00:00:00.000Z');
      assert.deepEqual(u1[0]?.groups, ['admins'], "the account's own sign-in asserted the IdP groups it stored");
      assert.deepEqual((await store.listIdentities('u2')).map((r) => [r.idp, r.email]), [['github', 'bea@mail.test']]);
      assert.deepEqual((await store.listIdentities('u3')).map((r) => [r.idp, r.email]), [['proxy', undefined]]);
      assert.equal((await store.getUserByIdentity('github:42'))?.id, 'u2');
      assert.deepEqual(await store.findUsersByVerifiedEmail('ana@example.com'), [], 'backfilled rows are not verified');
    } finally { await store.close(); }
  } finally { await admin.end(); }
});

test('config: idp.linkedStandingDays is whole days from 1 to 365, absent by default', () => {
  const cfg = (idp: Record<string, unknown>) => JSON.stringify({
    instance: { name: 'X', baseUrl: 'http://localhost', pack: '/tmp' }, dev: { enabled: true },
    idp: { issuer: 'https://a.example', clientId: 'c', displayName: 'A', ...idp },
  });
  assert.equal(parseConfig(cfg({})).idp.linkedStandingDays, undefined, 'not written into the config, so the setup fingerprint stays');
  assert.equal(parseConfig(cfg({ linkedStandingDays: 7 })).idp.linkedStandingDays, 7);
  for (const bad of [0, 366, 1.5, '30']) {
    assert.throws(() => parseConfig(cfg({ linkedStandingDays: bad })), /invalid idp\.linkedStandingDays/);
  }
});
