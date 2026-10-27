// SPDX-License-Identifier: MPL-2.0
/**
 * The two read-only surfaces a service token reaches beyond the action-gated
 * API: the catalogue and `/api/auth/session`. Pinned here:
 *
 *  - a live token reads the catalogue as a member with no groups: the same
 *    filtered bytes, the same signature, hidden tools still hidden;
 *  - reading is gated on `catalog.read`, so a deny grant on `user:svc_<id>`
 *    takes it away;
 *  - an unknown, revoked or expired token gets 401, never the anonymous view,
 *    even where anonymous reads are allowed;
 *  - `/api/auth/session` names the token (`kind: service`), and a cookie
 *    session or a guest answers exactly as before, token or not.
 *
 * Run directly:  node --test tests/service-token-reads.test.ts
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { webcrypto } from 'node:crypto';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import type { Store } from '../server/src/store/types.ts';

const servers: Server[] = [];
let pack: string;
const key = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as webcrypto.CryptoKeyPair;
const signingKey = JSON.stringify(await webcrypto.subtle.exportKey('jwk', key.privateKey));

interface Rig { base: string; store: Store; owner: string; plain: string; brand: string }

async function boot(mode: 'gated' | 'open'): Promise<Rig> {
  const store = createMemoryStore();
  await store.putOverlay({ toolId: 'secret', version: 1, visibility: { groups: ['brand'] } });
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Token Reads', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: mode, guestLinks: { enabled: true } },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'plain@test', groups: [] },
      { email: 'brand@test', groups: ['brand'] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'reads-session', link: 'reads-link', catalogSigningKey: signingKey } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  return { base, store, owner: await login('owner@test'), plain: await login('plain@test'), brand: await login('brand@test') };
}

async function mint(rig: Rig, label: string, role: string): Promise<{ id: string; token: string }> {
  const res = await fetch(`${rig.base}/api/v1/tokens`, {
    method: 'POST', headers: { cookie: rig.owner, 'content-type': 'application/json' }, body: JSON.stringify({ label, role }),
  });
  assert.equal(res.status, 201);
  return res.json() as Promise<{ id: string; token: string }>;
}

const get = (rig: Rig, path: string, headers: Record<string, string> = {}, method = 'GET') =>
  fetch(rig.base + path, { method, headers: { 'accept-encoding': 'identity', ...headers } });
const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const text = async (res: Response) => Buffer.from(await res.arrayBuffer()).toString();

let gated: Rig;
let open: Rig;

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-token-reads-'));
  const tools = [{ id: 'open', name: 'Open' }, { id: 'secret', name: 'Secret' }];
  for (const tool of tools) {
    await mkdir(join(pack, 'tools', tool.id), { recursive: true });
    await writeFile(join(pack, 'tools', tool.id, 'tool.json'), JSON.stringify({ id: tool.id }));
  }
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  for (const file of ['index.json', 'index.slim.json']) await writeFile(join(pack, 'catalog', 'tools', file), JSON.stringify({ tools }));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  gated = await boot('gated');
  open = await boot('open');
});

after(async () => {
  await Promise.all(servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))));
  await rm(pack, { recursive: true, force: true });
});

test('a member token reads the catalogue exactly as a member with no groups', async () => {
  const { token } = await mint(gated, 'deploy check', 'member');
  const asToken = await get(gated, '/catalog/tools/index.json', bearer(token));
  const asPlain = await get(gated, '/catalog/tools/index.json', { cookie: gated.plain });
  const asBrand = await get(gated, '/catalog/tools/index.json', { cookie: gated.brand });
  assert.equal(asToken.status, 200);
  const [tokenBody, plainBody, brandBody] = [await text(asToken), await text(asPlain), await text(asBrand)];
  assert.equal(tokenBody, plainBody, 'the same filtered bytes as a member with no groups');
  assert.notEqual(tokenBody, brandBody, 'a group member sees more');
  assert.doesNotMatch(tokenBody, /"secret"/, 'a tool hidden from a no-group member stays hidden');
  assert.equal(asToken.headers.get('cache-control'), asPlain.headers.get('cache-control'), 'the same private cache policy');

  const sig = await get(gated, '/catalog/tools/index.sig.json', bearer(token));
  assert.equal(sig.status, 200, 'the signature for those bytes');
  assert.equal(await text(sig), await text(await get(gated, '/catalog/tools/index.sig.json', { cookie: gated.plain })));
  assert.equal((await get(gated, '/catalog/tools/index.json', bearer(token), 'HEAD')).status, 200, 'HEAD too');
  assert.equal((await get(gated, '/tools/secret/tool.json', bearer(token))).status, 401, 'tool files stay member-only');
});

test('a deny grant on catalog.read takes the catalogue from that token alone', async () => {
  const denied = await mint(gated, 'denied reader', 'member');
  const other = await mint(gated, 'other reader', 'viewer');
  const grant = { principal: `user:svc_${denied.id}`, action: 'catalog.read', resource: '*', effect: 'deny' };
  const put = await fetch(`${gated.base}/api/v1/grants`, {
    method: 'POST', headers: { cookie: gated.owner, 'content-type': 'application/json' }, body: JSON.stringify(grant),
  });
  assert.equal(put.status, 201);
  assert.equal((await get(gated, '/catalog/tools/index.json', bearer(denied.token))).status, 403);
  assert.equal((await get(gated, '/catalog/tools/index.json', bearer(other.token))).status, 200, 'a viewer token holds catalog.read');
  assert.equal((await get(gated, '/catalog/tools/index.json', { cookie: gated.plain })).status, 200, 'members are not touched');
});

test('an unknown, revoked or expired token gets 401, even where anonymous reads are allowed', async () => {
  for (const rig of [gated, open]) {
    const { id, token } = await mint(rig, 'short-lived', 'member');
    assert.equal((await get(rig, '/catalog/tools/index.json', bearer(token))).status, 200);
    assert.equal((await fetch(`${rig.base}/api/v1/tokens/${id}`, { method: 'DELETE', headers: { cookie: rig.owner } })).status, 200);
    assert.equal((await get(rig, '/catalog/tools/index.json', bearer(token))).status, 401, 'revoked');

    const expired = 'lwt_expired-reads-token-0001';
    await rig.store.putApiToken({ id: 'tok_expired', label: 'expired', role: 'member', tokenHash: hashServiceSecret(expired),
      createdBy: 'user:owner', createdAt: new Date(Date.now() - 86400000).toISOString(), expiresAt: new Date(Date.now() - 1).toISOString() });
    assert.equal((await get(rig, '/catalog/tools/index.json', bearer(expired))).status, 401, 'expired');
    assert.equal((await get(rig, '/catalog/tools/index.json', bearer('lwt_never-minted-0000000'))).status, 401, 'unknown');
  }
  // Without a token, each mode answers as it always did.
  assert.equal((await get(gated, '/catalog/tools/index.json')).status, 401);
  assert.equal((await get(open, '/catalog/tools/index.json')).status, 200);
  assert.equal((await get(gated, '/catalog/tools/index.json', bearer('not-a-service-token'))).status, 401, 'another bearer is no credential here');
});

test('/api/auth/session names a live token and nothing else changes', async () => {
  const { id, token } = await mint(gated, 'lolly.ing deploy check', 'member');
  const res = await get(gated, '/api/auth/session', bearer(token));
  assert.equal(res.status, 200);
  assert.match(String(res.headers.get('cache-control')), /no-store/);
  assert.deepEqual(await res.json(), { kind: 'service', user: { sub: `token:${id}`, role: 'member', label: 'lolly.ing deploy check' } });

  // A cookie answers first: the member, exactly as before, with or without a token beside it.
  const plain = await (await get(gated, '/api/auth/session', { cookie: gated.plain })).json() as Record<string, unknown>;
  const both = await (await get(gated, '/api/auth/session', { cookie: gated.plain, ...bearer(token) })).json() as Record<string, unknown>;
  assert.equal(plain.kind, 'member');
  assert.deepEqual(both, plain);

  assert.equal((await get(gated, '/api/auth/session')).status, 401, 'no session, no token');
  assert.equal((await fetch(`${gated.base}/api/v1/tokens/${id}`, { method: 'DELETE', headers: { cookie: gated.owner } })).status, 200);
  assert.equal((await get(gated, '/api/auth/session', bearer(token))).status, 401, 'revoked');
});

test('a guest is unaffected', async () => {
  const link = await fetch(`${gated.base}/api/v1/links`, {
    method: 'POST', headers: { cookie: gated.owner, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'guest-edit', target: { toolId: 'open' }, ttlHours: 1 }),
  });
  assert.equal(link.status, 201, await link.clone().text());
  const url = new URL(((await link.json()) as { url: string }).url);
  const joined = await fetch(`${gated.base}${url.pathname}${url.search}&name=Robin`, { headers: { accept: 'application/json' }, redirect: 'manual' });
  assert.equal(joined.status, 200, await joined.clone().text());
  const guest = joined.headers.getSetCookie().find((c) => c.startsWith('lw_guest='))!.split(';')[0]!;
  const who = await (await get(gated, '/api/auth/session', { cookie: guest })).json() as { kind: string; guest: { name: string } };
  assert.deepEqual([who.kind, who.guest.name], ['guest', 'Robin']);
  const index = await get(gated, '/catalog/tools/index.json', { cookie: guest });
  assert.equal(index.status, 200, 'a guest still reads the catalogue its link opens');
  assert.doesNotMatch(await text(index), /"secret"/);
});
