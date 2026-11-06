// SPDX-License-Identifier: MPL-2.0
/**
 * A manager's edit, end to end in process: who may send one, what a document may
 * change, how it reaches a render and a signed catalogue, how it rolls back, and what
 * a new image does to it. Pure comparison is tested first, then the routes.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import { applyBrandChanges, brandPageAddress, BrandEditRefusal, checkDocumentShape, compareBrandDocument, describeBrandChanges, outOfScopeMessage } from '../server/src/brand/edit-document.ts';
import { deriveInstancePack, inspectInstancePack, instancePackTokensChecksum } from '../server/src/catalog/instance-pack.ts';
import { createCatalogSigning } from '../server/src/catalog/signing.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';
import { canonicalJson } from '../server/src/lib/crypto.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';
import { GROUP_NAMED_ROLES, roleAllows, roleFromGroups } from '../server/src/rbac/evaluate.ts';
import { routeScopes } from '../server/src/iam/token-scopes.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store } from '../server/src/store/types.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const servers: Server[] = [];
const scratch: string[] = [];
after(() => { for (const server of servers) server.close(); for (const dir of scratch) rmSync(dir, { recursive: true, force: true }); });

const sha256 = (bytes: Buffer | string): string => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes: Buffer | string): string => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** An invented textile brand, with one colourway, light and dark. */
function tokens(): Record<string, any> {
  return {
    $description: 'Wefthouse',
    $metadata: { tokenSetOrder: ['base', 'light', 'dark', 'colourway/indigo'] },
    $themes: [
      { name: 'light', selectedTokenSets: { base: 'enabled', light: 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'mode' } } } },
      { name: 'dark', selectedTokenSets: { base: 'enabled', dark: 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'mode' } } } },
      { id: 'indigo', name: 'Indigo', group: 'colourway', selectedTokenSets: { 'colourway/indigo': 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'colourway', canonical: true } } } },
    ],
    $extensions: { 'com.suse.lolly': { brandSystem: {
      schemaVersion: 1, id: 'wefthouse', label: 'Wefthouse',
      roles: [{ id: 'typeface', label: 'Typeface', resources: [{ type: 'token', path: 'font.brand' }] }],
      bindings: [],
      rules: [{ id: 'headline', label: 'Headlines', kind: 'text-weight', roleIds: ['typeface'], parameters: { target: 'headline', weights: ['500'] }, requirement: 'advisory', origin: { kind: 'manual', author: 'Wefthouse' }, review: { state: 'draft' } }],
    } } },
    base: {
      color: { $type: 'color', brand: { indigo: { $value: '#1b2a6b' }, madder: { $value: '#a63a2a' } } },
      font: { brand: { $type: 'fontFamily', $value: 'Inter' } },
      asset: { logo: { $type: 'asset', $value: 'wefthouse/logo/primary' } },
    },
    light: { color: { semantic: { primary: { $type: 'color', $value: '{color.colourway.light.primary}' } } } },
    dark: { color: { semantic: { primary: { $type: 'color', $value: '{color.colourway.dark.primary}' } } } },
    'colourway/indigo': { color: { colourway: {
      light: { primary: { $type: 'color', $value: '{color.brand.indigo}' } },
      dark: { primary: { $type: 'color', $value: '#8fa2ff' } },
    } } },
  };
}

// ── What a document may change ───────────────────────────────────────────────

const colourChange = (doc: Record<string, any>): Record<string, any> => { doc.base.color.brand.indigo.$value = '#223377'; return doc; };

test('changing a colour is in scope, and the change is named', () => {
  const base = tokens(), doc = colourChange(tokens());
  const out = compareBrandDocument(base, doc);
  assert.deepEqual(out.outOfScope, []);
  assert.deepEqual(out.invalid, []);
  assert.equal(out.changes.length, 1);
  assert.deepEqual(describeBrandChanges(out.changes), [{ kind: 'colour', name: 'base: color.brand.indigo', action: 'changed', before: '#1b2a6b', after: '#223377' }]);
});

test('an unchanged document changes nothing', () => {
  const out = compareBrandDocument(tokens(), tokens());
  assert.deepEqual(out, { changes: [], outOfScope: [], invalid: [] });
});

test('a change outside the slice is named, whatever it is', () => {
  const cases: Array<[string, (doc: Record<string, any>) => void, RegExp]> = [
    ['a font', doc => { doc.base.font.brand.$value = 'Comic Sans'; }, /base\.font/],
    ['a logo', doc => { doc.base.asset.logo.$value = 'evil/logo'; }, /base\.asset/],
    ['a house rule', doc => { doc.$extensions['com.suse.lolly'].brandSystem.rules = []; }, /brandSystem\.rules/],
    ['the name', doc => { doc.$extensions['com.suse.lolly'].brandSystem.label = 'Other'; }, /brandSystem\.label/],
    ['a role that is not a colour role', doc => { doc.$extensions['com.suse.lolly'].brandSystem.roles[0].label = 'Type'; }, /not a colour role/],
    ['a mode', doc => { doc.$themes[0].name = 'day'; }, /not a colourway/],
    ['the document description', doc => { doc.$description = 'Other'; }, /\$description/],
    ['a new set that is no colourway', doc => { doc.extra = { color: {} }; doc.$metadata.tokenSetOrder.push('extra'); }, /the set extra/],
    ['set precedence', doc => { doc.$metadata.tokenSetOrder = ['dark', 'light', 'base', 'colourway/indigo']; }, /tokenSetOrder/],
    ['another setting', doc => { doc.$extensions['com.suse.lolly'].shareCards = 'other'; }, /shareCards/],
    ['another vendor', doc => { doc.$extensions.other = { a: 1 }; }, /\$extensions\.other/],
    ['a colourway set holding more than colours', doc => { doc['colourway/rust'] = { color: {}, font: {} }; doc.$metadata.tokenSetOrder.push('colourway/rust'); }, /colourway\/rust/],
  ];
  for (const [what, change, name] of cases) {
    const doc = tokens();
    change(doc);
    const out = compareBrandDocument(tokens(), doc);
    assert.match(outOfScopeMessage(out.outOfScope), name, what);
    assert.ok(out.outOfScope.length, what);
  }
  assert.match(outOfScopeMessage(['base.font']), /This edit also changes base\.font\. This instance takes colours, colour roles and the brand page address, so nothing was saved\./);
});

test('a colour that is not a colour is refused, and cannot leave a declaration', () => {
  for (const value of ['url(https://evil.example/x)', 'red;--x:1', '</style><script>', '#12', 'expression(alert(1))', 'var(--secret)', 'rgb(0 0 0) url(x)', 'linear-gradient(url(x))', 'a'.repeat(40), { a: 'url(x)' }, ['red;'], 42 as unknown as string]) {
    const doc = tokens();
    doc.base.color.brand.indigo.$value = value;
    const out = compareBrandDocument(tokens(), doc);
    if (typeof value === 'number') { assert.equal(out.invalid.length, 0, 'a bare number is a value the engine ignores'); continue; }
    assert.ok(out.invalid.some(line => /not a colour value/.test(line)), `${JSON.stringify(value)} -> ${JSON.stringify(out.invalid)}`);
  }
  for (const value of ['#fff', '#112233', '#11223344', 'transparent', 'rgb(0 0 0 / 50%)', 'oklch(70% 0.1 200)', 'color-mix(in oklab, red, blue)', 'linear-gradient(90deg, #fff, rgb(0 0 0))', { colorSpace: 'srgb', components: [0, 0, 0], hex: '#000000' }, { stops: [{ color: '{color.brand.madder}', position: 0 }] }]) {
    const doc = tokens();
    doc.base.color.brand.indigo.$value = value;
    assert.deepEqual(compareBrandDocument(tokens(), doc).invalid, [], JSON.stringify(value));
  }
});

test('a token can only be a colour, with inert settings', () => {
  const doc = tokens();
  doc.base.color.brand.indigo.$type = 'dimension';
  assert.match(compareBrandDocument(tokens(), doc).invalid.join(), /only a colour or a gradient/);
  const extra = tokens();
  extra.base.color.brand.indigo.$script = 'x';
  assert.match(compareBrandDocument(tokens(), extra).invalid.join(), /cannot hold \$script/);
  const hostile = tokens();
  hostile.base.color.brand.indigo.$extensions = { 'com.suse.lolly': { spot: { name: 'a</style>' } } };
  assert.match(compareBrandDocument(tokens(), hostile).invalid.join(), /settings cannot be used/);
  const fine = tokens();
  fine.base.color.brand.indigo.$extensions = { 'com.suse.lolly': { cmyk: [0, 0, 0, 100], spot: { name: 'PMS 287' }, colourRole: { derived: true } } };
  assert.deepEqual(compareBrandDocument(tokens(), fine).invalid, []);
  const named = tokens();
  named.base.color.brand['a"b'] = { $value: '#fff' };
  assert.match(compareBrandDocument(tokens(), named).invalid.join(), /cannot be used for a colour/);
  const flat = tokens();
  flat.base.color = 'red';
  assert.match(compareBrandDocument(tokens(), flat).invalid.join(), /group of colours/);
});

test('hostile shapes are refused before anything walks them', () => {
  const refused = (raw: string, pattern: RegExp) => assert.throws(() => checkDocumentShape(JSON.parse(raw)), (error: unknown) => error instanceof BrandEditRefusal && pattern.test(error.message));
  refused('[]', /one JSON object/);
  refused('null', /one JSON object/);
  refused('{"__proto__":{"polluted":1}}', /reserved name/);
  refused('{"a":{"constructor":{}}}', /reserved name/);
  refused('{"a":{"prototype":1}}', /reserved name/);
  refused(JSON.stringify({ ['a\u0000b']: 1 }), /control characters/);
  refused(`${'{"a":'.repeat(60)}1${'}'.repeat(60)}`, /nests too deeply/);
  assert.equal(({} as { polluted?: number }).polluted, undefined);
});

