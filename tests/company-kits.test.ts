// SPDX-License-Identifier: MPL-2.0
/** Partner kit storage and proposals over real HTTP (plans/82 M8). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deflateRawSync } from 'node:zlib';
import sharp from 'sharp';
import type { PartnerKitV1 } from '@lolly-tools/core/partner-kit-v1';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { submitAsset } from '../server/src/catalog/submit.ts';
import { PACK_MAX_BYTES } from '../server/src/catalog/instance-pack.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';
import { KIT_DESIGN_SYSTEM_MAX_BYTES, KIT_LOLLY_MAX_BYTES, KIT_MAX_BYTES, KIT_TOKENS_MAX_BYTES } from '../server/src/programmes/kit.ts';

let server: Server;
let base = '';
let pack = '';
let store: ReturnType<typeof createMemoryStore>;
let blobs: ReturnType<typeof createMemoryBlobStore>;
let policy: ReturnType<typeof parseConfig>['policy']['submit'];
let bruno = '';
let rita = '';
let gus = '';
let pat = '';
let logo = '';
let foreignLogo = '';
let assetId = '';
const AT = '/api/v1/programmes/resellers/companies';
const K = `${AT}/northwind/kit`;
const OWN = '/api/v1/me/company/kit';
const tokens = readFileSync(join(import.meta.dirname, 'fixtures', 'company-kit-tokens.json'));
const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><path d="M10 70 L40 10 L70 70 Z" fill="${fill}"/></svg>`);
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json() as Record<string, any> };
};
const upload = async (cookie: string, path: string, bytes: Buffer = Buffer.alloc(0), method = 'POST') => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json() as Record<string, any> };
};
async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const feed = async (cookie: string) => (await call(cookie, 'GET', '/catalog/assets/index.json')).body.assets as Array<{ id: string; type: string }>;
const kit = (id = 'northwind'): PartnerKitV1 => ({ schemaVersion: 1, id, label: id === 'northwind' ? 'Northwind IT' : id, logos: { light: { id: logo, version: 1 } },
  colours: [{ role: 'primary', name: 'Northwind blue', value: '#0B3D91' }], source: { kind: 'manual' } });
function zip(entries: Record<string, string>): Buffer {
  const builder = new ZipBuilder();
  return Buffer.concat([...Object.entries(entries).map(([name, body]) => builder.add(name, Buffer.from(body))), builder.end()]);
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-company-kits-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Kit Hub', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    policy: { submit: { chain: 'catalog-review' } },
    dev: { enabled: true, users: [
      { email: 'bruno@brand.test', groups: ['admin'] }, { email: 'staff@brand.test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] }, { email: 'gus@globex.test', groups: [] }, { email: 'pat@partner.test', groups: [] },
    ] },
  }));
  policy = config.policy.submit;
  store = createMemoryStore();
  blobs = createMemoryBlobStore();
  const app = buildApp({ config, store, blobs, secrets: { session: 'sk', link: 'lk' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, () => resolve()); });
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  bruno = await login('bruno@brand.test');
  await call(bruno, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers' });
  for (const [id, name] of [['northwind', 'Northwind IT'], ['globex', 'Globex']]) assert.equal((await call(bruno, 'PUT', `${AT}/${id}`, { name })).status, 201);
  rita = await login('rita@northwind.test');
  gus = await login('gus@globex.test');
  pat = await login('pat@partner.test');
  assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers/people', { rows: [
    { email: 'rita@northwind.test', company: 'northwind' }, { email: 'gus@globex.test', company: 'globex' }, { email: 'pat@partner.test' },
  ], apply: true })).status, 200);
  const ownLogo = await upload(bruno, `${AT}/northwind/profile/logo?surface=light`, svg('#0b3d91'));
  assert.equal(ownLogo.status, 200, JSON.stringify(ownLogo.body));
  logo = ownLogo.body.asset.id;
  const other = await upload(bruno, `${AT}/globex/profile/logo?surface=light`, svg('#e3001b'));
  assert.equal(other.status, 200);
  foreignLogo = other.body.asset.id;
});
after(async () => { server?.close(); await rm(pack, { recursive: true, force: true }); });

test('tokens, share and SVG imports propose colours and current logo pins without rules or writes', async () => {
  const count = (await store.listInstanceAssets()).length;
  const auditCount = (await store.listAudit()).length;
  const sources: Array<[string, Buffer, string]> = [
    ['tokens', tokens, 'partner.tokens.json'], ['lolly', zip({ 'design-system.json': tokens.toString(), 'hooks.js': 'throw new Error("never run")' }), 'partner.lolly'],
    ['lolly', zip({ 'design-system.json': `${' '.repeat(KIT_TOKENS_MAX_BYTES)}${tokens.toString()}` }), 'large.lolly'],
    ['logos', Buffer.alloc(0), 'Company logos'],
  ];
  for (const [from, bytes, reference] of sources) {
    const proposed = await upload(bruno, `${K}/import?from=${from}&name=${encodeURIComponent(reference)}`, bytes);
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.equal(proposed.body.kit.id, 'northwind');
    assert.equal(proposed.body.kit.label, 'Northwind IT');
    assert.deepEqual(proposed.body.kit.logos, { light: { id: logo, version: 1 } });
    assert.ok(proposed.body.kit.colours.some((c: { value: string }) => c.value === '#0b3d91'));
    assert.equal(proposed.body.kit.rules, undefined);
    assert.deepEqual(proposed.body.kit.source, { kind: from, reference });
  }
  assert.equal((await store.listInstanceAssets()).length, count);
  assert.equal((await store.listAudit()).length, auditCount);
  assert.equal((await store.getCompanyProfile('northwind'))?.kit, undefined);
  assert.equal((await call(bruno, 'GET', K)).status, 404);
  const missing = await upload(bruno, `${K}/import?from=lolly`, zip({ 'tokens.json': tokens.toString() }));
  assert.equal(missing.status, 200);
  assert.deepEqual(missing.body.kit.colours, []);
  assert.match(missing.body.warnings.join(' '), /no design-system.json/);
});

test('Tokens Studio, zipped sets and a Penpot project use the engine readers', async () => {
  const doc = JSON.parse(tokens.toString());
  const studio = { Brand: doc, $metadata: { tokenSetOrder: ['Brand'] } };
  const inputs = [Buffer.from(JSON.stringify(studio)), zip({ 'Brand.json': JSON.stringify(doc), '$metadata.json': JSON.stringify(studio.$metadata) }),
    zip({ 'manifest.json': JSON.stringify({ files: [{ id: 'brand' }] }), 'files/brand/tokens.json': JSON.stringify(studio) })];
  for (const bytes of inputs) {
    const proposed = await upload(bruno, `${K}/import?from=tokens`, bytes);
    assert.equal(proposed.status, 200, JSON.stringify(proposed.body));
    assert.ok(proposed.body.kit.colours.length);
    assert.equal(proposed.body.kit.rules, undefined);
  }
});

test('import bounds, malformed files, paths and zip bombs are refused', async () => {
  assert.equal((await upload(bruno, `${K}/import?from=tokens`, Buffer.alloc(KIT_TOKENS_MAX_BYTES + 1, 32))).status, 413);
  assert.equal((await upload(bruno, `${K}/import?from=lolly`, Buffer.alloc(KIT_LOLLY_MAX_BYTES + 1))).status, 413);
  assert.equal((await upload(bruno, `${K}/import?from=tokens`, Buffer.from('{'))).status, 422);
  assert.equal((await upload(bruno, `${K}/import?from=tokens&name=https%3A%2F%2Fpartner.test%2Ftokens.json`, tokens)).status, 422);
  assert.equal((await upload(bruno, `${K}/import?from=other`, tokens)).status, 400);
  assert.equal((await upload(bruno, `${K}/import?from=lolly`, Buffer.from('not a zip'))).status, 422);
  const bomb = zip({ 'design-system.json': 'x' });
  const central = bomb.indexOf(Buffer.from('504b0102', 'hex'));
  bomb.writeUInt32LE(PACK_MAX_BYTES + 1, central + 24);
  assert.equal((await upload(bruno, `${K}/import?from=lolly`, bomb)).status, 422);
  // A share's design system is read under its own bound, far below the pack budget.
  const wide = zip({ 'design-system.json': `${' '.repeat(KIT_DESIGN_SYSTEM_MAX_BYTES + 1)}{}` });
  assert.equal((await upload(bruno, `${K}/import?from=lolly`, wide)).status, 422);
  // A false expanded size still hits the inflater's output bound.
  const payload = deflateRawSync(Buffer.alloc(KIT_TOKENS_MAX_BYTES + 1, 32));
  const local = Buffer.alloc(30), row = Buffer.alloc(46), end = Buffer.alloc(22), name = Buffer.from('design-system.json');
  local.writeUInt32LE(0x04034b50); local.writeUInt16LE(name.length, 26);
  row.writeUInt32LE(0x02014b50); row.writeUInt16LE(8, 10); row.writeUInt32LE(payload.length, 20); row.writeUInt32LE(1, 24); row.writeUInt16LE(name.length, 28);
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(1, 10); end.writeUInt32LE(local.length + name.length + payload.length, 16);
  assert.equal((await upload(bruno, `${K}/import?from=tokens`, Buffer.concat([local, name, payload, row, name, end]))).status, 422);
});

test('another company logo, a non-logo asset and a missing logo version are refused before storage', async () => {
  const count = (await store.listInstanceAssets()).length;
  for (const [id, version] of [[foreignLogo, 1], [logo, 999]]) {
    const refused = await call(bruno, 'PUT', K, { ...kit(), logos: { light: { id, version } } });
    assert.equal(refused.status, 422);
    assert.match(refused.body.error.message, id === foreignLogo ? /own profile logo/ : /no version 999/);
  }
  await store.putInstanceAsset({ id: 'inst/not-logo', entry: { id: 'inst/not-logo', type: 'image', tags: [], meta: { company: 'northwind' } }, blobs: { png: 'not-logo' }, groups: ['company-northwind'], createdAt: 'x' });
  const refused = await call(bruno, 'PUT', K, { ...kit(), logos: { light: { id: 'inst/not-logo', version: 1 } } });
  assert.equal(refused.status, 422);
  assert.match(refused.body.error.message, /own profile logo/);
  assert.equal((await store.listInstanceAssets()).length, count + 1);
  assert.equal((await store.getCompanyProfile('northwind'))?.kit, undefined);
});

test('kit size and format bounds are enforced and source references cannot carry URLs', async () => {
  assert.equal((await upload(bruno, K, Buffer.from(`${' '.repeat(KIT_MAX_BYTES)}${JSON.stringify(kit())}`), 'PUT')).status, 413);
  assert.equal((await call(bruno, 'PUT', K, { ...kit(), label: 'x'.repeat(KIT_MAX_BYTES) })).status, 413);
  for (const bad of [{ ...kit(), id: 'globex' }, { ...kit(), rules: { treatments: ['anything'] } },
    { ...kit(), source: { kind: 'tokens', reference: 'https://partner.test/tokens.json' } }, { ...kit(), colours: Array.from({ length: 13 }, () => kit().colours[0]) }]) {
    assert.equal((await call(bruno, 'PUT', K, bad)).status, 422);
  }
  assert.equal((await store.listInstanceAssets()).filter((r) => r.entry.type === 'partner-kit').length, 0);
});

test('saving makes revision 1 then 2 on the same partner-kit asset and preserves profile history', async () => {
  const prior = (await store.getCompanyProfile('northwind'))!;
  const first = await call(bruno, 'PUT', K, kit());
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assetId = first.body.assetId;
  assert.equal(first.body.revision, 1);
  assert.equal(first.body.kit.colours[0].value, '#0b3d91');
  const rec = (await store.getInstanceAsset(assetId))!;
  assert.equal(rec.entry.type, 'partner-kit');
  assert.deepEqual(rec.entry.tags, ['partner', 'kit']);
  assert.deepEqual(rec.entry.meta, { company: 'northwind' });
  assert.deepEqual(rec.groups, ['company-northwind']);
  assert.equal(rec.submission?.state, 'live', 'company kits bypass the catalog contribution chain');
  const blob = (await blobs.get(rec.blobs.json!))!;
  assert.equal(await new Response(blob.body).text(), `${JSON.stringify(first.body.kit, null, 2)}\n`);
  const second = await call(bruno, 'PUT', K, { ...kit(), rules: { clearSpace: { value: 0.5, unit: 'mark-height' }, minSize: { px: 40, mm: 10 }, treatments: ['colour', 'mono'] } });
  assert.equal(second.status, 200);
  assert.equal(second.body.assetId, assetId);
  assert.equal(second.body.revision, 2);
  assert.deepEqual((await store.listAssetVersions(assetId)).map((r) => r.version), [1, 2]);
  assert.equal((await call(bruno, 'PUT', K, second.body.kit)).body.revision, 2, 'identical normalized bytes keep their revision');
  assert.deepEqual((await call(bruno, 'GET', K)).body, second.body);
  assert.equal((await store.getCompanyProfile('northwind'))?.revision, prior.revision);
  assert.deepEqual((await store.getCompanyProfile('northwind'))?.kit, { assetId });
  const profileSave = await call(bruno, 'PUT', `${AT}/northwind/profile`, { currency: 'EUR' });
  assert.equal(profileSave.status, 200);
  assert.deepEqual((await store.getCompanyProfile('northwind'))?.kit, { assetId }, 'profile edits preserve the separate pointer');
  assert.ok((await store.listCompanyProfileHistory('northwind')).every((r) => !('kit' in r.profile)));
});

test('a second submit is refused and generic catalog submission cannot mint a kit', async () => {
  const input = { bytes: Buffer.from(JSON.stringify(kit())), name: 'Second kit', submitter: { id: 'manager', groups: ['admin'] } };
  const duplicate = await submitAsset({ store, blobs, policy }, { ...input, companyKit: { companyId: 'northwind' } });
  assert.equal(duplicate.ok, false);
  if (!duplicate.ok) assert.match(duplicate.detail, /already has one kit/);
  const generic = await submitAsset({ store, blobs, policy: { ...policy, chain: undefined } }, { ...input, type: 'partner-kit' });
  assert.equal(generic.ok, false);
  assert.equal((await store.listInstanceAssets()).filter((r) => r.entry.type === 'partner-kit').length, 1);
});

test('concurrent first submissions keep one kit and a scanner veto stores nothing', async () => {
  await call(bruno, 'PUT', `${AT}/concurrent`, { name: 'Concurrent Partner' });
  const input = { bytes: Buffer.from(JSON.stringify({ ...kit('concurrent'), logos: {} })), name: 'Concurrent kit',
    companyKit: { companyId: 'concurrent' }, submitter: { id: 'manager', groups: ['admin'] } };
  const refused = await submitAsset({ store, blobs, policy,
    scanHook: { kind: 'http', target: 'http://scanner.test', timeoutMs: 1000, onError: 'reject' },
    fetchImpl: async () => new Response('file refused', { status: 422 }),
  }, input);
  assert.equal(refused.ok, false);
  if (!refused.ok) assert.equal(refused.code, 'SCAN_REJECTED');
  assert.equal((await store.getCompanyProfile('concurrent'))?.kit, undefined);
  const large = await submitAsset({ store, blobs, policy }, { ...input, bytes: Buffer.from(JSON.stringify({ ...kit('concurrent'), label: 'x'.repeat(KIT_MAX_BYTES) })) });
  assert.equal(large.ok, false, 'the engine enforces the kit bound for direct submits too');
  const outcomes = await Promise.all([submitAsset({ store, blobs, policy }, input), submitAsset({ store, blobs, policy }, input)]);
  assert.equal(outcomes.filter((r) => r.ok).length, 1);
  const records = (await store.listInstanceAssets()).filter((r) => r.entry.type === 'partner-kit' && (r.entry.meta as { company?: string })?.company === 'concurrent');
  assert.equal(records.length, 1);
  assert.deepEqual((await store.getCompanyProfile('concurrent'))?.kit, { assetId: records[0]!.id });
  assert.equal((await call(bruno, 'DELETE', `${AT}/concurrent`)).status, 200);
});

test('feed, blob routes and org-config offer the kit only to the company member', async () => {
  assert.ok((await feed(rita)).some((r) => r.id === assetId && r.type === 'partner-kit'));
  for (const cookie of [gus, pat, await login('staff@brand.test')]) {
    assert.ok(!(await feed(cookie)).some((r) => r.id === assetId));
    assert.equal((await fetch(`${base}/catalog/${assetId}/json`, { headers: { cookie } })).status, 403);
    assert.equal((await call(cookie, 'GET', '/api/v1/org-config')).body.partner?.company?.kit, undefined);
  }
  assert.equal((await fetch(`${base}/catalog/${assetId}/json`, { headers: { cookie: rita } })).status, 200);
  assert.deepEqual((await call(rita, 'GET', '/api/v1/org-config')).body.partner.company.kit, { id: assetId, revision: 2, label: 'Northwind IT' });
  assert.equal((await call(rita, 'GET', OWN)).body.assetId, assetId);
  assert.equal((await call(gus, 'GET', OWN)).status, 404);
  assert.equal((await call(pat, 'GET', OWN)).status, 404);
});

test('managers need programme.manage and contacts may edit only with direct editing enabled', async () => {
  assert.equal((await call(rita, 'GET', K)).status, 403);
  assert.equal((await call(rita, 'PUT', K, kit())).status, 403);
  assert.equal((await upload(rita, `${K}/import?from=logos`)).status, 403);
  assert.equal((await call(rita, 'DELETE', K)).status, 403);
  assert.equal((await call(rita, 'PUT', OWN, kit())).status, 403);
  assert.equal((await upload(rita, `${OWN}/import?from=logos`)).status, 403);
  assert.equal((await call(bruno, 'PUT', `${AT}/northwind/profile/settings`, { editors: ['rita@northwind.test'] })).status, 200);
  assert.equal((await upload(rita, `${OWN}/import?from=tokens`, tokens)).status, 200);
  assert.equal((await call(rita, 'PUT', OWN, kit())).status, 200);
  await store.putChain({ id: 'review', name: 'Review', steps: [{ name: 'Brand', approvers: { groups: ['admin'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  assert.equal((await call(bruno, 'PUT', `${AT}/northwind/profile/settings`, { approvalChain: 'review' })).status, 200);
  assert.equal((await call(rita, 'PUT', OWN, kit())).status, 403);
  assert.equal((await upload(rita, `${OWN}/import?from=logos`)).status, 403);
  assert.equal((await call(bruno, 'PUT', K, kit())).status, 200, 'a manager never waits for contact approval');
  await call(bruno, 'PUT', `${AT}/northwind/profile/settings`, { approvalChain: null });
});

test('current logo versions are proposed and older existing pins remain valid', async () => {
  const replaced = await upload(bruno, `${AT}/northwind/profile/logo?surface=light`, svg('#123f8f'));
  assert.equal(replaced.status, 200);
  assert.equal(replaced.body.asset.id, logo);
  const proposed = await upload(bruno, `${K}/import?from=logos`);
  assert.equal(proposed.body.kit.logos.light.version, 2);
  assert.equal(proposed.body.kit.colours[0].value, '#123f8f');
  assert.equal(proposed.body.kit.rules, undefined);
  assert.equal((await call(bruno, 'PUT', K, kit())).status, 200, 'an existing earlier logo version may be pinned');
});

test('a PNG logo proposes no colours and no rules', async () => {
  await call(bruno, 'PUT', `${AT}/raster`, { name: 'Raster Partner' });
  const png = await sharp({ create: { width: 400, height: 400, channels: 4, background: '#e3001b' } }).png().toBuffer();
  assert.equal((await upload(bruno, `${AT}/raster/profile/logo?surface=mark`, png)).status, 200);
  const proposed = await upload(bruno, `${AT}/raster/kit/import?from=logos`);
  assert.equal(proposed.status, 200);
  assert.ok(proposed.body.kit.logos.mark.id);
  assert.deepEqual(proposed.body.kit.colours, []);
  assert.equal(proposed.body.kit.rules, undefined);
});

test('ending the company retires its kit and Reopen restores the same pointer', async () => {
  const preview = await call(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind' });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.companyKits[0].assetId, assetId);
  assert.deepEqual((await store.getCompanyProfile('northwind'))?.kit, { assetId });
  const done = await call(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', apply: true });
  assert.equal(done.status, 200, JSON.stringify(done.body));
  assert.equal((await store.getCompanyProfile('northwind'))?.kit, undefined);
  assert.ok((await store.getLifecycle(assetId))?.revokedAt);
  assert.equal((await call(bruno, 'GET', K)).status, 404);
  assert.equal((await call(bruno, 'PUT', K, kit())).status, 409);
  assert.equal((await upload(bruno, `${K}/import?from=logos`)).status, 409);
  const reopen = `/api/v1/programmes/exits/${done.body.exit}/reopen`;
  const dry = await call(bruno, 'POST', reopen, {});
  assert.equal(dry.body.companyKits[0].result, 'restored');
  assert.equal((await store.getCompanyProfile('northwind'))?.kit, undefined);
  assert.equal((await call(bruno, 'POST', reopen, { apply: true })).status, 200);
  assert.deepEqual((await store.getCompanyProfile('northwind'))?.kit, { assetId });
  assert.equal((await store.getLifecycle(assetId))?.revokedAt, undefined);
  rita = await login('rita@northwind.test');
  assert.ok((await feed(rita)).some((r) => r.id === assetId));
});

test('removing retires the asset, clears the pointer and lets the company save a new kit', async () => {
  assert.equal((await call(bruno, 'DELETE', K)).status, 200);
  assert.ok((await store.getLifecycle(assetId))?.revokedAt);
  assert.equal((await store.getCompanyProfile('northwind'))?.kit, undefined);
  assert.equal((await call(bruno, 'GET', K)).status, 404);
  assert.equal((await call(bruno, 'DELETE', K)).status, 404);
  assert.ok(!(await feed(rita)).some((r) => r.id === assetId));
  assert.equal((await call(rita, 'GET', '/api/v1/org-config')).body.partner.company.kit, undefined);
  const made = await call(bruno, 'PUT', K, kit());
  assert.equal(made.status, 200);
  assert.notEqual(made.body.assetId, assetId);
  assert.equal(made.body.revision, 1);
});

test('programme exit covers every company kit and Reopen keeps a later pointer', async () => {
  await call(bruno, 'PUT', '/api/v1/programmes/kit-exit', { name: 'Kit Exit' });
  const ids: Record<string, string> = {};
  for (const id of ['exit-a', 'exit-b']) {
    const at = `/api/v1/programmes/kit-exit/companies/${id}`;
    await call(bruno, 'PUT', at, { name: id });
    const made = await call(bruno, 'PUT', `${at}/kit`, { ...kit(id), logos: {} });
    assert.equal(made.status, 200);
    ids[id] = made.body.assetId;
  }
  const done = await call(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'kit-exit', apply: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.companyKits.length, 2);
  for (const id of Object.keys(ids)) {
    assert.equal((await store.getCompanyProfile(id))?.kit, undefined);
    assert.ok((await store.getLifecycle(ids[id]!))?.revokedAt);
  }
  await store.putCompanyKit('exit-b', { assetId: 'inst/later-kit' }, null);
  const reopened = await call(bruno, 'POST', `/api/v1/programmes/exits/${done.body.exit}/reopen`, { apply: true });
  assert.equal(reopened.status, 200);
  assert.deepEqual((await store.getCompanyProfile('exit-a'))?.kit, { assetId: ids['exit-a'] });
  assert.deepEqual((await store.getCompanyProfile('exit-b'))?.kit, { assetId: 'inst/later-kit' });
  assert.ok((await store.getLifecycle(ids['exit-b']!))?.revokedAt);
  for (const id of Object.keys(ids)) assert.equal((await call(bruno, 'DELETE', `/api/v1/programmes/kit-exit/companies/${id}`)).status, 200);
});

test('deleting a company deletes current and retired kits with every version', async () => {
  const records = (await store.listInstanceAssets()).filter((r) => r.entry.type === 'partner-kit');
  const blobIds = new Set(records.flatMap((r) => Object.values(r.blobs)));
  for (const rec of records) for (const row of await store.listAssetVersions(rec.id)) for (const f of row.formats) blobIds.add(f.blobId);
  assert.equal((await call(bruno, 'DELETE', `${AT}/northwind`)).status, 200);
  for (const rec of records) {
    assert.equal(await store.getInstanceAsset(rec.id), null);
    assert.deepEqual(await store.listAssetVersions(rec.id), []);
  }
  for (const id of blobIds) assert.equal(await blobs.get(id), null);
  assert.equal(await store.getCompanyProfile('northwind'), null);
});

test('kit audit payloads hold revision transitions and source lines only', async () => {
  const audits = (await store.listAudit()).filter((e) => e.action === 'programme.company.kit');
  assert.ok(audits.length >= 6);
  assert.deepEqual(audits[0]!.payload, { revisionBefore: null, revisionAfter: 1, source: { kind: 'manual' } });
  for (const row of audits) {
    assert.deepEqual(Object.keys(row.payload!).sort(), ['revisionAfter', 'revisionBefore', 'source']);
    assert.doesNotMatch(JSON.stringify(row.payload), /colours|#0b3d91|<svg|schemaVersion/);
  }
});
