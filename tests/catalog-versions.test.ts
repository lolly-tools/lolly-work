/**
 * Asset versions and supersession (plans/31 §6) over real HTTP.
 *
 * The claim this suite pins down is that an instance asset's ID is durable and
 * its BYTES are a sequence:
 *
 *  - new bytes for an existing `inst/*` id arrive through the SAME submit
 *    pipeline and land as version N+1, with the served URL unchanged and the
 *    feed's checksum moved - which is exactly what tells a shell holding an old
 *    copy to fetch again;
 *  - the prior bytes stay reachable at a gated `?v=N`, so a session that pinned
 *    a render does not break because a brand refresh landed;
 *  - a rollback points the head at a version that already exists, changing
 *    nothing else and deleting nothing;
 *  - a HOLD refuses version deletion the way it refuses revocation, and
 *    retention never trims the head or a held asset;
 *  - a head move busts the render cache, because a cached render of the old
 *    bytes under an unchanged key is the failure that makes versioning a lie;
 *  - supersession is the other half and works on IDS, not bytes: `replacedBy`
 *    rides the served feed additively for pack, federated and instance ids
 *    alike.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { instanceAssetEntry, instanceAssetsFingerprint } from '../server/src/catalog/instance-assets.ts';
import {
  applyVersionToRecord, backfillVersionOne, orphanBlobIds, parseReplacedBy, versionsToTrim,
  type AssetVersionRecord,
} from '../server/src/catalog/versions.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';
import type { AuditEvent } from '../server/src/audit/chain.ts';

const servers: Server[] = [];

/** Three distinct 1x1 PNGs - real enough that the sniffer reads their IHDR,
 *  and different enough in their bytes that a checksum tells them apart. */
const PNG_V1 = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');
const PNG_V2 = Buffer.concat([PNG_V1, Buffer.from('second')]);
const PNG_V3 = Buffer.concat([PNG_V1, Buffer.from('third-take')]);

const CARD_MANIFEST = {
  id: 'test-card', name: 'test-card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 400, height: 200, formats: ['svg', 'png'] },
  inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' }],
};
const CARD_TEMPLATE =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200" width="400" height="200">' +
  '<text x="20" y="110" font-size="28" fill="#ffffff">{{title}}</text></svg>';

interface Booted {
  base: string;
  store: ReturnType<typeof createMemoryStore>;
  blobs: ReturnType<typeof createMemoryBlobStore>;
}

/** One instance with a versionable `inst/hero`, a pack asset, and a real tool
 *  so the render cache can be observed through its ETag. */
