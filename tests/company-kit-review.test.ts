// SPDX-License-Identifier: MPL-2.0
/** Company kit review through the app (plans/82 M8, W-M8-4). */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { IncomingMessage, ServerResponse } from 'node:http';
import { Socket } from 'node:net';
import { Duplex } from 'node:stream';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { PARTNER_KIT_LIMITS, PARTNER_KIT_MAX_ASSET_ID, PARTNER_KIT_MAX_SOURCE_REFERENCE, PARTNER_KIT_COLOUR_ROLES, PARTNER_KIT_TREATMENTS } from '@lolly-tools/core/partner-kit-v1';
import { KIT_DESIGN_SYSTEM_MAX_BYTES, KIT_LOLLY_MAX_BYTES, KIT_SVG_MAX_BYTES, KIT_TOKENS_MAX_BYTES, KIT_TOKENS_MAX_PARTS } from '../server/src/programmes/kit.ts';
import { KIT_LIMITS } from '../server/src/programmes/kit-routes.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

const expectedLimits = { ...PARTNER_KIT_LIMITS, maxAssetId: PARTNER_KIT_MAX_ASSET_ID, maxSourceReference: PARTNER_KIT_MAX_SOURCE_REFERENCE,
  colourRoles: [...PARTNER_KIT_COLOUR_ROLES], treatments: [...PARTNER_KIT_TREATMENTS],
  imports: { tokensMaxBytes: KIT_TOKENS_MAX_BYTES, lollyMaxBytes: KIT_LOLLY_MAX_BYTES, designSystemMaxBytes: KIT_DESIGN_SYSTEM_MAX_BYTES,
    tokensMaxParts: KIT_TOKENS_MAX_PARTS, svgMaxBytes: KIT_SVG_MAX_BYTES } };

let app: ReturnType<typeof buildApp>;
let pack = '';
let store: ReturnType<typeof createMemoryStore>;
let blobs: ReturnType<typeof createMemoryBlobStore>;
let manager = '';
let reviewer = '';
let contact = '';
const AT = '/api/v1/programmes/partners/companies';
const OWN = '/api/v1/me/company/kit';
const kit = (id: string, label = id) => ({ schemaVersion: 1, id, label, logos: {},
  colours: [{ role: 'primary', name: 'Blue', value: '#0B3D91' }], source: { kind: 'manual' } });
