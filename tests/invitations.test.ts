// SPDX-License-Identifier: MPL-2.0
/**
 * Invitations (plans/74 W-ID-2) over real HTTP. Pinned here: the routes are
 * gated on `user.invite` (admin and owner), input is validated before anything
 * is stored, inviting an address again is a no-op, revocation happens once,
 * and at sign-in an invitation admits a verified email, joins its groups to
 * the person's local groups (creating missing ones) and is accepted once.
 * An expired or revoked invitation admits nobody. The OIDC half uses a stub
 * issuer that signs genuine RS256 id_tokens; the proxy half uses the
 * reverse-proxy route.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { readInviteToken } from '../server/src/access/invite-token.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(over: Record<string, unknown>, fetchImpl?: typeof fetch, secrets: Record<string, string> = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-invite-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Invite Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    ...over,
  }));
  const store = createMemoryStore();
  const app = buildApp({
    config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sInv', link: 'lInv', ...secrets },
    ...(fetchImpl ? { fetchImpl } : {}),
  });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

const sessionOf = (res: Response): string | undefined =>
  res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))?.split(';')[0];

async function devLogin(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return sessionOf(res) as string;
}

const invite = (base: string, cookie: string | undefined, body: unknown) =>
  fetch(`${base}/api/v1/invitations`, {
    method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
const revoke = (base: string, cookie: string | undefined, id: string) =>
  fetch(`${base}/api/v1/invitations/${id}`, { method: 'DELETE', headers: cookie ? { cookie } : {} });

type Wire = { id: string; email: string; groups: string[]; status: string; created?: boolean; expiresAt: string | null; acceptedAt: string | null; acceptedUserId: string | null; revokedAt: string | null };

const DEV = { enabled: true, users: [
  { email: 'owner@test', groups: ['owner'] },
  { email: 'admin@test', groups: ['admin'] },
  { email: 'member@test', groups: [] },
  { email: 'designer@test', groups: ['designers'] },
] };

// ── routes ───────────────────────────────────────────────────────────────────

test('routes: sign-in required, user.invite required (admin and owner), members refused', async () => {
  const { base } = await boot({ dev: DEV });
  assert.equal((await fetch(`${base}/api/v1/invitations`)).status, 401);
  assert.equal((await invite(base, undefined, { emails: ['a@x.example'] })).status, 401);
  assert.equal((await revoke(base, undefined, 'inv_x')).status, 401);

  const member = await devLogin(base, 'member@test');
  assert.equal((await fetch(`${base}/api/v1/invitations`, { headers: { cookie: member } })).status, 403);
  assert.equal((await invite(base, member, { emails: ['a@x.example'] })).status, 403);
  assert.equal((await revoke(base, member, 'inv_x')).status, 403);

  for (const who of ['admin@test', 'owner@test']) {
    const cookie = await devLogin(base, who);
    const list = await fetch(`${base}/api/v1/invitations`, { headers: { cookie } });
    assert.equal(list.status, 200, who);
    const body = await list.json() as { invitations: unknown[]; signInUrl: string; admission: { policy: boolean; invitations: boolean } };
    assert.equal(body.signInUrl, 'https://team.example', 'the address to share is the instance base URL');
    assert.deepEqual(body.admission, { policy: false, invitations: true });
  }
  const session = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: await devLogin(base, 'admin@test') } })).json() as { console: { actions: string[] } };
  assert.ok(session.console.actions.includes('user.invite'), 'the console learns the action from the session');
});

test('routes: validation refuses bad input before anything is stored', async () => {
  const { base, store } = await boot({ dev: DEV });
  const admin = await devLogin(base, 'admin@test');
  await devLogin(base, 'designer@test'); // makes "designers" an IdP group
  const bad = async (body: unknown, status: number, code: string, field?: string) => {
    const res = await invite(base, admin, body);
    assert.equal(res.status, status, JSON.stringify(body));
    const err = (await res.json() as { error: { code: string; field?: string } }).error;
    assert.equal(err.code, code, JSON.stringify(body));
    if (field) assert.equal(err.field, field);
  };
  await bad([], 400, 'INVALID_INPUT');
  await bad({}, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: [] }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: ['  '] }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: 'a@x.example' }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: ['not-an-address'] }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: ['a b@x.example'] }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: Array.from({ length: 201 }, (_, i) => `p${i}@x.example`) }, 400, 'INVALID_INPUT', 'emails');
  await bad({ emails: ['a@x.example'], groups: 'team' }, 400, 'INVALID_INPUT', 'groups');
  await bad({ emails: ['a@x.example'], groups: ['has space'] }, 400, 'INVALID_INPUT', 'groups');
  await bad({ emails: ['a@x.example'], groups: ['-leading'] }, 400, 'INVALID_INPUT', 'groups');
  await bad({ emails: ['a@x.example'], groups: ['x'.repeat(65)] }, 400, 'INVALID_INPUT', 'groups');
  await bad({ emails: ['a@x.example'], groups: ['owner'] }, 403, 'OWNER_ONLY');
  await bad({ emails: ['a@x.example'], expiresAt: 'soon' }, 400, 'INVALID_INPUT', 'expiresAt');
  await bad({ emails: ['a@x.example'], expiresAt: 12 }, 400, 'INVALID_INPUT', 'expiresAt');
  await bad({ emails: ['a@x.example'], expiresAt: new Date(Date.now() - 1000).toISOString() }, 400, 'INVALID_INPUT', 'expiresAt');
  await bad({ emails: ['a@x.example'], expiresAt: new Date(Date.now() + 400 * 86_400_000).toISOString() }, 400, 'INVALID_INPUT', 'expiresAt');
  assert.deepEqual(await store.listInvitations(), [], 'nothing was stored');
  assert.equal((await store.listAudit()).some((e) => e.action === 'invite.create'), false);

  // An owner may hand out an owner group, even though "owner" is also an IdP
  // group here: that is how a second owner joins a groupless-IdP instance.
  const owner = await devLogin(base, 'owner@test');
  assert.equal((await invite(base, owner, { emails: ['co-owner@x.example'], groups: ['owner'] })).status, 201);
  assert.equal((await invite(base, owner, { emails: ['dee@x.example'], groups: ['designers'] })).status, 201, 'an owner may name an IdP group');
  const idpByAdmin = await invite(base, admin, { emails: ['eli@x.example'], groups: ['designers'] });
  assert.equal(idpByAdmin.status, 400, 'an admin is held to the local registry, like PUT local-groups');
  assert.equal((await idpByAdmin.json() as { error: { code: string } }).error.code, 'UNKNOWN_GROUP');
  assert.equal((await invite(base, admin, { emails: ['eli@x.example'], groups: ['made-up'] })).status, 400, 'an unregistered name is refused');
});

test('routes: create, idempotent re-invite, list, revoke once, re-invite after revoke; all audited', async () => {
  const { base, store } = await boot({ dev: DEV });
  const admin = await devLogin(base, 'admin@test');
  const expiresAt = new Date(Date.now() + 7 * 86_400_000).toISOString();
  for (const name of ['team', 'other']) await store.putLocalGroup({ name, createdAt: new Date().toISOString() });

  const first = await invite(base, admin, { emails: ['Ana@Example.com', 'ana@example.com', ' bo@example.com '], groups: ['team', 'team'], expiresAt });
  assert.equal(first.status, 201);
  const made = await first.json() as { invitations: Wire[]; signInUrl: string };
  assert.equal(made.signInUrl, 'https://team.example');
  assert.deepEqual(made.invitations.map((i) => [i.email, i.created, i.status]), [['ana@example.com', true, 'pending'], ['bo@example.com', true, 'pending']],
    'addresses are lowercased, trimmed and deduplicated');
  assert.deepEqual(made.invitations[0]?.groups, ['team']);
  assert.equal(made.invitations[0]?.expiresAt, expiresAt);
  const ana = made.invitations[0] as Wire;

  // Inviting the same address again changes nothing and says so.
  const again = await invite(base, admin, { emails: ['ANA@example.com'], groups: ['other'] });
  assert.equal(again.status, 200, 'nothing new: 200, not 201');
  const kept = (await again.json() as { invitations: Wire[] }).invitations[0] as Wire;
  assert.equal(kept.id, ana.id);
  assert.equal(kept.created, false);
  assert.deepEqual(kept.groups, ['team'], 'the existing invitation is returned unchanged');
  const mixed = await invite(base, admin, { emails: ['ana@example.com', 'cy@example.com'] });
  assert.equal(mixed.status, 201, 'a batch with anything new is a 201');
  assert.deepEqual((await mixed.json() as { invitations: Wire[] }).invitations.map((i) => i.created), [false, true]);
  assert.equal((await store.listAudit()).filter((e) => e.action === 'invite.create').length, 3, 'one audit row per invitation actually created');
  const createRow = (await store.listAudit()).find((e) => e.action === 'invite.create' && e.subject === `invitation:${ana.id}`);
  assert.deepEqual(createRow?.payload, { email: 'ana@example.com', groups: ['team'], expiresAt, via: 'console', passwordSetup: false });

  const listed = await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: admin } })).json() as { invitations: Wire[] };
  assert.equal(listed.invitations.length, 3);

  // Revoke once; the second attempt is a 404; an unknown id is a 404.
  const gone = await revoke(base, admin, ana.id);
  assert.equal(gone.status, 200);
  assert.equal((await gone.json() as Wire).status, 'revoked');
  assert.equal((await revoke(base, admin, ana.id)).status, 404);
  assert.equal((await revoke(base, admin, 'inv_nope')).status, 404);
  const revokeRow = (await store.listAudit()).find((e) => e.action === 'invite.revoke');
  assert.deepEqual(revokeRow?.payload, { email: 'ana@example.com', was: 'pending' });

  // After a revoke the address is free for a fresh invitation.
  const fresh = await invite(base, admin, { emails: ['ana@example.com'] });
  assert.equal(fresh.status, 201);
  assert.notEqual((await fresh.json() as { invitations: Wire[] }).invitations[0]?.id, ana.id);
  const statuses = (await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: admin } })).json() as { invitations: Wire[] })
    .invitations.filter((i) => i.email === 'ana@example.com').map((i) => i.status).sort();
  assert.deepEqual(statuses, ['pending', 'revoked'], 'revoked rows stay listed for the record');
});

test('routes: groups on an invitation carry the local-groups controls (grant.edit, role rank, owner-only grants, existing accounts)', async () => {
  const { base, store } = await boot({ dev: { enabled: true, users: [
    ...DEV.users,
    { email: 'inviter@test', groups: ['inviters'] },
    { email: 'mal@test', groups: ['recruiters'] },
  ] } });
  const owner = await devLogin(base, 'owner@test');
  const admin = await devLogin(base, 'admin@test');
  const grant = async (body: Record<string, string>) => {
    const res = await fetch(`${base}/api/v1/grants`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ resource: '*', effect: 'allow', ...body }) });
    assert.equal(res.status, 201, JSON.stringify(body));
  };
  for (const name of ['team', 'secops']) await store.putLocalGroup({ name, createdAt: new Date().toISOString() });
  await grant({ principal: 'group:inviters', action: 'user.invite' });
  await grant({ principal: 'group:recruiters', action: 'user.invite' });
  await grant({ principal: 'group:recruiters', action: 'grant.edit' });
  await grant({ principal: 'group:secops', action: 'token.manage' }); // owner-only power
  const code = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;

  // user.invite alone admits people; it does not assign groups.
  const inviter = await devLogin(base, 'inviter@test');
  assert.equal((await invite(base, inviter, { emails: ['plain@x.example'] })).status, 201);
  const noEdit = await invite(base, inviter, { emails: ['p2@x.example'], groups: ['team'] });
  assert.equal(noEdit.status, 403);
  assert.equal(await code(noEdit), 'FORBIDDEN');

  // A member holding user.invite and grant.edit cannot hand out a role above
  // their own, and cannot re-group their own account (or any existing one).
  const mal = await devLogin(base, 'mal@test');
  const selfAdmin = await invite(base, mal, { emails: ['mal@test'], groups: ['admin'] });
  assert.equal(selfAdmin.status, 403);
  assert.equal(await code(selfAdmin), 'ROLE_ESCALATION');
  assert.equal(await code(await invite(base, mal, { emails: ['friend@x.example'], groups: ['admin'] })), 'ROLE_ESCALATION');
  type Row = { email: string; status: string; reason?: string; created: boolean };
  const selfTeam = await invite(base, mal, { emails: ['MAL@test'], groups: ['team'] });
  assert.equal(selfTeam.status, 200);
  assert.deepEqual((await selfTeam.json() as { invitations: Row[] }).invitations.map((r) => [r.status, r.reason]), [['refused', 'self']],
    'never your own account');
  // An existing account gets the groups now (plans/74) instead of a 409.
  await devLogin(base, 'member@test');
  const existing = await invite(base, admin, { emails: ['member@test'], groups: ['team'] });
  assert.equal(existing.status, 200, 'nothing was created');
  assert.deepEqual((await existing.json() as { invitations: Row[] }).invitations.map((r) => [r.email, r.status, r.created]), [['member@test', 'applied', false]]);
  const memberRow = (await store.findUsersByEmail('member@test'))[0]!;
  assert.ok(memberRow.localGroups.includes('team'), 'the group is applied at once');
  assert.equal(await store.findActiveInvitation('member@test'), null, 'and no invitation is written');
  // An owner's account is re-grouped only by an owner.
  const ownerByAdmin = await invite(base, admin, { emails: ['owner@test'], groups: ['team'] });
  assert.deepEqual((await ownerByAdmin.json() as { invitations: Row[] }).invitations.map((r) => [r.status, r.reason]), [['refused', 'owner-only']]);
  assert.equal((await invite(base, mal, { emails: ['friend@x.example'], groups: ['team'] })).status, 201, 'a plain local group for a new person is fine');

  // A group carrying an owner-only grant is the grant guard's territory.
  const powered = await invite(base, admin, { emails: ['ops@x.example'], groups: ['secops'] });
  assert.equal(powered.status, 403);
  assert.equal(await code(powered), 'OWNER_ONLY_ACTION');
  assert.equal((await invite(base, owner, { emails: ['ops@x.example'], groups: ['secops'] })).status, 201);
  assert.deepEqual((await store.listInvitations()).map((i) => i.email).sort(), ['friend@x.example', 'ops@x.example', 'plain@x.example']);
});

// ── sign-in through a stub OIDC issuer ───────────────────────────────────────

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const ISSUER = 'https://accounts.google.test';
const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createSign('sha256').update(`${head}.${body}`).sign(privateKey))}`;
}
type Current = { nonce: string; claims: Record<string, unknown> };
function issuerFetch(current: Current): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${ISSUER}/.well-known/openid-configuration`) {
      return Response.json({ issuer: ISSUER, authorization_endpoint: `${ISSUER}/authorize`, token_endpoint: `${ISSUER}/token`, jwks_uri: `${ISSUER}/jwks` });
    }
    if (url === `${ISSUER}/jwks`) return Response.json({ keys: [JWK] });
    if (url === `${ISSUER}/token`) {
      return Response.json({ id_token: signIdToken({ iss: ISSUER, aud: 'g-client', nonce: current.nonce, exp: Math.floor(Date.now() / 1000) + 300, ...current.claims }) });
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}
async function oidcSignIn(base: string, current: Current, claims: Record<string, unknown>) {
  const started = await fetch(`${base}/api/auth/login?returnTo=%2Fadmin`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location') as string);
  current.nonce = authorize.searchParams.get('nonce') as string;
  current.claims = claims;
  const stateCookie = (started.headers.getSetCookie().find((c) => c.startsWith('lw_state=')) as string).split(';')[0] as string;
  const done = await fetch(`${base}/api/auth/callback?code=xyz&state=${authorize.searchParams.get('state')}`, { headers: { cookie: stateCookie }, redirect: 'manual' });
  return { done, session: sessionOf(done) };
}
async function whoami(base: string, cookie: string) {
  const res = await fetch(`${base}/api/auth/session`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { user: { role: string; groups: string[] } }).user;
}
const deniedReasons = async (store: ReturnType<typeof createMemoryStore>) =>
  (await store.listAudit()).filter((e) => e.action === 'auth.denied').map((e) => (e.payload as { reason: string; email: string }));

const gatedIdp = (admission: Record<string, unknown> = { emails: ['ana@example.com'] }) => ({
  issuer: ISSUER, clientId: 'g-client', displayName: 'Google',
  admission, ...((admission.emails as string[] | undefined)?.includes('ana@example.com') ? { bootstrapOwners: ['ana@example.com'] } : {}),
});

test('admission by invitation end to end: invited, groups joined and created, accepted once, revoke blocks the next sign-in', async () => {
  const current: Current = { nonce: '', claims: {} };
  const { base, store } = await boot({ idp: gatedIdp() }, issuerFetch(current));

  // The bootstrap owner signs in and invites Bo into a group that does not exist yet.
  const ana = await oidcSignIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true });
  assert.equal(ana.done.status, 302);
  const owner = ana.session as string;
  assert.equal((await whoami(base, owner)).role, 'owner');

  // Not invited yet: refused, no row.
  const early = await oidcSignIn(base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(early.done.status, 403);
  assert.equal(await store.getUserBySub('g-bo'), null);

  // An invitation names a group that exists, like PUT local-groups does.
  assert.equal((await invite(base, owner, { emails: ['bo@partner.example'], groups: ['team'] })).status, 400, 'no such local group yet');
  const group = await fetch(`${base}/api/v1/groups`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'team' }) });
  assert.equal(group.status, 201);
  const created = await invite(base, owner, { emails: ['Bo@Partner.example'], groups: ['team'], expiresAt: new Date(Date.now() + 86_400_000).toISOString() });
  assert.equal(created.status, 201);
  const inv = (await created.json() as { invitations: Wire[] }).invitations[0] as Wire;

  // An unverified email does not get to use the invitation, and does not consume it.
  const unverified = await oidcSignIn(base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: false });
  assert.equal(unverified.done.status, 403);
  assert.equal((await store.getInvitation(inv.id))?.acceptedAt, undefined);

  // The invited, verified sign-in is admitted and joins the group.
  const bo = await oidcSignIn(base, current, { sub: 'g-bo', email: 'BO@partner.example', email_verified: true });
  assert.equal(bo.done.status, 302);
  const boUser = await whoami(base, bo.session as string);
  assert.ok(boUser.groups.includes('team'), 'the fresh session already carries the invitation group');
  assert.equal(boUser.role, 'member');
  const row = await store.getUserBySub('g-bo');
  assert.deepEqual(row?.localGroups, ['team'], 'joined as a LOCAL group, so an IdP re-sync keeps it');
  assert.deepEqual((await store.listLocalGroups()).map((g) => g.name), ['team'], 'no group was invented');
  const accepted = await store.getInvitation(inv.id);
  assert.equal(accepted?.acceptedUserId, row?.id);
  assert.ok(accepted?.acceptedAt);
  const audit = await store.listAudit();
  const acceptRow = audit.find((e) => e.action === 'invite.accept');
  assert.equal(acceptRow?.subject, `invitation:${inv.id}`);
  assert.deepEqual(acceptRow?.payload, { via: 'sign-in', provider: 'oidc', idp: 'primary', email: 'bo@partner.example', groups: ['team'] });
  assert.equal((audit.findLast((e) => e.action === 'auth.login')?.payload as { admittedVia?: string }).admittedVia, 'invitation');

  // An owner removes Bo from the group; the next sign-in does not put it back.
  await store.setLocalGroups(row!.id, []);
  const second = await oidcSignIn(base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(second.done.status, 302, 'an accepted invitation keeps admitting');
  assert.deepEqual((await store.getUserBySub('g-bo'))?.localGroups, [], 'groups are applied once, at acceptance');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'invite.accept').length, 1, 'accepted exactly once');

  // Revoking the accepted invitation blocks the next sign-in.
  const listedAccepted = (await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: owner } })).json() as { invitations: Wire[] })
    .invitations.find((i) => i.id === inv.id);
  assert.equal(listedAccepted?.status, 'accepted');
  assert.equal((await revoke(base, owner, inv.id)).status, 200);
  assert.deepEqual((await store.listAudit()).findLast((e) => e.action === 'invite.revoke')?.payload, { email: 'bo@partner.example', was: 'accepted' });
  const after = await oidcSignIn(base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(after.done.status, 403);
  assert.deepEqual((await deniedReasons(store)).at(-1), { provider: 'oidc', idp: 'primary', reason: 'not-invited', email: 'bo@partner.example' });
});

test('an invitation written for an account that already existed is accepted but never re-groups it', async () => {
  const current: Current = { nonce: '', claims: {} };
  const { base, store } = await boot({ idp: gatedIdp({ emails: ['ana@example.com'], domains: ['example.com'] }) }, issuerFetch(current));
  const mal = await oidcSignIn(base, current, { sub: 'g-mal', email: 'mal@example.com', email_verified: true });
  assert.equal(mal.done.status, 302);
  // As if written before the route refused it: the account predates the invitation.
  await new Promise((r) => setTimeout(r, 5));
  await store.createInvitation({ id: 'inv_mal', email: 'mal@example.com', groups: ['admin'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const again = await oidcSignIn(base, current, { sub: 'g-mal', email: 'mal@example.com', email_verified: true });
  assert.equal(again.done.status, 302);
  const row = await store.getUserBySub('g-mal');
  assert.deepEqual(row?.localGroups, [], 'no group joined');
  assert.equal(row?.role, 'member', 'no escalation');
  assert.equal((await store.getInvitation('inv_mal'))?.acceptedUserId, row?.id, 'still recorded as accepted');
  assert.equal((await store.listLocalGroups()).length, 0, 'no group created');
  assert.deepEqual((await store.listAudit()).find((e) => e.action === 'invite.accept')?.payload,
    { via: 'sign-in', provider: 'oidc', idp: 'primary', email: 'mal@example.com', groups: ['admin'], groupsNotApplied: 'existing-account' });
});

test('device sign-in asks admission again: a revoked invitation cannot be renewed from a live session', async () => {
  const current: Current = { nonce: '', claims: {} };
  const { base, store } = await boot({ idp: gatedIdp({}) }, issuerFetch(current));
  await store.createInvitation({ id: 'inv_dev', email: 'bo@partner.example', groups: [], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const bo = await oidcSignIn(base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(bo.done.status, 302);
  const cookie = bo.session as string;
  const deviceSignIn = async () => {
    const started = await (await fetch(`${base}/api/v1/auth/device`, { method: 'POST' })).json() as { deviceCode: string; userCode: string };
    const approve = await fetch(`${base}/activate`, {
      method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ code: started.userCode, decision: 'approve' }).toString(),
    });
    assert.equal(approve.status, 200);
    const token = await fetch(`${base}/api/v1/auth/device/token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode: started.deviceCode }) });
    return { status: (await token.json() as { status: string }).status, session: sessionOf(token) };
  };
  assert.equal((await deviceSignIn()).status, 'approved', 'admitted: the device gets a session');

  await store.revokeInvitation('inv_dev', new Date().toISOString());
  const after = await deviceSignIn();
  assert.equal(after.status, 'denied', 'no longer admitted: no fresh session');
  assert.equal(after.session, undefined);
  assert.deepEqual((await deniedReasons(store)).at(-1), { provider: 'device', reason: 'not-admitted', email: 'bo@partner.example' });
});

test('admission by invitation: an expired or revoked pending invitation admits nobody', async () => {
  const current: Current = { nonce: '', claims: {} };
  const { base, store } = await boot({ idp: gatedIdp({}) }, issuerFetch(current)); // {} = invitations only
  const past = new Date(Date.now() - 60_000).toISOString();
  await store.createInvitation({ id: 'inv_old', email: 'cy@partner.example', groups: ['team'], invitedBy: 'user:x', createdAt: past, expiresAt: past });
  const expired = await oidcSignIn(base, current, { sub: 'g-cy', email: 'cy@partner.example', email_verified: true });
  assert.equal(expired.done.status, 403);
  assert.equal(await store.getUserBySub('g-cy'), null);
  assert.equal((await store.getInvitation('inv_old'))?.acceptedAt, undefined, 'an expired invitation is never accepted');

  await store.createInvitation({ id: 'inv_dy', email: 'dy@partner.example', groups: [], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  await store.revokeInvitation('inv_dy', new Date().toISOString());
  const revoked = await oidcSignIn(base, current, { sub: 'g-dy', email: 'dy@partner.example', email_verified: true });
  assert.equal(revoked.done.status, 403);
  assert.deepEqual((await deniedReasons(store)).map((d) => d.reason), ['not-invited', 'not-invited']);
  assert.equal((await store.listUsers()).length, 0);
});

test('admission by invitation: invitations switched off in config admit nobody; an open instance still applies the groups', async () => {
  const current: Current = { nonce: '', claims: {} };
  const off = await boot({ idp: gatedIdp({ invitations: false }) }, issuerFetch(current));
  await off.store.createInvitation({ id: 'inv_off', email: 'bo@partner.example', groups: ['team'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const refused = await oidcSignIn(off.base, current, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(refused.done.status, 403);
  assert.equal((await off.store.getInvitation('inv_off'))?.acceptedAt, undefined);

  // No admission block: everyone is admitted, and a verified invited email
  // still picks up its groups. An unverified one does not.
  const openCurrent: Current = { nonce: '', claims: {} };
  const open = await boot({ idp: { issuer: ISSUER, clientId: 'g-client', displayName: 'Google' } }, issuerFetch(openCurrent));
  await open.store.createInvitation({ id: 'inv_open', email: 'bo@partner.example', groups: ['team'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  await open.store.createInvitation({ id: 'inv_unv', email: 'eve@partner.example', groups: ['team'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const unv = await oidcSignIn(open.base, openCurrent, { sub: 'g-eve', email: 'eve@partner.example' });
  assert.equal(unv.done.status, 302, 'open instance admits');
  assert.deepEqual((await open.store.getUserBySub('g-eve'))?.localGroups, [], 'an unverified email never takes an invitation');
  assert.equal((await open.store.getInvitation('inv_unv'))?.acceptedAt, undefined);
  const bo = await oidcSignIn(open.base, openCurrent, { sub: 'g-bo', email: 'bo@partner.example', email_verified: true });
  assert.equal(bo.done.status, 302);
  assert.deepEqual((await open.store.getUserBySub('g-bo'))?.localGroups, ['team']);
});

test('revoking an accepted owner invitation is owner-only', async () => {
  const current: Current = { nonce: '', claims: {} };
  const { base, store } = await boot({ idp: { ...gatedIdp(), roleGroups: { owner: ['owners'], admin: ['admins'] } } }, issuerFetch(current));
  const owner = (await oidcSignIn(base, current, { sub: 'g-ana', email: 'ana@example.com', email_verified: true })).session as string;
  const made = await (await invite(base, owner, { emails: ['co@partner.example', 'ad@partner.example'], groups: [] })).json() as { invitations: Wire[] };
  const [co, ad] = made.invitations as [Wire, Wire];
  // Co is invited as an owner, Ad as an admin (set directly: the route test above covers the owner-group guard).
  await oidcSignIn(base, current, { sub: 'g-co', email: 'co@partner.example', email_verified: true });
  await oidcSignIn(base, current, { sub: 'g-ad', email: 'ad@partner.example', email_verified: true });
  await store.putLocalGroup({ name: 'owners', createdAt: new Date().toISOString() });
  await store.putLocalGroup({ name: 'admins', createdAt: new Date().toISOString() });
  await store.setLocalGroups((await store.getUserBySub('g-co'))!.id, ['owners']);
  await store.setLocalGroups((await store.getUserBySub('g-ad'))!.id, ['admins']);
  const admin = (await oidcSignIn(base, current, { sub: 'g-ad', email: 'ad@partner.example', email_verified: true })).session as string;
  assert.equal((await whoami(base, admin)).role, 'admin');
  const blocked = await revoke(base, admin, co.id);
  assert.equal(blocked.status, 403);
  assert.equal((await blocked.json() as { error: { code: string } }).error.code, 'OWNER_ONLY');
  assert.equal((await invite(base, admin, { emails: ['x@partner.example'], groups: ['owners'] })).status, 403, 'a group mapped to owner is owner-only');
  assert.equal((await revoke(base, owner, co.id)).status, 200);
  assert.ok(ad.id);
});

// ── sign-in through the reverse proxy ────────────────────────────────────────

test('admission by invitation through the reverse proxy', async () => {
  const SECRET = 'proxy-shared-secret-0123456789';
  const { base, store } = await boot({
    proxyAuth: { enabled: true, displayName: 'YunoHost' },
    idp: { admission: {} },
  }, undefined, { proxyAuth: SECRET });
  const headers = { 'x-lw-proxy-auth': SECRET, ynh_user: 'bo', ynh_user_email: 'bo@partner.example' };
  const before = await fetch(`${base}/api/auth/proxy`, { headers, redirect: 'manual' });
  assert.equal(before.status, 403);
  await store.createInvitation({ id: 'inv_px', email: 'bo@partner.example', groups: ['team', 'brand'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const admitted = await fetch(`${base}/api/auth/proxy`, { headers, redirect: 'manual' });
  assert.equal(admitted.status, 302);
  assert.deepEqual((await store.getUserBySub('proxy:bo'))?.localGroups, ['team', 'brand']);
  assert.deepEqual((await store.listAudit()).find((e) => e.action === 'invite.accept')?.payload,
    { via: 'sign-in', provider: 'proxy', email: 'bo@partner.example', groups: ['team', 'brand'], createdGroups: ['team', 'brand'] });
});

// ── the CLI drives the same routes ───────────────────────────────────────────

test('lw invite add / ls / rm', async () => {
  const { base, store } = await boot({ dev: DEV });
  for (const name of ['team', 'brand']) await store.putLocalGroup({ name, createdAt: new Date().toISOString() });
  const owner = await devLogin(base, 'owner@test');
  const minted = await (await fetch(`${base}/api/v1/tokens`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'ci', role: 'admin' }),
  })).json() as { token: string };
  const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
  const home = await mkdtemp(join(tmpdir(), 'lw-invite-cli-'));
  const run = (args: string[]) => promisify(execFile)(process.execPath, [CLI, ...args], {
    env: { ...process.env, HOME: home, LW_BASE: base, LW_TOKEN: minted.token },
  });

  const added = await run(['invite', 'add', 'ana@example.com', 'bo@example.com', '--group', 'team', '--group', 'brand']);
  assert.match(added.stdout, /invited +inv_[\w-]+ +ana@example\.com +pending +groups team,brand/);
  assert.match(added.stdout, /share the sign-in address: https:\/\/team\.example/);
  const repeat = await run(['invite', 'add', 'ana@example.com']);
  assert.match(repeat.stdout, /existing +inv_[\w-]+ +ana@example\.com/);

  const listed = JSON.parse((await run(['invite', 'ls', '--json'])).stdout) as { invitations: Wire[] };
  assert.equal(listed.invitations.length, 2);
  const id = listed.invitations.find((i) => i.email === 'bo@example.com')?.id as string;
  const removed = await run(['invite', 'rm', id]);
  assert.match(removed.stdout, new RegExp(`revoked ${id} \\(bo@example\\.com\\)`));
  assert.doesNotMatch((await run(['invite', 'ls'])).stdout, /bo@example\.com/, 'revoked rows hide by default');
  assert.match((await run(['invite', 'ls', '--all'])).stdout, /bo@example\.com +revoked/);
  await assert.rejects(run(['invite', 'add']), /usage: lw invite add/);
});

// ── invite links, New link and Invite again (plans/74 invite spec R13 to R16) ─

const PASSWORD = { id: 'email', kind: 'password', displayName: 'Email and password' };
const post = (base: string, cookie: string, path: string, body: unknown = {}) =>
  fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
type LinkWire = Wire & {
  link: string | null; linkVersion: number; openedAt: string | null; passwordSetup: boolean; password: string;
  inviter: { name: string } | null; createdVia: string; acceptedUser: { name: string; email: string } | null;
  projects: Array<{ projectId: string; name: string | null; role: string; invitedBy: { name: string } | null }>;
};
const tokenOf = (link: string): string => link.slice(link.lastIndexOf('/') + 1);

test('invitation wires: a personal link while pending, names and projects, password state, and the message context', async () => {
  const { base, store } = await boot({
    dev: { enabled: true, users: [...DEV.users, { email: 'ada@test', name: 'Ada', groups: ['admin'] }] },
    idp: { additional: [PASSWORD] },
    instance: { name: 'lolly.ing', baseUrl: 'https://team.example', inviteNote: 'Use GitHub or email and password.' },
    policy: { invites: { passwordDomains: ['suse.com'] } },
  });
  const ada = await devLogin(base, 'ada@test');
  const made = await invite(base, ada, { emails: ['sam@suse.com'], passwordSetup: true });
  assert.equal(made.status, 201);
  const body = await made.json() as { invitations: LinkWire[]; providers: string[]; passwordSignIn: boolean; passwordDomains: string[]; inviteNote: string | null };
  const sam = body.invitations[0]!;
  assert.match(sam.link!, /^https:\/\/team\.example\/l\/invite\/[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/);
  assert.deepEqual(readInviteToken(tokenOf(sam.link!), ['lInv']), { invitationId: sam.id, projectId: null, version: 1 },
    'the console carries the workspace link, signed with the link secret');
  assert.deepEqual([sam.linkVersion, sam.openedAt, sam.passwordSetup, sam.password, sam.createdVia], [1, null, true, 'none', 'console']);
  assert.deepEqual(sam.inviter, { name: 'Ada' }, 'named, never by address');
  assert.deepEqual([body.providers, body.passwordSignIn, body.passwordDomains, body.inviteNote],
    [['Email and password'], true, ['suse.com'], 'Use GitHub or email and password.']);
  const create = (await store.listAudit()).find((e) => e.action === 'invite.create');
  assert.deepEqual(create?.payload, { email: 'sam@suse.com', groups: [], via: 'console', passwordSetup: true });

  // A password set since ends what the flag offers; the wire says so.
  await store.putPasswordCredential({ id: 'pw_1', email: 'sam@suse.com', hash: 'x', at: new Date().toISOString(), ownerIssued: false });
  const listed = await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: ada } })).json() as { invitations: LinkWire[] };
  assert.equal(listed.invitations.find((i) => i.id === sam.id)?.password, 'set');

  // A project invitation shows its project and who put it there.
  const projectId = (await (await post(base, ada, '/api/v1/projects', { name: 'Brand refresh' })).json() as { id: string }).id;
  assert.equal((await post(base, ada, `/api/v1/projects/${projectId}/invite`, { emails: ['bo@x.example'], role: 'editor' })).status, 200);
  const all = await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: ada } })).json() as { invitations: LinkWire[] };
  const bo = all.invitations.find((i) => i.email === 'bo@x.example')!;
  assert.equal(bo.createdVia, 'project');
  assert.deepEqual(bo.projects, [{ projectId, name: 'Brand refresh', role: 'editor', invitedBy: { name: 'Ada' } }]);

  // Ended rows carry no link; an accepted one names the account.
  const revoked = await (await revoke(base, ada, bo.id)).json() as LinkWire;
  assert.deepEqual([revoked.status, revoked.link], ['revoked', null]);
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await store.createInvitation({ id: 'inv_old', email: 'old@x.example', groups: [], invitedBy: 'user:x', createdAt: past, expiresAt: past });
  const member = (await store.findUsersByEmail('ada@test'))[0]!;
  await store.createInvitation({ id: 'inv_acc', email: 'acc@x.example', groups: [], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  await store.acceptInvitation('inv_acc', member.id, new Date().toISOString());
  const later = await (await fetch(`${base}/api/v1/invitations`, { headers: { cookie: ada } })).json() as { invitations: LinkWire[] };
  const old = later.invitations.find((i) => i.id === 'inv_old')!;
  assert.deepEqual([old.status, old.link, old.inviter], ['expired', null, null]);
  const acc = later.invitations.find((i) => i.id === 'inv_acc')!;
  assert.deepEqual([acc.status, acc.link, acc.acceptedUser], ['accepted', null, { name: 'Ada', email: 'ada@test' }]);
});

test('POST /api/v1/invitations: an account that holds the address is "already", and the password tick needs an admin and password sign-in', async () => {
  const { base, store } = await boot({ dev: DEV, idp: { additional: [PASSWORD] } });
  const admin = await devLogin(base, 'admin@test');
  await devLogin(base, 'member@test');
  const res = await invite(base, admin, { emails: ['member@test', 'new@x.example'] });
  assert.equal(res.status, 201);
  const rows = (await res.json() as { invitations: Array<{ email: string; status: string; created: boolean; userIds?: string[] }> }).invitations;
  const memberId = (await store.findUsersByEmail('member@test'))[0]!.id;
  assert.deepEqual(rows.map((r) => [r.email, r.status, r.created]), [['member@test', 'already', false], ['new@x.example', 'pending', true]]);
  assert.deepEqual(rows[0]?.userIds, [memberId]);
  assert.equal(await store.findActiveInvitation('member@test'), null, 'no row is written for someone already here');
  assert.equal((await invite(base, admin, { emails: ['p@x.example'], passwordSetup: 'yes' })).status, 400);

  // A member who holds user.invite may invite, but not with a password link.
  await store.putGrant({ principal: `user:${memberId}`, action: 'user.invite', resource: '*', effect: 'allow' });
  const member = await devLogin(base, 'member@test');
  const byMember = await (await invite(base, member, { emails: ['m@suse.com'], passwordSetup: true })).json() as { invitations: LinkWire[] };
  assert.equal(byMember.invitations[0]?.passwordSetup, false, 'ignored, not refused');

  // Without password sign-in the tick means nothing, even for an admin.
  const plain = await boot({ dev: DEV });
  const plainAdmin = await devLogin(plain.base, 'admin@test');
  const made = await (await invite(plain.base, plainAdmin, { emails: ['p@x.example'], passwordSetup: true })).json() as { invitations: LinkWire[]; passwordSignIn: boolean };
  assert.deepEqual([made.invitations[0]?.passwordSetup, made.passwordSignIn], [false, false]);
});

test('POST /api/v1/invitations supersedes the open join request of an address it invites', async () => {
  const { base, store } = await boot({ dev: DEV });
  const admin = await devLogin(base, 'admin@test');
  const now = new Date();
  await store.createAccessRequest({
    id: 'req_join', kind: 'join', status: 'open', email: 'zed@x.example', idp: 'github', identitySub: 'github:9',
    createdAt: now.toISOString(), expiresAt: new Date(now.getTime() + 14 * 86_400_000).toISOString(),
  }, now.toISOString());
  assert.equal((await invite(base, admin, { emails: ['zed@x.example'] })).status, 201);
  assert.equal((await store.getAccessRequest('req_join'))?.status, 'superseded');
  const adminId = (await store.findUsersByEmail('admin@test'))[0]!.id;
  const row = (await store.listAudit()).find((e) => e.action === 'access.supersede');
  assert.deepEqual([row?.actor, row?.subject, row?.payload], [`user:${adminId}`, 'request:req_join', { kind: 'join', by: 'invitation' }]);
});

test('New link (R13): the version goes up and earlier links stop matching; pending only; ten a day per invitation', async () => {
  const { base, store } = await boot({ dev: DEV });
  const admin = await devLogin(base, 'admin@test');
  const first = (await (await invite(base, admin, { emails: ['ana@x.example'] })).json() as { invitations: LinkWire[] }).invitations[0]!;
  assert.equal(await store.markInvitationOpened(first.id, new Date().toISOString()), true);

  const res = await post(base, admin, `/api/v1/invitations/${first.id}/link`);
  assert.equal(res.status, 200);
  const next = (await res.json() as { invitation: LinkWire }).invitation;
  assert.deepEqual([next.id, next.linkVersion, next.openedAt], [first.id, 2, null], 'opened again counts from the new link');
  assert.notEqual(next.link, first.link);
  // The invite page compares the signed version with the stored one, so a
  // link copied before reads as ended there.
  assert.equal(readInviteToken(tokenOf(first.link!), ['lInv'])?.version, 1);
  assert.equal(readInviteToken(tokenOf(next.link!), ['lInv'])?.version, (await store.getInvitation(first.id))?.linkVersion);
  const adminId = (await store.findUsersByEmail('admin@test'))[0]!.id;
  const row = (await store.listAudit()).find((e) => e.action === 'invite.link');
  assert.deepEqual([row?.actor, row?.subject, row?.payload], [`user:${adminId}`, `invitation:${first.id}`, { email: 'ana@x.example', version: 2 }]);

  // Ten new links a day for one invitation, then 429.
  for (let i = 0; i < 9; i++) assert.equal((await post(base, admin, `/api/v1/invitations/${first.id}/link`)).status, 200, `link ${i + 2}`);
  const eleventh = await post(base, admin, `/api/v1/invitations/${first.id}/link`);
  assert.equal(eleventh.status, 429);
  assert.equal((await eleventh.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
  assert.equal((await store.getInvitation(first.id))?.linkVersion, 11);

  // Only a pending invitation: accepted and expired are 409, revoked and unknown 404, members 403.
  const at = new Date().toISOString();
  await store.createInvitation({ id: 'inv_acc', email: 'acc@x.example', groups: [], invitedBy: 'user:x', createdAt: at });
  await store.acceptInvitation('inv_acc', adminId, at);
  const past = new Date(Date.now() - 1000).toISOString();
  await store.createInvitation({ id: 'inv_exp', email: 'exp@x.example', groups: [], invitedBy: 'user:x', createdAt: past, expiresAt: past });
  await store.createInvitation({ id: 'inv_rev', email: 'rev@x.example', groups: [], invitedBy: 'user:x', createdAt: at });
  await store.revokeInvitation('inv_rev', at);
  const code = async (r: Response) => [r.status, (await r.json() as { error: { code: string } }).error.code];
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_acc/link')), [409, 'NOT_PENDING']);
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_exp/link')), [409, 'NOT_PENDING']);
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_rev/link')), [404, 'NOT_FOUND']);
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_nope/link')), [404, 'NOT_FOUND']);
  assert.equal((await post(base, await devLogin(base, 'member@test'), `/api/v1/invitations/${first.id}/link`)).status, 403);
});

test('Invite again (R14): a fresh invitation for an ended one, under the same group checks; refused while another is live', async () => {
  const { base, store } = await boot({ dev: DEV });
  const admin = await devLogin(base, 'admin@test');
  const adminId = (await store.findUsersByEmail('admin@test'))[0]!.id;
  await store.putLocalGroup({ name: 'team', createdAt: new Date().toISOString() });
  const longAgo = new Date(Date.now() - 40 * 86_400_000).toISOString();
  const past = new Date(Date.now() - 86_400_000).toISOString();
  await store.createInvitation({
    id: 'inv_exp', email: 'cy@x.example', groups: ['team'], invitedBy: 'user:someone', createdAt: longAgo, expiresAt: past,
    projects: [{ projectId: 'prj_a', role: 'editor', invitedBy: 'user:other' }, { projectId: 'prj_b', role: 'viewer' }], createdVia: 'project',
  });

  const before = Date.now();
  const res = await post(base, admin, '/api/v1/invitations/inv_exp/reinvite');
  assert.equal(res.status, 201);
  const fresh = (await res.json() as { invitation: LinkWire }).invitation;
  assert.notEqual(fresh.id, 'inv_exp');
  assert.deepEqual([fresh.status, fresh.groups, fresh.createdVia, fresh.linkVersion], ['pending', ['team'], 'project', 1]);
  assert.deepEqual((await store.getInvitation(fresh.id))?.projects, [
    { projectId: 'prj_a', role: 'editor', invitedBy: 'user:other' }, { projectId: 'prj_b', role: 'viewer', invitedBy: 'user:someone' },
  ], 'the projects keep who put them there, so acceptance asks about the same people');
  assert.ok(fresh.link);
  const ttl = Date.parse(fresh.expiresAt!) - before;
  assert.ok(ttl > 719 * 3_600_000 && ttl <= 720 * 3_600_000 + 60_000, 'a fresh 30 days');
  assert.ok((await store.getInvitation('inv_exp'))?.revokedAt, 'the expired one ends, so its links stop working');
  const create = (await store.listAudit()).find((e) => e.action === 'invite.create' && e.subject === `invitation:${fresh.id}`);
  assert.equal(create?.actor, `user:${adminId}`);
  assert.deepEqual([create?.payload?.via, create?.payload?.from], ['reinvite', 'inv_exp']);

  const code = async (r: Response) => [r.status, (await r.json() as { error: { code: string } }).error.code];
  // A live invitation for the address: 409 with it. A pending one: not ended.
  await revoke(base, admin, fresh.id);
  await store.createInvitation({ id: 'inv_live', email: 'cy@x.example', groups: [], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  const clash = await post(base, admin, `/api/v1/invitations/${fresh.id}/reinvite`);
  assert.equal(clash.status, 409);
  const clashBody = await clash.json() as { error: { code: string; invitation: { id: string } } };
  assert.deepEqual([clashBody.error.code, clashBody.error.invitation.id], ['ACTIVE_INVITATION', 'inv_live']);
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_live/reinvite')), [409, 'NOT_ENDED']);
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_nope/reinvite')), [404, 'NOT_FOUND']);

  // A revoked invitation that never ended stays without an end; the groups are checked again.
  await store.createInvitation({ id: 'inv_own', email: 'boss@x.example', groups: ['owner'], invitedBy: 'user:x', createdAt: new Date().toISOString() });
  await store.revokeInvitation('inv_own', new Date().toISOString());
  assert.deepEqual(await code(await post(base, admin, '/api/v1/invitations/inv_own/reinvite')), [403, 'OWNER_ONLY']);
  const owner = await devLogin(base, 'owner@test');
  assert.deepEqual(await code(await post(base, owner, '/api/v1/invitations/inv_own/reinvite', { expiresAt: 'soon' })), [400, 'INVALID_INPUT']);
  const byOwner = await post(base, owner, '/api/v1/invitations/inv_own/reinvite');
  assert.equal(byOwner.status, 201);
  assert.equal((await byOwner.json() as { invitation: LinkWire }).invitation.expiresAt, null);
  assert.equal((await post(base, await devLogin(base, 'member@test'), '/api/v1/invitations/inv_exp/reinvite')).status, 403);
});
