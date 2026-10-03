// SPDX-License-Identifier: MPL-2.0
/**
 * OIDC callback failures (server/src/api/app.ts GET /api/auth/callback): when
 * the identity provider cannot be discovered, refuses the code, sends no
 * id_token, serves no keys, or sends a token or claims that do not verify, the
 * person gets the HTML sign-in failure page with a way back in, and the audit
 * log an `auth.failed` row naming the step. Before, each of these escaped as a
 * raw JSON 500. The issuer is a stub fetchImpl, as in tests/multi-idp.test.ts.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createSign, generateKeyPairSync } from 'node:crypto';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const JWK = { ...publicKey.export({ format: 'jwk' }), kid: 'k1', alg: 'RS256', use: 'sig' };
const b64u = (v: Buffer | string): string => Buffer.from(v).toString('base64url');
function signIdToken(payload: Record<string, unknown>): string {
  const head = b64u(JSON.stringify({ alg: 'RS256', kid: 'k1', typ: 'JWT' }));
  const body = b64u(JSON.stringify(payload));
  return `${head}.${body}.${b64u(createSign('sha256').update(`${head}.${body}`).sign(privateKey))}`;
}
const SECRETS = { session: 's'.repeat(40), link: 'l'.repeat(40) };

type Fault = 'issuer-mismatch' | 'token' | 'no-id-token' | 'jwks' | 'id-token' | 'claims' | 'none';

/** One issuer per case (discovery and keys are cached per issuer and URI). */
function issuerFetch(issuer: string, fault: Fault, nonceRef: { nonce: string }): typeof fetch {
  return (async (input: string | URL | Request) => {
    const url = String(input);
    if (url === `${issuer}/.well-known/openid-configuration`) {
      return Response.json({
        issuer: fault === 'issuer-mismatch' ? 'https://elsewhere.example' : issuer,
        authorization_endpoint: `${issuer}/authorize`, token_endpoint: `${issuer}/token`, jwks_uri: `${issuer}/jwks`,
      });
    }
    if (url === `${issuer}/jwks`) return fault === 'jwks' ? new Response('down', { status: 503 }) : Response.json({ keys: [JWK] });
    if (url === `${issuer}/token`) {
      if (fault === 'token') return Response.json({ error: 'invalid_grant' }, { status: 400 });
      if (fault === 'no-id-token') return Response.json({ access_token: 'at' });
      return Response.json({
        id_token: signIdToken({
          iss: issuer, aud: 'client', sub: 'u1', exp: Math.floor(Date.now() / 1000) + 300,
          nonce: fault === 'id-token' ? 'not-the-nonce' : nonceRef.nonce,
          ...(fault === 'claims' ? {} : { email: 'ana@example.test', email_verified: true }),
        }),
      });
    }
    if (url.startsWith('https://down.example')) return new Response('down', { status: 502 });
    throw new Error(`unexpected fetch in test: ${url}`);
  }) as typeof fetch;
}

async function boot(issuer: string, fetchImpl: typeof fetch): Promise<{ base: string; store: ReturnType<typeof createMemoryStore> }> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-oidc-err-'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Errors', baseUrl: 'http://hub.example', pack },
    rateLimit: { enabled: false },
    idp: { issuer, clientId: 'client', displayName: 'House' },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: SECRETS, fetchImpl });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

/** Start a sign-in on `base`; returns the callback query and the state cookie. */
async function start(base: string, nonceRef: { nonce: string }): Promise<{ state: string; cookie: string }> {
  const started = await fetch(`${base}/api/auth/login?returnTo=%2Fadmin`, { redirect: 'manual' });
  assert.equal(started.status, 302);
  const authorize = new URL(started.headers.get('location')!);
  nonceRef.nonce = authorize.searchParams.get('nonce')!;
  const cookie = started.headers.getSetCookie().find((c) => c.startsWith('lw_state='))!.split(';')[0]!;
  return { state: authorize.searchParams.get('state')!, cookie };
}

async function assertFailurePage(res: Response, status: number, text: RegExp): Promise<void> {
  assert.equal(res.status, status);
  assert.match(res.headers.get('content-type') ?? '', /text\/html/, 'an HTML page, not JSON');
  const page = await res.text();
  assert.match(page, text);
  assert.ok(page.includes('/api/auth/login?idp=primary&amp;returnTo=%2Fadmin'), 'a way back into the sign-in');
  assert.ok(res.headers.getSetCookie().some((c) => c.startsWith('lw_state=;')), 'the state cookie is cleared');
}

for (const fault of ['issuer-mismatch', 'token', 'no-id-token', 'jwks', 'id-token'] as const) {
  test(`a callback that fails at ${fault} shows the failure page and audits auth.failed`, async () => {
    const issuer = `https://idp-${fault}.example`;
    const nonceRef = { nonce: '' };
    const { base, store } = await boot(issuer, issuerFetch(issuer, fault, nonceRef));
    const { state, cookie } = await start(base, nonceRef);
    const done = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { headers: { cookie }, redirect: 'manual' });
    await assertFailurePage(done, 502, /did not finish the sign-in/);
    const failed = (await store.listAudit()).filter((e) => e.action === 'auth.failed');
    assert.deepEqual(failed.map((e) => e.payload), [{ provider: 'oidc', idp: 'primary', reason: fault }]);
    assert.equal((await store.listUsers()).length, 0, 'nobody was signed in');
  });
}

test('an id_token without an email is refused with the page, 403', async () => {
  const issuer = 'https://idp-claims.example';
  const nonceRef = { nonce: '' };
  const { base, store } = await boot(issuer, issuerFetch(issuer, 'claims', nonceRef));
  const { state, cookie } = await start(base, nonceRef);
  const done = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { headers: { cookie }, redirect: 'manual' });
  await assertFailurePage(done, 403, /did not share an email address/);
  assert.ok((await store.listAudit()).some((e) => e.action === 'auth.failed' && (e.payload as { reason?: string }).reason === 'claims'));
});

test('a callback served by an instance that cannot reach discovery shows the page (discovery)', async () => {
  // Sign-in started on one instance, finished on another whose discovery
  // cache is cold and whose IdP is unreachable: a function fleet does this.
  const nonceRef = { nonce: '' };
  const first = await boot('https://idp-up.example', issuerFetch('https://idp-up.example', 'none', nonceRef));
  const { state, cookie } = await start(first.base, nonceRef);
  const second = await boot('https://down.example', issuerFetch('https://idp-up.example', 'none', nonceRef));
  const done = await fetch(`${second.base}/api/auth/callback?code=c&state=${state}`, { headers: { cookie }, redirect: 'manual' });
  await assertFailurePage(done, 502, /did not finish the sign-in/);
  assert.ok((await second.store.listAudit()).some((e) => e.action === 'auth.failed' && (e.payload as { reason?: string }).reason === 'discovery'));
});

test('the same stub signs a person in when nothing fails', async () => {
  const issuer = 'https://idp-none.example';
  const nonceRef = { nonce: '' };
  const { base } = await boot(issuer, issuerFetch(issuer, 'none', nonceRef));
  const { state, cookie } = await start(base, nonceRef);
  const done = await fetch(`${base}/api/auth/callback?code=c&state=${state}`, { headers: { cookie }, redirect: 'manual' });
  assert.equal(done.status, 302);
  assert.equal(done.headers.get('location'), '/admin');
});
