import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { renderTool, type RenderDeps, type RenderRequest } from '../server/src/render/pipeline.ts';
import { effectivePolicySha256, evidenceHash, finishRenderEvidence, renderIdentity, type RenderEvidence, type RenderIdentity } from '../server/src/render/evidence.ts';
import { queryFromInputs } from '../server/src/automation/verbs.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { newRender, parseRenderSpec, renderWire } from '../server/src/renders/request.ts';
import { RenderRunner } from '../server/src/renders/runner.ts';
import type { RenderSpec } from '../server/src/renders/types.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';

const bytes = Buffer.from('<svg/>');
type Body = Omit<RenderEvidence, 'id' | 'apiVersion' | 'coverage' | 'outputSha256'>;
const baseBody = (): Body => ({
  engine: { version: '1.261.0', documentApiVersion: '1.0.0', scope: 'control-plane' },
  tool: { id: 'card', version: '1.0.0', sourceHash: evidenceHash([{ path: 'card/tool.json', sha256: 'a'.repeat(64), size: 10 }]), scope: 'local-runtime',
    files: [{ path: 'card/tool.json', sha256: 'a'.repeat(64), size: 10 }] },
  context: {
    paramsHash: evidenceHash({ title: 'Hello' }), profileHash: evidenceHash({}), groupsHash: evidenceHash(['design']),
    policyVersion: 'all-overlays-1', catalogVersion: '1/inst-1', format: 'svg', widthPx: null, heightPx: null,
    watermark: false, renderer: 'work-jsdom', rasterizer: 'none', signerCertificateHash: null,
  },
  resolved: { designRevision: '3:source-7', effectivePolicySha256: '941ea7a5a0a23c7677cf388c0e2f5bbc5c9348ad4cdf7e66841be579d832c14a' },
  assets: [{ source: 'catalog', id: 'inst/logo', format: 'svg', version: '2', sha256: 'b'.repeat(64), size: 42 }],
  limitations: ['dependencies-not-locked', 'engine-dependency-graph-unavailable'],
});
const receipt = (edit: (body: Body) => void = () => {}, output: Uint8Array = bytes) => {
  const body = baseBody(); edit(body);
  return finishRenderEvidence(body, output);
};
const spec = parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Hello', rows: [{ a: 1, b: 2 }] } });

test('render identity ignores object key order and scheduling but binds every resolved fact', () => {
  const identity = renderIdentity(spec, receipt())!;
  const { id, ...body } = identity;
  assert.equal(id, evidenceHash(body));
  assert.equal(identity.apiVersion, 'work/render-identity-v1');
  assert.equal(identity.coverage, 'partial');
  const reordered = parseRenderSpec({ inputs: { rows: [{ b: 2, a: 1 }], title: 'Hello' }, format: 'svg', toolId: 'card', priority: 9, maxAttempts: 1 });
  assert.equal(renderIdentity(reordered, receipt())!.id, id, 'key order, priority and attempts do not change what was rendered');

  const changes: [string, RenderSpec, (body: Body) => void][] = [
    ['inputs', parseRenderSpec({ toolId: 'card', format: 'svg', inputs: { title: 'Hello', rows: [{ a: 1, b: 3 }] } }), () => {}],
    ['verification', parseRenderSpec({ ...spec, verification: 'output-v1' }), () => {}],
    ['tool version', spec, b => { b.tool.version = '1.0.1'; }],
    ['tool source', spec, b => { b.tool.sourceHash = evidenceHash(['edited']); }],
    ['engine re-pin', spec, b => { b.engine.version = '1.262.0'; }],
    ['document API', spec, b => { b.engine.documentApiVersion = '1.1.0'; }],
    ['catalog version', spec, b => { b.context.catalogVersion = '1/inst-2'; }],
    ['design revision', spec, b => { b.resolved!.designRevision = '4:source-7'; }],
    ['asset bytes', spec, b => { b.assets[0]!.sha256 = 'c'.repeat(64); }],
    ['asset version', spec, b => { b.assets[0]!.version = '3'; }],
    ['effective policy', spec, b => { b.resolved!.effectivePolicySha256 = evidenceHash({ overlay: { toolId: 'card', version: 2 } }); }],
    ['groups', spec, b => { b.context.groupsHash = evidenceHash(['legal']); }],
    ['watermark', spec, b => { b.context.watermark = true; }],
    ['resolved values', spec, b => { b.context.paramsHash = evidenceHash({ title: 'Locked' }); }],
    ['profile', spec, b => { b.context.profileHash = evidenceHash({ firstname: 'Ada' }); }],
    ['dimensions', spec, b => { b.context.widthPx = 1200; }],
    ['renderer', spec, b => { b.context.rasterizer = 'resvg'; }],
    ['signer', spec, b => { b.context.signerCertificateHash = 'd'.repeat(64); }],
    ['unobserved bytes', spec, b => { b.limitations.push('asset-bytes-unobserved'); }],
  ];
  const seen = new Set([id]);
  for (const [name, request, edit] of changes) {
    const changed = renderIdentity(request, receipt(edit))!.id;
    assert.ok(!seen.has(changed), `${name} changes the identity`);
    seen.add(changed);
  }
});

