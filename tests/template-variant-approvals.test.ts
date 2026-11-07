// SPDX-License-Identifier: MPL-2.0
/**
 * One approval for a template's variants (plans/82 M7, W-M7-6a), over the real
 * app. Pinned here:
 *
 *  - off by default: an approval covers one file's exact inputs, as before;
 *  - with `enforce.approvalCovers: template-variants`, one approval of a
 *    published template version clears every partner's render from it, whatever
 *    the inputs the programme may edit;
 *  - a fixed value is still refused, and a new template version needs a new
 *    approval;
 *  - the request says what it covers: `covers: template-variants` and the
 *    template and version, the file being one example.
 *
 * Variant renders carry no approval record in their Content Credentials yet:
 * that waits for the engine's record fields (W-M7-6b).
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { templateVariantDigest } from '../server/src/approvals/export-review-match.ts';
import { normalizeOverlay } from '../server/src/policy/overlay.ts';

const TOOL = 'data-sheet';
const MARK = /lw-preview-watermark/;
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const cookies: Record<string, string> = {};
let template = '';

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-variant-approvals-'));
  await mkdir(join(pack, 'tools', TOOL), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL, 'tool.json'), JSON.stringify({ id: TOOL, name: 'Data sheet', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Product' }, { id: 'price', label: 'Price', type: 'text', default: '' }] }));
  await writeFile(join(pack, 'tools', TOOL, 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>{{title}} {{price}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: TOOL }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  store = createMemoryStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Variants', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin'] }, { email: 'review@test', groups: ['approver', 'review'] }, { email: 'rita@acme.test', groups: [] }] } }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sV', link: 'lV' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const who of ['bruno@test', 'review@test', 'rita@acme.test']) {
    const login = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(who)}`, { redirect: 'manual' });
    cookies[who.split('@')[0]!] = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  }
  assert.equal((await call('bruno', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [TOOL] })).status, 201);
  await store.putGrant({ principal: 'group:programme-resellers', action: 'export.server', resource: '*', effect: 'allow' });
  assert.equal((await call('bruno', 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
  const submitted = await call('bruno', 'POST', `/api/v1/catalog/submit?type=template&toolId=${TOOL}`, { toolId: TOOL, name: 'Partner data sheet', values: { title: 'SLES 16', price: '' } });
  assert.ok(submitted.status === 201 || submitted.status === 200, JSON.stringify(submitted.body));
  const published = await call('bruno', 'POST', '/api/v1/programmes/resellers/templates', { from: submitted.body.assetId, groups: ['programme-resellers'], editable: ['price'] });
  assert.equal(published.status, 201, JSON.stringify(published.body));
  template = published.body.id;
  // Under until-approved; the switch itself is set per test.
  await store.putOverlay({ toolId: TOOL, version: 1, enforce: { watermark: 'until-approved', escalation: 'brand' } });
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
/** Rita's render of the template with her own price: marked or clean. */
async function rendered(price: string, extra: Record<string, unknown> = {}) {
  const res = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { cookie: cookies.rita!, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: TOOL, format: 'svg', inputs: { template, price, ...extra } }) });
  const text = await res.text();
  return { status: res.status, marked: MARK.test(text), text };
}
const covers = async (value: 'file' | 'template-variants') => store.putOverlay({ toolId: TOOL, version: 1, enforce: { watermark: 'until-approved', escalation: 'brand', approvalCovers: value === 'file' ? undefined : value } as never });
/** Bruno asks for review of one example file made from the template. */
async function askAboutExample(price: string) {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookies.bruno!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const begun = await post('/api/v1/uploads', { scope: 'approval-artifact', name: 'example.svg', contentType: 'image/svg+xml', size: SVG.length, checksum: sha(SVG), parts: [{ size: SVG.length, checksum: sha(SVG) }] });
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  assert.equal((await fetch(`${base}/api/v1/uploads/${upload.id}/parts/0`, { method: 'PUT', headers: { cookie: cookies.bruno!, 'content-type': 'application/octet-stream' }, body: SVG })).status, 204);
  assert.equal((await post(`/api/v1/uploads/${upload.id}/finalize`, {})).status, 200);
  const created = await post('/api/v1/approvals', { subjectType: 'export-review', title: 'Partner data sheet', chainId: 'brand',
    exportReview: { uploadId: upload.id, checksum: sha(SVG), toolId: TOOL, format: 'svg', query: `template=${encodeURIComponent(template)}&price=${encodeURIComponent(price)}` } });
  assert.equal(created.status, 201, await created.clone().text());
  return await created.json() as { id: string; exportReview: { fingerprint: string; covers?: string; templateRef?: { id: string; version: number }; inputsDigest: string } };
}
async function approve(approval: { id: string; exportReview: { fingerprint: string } }) {
  const token = (await fetch(`${base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: cookies.review! } })).headers.get('x-lolly-review-token');
  const res = await call('review', 'POST', `/api/v1/approvals/${approval.id}/act`, { action: 'approve', comment: 'ok', artifactFingerprint: approval.exportReview.fingerprint, reviewToken: token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
}

test('the switch is template-variants or file, and file is not stored', () => {
  const parsed = normalizeOverlay(TOOL, { enforce: { watermark: 'until-approved', approvalCovers: 'template-variants' } });
  assert.equal(parsed?.enforce?.approvalCovers, 'template-variants');
  assert.equal(normalizeOverlay(TOOL, { enforce: { watermark: 'until-approved', approvalCovers: 'file' } })?.enforce?.approvalCovers, undefined);
  assert.equal(normalizeOverlay(TOOL, { enforce: { approvalCovers: 'everything' } }), null);
});

test('the key is the template and its fixed values, never what a partner may change', () => {
  const t = { id: 'inst/sheet', version: 3, values: { title: 'SLES 16', price: '€ 1', logo: 'inst/a' }, editable: ['price'], bindings: { logo: 'logo' } };
  assert.equal(templateVariantDigest(t), templateVariantDigest({ ...t, values: { ...t.values, price: '€ 2', logo: 'inst/b' } }));
  assert.notEqual(templateVariantDigest(t), templateVariantDigest({ ...t, version: 4 }), 'a new version needs a new approval');
  assert.notEqual(templateVariantDigest(t), templateVariantDigest({ ...t, values: { ...t.values, title: 'SLES 17' } }));
});

test('off by default: an approval covers one file\'s inputs, so a partner\'s variants stay marked', async () => {
  await covers('file');
  const example = await askAboutExample('€ 1,000');
  assert.equal(example.exportReview.covers, undefined);
  assert.equal(example.exportReview.templateRef, undefined);
  await approve(example);
  assert.equal((await rendered('€ 1,250')).marked, true, 'a partner\'s own price is not what was approved');
});

test('with the switch, one approval clears every partner variant of that template version', async () => {
  await covers('template-variants');
  assert.equal((await rendered('€ 2,000')).marked, true, 'nothing approved yet');
  const example = await askAboutExample('€ 2,000');
  assert.equal(example.exportReview.covers, 'template-variants');
  assert.deepEqual(example.exportReview.templateRef, { id: template, version: 1 });
  assert.equal(example.exportReview.inputsDigest, templateVariantDigest({ id: template, version: 1, values: { title: 'SLES 16', price: '' }, editable: ['price'] }));
  assert.equal((await rendered('€ 9')).marked, true, 'a request in review changes nothing');
  await approve(example);
  for (const price of ['€ 2,000', '€ 9', '€ 99,999']) {
    const r = await rendered(price);
    assert.equal(r.status, 200, r.text);
    assert.equal(r.marked, false, `${price} comes out clean under one decision`);
  }
  const locked = await rendered('€ 9', { title: 'Something else' });
  assert.equal(locked.status, 422, 'a fixed value is refused, so it can never ride on the approval');
  // Turned off again, the next render needs an approval of its own inputs.
  await covers('file');
  assert.equal((await rendered('€ 9')).marked, true);
  await covers('template-variants');
});

test('a new template version needs its own approval', async () => {
  const submitted = await call('bruno', 'POST', `/api/v1/catalog/submit?type=template&toolId=${TOOL}`, { toolId: TOOL, name: 'Partner data sheet v2', values: { title: 'SLES 16 SP1', price: '' } });
  const bare = template.slice('inst/'.length);
  const version = await call('bruno', 'POST', `/api/v1/programmes/resellers/templates/${bare}/versions`, { from: submitted.body.assetId });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  assert.equal((await rendered('€ 9')).marked, true, 'version 2 was never approved');
});
