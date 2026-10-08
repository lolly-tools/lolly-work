/**
 * Hidden catalog tags (plan 299, track B).
 *
 * A DAM's own labels arrive in every member's facet list. What this suite
 * pins: a hidden tag comes off what the feed SAYS about an asset and nothing
 * else (the asset stays); the rules apply when the index is served, so hiding
 * and showing take effect on the next read with no provider walk; a provider
 * rule touches only that provider's entries; the admin census still counts a
 * hidden tag so it can be found and shown again; and the rules ride the
 * policy document like the field definitions do.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import {
  applyTagRules, compileTagRules, hideEntryTags, normalizeHiddenTags, tagCensus, tagMatcher,
} from '../server/src/catalog/tag-rules.ts';
import {
  buildConfigDocument, commitConfigApply, diffConfigDocument, requiredActions, validateConfigDocument,
} from '../server/src/policy/config-doc.ts';
import type { AssetIndex, AssetIndexEntry } from '../server/src/catalog/lifecycle.ts';

// ── the pure rules ──────────────────────────────────────────────────────────

test('a hidden list is trimmed, deduped without regard to case, and refuses patterns it cannot honour', () => {
  assert.deepEqual(normalizeHiddenTags([' Internal ', 'internal', 'legal:*', '', 'Archive']), ['Internal', 'legal:*', 'Archive']);
  assert.ok('error' in (normalizeHiddenTags('nope') as object));
  assert.ok('error' in (normalizeHiddenTags(['*']) as object), 'a bare * would hide everything');
  assert.ok('error' in (normalizeHiddenTags(['a*b']) as object), 'only a trailing * is a pattern');
  assert.ok('error' in (normalizeHiddenTags(['line\nbreak']) as object));
  assert.ok('error' in (normalizeHiddenTags([42]) as object));
});

test('a matcher answers which pattern hid a tag, ignores case, and never hides the provider tag', () => {
  const m = tagMatcher(['Internal', 'legal:*']);
  assert.equal(m('internal'), 'Internal');
  assert.equal(m('LEGAL:review'), 'legal:*');
  assert.equal(m('legal'), null, 'a prefix pattern needs its prefix');
  assert.equal(m('Logos'), null);
  assert.equal(tagMatcher(['provider:*'])('provider:dam1'), null, 'the feed uses provider:<id> to say where an entry came from');
  assert.equal(m.size, 2);
});

const providerEntry = (): AssetIndexEntry => ({
  id: 'ext/dam1/a1', name: 'Summit Logo', type: 'raster', provider: 'dam1',
  tags: ['provider:dam1', 'Logos', 'event', 'Internal'],
  meta: { providerLabel: 'Acme DAM', providerSections: ['Logos', 'Internal'], providerCollections: ['Launch Kit'], providerTags: ['event', 'Internal'] },
});

test('hiding removes the label from tags and from the provider meta lists, and leaves the asset', () => {
  const set = compileTagRules([{ scope: '*', hidden: ['internal'] }], []);
  const hidden = hideEntryTags(providerEntry(), set);
  assert.deepEqual(hidden.tags, ['provider:dam1', 'Logos', 'event']);
  const meta = hidden.meta as Record<string, unknown>;
  assert.deepEqual(meta.providerSections, ['Logos']);
  assert.deepEqual(meta.providerTags, ['event']);
  assert.deepEqual(meta.providerCollections, ['Launch Kit']);
  assert.equal(hidden.id, 'ext/dam1/a1');

  const untouched = providerEntry();
  assert.equal(hideEntryTags(untouched, compileTagRules([{ scope: '*', hidden: ['nothing-here'] }], [])), untouched, 'no match, no copy');
  const index: AssetIndex = { version: 1, assets: [untouched] };
  assert.equal(applyTagRules(index, compileTagRules([], [])), index, 'no rules, same index');
});

test('a provider rule touches only that provider, and a declared mapping list joins it', () => {
  const pack: AssetIndexEntry = { id: 'acme/logo', name: 'Logo', type: 'vector', tags: ['event', 'logo'] };
  const set = compileTagRules([{ scope: 'provider:dam1', hidden: ['event'] }], [{ id: 'dam1', mapping: { hiddenTags: ['Logos'] } }]);
  const out = applyTagRules({ assets: [pack, providerEntry()] }, set);
  assert.deepEqual(out.assets?.[0]?.tags, ['event', 'logo'], 'a pack entry keeps a tag only dam1 hides');
  assert.deepEqual(out.assets?.[1]?.tags, ['provider:dam1', 'Internal']);
  assert.deepEqual((out.assets?.[1]?.meta as Record<string, unknown>).providerSections, ['Internal']);
});

test('the census counts every label once per asset, per source, and says what hides it', () => {
  const rows = tagCensus(
    [
      { source: 'pack', entries: [{ id: 'p1', tags: ['event'] }] },
      { source: 'dam1', entries: [providerEntry(), { id: 'ext/dam1/a2', provider: 'dam1', tags: ['provider:dam1', 'event'] }] },
    ],
    [{ scope: '*', hidden: ['intern*'] }, { scope: 'provider:dam1', hidden: ['event'] }],
    [{ id: 'dam1', mapping: { hiddenTags: ['Launch Kit'] } }],
  );
  const by = new Map(rows.map((r) => [r.tag, r]));
  assert.equal(rows[0]?.tag, 'event', 'most used first');
  assert.deepEqual(by.get('event')?.sources, { pack: 1, dam1: 2 });
  assert.deepEqual(by.get('event')?.hiddenBy, [{ scope: 'provider:dam1', pattern: 'event' }]);
  assert.deepEqual(by.get('Logos')?.kinds, ['tag', 'section']);
  assert.equal(by.get('Logos')?.count, 1, 'a tag and a section on one asset count once');
  assert.deepEqual(by.get('Internal')?.hiddenBy, [{ scope: '*', pattern: 'intern*' }]);
  assert.deepEqual(by.get('Launch Kit')?.hiddenBy, [{ scope: 'provider:dam1', pattern: 'Launch Kit', declared: true }]);
  assert.equal(by.has('provider:dam1'), false, 'the provider tag is not a label anyone curates');
});

// ── the policy document ─────────────────────────────────────────────────────

test('tag rules ride the policy document, and an instance that hides nothing exports what it did before', async () => {
  const store = createMemoryStore();
  const empty = await buildConfigDocument(store);
  assert.equal('tagRules' in empty, false, 'no key, so an older export still hashes the same');

  const incoming = validateConfigDocument({
    ...empty, tagRules: [{ scope: '*', hidden: ['Internal', 'internal'] }, { scope: 'provider:dam1', hidden: ['legal:*'] }],
  });
  assert.ok('doc' in incoming);
  const diff = diffConfigDocument(empty, incoming.doc, { prune: false }, new Set());
  assert.equal(diff.tagRules.create.length, 2);
  assert.deepEqual(requiredActions(diff).actions, ['policy.edit']);
  await commitConfigApply(store, diff, 'u1');
  const rules = await store.listCatalogTagRules();
  assert.deepEqual(rules.map((r) => [r.scope, r.hidden]), [['*', ['Internal']], ['provider:dam1', ['legal:*']]]);
  assert.equal(rules[0]?.updatedBy, 'user:u1');

  const exported = await buildConfigDocument(store);
  assert.deepEqual(exported.tagRules, [{ scope: '*', hidden: ['Internal'] }, { scope: 'provider:dam1', hidden: ['legal:*'] }]);
  const again = diffConfigDocument(exported, incoming.doc, { prune: false }, new Set());
  assert.equal(again.tagRules.unchanged.length, 2, 're-applying the same document changes nothing');

  const pruned = diffConfigDocument(exported, { ...exported, tagRules: [] }, { prune: true }, new Set());
  assert.equal(pruned.tagRules.delete.length, 2);
  await commitConfigApply(store, pruned, 'u1');
  assert.deepEqual(await store.listCatalogTagRules(), []);

  for (const bad of [{ tagRules: {} }, { tagRules: [{ scope: 'group:x', hidden: [] }] }, { tagRules: [{ scope: '*', hidden: ['*'] }] },
    { tagRules: [{ scope: '*', hidden: [] }, { scope: '*', hidden: [] }] }]) {
    assert.ok('errors' in validateConfigDocument({ ...empty, ...bad }), JSON.stringify(bad));
  }
});

test('migration 0065 creates the rules table the postgres driver writes', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql'));
  assert.ok(files.includes('0065_catalog_tag_rules.sql'));
  const sql = await readFile(join(dir, '0065_catalog_tag_rules.sql'), 'utf8');
  assert.match(sql, /create table catalog_tag_rules/);
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false);
  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into catalog_tag_rules \(scope, rule, updated_at\)/);
});

// ── over HTTP ───────────────────────────────────────────────────────────────

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const DAM_ASSETS = [
  {
    remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos', 'Internal'], tags: ['event', 'approved-2019'],
    collections: ['Launch Kit'], approved: true, formats: [{ format: 'png', remoteRef: 'att1', size: 10 }],
  },
  {
    remoteId: 'a2', name: 'Summit Banner', nativeType: 'file', sections: ['Banners'], tags: ['event', 'approved-2020'],
    approved: true, formats: [{ format: 'png', remoteRef: 'att2', size: 10 }],
  },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-tags-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: [{ id: 'acme/logo/primary', name: 'Acme Logo', type: 'vector', tags: ['logo', 'event'], formats: [{ format: 'svg', url: '/catalog/x.svg' }] }],
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Tags Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'author@test', groups: ['author'] },
    ] },
    catalogProviders: [
      { id: 'dam1', kind: 'mock', label: 'Acme DAM', enabled: true, options: { assets: DAM_ASSETS }, mapping: { hiddenTags: ['approved-2020'] } },
    ],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sT', link: 'lT' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const feed = async (cookie: string): Promise<AssetIndex> =>
  await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json() as AssetIndex;
const tagsOf = (index: AssetIndex, id: string): unknown => index.assets?.find((a) => a.id === id)?.tags;

test('over HTTP: hide and show take effect on the next read, with no re-sync and nothing dropped', async () => {
  const admin = await login('admin@test');
  const first = await feed(admin);
  assert.deepEqual(tagsOf(first, 'ext/dam1/a2'), ['provider:dam1', 'Banners', 'event'], 'the declared mapping list already applies');
  const syncedAt = (await store.getProvider('dam1'))?.state.lastSyncAt;

  const put = (body: unknown, cookie = admin) => fetch(`${base}/api/v1/catalog/tags/rules`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await put({ scope: '*', hide: ['Internal', 'approved-*'] })).status, 200);
  const hidden = await feed(admin);
  assert.deepEqual(tagsOf(hidden, 'ext/dam1/a1'), ['provider:dam1', 'Logos', 'event']);
  const meta = hidden.assets?.find((a) => a.id === 'ext/dam1/a1')?.meta as Record<string, unknown>;
  assert.deepEqual(meta.providerSections, ['Logos']);
  assert.deepEqual(meta.providerTags, ['event']);
  assert.equal(hidden.assets?.length, first.assets?.length, 'no asset left the feed');
  assert.equal((await store.getProvider('dam1'))?.state.lastSyncAt, syncedAt, 'no provider walk ran');

  assert.equal((await put({ scope: 'provider:dam1', hide: ['event'] })).status, 200);
  const scoped = await feed(admin);
  assert.deepEqual(tagsOf(scoped, 'acme/logo/primary'), ['logo', 'event'], 'a provider rule leaves the pack alone');
  assert.deepEqual(tagsOf(scoped, 'ext/dam1/a2'), ['provider:dam1', 'Banners']);

  // Search folds the same rules: a hidden label is not a reason to match.
  const search = await (await fetch(`${base}/api/v1/catalog/search?q=approved-2019`, { headers: { cookie: admin } })).json() as { results: unknown[] };
  assert.equal(search.results.length, 0);

  assert.equal((await put({ scope: '*', show: ['internal'] })).status, 200);
  assert.deepEqual(tagsOf(await feed(admin), 'ext/dam1/a1'), ['provider:dam1', 'Logos', 'Internal']);

  const census = await (await fetch(`${base}/api/v1/catalog/tags`, { headers: { cookie: admin } })).json() as {
    tags: Array<{ tag: string; count: number; sources: Record<string, number>; hiddenBy: Array<{ scope: string; pattern: string; declared?: boolean }> }>;
    rules: Array<{ scope: string; hidden: string[] }>; providers: Array<{ id: string; declared: string[] }>;
  };
  const row = (t: string) => census.tags.find((r) => r.tag === t);
  assert.deepEqual(row('event')?.sources, { pack: 1, dam1: 2 }, 'a hidden tag is still counted');
  assert.deepEqual(row('event')?.hiddenBy, [{ scope: 'provider:dam1', pattern: 'event' }]);
  assert.deepEqual(row('approved-2020')?.hiddenBy.map((h) => h.scope + (h.declared ? ' (declared)' : '')), ['*', 'provider:dam1 (declared)']);
  assert.deepEqual(census.providers.find((p) => p.id === 'dam1')?.declared, ['approved-2020']);
  const onlyDam = await (await fetch(`${base}/api/v1/catalog/tags?provider=dam1`, { headers: { cookie: admin } })).json() as { tags: Array<{ tag: string }> };
  assert.equal(onlyDam.tags.some((r) => r.tag === 'logo'), false, 'the provider census leaves the pack out');

  // Emptying a scope removes its row; the audit trail keeps before and after.
  assert.equal((await put({ scope: 'provider:dam1', hidden: [] })).status, 200);
  assert.equal((await store.listCatalogTagRules()).some((r) => r.scope === 'provider:dam1'), false);
  const audit = (await store.listAudit()).filter((e) => e.action === 'catalog.tags.update');
  assert.equal(audit.length, 4);
});

test('over HTTP: an author cannot hide tags, and a bad scope or provider is refused', async () => {
  const author = await login('author@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/tags`, { headers: { cookie: author } })).status, 403);
  const put = (body: unknown, cookie: string) => fetch(`${base}/api/v1/catalog/tags/rules`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await put({ scope: '*', hide: ['x'] }, author)).status, 403);
  const admin = await login('admin@test');
  assert.equal((await put({ scope: 'group:design', hide: ['x'] }, admin)).status, 400);
  assert.equal((await put({ scope: 'provider:nope', hide: ['x'] }, admin)).status, 404);
  assert.equal((await put({ scope: '*', hidden: ['a'], hide: ['b'] }, admin)).status, 400);
  assert.equal((await put({ scope: '*', hide: ['*'] }, admin)).status, 400);
});
