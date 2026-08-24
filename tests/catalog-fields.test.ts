/**
 * Org-defined asset metadata (plans/31 section 4) over real HTTP.
 *
 * The gap this closes is "flat tags are the only taxonomy an org has", and it
 * closes it without touching the closed OSS asset schema. What the suite pins
 * down is the split that makes that possible: DEFINITIONS are policy, so they
 * ride the policy-as-code document and nothing else defines them; VALUES are a
 * local overlay keyed by CATALOG ASSET ID, so an instance asset, a federated
 * `ext/*` asset and a pack file on disk all take them; and the feed carries
 * them as one additive `fields` bag, which is what keeps every shell version
 * out of lockstep with this.
 *
 * The mock provider is config-managed and born enabled, so the federated arm
 * needs no network and no CRUD dance (the catalog-availability pattern).
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import {
  applyFieldPatch, composeAssetMeta, extractedHaystack, MAX_EXTRACTED_TEXT, normalizeCatalogField,
  normalizeExtractedText, servedFields, validateFieldValue,
  type AssetMetaRecord, type CatalogFieldDef,
} from '../server/src/catalog/asset-meta.ts';
import {
  buildConfigDocument, commitConfigApply, diffConfigDocument, validateConfigDocument,
} from '../server/src/policy/config-doc.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';
import type { AuditEvent } from '../server/src/audit/chain.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PACK_ASSET = 'suse/tokens/brand';
const EXT_ASSET = 'ext/dam1/a1';
const INST_ASSET = 'inst/aaaa1111';

const REGION: CatalogFieldDef = { id: 'region', label: 'Region', kind: 'select', options: ['EMEA', 'AMER'] };
const CAMPAIGN: CatalogFieldDef = { id: 'campaign', label: 'Campaign', kind: 'text' };
const SHOT_ON: CatalogFieldDef = { id: 'shot-on', label: 'Shot on', kind: 'date' };
const BRIEF: CatalogFieldDef = { id: 'brief', label: 'Brief', kind: 'url' };

interface Booted {
  base: string;
  store: ReturnType<typeof createMemoryStore>;
}

async function boot(overrides: Record<string, unknown> = {}): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-fields-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: PACK_ASSET, name: 'Brand tokens', type: 'tokens', tags: ['brand'], formats: [{ format: 'json', url: 'assets/brand.json' }] }],
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Fields Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
      { email: 'viewer@test', groups: ['viewer'] },
    ] },
    catalogProviders: [
      { id: 'dam1', kind: 'mock', label: 'Mock DAM', enabled: true, options: { assets: [
        { remoteId: 'a1', name: 'Upstream Hero', nativeType: 'file', sections: [], tags: [], formats: [{ format: 'png', remoteRef: 'att1' }] },
      ] } },
    ],
    ...overrides,
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sF', link: 'lF' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** An instance-owned asset without going through the submit pipeline - this
 *  suite is about the editor, not about how the bytes arrived. */
async function seedInstanceAsset(store: Booted['store']): Promise<void> {
  await store.putInstanceAsset({
    id: INST_ASSET,
    entry: {
      id: INST_ASSET, name: 'Campaign Hero', type: 'image', tags: ['campaign'],
      formats: [{ format: 'png', url: `/catalog/${INST_ASSET}/png`, size: 12, checksum: 'sha0' }],
    },
    blobs: { png: `${INST_ASSET}/png` },
    createdAt: '2026-08-19T00:00:00.000Z',
  });
}

async function defineFields(base: string, cookie: string, defs: CatalogFieldDef[]): Promise<void> {
  for (const def of defs) {
    const res = await fetch(`${base}/api/v1/catalog/fields/${def.id}`, {
      method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(def),
    });
    assert.equal(res.status, 200, `defining ${def.id}`);
  }
}

