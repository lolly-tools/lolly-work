/**
 * Catalog collections (plans/31 §5) over real HTTP.
 *
 * A collection is a named, ordered, group-visible set of catalog asset ids, and
 * this suite pins the three things that make it more than a list in a table:
 *
 *  - the per-caller FEED carries the collections a caller's groups admit, with
 *    members narrowed to what that caller is already being served, ADDITIVELY -
 *    so a deployment with none serves a byte-identical index and the OSS
 *    catalog view can light up its Collections section later with no server
 *    change;
 *  - a collection LINK reuses wave 1b's machinery one level up: exposure at
 *    mint, lifecycle re-resolved per member at every resolve;
 *  - the bearer surface is a listing page and a zip and NOTHING ELSE. The
 *    boundary is asserted here rather than merely described: an asset the
 *    collection does not name is refused on a perfectly valid signature, and
 *    the page carries no route into the rest of the catalog.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { composeCollections, normalizeCollection, type CollectionRecord } from '../server/src/catalog/collections.ts';
import { accentFromTokens, collectionPageHtml } from '../server/src/links/collection-page.ts';
import { safeEntryName, ZipBuilder } from '../server/src/links/zip.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const HERO_BYTES = 'campaign-hero-bytes';
const PACK_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Acme</title></svg>';
const MARK_SVG = '<svg xmlns="http://www.w3.org/2000/svg"><title>Mark</title></svg>';

const MOCK_ASSETS = [
  {
    remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: [], approved: true,
    formats: [{ format: 'png', remoteRef: 'att1', size: 18 }],
  },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-collections-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo.svg'), PACK_SVG);
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'mark.svg'), MARK_SVG);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [
      { id: 'acme/logo', name: 'Acme Logo', type: 'icon', formats: [{ format: 'svg', url: '/catalog/assets/acme/logo.svg' }] },
      { id: 'acme/mark', name: 'Acme Mark', type: 'icon', formats: [{ format: 'svg', url: '/catalog/assets/acme/mark.svg' }] },
    ],
  }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Collection Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      // The curator holds admin AND the exposure groups: a collection may only
      // hold assets its curator can see, which is the rule this suite checks.
      { email: 'admin@test', groups: ['admin', 'design', 'sales'] },
      { email: 'owner@test', groups: ['owner', 'design'] },
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

  const app = buildApp({ config, store, blobs, secrets: { session: 'sC', link: 'lC', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dam9', kind: 'mock', label: 'Collection DAM', options: { assets: MOCK_ASSETS }, exposure: { groups: ['design'] } }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam9/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

async function putCollection(cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/catalog/collections/${id}`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function mint(cookie: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/links`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

async function mintOk(cookie: string, body: Record<string, unknown>): Promise<{ id: string; path: string }> {
  const res = await mint(cookie, body);
  if (res.status !== 201) assert.fail(`mint failed (${res.status}): ${await res.text()}`);
  const { id, url } = await res.json() as { id: string; url: string };
  return { id, path: url.replace('http://localhost', base) };
}

async function setLifecycle(assetId: string, body: Record<string, unknown>): Promise<void> {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/lifecycle/${assetId}`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal(res.status, 200, await res.text());
}

/**
 * A real ZIP reader, walking the central directory the way an extractor does.
 * Reading the archive back through its OWN index (rather than trusting the
 * order it was written in) is the point: it proves the central directory's
 * offsets, sizes and CRCs actually describe the bytes on the wire, which is
 * exactly what a hand-built archive could get wrong.
 */
