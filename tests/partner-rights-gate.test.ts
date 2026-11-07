// SPDX-License-Identifier: MPL-2.0
/**
 * The licence gate (plans/82 M4, W-M4-4).
 *
 * Pinned here, with the gate on: a partner's feed, the file bytes, browse and
 * search keep only what may travel (an owner-published mark, a licence that
 * lets the bytes be passed on, the exempt design system, brand skills and
 * published files, or a share anyway choice for their audience); a partner
 * cannot put a held file in a link; a link staff made leaves a held file out
 * of its page, its one-file route and its ZIP unless its minter chose to send
 * it, and never counts it as gone; a mark withdrawn takes a file out of a live
 * link on the next visit; staff get the same feed bytes with the gate on or
 * off; and `report` changes nothing a partner receives.
 *
 * Also pinned: the mode. Configuration wins; otherwise the default the
 * instance recorded once answers: `report` for a database that already held
 * accounts, `gate` for an empty one, and neither moves afterwards, whatever
 * a re-applied template or later accounts say. A memory store answers
 * `report`.
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
import { decidePartnerRightsDefault, partnerRightsState, type InstanceDefaultRecord } from '../server/src/catalog/rights-mode.ts';
import { RIGHTS_EXEMPT_TYPES } from '../server/src/programmes/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const ENGINE_SPEC: string = '@lolly/engine';
const readZip = async (bytes: Uint8Array): Promise<Array<{ name: string; bytes: Uint8Array }>> =>
  ((await import(ENGINE_SPEC)) as { readZip: (b: Uint8Array) => Array<{ name: string; bytes: Uint8Array }> }).readZip(bytes);

/** A store as the decision sees it: what was recorded, and whether accounts exist. */
function fakeStore(accounts: boolean) {
  let row: InstanceDefaultRecord | null = null;
  const store = {
    accounts,
    async getInstanceDefault() { return row; },
    async recordInstanceDefault(rec: InstanceDefaultRecord) { row ??= rec; return row; },
    async hasAccounts() { return store.accounts; },
  };
  return store;
}
const cfg = (partnerRights?: 'report' | 'gate') => ({ policy: { catalog: { versionKeep: 0, ...(partnerRights ? { partnerRights } : {}) } } }) as never;

test('the mode: decided once from the accounts, never moved after, and configuration always wins', async () => {
  const upgraded = fakeStore(true);
  const first = await decidePartnerRightsDefault(upgraded);
  assert.deepEqual([first.value, first.why], ['report', 'upgrade-with-accounts']);
  upgraded.accounts = false;
  assert.equal((await decidePartnerRightsDefault(upgraded)).value, 'report', 'a later start, or a re-applied template, never flips an upgrade');
  assert.equal(partnerRightsState(cfg(), first).line, 'Report only: decided when this instance upgraded with accounts already in it. Set policy.catalog.partnerRights to change it.');

  const fresh = fakeStore(false);
  const decided = await decidePartnerRightsDefault(fresh);
  assert.deepEqual([decided.value, decided.why], ['gate', 'fresh-install']);
  fresh.accounts = true;
  assert.equal((await decidePartnerRightsDefault(fresh)).value, 'gate', 'accounts arriving later change nothing');
  assert.deepEqual(partnerRightsState(cfg(), decided), { mode: 'gate', source: 'fresh-install', decidedAt: decided.decidedAt, line: 'Gate: decided at a fresh install. Set policy.catalog.partnerRights to change it.' });

  assert.deepEqual(partnerRightsState(cfg('report'), decided), { mode: 'report', source: 'config', line: 'Report only: set in configuration (policy.catalog.partnerRights).' });
  assert.equal(partnerRightsState(cfg('gate'), first).mode, 'gate');

  const memory = createMemoryStore();
  const recorded = await decidePartnerRightsDefault(memory);
  assert.equal(partnerRightsState(cfg(), recorded).mode, 'report', 'a memory store answers report');
  assert.equal(partnerRightsState(cfg(), recorded).source, 'memory-store');
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('on Postgres: an empty database records gate, one with accounts records report, and neither moves', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl as string, async (pg) => {
    assert.equal((await decidePartnerRightsDefault(pg)).value, 'gate', 'a fresh install');
    await pg.upsertUserBySub({ sub: 'dev:first@test', email: 'first@test', groups: [], role: 'owner' });
    assert.equal((await decidePartnerRightsDefault(pg)).value, 'gate', 'the first sign-in changes nothing');
  });
  await withFreshPostgres(pgUrl as string, async (pg) => {
    await pg.upsertUserBySub({ sub: 'dev:old@test', email: 'old@test', groups: [], role: 'owner' });
    const decided = await decidePartnerRightsDefault(pg);
    assert.deepEqual([decided.value, decided.why], ['report', 'upgrade-with-accounts'], 'an upgrade with accounts in it');
    // A re-applied template is a restart with no partnerRights in the config.
    assert.equal(partnerRightsState(cfg(), await pg.getInstanceDefault('catalog.partnerRights')).mode, 'report');
    assert.equal(partnerRightsState(cfg('gate'), await pg.getInstanceDefault('catalog.partnerRights')).mode, 'gate', 'the line in config wins');
  });
});

