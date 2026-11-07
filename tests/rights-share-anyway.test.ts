// SPDX-License-Identifier: MPL-2.0
/**
 * Share anyway (plans/82 M4, W-M4-3).
 *
 * Pinned here: a choice names one held file and one audience, the programme
 * or one company, is made by `programme.manage` with an optional note, and is
 * audited one row per file; it carries a fingerprint over the file's id,
 * checksum, licence declaration, audience and rules version, so a changed
 * licence record retires it and the report lists it as needing a new choice;
 * the report counts what is shared anyway; withdrawing, one at a time or all
 * of a company's at once (the call M5's exit makes), is audited; and a link's
 * dry run lists what would travel and what is held, while `includeHeld` from
 * a member of staff records the held files with their fingerprints on the
 * signed target and is never taken from the request.
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
import { canonicalJson, sha256Hex } from '../server/src/lib/crypto.ts';
import { assetIdentity, choiceFingerprint, withdrawRightsChoices } from '../server/src/programmes/rights.ts';

test('the fingerprint is sha256 over the canonical facts, and moves with any one of them', () => {
  const facts = { assetId: 'ext/dam/a', checksum: 'v1', declaration: 'CC-BY-NC-4.0', group: 'company-northwind-it', rulesVersion: 'rights-rules-x' };
  assert.equal(choiceFingerprint(facts), `sha256:${sha256Hex(canonicalJson(facts))}`);
  assert.equal(choiceFingerprint({ ...facts }), choiceFingerprint(facts));
  for (const key of Object.keys(facts) as Array<keyof typeof facts>) {
    assert.notEqual(choiceFingerprint({ ...facts, [key]: `${facts[key]}-changed` }), choiceFingerprint(facts), key);
  }
});

test('a choice binds every rendition the file serves, and no file without an identity', () => {
  const f = (format: string, checksum?: string, url = `/x.${format}`) => ({ format, url, ...(checksum ? { checksum } : {}) }) as never;
  const base = { id: 'acme/x', formats: [f('png', 'sha256-a'), f('svg', 'sha256-b')] };
  const id = assetIdentity(base);
  assert.match(id ?? '', /^sha256:[0-9a-f]{64}$/);
  assert.notEqual(assetIdentity({ ...base, formats: [f('png', 'sha256-a'), f('svg', 'sha256-CHANGED')] }), id, 'a second format moving moves the identity');
  assert.notEqual(assetIdentity({ ...base, locales: { fr: [f('png', 'sha256-fr')] } } as never), id, 'so does a localised rendition');
  assert.notEqual(assetIdentity({ ...base, locales: { fr: [f('png', 'sha256-fr')] } } as never), assetIdentity({ ...base, locales: { fr: [f('png', 'sha256-fr2')] } } as never));
  assert.equal(assetIdentity({ id: 'acme/x', formats: [f('png', 'sha256-a'), f('svg')] }), null, 'a pack rendition with no checksum: no identity');
  assert.equal(assetIdentity({ id: 'acme/x', version: '3', formats: [f('png')] }), null, 'a pack version alone does not move with the bytes');
  assert.ok(assetIdentity({ id: 'ext/dam/x', version: 'abcd', formats: [f('jpg')] }), 'a federated version hashes the upstream date and formats');
  assert.notEqual(assetIdentity({ id: 'ext/dam/x', version: 'abcd', formats: [f('jpg')] }), assetIdentity({ id: 'ext/dam/x', version: 'abce', formats: [f('jpg')] }));
});

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const photo = (remoteId: string, folder: string) => ({
  remoteId, name: `${folder} ${remoteId}`, nativeType: 'file', sections: [], folder, tags: [], approved: true, formats: [{ format: 'jpg', remoteRef: 'f', size: 8 }],
});
const PACK = [
  { id: 'acme/photo/sponsored', name: 'Sponsored photo', type: 'raster', license: 'CC-BY-NC-4.0', attribution: 'Photo by A. Person' },
  { id: 'acme/photo/open', name: 'Open photo', type: 'raster', license: 'CC-BY-4.0' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-share-anyway-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  for (const a of PACK) await writeFile(join(pack, 'catalog', 'assets', 'acme', `${a.id.split('/').pop()}.jpg`), 'x');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: PACK.map((a) => ({ ...a, formats: [{ format: 'jpg', url: `/catalog/assets/acme/${a.id.split('/').pop()}.jpg` }] })),
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
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sa', link: 'la', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('bruno@test');
  assert.ok([200, 201].includes((await call(admin, 'POST', '/api/v1/catalog/providers', {
    id: 'dam', kind: 'mock', label: 'Brandfolder', exposure: { groups: ['marketing'] },
    options: { assets: [photo('e1', 'event-photos'), photo('e2', 'event-photos'), photo('s1', 'stock')] },
  })).status));
  assert.equal((await call(await login('owner@test'), 'POST', '/api/v1/catalog/providers/dam/enable')).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  for (const [id, name] of [['northwind-it', 'Northwind IT'], ['globex', 'Globex']]) {
    assert.equal((await call(admin, 'PUT', `/api/v1/programmes/resellers-emea/companies/${id}`, { name })).status, 201);
  }
  await login('rita@northwind.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers-emea/people', { rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }], apply: true })).status, 200);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers-emea/folders', { provider: 'dam', path: 'event-photos' })).status, 201);
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
const report = async () => (await call(await login('bruno@test'), 'GET', '/api/v1/programmes/resellers-emea/rights-report')).body;
const lastAudit = async (action: string) => (await store.listAudit()).filter((e) => e.action === action).at(-1);

test('share anyway: one held file, one company, a note, audited with its fingerprint', async () => {
  const bruno = await login('bruno@test');
  const note = 'Northwind sponsored the event; the photographer agreed by email, ref 2026-114';
  const made = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['acme/photo/sponsored'], company: 'northwind-it', note });
  assert.equal(made.status, 200, JSON.stringify(made.body));
  const [choice] = made.body.choices;
  assert.equal(choice.group, 'company-northwind-it');
  assert.deepEqual(choice.company, { id: 'northwind-it', name: 'Northwind IT' });
  assert.equal(choice.licence, 'CC BY-NC 4.0');
  assert.equal(choice.chosenBy.name, 'Bruno Marsh');
  assert.equal(choice.standing, 'live');
  assert.match(choice.fingerprint, /^sha256:[0-9a-f]{64}$/);

  const row = await lastAudit('programme.rights.share-anyway');
  assert.deepEqual(row!.payload, {
    assetId: 'acme/photo/sponsored', group: 'company-northwind-it', licence: 'CC-BY-NC-4.0', reason: 'CC-BY-NC-4.0 is recorded and not yet interpreted', note, fingerprint: choice.fingerprint,
  });

  const r = await report();
  assert.equal(r.totals.sharedAnyway, 1);
  const kit = r.sources.find((s: { label: string }) => s.label === 'Launch kit');
  assert.equal(kit.sharedAnyway, 1);
  assert.equal(kit.held.count, 0);
  assert.equal(r.choices.length, 1);
  assert.equal(r.choices[0].note, note, 'the admin reads the note; partners never do');
});

test('refusals: a file that already travels, a file outside the audience, a company elsewhere, and no programme.manage', async () => {
  const bruno = await login('bruno@test');
  const open = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['acme/photo/open'] });
  assert.equal(open.status, 409);
  assert.equal(open.body.error.code, 'NOT_HELD');
  const outside = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/s1'] });
  assert.equal(outside.status, 404, 'stock was never given to this programme');
  assert.equal(outside.body.error.code, 'NOT_IN_FEED');
  const mixed = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1', 'acme/photo/open'] });
  assert.equal(mixed.status, 409, 'nothing is written unless every file qualifies');
  assert.equal((await store.listRightsChoices()).filter((c) => c.assetId === 'ext/dam/e1').length, 0);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'], company: 'nope' })).status, 404);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: [] })).status, 400);
  assert.equal((await call(await login('staff@test'), 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'] })).status, 403);
  assert.equal((await call(await login('rita@northwind.test'), 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'] })).status, 403);
});

test('a choice is remembered against its facts: a new licence record retires it', async () => {
  const bruno = await login('bruno@test');
  const both = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1', 'ext/dam/e2'] });
  assert.equal(both.status, 200);
  assert.equal(both.body.choices.length, 2, 'several held files in one folder, chosen once');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'programme.rights.share-anyway').length, 3, 'one audited row per file');
  assert.equal((await report()).totals.sharedAnyway, 3);

  assert.equal((await call(bruno, 'PUT', '/api/v1/catalog/rights/licences', { assetId: 'ext/dam/e1', declaration: 'CC BY-ND 4.0' })).status, 201);
  const r = await report();
  assert.equal(r.totals.sharedAnyway, 2);
  assert.equal(r.totals.needsChoosing, 1);
  const events = r.sources.find((s: { label: string }) => s.label === 'Brandfolder / event-photos');
  assert.equal(events.heldFiles.find((f: { id: string }) => f.id === 'ext/dam/e1').needsChoosing, true);
  assert.equal(r.choices.find((c: { assetId: string }) => c.assetId === 'ext/dam/e1').standing, 'needs-choosing');

  assert.equal((await call(bruno, 'DELETE', '/api/v1/catalog/rights/licences?assetId=ext/dam/e1')).status, 200);
  assert.equal((await report()).choices.find((c: { assetId: string }) => c.assetId === 'ext/dam/e1').standing, 'live', 'the same facts again, the same choice');
});

test('withdrawing: one choice from the console, and every choice of a company in one call', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'DELETE', '/api/v1/programmes/resellers-emea/rights/choices?assetId=ext/dam/e2')).status, 200);
  assert.equal((await call(bruno, 'DELETE', '/api/v1/programmes/resellers-emea/rights/choices?assetId=ext/dam/e2')).status, 404);
  assert.equal((await lastAudit('programme.rights.withdraw'))!.payload!.via, 'console');

  const bodyOf = (actor: string, action: string, subject: string, payload?: Record<string, unknown>) => ({ actor, action, subject, ...(payload ? { payload } : {}), at: new Date().toISOString() });
  const gone = await withdrawRightsChoices(store, bodyOf, 'user:bruno', { companyId: 'northwind-it' }, 'programme-exit');
  assert.deepEqual(gone.map((c) => c.assetId), ['acme/photo/sponsored']);
  assert.equal((await lastAudit('programme.rights.withdraw'))!.payload!.via, 'programme-exit');
  assert.deepEqual((await store.listRightsChoices()).map((c) => c.assetId), ['ext/dam/e1'], 'the programme\'s own choice stays');
  assert.equal((await withdrawRightsChoices(store, bodyOf, 'system', { programmeId: 'resellers-emea' }, 'programme-exit')).length, 1);
  assert.deepEqual(await store.listRightsChoices(), []);
});

test('a link dry run lists what would travel and what is held, and writes nothing', async () => {
  const staff = await login('staff@test');
  const linksBefore = (await store.listAllLinks()).length;
  const auditBefore = (await store.listAudit()).length;
  const dry = await call(staff, 'POST', '/api/v1/links?dryRun=1', { kind: 'download', target: { collectionId: 'launch-kit' } });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.equal(dry.body.dryRun, true);
  assert.equal(dry.body.travel, 1);
  assert.equal(dry.body.held, 1);
  assert.deepEqual(dry.body.files[0], {
    id: 'acme/photo/sponsored', name: 'Sponsored photo', travels: false, licence: 'CC BY-NC 4.0', declared: 'CC-BY-NC-4.0', category: 'not-interpreted',
    reason: 'CC-BY-NC-4.0 is recorded and not yet interpreted', conditions: ['Attribution', 'NonCommercial'],
  });
  assert.deepEqual(dry.body.files[1], { id: 'acme/photo/open', name: 'Open photo', travels: true, licence: 'CC BY 4.0' });
  assert.equal((await store.listAllLinks()).length, linksBefore);
  assert.equal((await store.listAudit()).length, auditBefore);
});

test('includeHeld: staff only, fingerprinted on the signed target, never taken from the request', async () => {
  const staff = await login('staff@test');
  const made = await call(staff, 'POST', '/api/v1/links', { kind: 'download', target: { collectionId: 'launch-kit' }, includeHeld: true, note: 'the sponsor asked for the set' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.equal(made.body.includeHeld, 1);
  const link = (await store.listAllLinks()).find((l) => l.id === made.body.id)!;
  assert.deepEqual(link.target.includeHeld?.map((h) => h.id), ['acme/photo/sponsored']);
  assert.match(link.target.includeHeld![0]!.fingerprint, /^sha256:/);
  const row = await lastAudit('link.create');
  assert.deepEqual((row!.payload as { includeHeld: string[] }).includeHeld, ['acme/photo/sponsored']);
  assert.equal((row!.payload as { note: string }).note, 'the sponsor asked for the set');

  const spoof = await call(staff, 'POST', '/api/v1/links', { kind: 'download', target: { collectionId: 'launch-kit', includeHeld: [{ id: 'acme/photo/sponsored', fingerprint: 'sha256:00' }] } });
  assert.equal(spoof.status, 201);
  assert.equal((await store.listAllLinks()).find((l) => l.id === spoof.body.id)!.target.includeHeld, undefined, 'the server alone writes it');

  const rita = await login('rita@northwind.test');
  assert.equal((await call(rita, 'POST', '/api/v1/links', { kind: 'share', target: { assetId: 'ext/dam/e1' }, includeHeld: true })).status, 403);
  assert.equal((await call(rita, 'POST', '/api/v1/links?dryRun=1', { kind: 'share', target: { assetId: 'ext/dam/e1' } })).status, 200, 'a partner may still look');
});

test('ending a company lists its share anyway choices in the dry run and withdraws them with via programme-exit', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['acme/photo/sponsored'], company: 'globex' })).status, 200);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e2'] })).status, 200);
  const dry = await call(bruno, 'POST', '/api/v1/programmes/exit', { company: 'globex' });
  assert.equal(dry.status, 200, JSON.stringify(dry.body));
  assert.deepEqual(dry.body.rightsChoices, [{ assetId: 'acme/photo/sponsored', group: 'company-globex', licence: 'CC-BY-NC-4.0' }], 'the company\'s choice, not the programme\'s');
  assert.equal((await store.listRightsChoices()).length, 2, 'a dry run withdraws nothing');
  const applied = await call(bruno, 'POST', '/api/v1/programmes/exit', { company: 'globex', apply: true });
  assert.equal(applied.status, 200, JSON.stringify(applied.body));
  assert.deepEqual((await store.listRightsChoices()).map((c) => c.group), ['programme-resellers-emea']);
  const row = (await store.listAudit()).filter((e) => e.action === 'programme.rights.withdraw').at(-1)!;
  assert.deepEqual([row.payload!.assetId, row.payload!.group, row.payload!.via], ['acme/photo/sponsored', 'company-globex', 'programme-exit']);
});

const pause = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

test('a choice and its audit row commit together: when the write fails, neither is kept', async () => {
  const bruno = await login('bruno@test');
  const before = (await store.listAudit()).filter((e) => e.action === 'programme.rights.share-anyway').length;
  const original = store.putRightsChoicesAudited;
  store.putRightsChoicesAudited = async () => { throw new Error('the database went away'); };
  const res = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'], company: 'northwind-it' });
  store.putRightsChoicesAudited = original;
  assert.equal(res.status, 500);
  assert.ok(!(await store.listRightsChoices()).some((c) => c.assetId === 'ext/dam/e1' && c.group === 'company-northwind-it'), 'no choice');
  assert.equal((await store.listAudit()).filter((e) => e.action === 'programme.rights.share-anyway').length, before, 'and no row');
});

test('an ended company takes no new choice, and a choice racing its exit does not outlive the exit', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/hooli', { name: 'Hooli' })).status, 201);
  // The PUT reaches its write, then waits while the exit ends the company.
  const original = store.putRightsChoicesAudited;
  let release!: () => void, reached!: () => void;
  const held = new Promise<void>((r) => { release = r; });
  const atWrite = new Promise<void>((r) => { reached = r; });
  store.putRightsChoicesAudited = async (...args) => { reached(); await held; return original(...args); };
  const racing = call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'], company: 'hooli' });
  await Promise.race([atWrite, pause(3000)]);
  store.putRightsChoicesAudited = original;
  const exit = await call(bruno, 'POST', '/api/v1/programmes/exit', { company: 'hooli', apply: true });
  assert.equal(exit.status, 200, JSON.stringify(exit.body));
  release();
  const res = await racing;
  assert.equal(res.status, 409, JSON.stringify(res.body));
  assert.equal(res.body.error.code, 'AUDIENCE_ENDED');
  assert.ok(!(await store.listRightsChoices()).some((c) => c.group === 'company-hooli'), 'nothing for the ended company');
  const after = await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/rights/choices', { assetIds: ['ext/dam/e1'], company: 'hooli' });
  assert.equal(after.status, 409);
  assert.equal(after.body.error.code, 'AUDIENCE_ENDED', 'an ended audience is refused outright');
});

test('deleting a company or a programme withdraws its choices, audited, and the same id made again starts with none', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac', { name: 'Partners, APAC' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac/companies/initech', { name: 'Initech' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac/folders', { provider: 'dam', path: 'event-photos' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac/rights/choices', { assetIds: ['ext/dam/e1'], company: 'initech' })).status, 200);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac/rights/choices', { assetIds: ['ext/dam/e2'] })).status, 200);
  const of = async (group: string) => (await store.listRightsChoices()).filter((c) => c.group === group);

  assert.equal((await call(bruno, 'DELETE', '/api/v1/programmes/partners-apac/companies/initech')).status, 200);
  assert.deepEqual(await of('company-initech'), []);
  assert.equal((await lastAudit('programme.rights.withdraw'))!.payload!.via, 'company-delete');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac/companies/initech', { name: 'Initech' })).status, 201);
  assert.deepEqual(await of('company-initech'), [], 'a company made again with the same id inherits nothing');

  assert.equal((await of('programme-partners-apac')).length, 1);
  assert.equal((await call(bruno, 'DELETE', '/api/v1/programmes/partners-apac')).status, 200);
  assert.deepEqual(await of('programme-partners-apac'), []);
  assert.equal((await lastAudit('programme.rights.withdraw'))!.payload!.via, 'programme-delete');
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/partners-apac', { name: 'Partners, APAC' })).status, 201);
  assert.deepEqual(await of('programme-partners-apac'), [], 'nor does a programme');
});
