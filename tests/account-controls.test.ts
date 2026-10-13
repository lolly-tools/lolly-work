// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { buildApp } from '../server/src/api/app.ts';
import { loadSecrets, parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createLinkPasswordAttempts } from '../server/src/links/password-attempts.ts';
import { mintGuestCookie, mintSessionCookie, readMemberSession, readPrincipal, type SessionUser } from '../server/src/iam/sessions.ts';
import { mintToken } from '../server/src/iam/tokens.ts';
import { resolveMember } from '../server/src/iam/member.ts';
import { localSessionKey, revokeBrowserSessions } from '../server/src/iam/local-logout.ts';
import { hashPassword } from '../server/src/lib/crypto.ts';
import { signLink } from '../server/src/links/sign.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import { credentialExpiry } from '../server/src/iam/credential-expiry.ts';

const sessionSecret = 'owned-account-session', linkSecret = 'owned-account-link';
const cookieOnly = (value: string) => value.split(';')[0]!;

test('link password cooldown is per client, fixed, and keeps a bounded cache', () => {
  let now = 1000;
  const attempts = createLinkPasswordAttempts(() => now, 2);
  for (let i = 0; i < 10; i++) attempts.miss('shared', 'client-a');
  assert.equal(attempts.retryAfter('shared', 'client-a'), 900);
  assert.equal(attempts.retryAfter('shared', 'client-b'), 0);
  assert.equal(attempts.retryAfter('other', 'client-a'), 0);
  now += 899000; attempts.miss('shared', 'client-a');
  assert.equal(attempts.retryAfter('shared', 'client-a'), 1);
  now += 1000; assert.equal(attempts.retryAfter('shared', 'client-a'), 0);
  attempts.miss('a', 'a'); attempts.miss('b', 'b'); attempts.miss('c', 'c');
  assert.equal(attempts.size, 2);
});

test('local logout revokes the renewal chain and guest cookie, preserving another device', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'person', email: 'person@fixture.test', groups: ['owner'], role: 'owner' });
  const person: SessionUser = { sub: user.sub, email: user.email, name: 'Person', groups: user.groups, role: user.role, epoch: user.sessionEpoch };
  const first = cookieOnly(mintSessionCookie(person, sessionSecret, false));
  const other = cookieOnly(mintSessionCookie(person, sessionSecret, false));
  const read = readMemberSession(first, sessionSecret)!;
  const renewed = cookieOnly(mintSessionCookie(read.user, sessionSecret, false));
  const guest = cookieOnly(mintGuestCookie({ linkId: 'shared', toolId: 'sample', inviter: user.id, name: 'Guest' }, sessionSecret, false, 3600));
  await revokeBrowserSessions(store, `${first}; ${guest}`, sessionSecret);
  assert.equal(await resolveMember(store, first, sessionSecret), null);
  assert.equal(await resolveMember(store, renewed, sessionSecret), null);
  assert.equal((await resolveMember(store, other, sessionSecret))?.id, user.id);
  assert.ok(await store.localSessionRevoked(localSessionKey(readPrincipal(guest, sessionSecret)!)!));
  assert.equal((await store.getUser(user.id))!.sessionEpoch, user.sessionEpoch);
});

test('legacy session fallback carries the same revocation id through renewal', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'legacy', email: 'legacy@fixture.test', groups: ['owner'], role: 'owner' });
  const body: SessionUser = { sub: user.sub, email: user.email, name: 'Legacy', groups: user.groups, role: user.role };
  const legacy = `lw_session=${mintToken('lw/session', body, sessionSecret, 3600)}`;
  const session = readMemberSession(legacy, sessionSecret)!;
  assert.match(session.user.revocationId!, /^legacy:/);
  const renewed = cookieOnly(mintSessionCookie(session.user, sessionSecret, false));
  await revokeBrowserSessions(store, legacy, sessionSecret);
  assert.equal(await resolveMember(store, renewed, sessionSecret), null);
});

test('known evaluation material is refused in production, including previous keys', () => {
  for (const key of ['LW_SESSION_SECRET', 'LW_LINK_SECRET', 'LW_SESSION_SECRET_PREVIOUS', 'LW_LINK_SECRET_PREVIOUS', 'LW_RENDER_WORKER_SECRET']) {
    assert.throws(() => loadSecrets({ NODE_ENV: 'production', LW_SESSION_SECRET: 'owned-production-session', LW_LINK_SECRET: 'owned-production-link',
      [key]: 'eval-only-fixture' }), /must be replaced with a production secret/);
  }
  assert.equal(loadSecrets({ NODE_ENV: 'production', LW_SESSION_SECRET: 'eval-only-fixture', LW_LINK_SECRET: 'eval-only-fixture' },
    parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, policy: { defaultAccessMode: 'open' } }))).session, 'eval-only-fixture');
});