test('the v1 identity derivation is frozen', () => {
  // The evidence download recomputes stored v1 identities. If this value moves,
  // keep the v1 derivation and add a new apiVersion instead of updating it.
  assert.equal(renderIdentity(spec, receipt())!.id, '72225596c4f7329a6466f9b5aeae4bf9fad19807bceb163ebde6990a7850514f');
  assert.equal(effectivePolicySha256(undefined, ['design'], ['title'], null), '941ea7a5a0a23c7677cf388c0e2f5bbc5c9348ad4cdf7e66841be579d832c14a');
});

test('the effective policy is what the caller\'s groups resolve, not the whole overlay', () => {
  const overlay = (rules: NonNullable<ToolOverlay['inputAccess']>, version = 1, name?: string): ToolOverlay => ({ toolId: 'card', version, ...(name ? { name } : {}), inputAccess: rules });
  const design = (o: ToolOverlay | undefined) => effectivePolicySha256(o, ['design'], ['title', 'size'], null);
  const base = overlay({ title: [{ groups: ['design'], level: 'choice', allow: ['Hello', 'Bye'] }] });
  const legalOnly = overlay({
    title: [{ groups: ['design'], level: 'choice', allow: ['Hello', 'Bye'] }],
    size: [{ groups: ['legal'], level: 'locked', value: 'A4', reason: 'Legal sets the size' }],
    footer: [{ groups: ['legal'], level: 'hidden' }],
  }, 7, 'Legal guardrails');
  assert.equal(design(legalOnly), design(base), 'rules for another group, attribution and the version counter are left out');
  assert.equal(design(overlay({})), design(undefined), 'an overlay that governs nothing for this caller');
  assert.notEqual(design(overlay({ title: [{ groups: ['design'], level: 'choice', allow: ['Hello'] }] })), design(base));
  assert.notEqual(design(overlay({ ...base.inputAccess, size: [{ groups: ['*'], level: 'locked', value: 'A4' }] })), design(base));
  assert.notEqual(design(overlay({ '*': [{ groups: ['design'], level: 'hidden' }] })), design(undefined), 'the input default applies to named inputs');
  assert.notEqual(design({ ...base, enforce: { formats: ['svg'] } }), design(base));
  assert.notEqual(effectivePolicySha256(base, ['design'], ['title'], { revision: '1', results: [] }), effectivePolicySha256(base, ['design'], ['title'], null));
});

test('render identity leaves out output bytes, runtime measurements and other tools\' policy', () => {
  const identity = renderIdentity(spec, receipt())!;
  const other = receipt(b => {
    b.context.policyVersion = 'all-overlays-2';
    b.runtime = { initialValuesHash: 'e'.repeat(64), hydratedHash: 'f'.repeat(64), hookErrors: 0, droppedAssets: 0 };
  }, Buffer.from('<svg>signed at another time</svg>'));
  assert.notEqual(other.id, receipt().id, 'the receipt still distinguishes the attempts');
  assert.equal(renderIdentity(spec, other)!.id, identity.id);
  assert.doesNotMatch(JSON.stringify(identity), /outputSha256|policyVersion|all-overlays/);
});

test('render identity refuses a receipt for another request and is absent on older receipts', () => {
  assert.throws(() => renderIdentity({ ...spec, toolId: 'poster' }, receipt()), /different tool or format/);
  assert.throws(() => renderIdentity({ ...spec, format: 'png' }, receipt()), /different tool or format/);
  assert.equal(renderIdentity(spec, receipt(b => { delete b.resolved; })), null);
});

test('worker observation budgets do not move the identity, and worker resources are named as outside it', () => {
  const worker = (extra: string[]) => receipt(b => {
    b.context.renderer = 'chromium-worker';
    b.tool.scope = 'control-plane-validation';
    b.limitations.push('worker-tool-and-assets-unattested', ...extra);
  });
  const calm = renderIdentity(spec, worker([]))!;
  const slow = renderIdentity(spec, worker(['worker-resource-read-timeout', 'worker-resource-count-budget']))!;
  assert.equal(slow.id, calm.id);
  assert.ok(calm.limitations.includes('worker-resources-outside-identity'));
  assert.ok(calm.limitations.includes('worker-tool-and-assets-unattested'));
  assert.deepEqual(calm.limitations, [...calm.limitations].sort());
});