test('brand skills join the exempt types, beside the design system and published files', () => {
  for (const type of ['tokens', 'font', 'palette', 'template', 'rules-tool', 'user-tool', 'skill']) assert.ok(RIGHTS_EXEMPT_TYPES.has(type), type);
  assert.ok(!RIGHTS_EXEMPT_TYPES.has('raster') && !RIGHTS_EXEMPT_TYPES.has('vector'));
});

const photo = (remoteId: string, folder: string) => ({
  remoteId, name: `${folder} ${remoteId}`, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'jpg', remoteRef: 'f', size: 8 }],
});
const PACK = [
  { id: 'acme/tokens', name: 'Acme tokens', type: 'tokens', file: 'tokens.json' },
  { id: 'acme/font', name: 'Acme Sans', type: 'font', file: 'sans.woff2' },
  { id: 'acme/skill/voice', name: 'Acme voice skill', type: 'skill', file: 'voice.md' },
  { id: 'acme/photo/open', name: 'Open photo', type: 'raster', file: 'open.jpg', license: 'CC-BY-4.0', attribution: 'Photo by B. Person' },
  { id: 'acme/photo/sponsored', name: 'Sponsored photo', type: 'raster', file: 'sponsored.jpg', license: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person' },
  { id: 'acme/photo/unrecorded', name: 'Unrecorded photo', type: 'raster', file: 'unrecorded.jpg' },
];

let store: ReturnType<typeof createMemoryStore>;
const servers: Server[] = [];
let gate = '';
let report = '';

async function start(partnerRights: 'report' | 'gate' | undefined, pack: string): Promise<string> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SUSE', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    ...(partnerRights ? { policy: { catalog: { partnerRights } } } : {}),
    dev: { enabled: true, users: [
      { email: 'bruno@test', groups: ['admin'], name: 'Bruno Marsh' },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sg', link: 'lg', credential: 'a-32-byte-or-longer-master-secret!' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  servers.push(server);
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rights-gate-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), `${a.id}-bytes`);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map(({ file, ...a }) => ({ ...a, formats: [{ format: file.split('.').pop(), url: `/catalog/assets/acme/${file}` }] })),
  }));
  store = createMemoryStore();
  gate = await start('gate', pack);
  report = await start(undefined, pack);

  const admin = await login(gate, 'bruno@test');
  assert.ok([200, 201].includes((await call(gate, admin, 'POST', '/api/v1/catalog/providers', {
    id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] },
    options: { assets: [photo('e1', 'event-photos'), photo('e2', 'event-photos'), photo('s1', 'stock')] },
  })).status));
  assert.equal((await call(gate, await login(gate, 'owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(gate, admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  assert.equal((await call(gate, admin, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  await login(gate, 'rita@northwind.test');
  assert.equal((await call(gate, admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  for (const path of ['event-photos', 'stock']) assert.equal((await call(gate, admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path })).status, 201);
  await store.putCollection({
    id: 'brand-guidance', name: 'Brand guidance', members: ['acme/skill/voice'], groups: ['programme-resellers-emea'], curator: 'user:x', createdAt: 'x', updatedAt: 'x',
  });
  await store.putCollection({
    id: 'launch-kit', name: 'Launch kit', members: ['acme/photo/open', 'acme/photo/sponsored', 'acme/photo/unrecorded'], groups: ['programme-resellers-emea', 'marketing'],
    curator: 'user:x', createdAt: 'x', updatedAt: 'x',
  });
});

after(() => { for (const s of servers) s.close(); });

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(base: string, cookie: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
}
const feedIds = async (base: string, email: string) => {
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: await login(base, email) } })).json() as { assets: Array<{ id: string }> };
  return feed.assets.map((a) => a.id).sort();
};
const mint = async (body: Record<string, unknown>, email = 'staff@test') => {
  const res = await call(gate, await login(gate, email), 'POST', '/api/v1/links', body);
  return { ...res, path: typeof res.body?.url === 'string' ? res.body.url.replace('http://localhost', gate) : '' };
};