function readZip(buf: Buffer): Array<{ name: string; bytes: Buffer }> {
  let eocd = -1;
  for (let i = buf.length - 22; i >= 0; i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  assert.ok(eocd >= 0, 'the archive ends with an end-of-central-directory record');
  const count = buf.readUInt16LE(eocd + 10);
  let off = buf.readUInt32LE(eocd + 16);
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (let n = 0; n < count; n++) {
    assert.equal(buf.readUInt32LE(off), 0x02014b50, 'central directory header signature');
    const method = buf.readUInt16LE(off + 10);
    const declaredCrc = buf.readUInt32LE(off + 16);
    const compSize = buf.readUInt32LE(off + 20);
    const uncompSize = buf.readUInt32LE(off + 24);
    const nameLen = buf.readUInt16LE(off + 28);
    const extraLen = buf.readUInt16LE(off + 30);
    const commentLen = buf.readUInt16LE(off + 32);
    const localOff = buf.readUInt32LE(off + 42);
    const name = buf.toString('utf8', off + 46, off + 46 + nameLen);
    assert.equal(buf.readUInt32LE(localOff), 0x04034b50, 'local file header signature');
    const dataStart = localOff + 30 + buf.readUInt16LE(localOff + 26) + buf.readUInt16LE(localOff + 28);
    const raw = buf.subarray(dataStart, dataStart + compSize);
    const bytes = method === 8 ? inflateRawSync(raw) : Buffer.from(raw);
    assert.equal(bytes.length, uncompSize, `${name}: declared uncompressed size matches`);
    assert.equal(crc32(bytes) >>> 0, declaredCrc, `${name}: declared CRC matches the bytes`);
    out.push({ name, bytes });
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

test('migration 0019 follows 0018, with nothing between', async () => {
  const { readdir } = await import('node:fs/promises');
  const files = (await readdir(new URL('../migrations', import.meta.url))).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0019_catalog_collections.sql');
  assert.ok(at > 0, '0019 is on disk');
  // Collections own 0019 and claim nothing between it and the asset metadata of
  // 0018. The migration CEILING belongs to whichever stage last claimed a
  // number - it moved to catalog-versions.test.ts with 0020 - so this assertion
  // stays about what collections actually took.
  assert.equal(files[at - 1], '0018_catalog_asset_meta.sql', '0019 follows 0018 with nothing between');
});

test('normalizeCollection: slug ids, ordered deduped members, traversal refused', () => {
  const ctx = { curator: 'user:u1', now: '2026-08-20T00:00:00.000Z' };
  assert.ok('error' in normalizeCollection('Not A Slug', { name: 'x' }, ctx));
  assert.ok('error' in normalizeCollection('ok', { members: [] }, ctx), 'a name is required');
  assert.ok('error' in normalizeCollection('ok', { name: 'x', members: ['../../etc/passwd'] }, ctx));
  assert.ok('error' in normalizeCollection('ok', { name: 'x', members: 'inst/a' }, ctx));
  assert.ok('error' in normalizeCollection('ok', { name: 'x', groups: 3 }, ctx));

  const made = normalizeCollection('launch', {
    name: '  Launch kit  ', description: ' spring ', members: ['inst/b', 'inst/a', 'inst/b'], groups: ['design', 'design', ''],
  }, ctx) as CollectionRecord;
  assert.equal(made.name, 'Launch kit');
  assert.equal(made.description, 'spring');
  assert.deepEqual(made.members, ['inst/b', 'inst/a'], 'order is the curator\'s and a repeat keeps its first position');
  assert.deepEqual(made.groups, ['design']);
  assert.equal(made.curator, 'user:u1');

  // A sparse update keeps what it does not mention, and never re-owns the set.
  const edited = normalizeCollection('launch', { description: '' }, {
    curator: 'user:u2', now: '2026-08-21T00:00:00.000Z', prior: made,
  }) as CollectionRecord;
  assert.equal(edited.name, 'Launch kit');
  assert.deepEqual(edited.members, ['inst/b', 'inst/a']);
  assert.equal(edited.description, undefined, 'an emptied description clears rather than storing blank');
  assert.equal(edited.curator, 'user:u1', 'editing somebody else\'s collection does not re-own it');
  assert.equal(edited.createdAt, made.createdAt);
  assert.notEqual(edited.updatedAt, made.updatedAt);
});

test('composeCollections is additive: no visible collections leaves the index untouched', () => {
  const index = { assets: [{ id: 'a/1' }] };
  assert.equal(composeCollections(index, [], ['design']), index, 'the same reference - a public build is byte-identical');
  const secret: CollectionRecord = {
    id: 's', name: 'S', members: ['a/1'], groups: ['brand'],
    curator: 'user:u1', createdAt: 'x', updatedAt: 'x',
  };
  assert.equal(composeCollections(index, [secret], ['design']), index, 'a collection this caller\'s groups do not admit is not there at all');
});

test('CRUD and RBAC: managing collections is its own action, grant-narrowable', async () => {
  const admin = await login('admin@test');
  const designer = await login('designer@test');

  assert.equal((await fetch(`${base}/api/v1/catalog/collections`, { headers: { cookie: designer } })).status, 403,
    'a plain member does not hold catalog.collection.manage');
  assert.equal((await putCollection(designer, 'nope', { name: 'Nope' })).status, 403);

  const created = await putCollection(admin, 'launch', {
    name: 'Launch kit', description: 'Everything for the spring launch.',
    members: ['inst/hero', 'ext/dam9/a1', 'acme/logo'], groups: ['design'],
  });
  const rec = await created.json() as CollectionRecord;
  assert.equal(created.status, 201, JSON.stringify(rec));
  assert.deepEqual(rec.members, ['inst/hero', 'ext/dam9/a1', 'acme/logo'], 'the curator\'s order is stored as given');
  assert.match(rec.curator, /^user:/, 'the curator is recorded on the set');

  const again = await putCollection(admin, 'launch', { description: 'Spring 2026.' });
  assert.equal(again.status, 200, 'an update is a 200, and a sparse body keeps the members');
  assert.deepEqual((await again.json() as CollectionRecord).members, ['inst/hero', 'ext/dam9/a1', 'acme/logo']);

  const listed = await (await fetch(`${base}/api/v1/catalog/collections`, { headers: { cookie: admin } })).json() as { collections: CollectionRecord[] };
  assert.ok(listed.collections.some((c) => c.id === 'launch'));

  // The audit trail carries before/after, like every other catalog mutation.
  const entry = (await store.listAudit()).find((e) => e.action === 'catalog.collection.edit' && e.subject === 'collection:launch');
  assert.ok(entry, 'a collection edit is audited');

  // Grant-narrowable: the brand team curates without becoming admin.
  const owner = await login('owner@test');
  assert.equal((await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'group:design', action: 'catalog.collection.manage', resource: '*', effect: 'allow' }),
  })).status, 201);
  const granted = await putCollection(await login('designer@test'), 'moodboard', { name: 'Moodboard', members: ['inst/hero'] });
  assert.equal(granted.status, 201, await granted.text());

  assert.equal((await fetch(`${base}/api/v1/catalog/collections/moodboard`, { method: 'DELETE', headers: { cookie: admin } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/collections/moodboard`, { headers: { cookie: admin } })).status, 404);
});

test('a collection may only hold assets its curator can see', async () => {
  // Exposure must not be launderable through a list: a collection link is
  // minted on the COLLECTION's visibility, and its bearer then gets every
  // member, so a curator who cannot see an asset cannot put it in a set.
  const owner = await login('owner@test');
  assert.equal((await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'group:sales', action: 'catalog.collection.manage', resource: '*', effect: 'allow' }),
  })).status, 201);

  const seller = await login('seller@test');
  const refused = await putCollection(seller, 'sales-set', { name: 'Sales set', members: ['acme/logo', 'inst/hero'] });
  assert.equal(refused.status, 403);
  assert.equal((await refused.json() as { error: { code: string } }).error.code, 'MEMBER_NOT_VISIBLE');
  assert.equal(await store.getCollection('sales-set'), null, 'nothing was written');

  const ok = await putCollection(seller, 'sales-set', { name: 'Sales set', members: ['acme/logo'] });
  assert.equal(ok.status, 201);
  assert.equal((await putCollection(seller, 'sales-set', { members: ['acme/logo', 'ext/dam9/a1'] })).status, 403,
    'the same rule holds on an update');
});

test('the per-caller feed lists the collections a caller may see, additively', async () => {
  const admin = await login('admin@test');
  await putCollection(admin, 'everyone', { name: 'For everyone', members: ['acme/logo', 'inst/hero'], groups: '*' });

  const designer = await login('designer@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: designer } })).json() as {
    assets: Array<{ id: string }>;
    collections?: Array<{ id: string; name: string; members: string[]; description?: string }>;
  };
  assert.ok(Array.isArray(feed.assets), 'the assets half is untouched');
  const byId = new Map((feed.collections ?? []).map((c) => [c.id, c]));
  assert.ok(byId.has('launch'), 'a design-visible collection reaches a designer');
  assert.deepEqual(byId.get('launch')?.members, ['inst/hero', 'ext/dam9/a1', 'acme/logo'], 'in the curator\'s order');
  assert.equal(byId.get('launch')?.description, 'Spring 2026.');

  const seller = await login('seller@test');
  const sellerFeed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: seller } })).json() as {
    collections?: Array<{ id: string; members: string[] }>;
  };
  const sellerIds = (sellerFeed.collections ?? []).map((c) => c.id);
  assert.ok(!sellerIds.includes('launch'), 'a collection whose groups do not admit this caller is absent');
  assert.ok(sellerIds.includes('everyone'));
  assert.deepEqual((sellerFeed.collections ?? []).find((c) => c.id === 'everyone')?.members, ['acme/logo'],
    'members are narrowed to what this caller is actually being served');
});

test('a collection link may not launder a member past the MINTER\'s own exposure', async () => {
  // The curation-time rule binds the CURATOR, and `catalog.collection.manage`
  // is an admin action while `link.create` is a plain member default. So the
  // dangerous shape is a widely visible set assembled by someone who can see
  // everything in it: without a mint-time check, any member who can see the
  // COLLECTION mints a link and reads back the bytes of a member their own
  // groups are denied - exposure laundered through a list, one level up from
  // the case the PUT already refuses.
  const admin = await login('admin@test');
  assert.equal((await putCollection(admin, 'everyone', {
    name: 'For everyone', members: ['acme/logo', 'inst/hero'], groups: '*',
  })).status, 200, 'admin sees both members, so curating the set is allowed');

  const seller = await login('seller@test');
  assert.equal((await fetch(`${base}/catalog/inst/hero/png`, { headers: { cookie: seller } })).status, 403,
    'the seller is individually denied the hero: this is the access the link must not hand on');

  const refused = await mint(seller, { kind: 'share', target: { collectionId: 'everyone' } });
  assert.equal(refused.status, 403, 'the set is visible to the seller, but one of its members is not');
  const body = await refused.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'MEMBER_NOT_VISIBLE');
  assert.ok(!body.error.message.includes('inst/hero'), 'the refusal counts the unseen members and never names them');
  assert.equal((await mint(seller, { kind: 'download', target: { collectionId: 'everyone' } })).status, 403,
    'the zip is the same reach by another name');

  // The narrowed set the seller CAN see still links, and carries only what the
  // feed would have served them anyway.
  assert.equal((await putCollection(admin, 'sales-only', { name: 'Sales only', members: ['acme/logo'], groups: '*' })).status, 201);
  const ok = await mintOk(seller, { kind: 'share', target: { collectionId: 'sales-only' } });
  const page = await (await fetch(ok.path)).text();
  assert.ok(!page.includes('Campaign Hero'), 'nothing the seller could not see is on it');
  assert.match(page, /logo\.svg/);

  // And a minter who does hold the exposure is unaffected: the check is the
  // minter's own visibility, not a ban on sharing sets at all.
  const designer = await login('designer@test');
  assert.equal((await mint(designer, { kind: 'share', target: { collectionId: 'everyone' } })).status, 201);
});

test('a collection link: share serves the listing page, download serves the zip, embed is refused', async () => {
  const designer = await login('designer@test');
  assert.equal((await mint(designer, { kind: 'embed', target: { collectionId: 'launch' } })).status, 400,
    'a collection is a list, so there is nothing for an <img> to point at');
  assert.equal((await mint(designer, { kind: 'guest-edit', target: { collectionId: 'launch' } })).status, 400);
  assert.equal((await mint(designer, { kind: 'share', target: { collectionId: 'launch', assetId: 'inst/hero' } })).status, 400);
  assert.equal((await mint(await login('seller@test'), { kind: 'share', target: { collectionId: 'launch' } })).status, 403,
    'exposure is checked at mint, one level up: the minter must see the collection');
  assert.equal((await mint(designer, { kind: 'share', target: { collectionId: 'ghost' } })).status, 403);

  const share = await mintOk(designer, { kind: 'share', target: { collectionId: 'launch' } });
  // The whole point of a link: no session involved.
  const page = await fetch(share.path);
  assert.equal(page.status, 200);
  assert.match(page.headers.get('content-type') ?? '', /^text\/html/);
  assert.equal(page.headers.get('cache-control'), 'private, no-store', 'nothing a bearer page serves is CDN-cacheable');
  assert.match(page.headers.get('content-security-policy') ?? '', /default-src 'none'/);
  const html = await page.text();
  assert.match(html, /Launch kit/);
  assert.match(html, /Spring 2026\./);
  assert.match(html, /Campaign Hero\.png/);
  assert.match(html, /Summit Logo\.png/);
  assert.match(html, /logo\.svg/);
  assert.match(html, /Download all \(3\)/);
  assert.match(html, /Collection Hub/, 'the instance name is the brand chrome the sign-in gate also carries');

  const dl = await mintOk(designer, { kind: 'download', target: { collectionId: 'launch' } });
  const zipRes = await fetch(dl.path);
  assert.equal(zipRes.status, 200);
  assert.equal(zipRes.headers.get('content-type'), 'application/zip');
  assert.equal(zipRes.headers.get('content-disposition'), 'attachment; filename="Launch_kit.zip"');
  const entries = readZip(Buffer.from(await zipRes.arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['Campaign Hero.png', 'Summit Logo.png', 'logo.svg'],
    'every member, in the curator\'s order, named for the asset');
  assert.equal(entries[0]?.bytes.toString(), HERO_BYTES);
  assert.equal(entries[1]?.bytes.toString(), 'mock:dam9:a1:att1');
  assert.equal(entries[2]?.bytes.toString(), PACK_SVG);

  // The page's own Download-all button is the same signature with ?zip=1, and
  // is followed here as written rather than reconstructed, so a mis-encoded
  // signature on the page would fail the test rather than pass it.
  const zipHref = (/href="([^"]*zip=1)"/.exec(html)?.[1] ?? '').replace(/&amp;/g, '&');
  assert.ok(zipHref.startsWith(`/l/${share.id}?`), `the page offers its own archive: ${zipHref}`);
  const fromPage = await fetch(`${base}${zipHref}`);
  assert.equal(fromPage.headers.get('content-type'), 'application/zip');
  assert.equal(readZip(Buffer.from(await fromPage.arrayBuffer())).length, 3);
});

test('the boundary: a bearer reaches this collection and nothing else', async () => {
  const designer = await login('designer@test');
  const share = await mintOk(designer, { kind: 'share', target: { collectionId: 'launch' } });
  const html = await (await fetch(share.path)).text();

  // Nothing on the page addresses anything but this link.
  const hrefs = [...html.matchAll(/(?:href|src)="([^"]+)"/g)].map((m) => m[1] as string);
  for (const href of hrefs) {
    assert.ok(
      href.startsWith(`/l/${share.id}?`) || href.startsWith('/api/brand/'),
      `the page reaches only this link and the unauthenticated brand chrome, not ${href}`,
    );
  }
  assert.ok(!/\/admin|\/catalog\/|\/api\/v1\//.test(html), 'no route into the console, the feed or the API');
  assert.ok(!/<form|<input|<script/i.test(html), 'no search box, no sign-up, no script');
  assert.ok(!html.includes('everyone') && !html.includes('For everyone'), 'no other collection is named');

  // One member's bytes, addressed from the page.
  const member = await fetch(`${share.path}&asset=${encodeURIComponent('acme/logo')}`);
  assert.equal(member.status, 200);
  assert.equal(await member.text(), PACK_SVG);
  assert.equal(member.headers.get('content-disposition'), null, 'a preview serves inline');
  assert.match(member.headers.get('content-security-policy') ?? '', /sandbox/, 'linked bytes stay inert');
  const attached = await fetch(`${share.path}&asset=${encodeURIComponent('acme/logo')}&dl=1`);
  assert.equal(attached.headers.get('content-disposition'), 'attachment; filename="logo.svg"');

  // An asset the collection does not name is refused on a valid signature.
  const outside = await fetch(`${share.path}&asset=${encodeURIComponent('acme/mark')}`);
  assert.equal(outside.status, 404);
  assert.equal((await outside.json() as { error: { code: string } }).error.code, 'NOT_IN_COLLECTION');
  assert.equal((await fetch(`${share.path}&asset=${encodeURIComponent('inst/nope')}`)).status, 404);

  // And the ordinary link machinery still governs the whole thing.
  assert.equal((await fetch(`${base}/l/${share.id}?s=wrong`)).status, 403);
  assert.equal((await fetch(`${base}/api/v1/links/${share.id}/revoke`, { method: 'POST', headers: { cookie: designer } })).status, 200);
  assert.equal((await fetch(share.path)).status, 410, 'LINK_REVOKED');
});

test('a password-guarded collection link carries its password into every item and the zip', async () => {
  const designer = await login('designer@test');
  const guarded = await mintOk(designer, { kind: 'share', target: { collectionId: 'launch' }, password: 'hunter2' });
  assert.equal((await fetch(guarded.path)).status, 401, 'PASSWORD_REQUIRED');
  const opened = await fetch(`${guarded.path}&pw=hunter2`);
  assert.equal(opened.status, 200);
  const html = await opened.text();
  assert.ok(html.includes('pw=hunter2'), 'the page\'s own links stay usable rather than 401-ing one click later');
  const zip = await fetch(`${guarded.path}&pw=hunter2&zip=1`);
  assert.equal(zip.headers.get('content-type'), 'application/zip');
});

test('lifecycle governs per member at resolve: an expired or revoked asset leaves both the page and the zip', async () => {
  const designer = await login('designer@test');
  const share = await mintOk(designer, { kind: 'share', target: { collectionId: 'launch' } });
  const zipLink = await mintOk(designer, { kind: 'download', target: { collectionId: 'launch' } });

  assert.equal(readZip(Buffer.from(await (await fetch(zipLink.path)).arrayBuffer())).length, 3);

  await setLifecycle('inst/hero', { validUntil: '2020-01-01T00:00:00.000Z' });
  await setLifecycle('ext/dam9/a1', { revoke: true });

  const html = await (await fetch(share.path)).text();
  assert.ok(!html.includes('Campaign Hero'), 'an expired member is not on the page');
  assert.ok(!html.includes('Summit Logo'), 'a revoked member is not on the page');
  assert.match(html, /logo\.svg/, 'the members that are still live are');
  assert.match(html, /Download all \(1\)/);
  assert.match(html, /2 assets are no longer available/, 'the bearer is told how many, and never which');

  const entries = readZip(Buffer.from(await (await fetch(zipLink.path)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['logo.svg'], 'the archive cannot contain what the page refuses');

  // And it comes back when the window reopens - the link never changed.
  await setLifecycle('inst/hero', { validUntil: '2099-01-01T00:00:00.000Z' });
  assert.match(await (await fetch(share.path)).text(), /Campaign Hero\.png/);
  assert.equal(readZip(Buffer.from(await (await fetch(zipLink.path)).arrayBuffer())).length, 2);
});

test('deleting a collection stops its links without touching its members', async () => {
  const admin = await login('admin@test');
  await putCollection(admin, 'temp', { name: 'Temporary', members: ['acme/logo'] });
  const link = await mintOk(admin, { kind: 'share', target: { collectionId: 'temp' } });
  assert.equal((await fetch(link.path)).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/collections/temp`, { method: 'DELETE', headers: { cookie: admin } })).status, 200);
  assert.equal((await fetch(link.path)).status, 404, 'a link to a collection that is gone resolves to nothing');
  assert.equal((await fetch(`${base}/catalog/assets/acme/logo.svg`, { headers: { cookie: admin } })).status, 200,
    'the assets it listed were never owned by it');
});

