// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { SignJWT, generateKeyPair, exportJWK } from 'jose';
import { discover, exchangeCode, fetchJwks, verifyIdToken, buildAuthorizeUrl } from '../server/src/iam/oidc.ts';
import { verifyLogoutToken } from '../server/src/iam/oidc-logout.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { resolveMember } from '../server/src/iam/member.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { parseConfig } from '../server/src/config/instance.ts';

const now = Date.now(), seconds = Math.floor(now / 1000);
const expect = { issuer: 'https://id.example', clientId: 'work', nonce: 'nonce' };
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const jwk = { ...keys.publicKey.export({ format: 'jwk' }), kid: 'one', use: 'sig' };
const jwks = { keys: [jwk] };
const claims = { iss: expect.issuer, sub: 'person', aud: 'work', iat: seconds, exp: seconds + 300, nonce: 'nonce' };
function sign(p: Record<string, unknown>, header = { alg: 'RS256', kid: 'one' }): string {
  const data = [header, p].map(v => Buffer.from(JSON.stringify(v)).toString('base64url')).join('.');
  return `${data}.${createSign('sha256').update(data).sign(keys.privateKey).toString('base64url')}`;
}

test('ID tokens require typed claims and the configured client, issuer, nonce and algorithm', async () => {
  assert.equal((await verifyIdToken(sign(claims), jwks, expect, now)).sub, 'person');
  for (const field of ['iss', 'sub', 'aud', 'exp', 'iat']) {
    const p: Record<string, unknown> = { ...claims }; delete p[field];
    await assert.rejects(verifyIdToken(sign(p), jwks, expect, now), `missing ${field}`);
  }
  for (const patch of [ { sub: '' }, { sub: 12 }, { iss: 'https://other.example' }, { aud: 'other' },
    { aud: ['work', 'other'] }, { aud: ['work', 42] }, { azp: 'other' }, { nonce: 'other' },
    { exp: seconds }, { exp: 'future' }, { iat: 'today' }, { iat: seconds + 301 }, { nbf: seconds + 60 } ]) {
    await assert.rejects(verifyIdToken(sign({ ...claims, ...patch }), jwks, expect, now), JSON.stringify(patch));
  }
  await assert.rejects(verifyIdToken(sign(claims, { alg: 'HS256', kid: 'one' }), jwks, expect, now));
  await assert.rejects(verifyIdToken(sign(claims, { alg: 'RS256', kid: 'unknown' }), jwks, expect, now));
  assert.ok(await verifyIdToken(sign({ ...claims, aud: ['work', 'api'], azp: 'work' }), jwks, { ...expect, trustedAudiences: ['api'] }, now));
});

test('assurance validates returned acr, every required amr, and auth_time', async () => {
  const policy = { ...expect, assurance: { acrValues: ['strong'], amrValues: ['pwd', 'otp'], maxAgeSeconds: 300 } };
  const good = { ...claims, acr: 'strong', amr: ['pwd', 'otp'], auth_time: seconds - 60 };
  assert.ok(await verifyIdToken(sign(good), jwks, policy, now));
  for (const patch of [{ acr: 'weak' }, { amr: ['pwd'] }, { amr: 'otp' }, { auth_time: undefined }, { auth_time: seconds - 400 }, { auth_time: seconds + 400 }]) {
    await assert.rejects(verifyIdToken(sign({ ...good, ...patch }), jwks, policy, now));
  }
  const url = new URL(buildAuthorizeUrl({ authorizationEndpoint: 'https://id.example/auth', clientId: 'work', redirectUri: 'https://work.example/cb',
    state: 's', nonce: 'n', codeChallenge: 'c', assurance: policy.assurance }));
  assert.equal(url.searchParams.get('acr_values'), 'strong'); assert.equal(url.searchParams.get('max_age'), '300');
});

test('explicit asymmetric algorithm choices cannot widen the default', async () => {
  for (const alg of ['ES256', 'PS256'] as const) {
    const pair = await generateKeyPair(alg); const key = await exportJWK(pair.publicKey);
    const token = await new SignJWT(claims).setProtectedHeader({ alg, kid: alg }).sign(pair.privateKey);
    const set = { keys: [{ ...key, kid: alg }] };
    await assert.rejects(verifyIdToken(token, set, expect, now));
    assert.ok(await verifyIdToken(token, set, { ...expect, signingAlgorithm: alg }, now));
  }
});

test('discovery rejects mismatched issuers and insecure or malformed endpoints before use', async () => {
  const doc = { issuer: expect.issuer, authorization_endpoint: `${expect.issuer}/auth`, token_endpoint: `${expect.issuer}/token`, jwks_uri: `${expect.issuer}/jwks` };
  for (const patch of [{ issuer: `${expect.issuer}/` }, { issuer: 'https://other.example' }, { token_endpoint: 'http://other.example/token' },
    { end_session_endpoint: 'http://localhost/logout' }, { jwks_uri: 'https://user:secret@id.example/jwks' }, { authorization_endpoint: undefined }]) {
    await assert.rejects(discover(expect.issuer, async () => Response.json({ ...doc, ...patch })));
  }
  let requests = 0;
  const transport: typeof fetch = async (_url, init) => { requests++; assert.equal(init?.redirect, 'error'); assert.ok(init?.signal); return Response.json(doc); };
  await discover(expect.issuer, transport); await discover(expect.issuer, transport); assert.equal(requests, 1);
  await assert.rejects(discover('http://remote.example', transport));
});

