// SPDX-License-Identifier: MPL-2.0
/**
 * Owner-published marks and licence records (plans/82 M4, W-M4-2).
 *
 * Pinned here: the four scopes and how narrowly each covers a file; a mark or
 * a licence record reaches only a file that records nothing of its own, and a
 * licence record answers before a mark; the composed record is the one the
 * engine's `ownerPublished()` reads, so the file travels as "Owner-published,
 * not an open licence"; the served entry never names who stated it; the
 * report shows the mark, who stated it and what it covers; a licence record
 * keeps the text as typed and reads as the engine reads it (NC recognised and
 * not interpreted); only `catalog.edit` records either; every change is
 * audited with what was there before; and withdrawing a mark returns its
 * files to held.
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
import { buildApp } from '../server/src/api/app.ts';
import {
  composeRightsRecords, loadRightsEngine, markCovers, markScopeKey, parseMarkScope, rightsAnswer, type AssetLicenceRecord, type AssetRightsMarkRecord,
} from '../server/src/catalog/rights.ts';

const OWNER = 'Owner-published, not an open licence';
const mark = (scope: string, holder = 'SUSE'): AssetRightsMarkRecord => ({ scope, holder, terms: `Published by ${holder}. Not an open licence.`, statedBy: 'usr_1', statedAt: '2026-11-07T10:00:00.000Z' });

test('scopes: four kinds, read strictly, each covering as narrowly as it says', () => {
  assert.deepEqual(parseMarkScope('folder:dam/event-photos/'), { kind: 'folder', provider: 'dam', path: 'event-photos' });
  assert.equal(markScopeKey(parseMarkScope('folder:dam//event-photos/day-2')!), 'folder:dam/event-photos/day-2');
  assert.deepEqual(parseMarkScope('provider:dam'), { kind: 'provider', provider: 'dam' });
  assert.deepEqual(parseMarkScope('prefix:suse/logo/'), { kind: 'prefix', prefix: 'suse/logo/' });
  assert.deepEqual(parseMarkScope('asset:ext/dam/a1'), { kind: 'asset', id: 'ext/dam/a1' });
  for (const bad of ['folder:dam/', 'folder:dam/../x', 'prefix:suse/logo', 'prefix:ext/dam/', 'prefix:inst/', 'collection:launch', 'provider:', 'asset:../x', 42]) {
    assert.equal(parseMarkScope(bad), null, String(bad));
  }
  const photo = { id: 'ext/dam/e3', meta: { providerFolder: 'event-photos/day-2' } };
  const ranks = ['asset:ext/dam/e3', 'folder:dam/event-photos/day-2', 'folder:dam/event-photos', 'provider:dam'].map((s) => markCovers(parseMarkScope(s)!, photo));
  assert.ok(ranks.every((r, i) => r > 0 && (i === 0 || r < ranks[i - 1]!)), 'one file, then the deeper folder, then the folder, then the provider');
  assert.equal(markCovers(parseMarkScope('folder:dam/event')!, { id: 'ext/dam/x', meta: { providerFolder: 'event-photos' } }), 0, 'a sibling with the same start is not below');
  assert.equal(markCovers(parseMarkScope('prefix:suse/')!, { id: 'suse/logo/a' }) > 0, true);
  assert.equal(markCovers(parseMarkScope('provider:dam')!, { id: 'ext/other/a' }), 0);
});

test('composition: only a blank declaration inherits, a licence record answers first, and the engine reads the result', async () => {
  const engine = await loadRightsEngine();
  const marks = [mark('provider:dam', 'Whole DAM'), mark('folder:dam/event-photos', 'SUSE'), mark('prefix:acme/', 'Acme')];
  const licences: AssetLicenceRecord[] = [{ assetId: 'ext/dam/e2', declaration: 'CC BY-NC 4.0', attribution: 'Photo by A. Person', recordedBy: 'usr_1', recordedAt: 'x' }];
  const entries = [
    { id: 'ext/dam/e1', meta: { providerFolder: 'event-photos' } },
    { id: 'ext/dam/e2', meta: { providerFolder: 'event-photos' } },
    { id: 'ext/dam/s1', meta: { providerFolder: 'stock' } },
    { id: 'acme/photo/open', license: 'CC-BY-4.0' },
    { id: 'acme/logo/unrecorded' },
    { id: 'acme/logo/own', rights: { works: [{ id: 'acme/logo/own', creators: [{ name: 'Acme', role: 'owner' }], rights: [{ declaration: 'LicenseRef-Acme-Marks', assertedBy: 'catalog', evidence: 'catalog-entry', status: 'unparsed' }], grants: [{ kind: 'own-work', scope: 'Acme terms', asserted: true }] }] } },
  ];
  const out = composeRightsRecords(engine, entries, marks, licences);
  const answer = (id: string) => rightsAnswer(engine, out.find((e) => e.id === id)!);

  const e1 = answer('ext/dam/e1');
  assert.ok(e1.state === 'travels' && e1.licence === OWNER && e1.owner?.holder === 'SUSE', 'the folder mark, narrower than the provider one');
  assert.ok(e1.state === 'travels' && e1.declared === 'LicenseRef-Owner-Published');
  const e2 = answer('ext/dam/e2');
  assert.ok(e2.state === 'held' && e2.category === 'not-interpreted', 'a licence record beats a mark, and NC stays recognised and not interpreted');
  assert.equal(out.find((e) => e.id === 'ext/dam/e2')!.license, 'CC BY-NC 4.0', 'the text as typed');
  assert.equal(out.find((e) => e.id === 'ext/dam/e2')!.attribution, 'Photo by A. Person');
  const s1 = answer('ext/dam/s1');
  assert.ok(s1.state === 'travels' && s1.owner?.holder === 'Whole DAM');
  assert.equal(out.find((e) => e.id === 'acme/photo/open'), entries[3], 'a recorded licence is never overridden');
  assert.ok(answer('acme/logo/unrecorded').state === 'travels');
  assert.equal(out.find((e) => e.id === 'acme/logo/own'), entries[5], 'a pack own-work record stays as written');
  assert.ok(!JSON.stringify(out).includes('usr_1'), 'a composed entry never names who stated the mark');
  assert.equal(composeRightsRecords(engine, entries, [], []), entries, 'no marks and no records: the same array back');
});

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const photo = (remoteId: string, folder: string) => ({
  remoteId, name: `${folder} ${remoteId}`, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'jpg', remoteRef: 'f', size: 8 }],
});
const PACK = [
  { id: 'acme/tokens', name: 'Acme tokens', type: 'tokens' },
  { id: 'acme/photo/open', name: 'Open photo', type: 'raster', license: 'CC-BY-4.0' },
  { id: 'acme/logo/mark', name: 'Acme mark', type: 'vector' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rights-marks-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', `${a.id.split('/').pop()}.bin`), 'x');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map((a) => ({ ...a, formats: [{ format: 'bin', url: `/catalog/assets/acme/${a.id.split('/').pop()}.bin` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sm', link: 'lm', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('bruno@test');
  const created = await call(admin, 'POST', '/api/v1/catalog/providers', {
    id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] },
    options: { assets: [photo('e1', 'event-photos'), photo('e2', 'event-photos'), photo('e3', 'event-photos/day-2'), photo('s1', 'stock'), photo('s2', 'stock')] },
  });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'event-photos' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'stock' })).status, 201);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const feed = async (email: string) => (await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: await login(email) } })).json()) as { assets: Array<Record<string, any>> };
const report = async () => (await call(await login('bruno@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).body;

test('a folder mark: stated once, composed onto every file below it, shown with who stated it', async () => {
  const bruno = await login('bruno@test');
  const before = await report();
  const row0 = before.sources.find((s: { label: string }) => s.label === 'Brandfolder / event-photos');
  assert.equal(row0.markScope, 'folder:dam/event-photos', 'the row says what "These are ours" records');
  assert.equal(row0.held.count, 3);

  const defaults = (await call(bruno, 'GET', '/api/v1/catalog/rights/marks')).body.defaults;
  assert.deepEqual(defaults, { holder: 'SUSE', terms: 'Published by SUSE for the people and partner programmes of this workspace to use in their work. Not an open licence.' });

  const put = await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'folder:dam/event-photos', note: 'shot by our photo team' });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  assert.equal(put.body.mark.holder, 'SUSE', 'the holder is prefilled with the workspace name');
  assert.equal(put.body.mark.terms, defaults.terms);
  assert.deepEqual(put.body.covered, { now: 3, atStatement: 3 });
  assert.match(put.body.statement, /^Recorded as SUSE's own statement by Bruno Marsh on \d{1,2} \w{3} \d{4}\. Lolly does not check ownership\.$/);

  const rita = await feed('rita@northwind.test');
  const e1 = rita.assets.find((a) => a.id === 'ext/dam/e1')!;
  assert.deepEqual(e1.rights.works[0].creators, [{ name: 'SUSE', role: 'owner' }]);
  assert.equal(e1.rights.works[0].rights[0].declaration, 'LicenseRef-Owner-Published');
  assert.equal(e1.rights.works[0].grants[0].scope, defaults.terms);
  assert.ok(!JSON.stringify(rita).includes('Bruno') && !JSON.stringify(rita).includes('statedBy'), 'the app wire never says who stated a mark');
  assert.ok((await feed('staff@test')).assets.find((a) => a.id === 'ext/dam/e3')!.rights, 'every caller reads the same record');
  assert.equal(rita.assets.find((a) => a.id === 'ext/dam/s1')!.rights, undefined, 'a folder not marked stays as it was');

  const after = await report();
  const row = after.sources.find((s: { label: string }) => s.label === 'Brandfolder / event-photos');
  assert.deepEqual(row.travel.byLicence, [{ licence: OWNER, count: 3 }]);
  assert.equal(row.held.count, 0);
  assert.equal(row.mark.statedBy.name, 'Bruno Marsh');
  assert.deepEqual(row.mark.covered, { now: 3, atStatement: 3 });
  assert.equal(row.mark.note, 'shot by our photo team');

  const audit = (await store.listAudit()).filter((e) => e.action === 'catalog.rights.mark').at(-1)!;
  assert.deepEqual(audit.payload, { scope: 'folder:dam/event-photos', holder: 'SUSE', terms: defaults.terms, note: 'shot by our photo team', covered: 3 });

  const edit = await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'folder:dam/event-photos/', holder: 'SUSE Software Solutions', terms: 'Ours. Not an open licence.' });
  assert.equal(edit.status, 200, 'the same scope, written another way, is the same mark');
  const edited = (await store.listAudit()).filter((e) => e.action === 'catalog.rights.mark').at(-1)!;
  assert.deepEqual((edited.payload as { before: unknown }).before, { holder: 'SUSE', terms: defaults.terms, note: 'shot by our photo team' });
});

test('a licence record: the text as typed, read as the engine reads it, never over a file\'s own record', async () => {
  const bruno = await login('bruno@test');
  const put = await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'ext/dam/s1', declaration: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person', note: 'the photographer agreed by email, ref 2026-114' });
  assert.equal(put.status, 201, JSON.stringify(put.body));
  assert.deepEqual(put.body.reads, { travels: false, licence: 'CC BY-NC 4.0', category: 'not-interpreted', reason: 'CC-BY-NC-4.0 is recorded and not yet interpreted', conditions: ['Attribution', 'NonCommercial'] });
  assert.match(put.body.statement, /^Recorded by Bruno Marsh on .+ as this workspace's own record of the licence\. Lolly does not check the licence\.$/);
  assert.doesNotMatch(JSON.stringify(put.body), /verified|cleared/i);

  const s1 = (await feed('rita@northwind.test')).assets.find((a) => a.id === 'ext/dam/s1')!;
  assert.equal(s1.license, 'CC-BY-NC-4.0');
  assert.equal(s1.attribution, 'Photo by A. Person');
  const stock = (await report()).sources.find((s: { label: string }) => s.label === 'Brandfolder / stock');
  assert.deepEqual(stock.held.byReason.map((r: { category: string; count: number }) => [r.category, r.count]).sort(), [['not-interpreted', 1], ['not-recorded', 1]]);

  const own = await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'acme/photo/open', declaration: 'MIT' });
  assert.equal(own.status, 409, 'a file\'s own record is never overwritten');
  assert.equal(own.body.error.code, 'LICENCE_RECORDED');
  const ownMark = await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'asset:acme/photo/open' });
  assert.equal(ownMark.status, 409, 'nor replaced by a mark');

  const change = await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'ext/dam/s1', declaration: 'CC BY 4.0' });
  assert.equal(change.status, 200);
  const row = (await store.listAudit()).filter((e) => e.action === 'catalog.rights.licence').at(-1)!;
  assert.deepEqual((row.payload as { before: unknown }).before, { declaration: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person', note: 'the photographer agreed by email, ref 2026-114' });
  assert.equal((await call(bruno, 'DELETE', '/api/v1/catalog/rights/licences?assetId=ext/dam/s1')).status, 200);
  assert.equal((await feed('rita@northwind.test')).assets.find((a) => a.id === 'ext/dam/s1')!.license, undefined);
  assert.equal((await store.listAudit()).filter((e) => e.action === 'catalog.rights.licence.remove').length, 1);
});

test('refusals: a bad scope, a provider that is not there, a scope that covers nothing, and anyone without catalog.edit', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'collection:launch-kit' })).status, 400);
  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'provider:nope' })).status, 404);
  const nothing = await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'folder:dam/not-a-folder' });
  assert.equal(nothing.status, 404);
  assert.equal(nothing.body.error.code, 'NOTHING_COVERED');
  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'prefix:acme/', terms: 'x'.repeat(1025) })).status, 400);
  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'ext/dam/nope', declaration: 'MIT' })).status, 404);
  for (const who of ['staff@test', 'rita@northwind.test']) {
    const cookie = await login(who);
    assert.equal((await call(cookie, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'prefix:acme/' })).status, 403, who);
    assert.equal((await call(cookie, 'GET', '/api/v1/catalog/rights/marks')).status, 403, who);
    assert.equal((await call(cookie, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'acme/logo/mark', declaration: 'MIT' })).status, 403, who);
  }
});

test('withdrawing a mark returns its files to what they record themselves', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'DELETE', '/api/v1/catalog/rights/marks?scope=folder:dam/event-photos')).status, 200);
  assert.equal((await call(bruno, 'DELETE', '/api/v1/catalog/rights/marks?scope=folder:dam/event-photos')).status, 404);
  assert.equal((await feed('rita@northwind.test')).assets.find((a) => a.id === 'ext/dam/e1')!.rights, undefined);
  const row = (await report()).sources.find((s: { label: string }) => s.label === 'Brandfolder / event-photos');
  assert.equal(row.held.count, 3);
  assert.equal(row.mark, undefined);
  const unmark = (await store.listAudit()).filter((e) => e.action === 'catalog.rights.unmark').at(-1)!;
  assert.equal((unmark.payload as { before: { holder: string } }).before.holder, 'SUSE Software Solutions');
  assert.deepEqual((await call(bruno, 'GET', '/api/v1/catalog/rights/marks')).body.marks, []);
});
