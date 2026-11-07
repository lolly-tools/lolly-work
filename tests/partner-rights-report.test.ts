// SPDX-License-Identifier: MPL-2.0
/**
 * The licence report for a partner programme (plans/82 M4, W-M4-1).
 *
 * Pinned here: each file's answer comes from the engine's `redistribution()`
 * (the rule the app's `.lolly` builder asks), sorted into the report's
 * categories with the engine's own reason kept beside each; NC and ND are
 * recognised and never interpreted; a licence expression is held as not
 * recognised and explained; the design system, the brand team's published
 * files and a company's own files are exempt; the report counts by source
 * (provider folder, collection and so on) over the programme's feed with every
 * company in it; staff links that would lose files are counted; only
 * `programme.manage` reads the report; and reading it changes nothing a
 * partner or a member of staff receives.
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
import { HELD_LABEL, loadRightsEngine, rightsAnswer, RIGHTS_EXEMPT_TYPES } from '../server/src/catalog/rights.ts';

const TERMS = 'Published by Acme for the people and partner programmes of this workspace to use in their work. Not an open licence.';
const ownWork = (edit: Record<string, unknown> = {}) => ({
  works: [{
    id: 'acme/logo', creators: [{ name: 'Acme', role: 'owner' }],
    rights: [{ declaration: 'LicenseRef-Owner-Published', assertedBy: 'catalog', evidence: 'catalog-entry', status: 'unparsed' }],
    grants: [{ kind: 'own-work', scope: TERMS, asserted: true }],
    ...edit,
  }],
});

test('each answer comes from the engine and is sorted into the report categories', async () => {
  const engine = await loadRightsEngine();
  const answer = (entry: Record<string, unknown>, companies?: Set<string>) => rightsAnswer(engine, { id: 'x/y', ...entry }, companies);

  const open = answer({ license: 'CC-BY-4.0' });
  assert.equal(open.state, 'travels');
  assert.equal(open.state === 'travels' && open.licence, 'CC BY 4.0');

  const blank = answer({});
  assert.equal(blank.state, 'held');
  assert.equal(blank.state === 'held' && blank.category, 'not-recorded');
  assert.equal(blank.state === 'held' && blank.reason, 'licence not recorded', 'the engine\'s own sentence travels unchanged');

  const nc = answer({ license: 'CC-BY-NC-4.0' });
  assert.ok(nc.state === 'held' && nc.category === 'not-interpreted');
  assert.deepEqual(nc.state === 'held' && nc.conditions, ['Attribution', 'NonCommercial'], 'NC is recognised and its conditions recorded');
  assert.equal(nc.state === 'held' && nc.licence, 'CC BY-NC 4.0');
  assert.match(nc.state === 'held' ? nc.reason : '', /not yet interpreted/);
  const nd = answer({ license: 'CC BY-ND 4.0' });
  assert.ok(nd.state === 'held' && nd.category === 'not-interpreted', 'ND is never auto-passed or auto-banned either');

  const ref = answer({ license: 'LicenseRef-Acme-Proprietary' });
  assert.ok(ref.state === 'held' && ref.category === 'identifier');

  const or = answer({ license: 'MIT OR Apache-2.0' });
  assert.ok(or.state === 'held' && or.category === 'not-recognised');
  assert.equal(or.state === 'held' && or.detail, 'a choice of licences the rights holder offered, none selected');
  assert.equal(or.state === 'held' && or.declared, 'MIT OR Apache-2.0', 'the original text is kept');
  const and = answer({ license: 'MIT AND CC-BY-4.0' });
  assert.equal(and.state === 'held' && and.detail, 'cumulative; these rules record both and read neither as one');
  const prose = answer({ license: 'free for our partners' });
  assert.ok(prose.state === 'held' && prose.category === 'not-recognised' && !prose.detail);

  const owner = answer({ rights: ownWork() });
  assert.equal(owner.state, 'travels');
  assert.equal(owner.state === 'travels' && owner.licence, 'Owner-published, not an open licence');
  assert.deepEqual(owner.state === 'travels' && owner.owner, { holder: 'Acme', terms: TERMS });
  const partial = answer({ rights: ownWork({ grants: [{ kind: 'own-work', scope: '', asserted: true }] }) });
  assert.ok(partial.state === 'held' && partial.category === 'own-work-incomplete');

  for (const type of RIGHTS_EXEMPT_TYPES) assert.equal(answer({ type }).state, 'exempt', type);
  assert.deepEqual(answer({ type: 'tokens' }), { state: 'exempt', why: 'design-system' });
  assert.deepEqual(answer({ type: 'template' }), { state: 'exempt', why: 'published-by-brand-team' });
  assert.deepEqual(answer({ meta: { company: 'northwind' } }, new Set(['northwind'])), { state: 'exempt', why: 'company-own' });
  assert.equal(answer({ meta: { company: 'northwind' } }, new Set(['globex'])).state, 'held', 'a company\'s own file is exempt for that company only');
  assert.equal(answer({ meta: { company: 'northwind' } }).state, 'held', 'and a bearer link has no company');

  for (const label of Object.values(HELD_LABEL)) {
    assert.doesNotMatch(label, /cleared|verified|legally safe|royalty-free/i);
  }
});

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const photo = (remoteId: string, folder: string) => ({
  remoteId, name: `${folder} ${remoteId}`, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'jpg', remoteRef: 'f', size: 8 }],
});
const PROVIDER_ASSETS = [photo('e1', 'event-photos'), photo('e2', 'event-photos'), photo('e3', 'event-photos/day-2'), photo('s1', 'stock'), photo('s2', 'stock'), photo('i1', 'internal')];
const PACK = [
  { id: 'acme/tokens', name: 'Acme tokens', type: 'tokens' },
  { id: 'acme/font', name: 'Acme Sans', type: 'font' },
  { id: 'acme/photo/sponsored', name: 'Sponsored photo', type: 'raster', license: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person' },
  { id: 'acme/photo/open', name: 'Open photo', type: 'raster', license: 'CC-BY-4.0', attribution: 'Photo by B. Person' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rights-report-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', `${a.id.split('/').pop()}.bin`), 'x');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map((a) => ({ ...a, formats: [{ format: 'bin', url: `/catalog/assets/acme/${a.id.split('/').pop()}.bin` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sr', link: 'lr', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const created = await call(admin, 'POST', '/api/v1/catalog/providers', { id: 'dam', kind: 'mock', label: 'Brandfolder', options: { assets: PROVIDER_ASSETS }, exposure: { groups: ['marketing'] } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'event-photos' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'stock', company: 'northwind-it' })).status, 201);
  await store.putCollection({
    id: 'launch-kit', name: 'Launch kit', members: ['acme/photo/sponsored', 'acme/photo/open'], groups: ['programme-resellers-emea', 'marketing'],
    curator: 'user:x', createdAt: 'x', updatedAt: 'x',
  });
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
const feedIds = async (email: string) => {
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: await login(email) } })).json() as { assets: Array<{ id: string }> };
  return feed.assets.map((a) => a.id).sort();
};

test('the report counts the programme\'s feed by source, every company in it included', async () => {
  const before = { rita: await feedIds('rita@northwind.test'), staff: await feedIds('staff@test') };
  const r = await call(await login('admin@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report');
  assert.equal(r.status, 200, JSON.stringify(r.body));
  const report = r.body;
  assert.equal(report.programme.name, 'Resellers, EMEA');
  assert.match(report.rules, /^rights-rules-/);
  assert.deepEqual(report.totals, { assets: 9, travel: 1, held: 6, exempt: 2, sharedAnyway: 0, needsChoosing: 0 });

  const row = (label: string) => report.sources.find((s: { label: string }) => s.label === label);
  const events = row('Brandfolder / event-photos');
  assert.ok(events, JSON.stringify(report.sources.map((s: { label: string }) => s.label)));
  assert.equal(events.kind, 'folder');
  assert.deepEqual(events.provider, { id: 'dam', label: 'Brandfolder' });
  assert.equal(events.path, 'event-photos');
  assert.equal(events.assets, 3, 'everything below the folder counts');
  assert.deepEqual(events.held.byReason, [{ category: 'not-recorded', label: 'licence not recorded', count: 3 }]);
  assert.equal(events.heldFiles.length, 3);

  const stock = row('Brandfolder / stock');
  assert.equal(stock.assets, 2, 'a company\'s folder is in the programme\'s report');

  const kit = row('Launch kit');
  assert.equal(kit.kind, 'collection');
  assert.deepEqual(kit.travel.byLicence, [{ licence: 'CC BY 4.0', count: 1 }]);
  assert.deepEqual(kit.held.byReason, [{ category: 'not-interpreted', label: 'conditions recorded and not interpreted', count: 1 }]);
  assert.deepEqual(kit.heldFiles[0], {
    id: 'acme/photo/sponsored', name: 'Sponsored photo', licence: 'CC BY-NC 4.0', declared: 'CC-BY-NC-4.0', category: 'not-interpreted',
    reason: 'CC-BY-NC-4.0 is recorded and not yet interpreted', conditions: ['Attribution', 'NonCommercial'],
  });

  const design = row('Design system: tokens, fonts and palettes');
  assert.equal(design.exempt, 2);
  assert.ok(!report.sources.some((s: { heldFiles: Array<{ id: string }> }) => s.heldFiles.some((f) => f.id === 'ext/dam/i1')), 'a folder not given is not in the report');
  assert.deepEqual(report.links, { count: 0, files: 0, links: [], more: 0 });

  assert.deepEqual(await feedIds('rita@northwind.test'), before.rita, 'reading the report changes nothing a partner receives');
  assert.deepEqual(await feedIds('staff@test'), before.staff, 'nor anything staff receive');
  assert.ok(before.rita.includes('ext/dam/s1'), 'with no gate on, unrecorded files still reach the partner');
});

test('links made by staff that would lose files are counted; partner links and open files are not', async () => {
  const staff = await login('staff@test');
  const kitLink = await call(staff, 'POST', '/api/v1/links', { kind: 'download', target: { collectionId: 'launch-kit' } });
  assert.equal(kitLink.status, 201, JSON.stringify(kitLink.body));
  const openLink = await call(staff, 'POST', '/api/v1/links', { kind: 'share', target: { assetId: 'acme/photo/open' } });
  assert.equal(openLink.status, 201);
  const stockLink = await call(staff, 'POST', '/api/v1/links', { kind: 'share', target: { assetId: 'ext/dam/s1' } });
  assert.equal(stockLink.status, 201);
  const ritaLink = await call(await login('rita@northwind.test'), 'POST', '/api/v1/links', { kind: 'share', target: { assetId: 'ext/dam/s2' } });
  assert.equal(ritaLink.status, 201, JSON.stringify(ritaLink.body));

  const report = (await call(await login('admin@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).body;
  assert.equal(report.links.count, 2);
  assert.equal(report.links.files, 2);
  const byTarget = Object.fromEntries(report.links.links.map((l: { target: { id: string }; held: number; files: number }) => [l.target.id, [l.held, l.files]]));
  assert.deepEqual(byTarget, { 'launch-kit': [1, 2], 'ext/dam/s1': [1, 1] });
  assert.equal(report.links.links[0].createdBy.name.length > 0, true);
});

test('only programme.manage reads the report', async () => {
  assert.equal((await call(await login('staff@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).status, 403);
  assert.equal((await call(await login('rita@northwind.test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).status, 403);
  assert.equal((await call(await login('admin@test'), 'GET', '/api/v1/programmes/nobody/rights-report')).status, 404);
});
