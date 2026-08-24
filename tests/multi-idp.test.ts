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
