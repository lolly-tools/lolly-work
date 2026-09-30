import { after, test } from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, symlink, utimes } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';
import type { Store } from '../server/src/store/types.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { createBrandSources } from '../server/src/brand/sources.ts';
import { createBrandService } from '../server/src/brand/service.ts';

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });
function packBytes() {
  const zip = new ZipBuilder(new Date('2026-09-29T00:00:00Z'));
  const chunks = Object.entries({
    'manifest.json': JSON.stringify({ format: 'lolly-brand', formatVersion: 3 }),
    'instance.json': JSON.stringify({ instance: 'http://brand.example', name: 'Alpha', version: '1.0.0' }),
    'tokens.json': JSON.stringify({ color: { primary: { $type: 'color', $value: '#112233' } } }), 'pack.sig': 'test-signature',
  }).map(([name, value]) => zip.add(name, Buffer.from(value)));
  return Buffer.concat([...chunks, zip.end()]);
}
async function fixture(modern = false, store: Store = createMemoryStore()) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-brand-admin-'));
  const tool = { id: 'swatch', name: 'Swatch', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg'] }, inputs: [], hooks: { onInit: true } };
  await mkdir(join(pack, 'tools', 'swatch'), { recursive: true });
  await writeFile(join(pack, 'tools', 'swatch', 'tool.json'), JSON.stringify(tool));
  await writeFile(join(pack, 'tools', 'swatch', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="{{ink}}"/></svg>');
  await writeFile(join(pack, 'tools', 'swatch', 'hooks.js'), "async function onInit(){ return { ink: await host.tokens.resolve('color.primary') }; }");
  for (const [name, color] of [['alpha', '#112233'], ['beta', '#aabbcc']]) {
    const cat = join(pack, 'brands', name!, 'catalog');
    for (const path of ['assets', 'tools', 'fonts/webfonts']) await mkdir(join(cat, path), { recursive: true });
    const assets = [
      { id: 'shared/tokens/brand', name: `${name} tokens`, type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] },
      ...['light', 'dark'].map(theme => ({ id: `shared/logo/${theme}`, type: 'vector', tags: ['logo', 'horizontal', `on-${theme}`], formats: [{ format: 'svg', url: `/catalog/assets/${theme}.svg` }] })),
      ...(name === 'alpha' ? [{ id: 'alpha/only', type: 'vector', formats: [{ format: 'svg', url: '/catalog/assets/light.svg' }] }] : []),
    ];
    await writeFile(join(cat, 'assets', 'index.json'), JSON.stringify({ assets }));
    await writeFile(join(cat, 'assets', 'tokens.json'), JSON.stringify({ color: { primary: { $type: 'color', $value: color } } }));
    for (const theme of ['light', 'dark']) await writeFile(join(cat, 'assets', `${theme}.svg`), `<svg xmlns="http://www.w3.org/2000/svg"><title>${name}-${theme}</title></svg>`);
    await writeFile(join(cat, 'fonts', 'webfonts', 'Brand.woff2'), `${name}-font`);
    await writeFile(join(cat, 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [tool] }));
    await utimes(join(cat, 'tools', 'index.json'), 1700000000, 1700000000);
  }
  if (modern) await writeFile(join(pack, 'profiles.json'), JSON.stringify({ default: 'alpha', profiles: {
    alpha: { label: 'Alpha', tools: ['tools'], catalog: 'brands/alpha/catalog' },
    beta: { label: 'Beta', tools: ['tools'], catalog: 'brands/beta/catalog' },
  } }));
  else { await writeFile(join(pack, '.lolly-profile'), 'alpha\n'); await symlink('brands/alpha/catalog', join(pack, 'catalog')); }
  const config = parseConfig(JSON.stringify({ instance: { name: 'Example', baseUrl: 'http://brand.example', pack },
    rateLimit: { enabled: false }, render: { allowHooksInFastPath: true },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'admin@test', groups: ['admin'] }, { email: 'member@test', groups: ['member'] }] } }));
  const blobs = createMemoryBlobStore();
  const boot = async (replica: Store = store) => {
    const app = buildApp({ config, store: replica, blobs, secrets: { session: 'brand-test-session', link: 'brand-test-link' } });
    const server = createServer((req, res) => void app(req, res)); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  return { pack, config, store, blobs, boot };
}
async function login(base: string, role = 'owner') {
  const res = await fetch(`${base}/api/auth/dev?email=${role}@test`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function post(base: string, cookie: string, route: string, body: unknown) {
  const res = await fetch(base + route, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() as any };
}
async function review(base: string, cookie: string, change: object) {
  const res = await post(base, cookie, '/api/v1/brand/changes/preview', change);
  assert.equal(res.status, 200, JSON.stringify(res.body)); return res.body;
}
async function apply(base: string, cookie: string, reviewed: any) {
  return post(base, cookie, '/api/v1/brand/changes', { ...reviewed.change, revision: reviewed.revision, reviewToken: reviewed.reviewToken });
}

test('inventory is member gated, preserves old fields and exposes source facts without filesystem paths', async () => {
  const f = await fixture(), base = await f.boot(), member = await login(base, 'member');
  assert.equal((await fetch(base + '/api/v1/brand/profiles')).status, 401);
  const response = await fetch(base + '/api/v1/brand/profiles', { headers: { cookie: member } });
  const raw = await response.text(), data = JSON.parse(raw);
  assert.equal(data.available, true); assert.equal(data.active, 'alpha'); assert.equal(data.profiles.length, 2);
  assert.equal(data.sources[0].tokensHead, 'shared/tokens/brand');
  assert.equal(data.sources[0].operations.select, false);
  assert.equal(raw.includes(f.pack), false); assert.equal(raw.includes('lw-brand-sources-'), false);
  assert.equal((await post(base, member, '/api/v1/brand/changes/preview', { action: 'select', sourceId: 'profile:beta' })).status, 403);
});

test('active retirement needs a replacement; stale previews and permission changes cannot apply', async () => {
  const f = await fixture(), base = await f.boot(), owner = await login(base), admin = await login(base, 'admin');
  const blocked = await review(base, owner, { action: 'retire', sourceId: 'profile:alpha' });
  assert.ok(blocked.blockers.length);
  assert.equal((await apply(base, owner, blocked)).status, 409);
  assert.equal((await post(base, admin, '/api/v1/brand/changes/preview', { action: 'retire', sourceId: 'profile:alpha', replacementId: 'profile:beta' })).status, 403);
  const first = await review(base, owner, { action: 'select', sourceId: 'profile:beta' });
  const second = await review(base, owner, { action: 'stop-download', sourceId: 'download' });
  assert.equal((await apply(base, owner, second)).status, 200);
  assert.equal((await apply(base, owner, first)).body.error.code, 'STALE_PREVIEW');
  const fresh = await review(base, admin, { action: 'select', sourceId: 'profile:beta' });
  await f.store.putGrant({ principal: 'group:admin', action: 'brand.switch', resource: '*', effect: 'deny' });
  assert.equal((await apply(base, admin, fresh)).status, 403);
});

test('two replicas observe tokens, both logos, fonts, catalogue and render revisions with identical tool indices', async () => {
  const f = await fixture(), a = await f.boot(), b = await f.boot(), owner = await login(a);
  const headers = { cookie: owner };
  const before = await fetch(b + '/render/swatch.svg', { headers });
  assert.equal(before.status, 200, await before.clone().text()); assert.match(await before.text(), /#112233/);
  const beforeOrg = await fetch(b + '/api/v1/org-config', { headers });
  assert.match(await (await fetch(b + '/api/brand/logo/light')).text(), /alpha-light/);
  const inspected = await review(a, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.deepEqual(inspected.impact.removedAssets, ['alpha/only']);
  assert.equal((await apply(a, owner, inspected)).status, 200);
  const after = await fetch(b + '/render/swatch.svg', { headers: { ...headers, 'if-none-match': before.headers.get('etag')! } });
  assert.equal(after.status, 200); assert.match(await after.text(), /#aabbcc/);
  for (const theme of ['light', 'dark']) assert.match(await (await fetch(b + `/api/brand/logo/${theme}`)).text(), new RegExp(`beta-${theme}`));
  assert.equal(await (await fetch(b + '/api/brand/font/Brand.woff2')).text(), 'beta-font');
  const tokens = await (await fetch(b + '/catalog/assets/tokens.json', { headers })).json() as any;
  assert.equal(tokens.color.primary.$value, '#aabbcc');
  assert.equal((await fetch(b + '/api/v1/org-config', { headers: { ...headers, 'if-none-match': beforeOrg.headers.get('etag')! } })).status, 200);
  assert.equal(await readFile(join(f.pack, '.lolly-profile'), 'utf8'), 'alpha\n');
  const restarted = await f.boot();
  assert.equal((await (await fetch(restarted + '/api/v1/instance')).json() as any).brand.profile, 'beta');
});

test('configured downloads stay suppressed after restart and can be explicitly enabled again', async () => {
  const f = await fixture();
  await writeFile(join(f.pack, 'connect.lolly'), packBytes()); f.config.instance.connectPack = 'connect.lolly';
  const a = await f.boot(), owner = await login(a);
  assert.equal((await fetch(a + '/connect/pack.lolly', { headers: { cookie: owner } })).status, 200);
  const stop = await review(a, owner, { action: 'stop-download', sourceId: 'download' });
  assert.equal((await apply(a, owner, stop)).status, 200);
  const b = await f.boot();
  assert.equal((await fetch(b + '/connect/pack.lolly', { headers: { cookie: owner } })).status, 404);
  assert.equal((await (await fetch(b + '/api/v1/instance')).json() as any).connect, undefined);
  const enable = await review(b, owner, { action: 'enable-download', sourceId: 'download' });
  assert.equal((await apply(b, owner, enable)).status, 200);
  const change = await review(b, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.equal(change.impact.downloadWithdrawn, true);
  assert.equal((await apply(b, owner, change)).status, 200);
  assert.equal((await fetch(a + '/connect/pack.lolly', { headers: { cookie: owner } })).status, 404);
  const staleOffer = await review(a, owner, { action: 'enable-download', sourceId: 'download' });
  assert.ok(staleOffer.blockers.length);
});

test('retirement and restore retain mounted bytes and expose the reference impact', async () => {
  const f = await fixture(), base = await f.boot(), owner = await login(base);
  const actor = (await f.store.listUsers())[0]!;
  await f.store.putProject({ id: 'personal', name: 'Personal work', ownerId: actor.id, visibility: 'private', createdAt: new Date().toISOString() });
  await f.store.putSession({ id: 'saved', projectId: 'personal', toolId: 'swatch', toolVersion: '1.0.0', inputs: { logo: 'alpha/only' }, meta: {}, createdBy: actor.id, updatedBy: actor.id, rev: 1, updatedAt: new Date().toISOString() });
  const change = await review(base, owner, { action: 'retire', sourceId: 'profile:alpha', replacementId: 'profile:beta' });
  assert.equal(change.impact.affectedSessions, 1);
  assert.equal((await apply(base, owner, change)).status, 200);
  assert.ok(await f.store.getSession('saved'));
  assert.match(await readFile(join(f.pack, 'brands', 'alpha', 'catalog', 'assets', 'light.svg'), 'utf8'), /alpha-light/);
  const rejected = await review(base, owner, { action: 'select', sourceId: 'profile:alpha' }); assert.ok(rejected.blockers.length);
  const restored = await review(base, owner, { action: 'restore', sourceId: 'profile:alpha' });
  assert.equal((await apply(base, owner, restored)).status, 200);
  const selected = await review(base, owner, { action: 'select', sourceId: 'profile:alpha' });
  assert.equal((await apply(base, owner, selected)).status, 200);
});

test('modern profiles use the same source adapter and ephemeral production advertises its limitation', async () => {
  const f = await fixture(true), base = await f.boot(), owner = await login(base);
  const change = await review(base, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.equal((await apply(base, owner, change)).status, 200);
  assert.equal((await (await fetch(base + '/api/v1/instance')).json() as any).brand.profile, 'beta');
  f.config.dev.enabled = false;
  const service = createBrandService(f.config, f.store, f.blobs), actor = (await f.store.listUsers())[0]!;
  const inventory = await service.inventory(actor);
  assert.equal(inventory.mutable, false); assert.match(inventory.limitation!, /persist/);
  const blocked = await service.preview(actor, { action: 'select', sourceId: 'profile:alpha' });
  assert.ok(blocked.blockers.length);
});


test('missing persisted source keeps inventory and replacement controls available without serving another brand', async () => {
  const f = await fixture();
  const state = await f.store.getBrandState();
  await f.store.casBrandState(0, { ...state, activeSource: 'profile:missing' }, { at: new Date().toISOString(), actor: 'test', action: 'brand.select', subject: 'profile:missing' });
  const base = await f.boot(), owner = await login(base);
  const inventory = await (await fetch(base + '/api/v1/brand/profiles', { headers: { cookie: owner } })).json() as any;
  assert.equal(inventory.activeSource, 'profile:missing');
  assert.ok(inventory.sources.find((s: any) => s.id === 'profile:missing').diagnostics.length);
  assert.equal((await fetch(base + '/api/brand')).status, 404);
  assert.equal((await fetch(base + '/api/brand/logo/light')).status, 404);
  const change = await review(base, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.equal((await apply(base, owner, change)).status, 200);
  assert.match(await (await fetch(base + '/api/brand/logo/light')).text(), /beta-light/);
});

test('an upload from another source is rejected and revision preconditions reject mixed requests', async () => {
  const f = await fixture(), base = await f.boot(), owner = await login(base);
  const before = await fetch(base + '/api/v1/instance');
  const selected = await review(base, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.ok(selected.impact.changedAssets.includes('shared/logo/light'));
  assert.equal((await apply(base, owner, selected)).status, 200);
  const upload = await fetch(base + '/api/v1/instance-pack', { method: 'PUT', headers: { cookie: owner }, body: new Uint8Array(packBytes()) });
  assert.equal(upload.status, 400); assert.equal((await upload.json() as any).error.code, 'PACK_SOURCE_MISMATCH');
  const stale = await fetch(base + '/catalog/assets/tokens.json', { headers: { cookie: owner, 'x-lolly-brand-revision': before.headers.get('x-lolly-brand-revision')! } });
  assert.equal(stale.status, 409);
  assert.equal((await stale.json() as any).error.code, 'BRAND_REVISION_CHANGED');
});

test('tokens versions are excluded; independent heads need an explicit choice and single mounts are visible', async () => {
  const f = await fixture();
  const root = join(f.pack, 'brands', 'alpha');
  const indexPath = join(root, 'catalog/assets/index.json');
  const index = JSON.parse(await readFile(indexPath, 'utf8'));
  index.assets.push({ ...index.assets[0], id: 'shared/tokens/brand/v1' });
  await writeFile(indexPath, JSON.stringify(index));
  const first = (await createBrandSources(root).inventory()).sources[0]!;
  assert.equal(first.kind, 'mounted'); assert.equal(first.tokensHead, 'shared/tokens/brand');
  assert.deepEqual(first.diagnostics, []);
  index.assets.push({ ...index.assets[0], id: 'other/tokens' });
  await writeFile(indexPath, JSON.stringify(index));
  assert.match((await createBrandSources(root).inventory()).sources[0]!.diagnostics.join(' '), /Multiple tokens/);
  assert.equal((await createBrandSources(root, { mounted: 'other/tokens' }).inventory()).sources[0]!.tokensHead, 'other/tokens');
  index.brandTokens = null;
  await writeFile(indexPath, JSON.stringify(index));
  const neutral = (await createBrandSources(root).inventory()).sources[0]!;
  assert.equal(neutral.tokensHead, null); assert.deepEqual(neutral.diagnostics, []);
});

const databaseUrl = process.env.LW_TEST_DATABASE_URL;
test('Postgres HTTP replicas and a fresh pool retain selection, retirement and download suppression', { skip: !databaseUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(databaseUrl!, async store => {
    const f = await fixture(true, store);
    await writeFile(join(f.pack, 'connect.lolly'), packBytes()); f.config.instance.connectPack = 'connect.lolly';
    const replica = await createPostgresStore(databaseUrl!);
    try {
      const a = await f.boot(), b = await f.boot(replica), owner = await login(a);
      assert.equal((await fetch(a + '/connect/pack.lolly', { headers: { cookie: owner } })).status, 200);
      const stopped = await review(a, owner, { action: 'stop-download', sourceId: 'download' });
      assert.equal((await apply(a, owner, stopped)).status, 200);
      const retired = await review(a, owner, { action: 'retire', sourceId: 'profile:alpha', replacementId: 'profile:beta' });
      assert.equal((await apply(a, owner, retired)).status, 200);
      assert.match(await (await fetch(b + '/render/swatch.svg', { headers: { cookie: owner } })).text(), /#aabbcc/);
      assert.equal((await fetch(b + '/connect/pack.lolly', { headers: { cookie: owner } })).status, 404);
    } finally { await replica.close(); }
    const restarted = await createPostgresStore(databaseUrl!);
    try {
      const base = await f.boot(restarted);
      const state = await restarted.getBrandState();
      assert.equal(state.activeSource, 'profile:beta'); assert.equal(state.download.suppressed, true);
      assert.deepEqual(state.retired, ['profile:alpha']);
      assert.equal((await (await fetch(base + '/api/v1/instance')).json() as any).brand.profile, 'beta');
    } finally { await restarted.close(); }
  });
});


test('CLI reviews and applies the same permission and stale-preview contract', async () => {
  const f = await fixture(true), base = await f.boot(), owner = await login(base);
  const created = await post(base, owner, '/api/v1/tokens', { label: 'Brand test', role: 'owner' });
  assert.equal(created.status, 201);
  const run = (args: string[]) => promisify(execFile)(process.execPath, ['cli/lw.ts', ...args], {
    env: { ...process.env, LW_BASE: base, LW_TOKEN: created.body.token },
  });
  const listed = JSON.parse((await run(['brand'])).stdout);
  assert.equal(listed.activeSource, 'profile:alpha');
  const reviewed = await run(['brand', 'preview', 'retire', 'profile:alpha', '--replacement=profile:beta']);
  const file = join(f.pack, 'review.json');
  await writeFile(file, reviewed.stdout);
  const applied = JSON.parse((await run(['brand', 'apply', file])).stdout);
  assert.equal(applied.impact.to.id, 'profile:beta');
  assert.equal((await f.store.getBrandState()).activeSource, 'profile:beta');
  await assert.rejects(run(['brand', 'apply', file]), /stale/i);
  const events = await f.store.listAudit();
  assert.ok(events.some(event => event.action === 'brand.retire'));
});

test('modern shared asset roots keep their served URLs and namespace through selection', async () => {
  const f = await fixture(true);
  await mkdir(join(f.pack, 'shared-icons'));
  await writeFile(join(f.pack, 'shared-icons', 'mark.svg'), '<svg xmlns="http://www.w3.org/2000/svg"><title>shared mark</title></svg>');
  await writeFile(join(f.pack, 'shared-icons', 'index.json'), JSON.stringify({ assets: [
    { id: 'shared-icons/mark', type: 'vector', formats: [{ format: 'svg', url: '/catalog/packs/shared-icons/mark.svg' }] },
  ] }));
  const path = join(f.pack, 'profiles.json');
  const profiles = JSON.parse(await readFile(path, 'utf8'));
  for (const profile of Object.values(profiles.profiles) as Array<{ assets?: string[] }>) profile.assets = ['shared-icons'];
  await writeFile(path, JSON.stringify(profiles));
  const base = await f.boot(), owner = await login(base), headers = { cookie: owner };
  const before = await (await fetch(base + '/catalog/assets/index.json', { headers })).json() as any;
  assert.ok(before.assets.some((asset: any) => asset.id === 'shared-icons/mark'));
  const next = await review(base, owner, { action: 'select', sourceId: 'profile:beta' });
  assert.ok(next.impact.sharedAssets.includes('shared-icons/mark'));
  assert.ok(!next.impact.changedAssets.includes('shared-icons/mark'));
  assert.equal((await apply(base, owner, next)).status, 200);
  assert.match(await (await fetch(base + '/catalog/packs/shared-icons/mark.svg', { headers })).text(), /shared mark/);
});