const template = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><text>{{title}}</text><image href="{{logo.url}}"/></svg>';
const logo = (color: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg"><rect width="5" height="5" fill="${color}"/></svg>`);

test('a real render binds its loaded tool source, read asset bytes, design revision and effective policy', async (t) => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-render-identity-'));
  t.after(() => rm(pack, { recursive: true, force: true }));
  await mkdir(join(pack, 'tools', 'identity-card'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'identity-card', 'tool.json'), JSON.stringify({
    id: 'identity-card', name: 'Identity card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Default' }, { id: 'logo', label: 'Logo', type: 'asset', default: null }],
  }));
  await writeFile(join(pack, 'tools', 'identity-card', 'template.html'), template);
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'identity-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [
    { id: 'brand/logo', name: 'Logo', type: 'vector', version: '1.0.0', formats: [{ format: 'svg', url: 'assets/logo.svg' }] },
  ] }));
  await writeFile(join(pack, 'catalog', 'assets', 'logo.svg'), logo('red'));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Identity', baseUrl: 'http://localhost', pack }, dev: { enabled: true } }));
  const request = parseRenderSpec({ toolId: 'identity-card', format: 'svg', inputs: { title: 'Launch', logo: 'brand/logo' } });
  const base: RenderRequest = { toolId: request.toolId, format: request.format, query: queryFromInputs(request.inputs), principal: { groups: ['design'] }, profile: {}, overlays: new Map() };
  const identify = async (req: Partial<RenderRequest> = {}, deps: Partial<RenderDeps> = {}): Promise<RenderIdentity> => {
    const out = await renderTool({ config, captureEvidence: true, brandRevision: '1:source-a', ...deps }, { ...base, ...req });
    return renderIdentity(request, out.evidence!)!;
  };

  const first = await identify();
  assert.equal(first.sources.designRevision, '1:source-a');
  assert.deepEqual(first.sources.assets, [{ source: 'catalog', id: 'brand/logo', format: 'svg', version: '1.0.0', sha256: sha256Hex(logo('red')), size: logo('red').length }]);
  assert.equal((await identify()).id, first.id, 'unchanged resolution gives the same identity');

  const unrelated = await identify({ overlays: new Map([['other-tool', { toolId: 'other-tool', version: 4, enforce: { watermark: 'always' as const } }]]) });
  assert.equal(unrelated.id, first.id, 'another tool\'s policy is not this render\'s effective policy');
  const legal = await identify({ overlays: new Map([['identity-card', { toolId: 'identity-card', version: 2, defaults: { title: 'Unused' },
    inputAccess: { title: [{ groups: ['legal'], level: 'locked' as const, value: 'Legal' }] } }]]) });
  assert.equal(legal.id, first.id, 'a rule for another group and an unused default do not change this caller\'s policy');
  const governed = await identify({ overlays: new Map([['identity-card', { toolId: 'identity-card', version: 2,
    inputAccess: { title: [{ groups: ['design'], level: 'choice' as const, allow: ['Launch', 'Pause'] }] } }]]) });
  assert.notEqual(governed.policy.effectiveSha256, first.policy.effectiveSha256);
  assert.notEqual(governed.id, first.id);
  const regrouped = await identify({ principal: { groups: ['legal'] } });
  assert.notEqual(regrouped.id, first.id);

  assert.notEqual((await identify({}, { brandRevision: '2:source-a' })).id, first.id, 'a new design revision is a new identity');

  await writeFile(join(pack, 'catalog', 'assets', 'logo.svg'), logo('blue'));
  const recoloured = await identify();
  assert.notEqual(recoloured.id, first.id, 'changed source bytes under the same asset id and version');
  assert.deepEqual(recoloured.tool, first.tool);

  await writeFile(join(pack, 'tools', 'identity-card', 'template.html'), template.replace('<text>', '<text data-edit="1">'));
  const edited = await identify();
  assert.equal(edited.tool.version, first.tool.version);
  assert.notEqual(edited.tool.sourceHash, recoloured.tool.sourceHash);
  assert.notEqual(edited.id, recoloured.id, 'a source edit under the same declared version');
});

test('durable outputs carry the identity their receipt resolved, and a mismatched receipt publishes nothing', async (t) => {
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  const evidence = receipt();
  const record = (await store.insertRender(newRender('user:a', spec))).record;
  const runner = new RenderRunner({ store, blobs, execute: async () => ({ bytes, mime: 'image/svg+xml', cacheKey: 'key', evidence }) });
  t.after(() => runner.stop());
  await runner.tick();
  await until(async () => (await store.getRender(record.id, record.principal))?.state === 'succeeded');
  const saved = (await store.getRender(record.id, record.principal))!;
  assert.deepEqual(saved.output!.identity, renderIdentity(spec, evidence));
  assert.deepEqual((renderWire(saved).output as { identity: unknown }).identity, { id: saved.output!.identity!.id, coverage: 'partial' });

  const other = (await store.insertRender(newRender('user:a', { ...spec, toolId: 'poster', maxAttempts: 1 }))).record;
  await runner.tick();
  await until(async () => (await store.getRender(other.id, other.principal))?.state === 'failed');
  const failed = (await store.getRender(other.id, other.principal))!;
  assert.equal(failed.error!.code, 'RENDER_EVIDENCE_MISMATCH');
  assert.equal(failed.output, undefined);
});

async function until(predicate: () => Promise<boolean>): Promise<void> {
  for (let n = 0; n < 200; n++) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 10)); }
  assert.fail('render did not settle');
}
