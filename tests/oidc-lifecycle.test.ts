// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { mintSessionCookie, readMemberSession } from '../server/src/iam/sessions.ts';
import { resolveMember } from '../server/src/iam/member.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { logoutKey } from '../server/src/iam/oidc-logout.ts';

const key = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...key.publicKey.export({ format: 'jwk' }), kid: 'one', use: 'sig' };
const issuer = 'https://lifecycle-id.example';
const secret = 's'.repeat(40);
function signed(p: Record<string, unknown>): string {
  const data = [{ alg: 'RS256', kid: 'one' }, p].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${data}.${createSign('sha256').update(data).sign(key.privateKey).toString('base64url')}`;
}

test('HTTP OIDC login, explicit provider logout and back-channel logout preserve session boundaries', async t => {
  const pack = await mkdtemp(join(tmpdir(), 'oidc-lifecycle-'));
  const store = createMemoryStore();
  let nonce = '', sid = 'session-one', acr = 'weak';
  const iat = Math.floor(Date.now() / 1000);
  const app = buildApp({ config: parseConfig(JSON.stringify({ instance: { baseUrl: 'http://localhost:8787', pack }, rateLimit: { enabled: false },
    idp: { issuer, clientId: 'work', displayName: 'Example ID', assurance: { acrValues: ['strong'], amrValues: ['mfa'], maxAgeSeconds: 300 } } })), store, blobs: createMemoryBlobStore(), secrets: { session: secret, link: secret },
    fetchImpl: async input => {
      const url = String(input);
      if (url.endsWith('openid-configuration')) return Response.json({ issuer, authorization_endpoint: `${issuer}/auth`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`, end_session_endpoint: `${issuer}/logout` });
      if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
      if (url.endsWith('/token')) return Response.json({ id_token: signed({ iss: issuer, aud: 'work', sub: 'person', email: 'person@example.test', email_verified: true, iat, exp: iat + 600, nonce, sid, acr, amr: ['mfa'], auth_time: iat }) });
      throw new Error('unexpected IdP request');
    } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true }); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const base = `http://127.0.0.1:${address.port}`;
  const get = (path: string, cookie: string) => fetch(base + path, { headers: { cookie }, redirect: 'manual' });
  async function login(expectedStatus = 302): Promise<string> {
    const start = await fetch(base + '/api/auth/login', { redirect: 'manual' });
    assert.equal(start.status, 302);
    const auth = new URL(start.headers.get('location')!);
    assert.equal(auth.searchParams.get('acr_values'), 'strong');
    assert.equal(auth.searchParams.get('max_age'), '300'); nonce = auth.searchParams.get('nonce')!;
    const stateCookie = start.headers.getSetCookie().find(v => v.startsWith('lw_state='))!.split(';')[0]!;
    const done = await get(`/api/auth/callback?code=c&state=${auth.searchParams.get('state')}`, stateCookie);
    assert.equal(done.status, expectedStatus);
    if (expectedStatus !== 302) { assert.equal(done.headers.getSetCookie().some(v => v.startsWith('lw_session=')), false); return ''; }
    return done.headers.getSetCookie().find(v => v.startsWith('lw_session='))!.split(';')[0]!;
  }
  await login(502);
  acr = 'strong';
  const one = await login();
  sid = 'session-two'; const two = await login();
  assert.equal(readMemberSession(one, secret)?.user.oidc?.sid, 'session-one');
  const ordinary = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { cookie: one } });
  assert.equal(ordinary.status, 204); assert.equal(ordinary.headers.get('location'), null);
  const status = await get('/api/auth/session', one); assert.equal((await status.json() as { providerLogoutPath?: string }).providerLogoutPath, '/api/auth/logout-provider');
  const confirmation = await get('/api/auth/logout-provider', one);
  assert.equal(confirmation.status, 200);
  const html = await confirmation.text(); assert.match(html, /may affect other apps/);
  const token = /name="nonce" value="([^"]+)"/.exec(html)![1]!;
  const formCookie = confirmation.headers.getSetCookie()[0]!.split(';')[0]!;
  const post = (cookie: string, value: string) => fetch(base + '/api/auth/logout-provider', { method: 'POST', redirect: 'manual',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ nonce: value }) });
  assert.equal((await post(one, token)).status, 403);
  assert.equal((await post(`${two}; ${formCookie}`, token)).status, 403, 'confirmation is tied to the initiating session');
  const out = await post(`${one}; ${formCookie}`, token);
  assert.equal(out.status, 303);
  const destination = new URL(out.headers.get('location')!);
  assert.equal(destination.origin, issuer); assert.equal(destination.searchParams.get('client_id'), 'work');
  assert.equal(destination.searchParams.get('post_logout_redirect_uri'), 'http://localhost:8787/');
  assert.ok(out.headers.getSetCookie().some(v => v.startsWith('lw_session=;')));
  const logout = signed({ iss: issuer, aud: 'work', iat, jti: 'event-one', sid: 'session-one', events: { 'http://schemas.openid.net/event/backchannel-logout': {} } });
  const notify = (token: string) => fetch(base + '/api/auth/backchannel-logout/primary', { method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ logout_token: token }) });
  assert.equal((await notify('invalid')).status, 400);
  assert.equal((await get('/api/auth/session', one)).status, 200);
  assert.equal((await notify(logout)).status, 200);
  assert.equal((await get('/api/auth/session', one)).status, 401);
  assert.equal((await get('/api/auth/session', two)).status, 200);
  const inherited = readMemberSession(one, secret)!.user;
  const descendant = mintSessionCookie({ ...inherited, authAt: Date.now() }, secret, false).split(';')[0]!;
  assert.equal(await resolveMember(store, descendant, secret), null, 'renewal cannot discard the IdP session');
  assert.equal((await notify(logout)).status, 200);
  sid = 'session-one'; await login(403);
  assert.equal((await store.listAudit()).filter(e => e.action === 'auth.backchannel-logout').length, 1);
});

test('Postgres logout replay and revocation are atomic across concurrent calls', { skip: !process.env.LW_TEST_DATABASE_URL && 'requires disposable Postgres' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    const iat = Math.floor(Date.now() / 1000);
    const binding = { idp: 'primary', issuer, clientId: 'work', subject: 'person', sid: 'one', iat: iat - 1 };
    const event = { replayKey: logoutKey(issuer, 'work', 'jti', 'event'), targetKey: logoutKey(issuer, 'work', 'sid', 'one'), iat };
    const results = await Promise.all([store.recordOidcLogout(event), store.recordOidcLogout(event)]);
    assert.equal(results.filter(Boolean).length, 1);
    assert.equal(await store.oidcSessionRevoked(binding), true);
    assert.equal(await store.oidcSessionRevoked({ ...binding, sid: 'two' }), false);
    assert.equal(await store.oidcSessionRevoked({ ...binding, iat: iat + 1 }), true);
  });
});