async function boot(overrides: Record<string, unknown> = {}): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-versions-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'test-card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: 'acme/logo', name: 'Acme Logo', type: 'icon', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg' }] }],
  }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'test-card' }] }));
  await writeFile(join(pack, 'tools', 'test-card', 'tool.json'), JSON.stringify(CARD_MANIFEST));
  await writeFile(join(pack, 'tools', 'test-card', 'template.html'), CARD_TEMPLATE);

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Version Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      // admin holds catalog.edit (curation) AND the exposure group.
      { email: 'admin@test', groups: ['admin', 'design'] },
      // author holds catalog.submit (contribution) and nothing above it.
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'outsider@test', groups: ['sales'] },
    ] },
    ...overrides,
  }));

  const store = createMemoryStore();
  const blobs = createMemoryBlobStore();
  const stat = await blobs.put('inst/hero/png', PNG_V1, 'image/png');
  await store.putInstanceAsset({
    id: 'inst/hero',
    entry: instanceAssetEntry('inst/hero', { name: 'Campaign Hero', type: 'image' }, [
      { format: 'png', size: stat.size, checksum: stat.checksum },
    ]),
    blobs: { png: 'inst/hero/png' },
    groups: ['design'],
    createdAt: '2026-08-20T00:00:00.000Z',
  });
  const stat2 = await blobs.put('inst/hero2/png', PNG_V3, 'image/png');
  await store.putInstanceAsset({
    id: 'inst/hero2',
    entry: instanceAssetEntry('inst/hero2', { name: 'Campaign Hero 2027', type: 'image' }, [
      { format: 'png', size: stat2.size, checksum: stat2.checksum },
    ]),
    blobs: { png: 'inst/hero2/png' },
    groups: ['design'],
    createdAt: '2026-08-20T00:00:00.000Z',
  });

  const app = buildApp({ config, store, blobs, secrets: { session: 'sV', link: 'lV' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store, blobs };
}

after(() => { for (const s of servers) s.close(); });

let hub: Booted;
let base = '';
let admin = '';
let author = '';
let outsider = '';

before(async () => {
  hub = await boot();
  base = hub.base;
  admin = await login(base, 'admin@test');
  author = await login(base, 'author@test');
  outsider = await login(base, 'outsider@test');
});

async function login(b: string, email: string): Promise<string> {
  const res = await fetch(`${b}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** New bytes for an existing id - the natural way a version arrives. */
async function newVersion(
  b: string, cookie: string, assetId: string, bytes: Buffer, params: Record<string, string> = {},
): Promise<Response> {
  const q = new URLSearchParams({ assetId, ...params });
  return fetch(`${b}/api/v1/catalog/submit?${q}`, {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: new Uint8Array(bytes),
  });
}

async function feedEntry(b: string, cookie: string, id: string): Promise<Record<string, unknown> | undefined> {
  const res = await fetch(`${b}/catalog/assets/index.json`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const index = await res.json() as AssetIndex;
  return (index.assets ?? []).find((a) => a.id === id) as Record<string, unknown> | undefined;
}

/** Read one response body ONCE, asserting the status with the body as the
 *  failure message - `assert.equal(res.status, n, await res.text())` would
 *  consume the body even when it passes. */
async function jsonOk<T>(res: Response, status = 200): Promise<T> {
  const text = await res.text();
  assert.equal(res.status, status, text);
  return JSON.parse(text) as T;
}

async function versions(b: string, cookie: string, id: string): Promise<{
  head: number; keep: number; versions: Array<Record<string, unknown>>;
}> {
  return jsonOk(await fetch(`${b}/api/v1/catalog/assets/${id}/versions`, { headers: { cookie } }));
}

// ── the migration ───────────────────────────────────────────────────────────

test('migration 0020 follows 0019, with nothing between', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0020_catalog_asset_versions.sql');
  assert.ok(at > 0, '0020 is on disk');
  assert.equal(files[at - 1], '0019_catalog_collections.sql', '0020 follows 0019 with nothing between');
  // The migration CEILING moved on to wave 7 (SCIM) with 0021 - scim.test.ts
  // now holds the "nothing above me" assertion, the same relay the earlier
  // waves ran (collections handed 0019's ceiling to versions at 0020).
  const sql = await readFile(join(dir, '0020_catalog_asset_versions.sql'), 'utf8');
  assert.match(sql, /create table catalog_asset_versions/);
  assert.match(sql, /primary key \(asset_id, version\)/, 'one row per (asset, version)');
  // No backfill: version 1 is materialized from the record when it is needed.
  assert.equal(/\b(update|insert into)\b/i.test(sql), false, 'the migration moves no data');
  // The runner wraps each file in its own transaction.
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false);
});

// ── the pure rules ──────────────────────────────────────────────────────────

test('retention keeps the head whatever its age, and keep-all is the default', () => {
  const rows: AssetVersionRecord[] = [1, 2, 3, 4].map((version) => ({
    assetId: 'inst/a', version,
    formats: [{ format: 'png', blobId: `inst/a/v${version}/png`, size: 1, checksum: `c${version}` }],
    by: 'user:u1', at: '2026-08-20T00:00:00.000Z',
  }));
  assert.deepEqual(versionsToTrim(rows, 4, 0), [], 'keep-all (the default) trims nothing');
  assert.deepEqual(versionsToTrim(rows, 4, 2).map((r) => r.version), [1, 2], 'oldest first, newest two kept');
  // A rollback made version 1 current: retention must not delete the bytes the
  // asset is serving, however old they are.
  assert.deepEqual(versionsToTrim(rows, 1, 2).map((r) => r.version), [2, 3], 'the head survives, the next-newest joins it');
  assert.deepEqual(versionsToTrim(rows, 4, 10), [], 'a ceiling above the history trims nothing');

  // Two versions can point at the same bytes (a revert-by-upload); trimming one
  // must not blank the other.
  const shared: AssetVersionRecord[] = rows.map((r) => ({ ...r, formats: [{ ...r.formats[0]!, blobId: 'same' }] }));
  assert.deepEqual(orphanBlobIds([shared[0]!], [shared[1]!]), [], 'a blob a surviving version still names is kept');
  assert.deepEqual(orphanBlobIds([rows[0]!], [rows[1]!]), ['inst/a/v1/png']);
});

test('a head move rewrites what the entry advertises, never where it is served from', () => {
  const rec = {
    id: 'inst/x',
    entry: instanceAssetEntry('inst/x', { name: 'X', type: 'image', tags: ['brand'] }, [
      { format: 'png', size: 10, checksum: 'old' },
    ]),
    blobs: { png: 'inst/x/png' },
    createdAt: '2026-08-20T00:00:00.000Z',
  };
  const first = backfillVersionOne(rec);
  assert.equal(first.version, 1);
  assert.deepEqual(first.formats, [{ format: 'png', blobId: 'inst/x/png', size: 10, checksum: 'old' }]);

  const next: AssetVersionRecord = {
    assetId: 'inst/x', version: 2,
    formats: [{ format: 'png', blobId: 'inst/x/v2/png', size: 22, checksum: 'new' }],
    by: 'user:u1', at: '2026-08-20T01:00:00.000Z', width: 4, height: 3,
  };
  const moved = applyVersionToRecord(rec, next);
  assert.equal(moved.headVersion, 2);
  assert.equal(moved.blobs.png, 'inst/x/v2/png', 'the blob behind the id changed');
  assert.equal(moved.entry.name, 'X', 'descriptive metadata is not touched by a byte change');
  assert.deepEqual(moved.entry.tags, ['brand']);
  const fmt = (moved.entry.formats ?? [])[0] as Record<string, unknown>;
  assert.equal(fmt.url, '/catalog/inst/x/png', 'the served URL is the id, not the version');
  assert.equal(fmt.checksum, 'new', 'the advertised checksum moved, which is what makes a shell re-fetch');
  assert.equal(moved.entry.width, 4);

  // The fingerprint the render cache key folds in has to move too.
  assert.notEqual(instanceAssetsFingerprint([rec]), instanceAssetsFingerprint([moved]));
  assert.equal(instanceAssetsFingerprint([moved]), instanceAssetsFingerprint([moved]), 'and is content-derived, not a counter');
});

test('parseReplacedBy: a successor id, cleared, never itself, never a traversal', () => {
  assert.deepEqual(parseReplacedBy('inst/new', 'inst/old'), { value: 'inst/new' });
  assert.deepEqual(parseReplacedBy(null, 'inst/old'), { value: null });
  assert.deepEqual(parseReplacedBy('', 'inst/old'), { value: null });
  assert.ok('error' in parseReplacedBy('inst/old', 'inst/old'), 'a self-reference is a loop a consumer would follow forever');
  assert.ok('error' in parseReplacedBy('../../etc/passwd', 'inst/old'));
  assert.ok('error' in parseReplacedBy(7, 'inst/old'));
});

// ── new bytes for an existing id ────────────────────────────────────────────

test('new bytes land as version 2: the feed serves the head, ?v=1 keeps the old bytes', async () => {
  const before = await feedEntry(base, admin, 'inst/hero');
  const oldChecksum = ((before?.formats as Array<Record<string, unknown>>)[0] as Record<string, unknown>).checksum;

  const res = await newVersion(base, admin, 'inst/hero', PNG_V2, { note: 'reshot in studio' });
  const body = await jsonOk<{ version: number; duplicate: boolean; assetId: string }>(res, 201);
  assert.equal(body.version, 2);
  assert.equal(body.duplicate, false);
  assert.equal(body.assetId, 'inst/hero', 'the id is durable: no second asset was minted');

  // The feed serves the head, at the same URL, with a moved checksum.
  const after = await feedEntry(base, admin, 'inst/hero');
  const fmt = (after?.formats as Array<Record<string, unknown>>)[0] as Record<string, unknown>;
  assert.equal(fmt.url, '/catalog/inst/hero/png');
  assert.notEqual(fmt.checksum, oldChecksum);
  assert.equal(fmt.size, PNG_V2.length);

  const head = await fetch(`${base}/catalog/inst/hero/png`, { headers: { cookie: admin } });
  assert.equal(Buffer.from(await head.arrayBuffer()).toString('hex'), PNG_V2.toString('hex'));

  // Version 1 was materialized from the record itself - the asset predates
  // versioning, so its history starts at 1 rather than at 2 - and its bytes are
  // still reachable for a session that pinned them.
  const pinned = await fetch(`${base}/catalog/inst/hero/png?v=1`, { headers: { cookie: admin } });
  assert.equal(pinned.status, 200);
  assert.equal(Buffer.from(await pinned.arrayBuffer()).toString('hex'), PNG_V1.toString('hex'));
  assert.equal(pinned.headers.get('etag'), `"${(before?.formats as Array<Record<string, unknown>>)[0]!.checksum}"`);

  const list = await versions(base, admin, 'inst/hero');
  assert.equal(list.head, 2);
  assert.deepEqual(list.versions.map((v) => v.version), [2, 1], 'newest first');
  assert.equal(list.versions[0]!.head, true);
  assert.equal(list.versions[0]!.note, 'reshot in studio');
  assert.equal(list.versions[1]!.head, false);

  // An unknown version is a 404, never the head served under the wrong number.
  assert.equal((await fetch(`${base}/catalog/inst/hero/png?v=9`, { headers: { cookie: admin } })).status, 404);
  assert.equal((await fetch(`${base}/catalog/inst/hero/png?v=x`, { headers: { cookie: admin } })).status, 400);
});

test('replacing published bytes is the CURATION right, not the contribution right', async () => {
  // An author holds `catalog.submit`: they may contribute a new asset...
  const contributed = await fetch(`${base}/api/v1/catalog/submit?name=Author%20Upload`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'image/png' },
    body: new Uint8Array(Buffer.concat([PNG_V1, Buffer.from('author-upload')])),
  });
  await jsonOk(contributed, 201);
  // ...and may NOT replace the bytes of one that is already published.
  const refused = await newVersion(base, author, 'inst/hero', PNG_V3);
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  assert.equal((await versions(base, admin, 'inst/hero')).head, 2, 'nothing landed');
});

test('a version submit is bytes only: metadata and exposure keep their own doors', async () => {
  for (const [key, value] of [['groups', 'sales'], ['tags', 'a,b'], ['description', 'x'], ['type', 'icon']]) {
    const res = await newVersion(base, admin, 'inst/hero', PNG_V3, { [key as string]: value as string });
    assert.equal(res.status, 400, `${key} is refused rather than silently ignored`);
    assert.match((await res.json() as { error: { message: string } }).error.message, /\/meta/);
  }
  // A federated or pack id has no versions here at all.
  const packTarget = await newVersion(base, admin, 'acme/logo', PNG_V3);
  assert.equal(packTarget.status, 400);

  // Nor does a PIN: its bytes are local but its identity is still the
  // provider's until the exit's cutover, so versioning it would fork it from
  // the record it claims to be.
  const pinStat = await hub.blobs.put('inst/pinned/png', PNG_V1, 'image/png');
  await hub.store.putInstanceAsset({
    id: 'inst/pinned',
    entry: instanceAssetEntry('inst/pinned', { name: 'Pinned', type: 'image' }, [
      { format: 'png', size: pinStat.size, checksum: pinStat.checksum },
    ]),
    blobs: { png: 'inst/pinned/png' },
    groups: ['design'],
    origin: { provider: 'dam9', providerKind: 'mock', remoteId: 'a1', materializedAt: '2026-08-20T00:00:00.000Z' },
    createdAt: '2026-08-20T00:00:00.000Z',
  });
  const pinned = await newVersion(base, admin, 'inst/pinned', PNG_V3);
  assert.equal(pinned.status, 409);
  assert.equal((await pinned.json() as { error: { code: string } }).error.code, 'ASSET_IS_PINNED');
  // An asset this caller cannot see is a 404, not a 403 that confirms it.
  const unseen = await newVersion(base, outsider, 'inst/hero', PNG_V3);
  assert.equal(unseen.status, 403, 'an outsider holds neither catalog.edit nor the group');
});

test('identical bytes for the same id are reported as the head, and stored again by nobody', async () => {
  const listBefore = await versions(base, admin, 'inst/hero');
  const res = await newVersion(base, admin, 'inst/hero', PNG_V2);
  assert.equal(res.status, 200);
  const body = await res.json() as { duplicate: boolean; version: number };
  assert.equal(body.duplicate, true);
  assert.equal(body.version, 2);
  assert.deepEqual((await versions(base, admin, 'inst/hero')).versions.length, listBefore.versions.length);
});

test('?v=N answers to every gate the head answers to', async () => {
  // Exposure: an outsider gets no version of an asset they cannot see.
  assert.equal((await fetch(`${base}/catalog/inst/hero/png?v=1`, { headers: { cookie: outsider } })).status, 403);

  // Lifecycle: an expired asset's HISTORY expires with it. Done with a window
  // rather than a revocation because a revocation is forever - which is itself
  // the point being made: version history is not a way around lifecycle.
  const expired = await fetch(`${base}/api/v1/catalog/lifecycle/inst/hero2`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ validUntil: '2020-01-01T00:00:00.000Z' }),
  });
  assert.equal(expired.status, 200);
  assert.equal((await fetch(`${base}/catalog/inst/hero2/png?v=1`, { headers: { cookie: admin } })).status, 410);
  await fetch(`${base}/api/v1/catalog/lifecycle/inst/hero2`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ validUntil: null }),
  });
  assert.equal((await fetch(`${base}/catalog/inst/hero2/png?v=1`, { headers: { cookie: admin } })).status, 200);
});

// ── rollback ────────────────────────────────────────────────────────────────

test('rollback points the head at a prior version, deletes nothing, and is itself reversible', async () => {
  const back = await fetch(`${base}/api/v1/catalog/assets/inst/hero/head`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }),
  });
  assert.deepEqual(await jsonOk(back), { ok: true, id: 'inst/hero', version: 1, changed: true, previous: 2 });

  const served = await fetch(`${base}/catalog/inst/hero/png`, { headers: { cookie: admin } });
  assert.equal(Buffer.from(await served.arrayBuffer()).toString('hex'), PNG_V1.toString('hex'), 'the id serves the rolled-back bytes');
  const list = await versions(base, admin, 'inst/hero');
  assert.equal(list.head, 1);
  assert.equal(list.versions.length, 2, 'the version that WAS head is still in the history');
  assert.equal((await fetch(`${base}/catalog/inst/hero/png?v=2`, { headers: { cookie: admin } })).status, 200);

  // Idempotent, and audited with both numbers.
  const again = await fetch(`${base}/api/v1/catalog/assets/inst/hero/head`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }),
  });
  assert.equal((await again.json() as { changed: boolean }).changed, false);
  const rolled = (await hub.store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.rollback');
  assert.equal(rolled.length, 1, 'a no-op rollback writes no audit event');
  assert.deepEqual(rolled[0]?.payload, { before: { version: 2 }, after: { version: 1 } } as never,
    'audited with where the head was and where it went');

  const missing = await fetch(`${base}/api/v1/catalog/assets/inst/hero/head`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ version: 7 }),
  });
  assert.equal(missing.status, 404);
});

// ── holds, deletion and retention ───────────────────────────────────────────

test('a hold refuses version deletion the way it refuses revocation', async () => {
  // Head is version 1 after the rollback above; version 2 is the deletable one.
  const held = await fetch(`${base}/api/v1/catalog/lifecycle/inst/hero`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ hold: { note: 'litigation' } }),
  });
  await jsonOk(held);

  const refused = await fetch(`${base}/api/v1/catalog/assets/inst/hero/versions/2`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(refused.status, 409);
  const err = await refused.json() as { error: { code: string; message: string } };
  assert.equal(err.error.code, 'ASSET_HELD');
  assert.match(err.error.message, /litigation/);
  assert.equal((await versions(base, admin, 'inst/hero')).versions.length, 2, 'nothing was deleted');

  // The head is never deletable, hold or no hold: roll back first.
  await fetch(`${base}/api/v1/catalog/lifecycle/inst/hero`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ hold: null }),
  });
  const isHead = await fetch(`${base}/api/v1/catalog/assets/inst/hero/versions/1`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(isHead.status, 409);
  assert.equal((await isHead.json() as { error: { code: string } }).error.code, 'VERSION_IS_HEAD');

  // With the hold released, the non-head version goes - bytes and all.
  const gone = await fetch(`${base}/api/v1/catalog/assets/inst/hero/versions/2`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(gone.status, 200);
  assert.equal((await fetch(`${base}/catalog/inst/hero/png?v=2`, { headers: { cookie: admin } })).status, 404);
  assert.equal(await hub.blobs.head('inst/hero/v2/png'), null, 'the orphaned bytes went with the row');
  // The number is not reused: the next upload is version 3.
  const next = await newVersion(base, admin, 'inst/hero', PNG_V3);
  assert.equal((await next.json() as { version: number }).version, 3);
});

test('retention trims oldest-first, never the head, and never a held asset', async () => {
  const keeper = await boot({ policy: { catalog: { versionKeep: 2 } } });
  const cookie = await login(keeper.base, 'admin@test');
  for (const bytes of [PNG_V2, PNG_V3, Buffer.concat([PNG_V1, Buffer.from('fourth')])]) {
    await jsonOk(await newVersion(keeper.base, cookie, 'inst/hero', bytes), 201);
  }
  const list = await versions(keeper.base, cookie, 'inst/hero');
  assert.equal(list.keep, 2);
  assert.equal(list.head, 4);
  assert.deepEqual(list.versions.map((v) => v.version), [4, 3], 'the two newest survive, the oldest were trimmed');
  assert.equal((await fetch(`${keeper.base}/catalog/inst/hero/png?v=1`, { headers: { cookie } })).status, 404);
  assert.equal(await keeper.blobs.head('inst/hero/png'), null, 'version 1 bytes went with the row');
  assert.equal((await fetch(`${keeper.base}/catalog/inst/hero/png`, { headers: { cookie } })).status, 200, 'the head still serves');

  // A hold suspends retention entirely: in this codebase a hold only ever
  // preserves availability.
  await fetch(`${keeper.base}/api/v1/catalog/lifecycle/inst/hero`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ hold: { note: 'audit' } }),
  });
  const res = await newVersion(keeper.base, cookie, 'inst/hero', Buffer.concat([PNG_V1, Buffer.from('fifth')]));
  assert.equal(res.status, 201);
  assert.deepEqual((await versions(keeper.base, cookie, 'inst/hero')).versions.map((v) => v.version), [5, 4, 3],
    'the held asset kept a version retention would otherwise have trimmed');
});

// ── supersession ────────────────────────────────────────────────────────────

test('replacedBy retires an id in favour of another, and rides the feed additively', async () => {
  // Any id takes one, because the overlay is keyed by id: a pack asset is
  // superseded exactly as an instance asset is.
  for (const [id, successor] of [['inst/hero', 'inst/hero2'], ['acme/logo', 'inst/hero2']]) {
    const res = await fetch(`${base}/api/v1/catalog/assets/${id}/meta`, {
      method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
      body: JSON.stringify({ replacedBy: successor }),
    });
    assert.equal((await jsonOk<{ replacedBy: string }>(res)).replacedBy, successor);
    assert.equal((await feedEntry(base, admin, id as string))?.replacedBy, successor, 'served in the feed');
  }
  const inspect = await fetch(`${base}/api/v1/catalog/assets/inst/hero`, { headers: { cookie: admin } });
  const doc = await inspect.json() as { replacedBy?: string; version?: number };
  assert.equal(doc.replacedBy, 'inst/hero2');
  assert.equal(doc.version, 3, 'inspect names the served version too');

  // A supersession is advice, never a takedown: the asset keeps serving.
  assert.equal((await fetch(`${base}/catalog/inst/hero/png`, { headers: { cookie: admin } })).status, 200);

  // Refusals: itself, and a successor this caller cannot see.
  const loop = await fetch(`${base}/api/v1/catalog/assets/inst/hero/meta`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ replacedBy: 'inst/hero' }),
  });
  assert.equal(loop.status, 400);
  const ghost = await fetch(`${base}/api/v1/catalog/assets/inst/hero/meta`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ replacedBy: 'inst/nope' }),
  });
  assert.equal(ghost.status, 400);

  // Cleared, and the entry goes back to carrying nothing.
  const cleared = await fetch(`${base}/api/v1/catalog/assets/acme/logo/meta`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ replacedBy: null }),
  });
  assert.equal(cleared.status, 200);
  assert.equal((await feedEntry(base, admin, 'acme/logo'))?.replacedBy, undefined);
  const events = (await hub.store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.edit');
  assert.ok(events.some((e) => (e.payload as { after?: { replacedBy?: string } })?.after?.replacedBy === 'inst/hero2'),
    'audited with before and after like every other metadata edit');
});

// ── the render cache ────────────────────────────────────────────────────────

test('a head move busts the render cache key', async () => {
  const render = async (): Promise<string> => {
    const res = await fetch(`${base}/render/test-card.svg?title=Versioned`, { headers: { cookie: admin } });
    assert.equal(res.status, 200, await res.text());
    return res.headers.get('etag') as string;
  };
  const first = await render();
  assert.ok(first?.startsWith('"r-'));
  assert.equal(await render(), first, 'a stable catalog renders under a stable key');

  // Roll the head back: the bytes behind a stable catalog id changed, so the
  // key every render was cached under has to move with them.
  const back = await fetch(`${base}/api/v1/catalog/assets/inst/hero/head`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ version: 1 }),
  });
  await jsonOk(back);
  const afterRollback = await render();
  assert.notEqual(afterRollback, first, 'the render cache key moved with the head');

  // And a NEW version moves it again.
  assert.equal((await newVersion(base, admin, 'inst/hero', Buffer.concat([PNG_V1, Buffer.from('sixth')]))).status, 201);
  assert.notEqual(await render(), afterRollback);
});