test('with the gate on, a partner receives only what may travel', async () => {
  assert.deepEqual(await feedIds(gate, 'rita@northwind.test'), ['acme/font', 'acme/photo/open', 'acme/skill/voice', 'acme/tokens'],
    'the open photo, the design system and the brand skill; no unrecorded file, no NC photo');
  assert.deepEqual((await feedIds(report, 'rita@northwind.test')).filter((id) => id.startsWith('ext/')), ['ext/dam/e1', 'ext/dam/e2', 'ext/dam/s1'],
    'report changes nothing a partner receives');

  const rita = await login(gate, 'rita@northwind.test');
  assert.notEqual((await fetch(`${gate}/catalog/ext/dam/e1/f`, { headers: { cookie: rita } })).status, 200, 'held bytes do not serve');
  const browse = await call(gate, rita, 'GET', '/api/v1/catalog/assets?limit=100');
  assert.ok(!JSON.stringify(browse.body).includes('ext/dam/e1'), 'browse keeps to the gated feed');
  const search = await call(gate, rita, 'GET', '/api/v1/catalog/search?q=event');
  assert.ok(!(search.body.results ?? []).some((r: { id: string }) => r.id.startsWith('ext/dam/')), 'and so does search');
  const refused = await mint({ kind: 'share', target: { collectionId: 'launch-kit' } }, 'rita@northwind.test');
  assert.equal(refused.status, 403, 'a partner cannot put a held file in a link');
  assert.equal(refused.body.error.code, 'MEMBER_NOT_VISIBLE');
});

