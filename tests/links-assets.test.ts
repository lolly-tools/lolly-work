/**
 * Signed links onto catalog assets (plans/31 §2 1b) over real HTTP: a
 * share/embed/download link may target an instance asset, a federated asset or
 * a pack asset instead of a tool render.
 *
 * The two halves this suite pins down are the whole design: exposure is settled
 * at MINT (a member cannot mint a link to bytes they cannot see) and lifecycle
 * is re-resolved at RESOLVE (an expired, not-yet-published or revoked asset
 * stops serving on a link that is still perfectly live). TTL, passwords,
 * revocation, audit and telemetry are inherited from the link machinery, so
 * they are checked here on an asset target rather than re-implemented.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const HERO_BYTES = 'campaign-hero-bytes';
const PACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Acme</title></svg>';

const MOCK_ASSETS = [
  {
    remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: [], approved: true,
    formats: [{ format: 'png', remoteRef: 'att1', size: 18 }],
  },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-link-assets-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo.svg'), PACK_SVG);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: 'acme/logo', name: 'Acme Logo', type: 'icon', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg' }] }],
  }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Link Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'designer@test', groups: ['design'] },
      { email: 'seller@test', groups: ['sales'] },
    ] },
  }));

  store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const stat = await blobs.put('inst/hero/png', Buffer.from(HERO_BYTES), 'image/png');
  await store.putInstanceAsset({
    id: 'inst/hero',
    entry: instanceAssetEntry('inst/hero', { name: 'Campaign Hero', type: 'image' }, [
      { format: 'png', size: stat.size, checksum: stat.checksum },
    ]),
    blobs: { png: 'inst/hero/png' },
    groups: ['design'],
    createdAt: new Date().toISOString(),
  });

  const app = buildApp({ config, store, blobs, secrets: { session: 'sL', link: 'lL', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dam9', kind: 'mock', label: 'Link DAM', options: { assets: MOCK_ASSETS }, exposure: { groups: ['design'] } }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam9/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

interface Minted { id: string; url: string }

async function mint(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/links`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function mintOk(cookie: string, body: Record<string, unknown>): Promise<{ id: string; path: string }> {
  const res = await mint(cookie, body);
  if (res.status !== 201) assert.fail(`mint failed (${res.status}): ${await res.text()}`);
  const { id, url } = await res.json() as Minted;
  return { id, path: url.replace('http://localhost', base) };
}

async function setLifecycle(assetId: string, body: Record<string, unknown>, expect = 200): Promise<void> {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/lifecycle/${assetId}`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, expect, await res.text());
}

test('mint checks exposure: a member who cannot see the asset cannot mint a link to it', async () => {
  const seller = await login('seller@test');
  const refusedInst = await mint(seller, { kind: 'share', target: { assetId: 'inst/hero' } });
  assert.equal(refusedInst.status, 403, 'instance-asset group exposure holds at mint');
  const refusedExt = await mint(seller, { kind: 'download', target: { assetId: 'ext/dam9/a1' } });
  assert.equal(refusedExt.status, 403, 'provider group exposure holds at mint');
  assert.equal((await mint(seller, { kind: 'share', target: { assetId: 'inst/nope' } })).status, 403, 'an unknown asset is not visible either');
  assert.equal((await mint(seller, { kind: 'share', target: { assetId: '../../etc/passwd' } })).status, 400);

  const designer = await login('designer@test');
  assert.equal((await mint(designer, { kind: 'share', target: { assetId: 'inst/hero' } })).status, 201);
});

test('a target must name something; guest-edit never targets an asset', async () => {
  const designer = await login('designer@test');
  assert.equal((await mint(designer, { kind: 'share', target: {} })).status, 400);
  const guest = await mint(await login('admin@test'), { kind: 'guest-edit', target: { assetId: 'inst/hero' } });
  assert.equal(guest.status, 400, 'an asset has no tool to open, so it cannot admit a guest seat');
});

test('share and embed serve the asset inline to a bearer with no session; download attaches', async () => {
  const designer = await login('designer@test');
  // The instance is sign-in gated, so this is the whole point of the link: the
  // signature is the authorization, no cookie involved.
  assert.equal((await fetch(`${base}/catalog/inst/hero/png`)).status, 401);

  for (const kind of ['share', 'embed'] as const) {
    const { path } = await mintOk(designer, { kind, target: { assetId: 'inst/hero' } });
    const res = await fetch(path);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), HERO_BYTES);
    assert.equal(res.headers.get('content-type'), 'image/png');
    assert.equal(res.headers.get('cache-control'), 'private, max-age=300', 'nothing an asset link serves is CDN-cacheable');
    assert.equal(res.headers.get('content-disposition'), null, `${kind} serves inline`);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    // Inline plus unauthenticated is exactly the combination a member-submitted
    // SVG would exploit, so linked bytes are sandboxed and get no script.
    assert.match(res.headers.get('content-security-policy') ?? '', /default-src 'none'.*sandbox/);
  }

  const { path } = await mintOk(designer, { kind: 'download', target: { assetId: 'inst/hero', format: 'png' } });
  const dl = await fetch(path);
  assert.equal(dl.status, 200);
  assert.equal(await dl.text(), HERO_BYTES);
  assert.equal(dl.headers.get('content-disposition'), 'attachment; filename="Campaign_Hero.png"');
  const etag = dl.headers.get('etag');
  assert.ok(etag, 'the blob checksum still travels as an ETag');
  assert.equal((await fetch(path, { headers: { 'if-none-match': etag as string } })).status, 304);

  const missing = await mintOk(designer, { kind: 'share', target: { assetId: 'inst/hero', format: 'tiff' } });
  assert.equal((await fetch(missing.path)).status, 404, 'a format the asset does not have is a 404, not other bytes');
});

test('TTL, passwords and revocation work unchanged on an asset target', async () => {
  const designer = await login('designer@test');

  const expired = await mintOk(designer, { kind: 'share', target: { assetId: 'inst/hero' }, ttlHours: 0 });
  assert.equal((await fetch(expired.path)).status, 410, 'LINK_EXPIRED - the signature carries its own expiry');

  const guarded = await mintOk(designer, { kind: 'download', target: { assetId: 'inst/hero' }, password: 'hunter2' });
  assert.equal((await fetch(guarded.path)).status, 401, 'PASSWORD_REQUIRED');
  const opened = await fetch(`${guarded.path}&pw=hunter2`);
  assert.equal(opened.status, 200);
  assert.equal(await opened.text(), HERO_BYTES);

  const revoked = await mintOk(designer, { kind: 'share', target: { assetId: 'inst/hero' } });
  assert.equal((await fetch(revoked.path)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/links/${revoked.id}/revoke`, { method: 'POST', headers: { cookie: designer } })).status, 200);
  assert.equal((await fetch(revoked.path)).status, 410, 'LINK_REVOKED');
});

test('a federated asset target serves through the provider; a pack asset target serves the pack file', async () => {
  const designer = await login('designer@test');

  const ext = await mintOk(designer, { kind: 'download', target: { assetId: 'ext/dam9/a1' } });
  const extRes = await fetch(ext.path);
  assert.equal(extRes.status, 200);
  assert.equal(await extRes.text(), 'mock:dam9:a1:att1');
  assert.equal(extRes.headers.get('content-disposition'), 'attachment; filename="Summit_Logo.png"');

  const seller = await login('seller@test');
  const packLink = await mintOk(seller, { kind: 'download', target: { assetId: 'acme/logo' } });
  const packRes = await fetch(packLink.path);
  assert.equal(packRes.status, 200);
  assert.equal(await packRes.text(), PACK_SVG);
  assert.equal(packRes.headers.get('content-type'), 'image/svg+xml');
  assert.equal(packRes.headers.get('content-disposition'), 'attachment; filename="logo.svg"');

  const share = await mintOk(seller, { kind: 'share', target: { assetId: 'acme/logo' } });
  assert.equal((await fetch(share.path)).headers.get('content-disposition'), null);
});

test('the console Links view lists an asset link with its target, unchanged', async () => {
  const designer = await login('designer@test');
  const { id } = await mintOk(designer, { kind: 'embed', target: { assetId: 'inst/hero' } });
  const listed = await (await fetch(`${base}/api/v1/links`, { headers: { cookie: designer } })).json() as {
    links: Array<{ id: string; kind: string; target: { assetId?: string }; url: string; status: string }>;
  };
  const row = listed.links.find((l) => l.id === id);
  assert.ok(row, 'the asset link is listed by the same route the console already calls');
  assert.equal(row?.target.assetId, 'inst/hero');
  assert.equal(row?.status, 'live');
  assert.match(row?.url ?? '', new RegExp(`^http://localhost/l/${id}\\?s=`));
});

test('audit and telemetry ride the existing machinery', async () => {
  const designer = await login('designer@test');
  const { id } = await mintOk(designer, { kind: 'share', target: { assetId: 'inst/hero' } });
  const entry = (await store.listAudit()).find((e) => e.action === 'link.create' && e.subject === `link:${id}`);
  assert.ok(entry, 'minting an asset link audits as link.create, exactly like a render target');
  assert.equal((entry?.payload as { assetId?: string } | undefined)?.assetId, 'inst/hero');
  assert.equal((entry?.payload as { toolId?: string | null } | undefined)?.toolId, null);

  // `link.visit` is a closed-vocabulary client event carrying linkKind only;
  // an asset link is the same event, so nothing new is ingested or disclosed.
  const posted = await fetch(`${base}/api/v1/telemetry`, {
    method: 'POST', headers: { cookie: designer, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ event: 'link.visit', attrs: { linkKind: 'share', assetId: 'inst/hero' } }] }),
  });
  assert.equal(posted.status, 202);
  const visit = (await store.listEvents()).find((e) => e.event === 'link.visit');
  assert.ok(visit);
  assert.equal((visit?.attrs as { linkKind?: string }).linkKind, 'share');
  assert.equal((visit?.attrs as { assetId?: string }).assetId, undefined, 'the vocabulary stays closed');
});

test('lifecycle is re-checked at resolve: expiry, scheduling and revocation kill a live link', async () => {
  const designer = await login('designer@test');
  const { path } = await mintOk(designer, { kind: 'share', target: { assetId: 'inst/hero' } });
  assert.equal((await fetch(path)).status, 200);

  await setLifecycle('inst/hero', { validUntil: '2020-01-01T00:00:00.000Z' });
  const expired = await fetch(path);
  assert.equal(expired.status, 410, 'an expired asset refuses to serve on a still-live link');
  assert.equal((await expired.json() as { error: { code: string } }).error.code, 'ASSET_EXPIRED');

  await setLifecycle('inst/hero', { validUntil: '2099-01-01T00:00:00.000Z' });
  assert.equal((await fetch(path)).status, 200, 'the same link works again once the window reopens');

  await setLifecycle('inst/hero', { validFrom: '2099-01-01T00:00:00.000Z' });
  assert.equal((await fetch(path)).status, 410, 'an asset scheduled into the future is withheld from a bearer too');
  await setLifecycle('inst/hero', { validFrom: '2000-01-01T00:00:00.000Z' });
  assert.equal((await fetch(path)).status, 200);

  // A hold only ever PRESERVES availability (plans/27 §3), so it is deliberately
  // not a refusal - a held asset keeps serving, and refuses to be revoked.
  await setLifecycle('inst/hero', { hold: { note: 'legal review' } });
  assert.equal((await fetch(path)).status, 200, 'a hold never takes bytes away');
  await setLifecycle('inst/hero', { revoke: true }, 409);
  assert.equal((await fetch(path)).status, 200);

  await setLifecycle('inst/hero', { hold: null });
  await setLifecycle('inst/hero', { revoke: true });
  assert.equal((await fetch(path)).status, 410, 'revocation of the ASSET kills the link, without touching the link');
});

test('lifecycle on a federated asset gates its link the same way', async () => {
  const designer = await login('designer@test');
  const { path } = await mintOk(designer, { kind: 'embed', target: { assetId: 'ext/dam9/a1' } });
  assert.equal((await fetch(path)).status, 200);
  await setLifecycle('ext/dam9/a1', { validUntil: '2020-01-01T00:00:00.000Z' });
  assert.equal((await fetch(path)).status, 410);
  await setLifecycle('ext/dam9/a1', { revoke: true });
  assert.equal((await fetch(path)).status, 410);
});

test('a link minted before the exit survives the cutover through the alias', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({
      id: 'dam8', kind: 'mock', label: 'Exit DAM', exposure: { groups: ['design'] },
      options: { assets: [{ remoteId: 'b1', name: 'Brand Mark', nativeType: 'file', sections: [], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'r1' }] }] },
    }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam8/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);

  const designer = await login('designer@test');
  const { path } = await mintOk(designer, { kind: 'download', target: { assetId: 'ext/dam8/b1' } });
  assert.equal(await (await fetch(path)).text(), 'mock:dam8:b1:r1');

  // Pin: bytes go local, identity stays ext/* - the link serves the local copy.
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam8/materialize`, { method: 'POST', headers: { cookie: admin } })).status, 200);
  assert.equal(await (await fetch(path)).text(), 'mock:dam8:b1:r1');

  // Cutover: identity moves to inst/* and the provider is disabled. The link
  // was minted against the federated id and keeps resolving through the alias.
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam8/cutover`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  const after = await fetch(path);
  assert.equal(after.status, 200, 'the old federated target survives the exit');
  assert.equal(await after.text(), 'mock:dam8:b1:r1');
  assert.equal(after.headers.get('content-disposition'), 'attachment; filename="Brand_Mark.png"');
});

test('lifecycle on a pack asset gates its link the same way', async () => {
  const seller = await login('seller@test');
  const { path } = await mintOk(seller, { kind: 'share', target: { assetId: 'acme/logo' } });
  assert.equal((await fetch(path)).status, 200);
  await setLifecycle('acme/logo', { revoke: true });
  assert.equal((await fetch(path)).status, 410);
});
