// SPDX-License-Identifier: MPL-2.0
/**
 * One approval for a template's variants (plans/82 M7, W-M7-6a), over the real
 * app. Pinned here:
 *
 *  - off by default: an approval covers one file's exact inputs, as before;
 *  - with `enforce.approvalCovers: template-variants`, one approval of a
 *    published template version clears every partner's render from it, whatever
 *    the inputs the programme may edit;
 *  - a fixed value is still refused, and the key is the fixed values as the
 *    effective policy fixes them, so a tool lock to another value, a change to
 *    what is open or a new template version needs a new approval;
 *  - a template with no editable list fixes nothing, so its files are approved
 *    one at a time;
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
import { templateFixedValues, templateOpenInputs, templateVariantDigest } from '../server/src/approvals/export-review-match.ts';
import { describeRenderReview } from '../server/src/approvals/export-review.ts';
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
async function askAboutExample(price: string, extra = '') {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookies.bruno!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const begun = await post('/api/v1/uploads', { scope: 'approval-artifact', name: 'example.svg', contentType: 'image/svg+xml', size: SVG.length, checksum: sha(SVG), parts: [{ size: SVG.length, checksum: sha(SVG) }] });
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  assert.equal((await fetch(`${base}/api/v1/uploads/${upload.id}/parts/0`, { method: 'PUT', headers: { cookie: cookies.bruno!, 'content-type': 'application/octet-stream' }, body: SVG })).status, 204);
  assert.equal((await post(`/api/v1/uploads/${upload.id}/finalize`, {})).status, 200);
  const created = await post('/api/v1/approvals', { subjectType: 'export-review', title: 'Partner data sheet', chainId: 'brand',
    exportReview: { uploadId: upload.id, checksum: sha(SVG), toolId: TOOL, format: 'svg', query: `template=${encodeURIComponent(template)}&price=${encodeURIComponent(price)}${extra}` } });
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

test('the key is the template, what it leaves open and its fixed values, never what a partner may change', () => {
  const t = { id: 'inst/sheet', version: 3, values: { title: 'SLES 16', price: '€ 1', logo: 'inst/a' }, editable: ['price'], bindings: { logo: 'logo' } };
  const ids = ['title', 'price', 'logo'];
  const open = templateOpenInputs(t)!;
  assert.deepEqual(open, ['logo', 'price']);
  const key = (values: Record<string, unknown>, locked: Record<string, unknown> = {}, o: string[] = open, version = 3) =>
    templateVariantDigest({ id: t.id, version }, o, templateFixedValues(ids, o, values, locked));
  assert.equal(key(t.values), key({ ...t.values, price: '€ 2', logo: 'inst/b' }));
  assert.notEqual(key(t.values), key(t.values, {}, open, 4), 'a new version needs a new approval');
  assert.notEqual(key(t.values), key({ ...t.values, title: 'SLES 17' }));
  // The effective policy's lock wins over the template's value, so two companies
  // whose tool locks fix different titles never share one approval.
  assert.notEqual(key(t.values, { title: 'Northwind title' }), key(t.values, { title: 'Globex title' }));
  assert.equal(key(t.values, { title: 'SLES 16' }), key(t.values), 'a lock to the template\'s own value is the same key');
  // Opening another input is a different key, even at the same version.
  assert.notEqual(key(t.values), key(t.values, {}, templateOpenInputs({ ...t, editable: ['price', 'title'] })!));
  // No editable list means everything stays editable: nothing is fixed, so no variant key.
  assert.equal(templateOpenInputs({ ...t, editable: undefined }), null);
  assert.deepEqual(templateOpenInputs({ ...t, editable: [], bindings: undefined }), [], 'an empty list fixes everything');
  assert.deepEqual(templateOpenInputs({ editable: [] }, { logo: 'logo' }), ['logo'], 'the tool overlay\'s bindings are open too');
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
  assert.deepEqual(example.exportReview.templateRef, { id: template, version: 1, name: 'Partner data sheet' });
  assert.equal(example.exportReview.inputsDigest, templateVariantDigest({ id: template, version: 1 }, ['price'], { title: 'SLES 16' }));
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

test('a tool lock that fixes another value needs its own approval, at the same template version', async () => {
  await covers('template-variants');
  const lock = (value: string, version: number) => store.putOverlay({ toolId: TOOL, version, enforce: { watermark: 'until-approved', escalation: 'brand', approvalCovers: 'template-variants' },
    inputAccess: { title: [{ groups: ['*'], level: 'locked', value }] } } as never);
  try {
    await lock('Locked title A', 2);
    const example = await askAboutExample('€ 3');
    assert.equal(example.exportReview.inputsDigest, templateVariantDigest({ id: template, version: 1 }, ['price'], { title: 'Locked title A' }));
    await approve(example);
    const clean = await rendered('€ 4');
    assert.equal(clean.marked, false, clean.text);
    assert.match(clean.text, /Locked title A/);
    await lock('Locked title B', 3);
    const other = await rendered('€ 4');
    assert.match(other.text, /Locked title B/);
    assert.equal(other.marked, true, 'the approval saw title A, never title B');
  } finally {
    await covers('template-variants');
  }
});

test('editable absent is not editable empty: a template that fixes nothing is approved one file at a time', async () => {
  await covers('template-variants');
  const bare = template.slice('inst/'.length);
  const put = async (editable: string[] | null) => {
    const res = await call('bruno', 'PUT', `/api/v1/programmes/resellers/templates/${bare}`, { editable });
    assert.equal(res.status, 200, JSON.stringify(res.body));
    assert.deepEqual(res.body.editable, editable);
  };
  const renderAs = async (inputs: Record<string, unknown>) => {
    const res = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { cookie: cookies.rita!, 'content-type': 'application/json' },
      body: JSON.stringify({ toolId: TOOL, format: 'svg', inputs: { template, ...inputs } }) });
    const text = await res.text();
    return { status: res.status, marked: MARK.test(text), text };
  };
  try {
    // Fully fixed: nothing open, and one approval of the template covers it.
    await put([]);
    assert.equal((await renderAs({ price: '€ 9' })).status, 422, 'with nothing open, a price is refused');
    const fixed = await askAboutExample('');
    assert.equal(fixed.exportReview.covers, 'template-variants');
    assert.equal(fixed.exportReview.inputsDigest, templateVariantDigest({ id: template, version: 1 }, [], { title: 'SLES 16', price: '' }));
    await approve(fixed);
    assert.equal((await renderAs({})).marked, false, 'the fully fixed template is approved');
    // Opened up without a new version: a partner may now change the title, so that
    // approval no longer covers anything, and each file is approved on its own.
    await put(null);
    const changed = await renderAs({ title: 'Cheaper', price: '€ 1' });
    assert.equal(changed.status, 200, changed.text);
    assert.equal(changed.marked, true, 'a title nobody reviewed is not covered by the approval of the fixed template');
    assert.equal((await renderAs({})).marked, true);
    // The app sends every value the file was made from, the template's title included.
    const example = await askAboutExample('€ 5', `&title=${encodeURIComponent('SLES 16')}`);
    assert.equal(example.exportReview.covers, undefined, 'the request covers its own file');
    assert.equal(example.exportReview.templateRef, undefined);
    await approve(example);
    assert.equal((await rendered('€ 5')).marked, false, 'the approved file\'s own inputs come out clean');
    assert.equal((await rendered('€ 6')).marked, true, 'another price needs its own approval');
  } finally {
    await put(['price']);
  }
});

test('a new template version needs its own approval', async () => {
  const submitted = await call('bruno', 'POST', `/api/v1/catalog/submit?type=template&toolId=${TOOL}`, { toolId: TOOL, name: 'Partner data sheet v2', values: { title: 'SLES 16 SP1', price: '' } });
  const bare = template.slice('inst/'.length);
  const version = await call('bruno', 'POST', `/api/v1/programmes/resellers/templates/${bare}/versions`, { from: submitted.body.assetId });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  assert.equal((await rendered('€ 9')).marked, true, 'version 2 was never approved');
});

test('a token\'s request about a variant render records the template it covers, as a person\'s does', () => {
  const bytes = new TextEncoder().encode('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
  const facts = { toolId: TOOL, format: 'svg', name: 'r.svg', toolVersion: '1.0.0', inputsDigest: 'd'.repeat(64) };
  const plain = describeRenderReview(bytes, facts, '2026-11-08T00:00:00.000Z')!;
  const variant = describeRenderReview(bytes, { ...facts, covers: 'template-variants', templateRef: { id: 'inst/abc', version: 3, name: 'Partner data sheet' } }, '2026-11-08T00:00:00.000Z')!;
  assert.equal(plain.covers, undefined);
  assert.equal(variant.covers, 'template-variants');
  assert.deepEqual(variant.templateRef, { id: 'inst/abc', version: 3, name: 'Partner data sheet' });
  assert.notEqual(variant.fingerprint, plain.fingerprint, 'the decision is bound to what it covers');
});