test('nothing dangles: an alias, a role or a colourway has to land on something that exists', () => {
  const alias = tokens();
  alias.base.color.brand.indigo.$value = '{color.brand.gone}';
  assert.match(compareBrandDocument(tokens(), alias).invalid.join(), /names \{color\.brand\.gone\}/);
  const removed = tokens();
  delete removed.base.color.brand.indigo;
  assert.match(compareBrandDocument(tokens(), removed).invalid.join(), /still points at color\.brand\.indigo/);
  const role = tokens();
  role.$extensions['com.suse.lolly'].brandSystem.roles.push({ id: 'main', label: 'Main', group: 'colourway', resources: [{ type: 'token', path: 'color.semantic.main' }] });
  assert.match(compareBrandDocument(tokens(), role).invalid.join(), /names color\.semantic\.main/);
  const theme = tokens();
  theme.$themes.push({ id: 'rust', name: 'Rust', group: 'colourway', selectedTokenSets: { 'colourway/rust': 'enabled' } });
  assert.match(compareBrandDocument(tokens(), theme).invalid.join(), /turns on colourway\/rust/);
});

/** A document in the shape colour roles write: the brand's words, bound by aliases. */
function withRoles(): Record<string, any> {
  const doc = tokens();
  const brand = doc.$extensions['com.suse.lolly'].brandSystem;
  brand.roles.push(
    { id: 'main', label: 'Main', description: 'The ground colour', group: 'colourway', resources: [{ type: 'token', path: 'color.semantic.main' }] },
    { id: 'accent', label: 'Accent', group: 'colourway', resources: [{ type: 'token', path: 'color.semantic.accent' }] },
  );
  brand.bindings.push({ id: 'lead', roleId: 'main', consumer: { slot: 'primary' } });
  doc.light.color.semantic.main = { $type: 'color', $value: '{color.colourway.light.main}' };
  doc.light.color.semantic.accent = { $type: 'color', $value: '{color.colourway.light.accent}' };
  doc.dark.color.semantic.main = { $type: 'color', $value: '{color.colourway.dark.main}' };
  doc.dark.color.semantic.accent = { $type: 'color', $value: '{color.colourway.dark.accent}' };
  const way = doc['colourway/indigo'].color.colourway;
  way.light.main = { $type: 'color', $value: '#1b2a6b' };
  way.light.accent = { $type: 'color', $value: '#a63a2a' };
  way.light['on-main'] = { $type: 'color', $value: 'oklch(100% 0 0)', $extensions: { 'com.suse.lolly': { colourRole: { derived: true } } } };
  way.dark.main = { $type: 'color', $value: '#8fa2ff' };
  way.dark.accent = { $type: 'color', $value: '#ffb4a2' };
  way.light.primary.$value = '{color.colourway.light.main}';
  way.dark.primary.$value = '{color.colourway.dark.main}';
  return doc;
}

test('colour roles and bindings are in scope, and the rules around them are not', () => {
  const out = compareBrandDocument(tokens(), withRoles());
  assert.deepEqual(out.outOfScope, []);
  assert.deepEqual(out.invalid, []);
  const lines = describeBrandChanges(out.changes);
  assert.ok(lines.some(line => line.kind === 'role' && line.name === 'main' && line.after === 'Main'));
  assert.ok(lines.some(line => line.kind === 'binding' && line.name === 'lead' && line.after === 'main as primary'));
});

test('role ids and text follow the studio\'s rules', () => {
  const bad = (id: string, label = 'Word') => {
    const doc = withRoles();
    doc.$extensions['com.suse.lolly'].brandSystem.roles.push({ id, label, group: 'colourway', resources: [] });
    return compareBrandDocument(tokens(), doc).invalid.join();
  };
  for (const id of ['Main', 'a1', '1a', 'on-main', 'token-a', 'a'.repeat(33), 'warn']) assert.notEqual(bad(id), '', id);
  assert.equal(bad('supporting'), '');
  assert.match(bad('supporting', 'a\u0000b'), /plain label/);
  assert.match(bad('supporting', 'x'.repeat(81)), /plain label/);
  const binding = withRoles();
  binding.$extensions['com.suse.lolly'].brandSystem.bindings.push({ id: 'type', roleId: 'typeface', consumer: { slot: 'primary' } });
  assert.match(compareBrandDocument(tokens(), binding).invalid.join(), /names a colour role this document does not have/);
  const twice = withRoles();
  twice.$extensions['com.suse.lolly'].brandSystem.roles.push({ id: 'main', label: 'Again', group: 'colourway', resources: [] });
  assert.match(compareBrandDocument(tokens(), twice).invalid.join(), /share one id/);
  const asset = withRoles();
  asset.$extensions['com.suse.lolly'].brandSystem.roles.push({ id: 'cloth', label: 'Cloth', group: 'colourway', resources: [{ type: 'asset', id: 'x' }] });
  assert.match(compareBrandDocument(tokens(), asset).invalid.join(), /can only name colour tokens/);
});

test('a system with no record can gain roles and bindings, and nothing more', () => {
  const blank = tokens();
  delete blank.$extensions;
  const doc = withRoles();
  doc.$extensions['com.suse.lolly'].brandSystem.roles = doc.$extensions['com.suse.lolly'].brandSystem.roles.filter((role: { group?: string }) => role.group === 'colourway');
  doc.$extensions['com.suse.lolly'].brandSystem.rules = [];
  const out = compareBrandDocument(blank, doc);
  assert.deepEqual(out.outOfScope, []);
  assert.deepEqual(out.invalid, []);
  assert.equal(out.changes.filter(change => change.kind === 'system').length, 1);
  doc.$extensions['com.suse.lolly'].brandSystem.rules = tokens().$extensions['com.suse.lolly'].brandSystem.rules;
  assert.match(compareBrandDocument(blank, doc).outOfScope.join(), /brandSystem\.rules/);
});

test('a colourway can be added or removed, with its theme and its place in the order', () => {
  const doc = tokens();
  doc['colourway/rust'] = { color: { colourway: { light: { primary: { $type: 'color', $value: '#a63a2a' } } } } };
  doc.$themes.push({ id: 'rust', name: 'Rust', group: 'colourway', selectedTokenSets: { 'colourway/rust': 'enabled' }, $extensions: { 'com.suse.lolly': { axis: { kind: 'colourway' } } } });
  doc.$metadata.tokenSetOrder.push('colourway/rust');
  const added = compareBrandDocument(tokens(), doc);
  assert.deepEqual(added.outOfScope, []);
  assert.deepEqual(added.invalid, []);
  assert.deepEqual(describeBrandChanges(added.changes).map(line => [line.kind, line.action]), [['colourway', 'added']], 'one line for the set and its theme');
  const removed = compareBrandDocument(doc, tokens());
  assert.deepEqual(removed.outOfScope, []);
  assert.deepEqual(removed.invalid, []);
  assert.deepEqual(canonicalJson(applyBrandChanges(doc, removed.changes).doc), canonicalJson(tokens()));
});

test('a change line carries the name a person gave the colour, as bounded plain text', () => {
  const base = tokens();
  const named = structuredClone(base) as any;
  named.base.color.brand.indigo = { $type: 'color', $value: '#1b2a6b', $description: 'Ink' };
  const edited = structuredClone(named) as any;
  edited.base.color.brand.indigo.$value = '#7a2cc8';
  const [line] = describeBrandChanges(compareBrandDocument(named, edited).changes);
  assert.equal(line!.label, 'Ink');
  assert.equal(line!.name, 'base: color.brand.indigo');
  edited.base.color.brand.indigo.$description = 'x'.repeat(400);
  assert.equal(describeBrandChanges(compareBrandDocument(named, edited).changes)[0]!.label!.length, 80);
});

test('a first colourway may note which themes are light and dark, and nothing else about them', () => {
  const plain = tokens();
  for (const theme of plain.$themes.slice(0, 2)) delete theme.$extensions;
  const out = compareBrandDocument(plain, tokens());
  assert.deepEqual(out.outOfScope, []);
  assert.deepEqual(out.invalid, []);
  assert.deepEqual(out.changes.map(change => change.kind), ['mode-note', 'mode-note']);
  assert.equal(canonicalJson(applyBrandChanges(plain, out.changes).doc), canonicalJson(tokens()));
  assert.deepEqual(describeBrandChanges(out.changes), [], 'not a change anyone chose');
  const more = tokens();
  for (const theme of more.$themes.slice(0, 2)) theme.selectedTokenSets = { base: 'enabled' };
  assert.match(compareBrandDocument(plain, more).outOfScope.join(), /not a colourway/);
  const other = tokens();
  other.$themes[0].$extensions['com.suse.lolly'].axis = { kind: 'surface' };
  assert.match(compareBrandDocument(plain, other).outOfScope.join(), /not a colourway/);
});

test('the brand page address reads the same as Lolly\'s engine rule', () => {
  // The cases in Lolly's tests for engine/src/brand-page-address.ts.
  for (const good of ['https://acme.example/', 'https://acme.example/brand/acme/', 'HTTPS://ACME.example/x']) assert.ok(brandPageAddress(good), good);
  assert.equal(brandPageAddress('https://acme.example'), 'https://acme.example/');
  for (const bad of ['http://acme.example/', 'javascript:alert(1)', 'https://user:pw@acme.example/', 'https://acme.example/?a=1', 'https://acme.example/#x', 'https://localhost/', 'https://a.localhost/', 'https://127.0.0.1/', 'https://[::1]/', 'https://acme.example./', 'https://acme.example/a b', `https://acme.example/${'x'.repeat(520)}`, '', null, 42]) assert.equal(brandPageAddress(bad), null, String(bad));
  const set = tokens();
  set.$extensions['com.suse.lolly'].exportRecord = { brandPage: 'https://acme.example/brand/' };
  assert.deepEqual(describeBrandChanges(compareBrandDocument(tokens(), set).changes).map(line => line.after), ['https://acme.example/brand/']);
  set.$extensions['com.suse.lolly'].exportRecord = { brandPage: 'http://acme.example/' };
  assert.match(compareBrandDocument(tokens(), set).invalid.join(), /plain https address/);
  set.$extensions['com.suse.lolly'].exportRecord = { brandPage: 'https://acme.example/', other: 1 };
  assert.match(compareBrandDocument(tokens(), set).outOfScope.join(), /exportRecord\.other/);
});