/** Use Node's HTTP request and response streams without opening a listener. */
const call = async (cookie: string, method: string, path: string, body?: unknown, token?: string) => {
  const req = new IncomingMessage(new Socket());
  req.method = method; req.url = path;
  const bytes = body === undefined ? undefined : Buffer.isBuffer(body) ? body : Buffer.from(JSON.stringify(body));
  req.headers = { host: 'localhost', cookie, ...(token ? { authorization: `Bearer ${token}` } : {}), 'content-type': 'application/json', ...(bytes ? { 'content-length': String(bytes.length) } : {}) };
  if (bytes) req.push(bytes);
  req.push(null);
  const output: Buffer[] = [];
  const socket = new Duplex({ read() {}, write(chunk, _encoding, done) { output.push(Buffer.from(chunk)); done(); } });
  const res = new ServerResponse(req);
  res.assignSocket(socket as Socket);
  const finished = new Promise<void>((resolve) => res.once('finish', resolve));
  await app(req, res);
  await finished;
  const raw = Buffer.concat(output);
  const text = raw.subarray(raw.indexOf('\r\n\r\n') + 4).toString();
  socket.destroy(); req.socket.destroy();
  const cookies = res.getHeader('set-cookie');
  return { status: res.statusCode, body: text ? JSON.parse(text) as Record<string, any> : {}, cookies: Array.isArray(cookies) ? cookies : [String(cookies)] };
};
async function login(email: string): Promise<string> {
  const res = await call('', 'GET', `/api/auth/dev?email=${encodeURIComponent(email)}`);
  return res.cookies!.find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const settings = (id: string, body: unknown) => call(manager, 'PUT', `${AT}/${id}/profile/settings`, body);
const read = async (id: string) => (await call(manager, 'GET', `${AT}/${id}/kit`)).body;
const decide = async (approvalId: string, action: 'approve' | 'reject') => {
  const res = await call(reviewer, 'POST', `/api/v1/approvals/${approvalId}/act`, { action });
  assert.equal(res.status, 200, JSON.stringify(res.body));
  return res.body;
};
async function company(id: string, live = true) {
  assert.equal((await call(manager, 'PUT', `${AT}/${id}`, { name: id })).status, 201);
  if (live) assert.equal((await call(manager, 'PUT', `${AT}/${id}/kit`, kit(id))).status, 200);
  return `${AT}/${id}/kit`;
}
const kitAudits = async (id: string) => (await store.listAudit()).filter((a) => a.action === 'programme.company.kit' && a.subject === `company:${id}`);

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-kit-review-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Kit Review', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    policy: { submit: { chain: 'catalog-review' } },
    dev: { enabled: true, users: [
      { email: 'manager@brand.test', groups: ['admin'] }, { email: 'reviewer@brand.test', groups: ['approver', 'review'] },
      { email: 'owner@brand.test', groups: ['owner'] },
      { email: 'contact@partner.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  blobs = createMemoryBlobStore();
  await store.putChain({ id: 'kit-review', name: 'Kit review', steps: [{ name: 'Brand', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  app = buildApp({ config, store, blobs, secrets: { session: 'sk', link: 'lk' } });
  manager = await login('manager@brand.test');
  reviewer = await login('reviewer@brand.test');
  contact = await login('contact@partner.test');
  assert.equal((await call(manager, 'PUT', '/api/v1/programmes/partners', { name: 'Partners' })).status, 201);
});
after(async () => { await rm(pack, { recursive: true, force: true }); });

test('empty and saved GETs and imports return the SDK and import limits', async () => {
  const at = await company('limits', false);
  const empty = await call(manager, 'GET', at);
  assert.equal(empty.status, 404);
  assert.deepEqual(empty.body.limits, expectedLimits);
  const tokens = { color: { brand: { $type: 'color', $value: '#0b3d91' } } };
  const zip = new ZipBuilder();
  const share = Buffer.concat([zip.add('design-system.json', Buffer.from(JSON.stringify(tokens))), zip.end()]);
  for (const [from, body] of [['logos', undefined], ['tokens', tokens], ['lolly', share]] as const) {
    const imported = await call(manager, 'POST', `${at}/import?from=${from}`, body);
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.deepEqual(imported.body.limits, expectedLimits);
  }
  const saved = await call(manager, 'PUT', at, kit('limits'));
  assert.equal(saved.status, 200);
  const view = await call(manager, 'GET', at);
  assert.equal(view.status, 200);
  assert.deepEqual(view.body.limits, expectedLimits);
});

test('kit approval is off by default and settings are independent of profile revisions', async () => {
  const at = await company('defaults', false);
  const before = (await call(manager, 'GET', `${AT}/defaults/profile`)).body;
  assert.equal(before.settings.kitApprovalChain, null);
  const saved = await call(manager, 'PUT', at, kit('defaults'));
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.deepEqual(await read('defaults'), saved.body);
  assert.deepEqual(await store.listApprovals(), []);
  for (const value of [42, [], {}]) assert.equal((await settings('defaults', { kitApprovalChain: value })).status, 400);
  assert.equal((await settings('defaults', { kitApprovalChain: 'missing' })).status, 409);
  const changed = await settings('defaults', { kitApprovalChain: 'kit-review', approvalChain: 'kit-review' });
  assert.equal(changed.status, 200);
  assert.equal(changed.body.settings.kitApprovalChain, 'kit-review');
  assert.equal(changed.body.settings.approvalChain, 'kit-review');
  assert.equal(changed.body.revision, before.revision);
  assert.deepEqual(await store.listCompanyProfileHistory('defaults'), []);
  assert.equal((await call(manager, 'PUT', `${AT}/defaults/profile`, { currency: 'EUR' })).status, 200);
  assert.ok((await store.listCompanyProfileHistory('defaults')).every((r) => !('kitApprovalChain' in r.profile)));
  const cleared = await settings('defaults', { kitApprovalChain: '' });
  assert.equal(cleared.body.settings.kitApprovalChain, null);
  assert.equal(cleared.body.settings.approvalChain, 'kit-review');
  assert.equal((await call(manager, 'PUT', at, kit('defaults', 'Direct revision'))).body.revision, 2);
  const audit = (await store.listAudit()).filter((a) => a.action === 'programme.company.profile.settings' && a.subject === 'company:defaults').at(-1)!;
  assert.deepEqual(audit.payload, {
    before: { editors: [], approvalChain: 'kit-review', kitApprovalChain: 'kit-review' },
    after: { editors: [], approvalChain: 'kit-review', kitApprovalChain: null },
  });
});

test('every manager save waits for approval and becomes the next revision on the same asset', async () => {
  const at = await company('revision');
  const before = await read('revision');
  await settings('revision', { kitApprovalChain: 'kit-review' });
  const requested = await call(manager, 'PUT', at, kit('revision', 'Reviewed revision'));
  assert.equal(requested.status, 202, JSON.stringify(requested.body));
  const id = requested.body.pending.approvalId;
  assert.deepEqual(requested.body, { pending: { approvalId: id } });
  const approval = (await store.getApproval(id))!;
  assert.equal(approval.subjectType, 'partner-kit');
  assert.equal(approval.subjectRef, 'revision');
  assert.deepEqual(approval.partnerKit, { companyId: 'revision', companyCreatedAt: approval.partnerKit?.companyCreatedAt, action: 'save', blobId: approval.partnerKit?.blobId });
  assert.ok(approval.partnerKit?.companyCreatedAt, 'the request is tied to this company record');
  const held = (await blobs.get(approval.partnerKit!.blobId!))!;
  assert.equal(JSON.parse(await new Response(held.body).text()).colours[0].value, '#0b3d91');
  assert.deepEqual(await read('revision'), { ...before, pending: { approvalId: id, action: 'save' } });
  assert.equal((await store.listAssetVersions(before.assetId)).length, 0);
  assert.equal((await kitAudits('revision')).length, 1, 'filing a request does not audit a live change');
  assert.equal((await call(manager, 'POST', `/api/v1/approvals/${id}/act`, { action: 'approve' })).status, 403);
  assert.ok((await call(reviewer, 'GET', '/api/v1/approvals?inbox=1')).body.approvals.some((a: { id: string }) => a.id === id));
  await decide(id, 'approve');
  const after = await read('revision');
  assert.equal(after.assetId, before.assetId);
  assert.equal(after.revision, 2);
  assert.equal(after.kit.label, 'Reviewed revision');
  assert.equal(after.pending, undefined);
  assert.deepEqual((await store.listAssetVersions(before.assetId)).map((r) => r.version), [1, 2]);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
  assert.deepEqual((await kitAudits('revision')).at(-1)!.payload, {
    revisionBefore: 1, revisionAfter: 2, source: { kind: 'manual' }, via: { approval: id },
  });
});

test('a first save waits without an asset and GET exposes the pending request', async () => {
  const at = await company('first', false);
  await settings('first', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit('first'));
  assert.equal(asked.status, 202);
  assert.equal((await store.getCompanyProfile('first'))?.kit, undefined);
  assert.deepEqual(await read('first'), { kit: null, limits: KIT_LIMITS, pending: { approvalId: asked.body.pending.approvalId, action: 'save' } });
  assert.deepEqual((await read('first')).limits, expectedLimits);
  assert.ok(!(await store.listInstanceAssets()).some((a) => (a.entry.meta as { company?: string })?.company === 'first'));
  await decide(asked.body.pending.approvalId, 'approve');
  assert.equal((await read('first')).revision, 1);
});

test('an admin token can submit a kit change that becomes live on approval', async () => {
  const at = await company('token', false);
  await settings('token', { kitApprovalChain: 'kit-review' });
  const owner = await login('owner@brand.test');
  const minted = await call(owner, 'POST', '/api/v1/tokens', { label: 'Kit CLI', role: 'admin' });
  assert.equal(minted.status, 201);
  const asked = await call('', 'PUT', at, kit('token'), minted.body.token);
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  const approval = (await store.getApproval(asked.body.pending.approvalId))!;
  assert.equal(await store.getUser(approval.createdBy), null, 'service identities are not company contacts');
  await decide(approval.id, 'approve');
  assert.equal((await read('token')).revision, 1);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
});

test('rejection leaves the live kit and removes the waiting bytes', async () => {
  const at = await company('rejected');
  const before = await read('rejected');
  await settings('rejected', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit('rejected', 'Rejected revision'));
  assert.equal(asked.status, 202);
  const approval = (await store.getApproval(asked.body.pending.approvalId))!;
  assert.ok(await blobs.get(approval.partnerKit!.blobId!));
  await decide(approval.id, 'reject');
  assert.deepEqual(await read('rejected'), before);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
  assert.equal((await store.listAssetVersions(before.assetId)).length, 0);
  assert.equal((await kitAudits('rejected')).length, 1);
});

test('removing a kit waits without retiring the live asset until approved', async () => {
  const at = await company('remove');
  const before = await read('remove');
  await settings('remove', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'DELETE', at);
  assert.equal(asked.status, 202);
  const id = asked.body.pending.approvalId;
  const subject = (await store.getApproval(id))!.partnerKit!;
  assert.deepEqual(subject, { companyId: 'remove', companyCreatedAt: subject.companyCreatedAt, action: 'remove' });
  assert.deepEqual(await read('remove'), { ...before, pending: { approvalId: id, action: 'remove' } });
  assert.equal((await store.getLifecycle(before.assetId))?.revokedAt, undefined);
  assert.equal((await call(manager, 'PUT', at, kit('remove', 'Another'))).status, 409);
  assert.equal((await call(manager, 'DELETE', at)).status, 409);
  await decide(id, 'reject');
  assert.deepEqual(await read('remove'), before);
  const again = await call(manager, 'DELETE', at);
  assert.equal(again.status, 202);
  await decide(again.body.pending.approvalId, 'approve');
  assert.equal((await call(manager, 'GET', at)).status, 404);
  assert.equal((await store.getCompanyProfile('remove'))?.kit, undefined);
  assert.ok((await store.getLifecycle(before.assetId))?.revokedAt);
  assert.deepEqual((await kitAudits('remove')).at(-1)!.payload, {
    revisionBefore: 1, revisionAfter: null, source: { kind: 'manual' }, via: { approval: again.body.pending.approvalId },
  });
});

test('one change waits at a time and clearing the switch restores direct saves after withdrawal', async () => {
  const at = await company('pending');
  await settings('pending', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit('pending', 'Waiting'));
  assert.equal(asked.status, 202);
  const id = asked.body.pending.approvalId;
  const approval = (await store.getApproval(id))!;
  const bytesBefore = (await blobs.usage!()).storedBytes;
  for (const method of ['PUT', 'DELETE']) {
    const duplicate = await call(manager, method, at, method === 'PUT' ? kit('pending', 'Again') : undefined);
    assert.equal(duplicate.status, 409);
    assert.equal(duplicate.body.error.code, 'KIT_CHANGE_PENDING');
    assert.match(duplicate.body.error.message, /waiting for approval/);
  }
  assert.equal((await blobs.usage!()).storedBytes, bytesBefore);
  assert.equal((await settings('pending', { kitApprovalChain: null })).status, 200);
  assert.equal((await call(manager, 'PUT', at, kit('pending'))).status, 409);
  assert.equal((await call(manager, 'POST', `/api/v1/approvals/${id}/withdraw`)).status, 200);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
  assert.equal((await call(manager, 'PUT', at, kit('pending', 'Direct again'))).body.revision, 2);
  assert.equal((await call(manager, 'DELETE', at)).status, 200);
});

test('overlapping save and remove requests file only one approval', async () => {
  const at = await company('overlap');
  await settings('overlap', { kitApprovalChain: 'kit-review' });
  const results = await Promise.all([
    call(manager, 'PUT', at, kit('overlap', 'Waiting')),
    call(manager, 'DELETE', at),
  ]);
  assert.deepEqual(results.map((r) => r.status).sort(), [202, 409]);
  const approvals = (await store.listApprovals()).filter((a) => a.partnerKit?.companyId === 'overlap');
  assert.equal(approvals.length, 1);
  await decide(approvals[0]!.id, 'reject');
});

test('an allowed contact is held by the kit switch while profile editing stays direct and imports store nothing', async () => {
  const at = await company('contact');
  assert.equal((await call(manager, 'POST', '/api/v1/programmes/partners/people', {
    rows: [{ email: 'contact@partner.test', company: 'contact' }], apply: true,
  })).status, 200);
  assert.equal((await call(contact, 'PUT', OWN, kit('contact'))).status, 403);
  await settings('contact', { editors: ['contact@partner.test'], kitApprovalChain: 'kit-review' });
  const before = await read('contact');
  assert.equal((await call(contact, 'PUT', '/api/v1/me/company/profile', { currency: 'GBP' })).status, 200);
  const asked = await call(contact, 'PUT', OWN, kit('contact', 'Contact revision'));
  assert.equal(asked.status, 202);
  assert.deepEqual((await call(contact, 'GET', OWN)).body, { ...before, pending: { approvalId: asked.body.pending.approvalId, action: 'save' } });
  assert.equal((await call(manager, 'PUT', at, kit('contact'))).status, 409);
  assert.equal((await call(contact, 'PUT', OWN, kit('contact'))).status, 409);
  const bytesBefore = (await blobs.usage!()).storedBytes;
  const assetsBefore = await store.listInstanceAssets();
  const approvalsBefore = await store.listApprovals();
  const auditsBefore = await store.listAudit();
  for (const [cookie, path] of [[manager, at], [contact, OWN]]) {
    const imported = await call(cookie!, 'POST', `${path}/import?from=logos`);
    assert.equal(imported.status, 200);
    assert.deepEqual(imported.body.limits, expectedLimits);
    assert.equal(imported.body.pending, undefined);
    assert.equal(imported.body.kit.id, 'contact');
  }
  assert.equal((await blobs.usage!()).storedBytes, bytesBefore);
  assert.deepEqual(await store.listInstanceAssets(), assetsBefore);
  assert.deepEqual(await store.listApprovals(), approvalsBefore);
  assert.deepEqual(await store.listAudit(), auditsBefore);
  await decide(asked.body.pending.approvalId, 'approve');
  assert.equal((await read('contact')).revision, 2);
});

test('invalid kits are refused before filing and checked again on approval', async () => {
  const at = await company('invalid');
  const before = await read('invalid');
  await settings('invalid', { kitApprovalChain: 'kit-review' });
  const approvalsBefore = await store.listApprovals();
  const bytesBefore = (await blobs.usage!()).storedBytes;
  for (const bad of [{ ...kit('invalid'), id: 'other' }, { ...kit('invalid'), logos: { light: { id: 'inst/foreign', version: 1 } } },
    { ...kit('invalid'), rules: { treatments: ['bad'] } }]) assert.equal((await call(manager, 'PUT', at, bad)).status, 422);
  assert.deepEqual(await store.listApprovals(), approvalsBefore);
  assert.equal((await blobs.usage!()).storedBytes, bytesBefore);
  const asked = await call(manager, 'PUT', at, kit('invalid', 'Proposed'));
  const approval = (await store.getApproval(asked.body.pending.approvalId))!;
  await blobs.put(approval.partnerKit!.blobId!, Buffer.from(JSON.stringify(kit('other'))), 'application/json');
  await decide(approval.id, 'approve');
  assert.deepEqual(await read('invalid'), before);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
});

test('a chain removed after the switch was set files no approval and stores no waiting bytes', async () => {
  const at = await company('missing-chain');
  const chain = (await store.getChain('kit-review'))!;
  await store.putChain({ ...chain, id: 'removed-chain' });
  await settings('missing-chain', { kitApprovalChain: 'removed-chain' });
  await store.deleteChain('removed-chain');
  const approvalsBefore = await store.listApprovals();
  const bytesBefore = (await blobs.usage!()).storedBytes;
  for (const method of ['PUT', 'DELETE']) {
    const refused = await call(manager, method, at, method === 'PUT' ? kit('missing-chain', 'Waiting') : undefined);
    assert.equal(refused.status, 409);
    assert.equal(refused.body.error.code, 'CHAIN_NOT_FOUND');
  }
  assert.deepEqual(await store.listApprovals(), approvalsBefore);
  assert.equal((await blobs.usage!()).storedBytes, bytesBefore);
});

test('a multi-step chain applies only at the final decision and keeps the waiting bytes between steps', async () => {
  const at = await company('steps');
  const before = await read('steps');
  await store.putChain({ id: 'two-steps', name: 'Two steps', steps: [
    { name: 'Brand', approvers: { groups: ['review'] }, rule: 'any' },
    { name: 'Legal', approvers: { groups: ['review'] }, rule: 'any' },
  ], onReject: 'return-to-submitter' });
  await settings('steps', { kitApprovalChain: 'two-steps' });
  const asked = await call(manager, 'PUT', at, kit('steps', 'Reviewed twice'));
  const approval = (await store.getApproval(asked.body.pending.approvalId))!;
  assert.equal((await decide(approval.id, 'approve')).state, 'in_review');
  assert.ok(await blobs.get(approval.partnerKit!.blobId!));
  assert.deepEqual((await read('steps')).kit, before.kit);
  assert.equal((await decide(approval.id, 'approve')).state, 'approved');
  assert.equal((await read('steps')).revision, 2);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
});

test('a decision after the company ended applies nothing and deletes the waiting bytes', async () => {
  const at = await company('ended');
  const before = await read('ended');
  await settings('ended', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit('ended', 'Too late'));
  const approval = (await store.getApproval(asked.body.pending.approvalId))!;
  assert.equal((await call(manager, 'POST', '/api/v1/programmes/exit', { company: 'ended', apply: true })).status, 200);
  const auditsBefore = await kitAudits('ended');
  await decide(approval.id, 'approve');
  assert.equal((await store.getCompanyProfile('ended'))?.kit, undefined);
  assert.equal((await store.getInstanceAsset(before.assetId))!.headVersion ?? 1, 1);
  assert.equal(await blobs.get(approval.partnerKit!.blobId!), null);
  assert.deepEqual(await kitAudits('ended'), auditsBefore);
});

test('deleting a company clears waiting bytes and closes save and remove requests before reuse of the id', async () => {
  for (const action of ['save', 'remove'] as const) {
    const id = `deleted-${action}`;
    const at = await company(id);
    await settings(id, { kitApprovalChain: 'kit-review' });
    const asked = await call(manager, action === 'save' ? 'PUT' : 'DELETE', at, action === 'save' ? kit(id, 'Waiting') : undefined);
    const approval = (await store.getApproval(asked.body.pending.approvalId))!;
    assert.equal((await call(manager, 'DELETE', `${AT}/${id}`)).status, 200);
    if (approval.partnerKit!.blobId) assert.equal(await blobs.get(approval.partnerKit!.blobId), null);
    await company(id);
    assert.equal((await call(reviewer, 'POST', `/api/v1/approvals/${approval.id}/act`, { action: 'approve' })).status, 409);
    assert.equal((await read(id)).revision, 1);
  }
});

test('a removal decided after the programme ended leaves its kit unchanged', async () => {
  const at = await company('programme-ended');
  const before = await read('programme-ended');
  await settings('programme-ended', { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'DELETE', at);
  assert.equal(asked.status, 202);
  const programme = (await store.getProgramme('partners'))!;
  await store.putProgramme({ ...programme, endedAt: new Date().toISOString() });
  await decide(asked.body.pending.approvalId, 'approve');
  assert.deepEqual(await read('programme-ended'), before);
  assert.equal((await store.getLifecycle(before.assetId))?.revokedAt, undefined);
  await store.putProgramme(programme);
});

test('kit and approval audit payloads carry no kit bytes or colours', async () => {
  const rows = (await store.listAudit()).filter((a) => a.action === 'programme.company.kit' || (a.payload as { subjectType?: string })?.subjectType === 'partner-kit');
  assert.ok(rows.some((a) => (a.payload as { via?: unknown })?.via));
  for (const row of rows) {
    assert.doesNotMatch(JSON.stringify(row.payload), /colours|#0b3d91|#0B3D91|schemaVersion|blobId/);
    if (row.action === 'programme.company.kit') assert.deepEqual(Object.keys(row.payload!).sort(),
      ['revisionAfter', 'revisionBefore', 'source', ...('via' in row.payload! ? ['via'] : [])]);
  }
});

// Read-only review (plans/82 M8, W-M8-4): each test fails on the code before its fix.

test('a request filed for a company that was deleted and made again with its id never applies to the new one', async () => {
  const id = 'reborn';
  const at = await company(id);
  const before = await read(id);
  await settings(id, { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit(id, 'Proposed'));
  assert.equal(asked.status, 202, JSON.stringify(asked.body));
  // As if the request had been stored after the old company was deleted: it points at the old record.
  const filed = (await store.getApproval(asked.body.pending.approvalId))!;
  await store.putApproval({ ...filed, partnerKit: { ...filed.partnerKit!, companyCreatedAt: '2000-01-01T00:00:00.000Z' } });
  await decide(filed.id, 'approve');
  assert.equal((await read(id)).revision, before.revision, 'the company made later keeps its own kit');
  assert.equal((await read(id)).kit.label, before.kit.label);
});

test('a decision applies only while the stored request still says approved', async () => {
  const id = 'second-thoughts';
  const at = await company(id);
  const before = await read(id);
  await settings(id, { kitApprovalChain: 'kit-review' });
  const asked = await call(manager, 'PUT', at, kit(id, 'Proposed'));
  assert.equal(asked.status, 202);
  const filed = (await store.getApproval(asked.body.pending.approvalId))!;
  // A second reviewer's rejection is what the store holds; a stale approve settles from its own copy.
  await decide(filed.id, 'reject');
  // The approve had read the waiting bytes before the rejection deleted them.
  await blobs.put(filed.partnerKit!.blobId!, Buffer.from(JSON.stringify(kit(id, 'Proposed'))), 'application/json');
  const { registerCompanyKitRoutes } = await import('../server/src/programmes/kit-routes.ts');
  const kits = registerCompanyKitRoutes({ add: () => undefined } as never, {
    store, blobs, notifier: { email: () => undefined, event: () => undefined } as never, baseUrl: 'http://localhost',
    requireAction: async () => null, memberOf: async () => null, audit: async () => undefined,
    kitVisible: async () => true, submitKit: async () => { throw new Error('a rejected request is never published'); },
  } as never);
  await kits.settleApproval({ ...filed, state: 'approved' });
  assert.equal((await read(id)).revision, before.revision);
});