function putMeta(base: string, cookie: string, id: string, body: Record<string, unknown>): Promise<Response> {
  return fetch(`${base}/api/v1/catalog/assets/${id}/meta`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}

// -- the migration -----------------------------------------------------------

test('migration 0018 follows 0017 with nothing between, and declares both tables', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  // This stage owns 0018 and claims exactly one file. The CEILING is asserted by
  // whichever stage currently holds it (wave 4's collections suite pins 0019),
  // because a later wave legitimately adding the next number must not read as
  // this one having added two.
  const at = files.indexOf('0018_catalog_asset_meta.sql');
  assert.ok(at > 0, '0018 is on disk');
  assert.equal(files[at - 1], '0017_catalog_submissions.sql', 'and it follows 0017 with nothing between');
  const sql = await readFile(join(dir, '0018_catalog_asset_meta.sql'), 'utf8');
  assert.match(sql, /create table catalog_field_defs/);
  assert.match(sql, /create table catalog_asset_meta/);
  // Keyed by catalog asset id, and deliberately WITHOUT a foreign key: the id
  // may name a pack file or a federated asset this database does not hold.
  assert.match(sql, /asset_id\s+text primary key/);
  assert.equal(/references\s+instance_assets/i.test(sql), false, 'no foreign key into instance_assets');
  // The runner wraps each file in its own transaction.
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false);

  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into catalog_field_defs \(id, def\)/);
  assert.match(driver, /insert into catalog_asset_meta \(asset_id, record, updated_at\)/);
});

// -- definitions, in isolation ----------------------------------------------

test('a definition is validated per kind: select needs options, nothing else may carry them', () => {
  for (const kind of ['text', 'date', 'url'] as const) {
    assert.equal(normalizeCatalogField('f', { label: 'F', kind })?.kind, kind);
    assert.equal(normalizeCatalogField('f', { label: 'F', kind, options: ['a'] }), null, `${kind} may not carry options`);
  }
  assert.deepEqual(normalizeCatalogField('region', REGION)?.options, ['EMEA', 'AMER']);
  assert.equal(normalizeCatalogField('region', { label: 'Region', kind: 'select' }), null, 'a select with nothing to select from');
  assert.equal(normalizeCatalogField('region', { label: 'Region', kind: 'select', options: [] }), null);
  assert.equal(normalizeCatalogField('region', { label: 'Region', kind: 'colour' }), null, 'unknown kind');
  assert.equal(normalizeCatalogField('region', { kind: 'text' }), null, 'a field with no label');
  assert.equal(normalizeCatalogField('Region!', { label: 'Region', kind: 'text' }), null, 'id must be a slug');
  assert.equal(normalizeCatalogField('req', { label: 'R', kind: 'text', required: true })?.required, true);
  assert.equal(normalizeCatalogField('req', { label: 'R', kind: 'text' })?.required, undefined, 'not-required is absent, never false');
  // Duplicate options collapse, order kept: the console renders this list.
  assert.deepEqual(normalizeCatalogField('r', { label: 'R', kind: 'select', options: ['b', 'a', 'b'] })?.options, ['b', 'a']);
});

test('a value is validated against its kind, and the refusal says which field and why', () => {
  assert.equal(validateFieldValue(REGION, 'EMEA'), null);
  assert.match(validateFieldValue(REGION, 'APAC') ?? '', /region: "APAC" is not one of EMEA, AMER/);
  assert.equal(validateFieldValue(SHOT_ON, '2026-08-19'), null);
  assert.match(validateFieldValue(SHOT_ON, '19-08-2026') ?? '', /YYYY-MM-DD/);
  assert.match(validateFieldValue(SHOT_ON, '2026-02-31') ?? '', /not a real date/);
  assert.equal(validateFieldValue(BRIEF, 'https://brand.example/brief'), null);
  assert.match(validateFieldValue(BRIEF, 'javascript:alert(1)') ?? '', /http or https/);
  assert.match(validateFieldValue(BRIEF, 'not a url') ?? '', /not a URL/);
  assert.equal(validateFieldValue(CAMPAIGN, 'Q4 launch'), null);
  assert.match(validateFieldValue(CAMPAIGN, 'x'.repeat(501)) ?? '', /at most 500/);
});