// ── Landing on a base ────────────────────────────────────────────────────────

test('changes land back on their own base as the document that made them', () => {
  for (const doc of [colourChange(tokens()), withRoles()]) {
    const out = compareBrandDocument(tokens(), doc);
    const landed = applyBrandChanges(tokens(), out.changes);
    assert.deepEqual(landed.gone, []);
    assert.deepEqual(landed.overlaps, []);
    assert.equal(canonicalJson(landed.doc), canonicalJson(doc));
  }
  const address = tokens();
  address.$extensions['com.suse.lolly'].exportRecord = { brandPage: 'https://acme.example/' };
  const out = compareBrandDocument(tokens(), address);
  assert.equal(canonicalJson(applyBrandChanges(tokens(), out.changes).doc), canonicalJson(address));
  // Clearing it prunes what it added.
  const back = compareBrandDocument(address, tokens());
  assert.equal(canonicalJson(applyBrandChanges(address, back.changes).doc), canonicalJson(tokens()));
});

test('on a new image an edit lands on what changed elsewhere, and says where both changed the same thing', () => {
  const { changes } = compareBrandDocument(tokens(), colourChange(tokens()));
  const image = tokens();
  image.base.font.brand.$value = 'Söhne';
  image.base.color.brand.madder.$value = '#ff0000';
  const landed = applyBrandChanges(image, changes);
  assert.deepEqual(landed.gone, []);
  assert.deepEqual(landed.overlaps, []);
  assert.equal(landed.doc.base && (landed.doc.base as any).font.brand.$value, 'Söhne', 'the new image is kept');
  assert.equal((landed.doc.base as any).color.brand.madder.$value, '#ff0000');
  assert.equal((landed.doc.base as any).color.brand.indigo.$value, '#223377', 'the edit stays on top');
  const both = tokens();
  both.base.color.brand.indigo.$value = '#000000';
  const overlap = applyBrandChanges(both, changes);
  assert.deepEqual(overlap.overlaps, ['base: color.brand.indigo']);
  assert.equal((overlap.doc.base as any).color.brand.indigo.$value, '#223377');
});

test('an edit that names something the image dropped does not land, and says what', () => {
  const { changes } = compareBrandDocument(tokens(), colourChange(tokens()));
  const image = tokens();
  delete image.base.color.brand.indigo;
  image['colourway/indigo'].color.colourway.light.primary.$value = '#000000';
  assert.deepEqual(applyBrandChanges(image, changes).gone, ['base: color.brand.indigo']);

  const roles = compareBrandDocument(tokens(), withRoles());
  const noSystem = tokens();
  delete noSystem.$extensions;
  assert.ok(applyBrandChanges(noSystem, roles.changes).gone.some(line => /no list of roles/.test(line)));

  const aliased = tokens();
  aliased.base.color.brand.indigo.$value = '{color.brand.madder}';
  const change = compareBrandDocument(tokens(), aliased).changes;
  const noMadder = tokens();
  delete noMadder.base.color.brand.madder;
  assert.ok(applyBrandChanges(noMadder, change).gone.some(line => /names \{color\.brand\.madder\}/.test(line)));
});

// ── The instance ─────────────────────────────────────────────────────────────

const privateKeyPem = (): string => generateKeyPairSync('ec', { namedCurve: 'P-256' }).privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;

interface HarnessOptions {
  doc?: Record<string, any>;
  store?: Store;
  blobs?: BlobStore;
  signingKey?: string | null;
  grants?: boolean;
}

function writePack(doc: Record<string, any>): string {
  const pack = mkdtempSync(join(tmpdir(), 'lw-brand-edit-pack-'));
  scratch.push(pack);
  const tool = { id: 'swatch', name: 'Swatch', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', render: { width: 100, height: 100, formats: ['svg'] }, inputs: [{ id: 'heading', type: 'text', label: 'Heading' }], hooks: { onInit: true } };
  mkdirSync(join(pack, 'tools', 'swatch'), { recursive: true });
  writeFileSync(join(pack, 'tools', 'swatch', 'tool.json'), JSON.stringify(tool));
  writeFileSync(join(pack, 'tools', 'swatch', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="{{ink}}"/></svg>');
  writeFileSync(join(pack, 'tools', 'swatch', 'hooks.js'), "async function onInit(){ return { ink: await host.tokens.resolve('color.brand.indigo') }; }");
  mkdirSync(join(pack, 'catalog', 'assets', 'wefthouse', 'tokens'), { recursive: true });
  mkdirSync(join(pack, 'catalog', 'tools'), { recursive: true });
  const bytes = JSON.stringify(doc);
  writeFileSync(join(pack, 'catalog', 'assets', 'wefthouse', 'tokens', 'brand.json'), bytes);
  writeFileSync(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ brandTokens: 'wefthouse/tokens/brand', assets: [
    { id: 'wefthouse/tokens/brand', name: 'Wefthouse tokens', version: '1.0.0', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/wefthouse/tokens/brand.json', checksum: sri(bytes), size: bytes.length }] },
  ] }));
  writeFileSync(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
  return pack;
}

async function harness(options: HarnessOptions = {}) {
  const store = options.store ?? createMemoryStore(), blobs = options.blobs ?? createMemoryBlobStore();
  const pack = writePack(options.doc ?? tokens());
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Wefthouse', baseUrl: 'http://brand.example', pack, brandTokens: { mounted: 'wefthouse/tokens/brand' } },
    idp: { roleGroups: { 'brand-manager': ['brand-team'] } },
    policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false }, render: { allowHooksInFastPath: true },
    dev: { enabled: true, users: [
      { email: 'owner@test', name: 'Owner', groups: ['owner'] }, { email: 'admin@test', name: 'Admin', groups: ['admin'] },
      { email: 'manager@test', name: 'Manager', groups: ['brand-team'] }, { email: 'member@test', name: 'Member', groups: [] },
      { email: 'review@test', name: 'Reviewer', groups: ['approver'] }, { email: 'lookalike@test', name: 'Lookalike', groups: ['brand-manager'] },
    ] },
  }));
  const signingKey = options.signingKey === undefined ? privateKeyPem() : options.signingKey;
  const app = buildApp({ config, store, blobs, secrets: { session: 'test-session', link: 'test-link', webhook: 'test-webhook', ...(signingKey ? { catalogSigningKey: signingKey } : {}) } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session'))?.split(';')[0] ?? '';
  const cookies = { owner: await login('owner@test'), admin: await login('admin@test'), manager: await login('manager@test'), member: await login('member@test'), reviewer: await login('review@test'), lookalike: await login('lookalike@test') };
  const call = (method: string, path: string, body?: unknown, cookie: string = cookies.manager) => fetch(`${base}${path}`, { method, headers: { cookie, ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const read = async (path: string, cookie: string = cookies.manager) => { const res = await call('GET', path, undefined, cookie); return { status: res.status, body: await res.json() as any }; };
  const docOf = async () => (await read('/api/v1/brand/edits/document')).body;
  const state = async (cookie: string = cookies.manager) => (await read('/api/v1/brand/edits', cookie)).body;
  const envelope = (doc: unknown, baseChecksum: string, text = JSON.stringify(doc)) => ({ document: text, digest: sha256(text), base: baseChecksum });
  const previewDoc = async (doc: unknown, cookie: string = cookies.manager) => {
    const baseChecksum = (await docOf()).baseChecksum;
    const res = await call('POST', '/api/v1/brand/edits/preview', envelope(doc, baseChecksum), cookie);
    return { status: res.status, body: await res.json() as any, baseChecksum };
  };
  const send = async (doc: unknown, cookie: string = cookies.manager) => {
    const reviewed = await previewDoc(doc, cookie);
    assert.equal(reviewed.status, 200, JSON.stringify(reviewed.body));
    const res = await call('POST', '/api/v1/brand/edits', { ...envelope(doc, reviewed.baseChecksum), revision: reviewed.body.revision, reviewToken: reviewed.body.reviewToken }, cookie);
    return { status: res.status, body: await res.json() as any };
  };
  const servedDoc = async (cookie: string = cookies.member) => {
    const index = (await read('/catalog/assets/index.json', cookie)).body;
    const asset = index.assets.find((row: { id: string }) => row.id === 'wefthouse/tokens/brand');
    const res = await call('GET', asset.formats[0].url, undefined, cookie);
    const bytes = Buffer.from(await res.arrayBuffer());
    return { status: res.status, bytes, format: asset.formats[0], index };
  };
  const token = async (id: string, role: string, scopes?: string[]) => {
    const secret = mintServiceSecret();
    await store.putApiToken({ id, label: id, role, tokenHash: secret.tokenHash, createdBy: 'system', createdAt: new Date().toISOString(), ...(scopes ? { scopes: scopes as never } : {}) });
    return secret.secret;
  };
  const render = async (cookie: string = cookies.owner) => {
    const res = await call('GET', '/render/swatch.svg', undefined, cookie);
    return { status: res.status, text: await res.text() };
  };
  const instance = async () => (await fetch(`${base}/api/v1/instance`)).json() as Promise<any>;
  const envelopeOf = async (cookie: string = cookies.member) => (await read('/catalog/tools/index.sig.json', cookie)).body;
  return { base, pack, store, blobs, cookies, call, read, docOf, state, previewDoc, send, envelope, servedDoc, token, render, instance, envelopeOf, signingKey };
}

// ── Who may ──────────────────────────────────────────────────────────────────

test('the role holds exactly what it says, on top of a member', () => {
  for (const action of ['brand.edit', 'brand.page.publish', 'brand.switch', 'tool.use', 'session.edit']) assert.equal(roleAllows('brand-manager', action), true, action);
  for (const action of ['policy.edit', 'grant.edit', 'approval.act', 'instance.config', 'catalog.publish', 'catalog.edit', 'token.manage', 'catalog.submit', 'audit.export']) assert.equal(roleAllows('brand-manager', action), false, action);
  for (const role of ['admin', 'owner']) assert.equal(roleAllows(role as 'admin', 'brand.edit'), true, role);
  for (const role of ['viewer', 'member', 'author', 'approver', 'guest', 'automation']) assert.equal(roleAllows(role as 'member', 'brand.edit'), false, role);
});

test('the role comes only from an explicit mapping, and a group that merely shares its name gains nothing', async () => {
  assert.equal(GROUP_NAMED_ROLES.includes('brand-manager'), false);
  assert.equal(roleFromGroups(['brand-manager']), 'member');
  assert.equal(roleFromGroups(['brand-team'], { 'brand-manager': ['brand-team'] }), 'brand-manager');
  assert.equal(roleFromGroups(['brand-team', 'admin'], { 'brand-manager': ['brand-team'] }), 'admin');
  assert.equal(roleFromGroups(['brand-team', 'approver'], { 'brand-manager': ['brand-team'] }), 'brand-manager');
  const t = await harness();
  assert.equal((await t.call('GET', '/api/v1/brand/edits', undefined, t.cookies.lookalike)).status, 403);
  assert.equal((await t.call('GET', '/api/v1/brand/edits', undefined, t.cookies.manager)).status, 200);
});

test('fails closed: no session, a member and a reviewer are refused on every route', async () => {
  const t = await harness();
  const routes: Array<[string, string]> = [['GET', '/api/v1/brand/edits'], ['GET', '/api/v1/brand/edits/document'], ['POST', '/api/v1/brand/edits/preview'], ['POST', '/api/v1/brand/edits'], ['POST', '/api/v1/brand/edits/rollback'], ['POST', '/api/v1/brand/edits/keep']];
  for (const [method, path] of routes) {
    assert.equal((await fetch(`${t.base}${path}`, { method, headers: { 'content-type': 'application/json' }, ...(method === 'POST' ? { body: '{}' } : {}) })).status, 401, `${method} ${path} signed out`);
    for (const cookie of [t.cookies.member, t.cookies.reviewer]) {
      assert.equal((await t.call(method, path, method === 'POST' ? {} : undefined, cookie)).status, 403, `${method} ${path}`);
    }
  }
  for (const cookie of [t.cookies.member, t.cookies.reviewer, t.cookies.manager]) {
    assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, cookie)).status, 403, 'a brand manager cannot change the switches');
  }
  assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, t.cookies.admin)).status, 200);
});