test('JWKS cache refreshes immediately for a new kid and does not accept the old key', async () => {
  let requests = 0;
  const transport: typeof fetch = async () => Response.json({ keys: [{ ...jwk, kid: ++requests === 1 ? 'one' : 'two' }] });
  await fetchJwks('https://id.example/jwks', transport, 'one');
  await fetchJwks('https://id.example/jwks', transport, 'one');
  assert.equal(requests, 1);
  const refreshed = await fetchJwks('https://id.example/jwks', transport, 'two');
  assert.equal(requests, 2); assert.equal(refreshed.keys[0]?.kid, 'two');
});

test('token authentication supports explicit basic/post/none without leaking secrets on redirects', async () => {
  for (const method of ['client_secret_basic', 'client_secret_post', 'none'] as const) {
    await exchangeCode({ tokenEndpoint: 'https://id.example/token', clientId: 'work:+', clientSecret: 'secret:+', code: 'code', verifier: 'v',
      redirectUri: 'https://work.example/cb', authMethod: method, fetchImpl: async (_url, init) => {
        assert.equal(init?.redirect, 'error');
        const body = new URLSearchParams(String(init?.body)), headers = new Headers(init?.headers);
        assert.equal(body.get('code_verifier'), 'v');
        if (method === 'client_secret_basic') {
          assert.equal(headers.get('authorization'), `Basic ${Buffer.from('work%3A%2B:secret%3A%2B').toString('base64')}`);
          assert.equal(body.has('client_secret'), false);
        } else { assert.equal(headers.has('authorization'), false); assert.equal(body.has('client_secret'), method === 'client_secret_post'); }
        return Response.json({ id_token: 'token' });
      } });
  }
  await assert.rejects(exchangeCode({ tokenEndpoint: 'https://id.example/token', clientId: 'work', code: 'c', verifier: 'v', redirectUri: 'https://work.example/cb', authMethod: 'client_secret_basic' }));
});

test('bad assurance and client authentication configuration fails closed', () => {
  for (const idp of [{ signingAlgorithm: 'none' }, { tokenEndpointAuthMethod: 'surprise' }, { assurance: { amrValues: [] } },
    { assurance: { maxAgeSeconds: -1 } }, { assurance: { typo: true } }]) assert.throws(() => parseConfig(JSON.stringify({ idp })));
});

const logoutClaims = { iss: expect.issuer, aud: 'work', iat: seconds, jti: 'logout-1', sid: 'browser-one',
  events: { 'http://schemas.openid.net/event/backchannel-logout': {} } };
test('logout tokens require the logout event, fresh time, session id and no nonce', async () => {
  assert.ok(await verifyLogoutToken(sign(logoutClaims), jwks, expect, now));
  for (const patch of [{ events: {} }, { nonce: 'nonce' }, { iat: seconds - 301 }, { iat: seconds + 61 }, { sid: undefined, sub: 'person' },
    { jti: '' }, { aud: ['work', 'untrusted'] }, { iss: 'https://elsewhere.example' }]) await assert.rejects(verifyLogoutToken(sign({ ...logoutClaims, ...patch }), jwks, expect, now));
  await assert.rejects(verifyLogoutToken(sign(claims), jwks, expect, now));
});

test('logout revokes only the named IdP session and its renewed/device descendants; replay cannot revoke a new login', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'person', email: 'person@example.test', groups: [], role: 'member' });
  const binding = { idp: 'primary', issuer: expect.issuer, clientId: 'work', subject: 'person', sid: 'browser-one', iat: seconds - 10 };
  const cookie = (patch = {}) => mintSessionCookie({ sub: user.sub, email: user.email, name: 'Person', groups: [], role: 'member', oidc: { ...binding, ...patch } }, 'secret', false).split(';')[0];
  assert.ok(await resolveMember(store, cookie(), 'secret'));
  const event = await verifyLogoutToken(sign(logoutClaims), jwks, expect, now);
  assert.equal(await store.recordOidcLogout(event), true);
  assert.equal(await resolveMember(store, cookie(), 'secret'), null);
  assert.ok(await resolveMember(store, cookie({ sid: 'browser-two' }), 'secret'));
  assert.ok(await resolveMember(store, cookie({ issuer: 'https://other.example' }), 'secret'));
  assert.equal(await resolveMember(store, cookie({ iat: seconds + 1 }), 'secret'), null, 'a newer issue time cannot revive the same sid');
  assert.equal(await store.recordOidcLogout(event), false);
  assert.equal(await resolveMember(store, cookie({ iat: seconds + 1 }), 'secret'), null, 'a newer issue time cannot revive the same sid');
  const expired = mintSessionCookie({ sub: user.sub, email: user.email, name: '', groups: [], role: 'member', standingUntil: Date.now() - 1 }, 'secret', false);
  assert.equal(await resolveMember(store, expired, 'secret'), null);
});