test('a patch merges, clears on empty, refuses an unknown id, and enforces required on the RESULT', () => {
  const defs = [REGION, { ...CAMPAIGN, required: true }];
  const first = applyFieldPatch(defs, {}, { region: 'EMEA', campaign: 'Q4' });
  assert.deepEqual('values' in first ? first.values : null, { region: 'EMEA', campaign: 'Q4' });

  // Sparse: an absent key keeps what was stored.
  const merged = applyFieldPatch(defs, { region: 'EMEA', campaign: 'Q4' }, { region: 'AMER' });
  assert.deepEqual('values' in merged ? merged.values : null, { region: 'AMER', campaign: 'Q4' });

  const unknown = applyFieldPatch(defs, {}, { nope: 'x', campaign: 'Q4' });
  assert.ok('errors' in unknown && unknown.errors.some((e) => e.includes('unknown field "nope"')));

  // Required is checked on what the save LEAVES BEHIND, so clearing it fails
  // even though the patch itself carries a legal value for it.
  const cleared = applyFieldPatch(defs, { region: 'EMEA', campaign: 'Q4' }, { campaign: '' });
  assert.ok('errors' in cleared && cleared.errors.some((e) => e.includes('campaign (Campaign) is required')));
  // A non-required field clears with the empty string, and with null.
  const dropped = applyFieldPatch([REGION], { region: 'EMEA' }, { region: null });
  assert.deepEqual('values' in dropped ? dropped.values : null, {});

  // A value whose definition has been retired survives an unrelated edit: it is
  // hidden from every served surface already, and an edit of the field next to
  // it must not be what destroys it.
  const survives = applyFieldPatch([REGION], { region: 'EMEA', retired: 'kept' }, { region: 'AMER' });
  assert.deepEqual('values' in survives ? survives.values : null, { region: 'AMER', retired: 'kept' });
});

test('the served bag filters to LIVE definitions and orders by them, and the feed fold is additive', () => {
  const meta = { assetId: 'x', fields: { region: 'EMEA', retired: 'old value' }, updatedBy: 'user:u', updatedAt: 'now' };
  assert.deepEqual(servedFields([REGION], meta), { region: 'EMEA' }, 'a value with no definition is not served');
  assert.deepEqual(servedFields([], meta), {}, 'no definitions, nothing served');

  const index: AssetIndex = { assets: [{ id: 'x', name: 'X' }, { id: 'y', name: 'Y' }] };
  const composed = composeAssetMeta(index, [meta], [REGION]);
  assert.deepEqual(composed.assets?.[0], { id: 'x', name: 'X', fields: { region: 'EMEA' } });
  assert.deepEqual(composed.assets?.[1], { id: 'y', name: 'Y' }, 'an entry with no values is untouched');
  assert.equal(composeAssetMeta(index, [], [REGION]), index, 'nothing to fold returns the same index');
});

// -- definitions are policy --------------------------------------------------

test('the definitions ride the policy document: export, apply, re-apply, prune', async () => {
  const store = createMemoryStore();
  const doc = validateConfigDocument({
    kind: 'lolly-work/config', version: 1,
    grants: [], overlays: [], chains: [], providers: [], featureFlags: [],
    catalogFields: [REGION, CAMPAIGN],
  });
  assert.ok('doc' in doc, 'a document carrying field definitions validates');
  if (!('doc' in doc)) return;

  const first = diffConfigDocument(await buildConfigDocument(store), doc.doc, { prune: false }, new Set());
  assert.equal(first.catalogFields.create.length, 2);
  await commitConfigApply(store, first, 'u1');
  assert.deepEqual((await store.listCatalogFields()).map((f) => f.id), ['campaign', 'region']);

  // Round trip: what comes back out is what went in, and re-applying is a no-op.
  const exported = await buildConfigDocument(store);
  assert.deepEqual(exported.catalogFields, [CAMPAIGN, REGION]);
  const again = diffConfigDocument(exported, doc.doc, { prune: false }, new Set());
  assert.equal(again.catalogFields.unchanged.length, 2);
  assert.equal(again.catalogFields.update.length, 0);

  // A changed label is an update, not a second row.
  const relabel = validateConfigDocument({ ...doc.doc, catalogFields: [{ ...REGION, label: 'Sales region' }, CAMPAIGN] });
  assert.ok('doc' in relabel);
  if ('doc' in relabel) {
    const d = diffConfigDocument(await buildConfigDocument(store), relabel.doc, { prune: false }, new Set());
    assert.equal(d.catalogFields.update.length, 1);
    await commitConfigApply(store, d, 'u1');
    assert.equal((await store.listCatalogFields()).find((f) => f.id === 'region')?.label, 'Sales region');
  }

  // Prune removes the DEFINITION and nothing else: a value filed under it
  // survives, which is what makes retiring a field reversible.
  await store.putAssetMeta({ assetId: INST_ASSET, fields: { region: 'EMEA' }, updatedBy: 'user:u1', updatedAt: 'now' });
  const narrowed = validateConfigDocument({ ...doc.doc, catalogFields: [CAMPAIGN] });
  assert.ok('doc' in narrowed);
  if ('doc' in narrowed) {
    const d = diffConfigDocument(await buildConfigDocument(store), narrowed.doc, { prune: true }, new Set());
    assert.deepEqual(d.catalogFields.delete.map((f) => f.id), ['region']);
    await commitConfigApply(store, d, 'u1');
    assert.deepEqual((await store.listCatalogFields()).map((f) => f.id), ['campaign']);
    assert.equal((await store.getAssetMeta(INST_ASSET))?.fields.region, 'EMEA', 'the value outlives its definition');
  }
});