test('a deny grant wins, and an allow grant works without the role', async () => {
  const t = await harness();
  const cookieUser = async (email: string) => (await t.store.listUsers()).find(user => user.email === email)!;
  const manager = await cookieUser('manager@test');
  await t.store.putGrant({ principal: `user:${manager.id}`, action: 'brand.edit', resource: '*', effect: 'deny' });
  assert.equal((await t.call('GET', '/api/v1/brand/edits')).status, 403);
  const member = await cookieUser('member@test');
  await t.store.putGrant({ principal: `user:${member.id}`, action: 'brand.edit', resource: '*', effect: 'allow' });
  assert.equal((await t.call('GET', '/api/v1/brand/edits', undefined, t.cookies.member)).status, 200);
});

test('a scoped token reaches none of it, and no route is opened to one', async () => {
  const t = await harness();
  const scoped = await t.token('scoped', 'admin', ['render', 'documents', 'files', 'delivery', 'catalog.read', 'audit.read']);
  for (const [method, path] of [['GET', '/api/v1/brand/edits'], ['GET', '/api/v1/brand/edits/document'], ['POST', '/api/v1/brand/edits/preview'], ['POST', '/api/v1/brand/edits'], ['POST', '/api/v1/brand/edits/rollback'], ['POST', '/api/v1/brand/edits/keep'], ['PUT', '/api/v1/brand/edits/settings']] as const) {
    const res = await fetch(`${t.base}${path}`, { method, headers: { authorization: `Bearer ${scoped}`, 'content-type': 'application/json' }, ...(method === 'GET' ? {} : { body: '{}' }) });
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'TOKEN_SCOPE', `${method} ${path}`);
    assert.equal(routeScopes(method, path), null, `${method} ${path} is in no scope`);
  }
  // An unscoped token holds its role, and an edit is a person's or a full token's act, as publishing a page is.
  const full = await t.token('full', 'admin');
  assert.equal((await fetch(`${t.base}/api/v1/brand/edits`, { headers: { authorization: `Bearer ${full}` } })).status, 200);
});

test('org-config carries the bit and the capability only for someone who can use them', async () => {
  const t = await harness();
  const memberConfig = (await t.read('/api/v1/org-config', t.cookies.member)).body;
  assert.equal(memberConfig.can['brand.edit'], false);
  assert.equal(memberConfig.brandEdits, undefined);
  const managerConfig = (await t.read('/api/v1/org-config')).body;
  assert.equal(managerConfig.can['brand.edit'], true);
  assert.deepEqual(managerConfig.brandEdits, { maxDocumentBytes: 8 * 1024 * 1024, approval: false });
  const version = managerConfig.policyVersion;
  await t.store.putChain({ id: 'brand', name: 'Brand', version: 1, steps: [{ name: 'Brand', approvers: { groups: ['approver'] }, rule: 'any' }], onReject: 'return-to-submitter' } as never);
  assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: 'brand', lookAfterImage: false }, t.cookies.admin)).status, 200);
  const after = (await t.read('/api/v1/org-config')).body;
  assert.equal(after.brandEdits.approval, true);
  assert.notEqual(after.policyVersion, version, 'a connected shell has to notice');
});

// ── Sending, live and back ───────────────────────────────────────────────────

