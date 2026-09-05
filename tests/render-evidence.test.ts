import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { renderTool, type RenderDeps, type RenderRequest } from '../server/src/render/pipeline.ts';
import { normalizeParams, renderCacheKey } from '../server/src/render/cache-key.ts';
import { createAssetObserver, evidenceHash } from '../server/src/render/evidence.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { queryFromInputs } from '../server/src/automation/verbs.ts';
import type { AssetRef } from '../server/src/render/contract.ts';

const template = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><text>{{title}}</text>{{#each rows}}<text>{{label}}</text>{{/each}}<image href="{{logo.url}}"/></svg>';
const logo = (color: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5" fill="${color}"/></svg>`);
async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-evidence-'));
  t.after(() => rm(pack, { recursive: true, force: true }));
  await mkdir(join(pack, 'tools', 'receipt-card'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  const manifest = {
    id: 'receipt-card', name: 'Receipt card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [
      { id: 'title', label: 'Title', type: 'text', default: 'Default', bindToProfile: 'firstname' },
      { id: 'rows', label: 'Rows', type: 'blocks', default: [], fields: [{ id: 'label', label: 'Label', type: 'text' }] },
      { id: 'logo', label: 'Logo', type: 'asset', default: null },
    ],
  };
  await writeFile(join(pack, 'tools', 'receipt-card', 'tool.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'tools', 'receipt-card', 'template.html'), template);
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'receipt-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [
    { id: 'brand/logo', name: 'Logo', type: 'vector', version: '1.0.0', formats: [{ format: 'svg', url: 'assets/logo.svg', checksum: 'declared-stale-checksum' }] },
  ] }));
  await writeFile(join(pack, 'catalog', 'assets', 'logo.svg'), logo('red'));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Evidence', baseUrl: 'http://localhost', pack }, dev: { enabled: true } }));
  const request: RenderRequest = { toolId: 'receipt-card', format: 'svg', query: '', principal: { groups: ['admin'] }, profile: {}, overlays: new Map() };
  const render = (req: Partial<RenderRequest> = {}, deps: Partial<RenderDeps> = {}) => renderTool({ config, ...deps }, { ...request, ...req });
  return { pack, manifest, render };
}

test('cache keys preserve JSON types, nested values and array order while normalizing object keys', () => {
  const parts = { toolId: 'card', toolVersion: '1', engineVersion: '1', catalogVersion: '1', policyVersion: '1', format: 'svg' };
  const key = (params: Record<string, unknown>) => renderCacheKey({ ...parts, params });
  assert.equal(key({ a: { z: 1, b: true }, rows: [1, 2] }), key({ rows: [1, 2], a: { b: true, z: 1 } }));
  for (const [a, b] of [[{ n: 1 }, { n: '1' }], [{ n: true }, { n: 'true' }], [{ n: null }, { n: 'null' }],
    [{ n: { x: 1 } }, { n: { x: 2 } }], [{ n: [1, 2] }, { n: [2, 1] }]] as const) assert.notEqual(key(a), key(b));
  assert.equal(normalizeParams({ b: 1, a: { z: true } }), '{"a":{"z":true},"b":1}');
});

test('real rendering never shares cached profile-bound values or different block rows', async (t) => {
  const f = await fixture(t);
  const ada = await f.render({ profile: { firstname: 'Ada', useDetails: true } });
  const ben = await f.render({ profile: { firstname: 'Ben', useDetails: true } });
  assert.notEqual(ada.cacheKey, ben.cacheKey);
  assert.match(Buffer.from(ada.bytes).toString(), />Ada</); assert.match(Buffer.from(ben.bytes).toString(), />Ben</);
  const a = await f.render({ query: queryFromInputs({ rows: [{ label: 'First' }] }) });
  const b = await f.render({ query: queryFromInputs({ rows: [{ label: 'Second' }] }) });
  assert.notEqual(a.cacheKey, b.cacheKey);
  assert.match(Buffer.from(a.bytes).toString(), /First/); assert.match(Buffer.from(b.bytes).toString(), /Second/);
});

test('watermark, dimensions and same-version source edits produce distinct cached outputs', async (t) => {
  const f = await fixture(t);
  const clean = await f.render();
  const marked = await f.render({ watermarkPreview: true });
  assert.notEqual(clean.cacheKey, marked.cacheKey);
  assert.doesNotMatch(Buffer.from(clean.bytes).toString(), /lw-preview-watermark/);
  assert.match(Buffer.from(marked.bytes).toString(), /lw-preview-watermark/);
  const small = await f.render({ query: 'width=100' });
  const large = await f.render({ query: 'width=200' });
  assert.notEqual(small.cacheKey, large.cacheKey);
  assert.match(Buffer.from(large.bytes).toString(), /width="200"/);
  await writeFile(join(f.pack, 'tools', 'receipt-card', 'template.html'), template.replace('<text>', '<text data-revision="2">'));
  const edited = await f.render();
  assert.notEqual(clean.cacheKey, edited.cacheKey);
  assert.match(Buffer.from(edited.bytes).toString(), /data-revision="2"/);
});

test('fresh receipts record actual catalog bytes, effective profile and loaded sources without backfilling cached bytes', async (t) => {
  const f = await fixture(t);
  const req = { query: queryFromInputs({ logo: 'brand/logo' }), profile: { firstname: 'Private Firstname', email: 'private@example.com', useDetails: true } };
  const old = await f.render(req);
  assert.equal(old.evidence, undefined);
  await writeFile(join(f.pack, 'catalog', 'assets', 'logo.svg'), logo('blue'));
  const next = await f.render(req, { captureEvidence: true });
  const e = next.evidence!;
  assert.equal(e.coverage, 'partial'); assert.equal(e.apiVersion, '1.0.0');
  assert.equal(e.outputSha256, sha256Hex(next.bytes));
  const { id, ...body } = e; assert.equal(id, evidenceHash(body));
  assert.notDeepEqual(next.bytes, old.bytes, 'observations and bytes come from this fresh execution');
  assert.deepEqual(e.assets, [{ source: 'catalog', id: 'brand/logo', format: 'svg', version: '1.0.0', sha256: sha256Hex(logo('blue')), size: logo('blue').length }]);
  assert.equal(e.tool.sourceHash, evidenceHash(e.tool.files));
  assert.equal(e.tool.files.find((file) => file.path.endsWith('template.html'))!.sha256, sha256Hex(template));
  assert.equal(e.tool.scope, 'local-runtime'); assert.ok(e.runtime?.initialValuesHash);
  assert.equal(e.context.profileHash, evidenceHash(req.profile));
  assert.ok(e.limitations.includes('engine-dependency-graph-unavailable'));
  assert.ok(e.limitations.includes('dependencies-not-locked'));
  assert.doesNotMatch(JSON.stringify(e), /Private Firstname|private@example\.com|data:image|declared-stale-checksum/);
  assert.deepEqual((await f.render(req, { captureEvidence: true })).evidence, e, 'unchanged observations and SVG produce the same receipt');
  const changed = await f.render({ ...req, profile: { ...req.profile, firstname: 'Changed' } }, { captureEvidence: true });
  assert.notEqual(changed.evidence!.context.profileHash, e.context.profileHash);
  assert.notEqual(changed.evidence!.runtime!.initialValuesHash, e.runtime!.initialValuesHash);
  assert.notEqual(changed.evidence!.id, e.id);
  const overlay = { toolId: 'receipt-card', version: 2, enforce: { watermark: 'always' as const } };
  const governed = await f.render({ ...req, overlays: new Map([['receipt-card', overlay]]) }, { captureEvidence: true });
  assert.notEqual(governed.evidence!.context.policyVersion, e.context.policyVersion);
  assert.equal(governed.evidence!.context.watermark, true);
});

test('provider receipts hash returned bytes and nested provider values cannot collide in the output cache', async (t) => {
  const f = await fixture(t);
  let color = 'red';
  let reads = 0;
  const hostedResolver: NonNullable<RenderDeps['hostedResolver']> = async (ref) => {
    reads++;
    const bytes = logo(color);
    return { asset: { source: 'remote', id: ref.raw, type: 'vector', format: 'svg', url: `data:image/svg+xml;base64,${bytes.toString('base64')}`, checksum: 'untrusted-declared-hash' },
      cacheKey: 'same-provider-key', stages: [], sourceBytes: bytes.length, outputBytes: bytes.length };
  };
  const query = queryFromInputs({ logo: 'cms://dam/logo' });
  const red = await f.render({ query }, { hostedResolver }); color = 'blue';
  const blue = await f.render({ query }, { hostedResolver });
  assert.notEqual(red.cacheKey, blue.cacheKey); assert.notDeepEqual(red.bytes, blue.bytes);
  const captured = await f.render({ query }, { hostedResolver, captureEvidence: true });
  assert.equal(captured.evidence!.assets[0]!.sha256, sha256Hex(logo('blue')));
  assert.equal(captured.evidence!.assets[0]!.source, 'provider');
  assert.equal(captured.evidence!.assets[0]!.id, 'cms://dam/logo');
  assert.equal(reads, 3, 'preflight and engine re-resolution share one provider result per render');
});

test('worker receipts explicitly distinguish plane validation from unattested worker dependencies', async (t) => {
  const f = await fixture(t);
  await writeFile(join(f.pack, 'tools', 'receipt-card', 'tool.json'), JSON.stringify({ ...f.manifest, hooks: { onInit: true } }));
  await writeFile(join(f.pack, 'tools', 'receipt-card', 'hooks.js'), 'function onInit() { return {}; }');
  const worker = createServer((req, res) => { req.resume(); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg"><text>Worker</text></svg>' })); });
  t.after(() => new Promise<void>((resolve) => worker.close(() => resolve())));
  await new Promise<void>((resolve) => worker.listen(0, '127.0.0.1', resolve));
  const address = worker.address(); assert.ok(address && typeof address === 'object');
  const result = await f.render({}, { captureEvidence: true, worker: { url: `http://127.0.0.1:${address.port}`, secret: 'private-worker-key', timeoutMs: 1_000 } });
  assert.equal(result.evidence!.tool.scope, 'control-plane-validation');
  assert.equal(result.evidence!.context.renderer, 'chromium-worker');
  assert.equal(result.evidence!.runtime, undefined);
  assert.ok(result.evidence!.limitations.includes('worker-tool-and-assets-unattested'));
  assert.doesNotMatch(JSON.stringify(result.evidence), /private-worker-key|127\.0\.0\.1/);
});

test('asset observations are canonical, bounded and honest about missing bytes', () => {
  const asset: AssetRef = { source: 'remote', id: 'cms://dam/logo', type: 'vector', format: 'svg', url: 'https://example.com/logo.svg' };
  const observer = createAssetObserver();
  observer.observe('provider', asset);
  for (let i = 0; i < 260; i++) observer.observe('provider', { ...asset, id: `cms://dam/${i}` }, logo('blue'));
  const result = observer.finish();
  assert.equal(result.assets.length, 256);
  assert.deepEqual(result.limitations, ['asset-bytes-unobserved', 'asset-observation-limit']);
  const a = createAssetObserver(); const b = createAssetObserver();
  const one = { ...asset, id: 'one' }; const two = { ...asset, id: 'two' };
  a.observe('provider', one, logo('red')); a.observe('provider', two, logo('blue')); a.observe('provider', one, logo('red'));
  b.observe('provider', two, logo('blue')); b.observe('provider', one, logo('red'));
  assert.deepEqual(a.finish(), b.finish());
  a.observe('provider', asset, logo('black'));
  assert.equal(a.finish().assets.length, 2, 'late hook reads cannot change a finalized receipt');
});