test('a mark, a licence that travels and a share anyway choice each let a file through, for that audience only', async () => {
  const bruno = await login(gate, 'bruno@test');
  assert.equal((await call(gate, bruno, 'PUT', '/api/v1/catalog/rights/marks', { scope: 'folder:dam/event-photos' })).status, 201);
  assert.equal((await call(gate, bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['acme/photo/sponsored'], company: 'northwind-it' })).status, 200);
  const ids = await feedIds(gate, 'rita@northwind.test');
  for (const id of ['ext/dam/e1', 'ext/dam/e2', 'acme/photo/sponsored']) assert.ok(ids.includes(id), id);
  for (const id of ['ext/dam/s1', 'acme/photo/unrecorded']) assert.ok(!ids.includes(id), id);
  assert.equal((await fetch(`${gate}/catalog/ext/dam/e1/f`, { headers: { cookie: await login(gate, 'rita@northwind.test') } })).status, 200);

  const r = (await call(gate, bruno, 'GET', '/api/v1/programmes/resellers-emea/rights-report')).body;
  assert.equal(r.mode.mode, 'gate');
  assert.equal(r.mode.line, 'Gate: set in configuration (policy.catalog.partnerRights).');
  assert.equal(r.totals.held, 2, 'the report still counts what the gate holds back');
  assert.equal(r.limits.collectionZipBytes, 2 * 1024 * 1024 * 1024);
  assert.equal(r.limits.collectionMembers, 500);

  const preview = (await call(gate, bruno, 'GET', '/api/v1/org-config/preview?groups=programme-resellers-emea,company-northwind-it,partner')).body.preview;
  assert.deepEqual([preview.assets.licence.heldBack, preview.assets.licence.sharedAnyway], [2, 1]);
  assert.equal(preview.assets.licence.shared[0].chosenBy, 'Bruno Marsh');
  const orgConfig = (await call(gate, await login(gate, 'rita@northwind.test'), 'GET', '/api/v1/org-config')).body;
  assert.ok(!JSON.stringify(orgConfig).includes('Bruno'), 'a partner is told nothing about choices');
});

test('a link staff made leaves held files out unless its minter chose them, and never counts them as gone', async () => {
  const plain = await mint({ kind: 'share', target: { collectionId: 'launch-kit' } });
  assert.equal(plain.status, 201);
  const page = await (await fetch(plain.path)).text();
  assert.match(page, /open\.jpg/);
  assert.doesNotMatch(page, /sponsored\.jpg|unrecorded\.jpg/);
  assert.doesNotMatch(page, /no longer available/, 'a held file was never offered, so it is never counted');
  const one = await fetch(`${plain.path}&asset=${encodeURIComponent('acme/photo/sponsored')}&dl=1`);
  assert.equal(one.status, 404);
  const zip = await readZip(new Uint8Array(await (await fetch(`${plain.path}&zip=1`)).arrayBuffer()));
  assert.deepEqual(zip.map((e) => e.name), ['CREDITS.txt', 'credits.json', 'open.jpg']);

  const chosen = await mint({ kind: 'download', target: { collectionId: 'launch-kit' }, includeHeld: true, note: 'the sponsor asked' });
  assert.equal(chosen.body.includeHeld, 2);
  const entries = await readZip(new Uint8Array(await (await fetch(chosen.path)).arrayBuffer()));
  assert.deepEqual(entries.map((e) => e.name), ['CREDITS.txt', 'credits.json', 'open.jpg', 'sponsored.jpg', 'unrecorded.jpg']);
  const credits = new TextDecoder().decode(entries[0]!.bytes);
  assert.match(credits, /- Sponsored photo \(acme\/photo\/sponsored\)[\s\S]*?licence: CC BY-NC 4\.0\n {2}credit: {2}Photo by A\. Person\n {2}included by the sender, who chose to carry bytes held back by default/);
  assert.ok(!/- Open photo[^-]*included by the sender/.test(credits), 'a file that travels on its own licence is not marked as a choice');
  const json = JSON.parse(new TextDecoder().decode(entries[1]!.bytes)) as { travelled: Array<{ id: string; includedByChoice?: true }> };
  assert.deepEqual(json.travelled.filter((e) => e.includedByChoice).map((e) => e.id), ['acme/photo/sponsored', 'acme/photo/unrecorded']);

  const rita = await mint({ kind: 'share', target: { assetId: 'ext/dam/e1' } }, 'rita@northwind.test');
  assert.equal(rita.status, 201, 'a marked file is the partner\'s to share');
  const single = await mint({ kind: 'share', target: { assetId: 'ext/dam/e2' } });
  assert.equal((await fetch(single.path)).status, 200);

  // Withdrawing the mark takes the files out of the live links on the next visit.
  assert.equal((await call(gate, await login(gate, 'bruno@test'), 'DELETE', '/api/v1/catalog/rights/marks?scope=folder:dam/event-photos')).status, 200);
  assert.equal((await fetch(single.path)).status, 404);
  assert.notEqual((await fetch(rita.path)).status, 200);
});