test('with no chain an edit goes live on send, and reaches a member, a render and the instance', async () => {
  const t = await harness();
  const before = await t.instance();
  const sigBefore = await t.envelopeOf();
  const mounted = await t.servedDoc();
  assert.match((await t.render()).text, /#1b2a6b/);

  const doc = colourChange(tokens());
  const reviewed = await t.previewDoc(doc);
  assert.deepEqual(reviewed.body.lines, [{ kind: 'colour', name: 'base: color.brand.indigo', action: 'changed', before: '#1b2a6b', after: '#223377' }]);
  assert.equal(reviewed.body.approval, false);
  assert.equal((await t.render()).text.includes('#223377'), false, 'a preview changes nothing');
  const sent = await t.send(doc);
  assert.equal(sent.status, 201, JSON.stringify(sent.body));
  assert.equal(sent.body.state, 'live');
  assert.equal(sent.body.revision, 1);

  const served = await t.servedDoc();
  assert.equal(served.status, 200);
  assert.equal(served.bytes.toString(), JSON.stringify(doc), 'the bytes as sent');
  assert.equal(served.format.checksum, sri(served.bytes));
  assert.equal(served.format.size, served.bytes.length);
  assert.notEqual(served.format.url, mounted.format.url);
  assert.match(served.format.url, new RegExp(`/${sha256(served.bytes).slice(0, 16)}/tokens\\.json$`), 'a new content address, so nothing stale is served under it');
  assert.equal(served.index.brandTokens, 'wefthouse/tokens/brand');
  assert.equal(served.index.assets.find((row: { id: string }) => row.id === 'wefthouse/tokens/brand').version, '1.0.0', 'no version bump');

  const rendered = await t.render();
  assert.equal(rendered.status, 200, rendered.text);
  assert.match(rendered.text, /#223377/);

  const after = await t.instance();
  assert.notEqual(after.branding.revision, before.branding.revision, 'a client notices on its next check');
  const sig = await t.envelopeOf();
  assert.ok(sig.seq > sigBefore.seq, 'the signed sequence moves');
  assert.notEqual(sig.assetIndexHash, sigBefore.assetIndexHash);
});

test('the mounted files stay exactly as they were', async () => {
  const t = await harness();
  const { readFileSync } = await import('node:fs');
  const file = join(t.pack, 'catalog', 'assets', 'wefthouse', 'tokens', 'brand.json');
  const index = join(t.pack, 'catalog', 'assets', 'index.json');
  const [fileBefore, indexBefore] = [readFileSync(file), readFileSync(index)];
  assert.equal((await t.send(colourChange(tokens()))).status, 201);
  assert.ok(readFileSync(file).equals(fileBefore));
  assert.ok(readFileSync(index).equals(indexBefore));
});

test('a signed catalogue covers the edit: signature, then index, then bytes', async () => {
  const t = await harness();
  assert.equal((await t.send(colourChange(tokens()))).status, 201);
  const specifier: string = '@lolly/engine';
  const engine = await import(specifier) as {
    verifyEnvelopeSignature(envelope: unknown, key: webcrypto.CryptoKey): Promise<{ ok: boolean; reason?: string }>;
  };
  const keyDocument = await (await fetch(`${t.base}/api/v1/catalog/public-key`)).json() as { publicKey: webcrypto.JsonWebKey; keyId: string };
  const key = await webcrypto.subtle.importKey('jwk', keyDocument.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  const envelope = await t.envelopeOf();
  assert.equal(envelope.keyId, keyDocument.keyId, 'signed with the instance\'s key');
  assert.deepEqual(await engine.verifyEnvelopeSignature(envelope, key), { ok: true });
  const indexRes = await t.call('GET', '/catalog/assets/index.json', undefined, t.cookies.member);
  const indexBytes = Buffer.from(await indexRes.arrayBuffer());
  assert.equal(sha256(indexBytes), envelope.assetIndexHash, 'the signature covers the index the member reads');
  const served = await t.servedDoc();
  assert.equal(sri(served.bytes), served.format.checksum, 'the index covers the tokens');
  // A byte changed anywhere breaks the chain the web app checks.
  const tampered = Buffer.from(served.bytes); tampered[0] = tampered[0]! ^ 1;
  assert.notEqual(sri(tampered), served.format.checksum);
  const { signature: _signature, ...rest } = envelope;
  assert.equal((await engine.verifyEnvelopeSignature({ ...rest, assetIndexHash: 'f'.repeat(64), signature: envelope.signature }, key)).ok, false);
});

test('the digest binds the document', async () => {
  const t = await harness();
  const doc = colourChange(tokens()), checksum = (await t.docOf()).baseChecksum;
  const wrong = await t.call('POST', '/api/v1/brand/edits/preview', { document: JSON.stringify(doc), digest: 'f'.repeat(64), base: checksum });
  assert.equal(wrong.status, 409);
  assert.equal((await wrong.json() as { error: { code: string } }).error.code, 'BRAND_EDIT_DIGEST');
  const reviewed = await t.previewDoc(doc);
  // A different document under the reviewed token is refused.
  const other = colourChange(tokens()); other.base.color.brand.madder.$value = '#000000';
  const swapped = await t.call('POST', '/api/v1/brand/edits', { ...t.envelope(other, reviewed.baseChecksum), revision: reviewed.body.revision, reviewToken: reviewed.body.reviewToken });
  assert.equal(swapped.status, 409);
  assert.equal((await swapped.json() as { error: { code: string } }).error.code, 'STALE_PREVIEW');
  const noReview = await t.call('POST', '/api/v1/brand/edits', t.envelope(doc, reviewed.baseChecksum));
  assert.equal(noReview.status, 400);
  const sent = await t.send(doc);
  assert.equal(sent.body.digest, sha256(JSON.stringify(doc)));
  const history = await t.state();
  assert.equal(history.revisions[0].digest, sha256(JSON.stringify(doc)));
  assert.equal(history.revisions[0].sentByName, 'Manager');
  const stored = await t.call('GET', '/api/v1/brand/edits/revisions/1/document');
  assert.equal(sha256(Buffer.from(await stored.arrayBuffer())), history.revisions[0].digest);
  // The same document again changes nothing, and adds no revision.
  const again = await t.send(doc);
  assert.equal(again.body.unchanged, true);
  assert.equal((await t.state()).revisions.length, 1);
});

test('a document built on an old base is told to start again', async () => {
  const t = await harness();
  const stale = await t.call('POST', '/api/v1/brand/edits/preview', t.envelope(colourChange(tokens()), 'a'.repeat(64)));
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as { error: { code: string } }).error.code, 'BRAND_EDIT_BASE_MOVED');
});

test('out-of-scope and hostile documents save nothing, and say why plainly', async () => {
  const t = await harness();
  const font = tokens(); font.base.font.brand.$value = 'Comic Sans';
  const reviewed = await t.previewDoc(font);
  assert.deepEqual(reviewed.body.outOfScope, ['base.font']);
  const refused = await t.call('POST', '/api/v1/brand/edits', { ...t.envelope(font, reviewed.baseChecksum), revision: reviewed.body.revision, reviewToken: reviewed.body.reviewToken });
  assert.equal(refused.status, 422);
  const body = await refused.json() as { error: { code: string; message: string } };
  assert.equal(body.error.code, 'BRAND_EDIT_OUT_OF_SCOPE');
  assert.match(body.error.message, /base\.font/);
  const hostile = tokens(); hostile.base.color.brand.indigo.$value = 'url(https://evil.example/)';
  const review2 = await t.previewDoc(hostile);
  const invalid = await t.call('POST', '/api/v1/brand/edits', { ...t.envelope(hostile, review2.baseChecksum), revision: review2.body.revision, reviewToken: review2.body.reviewToken });
  assert.equal(invalid.status, 422);
  assert.equal((await invalid.json() as { error: { code: string } }).error.code, 'BRAND_EDIT_INVALID');
  const notJson = await t.call('POST', '/api/v1/brand/edits/preview', { document: '{', digest: sha256('{'), base: review2.baseChecksum });
  assert.equal(notJson.status, 422);
  const proto = '{"__proto__":{"x":1}}';
  const polluted = await t.call('POST', '/api/v1/brand/edits/preview', { document: proto, digest: sha256(proto), base: review2.baseChecksum });
  assert.equal(polluted.status, 422);
  const large = 'x'.repeat(8 * 1024 * 1024 + 1);
  assert.equal((await t.call('POST', '/api/v1/brand/edits/preview', { document: large, digest: sha256(large), base: review2.baseChecksum })).status, 413);
  assert.equal((await t.state()).revisions.length, 0);
  assert.match((await t.render()).text, /#1b2a6b/);
});

test('a role list the engine cannot read is refused, because the rules would go with it', async () => {
  const t = await harness();
  const doc = tokens();
  // A rule pointing at a role that is gone reads as no record at all.
  doc.$extensions['com.suse.lolly'].brandSystem.bindings = [{ id: 'lead', roleId: 'nobody', consumer: { slot: 'primary' } }];
  const out = await t.previewDoc(doc);
  assert.ok(out.body.invalid.length);
});

test('rolling back drops the pointer, and the mounted tokens are served again', async () => {
  const t = await harness();
  const mounted = await t.servedDoc();
  const first = await t.envelopeOf();
  await t.send(colourChange(tokens()));
  const during = await t.envelopeOf();
  const back = await t.call('POST', '/api/v1/brand/edits/rollback', {});
  assert.equal(back.status, 200);
  const served = await t.servedDoc();
  assert.equal(served.format.url, mounted.format.url);
  assert.ok(served.bytes.equals(mounted.bytes));
  assert.match((await t.render()).text, /#1b2a6b/);
  const after = await t.envelopeOf();
  assert.ok(after.seq > during.seq && during.seq > first.seq, 'the sequence only ever rises, so a client accepts a rollback');
  assert.equal(after.assetIndexHash, first.assetIndexHash, 'the same index as before the edit');
  const state = await t.state();
  assert.equal(state.edit, null);
  assert.equal(state.revisions[0].state, 'rolled-back');
  assert.equal(state.revisions[0].endedByName, 'Manager');
  // A second rollback is harmless.
  assert.equal((await (await t.call('POST', '/api/v1/brand/edits/rollback', {})).json() as { unchanged: boolean }).unchanged, true);
});

test('rolling back to an earlier revision is a new send of what it changed', async () => {
  const t = await harness();
  const one = colourChange(tokens());
  const two = colourChange(tokens()); two.base.color.brand.indigo.$value = '#445566';
  await t.send(one);
  await t.send(two);
  assert.match((await t.render()).text, /#445566/);
  const state = await t.state();
  assert.equal(state.revisions[0].state, 'live');
  assert.equal(state.revisions[1].state, 'superseded');
  const back = await t.call('POST', '/api/v1/brand/edits/rollback', { to: 1 });
  assert.equal(back.status, 201, await back.clone().text());
  assert.match((await t.render()).text, /#223377/);
  const later = await t.state();
  assert.equal(later.revisions[0].n, 3);
  assert.equal(later.revisions[0].restoredFrom, 1);
  assert.equal((await t.call('POST', '/api/v1/brand/edits/rollback', { to: 99 })).status, 404);
});

test('audit entries name the actor for send, go-live, rollback and the switches', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  await t.call('POST', '/api/v1/brand/edits/rollback', {});
  await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, t.cookies.admin);
  const events = await t.store.listAudit();
  const users = await t.store.listUsers();
  const id = (email: string) => users.find(user => user.email === email)!.id;
  const of = (action: string) => events.filter(event => event.action === action);
  assert.equal(of('brand.edit.send')[0]?.actor, `user:${id('manager@test')}`);
  assert.equal(of('brand.edit.live')[0]?.actor, `user:${id('manager@test')}`);
  assert.equal(of('brand.edit.rollback')[0]?.actor, `user:${id('manager@test')}`);
  assert.equal(of('brand.edit.settings')[0]?.actor, `user:${id('admin@test')}`);
  assert.deepEqual((of('brand.edit.settings')[0]?.payload as { after: unknown }).after, { approvalChain: null, lookAfterImage: true });
  assert.equal((of('brand.edit.live')[0]?.payload as { revision: number }).revision, 1);
});

// ── A chain ──────────────────────────────────────────────────────────────────

async function withChain() {
  const t = await harness();
  await t.store.putChain({ id: 'brand', name: 'Brand review', version: 1, steps: [{ name: 'Brand', approvers: { groups: ['approver'] }, rule: 'any' }], onReject: 'return-to-submitter' } as never);
  assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: 'brand', lookAfterImage: false }, t.cookies.admin)).status, 200);
  return t;
}

