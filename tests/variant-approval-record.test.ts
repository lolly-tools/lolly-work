// SPDX-License-Identifier: MPL-2.0
/**
 * The record a variant render carries (plans/82 M7, W-M7-6b; decision 5, approved
 * by Andy on 2026-11-07). Over the real app with a real signer. Pinned here:
 *
 *  - once one approval covers a template version's variants, a partner's clean
 *    render from it carries the approval id and decision time, `covers: template`
 *    with the template id and version, and the example's digest labelled as the
 *    example's, never this file's;
 *  - a render that is still marked, and a render under a file's approval, carry no
 *    approval record;
 *  - the record names no person, name or comment, and Verify reads it back.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { variantApprovalRecord } from '../server/src/render/record.ts';

const ENGINE: string = '@lolly/engine';
const engine = await import(ENGINE) as {
  generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
  issueLeafCert: (o: object) => Promise<Uint8Array>;
  derToPem: (der: Uint8Array, label: string) => string;
  verifyC2pa: (b: Uint8Array) => Promise<{ found: boolean; state: string; checks: Array<{ code: string; ok: boolean }>; approval?: Record<string, unknown>; environment?: Record<string, unknown> | null }>;
};

const TOOL = 'data-sheet';
const MARK = /lw-preview-watermark/;
const EXAMPLE = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');
const sha = (b: Uint8Array | string) => createHash('sha256').update(b).digest('hex');
let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const cookies: Record<string, string> = {};
let template = '';

async function mintIdentity(): Promise<{ certPem: string; keyPem: string }> {
  const root = await engine.generateCaRoot({ commonName: 'Test Root', organization: 'Test', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await engine.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'lolly@test.invalid', organization: 'Test', days: 365 });
  return { certPem: engine.derToPem(leaf, 'CERTIFICATE') + engine.derToPem(root.certDer, 'CERTIFICATE'), keyPem: engine.derToPem(keyDer, 'PRIVATE KEY') };
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-variant-record-'));
  await mkdir(join(pack, 'tools', TOOL), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL, 'tool.json'), JSON.stringify({ id: TOOL, name: 'Data sheet', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Product' }, { id: 'price', label: 'Price', type: 'text', default: '' }] }));
  await writeFile(join(pack, 'tools', TOOL, 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>{{title}} {{price}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: TOOL }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const { certPem, keyPem } = await mintIdentity();
  const certFile = join(pack, 'c2pa.pem');
  await writeFile(certFile, certPem);
  store = createMemoryStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Variants', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    render: { c2pa: { certFile, claimGenerator: 'Lolly Work' } },
    dev: { enabled: true, users: [{ email: 'bruno@test', groups: ['admin'] }, { email: 'review@test', groups: ['approver', 'review'] }, { email: 'rita@acme.test', groups: [] }] } }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sVR', link: 'lVR', c2paSigningKey: keyPem } });
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
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
const covers = async (value: 'file' | 'template-variants', version: number) => store.putOverlay({ toolId: TOOL, version,
  enforce: { watermark: 'until-approved', escalation: 'brand', ...(value === 'file' ? {} : { approvalCovers: value }) } as never });
/** Rita's render of the template with her own price, as signed bytes. */
async function rendered(price: string, format: 'svg' | 'png' = 'svg') {
  const res = await fetch(`${base}/api/v1/render`, { method: 'POST', headers: { cookie: cookies.rita!, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: TOOL, format, inputs: { template, price } }) });
  const bytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(res.status, 200, new TextDecoder().decode(bytes).slice(0, 300));
  return { bytes, marked: MARK.test(new TextDecoder('latin1').decode(bytes)), report: await engine.verifyC2pa(bytes) };
}
/** Bruno asks for review of one example file, then the reviewer approves it. */
async function approvedExample(price: string, extra = '') {
  const post = (path: string, body: unknown) => fetch(`${base}${path}`, { method: 'POST', headers: { cookie: cookies.bruno!, 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const begun = await post('/api/v1/uploads', { scope: 'approval-artifact', name: 'example.svg', contentType: 'image/svg+xml', size: EXAMPLE.length, checksum: sha(EXAMPLE), parts: [{ size: EXAMPLE.length, checksum: sha(EXAMPLE) }] });
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  assert.equal((await fetch(`${base}/api/v1/uploads/${upload.id}/parts/0`, { method: 'PUT', headers: { cookie: cookies.bruno!, 'content-type': 'application/octet-stream' }, body: EXAMPLE })).status, 204);
  assert.equal((await post(`/api/v1/uploads/${upload.id}/finalize`, {})).status, 200);
  const created = await post('/api/v1/approvals', { subjectType: 'export-review', title: 'Partner data sheet', chainId: 'brand',
    exportReview: { uploadId: upload.id, checksum: sha(EXAMPLE), toolId: TOOL, format: 'svg', query: `template=${encodeURIComponent(template)}&price=${encodeURIComponent(price)}${extra}` } });
  assert.equal(created.status, 201, await created.clone().text());
  const approval = await created.json() as { id: string; exportReview: { fingerprint: string; covers?: string } };
  const token = (await fetch(`${base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: cookies.review! } })).headers.get('x-lolly-review-token');
  const res = await call('review', 'POST', `/api/v1/approvals/${approval.id}/act`, { action: 'approve', comment: 'Good for every price', artifactFingerprint: approval.exportReview.fingerprint, reviewToken: token });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return (await store.getApproval(approval.id))!;
}

test('the record is built only from a template\'s approval for this template and version', () => {
  const t = { id: 'inst/sheet', version: 3 };
  const approval = { id: 'apr_1', actions: [{ at: '2026-11-07T10:00:00.000Z' }], exportReview: { sha256: 'c'.repeat(64), covers: 'template-variants', templateRef: { id: 'inst/sheet', version: 3 } } };
  assert.deepEqual(variantApprovalRecord(approval, t), { approvalId: 'apr_1', decidedAt: '2026-11-07T10:00:00.000Z', covers: 'template', templateId: 'inst/sheet', templateVersion: 3, exampleSha256: `sha256:${'c'.repeat(64)}` });
  assert.equal(variantApprovalRecord(approval, { ...t, version: 4 }), null, 'another version');
  assert.equal(variantApprovalRecord(approval, { ...t, id: 'inst/other' }), null, 'another template');
  assert.equal(variantApprovalRecord({ ...approval, exportReview: { ...approval.exportReview, covers: undefined } }, t), null, 'a file\'s approval');
  assert.equal(variantApprovalRecord({ ...approval, actions: [] }, t), null, 'no decision time');
  assert.equal(variantApprovalRecord({ ...approval, exportReview: { ...approval.exportReview, sha256: 'nope' } }, t), null);
  assert.equal(variantApprovalRecord(null, t), null);
});

test('once the template is approved, a partner\'s clean render carries the template\'s record and Verify reads it', async () => {
  await covers('template-variants', 1);
  const before = await rendered('€ 1');
  assert.equal(before.marked, true, 'nothing approved yet');
  assert.equal(before.report.approval, undefined, 'a marked render carries no approval record');
  const approval = await approvedExample('€ 2,000');
  const after = await rendered('€ 9,999');
  assert.equal(after.marked, false);
  assert.equal(after.report.state, 'valid', JSON.stringify(after.report.checks.filter((c) => !c.ok)));
  assert.deepEqual(after.report.approval, {
    approvalId: approval.id, decidedAt: approval.actions.at(-1)!.at, covers: 'template',
    templateId: template, templateVersion: 1, exampleSha256: `sha256:${sha(EXAMPLE)}`,
  });
  assert.notEqual(after.report.approval?.exampleSha256, `sha256:${sha(after.bytes)}`, 'the digest is the example\'s, not this file\'s');
  assert.doesNotMatch(JSON.stringify(after.report.approval), /Good for every price|review@test|bruno|Partner data sheet/, 'no comment, person or name');
  // The approval was given as SVG. A PNG of the same piece needs its own, so it carries no record.
  const png = await rendered('€ 9,999', 'png');
  assert.equal(png.report.state, 'valid');
  assert.equal(png.report.approval, undefined);
});

test('a render under a file\'s approval carries no template record', async () => {
  await covers('file', 2);
  try {
    await approvedExample('€ 5', `&title=${encodeURIComponent('SLES 16')}`);
    const clean = await rendered('€ 5');
    assert.equal(clean.marked, false, 'the approved file\'s own inputs come out clean');
    assert.equal(clean.report.approval, undefined);
  } finally {
    await covers('template-variants', 3);
  }
});