test('a malformed definition fails the whole document, path-tagged', () => {
  const bad = validateConfigDocument({
    kind: 'lolly-work/config', version: 1,
    grants: [], overlays: [], chains: [], providers: [], featureFlags: [],
    catalogFields: [{ id: 'region', label: 'Region', kind: 'select' }],
  });
  assert.ok('errors' in bad);
  if ('errors' in bad) assert.ok(bad.errors.some((e) => e.startsWith('catalogFields[0]')), bad.errors.join('; '));
});

// -- the route ---------------------------------------------------------------

test('values apply to all three id shapes: an instance asset, a federated one, and a pack file', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION, CAMPAIGN]);

  for (const id of [INST_ASSET, EXT_ASSET, PACK_ASSET]) {
    const res = await putMeta(base, admin, id, { fields: { region: 'EMEA', campaign: `for ${id}` } });
    assert.equal(res.status, 200, `${id} takes org fields`);
    const body = await res.json() as { fields: Record<string, string> };
    assert.equal(body.fields.region, 'EMEA');
    assert.equal((await store.getAssetMeta(id))?.fields.campaign, `for ${id}`);
  }

  // The inspect panel reads them back with the definitions beside them.
  const detail = await (await fetch(`${base}/api/v1/catalog/assets/${EXT_ASSET}`, { headers: { cookie: admin } })).json() as {
    fields: Record<string, string>; fieldDefs: CatalogFieldDef[]; canEdit: boolean;
  };
  assert.equal(detail.fields.region, 'EMEA');
  assert.deepEqual(detail.fieldDefs.map((f) => f.id), ['campaign', 'region']);
  assert.equal(detail.canEdit, true);
});

test('only an instance-owned asset takes an editable name, description and tags', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [CAMPAIGN]);

  const own = await putMeta(base, admin, INST_ASSET, { name: 'Campaign Hero 2026', tags: ['campaign', 'hero', 'campaign'], description: 'Q4 launch' });
  assert.equal(own.status, 200);
  const rec = await store.getInstanceAsset(INST_ASSET);
  assert.equal(rec?.entry.name, 'Campaign Hero 2026');
  assert.deepEqual(rec?.entry.tags, ['campaign', 'hero'], 'duplicates collapse');
  assert.equal(rec?.entry.description, 'Q4 launch');

  // A federated asset keeps the upstream name; a pack asset is a file on disk.
  for (const id of [EXT_ASSET, PACK_ASSET]) {
    const res = await putMeta(base, admin, id, { name: 'Renamed' });
    assert.equal(res.status, 400, `${id} has no editable name`);
    assert.match((await res.json() as { error: { message: string } }).error.message, /instance-owned/);
  }
  // An emptied description is removed, never stored blank.
  await putMeta(base, admin, INST_ASSET, { description: '  ' });
  assert.equal((await store.getInstanceAsset(INST_ASSET))?.entry.description, undefined);
  // And a name may not be emptied at all, on either surface.
  assert.equal((await putMeta(base, admin, INST_ASSET, { name: '   ' })).status, 400);
  assert.equal((await putMeta(base, admin, INST_ASSET, {})).status, 400, 'nothing to change');
});