test('with a chain an edit waits, a reviewer sees what changed, and the decision is bound to its digest', async () => {
  const t = await withChain();
  const doc = colourChange(tokens());
  const reviewed = await t.previewDoc(doc);
  assert.equal(reviewed.body.approval, true);
  const sent = await t.send(doc);
  assert.equal(sent.status, 202, JSON.stringify(sent.body));
  assert.equal(sent.body.state, 'pending');
  assert.match((await t.render()).text, /#1b2a6b/, 'nothing changes while it waits');
  assert.equal((await t.state()).edit, null);
  assert.equal((await t.state()).pending.n, 1);
  // One at a time.
  const other = colourChange(tokens()); other.base.color.brand.madder.$value = '#000000';
  assert.equal((await t.send(other)).status, 409);
  const robot = await t.token('robot', 'admin');
  const review3 = await t.previewDoc(other);
  const refusedToken = await fetch(`${t.base}/api/v1/brand/edits`, { method: 'POST', headers: { authorization: `Bearer ${robot}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...t.envelope(other, review3.baseChecksum), revision: review3.body.revision, reviewToken: review3.body.reviewToken }) });
  assert.equal(refusedToken.status, 409, 'waiting first');

  const list = (await t.read('/api/v1/approvals', t.cookies.reviewer)).body.approvals as any[];
  const seen = list.find(row => row.id === sent.body.approvalId);
  assert.equal(seen.subjectType, 'brand-edit');
  assert.equal(seen.brandEdit.digest, sha256(JSON.stringify(doc)));
  const detail = await t.read(seen.brandEdit.detail, t.cookies.reviewer);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body.lines.map((line: { after: string }) => line.after), ['#223377']);
  assert.equal((await t.read(seen.brandEdit.detail, t.cookies.member)).status, 404, 'anyone else learns nothing');

  const act = (body: Record<string, unknown>, cookie = t.cookies.reviewer) => t.call('POST', `/api/v1/approvals/${sent.body.approvalId}/act`, body, cookie);
  assert.equal((await act({ action: 'approve' })).status, 409, 'a decision names the digest it saw');
  assert.equal((await act({ action: 'approve', brandEditDigest: 'f'.repeat(64) })).status, 409);
  const approved = await act({ action: 'approve', brandEditDigest: sha256(JSON.stringify(doc)) });
  assert.equal(approved.status, 200, await approved.clone().text());
  assert.match((await t.render()).text, /#223377/);
  const state = await t.state();
  assert.equal(state.edit.state, 'current');
  assert.equal(state.pending, null);
  const events = await t.store.listAudit();
  const reviewer = (await t.store.listUsers()).find(user => user.email === 'review@test')!;
  assert.equal(events.find(event => event.action === 'brand.edit.live')?.actor, `user:${reviewer.id}`, 'going live names who approved');
});

test('a submitter cannot approve their own edit, even an administrator', async () => {
  const t = await withChain();
  const doc = colourChange(tokens());
  const sent = await t.send(doc, t.cookies.admin);
  assert.equal(sent.status, 202);
  const act = await t.call('POST', `/api/v1/approvals/${sent.body.approvalId}/act`, { action: 'approve', brandEditDigest: sha256(JSON.stringify(doc)) }, t.cookies.admin);
  assert.equal(act.status, 403);
});

test('a rejected or withdrawn edit never goes live, and its document goes', async () => {
  const t = await withChain();
  const doc = colourChange(tokens());
  const sent = await t.send(doc);
  const rejected = await t.call('POST', `/api/v1/approvals/${sent.body.approvalId}/act`, { action: 'reject', comment: 'No', brandEditDigest: sha256(JSON.stringify(doc)) }, t.cookies.reviewer);
  assert.equal(rejected.status, 200);
  assert.match((await t.render()).text, /#1b2a6b/);
  assert.equal((await t.state()).revisions[0].state, 'rejected');
  assert.equal((await t.call('GET', '/api/v1/brand/edits/revisions/1/document')).status, 410);

  const second = await t.send(colourChange(tokens()));
  assert.equal(second.status, 202);
  const withdrawn = await t.call('POST', `/api/v1/approvals/${second.body.approvalId}/withdraw`, {});
  assert.equal(withdrawn.status, 200, await withdrawn.clone().text());
  assert.equal((await t.state()).revisions[0].state, 'withdrawn');
});

test('a chain that has gone sends nothing, and an unknown one cannot be set', async () => {
  const t = await harness();
  assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: 'nobody', lookAfterImage: false }, t.cookies.admin)).status, 409);
  await t.store.putChain({ id: 'brand', name: 'Brand', version: 1, steps: [{ name: 'Brand', approvers: { groups: ['approver'] }, rule: 'any' }], onReject: 'return-to-submitter' } as never);
  assert.equal((await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: 'brand', lookAfterImage: false }, t.cookies.admin)).status, 200);
  await t.store.deleteChain('brand');
  const sent = await t.send(colourChange(tokens()));
  assert.equal(sent.status, 409);
  assert.equal(sent.body.error.code, 'CHAIN_NOT_FOUND');
  assert.match((await t.render()).text, /#1b2a6b/);
});

test('rolling back to the mounted tokens needs no approval, and going back to a revision still does', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  await t.store.putChain({ id: 'brand', name: 'Brand', version: 1, steps: [{ name: 'Brand', approvers: { groups: ['approver'] }, rule: 'any' }], onReject: 'return-to-submitter' } as never);
  await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: 'brand', lookAfterImage: false }, t.cookies.admin);
  assert.equal((await t.call('POST', '/api/v1/brand/edits/rollback', {})).status, 200);
  assert.match((await t.render()).text, /#1b2a6b/);
  const again = await t.call('POST', '/api/v1/brand/edits/rollback', { to: 1 });
  assert.equal(again.status, 202);
  assert.match((await t.render()).text, /#1b2a6b/);
});

// ── A new image ──────────────────────────────────────────────────────────────

/** The same database and blob store under a new pack, as a redeploy leaves them. */
async function nextImage(t: Awaited<ReturnType<typeof harness>>, doc: Record<string, any>) {
  return harness({ doc, store: t.store, blobs: t.blobs, signingKey: t.signingKey });
}

test('after a new image, by default the edit stays on top with a quiet note and nobody is asked', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  const image = tokens(); image.base.font.brand.$value = 'Söhne'; image.base.color.brand.madder.$value = '#ff0000';
  const next = await nextImage(t, image);
  const state = await next.state();
  assert.equal(state.edit.state, 'on-new-image');
  assert.equal(state.edit.ask, false);
  assert.deepEqual(state.edit.overlaps, []);
  assert.match((await next.render()).text, /#223377/, 'the edit stays live');
  const served = JSON.parse((await next.servedDoc()).bytes.toString());
  assert.equal(served.base.font.brand.$value, 'Söhne', 'the new image is underneath');
  assert.equal(served.base.color.brand.madder.$value, '#ff0000');
  assert.equal((await next.servedDoc()).format.checksum, sri((await next.servedDoc()).bytes), 'and it verifies');
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal((await t.store.listMessages()).filter(message => (message.data as { kind?: string } | undefined)?.kind === 'brand-edit').length, 0, 'nobody is asked');
  // The same on another replica of that image: the revision is the same.
  const replica = await harness({ doc: image, store: t.store, blobs: t.blobs, signingKey: t.signingKey });
  assert.equal((await replica.servedDoc()).format.checksum, (await next.servedDoc()).format.checksum);
});

test('an image that changes nothing in the tokens leaves the edit as it was', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  const next = await nextImage(t, tokens());
  assert.equal((await next.state()).edit.state, 'current');
  assert.equal((await next.servedDoc()).bytes.toString(), JSON.stringify(colourChange(tokens())), 'the document as sent');
});

test('the note names where the image and the edit changed the same thing, and the edit stays on top', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  const image = tokens(); image.base.color.brand.indigo.$value = '#000000';
  const next = await nextImage(t, image);
  const state = await next.state();
  assert.deepEqual(state.edit.overlaps, ['base: color.brand.indigo']);
  assert.match((await next.render()).text, /#223377/);
});

test('with the switch on, people who can edit are asked to look, and the edit stays live meanwhile', async () => {
  const t = await harness();
  await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, t.cookies.admin);
  await t.send(colourChange(tokens()));
  const image = tokens(); image.base.font.brand.$value = 'Söhne';
  const next = await nextImage(t, image);
  const state = await next.state();
  assert.equal(state.edit.state, 'on-new-image');
  assert.equal(state.edit.ask, true);
  assert.match((await next.render()).text, /#223377/, 'it flags and does not hold');
  await new Promise(resolve => setTimeout(resolve, 20));
  const asked = (await t.store.listMessages()).filter(message => (message.data as { kind?: string } | undefined)?.kind === 'brand-edit');
  assert.equal(asked.length, 1);
  assert.equal(asked[0]!.severity, 'action');
  const users = await t.store.listUsers();
  const audience = (asked[0]!.audience as { users: string[] }).users;
  assert.ok(audience.includes(users.find(user => user.email === 'manager@test')!.id));
  assert.equal(audience.includes(users.find(user => user.email === 'member@test')!.id), false);
  // Keeping it stands until the next image.
  assert.equal((await next.call('POST', '/api/v1/brand/edits/keep', {})).status, 200);
  assert.equal((await next.state()).edit.ask, false);
  assert.match((await next.render()).text, /#223377/);
  const events = await t.store.listAudit();
  assert.ok(events.some(event => event.action === 'brand.edit.keep'));
});

test('with the switch on, rolling back is the other answer to the question', async () => {
  const t = await harness();
  await t.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, t.cookies.admin);
  await t.send(colourChange(tokens()));
  const image = tokens(); image.base.font.brand.$value = 'Söhne';
  const next = await nextImage(t, image);
  assert.equal((await next.state()).edit.ask, true);
  assert.equal((await next.call('POST', '/api/v1/brand/edits/rollback', {})).status, 200);
  assert.equal((await next.state()).edit, null);
  assert.match((await next.render()).text, /#1b2a6b/);
});

test('an edit that can no longer apply is not half applied: the image is served whole, and it says what has gone', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  const image = tokens();
  delete image.base.color.brand.indigo;
  image['colourway/indigo'].color.colourway.light.primary.$value = '#000000';
  const next = await nextImage(t, image);
  const state = await next.state();
  assert.equal(state.edit.state, 'cannot-apply');
  assert.deepEqual(state.edit.gone, ['base: color.brand.indigo']);
  const served = await next.servedDoc();
  assert.equal(served.status, 200);
  assert.equal(served.bytes.toString(), JSON.stringify(image), 'the image\'s own document, whole');
  assert.equal(served.format.checksum, sri(served.bytes));
  const envelope = await next.envelopeOf();
  assert.ok(envelope.signature, 'still signed');
  await new Promise(resolve => setTimeout(resolve, 20));
  const notes = (await t.store.listMessages()).filter(message => (message.data as { kind?: string } | undefined)?.kind === 'brand-edit');
  assert.equal(notes.length, 1, 'never silently');
  assert.match(String(notes[0]!.body), /color\.brand\.indigo/);
  assert.equal((await next.state()).revisions[0].state, 'live', 'the revision stays in the history');
  // A person can drop the pointer, or send a new edit on the new base.
  assert.equal((await next.call('POST', '/api/v1/brand/edits/rollback', {})).status, 200);
  assert.equal((await next.state()).edit, null);
});

test('a document that cannot be read serves the mounted tokens and says so, and comes back when it can', async () => {
  const t = await harness();
  await t.send(colourChange(tokens()));
  const id = (await t.store.getBrandState()).edits!.mounted!.blobId;
  assert.ok(await t.blobs.get(id));
  await t.blobs.delete(id);
  const next = await nextImage(t, tokens());
  const after = await next.state();
  assert.equal(after.edit.state, 'unavailable');
  const served = await next.servedDoc();
  assert.equal(served.bytes.toString(), JSON.stringify(tokens()), 'the mounted document, whole');
  assert.equal(served.status, 200);
  assert.equal(served.format.checksum, sri(served.bytes));
});

// ── Rules ────────────────────────────────────────────────────────────────────

test('an edit does not stop a mapped tool: rule mappings bind the mounted source', async () => {
  const t = await harness();
  const mappings = [{ toolId: 'swatch', example: 'brand-poster', mode: 'light', fields: { heading: 'heading' } }];
  const reviewed = await (await t.call('POST', '/api/v1/brand/rules/preview', { mappings }, t.cookies.admin)).json() as { revision: number; reviewToken: string };
  assert.ok(reviewed.reviewToken, JSON.stringify(reviewed));
  assert.equal((await t.call('POST', '/api/v1/brand/rules', { mappings, revision: reviewed.revision, reviewToken: reviewed.reviewToken }, t.cookies.admin)).status, 200);
  const policy = async () => (await t.store.getBrandState()).rulePolicies!.mounted!;
  const before = await policy();
  assert.equal((await t.render()).status, 200);
  assert.equal((await t.send(colourChange(tokens()))).status, 201);
  // Without the mounted-only binding this answers 409 BRAND_REVISION_CHANGED for every mapped render.
  const rendered = await t.render();
  assert.equal(rendered.status, 200, rendered.text);
  assert.match(rendered.text, /#223377/);
  const rules = await t.read('/api/v1/brand/rules', t.cookies.admin);
  assert.equal(rules.status, 200);
  assert.equal(rules.body.system.id, 'wefthouse', 'the record still reads, rules and all');
  assert.equal(rules.body.mappings.length, 1);
  // A mapping reviewed while the edit is live binds the same mounted source.
  const again = await (await t.call('POST', '/api/v1/brand/rules/preview', { mappings }, t.cookies.admin)).json() as { sourceRevision: string };
  assert.equal(again.sourceRevision, before.sourceRevision);
  // And the rollback leaves the mapping standing.
  await t.call('POST', '/api/v1/brand/edits/rollback', {});
  assert.equal((await t.render()).status, 200);
});

// ── The connect download ─────────────────────────────────────────────────────

const PARTS = (tokensText: string) => ({
  'fonts.json': '[]', 'logos.json': '[]', 'prefs.json': '{}', 'tools.json': '{"tools":[],"files":{}}',
  'tools/swatch/hooks.js': 'x'.repeat(4000),
  'instance.json': JSON.stringify({ kind: 'instance-pack', name: 'Wefthouse', publisher: 'Wefthouse', version: '1.0.0', instance: 'http://brand.example' }),
  'tokens.json': tokensText,
  'catalog.json': JSON.stringify({ assets: [{ id: 'wefthouse/tokens/brand', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/wefthouse/tokens/brand.json', checksum: sri(tokensText), size: tokensText.length }] }] }, null, 2),
  'catalog/assets/wefthouse/tokens/brand.json': tokensText,
});

/** A pack in the builder's layout: an integrity map over every part, then a signature over the manifest. */
async function packOf(tokensText: string, signature: (manifest: Buffer) => Promise<Buffer | string | null>): Promise<Buffer> {
  const parts: Record<string, string> = PARTS(tokensText);
  const integrity = Object.fromEntries(Object.entries(parts).map(([path, text]) => [path, sri(text)]));
  const manifest = Buffer.from(JSON.stringify({ format: 'lolly-brand', formatVersion: 3, minReader: 1, integrity }, null, 2));
  const zip = new ZipBuilder(new Date('2026-11-06T00:00:00Z'));
  const signed = await signature(manifest);
  const chunks = Object.entries(parts).map(([name, text]) => zip.add(name, Buffer.from(text)));
  chunks.push(zip.add('manifest.json', manifest));
  chunks.push(zip.add('README.txt', Buffer.from('A readme.')));
  if (signed) chunks.push(zip.add('pack.sig', Buffer.from(JSON.stringify({ alg: 'ECDSA-P256-SHA256', signature: Buffer.isBuffer(signed) ? signed.toString('base64') : signed }))));
  return Buffer.concat([...chunks, zip.end()]);
}
const signerFor = (material: string) => { const signing = createCatalogSigning(material); return (manifest: Buffer) => signing.signBytes(manifest); };
async function upload(t: Awaited<ReturnType<typeof harness>>, bytes: Buffer) {
  const res = await fetch(`${t.base}/api/v1/instance-pack`, { method: 'PUT', headers: { cookie: t.cookies.owner, 'content-type': 'application/octet-stream' }, body: new Uint8Array(bytes) });
  assert.equal(res.status, 200, await res.clone().text());
}
const readPack = async (t: Awaited<ReturnType<typeof harness>>) => {
  const res = await t.call('GET', '/connect/pack.lolly', undefined, t.cookies.member);
  return { status: res.status, bytes: Buffer.from(await res.arrayBuffer()) };
};

/** Every part in a zip, read the way an app reads it. */
async function unzip(bytes: Buffer): Promise<Record<string, Uint8Array>> {
  const { unzipSync } = await import('fflate');
  return unzipSync(new Uint8Array(bytes));
}

test('a pack this instance signed carries the edit, verifies, and follows a rollback', async () => {
  const t = await harness();
  const kept = await packOf(JSON.stringify(tokens()), signerFor(t.signingKey!));
  await upload(t, kept);
  assert.ok((await readPack(t)).bytes.equals(kept));
  const doc = colourChange(tokens());
  const reviewed = await t.previewDoc(doc);
  assert.equal(reviewed.body.connect, 'derived', 'the sender is told before sending');
  assert.equal((await t.send(doc)).status, 201);
  assert.equal((await t.state()).connect, 'derived');

  const derived = await readPack(t);
  assert.equal(derived.status, 200);
  assert.equal(derived.bytes.equals(kept), false);
  assert.equal(instancePackTokensChecksum(derived.bytes), sha256(canonicalJson(doc)));
  const parts = await unzip(derived.bytes);
  // What an app's importer checks: the signature over the exact manifest, then every part against it.
  const manifest = JSON.parse(Buffer.from(parts['manifest.json']!).toString()) as { integrity: Record<string, string> };
  const sig = JSON.parse(Buffer.from(parts['pack.sig']!).toString()) as { signature: string; keyThumbprint: string };
  const keyDocument = await (await fetch(`${t.base}/api/v1/catalog/public-key`)).json() as { publicKey: webcrypto.JsonWebKey; keyId: string };
  assert.equal(sig.keyThumbprint, keyDocument.keyId);
  const key = await webcrypto.subtle.importKey('jwk', keyDocument.publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
  assert.equal(await webcrypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, Buffer.from(sig.signature, 'base64'), Uint8Array.from(parts['manifest.json']!)), true);
  for (const [path, expected] of Object.entries(manifest.integrity)) assert.equal(sri(Buffer.from(parts[path]!)), expected, path);
  // Tools and everything else keep their bytes, and the kept pack's parts stay readable.
  assert.equal(Buffer.from(parts['tools/swatch/hooks.js']!).toString(), 'x'.repeat(4000));
  assert.equal(Buffer.from(parts['tokens.json']!).toString(), JSON.stringify(doc));
  assert.equal(Buffer.from(parts['catalog/assets/wefthouse/tokens/brand.json']!).toString(), JSON.stringify(doc));
  const catalog = JSON.parse(Buffer.from(parts['catalog.json']!).toString());
  assert.equal(catalog.assets[0].formats[0].checksum, sri(JSON.stringify(doc)));
  assert.deepEqual(inspectInstancePack(derived.bytes, 'http://brand.example').signed, true);

  const back = await t.call('POST', '/api/v1/brand/edits/rollback', {});
  assert.equal(back.status, 200);
  assert.ok((await readPack(t)).bytes.equals(kept), 'the kept pack comes back byte for byte');
  assert.equal((await t.state()).connect, 'kept');
});

test('a derived pack is never served for an edit awaiting approval', async () => {
  const t = await withChain();
  const kept = await packOf(JSON.stringify(tokens()), signerFor(t.signingKey!));
  await upload(t, kept);
  const doc = colourChange(tokens());
  const sent = await t.send(doc);
  assert.equal(sent.status, 202);
  assert.ok((await readPack(t)).bytes.equals(kept), 'the kept pack while it waits');
  assert.equal((await t.state()).connect, 'kept');
  const approved = await t.call('POST', `/api/v1/approvals/${sent.body.approvalId}/act`, { action: 'approve', brandEditDigest: sha256(JSON.stringify(doc)) }, t.cookies.reviewer);
  assert.equal(approved.status, 200);
  const live = await readPack(t);
  assert.equal(instancePackTokensChecksum(live.bytes), sha256(canonicalJson(doc)));
});

test('a pack another key signed is withdrawn, not laundered, and the sender is told first', async () => {
  const t = await harness();
  const other = privateKeyPem();
  await upload(t, await packOf(JSON.stringify(tokens()), signerFor(other)));
  const doc = colourChange(tokens());
  assert.equal((await t.previewDoc(doc)).body.connect, 'withdrawn');
  await t.send(doc);
  assert.equal((await readPack(t)).status, 404, 'not offered: it would put old colours back on every device');
  assert.equal((await t.state()).connect, 'withdrawn');
  assert.equal((await t.instance()).connect, undefined);
  assert.equal((await t.instance()).brand.packUrl, null, 'a hosted app reads the catalogue instead');
  await t.call('POST', '/api/v1/brand/edits/rollback', {});
  assert.equal((await readPack(t)).status, 200, 'and it comes back');
});

test('a bogus signature or a changed part is never re-signed', async () => {
  const material = privateKeyPem();
  const signing = createCatalogSigning(material);
  const { keyId } = await signing.ready;
  const signer = { keyId, alg: 'ECDSA-P256-SHA256', signBytes: signing.signBytes, verifyBytes: signing.verifyBytes };
  const text = JSON.stringify(tokens()), edit = Buffer.from(JSON.stringify(colourChange(tokens())));
  assert.ok(await deriveInstancePack(await packOf(text, signerFor(material)), edit, signer), 'its own, intact');
  assert.equal(await deriveInstancePack(await packOf(text, async () => 'bm90IGEgc2lnbmF0dXJl'), edit, signer), null, 'a bogus signature');
  assert.equal(await deriveInstancePack(await packOf(text, async () => null), edit, signer), null, 'no signature');
  assert.equal(await deriveInstancePack(await packOf(text, signerFor(privateKeyPem())), edit, signer), null, 'another key');
  assert.equal(await deriveInstancePack(Buffer.from('not a zip at all'), edit, signer), null);
  // Signed correctly, with a part that no longer matches its manifest.
  const zip = new ZipBuilder(new Date('2026-11-06T00:00:00Z'));
  const parts: Record<string, string> = PARTS(text);
  const integrity = Object.fromEntries(Object.entries(parts).map(([path, value]) => [path, sri(value)]));
  const manifest = Buffer.from(JSON.stringify({ integrity }));
  const tampered = { ...parts, 'tools/swatch/hooks.js': 'evil()' };
  const chunks = Object.entries(tampered).map(([name, value]) => zip.add(name, Buffer.from(value)));
  chunks.push(zip.add('manifest.json', manifest), zip.add('pack.sig', Buffer.from(JSON.stringify({ signature: (await signing.signBytes(manifest)).toString('base64') }))));
  assert.equal(await deriveInstancePack(Buffer.concat([...chunks, zip.end()]), edit, signer), null, 'a changed tool');
});

test('with no signing key the download is withdrawn, and the catalogue still carries the edit', async () => {
  const t = await harness({ signingKey: null });
  await upload(t, await packOf(JSON.stringify(tokens()), signerFor(privateKeyPem())));
  const doc = colourChange(tokens());
  assert.equal((await t.previewDoc(doc)).body.connect, 'withdrawn');
  await t.send(doc);
  assert.equal((await readPack(t)).status, 404);
  assert.equal((await t.state()).connect, 'withdrawn');
  assert.match((await t.render()).text, /#223377/);
  assert.equal((await t.call('GET', '/catalog/tools/index.sig.json', undefined, t.cookies.member)).status, 404);
});

test('under a live edit, a pack of the mounted tokens is accepted and a pack of the edit stands by itself', async () => {
  const t = await harness();
  const doc = colourChange(tokens());
  await t.send(doc);
  // The edit's own document, built into a pack by whoever holds the builder.
  const built = await packOf(JSON.stringify(doc), signerFor(privateKeyPem()));
  await upload(t, built);
  assert.ok((await readPack(t)).bytes.equals(built));
  assert.equal((await t.state()).connect, 'kept');
  // The mounted tokens, signed by this instance: the edit rides in a derived copy.
  const mounted = await packOf(JSON.stringify(tokens()), signerFor(t.signingKey!));
  await upload(t, mounted);
  assert.equal(instancePackTokensChecksum((await readPack(t)).bytes), sha256(canonicalJson(doc)));
  assert.equal((await t.state()).connect, 'derived');
  // Anything else is refused as before.
  const res = await fetch(`${t.base}/api/v1/instance-pack`, { method: 'PUT', headers: { cookie: t.cookies.owner }, body: new Uint8Array(await packOf('{"color":{}}', signerFor(privateKeyPem()))) });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'PACK_SOURCE_MISMATCH');
});

test('stopping the download stops a derived pack too', async () => {
  const t = await harness();
  await upload(t, await packOf(JSON.stringify(tokens()), signerFor(t.signingKey!)));
  await t.send(colourChange(tokens()));
  assert.equal((await readPack(t)).status, 200);
  const preview = await (await t.call('POST', '/api/v1/brand/changes/preview', { action: 'stop-download', sourceId: 'download' }, t.cookies.owner)).json() as { revision: number; reviewToken: string };
  assert.equal((await t.call('POST', '/api/v1/brand/changes', { action: 'stop-download', sourceId: 'download', revision: preview.revision, reviewToken: preview.reviewToken }, t.cookies.owner)).status, 200);
  assert.equal((await readPack(t)).status, 404);
  assert.equal((await t.state()).connect, 'stopped');
});

// ── A read-only deployment ───────────────────────────────────────────────────

test('a deployment that cannot keep an edit says so, and offers nothing', async () => {
  const pack = writePack(tokens());
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Wefthouse', baseUrl: 'http://brand.example', pack, brandTokens: { mounted: 'wefthouse/tokens/brand' } },
    idp: { issuer: 'https://idp.example', clientId: 'x', roleGroups: { owner: ['o'], admin: ['a'], approver: ['r'], author: ['w'] } },
    policy: { defaultAccessMode: 'gated' }, rateLimit: { enabled: false },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'test-session', link: 'test-link', webhook: 'test-webhook' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const secret = mintServiceSecret();
  await store.putApiToken({ id: 'full', label: 'full', role: 'owner', tokenHash: secret.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  const base = `http://127.0.0.1:${address.port}`, headers = { authorization: `Bearer ${secret.secret}`, 'content-type': 'application/json' };
  const state = await (await fetch(`${base}/api/v1/brand/edits`, { headers })).json() as { available: boolean; limitation: string };
  assert.equal(state.available, false);
  assert.match(state.limitation, /cannot keep an edit/);
  assert.equal((await fetch(`${base}/api/v1/brand/edits/preview`, { method: 'POST', headers, body: '{}' })).status, 409);
});

// ── Several replicas ─────────────────────────────────────────────────────────

test('every replica serves the same thing, with one store and one blob store', async () => {
  const t = await harness();
  const packDoc = tokens();
  const other = await harness({ doc: packDoc, store: t.store, blobs: t.blobs, signingKey: t.signingKey });
  const doc = colourChange(tokens());
  await t.send(doc);
  assert.match((await other.render()).text, /#223377/, 'the pointer reaches the other replica at once');
  assert.equal((await other.servedDoc()).bytes.toString(), JSON.stringify(doc));
  assert.equal((await other.instance()).branding.revision, (await t.instance()).branding.revision, 'they agree on the revision');
  assert.equal(clone((await other.servedDoc()).format).checksum, (await t.servedDoc()).format.checksum);
  await other.call('POST', '/api/v1/brand/edits/rollback', {});
  assert.match((await t.render()).text, /#1b2a6b/);
});

test('postgres: an edit commits with its audit event, reaches a second replica and rolls back', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async (store) => {
    const blobs = createMemoryBlobStore(), signingKey = privateKeyPem();
    const one = await harness({ store, blobs, signingKey }), two = await harness({ store, blobs, signingKey });
    await one.call('PUT', '/api/v1/brand/edits/settings', { approvalChain: null, lookAfterImage: true }, one.cookies.admin);
    const doc = colourChange(tokens());
    const sent = await one.send(doc);
    assert.equal(sent.status, 201, JSON.stringify(sent.body));
    assert.match((await two.render()).text, /#223377/);
    assert.equal((await two.servedDoc()).bytes.toString(), JSON.stringify(doc));
    const state = await two.state();
    assert.equal(state.edit.digest, sha256(JSON.stringify(doc)));
    assert.equal(state.revisions[0].sentByName, 'Manager');
    assert.deepEqual(state.settings, { approvalChain: null, lookAfterImage: true });
    const seen = (await store.listAudit()).map(event => event.action);
    for (const action of ['brand.edit.settings', 'brand.edit.send', 'brand.edit.live']) assert.ok(seen.includes(action), action);
    assert.equal((await two.call('POST', '/api/v1/brand/edits/rollback', {})).status, 200);
    assert.match((await one.render()).text, /#1b2a6b/);
    assert.equal((await one.state()).revisions[0].state, 'rolled-back');
    const person = (await store.listUsers()).find(user => user.email === 'manager@test')!;
    assert.equal((await store.subjectRows(person.id, 'brandEdits', '', 10)).length, 1);
  });
});