test('the zip builder: safe entry names, deduped, and a real archive', async () => {
  const used = new Set<string>();
  assert.equal(safeEntryName('../../etc/passwd', used), 'etc-passwd', 'traversal cannot escape the extraction directory');
  assert.equal(safeEntryName('logo.svg', used), 'logo.svg');
  assert.equal(safeEntryName('logo.svg', used), 'logo (2).svg', 'a repeat is numbered, never silently dropped');
  assert.equal(safeEntryName('logo.svg', used), 'logo (3).svg');
  assert.equal(safeEntryName('   ', used), 'asset');

  // DEFLATE is kept only when it wins. Compressible bytes come out smaller than
  // they went in; already-compressed bytes are stored rather than inflated by a
  // pointless second pass.
  const builder = new ZipBuilder(new Date('2026-08-20T12:00:00Z'));
  const compressible = Buffer.from('lolly '.repeat(400));
  const incompressible = Buffer.from(Array.from({ length: 256 }, (_, i) => (i * 37 + 11) % 251));
  const first = builder.add('big.txt', compressible);
  const second = builder.add('noise.bin', incompressible);
  assert.ok(first.length < compressible.length, 'repetitive bytes deflate');
  assert.ok(second.length >= incompressible.length, 'incompressible bytes are stored, not grown');
  const archive = Buffer.concat([first, second, builder.end()]);
  const built = readZip(archive);
  assert.deepEqual(built.map((e) => e.name), ['big.txt', 'noise.bin']);
  assert.equal(built[0]?.bytes.toString(), compressible.toString());
  assert.deepEqual([...(built[1]?.bytes ?? [])], [...incompressible]);

  // And over HTTP, two pack files land as two named entries.
  const designer = await login('designer@test');
  const admin = await login('admin@test');
  await putCollection(admin, 'zippy', { name: 'Zippy', members: ['acme/logo', 'acme/mark'], groups: '*' });
  const link = await mintOk(designer, { kind: 'download', target: { collectionId: 'zippy' } });
  const entries = readZip(Buffer.from(await (await fetch(link.path)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['logo.svg', 'mark.svg']);
  assert.equal(entries[0]?.bytes.toString(), PACK_SVG);
  assert.equal(entries[1]?.bytes.toString(), MARK_SVG);
});

test('the bearer page renders without a brand pack, and picks up one when there is', () => {
  const bare = collectionPageHtml({
    instanceName: 'Bare Instance', name: 'Set', items: [], withheld: 0,
    zipHref: '/l/x?s=y&zip=1', expiresAt: '2026-09-01', brand: {},
  });
  assert.match(bare, /Bare Instance/);
  assert.match(bare, /Nothing in this collection is available right now\./);
  assert.ok(!bare.includes('Download all'), 'an empty set offers no archive');

  assert.equal(accentFromTokens({ color: { brand: { primary: { value: '#30BA78' } } } }), '#30BA78');
  assert.equal(accentFromTokens({ palette: { ink: '#101010' } }), '#101010', 'any hex will do when nothing is named brand');
  assert.equal(accentFromTokens({ spacing: { md: '8px' } }), undefined);
  assert.equal(accentFromTokens(null), undefined);

  const branded = collectionPageHtml({
    instanceName: 'Acme', name: 'Kit', description: 'Two things', withheld: 1,
    items: [
      { assetId: 'inst/a', name: 'Hero.png', format: 'png', sizeText: '18 B', previewHref: '/l/x?s=y&asset=inst%2Fa', downloadHref: '/l/x?s=y&asset=inst%2Fa&dl=1' },
      { assetId: 'inst/b', name: 'Deck.pdf', format: 'pdf', downloadHref: '/l/x?s=y&asset=inst%2Fb&dl=1' },
    ],
    zipHref: '/l/x?s=y&zip=1', expiresAt: '2026-09-01',
    brand: { logoLight: '/api/brand/logo/light', accent: '#30BA78', fontFamily: 'SUSE', fontUrl: '/api/brand/font/SUSE-Variable.woff2' },
  });
  assert.match(branded, /--accent:#30BA78/);
  assert.match(branded, /@font-face \{ font-family:'SUSE'/);
  assert.match(branded, /\/api\/brand\/logo\/light/);
  assert.match(branded, /<img class="thumb-img"/, 'a format a browser paints gets a preview');
  assert.match(branded, /<span class="thumb-tile">PDF<\/span>/, 'one it cannot gets a tile, not a broken image');
  assert.match(branded, /1 asset is no longer available/);
});
