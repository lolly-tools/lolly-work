import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import type { Store } from '../server/src/store/types.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { createBrandService } from '../server/src/brand/service.ts';
import { managedRuleContext, markBrandDraft } from '../server/src/brand/rules.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';
import { renderTool } from '../server/src/render/pipeline.ts';
import type { BrandSystemV1 } from '@lolly-tools/core/brand-system-v1';
const servers: Server[] = [], dirs: string[] = [], runners: RenderRunner[] = [];
after(async () => { await Promise.all(runners.map(r => r.stop())); await Promise.all(servers.map(server => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }))); await Promise.all(dirs.map(dir => rm(dir, { recursive: true, force: true }))); });
const rule = (kind: string, slot: string, parameters: object = {}) => ({ id: kind, label: kind, kind, roleIds: kind === 'color-choices' ? ['beacon'] : [], parameters: { slot, ...parameters }, requirement: 'required' as const, origin: { kind: 'manual' as const, author: 'Studio' }, review: { state: 'approved' as const, authority: 'Studio' } });
const brand = (): BrandSystemV1 => ({ schemaVersion: 1, id: 'sample', label: 'Our system', roles: [{ id: 'beacon', label: 'Beacon', resources: [{ type: 'token', path: 'color.beacon' }] }], bindings: [{ id: 'accent', roleId: 'beacon', consumer: { tool: 'brand-poster', slot: 'accent' } }], rules: [rule('color-choices', 'accent'), rule('text-length', 'heading', { max: 10 })] });
const mappings = [{ toolId: 'campaign', example: 'brand-poster', mode: 'Default', fields: { accent: 'ink', heading: 'title' } }];
async function fixture(system: unknown = brand(), hooks?: string, store: Store = createMemoryStore()) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rules-')); dirs.push(pack);
  for (const path of ['catalog/assets', 'catalog/tools', 'tools/campaign']) await mkdir(join(pack, path), { recursive: true });
  const manifest = { id: 'campaign', name: 'Campaign', version: '1.0.0', engineVersion: '^1.0.0', description: 'Managed rule fixture', status: 'community',
    inputs: [{ id: 'ink', type: 'color', label: 'Ink', default: '#ffcc00' }, { id: 'title', type: 'text', label: 'Title', default: 'Hello' }],
    render: { formats: ['svg', 'png'], width: 100, height: 80 }, ...(hooks ? { hooks: { onInit: true, beforeExport: true } } : {}) };
  await writeFile(join(pack, 'tools/campaign/tool.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'tools/campaign/template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="80"><rect width="100" height="80" fill="{{ink}}"/><text x="2" y="30">{{title}}</text></svg>');
  if (hooks) await writeFile(join(pack, 'tools/campaign/hooks.js'), hooks);
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify({ tools: [manifest] }));
  await writeFile(join(pack, 'catalog/assets/index.json'), JSON.stringify({ assets: [{ id: 'sample/tokens', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] }] }));
  await writeFile(join(pack, 'catalog/assets/tokens.json'), JSON.stringify({ color: { beacon: { $type: 'color', $value: '#ffcc00' } }, ...(system === null ? {} : { $extensions: { 'com.suse.lolly': { brandSystem: system } } }) }));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Test', baseUrl: 'http://rules.example', pack }, rateLimit: { enabled: false }, render: { allowHooksInFastPath: true }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'member@test', groups: ['member'] }] } }));
  const blobs = createMemoryBlobStore();
  const boot = async (replica: Store = store) => {
    const app = buildApp({ config, store: replica, blobs, secrets: { session: 'rules-session', link: 'rules-link' }, onRenderRunner: r => { runners.push(r); r.start(); } });
    const server = createServer((req, res) => void app(req, res)); servers.push(server);
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  };
  const base = await boot();
  const login = async (role = 'owner') => (await fetch(`${base}/api/auth/dev?email=${role}@test`, { redirect: 'manual' })).headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
  const cookie = await login();
  const post = async (path: string, body: unknown, auth = cookie) => {
    const res = await fetch(base + path, { method: 'POST', headers: { cookie: auth, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, data: await res.json() as any };
  };
  const preview = () => post('/api/v1/brand/rules/preview', { mappings });
  const apply = (data: any) => post('/api/v1/brand/rules', { mappings: data.mappings, revision: data.revision, reviewToken: data.reviewToken });
  const configure = async () => { const review = await preview(); assert.equal(review.status, 200, JSON.stringify(review.data)); assert.equal((await apply(review.data)).status, 200); };
  return { pack, config, store, blobs, base, cookie, boot, login, post, preview, apply, configure };
}

test('legacy packs retain rendering and unknown guides produce visibly labelled drafts', async () => {
  for (const system of [null, { schemaVersion: 999 }, { ...brand(), rules: [rule('unsupported-geometry', 'device')] }]) {
    const f = await fixture(system);
    const res = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
    assert.equal(res.status, 200, await res.clone().text());
    assert.equal((await res.text()).includes('DRAFT'), system !== null);
  }
});
test('mapping review is permission gated, stale safe, audited and visible across replicas', async () => {
  const f = await fixture(), member = await f.login('member');
  assert.equal((await f.post('/api/v1/brand/rules/preview', { mappings }, member)).status, 403);
  const old = await f.preview(), fresh = await f.preview();
  assert.equal((await f.apply(fresh.data)).status, 200);
  assert.equal((await f.apply(old.data)).data.error.code, 'STALE_PREVIEW');
  const second = await f.boot();
  const view = await (await fetch(second + '/api/v1/brand/rules', { headers: { cookie: f.cookie } })).json() as any;
  assert.deepEqual(view.mappings, mappings);
  const org = await (await fetch(second + '/api/v1/org-config', { headers: { cookie: f.cookie } })).json() as any;
  assert.deepEqual(org.tools.campaign.inputs.find((i: any) => i.id === 'ink').access.allow, ['#ffcc00']);
  assert.ok((await f.store.listAudit()).some(e => e.action === 'brand.rules.update'));
  const next = await f.preview();
  await f.store.putGrant({ principal: 'group:owner', action: 'policy.edit', resource: '*', effect: 'deny' });
  assert.equal((await f.apply(next.data)).status, 403);
});
test('HTTP and direct durable execution share required input constraints and output-bound evidence', async () => {
  const f = await fixture(); await f.configure();
  const headers = { cookie: f.cookie };
  const good = await fetch(f.base + '/render/campaign.svg', { headers });
  assert.equal(good.status, 200, await good.clone().text()); assert.doesNotMatch(await good.text(), /DRAFT/);
  for (const query of ['ink=%23ff0000', 'title=This%20is%20far%20too%20long']) {
    const bad = await fetch(f.base + `/render/campaign.svg?${query}`, { headers });
    assert.equal(bad.status, 422, await bad.clone().text());
  }
  const service = createBrandService(f.config, f.store, f.blobs), snap = await service.snapshot();
  const managedRules = await managedRuleContext(snap, 'campaign', 'svg');
  const out = await renderTool({ config: { ...f.config, instance: { ...f.config.instance, pack: snap.source.root } }, captureEvidence: true, managedRules }, { toolId: 'campaign', format: 'svg', query: '', principal: { groups: ['owner'] }, profile: {}, overlays: new Map() });
  assert.equal(out.evidence?.brandRules?.disposition, 'checked');
  assert.equal(out.evidence?.brandRules?.scope, 'runtime-inputs');
  assert.equal(out.evidence?.brandRules?.revision, snap.revision);
  assert.ok(out.evidence?.outputSha256);
});
test('existing organisation locks cannot be weakened by brand mappings', async () => {
  const f = await fixture(); await f.configure();
  await f.store.putOverlay({ toolId: 'campaign', version: 1, inputAccess: { ink: [{ groups: ['*'], level: 'locked', value: '#ff0000' }] } });
  const org = await (await fetch(f.base + '/api/v1/org-config', { headers: { cookie: f.cookie } })).json() as any;
  assert.equal(org.tools.campaign.inputs.find((i: any) => i.id === 'ink').access.level, 'locked');
  const res = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
  assert.equal(res.status, 422); assert.equal((await res.json() as any).error.code, 'BRAND_RULE_VIOLATION');
});
test('runtime hook cannot bypass the final input observation', async () => {
  const f = await fixture(brand(), "function onInit(){ return {ink:'#ff0000'}; }"); await f.configure();
  const res = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
  assert.equal(res.status, 422, await res.clone().text());
  assert.equal((await res.json() as any).error.code, 'BRAND_RULE_VIOLATION');
});
test('missing fields remain draft and stale source bytes cannot use a reviewed mapping', async () => {
  const f = await fixture();
  const review = await f.post('/api/v1/brand/rules/preview', { mappings: [{ ...mappings[0], fields: { accent: 'ink' } }] });
  assert.equal((await f.apply(review.data)).status, 200);
  const out = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
  assert.match(await out.text(), /DRAFT/);
  const path = join(f.pack, 'catalog/assets/tokens.json');
  const doc = JSON.parse(await readFile(path, 'utf8')); doc.color.beacon.$value = '#000000'; await writeFile(path, JSON.stringify(doc));
  const stale = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
  assert.equal(stale.status, 409); assert.equal((await stale.json() as any).error.code, 'BRAND_REVISION_CHANGED');
});
test('draft marking is above the artwork and cannot be suppressed by a known pattern id', () => {
  const svg = '<svg><rect id="lw-preview-watermark" width="100%" height="100%" fill="black"/></svg>';
  assert.ok(markBrandDraft(svg).indexOf('DRAFT') > svg.indexOf('fill="black"'));
  assert.throws(() => markBrandDraft('not an SVG'));
});

test('organisation choices govern omitted defaults and hook-produced values', async () => {
  for (const hooks of [undefined, "function onInit(){ return {title:'No'}; }"]) {
    const f = await fixture(brand(), hooks); await f.configure();
    await f.store.putOverlay({ toolId: 'campaign', version: 1, inputAccess: { title: [{ groups: ['*'], level: 'choice', allow: hooks ? ['Hello'] : ['No'] }] } });
    const res = await fetch(f.base + '/render/campaign.svg', { headers: { cookie: f.cookie } });
    assert.equal(res.status, 422, await res.clone().text());
    assert.equal((await res.json() as any).error.code, 'INPUT_NOT_ALLOWED');
  }
});
test('durable render downloads preserve draft marking, scoped receipt and filename', async () => {
  const f = await fixture();
  const submitted = await f.post('/api/v1/renders', { toolId: 'campaign', format: 'svg', inputs: {} });
  assert.equal(submitted.status, 202, JSON.stringify(submitted.data));
  let record: any;
  for (let n = 0; n < 200; n++) {
    record = await (await fetch(f.base + `/api/v1/renders/${submitted.data.id}`, { headers: { cookie: f.cookie } })).json();
    if (['succeeded', 'failed'].includes(record.state)) break;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.equal(record.state, 'succeeded', JSON.stringify(record));
  assert.equal(record.output.brandRules.disposition, 'draft');
  assert.equal(record.output.brandRules.scope, 'runtime-inputs');
  const download = await fetch(f.base + `/api/v1/renders/${record.id}/output/default`, { headers: { cookie: f.cookie } });
  assert.equal(download.headers.get('x-lolly-brand-check'), 'draft');
  assert.match(download.headers.get('content-disposition')!, /DRAFT/);
  assert.match(await download.text(), /DRAFT/);
});

test('format scope is checked per render and never projected as a global restriction', async () => {
  const system = brand(); system.rules = [ { ...system.rules[0]!, scope: { outputs: ['png'] } } ];
  const f = await fixture(system); await f.configure();
  const org = await (await fetch(f.base + '/api/v1/org-config', { headers: { cookie: f.cookie } })).json() as any;
  assert.equal(org.tools.campaign?.inputs.find((i: any) => i.id === 'ink').access?.level, undefined);
  const svg = await fetch(f.base + '/render/campaign.svg?ink=%23ff0000', { headers: { cookie: f.cookie } });
  assert.equal(svg.status, 200, await svg.clone().text());
  assert.equal(svg.headers.get('x-lolly-brand-check'), 'not-applicable');
  const png = await fetch(f.base + '/render/campaign.png?ink=%23ff0000', { headers: { cookie: f.cookie } });
  assert.equal(png.status, 422, await png.clone().text());
});

test('Postgres mappings and their audit survive a fresh replica', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    const start = runners.length;
    let replica: Awaited<ReturnType<typeof createPostgresStore>> | undefined;
    try {
      const f = await fixture(brand(), undefined, store); await f.configure();
      replica = await createPostgresStore(process.env.LW_TEST_DATABASE_URL!);
      const base = await f.boot(replica);
      const result = await fetch(base + '/api/v1/brand/rules', { headers: { cookie: f.cookie } });
      assert.equal(result.status, 200);
      assert.deepEqual((await result.json() as any).mappings, mappings);
      assert.ok((await replica.listAudit()).some(e => e.action === 'brand.rules.update'));
      const res = await fetch(base + '/render/campaign.svg?title=This%20is%20far%20too%20long', { headers: { cookie: f.cookie } });
      assert.equal(res.status, 422);
    } finally { await Promise.all(runners.slice(start).map(r => r.stop())); await replica?.close(); }
  });
});
