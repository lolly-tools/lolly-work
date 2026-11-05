// SPDX-License-Identifier: MPL-2.0
/**
 * Export review over the real app: a person sends the exact file with the
 * request, a reviewer has to fetch it before approving, and the requester gets
 * those bytes only once approved. The inputs digest comes from the server, by the
 * render path's normalisation, and the values themselves are not kept.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import {
  APPROVAL_ARTIFACT_DEFAULTS, approvedArtifactBytes, artifactMedia, artifactPartId, heldArtifactBytes, parseExportReview, sweepApprovalArtifacts,
} from '../server/src/approvals/export-review.ts';
import { renderInputsDigest } from '../server/src/render/inputs-digest.ts';
import { loadEngine } from '../server/src/render/contract.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Approval } from '../server/src/approvals/engine.ts';

const PACK = fileURLToPath(new URL('../packs/demo', import.meta.url));
const PART = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PNG_HEAD = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const png = (size = 2048) => Buffer.concat([PNG_HEAD, randomBytes(size)]);

interface World {
  base: string; server: Server; store: ReturnType<typeof createMemoryStore>; blobs: ReturnType<typeof createMemoryBlobStore>;
  author: string; reviewer: string; reviewer2: string; outsider: string; owner: string; viewer: string;
}
async function boot(policy: Record<string, unknown> = {}): Promise<World> {
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putChain({ id: 'other', name: 'Other', steps: [{ name: 'Other', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putGrant({ principal: 'group:viewer', action: 'export.request', resource: '*', effect: 'deny' } as never);
  const config = parseConfig(JSON.stringify({ instance: { name: 'Review', baseUrl: 'http://localhost', pack: PACK }, rateLimit: { enabled: false }, policy,
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] }, { email: 'author@test', groups: ['author'] },
      { email: 'review@test', groups: ['approver', 'review'] }, { email: 'review2@test', groups: ['approver', 'review'] },
      { email: 'outside@test', groups: ['approver', 'elsewhere'] }, { email: 'viewer@test', groups: ['viewer'] },
    ] } }));
  const app = buildApp({ config, store, blobs, secrets: { session: 'export-review-test', link: 'export-review-link' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  return { base, server, store, blobs,
    author: await login('author@test'), reviewer: await login('review@test'), reviewer2: await login('review2@test'),
    outsider: await login('outside@test'), owner: await login('owner@test'), viewer: await login('viewer@test') };
}
const json = (w: World, path: string, body: unknown, cookie: string, method = 'POST') => fetch(w.base + path, { method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Begin, send and finalize an upload in the request-file scope. */
async function send(w: World, bytes: Buffer, cookie = w.author, finish = true): Promise<string> {
  const parts: Array<{ size: number; checksum: string }> = [];
  for (let at = 0; at < bytes.length; at += PART) {
    const part = bytes.subarray(at, at + PART);
    parts.push({ size: part.length, checksum: sha(part) });
  }
  const begun = await json(w, '/api/v1/uploads', { scope: 'approval-artifact', name: 'card.png', contentType: 'image/png', size: bytes.length, checksum: sha(bytes), parts }, cookie);
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  for (let n = 0; n < parts.length; n++) {
    const put = await fetch(`${w.base}/api/v1/uploads/${upload.id}/parts/${n}`, { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream' }, body: bytes.subarray(n * PART, (n + 1) * PART) });
    assert.equal(put.status, 204);
  }
  if (finish) assert.equal((await json(w, `/api/v1/uploads/${upload.id}/finalize`, {}, cookie)).status, 200);
  return upload.id;
}
const request = (uploadId: string, bytes: Buffer, over: Record<string, unknown> = {}) => ({
  subjectType: 'export-review', title: 'Launch card', chainId: 'brand',
  exportReview: { uploadId, checksum: sha(bytes), toolId: 'qr-code', format: 'png', query: 'url=https%3A%2F%2Fexample.com', widthPx: 800, heightPx: 800, ...over },
});
const raise = async (w: World, bytes = png()) => {
  const created = await json(w, '/api/v1/approvals', request(await send(w, bytes), bytes), w.author);
  assert.equal(created.status, 201, await created.clone().text());
  return { bytes, approval: await created.json() as { id: string; exportReview: { fingerprint: string; sha256: string; artifactUrl: string; inputsDigest: string; toolVersion: string } & Record<string, unknown>; subjectRef: string; state: string } };
};
const read = (w: World, id: string, cookie: string) => fetch(`${w.base}/api/v1/approvals/${id}/artifact`, { headers: { cookie } });
const body = async (res: Response) => Buffer.from(await res.arrayBuffer());

let world: World;
before(async () => { world = await boot(); });
after(() => { world.server.close(); });

test('a request file travels by the parts protocol with general uploads off, and is a person\'s alone', async () => {
  const w = world;
  const bytes = png();
  const manifest = { name: 'x.png', contentType: 'image/png', size: bytes.length, checksum: sha(bytes), parts: [{ size: bytes.length, checksum: sha(bytes) }] };
  assert.equal((await json(w, '/api/v1/uploads', { ...manifest, scope: 'file' }, w.author)).status, 404, 'other scopes stay off');
  assert.equal((await json(w, '/api/v1/uploads', { ...manifest, scope: 'approval-artifact' }, w.viewer)).status, 403, 'needs export.request');
  const minted = await json(w, '/api/v1/tokens', { label: 'ci', role: 'admin' }, w.owner);
  assert.equal(minted.status, 201);
  const { token: secret } = await minted.json() as { token: string };
  const service = await fetch(`${w.base}/api/v1/uploads`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json' }, body: JSON.stringify({ ...manifest, scope: 'approval-artifact' }) });
  assert.equal(service.status, 403, 'an approval request comes from a person');
  const id = await send(w, bytes);
  assert.equal((await fetch(`${w.base}/api/v1/uploads/${id}`, { headers: { cookie: w.outsider } })).status, 404, 'only the owner sees it');
});

test('a request freezes server-worked facts, moves the bytes and keeps no values', async () => {
  const w = world;
  const secret = 'https://example.com/private-campaign-value';
  const bytes = png(2 * PART + 7); // more than one part
  const uploadId = await send(w, bytes);
  const created = await json(w, '/api/v1/approvals', request(uploadId, bytes, { query: `url=${encodeURIComponent(secret)}`, inputsDigest: 'client-says-so', toolVersion: '9.9.9', mediaType: 'text/html' }), w.author);
  assert.equal(created.status, 201, await created.clone().text());
  const approval = await created.json() as { id: string; subjectRef: string; exportReview: Record<string, unknown> };
  const engine = await loadEngine();
  const tool = await engine.loadTool('qr-code', (path: string) => readFile(join(PACK, 'tools', path), 'utf8'));
  assert.equal(approval.exportReview.toolVersion, tool.manifest.version, 'the version this instance serves');
  assert.equal(approval.exportReview.mediaType, 'image/png', 'from the file, not the client');
  assert.equal(approval.exportReview.sha256, sha(bytes));
  assert.equal(approval.exportReview.format, 'png');
  assert.match(String(approval.exportReview.inputsDigest), /^[a-f0-9]{64}$/);
  assert.notEqual(approval.exportReview.inputsDigest, 'client-says-so');
  assert.equal(approval.exportReview.parts, undefined, 'the part table stays on the server');
  assert.equal(approval.subjectRef, `export-review:${approval.exportReview.fingerprint}`);
  const stored = await w.store.getApproval(approval.id);
  assert.ok(!JSON.stringify(stored).includes('private-campaign-value'), 'input values are not stored');
  const audited = JSON.stringify(await w.store.listAuditAfter(0, 1000));
  assert.ok(!audited.includes('private-campaign-value'), 'nor audited');
  assert.equal(await w.store.getUpload(uploadId), null, 'the upload is gone once the request holds the file');
  assert.ok(await w.blobs.head(artifactPartId(approval.id, 2)), 'all three parts moved');
  assert.equal(await w.blobs.head(`upload/${uploadId}/0`), null);
});

test('a request is refused when the file, upload, chain or permission does not line up, and nothing is stored', async () => {
  const w = world;
  const bytes = png();
  const count = async () => (await w.store.listApprovals()).length;
  const before = await count();
  const mine = await send(w, bytes);
  assert.equal((await json(w, '/api/v1/approvals', request(mine, bytes), w.reviewer)).status, 404, 'someone else\'s upload');
  assert.equal((await json(w, '/api/v1/approvals', request(await send(w, bytes), png()), w.author)).status, 409, 'a different file');
  const unfinished = await send(w, bytes, w.author, false);
  assert.equal((await json(w, '/api/v1/approvals', request(unfinished, bytes), w.author)).status, 409, 'not finished');
  const wrong = await json(w, '/api/v1/approvals', request(await send(w, bytes), bytes, { format: 'pdf' }), w.author);
  assert.equal(wrong.status, 422, 'the opening bytes are not a PDF');
  assert.equal((await wrong.json() as { error: { code: string } }).error.code, 'ARTIFACT_FORMAT_MISMATCH');
  assert.equal((await json(w, '/api/v1/approvals', { subjectType: 'asset', title: 'x', chainId: 'brand', exportReview: {} }, w.author)).status, 400);
  assert.equal(await count(), before);
});

test('a reviewer fetches the bytes, inert; the requester and outsiders do not, before a decision', async () => {
  const w = world;
  const { bytes, approval } = await raise(w);
  const early = await read(w, approval.id, w.author);
  assert.equal(early.status, 403);
  assert.equal((await early.json() as { error: { code: string } }).error.code, 'ARTIFACT_NOT_RELEASED');
  assert.equal((await read(w, approval.id, w.outsider)).status, 404, 'the wrong groups learn nothing');
  assert.equal((await read(w, approval.id, w.viewer)).status, 404);
  const seen = await read(w, approval.id, w.reviewer);
  assert.equal(seen.status, 200);
  assert.match(seen.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(seen.headers.get('x-content-type-options'), 'nosniff');
  assert.match(seen.headers.get('content-disposition') ?? '', /^attachment/);
  assert.equal(seen.headers.get('content-type'), 'image/png');
  assert.match(seen.headers.get('cache-control') ?? '', /no-store/);
  assert.ok(seen.headers.get('x-lolly-review-token'));
  assert.deepEqual(await body(seen), bytes, 'exactly the reviewed bytes, unmarked');
});

test('approving needs the fingerprint and a token that came with the bytes', async () => {
  const w = world;
  const { bytes, approval } = await raise(w);
  const act = (cookie: string, over: Record<string, unknown>) => json(w, `/api/v1/approvals/${approval.id}/act`, { action: 'approve', ...over }, cookie);
  const code = async (res: Response) => (await res.json() as { error: { code: string } }).error.code;
  const fingerprint = approval.exportReview.fingerprint;
  const noPrint = await act(w.reviewer, {});
  assert.equal(noPrint.status, 409); assert.equal(await code(noPrint), 'ARTIFACT_SUBJECT_CHANGED');
  const stale = await act(w.reviewer, { artifactFingerprint: '0'.repeat(64) });
  assert.equal(stale.status, 409); assert.equal(await code(stale), 'ARTIFACT_SUBJECT_CHANGED');
  const notLoaded = await act(w.reviewer, { artifactFingerprint: fingerprint });
  assert.equal(notLoaded.status, 409); assert.equal(await code(notLoaded), 'ARTIFACT_NOT_LOADED');
  const theirs = (await read(w, approval.id, w.reviewer2)).headers.get('x-lolly-review-token')!;
  const borrowed = await act(w.reviewer, { artifactFingerprint: fingerprint, reviewToken: theirs });
  assert.equal(borrowed.status, 409, 'a token belongs to the person who fetched the file');
  assert.equal((await w.store.getApproval(approval.id))!.state, 'in_review');
  const token = (await read(w, approval.id, w.reviewer)).headers.get('x-lolly-review-token')!;
  const done = await act(w.reviewer, { artifactFingerprint: fingerprint, reviewToken: token });
  assert.equal(done.status, 200, await done.clone().text());
  assert.equal((await done.json() as { state: string }).state, 'approved');
  // The approved file is byte-identical to what was reviewed, and now the requester's.
  const released = await read(w, approval.id, w.author);
  assert.equal(released.status, 200);
  assert.equal(released.headers.get('x-lolly-review-token'), null);
  const received = await body(released);
  assert.deepEqual(received, bytes);
  assert.equal(sha(received), approval.exportReview.sha256);
  assert.equal((await read(w, approval.id, w.reviewer)).status, 200, 'the person who acted can read what they decided');
  const messages = await w.store.listMessages?.();
  if (messages) assert.ok(messages.some((m: { title?: string; cta?: { label?: string } }) => m.title?.includes('Launch card') && m.cta?.label === 'Get the approved file'));
});

test('a rejected request never releases the file to the requester; rejecting needs no fetch', async () => {
  const w = world;
  const { approval } = await raise(w);
  const rejected = await json(w, `/api/v1/approvals/${approval.id}/act`, { action: 'reject', comment: 'Wrong logo', artifactFingerprint: approval.exportReview.fingerprint }, w.reviewer);
  assert.equal(rejected.status, 200, await rejected.clone().text());
  assert.equal((await read(w, approval.id, w.author)).status, 403);
  assert.equal((await read(w, approval.id, w.reviewer)).status, 200, 'the record stays reviewable');
  await assert.rejects(approvedArtifactBytes({ blobs: w.blobs, store: w.store, policy: APPROVAL_ARTIFACT_DEFAULTS, recorder: { unavailable: async () => null, record: async () => ({ status: 'not-recorded', reason: 'no-route' }) } }, { state: 'rejected' } as Approval), /only an approved request/);
});

test('withdrawing removes the bytes and keeps the record', async () => {
  const w = world;
  const { approval } = await raise(w);
  assert.equal((await json(w, `/api/v1/approvals/${approval.id}/withdraw`, {}, w.author)).status, 200);
  const stored = await w.store.getApproval(approval.id);
  assert.equal(stored!.exportReview!.removedBecause, 'withdrawn');
  assert.equal(stored!.exportReview!.sha256, approval.exportReview.sha256);
  assert.equal(await w.blobs.head(artifactPartId(approval.id, 0)), null);
  for (const cookie of [w.author, w.reviewer]) assert.equal((await read(w, approval.id, cookie)).status, 410);
});

test('retention removes a rejected request\'s file after its days and leaves the rest', async () => {
  const w = await boot();
  try {
    const old = await raise(w), kept = await raise(w), open = await raise(w);
    await json(w, `/api/v1/approvals/${old.approval.id}/act`, { action: 'reject', comment: 'No', artifactFingerprint: old.approval.exportReview.fingerprint }, w.reviewer);
    const token = (await read(w, kept.approval.id, w.reviewer)).headers.get('x-lolly-review-token')!;
    await json(w, `/api/v1/approvals/${kept.approval.id}/act`, { action: 'approve', artifactFingerprint: kept.approval.exportReview.fingerprint, reviewToken: token }, w.reviewer);
    const policy = APPROVAL_ARTIFACT_DEFAULTS;
    assert.equal(await sweepApprovalArtifacts(w.store, w.blobs, policy), 0, 'too soon');
    const later = Date.now() + (policy.closedRetentionDays + 1) * 24 * 60 * 60 * 1000;
    assert.equal(await sweepApprovalArtifacts(w.store, w.blobs, policy, { now: later }), 1);
    assert.equal((await w.store.getApproval(old.approval.id))!.exportReview!.removedBecause, 'retention');
    assert.ok(await w.blobs.head(artifactPartId(kept.approval.id, 0)), 'an approved file is kept by default');
    assert.ok(await w.blobs.head(artifactPartId(open.approval.id, 0)), 'a request in review is never touched');
    const held = heldArtifactBytes(await w.store.listApprovals());
    assert.equal(held, kept.bytes.length + open.bytes.length);
    const run = await json(w, '/api/v1/retention/run', {}, w.owner);
    assert.equal(run.status, 200);
    assert.equal((await run.json() as { approvalArtifactsRemoved?: number }).approvalArtifactsRemoved, 0);
  } finally { w.server.close(); }
});

test('the instance budget and the off switch hold', async () => {
  const small = await boot({ approvalArtifacts: { maxFileBytes: 4096, instanceBudgetBytes: 4096 } });
  try {
    await raise(small, png(3000));
    const bytes = png(3000);
    const refused = await json(small, '/api/v1/approvals', request(await send(small, bytes), bytes), small.author);
    assert.equal(refused.status, 413);
    assert.equal((await refused.json() as { error: { code: string } }).error.code, 'APPROVAL_ARTIFACT_BUDGET');
    const big = png(5000);
    const parts = [{ size: big.length, checksum: sha(big) }];
    assert.equal((await json(small, '/api/v1/uploads', { scope: 'approval-artifact', name: 'x.png', contentType: 'image/png', size: big.length, checksum: sha(big), parts }, small.author)).status, 413);
  } finally { small.server.close(); }
  const off = await boot({ approvalArtifacts: { enabled: false } });
  try {
    const bytes = png();
    const parts = [{ size: bytes.length, checksum: sha(bytes) }];
    assert.equal((await json(off, '/api/v1/uploads', { scope: 'approval-artifact', name: 'x.png', contentType: 'image/png', size: bytes.length, checksum: sha(bytes), parts }, off.author)).status, 404);
    const config = await (await fetch(`${off.base}/api/v1/org-config`, { headers: { cookie: off.author } })).json() as { approvals?: unknown };
    assert.equal(config.approvals, undefined, 'a shell falls back honestly');
  } finally { off.server.close(); }
  assert.throws(() => parseConfig(JSON.stringify({ instance: { name: 'x', baseUrl: 'http://localhost', pack: PACK }, policy: { approvalArtifacts: { maxFileBytes: 1024 * 1024 * 1024, instanceBudgetBytes: 2048 * 1024 * 1024 } } })), /cannot exceed/);
});

test('a chain bound to a tool is writable, must exist, reaches shells and binds requests', async () => {
  const w = await boot();
  try {
    const put = (chain: string) => json(w, '/api/v1/policy/overlays/qr-code', { enforce: { escalation: chain } }, w.owner, 'PUT');
    const missing = await put('nope');
    assert.equal(missing.status, 400);
    assert.equal((await missing.json() as { error: { code: string } }).error.code, 'CHAIN_NOT_FOUND');
    assert.equal((await put('brand')).status, 200);
    const config = await (await fetch(`${w.base}/api/v1/org-config`, { headers: { cookie: w.author } })).json() as { tools: Record<string, { approvalChain?: string }>; approvals?: { exportReview: { maxFileBytes: number; partBytes: number } } };
    assert.equal(config.tools['qr-code']!.approvalChain, 'brand');
    assert.deepEqual(config.approvals, { exportReview: { maxFileBytes: APPROVAL_ARTIFACT_DEFAULTS.maxFileBytes, partBytes: PART } });
    const viewerConfig = await (await fetch(`${w.base}/api/v1/org-config`, { headers: { cookie: w.viewer } })).json() as { approvals?: unknown };
    assert.equal(viewerConfig.approvals, undefined, 'only someone who may request');
    const bytes = png();
    const wrongChain = await json(w, '/api/v1/approvals', { ...request(await send(w, bytes), bytes), chainId: 'other' }, w.author);
    assert.equal(wrongChain.status, 400);
    assert.equal((await wrongChain.json() as { error: { code: string } }).error.code, 'CHAIN_NOT_BOUND');
    const discovery = await (await fetch(`${w.base}/api/v1/discovery`)).json() as { approvals?: { exportReview: boolean } };
    assert.equal(discovery.approvals?.exportReview, true);
  } finally { w.server.close(); }
});

test('the digest matches a render of the same inputs: defaults, locks, order and hidden values', async () => {
  const engine = await loadEngine();
  const tool = await engine.loadTool('qr-code', (path: string) => readFile(join(PACK, 'tools', path), 'utf8'));
  const digest = (values: Record<string, unknown>, overlay?: Parameters<typeof renderInputsDigest>[3], groups: string[] = ['g']) => renderInputsDigest(engine, tool.manifest, values, overlay, groups, {});
  const state = (query: string) => engine.parseUrlState(query, tool.manifest).values as Record<string, unknown>;
  const input = (tool.manifest.inputs as Array<{ id: string; default?: unknown }>).find(i => i.id === 'ecl')!;
  const base = digest(state('url=https%3A%2F%2Fexample.com'));
  assert.match(base, /^[a-f0-9]{64}$/);
  assert.equal(digest(state(`url=https%3A%2F%2Fexample.com&ecl=${input.default}`)), base, 'an explicit default is the same input');
  assert.equal(digest(state(`ecl=${input.default}&url=https%3A%2F%2Fexample.com`)), base, 'order does not matter');
  assert.equal(digest(state('url=https%3A%2F%2Fexample.com&width=500&format=png')), base, 'size and format are not inputs');
  assert.notEqual(digest(state('url=https%3A%2F%2Fexample.org')), base, 'a different value is a different digest');
  const locked = { toolId: 'qr-code', version: 1, inputAccess: { url: [{ groups: ['*'], level: 'locked' as const, value: 'https://example.com' }] } };
  assert.equal(digest(state('url=https%3A%2F%2Fexample.org'), locked), digest({}, locked), 'a locked value beats what the app sent');
  assert.equal(digest({}, locked), base, 'a lock renders the same as sending that value');
  const hidden = { toolId: 'qr-code', version: 1, inputAccess: { ecl: [{ groups: ['*'], level: 'hidden' as const }] } };
  assert.equal(digest(state('url=https%3A%2F%2Fexample.com&ecl=H'), hidden), base, 'a hidden input cannot change the digest');
});

test('format and opening bytes must agree; unknown formats are opaque', () => {
  assert.deepEqual(artifactMedia('png', PNG_HEAD), { mediaType: 'image/png', preview: 'image' });
  assert.equal(artifactMedia('png', Buffer.from('<svg>')), null);
  assert.deepEqual(artifactMedia('svg', Buffer.from('<?xml version="1.0"?>\n<svg xmlns="http://www.w3.org/2000/svg"/>')), { mediaType: 'image/svg+xml', preview: 'image' });
  assert.equal(artifactMedia('svg', Buffer.from('<html><script>alert(1)</script></html>')), null);
  assert.deepEqual(artifactMedia('pdf', Buffer.from('%PDF-1.7')), { mediaType: 'application/pdf', preview: 'pdf' });
  assert.deepEqual(artifactMedia('eps', Buffer.from('%!PS')), { mediaType: 'application/octet-stream', preview: 'none' });
  assert.equal(parseExportReview({ uploadId: 'nope', checksum: '0'.repeat(64), toolId: 'x', format: 'png' }), null);
  assert.equal(parseExportReview({ uploadId: 'upl_a', checksum: '0'.repeat(64), toolId: 'x', format: 'jpeg' })!.format, 'jpg');
});

test('lw approvals artifact writes a verified file for the requester once approved, and refuses before', async () => {
  const w = await boot();
  const { spawn } = await import('node:child_process');
  const { mkdtemp, mkdir, writeFile, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const home = await mkdtemp(join(tmpdir(), 'lw-approval-file-'));
  try {
    await mkdir(join(home, '.config', 'lolly-work'), { recursive: true });
    await writeFile(join(home, '.config', 'lolly-work', 'session'), w.author);
    const cli = fileURLToPath(new URL('../cli/lw.ts', import.meta.url));
    const lw = (...args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
      const child = spawn(process.execPath, [cli, ...args], { env: { ...process.env, HOME: home, LW_BASE: w.base, LW_TOKEN: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
      child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
      child.on('close', code => resolve({ code: code ?? 0, stdout, stderr }));
    });
    const { bytes, approval } = await raise(w);
    const out = join(home, 'card.png');
    const early = await lw('approvals', 'artifact', approval.id, '--out', out);
    assert.notEqual(early.code, 0);
    assert.match(early.stderr, /ARTIFACT_NOT_RELEASED/);
    const listed = await lw('approvals');
    assert.match(listed.stdout, new RegExp(`${approval.id}\\s+in_review`));
    const token = (await read(w, approval.id, w.reviewer)).headers.get('x-lolly-review-token')!;
    await json(w, `/api/v1/approvals/${approval.id}/act`, { action: 'approve', artifactFingerprint: approval.exportReview.fingerprint, reviewToken: token }, w.reviewer);
    const fetched = await lw('approvals', 'artifact', approval.id, '--out', out, '--json');
    assert.equal(fetched.code, 0, fetched.stderr);
    assert.equal(JSON.parse(fetched.stdout).sha256, sha(bytes));
    assert.deepEqual(await readFile(out), bytes);
  } finally { w.server.close(); await rm(home, { recursive: true, force: true }); }
});