test('the editor is `catalog.edit`: refused without it, and grantable to a group that is not admin', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [CAMPAIGN]);

  assert.equal((await putMeta(base, await login(base, 'viewer@test'), INST_ASSET, { fields: { campaign: 'Q4' } })).status, 403);
  // An author may CONTRIBUTE an asset and still not edit what the catalog says
  // about one: the two are different authorities on purpose.
  const author = await login(base, 'author@test');
  assert.equal((await putMeta(base, author, INST_ASSET, { fields: { campaign: 'Q4' } })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/${INST_ASSET}/meta`, { method: 'PUT', body: '{}' })).status, 401);

  // The design group buys it with one grant row, no admin role involved.
  await store.putGrant({ principal: 'group:design', action: 'catalog.edit', resource: '*', effect: 'allow' });
  assert.equal((await putMeta(base, author, INST_ASSET, { fields: { campaign: 'Q4' } })).status, 200);
  const canEdit = await (await fetch(`${base}/api/v1/catalog/fields`, { headers: { cookie: author } })).json() as { canEdit: boolean };
  assert.equal(canEdit.canEdit, true, 'the advertised bit tracks the grant, so the console offers what the PUT allows');

  // Defining the taxonomy is policy.edit, which the grant above does not buy.
  const defining = await fetch(`${base}/api/v1/catalog/fields/season`, {
    method: 'PUT', headers: { cookie: author, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Season', kind: 'text' }),
  });
  assert.equal(defining.status, 403, 'filling a field in is not defining one');
});

test('an unknown id, an unknown field and an invalid value are all refused, and nothing is stored', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION]);

  assert.equal((await putMeta(base, admin, 'inst/nope', { fields: { region: 'EMEA' } })).status, 404);
  assert.equal((await putMeta(base, admin, 'ext/dam1/missing', { fields: { region: 'EMEA' } })).status, 404);
  const unknown = await putMeta(base, admin, INST_ASSET, { fields: { nope: 'x' } });
  assert.equal(unknown.status, 400);
  assert.equal((await unknown.json() as { error: { code: string } }).error.code, 'INVALID_FIELDS');
  assert.equal((await putMeta(base, admin, INST_ASSET, { fields: { region: 'APAC' } })).status, 400);
  assert.equal((await putMeta(base, admin, INST_ASSET, { fields: ['region'] })).status, 400);
  assert.equal(await store.getAssetMeta(INST_ASSET), null, 'a refusal stores nothing');

  // Both halves are validated before either is written, so a good name beside a
  // bad value refuses whole rather than landing half of itself.
  const half = await putMeta(base, admin, INST_ASSET, { name: 'Renamed', fields: { region: 'APAC' } });
  assert.equal(half.status, 400);
  assert.equal((await store.getInstanceAsset(INST_ASSET))?.entry.name, 'Campaign Hero', 'the name did not move');
  assert.equal(await store.getAssetMeta(INST_ASSET), null);
});

test('every change is audited with its before and after', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION, CAMPAIGN]);

  await putMeta(base, admin, INST_ASSET, { fields: { region: 'EMEA' } });
  await putMeta(base, admin, INST_ASSET, { name: 'Hero 2026', fields: { region: 'AMER', campaign: 'Q4' } });

  const edits = (await store.listAudit()).filter((e: AuditEvent) => e.action === 'catalog.edit');
  assert.equal(edits.length, 2);
  const second = edits[1]?.payload as { before: Record<string, unknown>; after: Record<string, unknown> };
  assert.equal(second.before.name, 'Campaign Hero');
  assert.equal(second.after.name, 'Hero 2026');
  assert.deepEqual(second.before.fields, { region: 'EMEA' });
  assert.deepEqual(second.after.fields, { region: 'AMER', campaign: 'Q4' });
  assert.equal(edits[1]?.subject, `catalog:${INST_ASSET}`);

  // Defining and retiring a field is audited too, under its own action.
  await fetch(`${base}/api/v1/catalog/fields/campaign`, { method: 'DELETE', headers: { cookie: admin } });
  const defs = (await store.listAudit()).filter((e: AuditEvent) => e.action.startsWith('catalog.field.'));
  assert.deepEqual(defs.map((e) => e.action), ['catalog.field.edit', 'catalog.field.edit', 'catalog.field.delete']);
});

test('the feed carries the values as an additive bag, search matches them, and retiring a field hides them', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION, CAMPAIGN]);
  await putMeta(base, admin, PACK_ASSET, { fields: { region: 'EMEA', campaign: 'Autumn Launch' } });
  await putMeta(base, admin, EXT_ASSET, { fields: { region: 'AMER' } });

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as AssetIndex;
  const packEntry = feed.assets?.find((a) => a.id === PACK_ASSET) as { fields?: Record<string, string>; name?: string };
  assert.deepEqual(packEntry.fields, { campaign: 'Autumn Launch', region: 'EMEA' });
  assert.equal(packEntry.name, 'Brand tokens', 'the entry is otherwise untouched');
  assert.deepEqual((feed.assets?.find((a) => a.id === EXT_ASSET) as { fields?: unknown }).fields, { region: 'AMER' });
  assert.equal((feed.assets?.find((a) => a.id === INST_ASSET) as { fields?: unknown }).fields, undefined, 'no values, no key');

  // The haystack folds the values, so an org finds an asset by what it filed it under.
  const found = await (await fetch(`${base}/api/v1/catalog/search?q=autumn`, { headers: { cookie: admin } })).json() as {
    results: Array<{ id: string }>;
  };
  assert.deepEqual(found.results.map((r) => r.id), [PACK_ASSET]);

  // Retiring the definition takes its values off every served surface at once,
  // and leaves the stored value alone.
  assert.equal((await fetch(`${base}/api/v1/catalog/fields/campaign`, { method: 'DELETE', headers: { cookie: admin } })).status, 200);
  const after = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as AssetIndex;
  assert.deepEqual((after.assets?.find((a) => a.id === PACK_ASSET) as { fields?: unknown }).fields, { region: 'EMEA' });
  const gone = await (await fetch(`${base}/api/v1/catalog/search?q=autumn`, { headers: { cookie: admin } })).json() as { results: unknown[] };
  assert.equal(gone.results.length, 0);
  assert.equal((await store.getAssetMeta(PACK_ASSET))?.fields.campaign, 'Autumn Launch', 'the value is hidden, not destroyed');
});

// -- coherence with the submit review queue (plans/31 section 3) --------------

const CHAIN = {
  id: 'brand-review', name: 'Brand review',
  steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' as const }],
  onReject: 'return-to-submitter' as const,
};

/** A 1x1 PNG, real enough that the submit sniffer reads its IHDR. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

test('the review queue fills the SAME overlay before publication, and the published asset carries it', async () => {
  const { base, store } = await boot({ policy: { submit: { chain: 'brand-review' } } });
  await store.putChain(CHAIN);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION, CAMPAIGN]);

  const author = await login(base, 'author@test');
  const submitted = await fetch(`${base}/api/v1/catalog/submit?name=Campaign%20Hero`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG),
  });
  const { assetId } = await submitted.json() as { assetId: string };
  const short = assetId.replace(/^inst\//, '');

  // A pending submission is not visible yet, so the ASSET editor refuses it -
  // the review queue's own PATCH is the door while it waits.
  assert.equal((await putMeta(base, admin, assetId, { fields: { region: 'EMEA' } })).status, 404);

  const brand = await login(base, 'brand@test');
  const patched = await fetch(`${base}/api/v1/catalog/submissions/${short}`, {
    method: 'PATCH', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Campaign Hero 2026', fields: { region: 'EMEA', campaign: 'Q4' } }),
  });
  assert.equal(patched.status, 200);
  const view = (await patched.json() as { submission: { name: string; fields: Record<string, string> } }).submission;
  assert.equal(view.name, 'Campaign Hero 2026');
  assert.deepEqual(view.fields, { campaign: 'Q4', region: 'EMEA' });
  assert.deepEqual((await store.getAssetMeta(assetId))?.fields, { region: 'EMEA', campaign: 'Q4' });

  // A bad value is refused there exactly as it is in the asset editor.
  const bad = await fetch(`${base}/api/v1/catalog/submissions/${short}`, {
    method: 'PATCH', headers: { cookie: brand, 'content-type': 'application/json' },
    body: JSON.stringify({ fields: { region: 'APAC' } }),
  });
  assert.equal(bad.status, 400);
  assert.equal((await bad.json() as { error: { code: string } }).error.code, 'INVALID_FIELDS');

  // Publishing carries the values into the feed with no second edit.
  await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  const entry = feed.assets?.find((a) => a.id === assetId) as { fields?: Record<string, string>; name?: string };
  assert.equal(entry.name, 'Campaign Hero 2026');
  assert.deepEqual(entry.fields, { campaign: 'Q4', region: 'EMEA' });

  // …and from then on the asset editor owns it, on the same overlay.
  const live = await putMeta(base, admin, assetId, { fields: { region: 'AMER' } });
  assert.equal(live.status, 200);
  assert.deepEqual((await live.json() as { fields: Record<string, string> }).fields, { campaign: 'Q4', region: 'AMER' });
});

// -- on-device OCR text search (plans/31 section 7) ---------------------------

test('normalizeExtractedText collapses whitespace, caps length, and clears on empty; extractedHaystack folds it', () => {
  assert.equal(normalizeExtractedText('  Quarterly\n\n  Revenue\tReview  '), 'Quarterly Revenue Review');
  assert.equal(normalizeExtractedText(''), null, 'empty is a clear, not a stored blank');
  assert.equal(normalizeExtractedText('   \n\t '), null, 'whitespace-only collapses to a clear');
  assert.equal(normalizeExtractedText(42), null, 'a non-string is a clear');
  assert.equal(normalizeExtractedText('x'.repeat(MAX_EXTRACTED_TEXT + 500))?.length, MAX_EXTRACTED_TEXT, 'capped');

  assert.deepEqual(extractedHaystack({ extractedText: 'on the slide' } as AssetMetaRecord), ['on the slide']);
  assert.deepEqual(extractedHaystack({ fields: {} } as AssetMetaRecord), [], 'no text, no term');
  assert.deepEqual(extractedHaystack(null), []);
});

test('OCR text is searchable, whitespace-collapsed and capped, stays OFF the feed, and clears cleanly', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');

  // A pack asset (no editable name/tags) still takes the overlay text, so an
  // org can find a file on disk by the words printed on it.
  const set = await putMeta(base, admin, PACK_ASSET, { extractedText: '  Q4  Revenue\n\nForecast  ' });
  assert.equal(set.status, 200);
  assert.equal((await set.json() as { extractedTextChars?: number }).extractedTextChars, 'Q4 Revenue Forecast'.length);
  assert.equal((await store.getAssetMeta(PACK_ASSET))?.extractedText, 'Q4 Revenue Forecast', 'stored whitespace-collapsed');

  // Found by a word that appears NOWHERE in id/name/tags/fields - only in the text.
  const found = await (await fetch(`${base}/api/v1/catalog/search?q=forecast`, { headers: { cookie: admin } })).json() as {
    results: Array<{ id: string }>;
  };
  assert.deepEqual(found.results.map((r) => r.id), [PACK_ASSET]);

  // …but the served feed entry does NOT carry the OCR text: it is a search
  // index, not weight on every catalog card.
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as AssetIndex;
  const entry = feed.assets?.find((a) => a.id === PACK_ASSET) as Record<string, unknown>;
  assert.equal(entry.extractedText, undefined, 'no OCR text on the feed');

  // The cap holds end-to-end (the route stores at most MAX_EXTRACTED_TEXT).
  await putMeta(base, admin, INST_ASSET, { extractedText: 'z'.repeat(MAX_EXTRACTED_TEXT + 1000) });
  assert.equal((await store.getAssetMeta(INST_ASSET))?.extractedText?.length, MAX_EXTRACTED_TEXT);

  // Clearing removes the term, and the search stops matching.
  assert.equal((await putMeta(base, admin, PACK_ASSET, { extractedText: '' })).status, 200);
  assert.equal((await store.getAssetMeta(PACK_ASSET))?.extractedText, undefined, 'cleared, not blank');
  const gone = await (await fetch(`${base}/api/v1/catalog/search?q=forecast`, { headers: { cookie: admin } })).json() as { results: unknown[] };
  assert.equal(gone.results.length, 0);
});

test('OCR text shares the overlay with fields and supersession, and editing one leaves the others', async () => {
  const { base, store } = await boot();
  await seedInstanceAsset(store);
  const admin = await login(base, 'admin@test');
  await defineFields(base, admin, [REGION]);

  // Three independent overlay halves set together in one request.
  const all = await putMeta(base, admin, INST_ASSET, {
    fields: { region: 'EMEA' }, replacedBy: PACK_ASSET, extractedText: 'launch deck cover',
  });
  assert.equal(all.status, 200);
  let meta = await store.getAssetMeta(INST_ASSET) as AssetMetaRecord;
  assert.deepEqual(meta.fields, { region: 'EMEA' });
  assert.equal(meta.replacedBy, PACK_ASSET);
  assert.equal(meta.extractedText, 'launch deck cover');

  // Editing ONLY the fields must not disturb the text or the supersession.
  assert.equal((await putMeta(base, admin, INST_ASSET, { fields: { region: 'AMER' } })).status, 200);
  meta = await store.getAssetMeta(INST_ASSET) as AssetMetaRecord;
  assert.deepEqual(meta.fields, { region: 'AMER' });
  assert.equal(meta.replacedBy, PACK_ASSET, 'supersession survived a fields-only edit');
  assert.equal(meta.extractedText, 'launch deck cover', 'OCR text survived a fields-only edit');

  // Editing ONLY the text must not disturb the fields or the supersession.
  assert.equal((await putMeta(base, admin, INST_ASSET, { extractedText: 'launch deck, revised' })).status, 200);
  meta = await store.getAssetMeta(INST_ASSET) as AssetMetaRecord;
  assert.deepEqual(meta.fields, { region: 'AMER' }, 'fields survived a text-only edit');
  assert.equal(meta.replacedBy, PACK_ASSET, 'supersession survived a text-only edit');
  assert.equal(meta.extractedText, 'launch deck, revised');

  // Clearing ONLY the supersession leaves the other two standing.
  assert.equal((await putMeta(base, admin, INST_ASSET, { replacedBy: '' })).status, 200);
  meta = await store.getAssetMeta(INST_ASSET) as AssetMetaRecord;
  assert.equal(meta.replacedBy, undefined);
  assert.deepEqual(meta.fields, { region: 'AMER' });
  assert.equal(meta.extractedText, 'launch deck, revised');
});

test('a plain submitter attaches OCR text to their pending submission, and it is searchable once published', async () => {
  const { base, store } = await boot({ policy: { submit: { chain: 'brand-review' } } });
  await store.putChain(CHAIN);

  // author holds catalog.submit but NOT catalog.edit, so the live-asset editor
  // is not their door - the review queue's PATCH is, exactly as it is for fields.
  const author = await login(base, 'author@test');
  const { assetId } = await (await fetch(`${base}/api/v1/catalog/submit?name=Roadmap%20Slide`, {
    method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG),
  })).json() as { assetId: string };
  const short = assetId.replace(/^inst\//, '');

  // The live-asset editor refuses the submitter here (no catalog.edit)…
  assert.equal((await putMeta(base, author, assetId, { extractedText: 'x' })).status, 403);

  // …but the review queue accepts their own reading of their own file.
  const patched = await fetch(`${base}/api/v1/catalog/submissions/${short}`, {
    method: 'PATCH', headers: { cookie: author, 'content-type': 'application/json' },
    body: JSON.stringify({ extractedText: '  Migration  timeline\n\nH2 rollout  ' }),
  });
  assert.equal(patched.status, 200);
  assert.equal((await store.getAssetMeta(assetId))?.extractedText, 'Migration timeline H2 rollout');

  // A pending submission is not in the feed, so it is not searchable yet.
  const brand = await login(base, 'brand@test');
  assert.equal((await (await fetch(`${base}/api/v1/catalog/search?q=rollout`, { headers: { cookie: brand } })).json() as { results: unknown[] }).results.length, 0);

  // Approve, and the words on the slide find it - no second edit after the decision.
  await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  const found = await (await fetch(`${base}/api/v1/catalog/search?q=rollout`, { headers: { cookie: author } })).json() as { results: Array<{ id: string }> };
  assert.deepEqual(found.results.map((r) => r.id), [assetId]);
});