test('an agent token placed in the company is gated as the person is: feed, bytes and search_assets', async () => {
  const owner = await login(gate, 'owner@test');
  const minted = await call(gate, owner, 'POST', '/api/v1/tokens', { label: 'northwind agent', scopes: ['catalog.read'] });
  assert.equal(minted.status, 201, JSON.stringify(minted.body));
  const token = minted.body.token as string;
  assert.equal((await call(gate, owner, 'PUT', `/api/v1/tokens/${minted.body.id}/programme`, { programme: 'resellers-emea', company: 'northwind-it' })).status, 200);
  const bearer = { authorization: `Bearer ${token}` };
  const feed = await (await fetch(`${gate}/catalog/assets/index.json`, { headers: bearer })).json() as { assets: Array<{ id: string }> };
  const ids = feed.assets.map((a) => a.id);
  assert.ok(ids.includes('acme/photo/open') && ids.includes('acme/skill/voice'));
  for (const held of ['acme/photo/unrecorded', 'ext/dam/s1']) assert.ok(!ids.includes(held), held);
  assert.notEqual((await fetch(`${gate}/catalog/ext/dam/s1/f`, { headers: bearer })).status, 200);
  const rpc = await fetch(`${gate}/api/v1/mcp`, {
    method: 'POST', headers: { ...bearer, 'content-type': 'application/json', 'mcp-protocol-version': '2025-11-25' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: 'photo', limit: 50 } } }),
  });
  const body = await rpc.json() as { result: { content: Array<{ text: string }> } };
  const found = JSON.parse(body.result.content[0]!.text) as { results: Array<{ id: string }> };
  const foundIds = found.results.map((r) => r.id);
  assert.ok(foundIds.includes('acme/photo/open'));
  assert.ok(!foundIds.includes('acme/photo/unrecorded') && !foundIds.some((id) => id === 'ext/dam/s1'), 'search_assets keeps to the gated feed');
});

test('staff receive the same feed bytes with the gate on or off', async () => {
  // The two servers share one store and one pack. `staleProviders` is each
  // process's own view of its last provider sync, so it is the one key set
  // aside; every other byte must match.
  const bytes = async (base: string, email: string) => {
    const text = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: await login(base, email) } })).text();
    const { staleProviders: _local, ...rest } = JSON.parse(text) as Record<string, unknown>;
    return JSON.stringify(rest);
  };
  assert.equal(await bytes(gate, 'staff@test'), await bytes(report, 'staff@test'));
  assert.equal(await bytes(gate, 'bruno@test'), await bytes(report, 'bruno@test'));
  assert.ok((await bytes(gate, 'staff@test')).includes('acme/photo/unrecorded'), 'staff keep every file the gate holds from partners');
});

test('the setup check gives the mode, why, and in report mode what the gate would hold', async () => {
  const gated = (await call(gate, await login(gate, 'owner@test'), 'GET', '/api/v1/system/setup')).body.checks.find((c: { id: string }) => c.id === 'partner-rights');
  assert.deepEqual(gated, { id: 'partner-rights', status: 'pass', message: 'Licence gate: Gate: set in configuration (policy.catalog.partnerRights).' });
  const reporting = (await call(report, await login(report, 'owner@test'), 'GET', '/api/v1/system/setup')).body.checks.find((c: { id: string }) => c.id === 'partner-rights');
  assert.equal(reporting.status, 'warning');
  assert.match(reporting.message, /^Licence gate: Report only: this instance keeps no database, so nothing was decided\. Set policy\.catalog\.partnerRights to change it\. \d+ assets? in 1 programme would be held back/);
  assert.match(reporting.message, /Mark the folders that are yours, then set policy\.catalog\.partnerRights to gate\.$/);
});