async function fixture(t: { after(fn: () => Promise<void>): void }, allowLegacyUnbounded = true) {
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, dev: { enabled: true }, rateLimit: { enabled: false, trustedProxyHops: 1 },
    policy: { serviceTokens: { allowLegacyUnbounded } } }));
  const app = buildApp({ store, config, secrets: { session: sessionSecret, link: linkSecret }, backgroundPollMs: 0 });
  const user = await store.upsertUserBySub({ sub: 'owner', email: 'owner@fixture.test', groups: ['owner'], role: 'owner' });
  const person: SessionUser = { sub: user.sub, email: user.email, name: 'Owner', groups: user.groups, role: user.role, epoch: user.sessionEpoch };
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  return { store, user, person, base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, cookie: cookieOnly(mintSessionCookie(person, sessionSecret, false)) };
}

test('HTTP logout rejects replay while another signed-in device remains active', async t => {
  const f = await fixture(t), other = cookieOnly(mintSessionCookie(f.person, sessionSecret, false));
  assert.equal((await fetch(`${f.base}/api/auth/logout`, { method: 'POST', headers: { cookie: f.cookie } })).status, 204);
  assert.equal((await fetch(`${f.base}/api/v1/users`, { headers: { cookie: f.cookie } })).status, 401);
  assert.equal((await fetch(`${f.base}/api/v1/users`, { headers: { cookie: other } })).status, 200);
});

test('password-protected link stays accessible to another trusted client after wrong guesses', async t => {
  const f = await fixture(t);
  const link = { id: 'owned-shared-link', kind: 'guest-edit' as const, target: { toolId: 'sample' }, exp: Math.floor(Date.now() / 1000) + 3600,
    createdBy: f.user.id, createdAt: new Date().toISOString(), pwHash: await hashPassword('owned-link-password') };
  await f.store.putLink(link);
  const url = `${f.base}/l/${link.id}?s=${signLink(link, linkSecret)}`;
  for (let i = 0; i < 10; i++) assert.equal((await fetch(`${url}&pw=incorrect`, { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 401);
  assert.equal((await fetch(`${url}&pw=owned-link-password`, { headers: { 'x-forwarded-for': '192.0.2.1' } })).status, 429);
  assert.equal((await fetch(`${url}&pw=owned-link-password`, { headers: { 'x-forwarded-for': '192.0.2.2' } })).status, 200);
});

test('service credentials receive bounded expiry and explicitly count legacy unbounded credentials', async t => {
  const f = await fixture(t);
  const created = await fetch(`${f.base}/api/v1/tokens`, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ label: 'automation', role: 'owner' }) });
  assert.equal(created.status, 201);
  const value = await created.json() as { expiresAt: string; legacyUnbounded: boolean };
  assert.equal(value.legacyUnbounded, false);
  assert.ok(Math.abs(Date.parse(value.expiresAt) - Date.now() - 90 * 86400000) < 5000);
  for (const ttlDays of [0, 366, '90', 1.5]) {
    assert.equal((await fetch(`${f.base}/api/v1/tokens`, { method: 'POST', headers: { cookie: f.cookie, 'content-type': 'application/json' },
      body: JSON.stringify({ label: 'automation', role: 'owner', ttlDays }) })).status, 400);
  }
  const token = 'lwt_owned-legacy-service';
  await f.store.putApiToken({ id: 'legacy', label: 'legacy', role: 'owner', tokenHash: hashServiceSecret(token), createdBy: `user:${f.user.id}`, createdAt: new Date().toISOString() });
  assert.equal((await fetch(`${f.base}/api/v1/tokens`, { headers: { authorization: `Bearer ${token}` } })).status, 200);
  const list = await (await fetch(`${f.base}/api/v1/tokens`, { headers: { cookie: f.cookie } })).json() as { legacyUnboundedCount: number };
  assert.equal(list.legacyUnboundedCount, 1);
  const strict = await fixture(t, false);
  await strict.store.putApiToken((await f.store.listApiTokens()).find(record => record.id === 'legacy')!);
  assert.equal((await fetch(`${strict.base}/api/v1/tokens`, { headers: { authorization: `Bearer ${token}` } })).status, 401);
  const expired = { id: 'expired', label: 'expired', role: 'owner', tokenHash: hashServiceSecret('lwt_owned-expired'), createdBy: `user:${f.user.id}`,
    createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() };
  await f.store.putApiToken(expired);
  assert.equal((await fetch(`${f.base}/api/v1/tokens`, { headers: { authorization: 'Bearer lwt_owned-expired' } })).status, 401);
  assert.equal(credentialExpiry(365, 0), new Date(365 * 86400000).toISOString());
});
