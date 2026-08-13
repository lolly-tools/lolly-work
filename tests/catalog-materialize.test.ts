/**
 * The exit over real HTTP (plans/27 §5): materialize a federated asset into the
 * instance's own BlobStore, serve it from /catalog/inst/*, suppress the doubled
 * ext entry while the provider is still enabled, then cut over — identity moves
 * to inst/*, old ext URLs keep resolving through aliases, and the provider is
 * disabled. RBAC: materialize is admin, cutover is owner.
 *
 * Config-managed mock provider (born enabled), memory BlobStore (buildApp's
 * default) — no network, no S3.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let instId = '';

const MOCK_ASSETS = [
  { remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: ['event'], approved: true, updatedAt: '2026-06-01T00:00:00.000Z', formats: [{ format: 'png', remoteRef: 'att1', size: 17 }] },
  { remoteId: 'a2', name: 'Draft', nativeType: 'file', sections: ['Docs'], tags: [], approved: false, formats: [{ format: 'pdf', remoteRef: 'att2' }] },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-materialize-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Exit Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'designer@test', groups: ['design'] },
      { email: 'seller@test', groups: ['sales'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's4', link: 'l4', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  // A db-managed mock provider (so cutover can disable it — the full exit path).
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dam4', kind: 'mock', label: 'Exit DAM', options: { assets: MOCK_ASSETS }, exposure: { groups: ['design'], requireApproved: true } }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam4/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const feedIds = async (cookie: string): Promise<string[]> =>
  ((await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json()) as { assets: Array<{ id: string }> }).assets.map((a) => a.id);

test('(a) materialize is admin-gated and mints an instance asset per exposed federated asset', async () => {
  const designer = await login('designer@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam4/materialize`, { method: 'POST', headers: { cookie: designer } })).status, 403);

  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/dam4/materialize`, { method: 'POST', headers: { cookie: admin } });
  assert.equal(res.status, 200);
  const body = await res.json() as { materialized: number; skipped: number; assets: Array<{ id: string; extId: string; formats: number }> };
  assert.equal(body.materialized, 1, 'only the approved asset passes the exposure slice');
  assert.equal(body.skipped, 1, 'the unapproved asset is skipped');
  instId = body.assets[0]!.id;
  assert.match(instId, /^inst\//);
  assert.equal(body.assets[0]!.extId, 'ext/dam4/a1');
});

test('(b) materialize is a pin: the feed keeps the ext identity (bytes now local); no substitution until cutover', async () => {
  const designer = await login('designer@test');
  const ids = await feedIds(designer);
  assert.ok(ids.includes('ext/dam4/a1'), 'the ext identity stays until cutover — a pin does not move it');
  assert.ok(!ids.includes(instId), 'the inst entry is NOT substituted in at materialize time');

  // The ext entry now serves the LOCAL pinned bytes (pin-prefers-local), so the
  // asset survives upstream deletion while keeping its federated identity.
  const blob = await fetch(`${base}/catalog/ext/dam4/a1/att1`, { headers: { cookie: designer } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'mock:dam4:a1:att1');

  const seller = await login('seller@test');
  assert.ok(!(await feedIds(seller)).some((i) => i.startsWith('ext/dam4/')), 'provider exposure still governs');
});

test('(b2) an expiry on the still-ext identity gates the pinned asset — no governance escape', async () => {
  const admin = await login('admin@test');
  const put = (body: unknown) => fetch(`${base}/api/v1/catalog/lifecycle/ext/dam4/a1`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await put({ validUntil: '2020-01-01T00:00:00.000Z' })).status, 200);
  const designer = await login('designer@test');
  assert.ok(!(await feedIds(designer)).includes('ext/dam4/a1'), 'expired pin leaves the feed');
  assert.equal((await fetch(`${base}/catalog/ext/dam4/a1/att1`, { headers: { cookie: designer } })).status, 410, 'ext bytes gated');
  assert.equal((await fetch(`${base}/catalog/${instId}/png`, { headers: { cookie: designer } })).status, 410, 'inst bytes gated by the same ext row (no phantom-inst bypass)');
  // Reversible: move the window into the future so the cutover test starts clean.
  assert.equal((await put({ validUntil: '2099-01-01T00:00:00.000Z' })).status, 200);
  assert.ok((await feedIds(designer)).includes('ext/dam4/a1'), 'live again');
});

test('(c) inst/* streams from the BlobStore with an ETag; the format entry carries checksum + size', async () => {
  const designer = await login('designer@test');
  const blob = await fetch(`${base}/catalog/${instId}/png`, { headers: { cookie: designer } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'mock:dam4:a1:att1', 'served from the materialized local bytes');
  const etag = blob.headers.get('etag');
  assert.ok(etag, 'ETag = checksum');
  // Conditional GET: a matching if-none-match returns 304, not a re-stream.
  const revalidate = await fetch(`${base}/catalog/${instId}/png`, { headers: { cookie: designer, 'if-none-match': etag as string } });
  assert.equal(revalidate.status, 304);

  const doc = await (await fetch(`${base}/api/v1/catalog/assets/${instId}`, { headers: { cookie: designer } })).json() as {
    origin?: { provider: string; remoteId: string }; formats?: Array<{ format: string; checksum?: string; size?: number }>;
  };
  assert.equal(doc.origin?.provider, 'dam4');
  assert.equal(doc.origin?.remoteId, 'a1');
  const png = doc.formats?.find((f) => f.format === 'png');
  assert.ok(png?.checksum, 'checksum stamped for the shell to verify');
  assert.equal(png?.size, 17);
});

test('(d) cutover is owner-gated: it migrates identity, aliases old ext URLs, and disables the provider', async () => {
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam4/cutover`, { method: 'POST', headers: { cookie: admin } })).status, 403, 'admin ≠ owner for the kill switch');

  const owner = await login('owner@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/dam4/cutover`, { method: 'POST', headers: { cookie: owner } });
  assert.equal(res.status, 200);
  const cut = await res.json() as { migrated: number; enabled: boolean };
  assert.equal(cut.migrated, 1);
  assert.equal(cut.enabled, false, 'a db-managed provider is disabled by cutover');

  // Old ext/* blob URL — baked into already-rendered content — still resolves,
  // now through the alias to the instance blob.
  const designer = await login('designer@test');
  const aliased = await fetch(`${base}/catalog/ext/dam4/a1/att1`, { headers: { cookie: designer } });
  assert.equal(aliased.status, 200, 'the old federated URL survives via alias');
  assert.equal(await aliased.text(), 'mock:dam4:a1:att1');

  // The instance asset remains in the feed; the provider is gone.
  const ids = await feedIds(designer);
  assert.ok(ids.includes(instId));
  assert.ok(!ids.some((i) => i.startsWith('ext/dam4/')));

  assert.ok((await store.listAudit()).some((e) => e.action === 'catalog.provider.cutover'));
});

test('(f) two formats sharing a name are materialized to DISTINCT blobs — no overwrite, no byte loss', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dam5', kind: 'mock', label: 'Dup DAM', options: { assets: [
      { remoteId: 'dup', name: 'Two Renditions', nativeType: 'file', sections: [], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'p1' }, { format: 'png', remoteRef: 'p2' }] },
    ] } }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam5/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  const res = await fetch(`${base}/api/v1/catalog/providers/dam5/materialize`, { method: 'POST', headers: { cookie: admin } });
  const id = (await res.json() as { assets: Array<{ id: string; formats: number }> }).assets[0]!.id;

  const doc = await (await fetch(`${base}/api/v1/catalog/assets/${id}`, { headers: { cookie: admin } })).json() as {
    formats: Array<{ format: string; url: string; checksum: string }>;
  };
  const keys = doc.formats.map((f) => f.format).sort();
  assert.deepEqual(keys, ['png', 'png-2'], 'the colliding second format got a distinct key');
  assert.notEqual(doc.formats[0]!.checksum, doc.formats[1]!.checksum, 'distinct bytes, distinct checksums');

  const a = await (await fetch(`${base}/catalog/${id}/png`, { headers: { cookie: admin } })).text();
  const b = await (await fetch(`${base}/catalog/${id}/png-2`, { headers: { cookie: admin } })).text();
  assert.notEqual(a, b, 'each rendition serves its own bytes');
  assert.deepEqual([a, b].sort(), ['mock:dam5:dup:p1', 'mock:dam5:dup:p2']);
});

test('(e) lifecycle governs the instance asset like any asset: revoke drops it from feed + 410s the blob', async () => {
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/lifecycle/${instId}`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ revoke: true }),
  })).status, 200);

  const designer = await login('designer@test');
  assert.ok(!(await feedIds(designer)).includes(instId), 'revoked instance asset leaves the feed');
  const blob = await fetch(`${base}/catalog/${instId}/png`, { headers: { cookie: designer } });
  assert.equal(blob.status, 410, 'and its bytes stop serving');
});
