// SPDX-License-Identifier: MPL-2.0
/**
 * Provider folders per programme or company (plans/82 M1 part 2c). A folder
 * rule gives one folder of a connected provider, and everything below it, to
 * a programme or to one company in it. Pinned here: the feed, the file bytes
 * and live search give a partner exactly those folders and nothing else of
 * the provider; staff are untouched; a company rule reaches only that
 * company; the admin sees the folders a sync found with their asset counts;
 * end dates, deleting a company and deleting a programme take rules away; and
 * paths that climb out are refused.
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
import { entryInFolders, folderWithin, foldersFor, normaliseFolderPath, type PartnerFolderRecord } from '../server/src/programmes/folders.ts';
import { folderCounts, sweepFolderRules } from '../server/src/programmes/folder-routes.ts';

const DAY = 86_400_000;
const asset = (remoteId: string, name: string, folder: string) => ({
  remoteId, name, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'f', size: 8 }],
});
const ASSETS = [
  asset('a1', 'EMEA price list', 'Partners/EMEA'),
  asset('a2', 'Acme price sheet', 'Partners/EMEA/Acme'),
  asset('a3', 'US price list', 'Partners/US'),
  asset('a4', 'Roadmap', 'Internal'),
];

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-partner-folders-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@acme.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sf', link: 'lf', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const created = await call(admin, 'POST', '/api/v1/catalog/providers', { id: 'dam', kind: 'mock', label: 'Partner DAM', options: { assets: ASSETS }, exposure: { groups: ['marketing'] } });
  assert.ok([200, 201].includes(created.status), JSON.stringify(created.body));
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/globex', { name: 'Globex' })).status, 201);
  await login('rita@acme.test');
  await login('gus@globex.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', {
    rows: [{ email: 'rita@acme.test', company: 'acme' }, { email: 'gus@globex.test', company: 'globex' }], apply: true,
  })).status, 200);
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
const extIds = async (email: string) => {
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: await login(email) } })).json() as { assets: Array<{ id: string }> };
  return feed.assets.map((a) => a.id).filter((id) => id.startsWith('ext/')).sort();
};

test('paths: normalised, never climbing out, and matching everything below', () => {
  assert.equal(normaliseFolderPath('/Partners//EMEA/ '), 'Partners/EMEA');
  assert.equal(normaliseFolderPath(''), '');
  assert.equal(normaliseFolderPath('Partners/../Internal'), null);
  assert.equal(normaliseFolderPath(42), null);
  assert.ok(folderWithin('Partners/EMEA/Acme', 'Partners/EMEA'));
  assert.ok(folderWithin('Partners/EMEA', 'Partners/EMEA'));
  assert.ok(!folderWithin('Partners/EMEAX', 'Partners/EMEA'), 'a sibling with the same prefix is not below');
  assert.ok(folderWithin('anything', ''), 'the empty path is the whole provider');
  const now = Date.now();
  const rules: PartnerFolderRecord[] = [
    { provider: 'dam', path: 'Partners/EMEA', programmeId: 'resellers', addedBy: 'u', addedAt: 'x' },
    { provider: 'dam', path: 'Partners/US', programmeId: 'resellers', companyId: 'globex', addedBy: 'u', addedAt: 'x' },
    { provider: 'dam', path: 'Old', programmeId: 'resellers', endsAt: new Date(now - 1).toISOString(), addedBy: 'u', addedAt: 'x' },
  ];
  assert.deepEqual([...foldersFor(rules, new Set(['programme-resellers', 'company-acme']), now)], [['dam', ['Partners/EMEA']]]);
  assert.deepEqual([...foldersFor(rules, new Set(['programme-resellers', 'company-globex']), now)], [['dam', ['Partners/EMEA', 'Partners/US']]]);
  assert.deepEqual(folderCounts([{ meta: { providerFolder: 'a/b' } }, { meta: { providerFolder: 'a' } }, { meta: {} }]),
    [{ path: '', assets: 3 }, { path: 'a', assets: 2 }, { path: 'a/b', assets: 1 }], 'all of it counts an asset with no folder too');
  assert.ok(entryInFolders(undefined, ['']), 'the whole provider covers an asset whose driver reports no folder');
  assert.ok(!entryInFolders(undefined, ['a']), 'a named folder does not');
});

test('a folder rule gives a programme that folder and everything below it, and nothing else of the provider', async () => {
  assert.deepEqual(await extIds('rita@acme.test'), [], 'before any rule a partner gets none of a staff provider');
  assert.equal((await extIds('staff@test')).length, 4);

  const admin = await login('admin@test');
  const added = await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: '/Partners/EMEA/' });
  assert.equal(added.status, 201);
  assert.equal(added.body.path, 'Partners/EMEA');
  assert.deepEqual(await extIds('rita@acme.test'), ['ext/dam/a1', 'ext/dam/a2']);
  assert.deepEqual(await extIds('gus@globex.test'), ['ext/dam/a1', 'ext/dam/a2']);
  assert.equal((await extIds('staff@test')).length, 4, 'staff unchanged');

  const rita = await login('rita@acme.test');
  assert.equal((await fetch(`${base}/catalog/ext/dam/a1/f`, { headers: { cookie: rita } })).status, 200);
  assert.equal((await fetch(`${base}/catalog/ext/dam/a3/f`, { headers: { cookie: rita } })).status, 403, 'a file outside the folder is refused');
  const found = await (await fetch(`${base}/api/v1/catalog/search?q=price`, { headers: { cookie: rita } })).json() as { results: Array<{ id: string }> };
  const ids = found.results.map((r) => r.id).sort();
  assert.ok(ids.includes('ext/dam/a1') && ids.includes('ext/dam/a2'));
  assert.ok(!ids.includes('ext/dam/a3'), 'live search keeps to the folder too');

  const audit = (await store.listAudit()).find((e) => e.action === 'programme.folder.add')!;
  assert.deepEqual(audit.payload, { provider: 'dam', path: 'Partners/EMEA' });
});

test('a company rule reaches that company only, and the admin sees folders and counts', async () => {
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'Partners/US', company: 'globex' })).status, 201);
  assert.deepEqual(await extIds('gus@globex.test'), ['ext/dam/a1', 'ext/dam/a2', 'ext/dam/a3']);
  assert.deepEqual(await extIds('rita@acme.test'), ['ext/dam/a1', 'ext/dam/a2']);

  const listed = (await call(admin, 'GET', '/api/v1/programmes/resellers/folders')).body;
  assert.deepEqual(listed.folders.map((f: any) => [f.path, f.company?.name ?? null, f.assets]), [['Partners/EMEA', null, 2], ['Partners/US', 'Globex', 1]]);
  const dam = listed.providers.find((p: any) => p.id === 'dam');
  assert.deepEqual(dam.folders, [
    { path: '', assets: 4 }, { path: 'Internal', assets: 1 }, { path: 'Partners', assets: 3 },
    { path: 'Partners/EMEA', assets: 2 }, { path: 'Partners/EMEA/Acme', assets: 1 }, { path: 'Partners/US', assets: 1 },
  ]);
  assert.equal((await call(await login('rita@acme.test'), 'GET', '/api/v1/programmes/resellers/folders')).status, 403, 'partners never list rules');
});

test('refusals: a path that climbs out, an unknown provider, a company from another programme', async () => {
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'Partners/../Internal' })).status, 400);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'nope', path: 'x' })).status, 404);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/isvs', { name: 'ISVs' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/isvs/companies/initech', { name: 'Initech' })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'x', company: 'initech' })).status, 404);
});

test('an end date ends a rule, and deleting a company or a programme takes its rules away', async () => {
  const admin = await login('admin@test');
  const ends = new Date(Date.now() + 2 * DAY).toISOString().slice(0, 10);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'Partners/EMEA', endsAt: ends })).status, 200, 'an edit of the existing rule');
  const audit = async (actor: string, action: string, subject: string, payload?: Record<string, unknown>) =>
    store.appendAudit({ at: new Date().toISOString(), actor, action, subject, ...(payload ? { payload } : {}) });
  assert.equal(await sweepFolderRules(store, audit, Date.now() + 3 * DAY), 1);
  assert.deepEqual(await extIds('rita@acme.test'), [], 'the ended folder is gone from the feed');
  assert.ok((await store.listAudit()).some((e) => e.action === 'programme.folder.end'));

  assert.equal((await call(admin, 'DELETE', '/api/v1/programmes/resellers/companies/globex')).status, 200);
  assert.ok(!(await store.listPartnerFolders()).some((r) => r.companyId === 'globex'), 'a deleted company\'s rule goes');

  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'Partners' })).status, 201);
  assert.equal((await call(admin, 'DELETE', '/api/v1/programmes/resellers/folders?provider=dam&path=Partners')).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/folders', { provider: 'dam', path: 'Partners' })).status, 201);
  assert.equal((await call(admin, 'DELETE', '/api/v1/programmes/resellers')).status, 200);
  assert.deepEqual(await store.listPartnerFolders(), [], 'a deleted programme\'s rules go');
});

test('the CLI gives, lists and removes a folder', async () => {
  const { execFile } = await import('node:child_process');
  const { promisify } = await import('node:util');
  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/msps', { name: 'Managed services' })).status, 201);
  const token = await call(await login('owner@test'), 'POST', '/api/v1/tokens', { label: 'Folders', role: 'admin' });
  assert.equal(token.status, 201);
  const run = async (args: string[]) => JSON.parse((await promisify(execFile)(process.execPath, ['cli/lw.ts', ...args, '--json'], {
    env: { ...process.env, LW_BASE: base, LW_TOKEN: token.body.token },
  })).stdout);
  assert.equal((await run(['folders', 'add', 'dam', 'Partners/US', '--programme', 'msps'])).path, 'Partners/US');
  const listed = await run(['folders', '--programme', 'msps']);
  assert.deepEqual(listed.folders.map((f: { path: string; assets: number }) => [f.path, f.assets]), [['Partners/US', 1]]);
  await run(['folders', 'rm', 'dam', 'Partners/US', '--programme', 'msps']);
  assert.deepEqual((await run(['folders', '--programme', 'msps'])).folders, []);
});
