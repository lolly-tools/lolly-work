// SPDX-License-Identifier: MPL-2.0
/**
 * The approved file: frozen reviewed bytes, plus a signed credential update when the
 * requester chose it, the instance allows it and this server can sign. Most of this
 * runs over the real app with a stand-in recorder, so every "not recorded" path and the
 * made-once rule are proved whatever engine is pinned. The last tests use a real engine:
 * the pinned one once it has `recordApprovalInCredential`, or the one LW_TEST_ENGINE names.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { loadEngine } from '../server/src/render/contract.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import { createApprovalRecorder, type ApprovalRecorder } from '../server/src/approvals/approval-recorder.ts';
import { heldArtifactBytes, retireArtifact } from '../server/src/approvals/export-review.ts';

const PACK = fileURLToPath(new URL('../packs/demo', import.meta.url));
const PART = 1024 * 1024;
const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(2048, 7)]);
const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

/** A recorder that "signs" by appending a marker, and counts how often it was asked. */
function standIn(over: Partial<ApprovalRecorder> = {}) {
  const calls: Array<{ approvalId: string; decidedAt: string; format: string }> = [];
  const recorder: ApprovalRecorder = {
    unavailable: async () => null,
    record: async (reviewed, format, facts) => {
      calls.push({ ...facts, format });
      const bytes = Buffer.concat([reviewed, Buffer.from(`\nrecord ${calls.length}`)]);
      return { status: 'recorded', bytes, sha256: sha(bytes) };
    },
    ...over,
  };
  return { recorder, calls };
}

async function boot(recorder: ApprovalRecorder, policy: Record<string, unknown> = {}) {
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Review', baseUrl: 'http://localhost', pack: PACK }, rateLimit: { enabled: false }, policy,
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'author@test', groups: ['author'] }, { email: 'review@test', groups: ['approver', 'review'] }] } }));
  const app = buildApp({ config, store, blobs, secrets: { session: 'record-test', link: 'record-link' }, approvalRecorder: recorder });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  servers.push(server);
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  return { base, store, blobs, config, author: await login('author@test'), reviewer: await login('review@test') };
}
type World = Awaited<ReturnType<typeof boot>>;
const post = (w: World, path: string, body: unknown, cookie: string) => fetch(w.base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function raise(w: World, bytes: Uint8Array, format: string, recordInCredentials?: boolean) {
  const parts: Array<{ size: number; checksum: string }> = [];
  for (let at = 0; at < bytes.length; at += PART) { const part = bytes.subarray(at, at + PART); parts.push({ size: part.length, checksum: sha(part) }); }
  const begun = await post(w, '/api/v1/uploads', { scope: 'approval-artifact', name: `card.${format}`, contentType: 'application/octet-stream', size: bytes.length, checksum: sha(bytes), parts }, w.author);
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  for (let n = 0; n < parts.length; n++) {
    const put = await fetch(`${w.base}/api/v1/uploads/${upload.id}/parts/${n}`, { method: 'PUT', headers: { cookie: w.author, 'content-type': 'application/octet-stream' }, body: bytes.subarray(n * PART, (n + 1) * PART) });
    assert.equal(put.status, 204);
  }
  assert.equal((await post(w, `/api/v1/uploads/${upload.id}/finalize`, {}, w.author)).status, 200);
  const created = await post(w, '/api/v1/approvals', { subjectType: 'export-review', title: 'Launch card', chainId: 'brand',
    exportReview: { uploadId: upload.id, checksum: sha(bytes), toolId: 'qr-code', format, ...(recordInCredentials !== undefined ? { recordInCredentials } : {}) } }, w.author);
  assert.equal(created.status, 201, await created.clone().text());
  return await created.json() as { id: string; exportReview: { fingerprint: string; sha256: string; recordInCredentials?: boolean; credentialRecord?: unknown } };
}

async function approve(w: World, approval: { id: string; exportReview: { fingerprint: string } }) {
  const look = await fetch(`${w.base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: w.reviewer } });
  assert.equal(look.status, 200);
  const reviewToken = look.headers.get('x-lolly-review-token');
  assert.ok(reviewToken);
  const acted = await post(w, `/api/v1/approvals/${approval.id}/act`, { action: 'approve', artifactFingerprint: approval.exportReview.fingerprint, reviewToken }, w.reviewer);
  assert.equal(acted.status, 200, await acted.clone().text());
  return await acted.json() as { state: string; exportReview: { credentialRecord: { state: string; reason?: string; sha256?: string; parts?: unknown } } };
}

const download = async (w: World, id: string, query = '', cookie = w.author) => {
  const res = await fetch(`${w.base}/api/v1/approvals/${id}/artifact${query}`, { headers: { cookie } });
  return { res, bytes: Buffer.from(await res.arrayBuffer()) };
};

test('recorded: the approved file is the update, made once, and the reviewed bytes stay as they were', async () => {
  const { recorder, calls } = standIn();
  const w = await boot(recorder);
  const a = await raise(w, PNG, 'png', true);
  assert.equal(a.exportReview.recordInCredentials, true, 'the choice is on the frozen record');
  const acted = await approve(w, a);
  const record = acted.exportReview.credentialRecord;
  assert.equal(record.state, 'recorded');
  assert.equal(record.parts, undefined, 'the part table stays on the server');
  assert.equal(calls.length, 1, 'written when the decision was made');
  assert.equal(calls[0]!.approvalId, a.id);
  assert.equal(calls[0]!.format, 'png');
  assert.ok(!Number.isNaN(Date.parse(calls[0]!.decidedAt)));

  const first = await download(w, a.id);
  assert.equal(first.res.status, 200);
  assert.equal(first.res.headers.get('x-lolly-approval-record'), 'recorded');
  assert.equal(sha(first.bytes), record.sha256);
  assert.deepEqual(first.bytes.subarray(0, PNG.length), PNG, 'the stand-in kept the reviewed bytes, so this is the update');
  const second = await download(w, a.id);
  assert.deepEqual(second.bytes, first.bytes, 'a repeat download gives the same bytes');
  assert.equal(calls.length, 1, 'and nothing is signed twice');

  const reviewed = await download(w, a.id, '?file=reviewed');
  assert.deepEqual(reviewed.bytes, PNG, 'the reviewed bytes stay available, untouched');
  assert.equal(reviewed.res.headers.get('x-lolly-approval-record'), null);
  assert.equal(sha(reviewed.bytes), a.exportReview.sha256);

  const stored = await w.store.getApproval(a.id);
  assert.equal(stored!.exportReview!.sha256, sha(PNG), 'both digests are on the record');
  assert.equal(stored!.exportReview!.credentialRecord!.state === 'recorded' && stored!.exportReview!.credentialRecord!.sha256, record.sha256);
  assert.ok(heldArtifactBytes([stored!]) > PNG.length * 2, 'the budget counts both files');
  const audited = await w.store.listAuditAfter(0, 1000);
  const entry = audited.find((row: { action: string }) => row.action === 'approval.credential') as { payload?: Record<string, unknown>; metadata?: Record<string, unknown> } | undefined;
  assert.ok(entry, 'the outcome is audited');
  const facts = JSON.stringify(entry);
  assert.match(facts, new RegExp(record.sha256!));
  assert.doesNotMatch(facts, /author@test|review@test/, 'and names no one');
});

test('opt-out: the approved download is byte-identical to the reviewed file, and says so', async () => {
  const { recorder, calls } = standIn();
  const w = await boot(recorder);
  const a = await raise(w, PNG, 'png', false);
  const acted = await approve(w, a);
  assert.deepEqual([acted.exportReview.credentialRecord.state, acted.exportReview.credentialRecord.reason], ['not-recorded', 'opted-out']);
  assert.equal(calls.length, 0, 'the writer is never called');
  const { res, bytes } = await download(w, a.id);
  assert.deepEqual(bytes, PNG);
  assert.equal(res.headers.get('x-lolly-approval-record'), 'not-recorded; reason=opted-out');
});

test('an older request with no stated choice is never recorded', async () => {
  const { recorder, calls } = standIn();
  const w = await boot(recorder);
  const acted = await approve(w, await raise(w, PNG, 'png'));
  assert.equal(acted.exportReview.credentialRecord.reason, 'not-offered');
  assert.equal(calls.length, 0);
});

test('the instance setting turns recording off whatever the request asked, and the capability with it', async () => {
  const { recorder, calls } = standIn();
  const w = await boot(recorder, { approvalArtifacts: { recordInCredentials: false } });
  const a = await raise(w, PNG, 'png', true);
  const acted = await approve(w, a);
  assert.equal(acted.exportReview.credentialRecord.reason, 'instance-off');
  assert.equal(calls.length, 0);
  assert.deepEqual((await download(w, a.id)).bytes, PNG);
  const config = await (await fetch(`${w.base}/api/v1/org-config`, { headers: { cookie: w.author } })).json() as { approvals?: { exportReview?: { recordInCredentials?: boolean; maxFileBytes?: number } } };
  assert.ok(config.approvals?.exportReview?.maxFileBytes);
  assert.equal(config.approvals?.exportReview?.recordInCredentials, undefined);
});

test('no signing identity: byte-identical file, a clear reason, and nothing is offered', async () => {
  const recorder = createApprovalRecorder({ signer: async () => null, engine: async () => ({ recordApprovalInCredential: async () => { throw new Error('must not be reached'); } }) });
  const w = await boot(recorder);
  const a = await raise(w, PNG, 'png', true);
  const acted = await approve(w, a);
  assert.equal(acted.exportReview.credentialRecord.reason, 'no-signing-identity');
  const { res, bytes } = await download(w, a.id);
  assert.deepEqual(bytes, PNG);
  assert.equal(res.headers.get('x-lolly-approval-record'), 'not-recorded; reason=no-signing-identity');
  const config = await (await fetch(`${w.base}/api/v1/org-config`, { headers: { cookie: w.author } })).json() as { approvals?: { exportReview?: { recordInCredentials?: boolean } } };
  assert.equal(config.approvals?.exportReview?.recordInCredentials, undefined);
});

test('an engine without the writer leaves the capability off and the file as reviewed', async () => {
  const recorder = createApprovalRecorder({ signer: async () => ({}) as never, engine: async () => ({}) });
  assert.equal(await recorder.unavailable(), 'engine-unsupported');
  const w = await boot(recorder);
  const a = await raise(w, PNG, 'png', true);
  const acted = await approve(w, a);
  assert.equal(acted.exportReview.credentialRecord.reason, 'engine-unsupported');
  assert.deepEqual((await download(w, a.id)).bytes, PNG);
});

test('a capable server advertises the choice to shells', async () => {
  const w = await boot(standIn().recorder);
  const config = await (await fetch(`${w.base}/api/v1/org-config`, { headers: { cookie: w.author } })).json() as { approvals?: { exportReview?: { recordInCredentials?: boolean } } };
  assert.equal(config.approvals?.exportReview?.recordInCredentials, true);
});

for (const reason of ['no-route', 'no-credential', 'write-failed', 'readback-failed', 'artwork-changed']) {
  test(`the engine answering ${reason} leaves byte-identical bytes and never a claim`, async () => {
    const w = await boot(standIn({ record: async () => ({ status: 'not-recorded', reason }) }).recorder);
    const a = await raise(w, PNG, 'png', true);
    const acted = await approve(w, a);
    assert.deepEqual([acted.exportReview.credentialRecord.state, acted.exportReview.credentialRecord.reason], ['not-recorded', reason]);
    const { res, bytes } = await download(w, a.id);
    assert.deepEqual(bytes, PNG);
    assert.equal(res.headers.get('x-lolly-approval-record'), `not-recorded; reason=${reason}`);
  });
}

test('a failure while settling never undoes the decision, and the first download settles it', async () => {
  let broken = true;
  const made = standIn();
  const recorder: ApprovalRecorder = { ...made.recorder, record: async (...args) => { if (broken) throw new Error('signer offline'); return made.recorder.record(...args); } };
  const w = await boot(recorder);
  const a = await raise(w, PNG, 'png', true);
  const acted = await approve(w, a);
  assert.equal(acted.state, 'approved', 'the decision stands');
  assert.equal(acted.exportReview.credentialRecord, undefined);
  broken = false;
  const { res, bytes } = await download(w, a.id);
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('x-lolly-approval-record'), 'recorded');
  assert.notDeepEqual(bytes, PNG);
  assert.equal((await w.store.getApproval(a.id))!.exportReview!.credentialRecord!.state, 'recorded');
});

test('the requester still cannot read anything before approval, recorded or not', async () => {
  const w = await boot(standIn().recorder);
  const a = await raise(w, PNG, 'png', true);
  assert.equal((await download(w, a.id)).res.status, 403);
  assert.equal((await download(w, a.id, '?file=reviewed')).res.status, 403);
});

test('retention removes the update with the reviewed file', async () => {
  const w = await boot(standIn().recorder);
  const a = await raise(w, PNG, 'png', true);
  await approve(w, a);
  const stored = (await w.store.getApproval(a.id))!;
  const record = stored.exportReview!.credentialRecord!;
  assert.equal(record.state, 'recorded');
  const removed = (await retireArtifact(w.store, w.blobs, stored, 'retention', new Date().toISOString()))!;
  assert.equal(removed.exportReview!.removedBecause, 'retention');
  assert.equal(removed.exportReview!.removalPending, undefined, 'the removal finished');
  const keys = record.state === 'recorded' ? record.parts.map((_, n) => `approval-artifact/${a.id}/approved/${record.sha256.slice(0, 16)}/${n}`) : [];
  for (const key of keys) assert.equal(await w.blobs.head(key), null, key);
  assert.equal(heldArtifactBytes([removed]), 0);
});

test('lw approvals artifact states which file it wrote, and --reviewed gets the reviewed bytes', async () => {
  const w = await boot(standIn().recorder);
  const home = await mkdtemp(join(tmpdir(), 'lw-approval-record-'));
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
    const a = await raise(w, PNG, 'png', true);
    const acted = await approve(w, a);
    const out = join(home, 'card.png');
    const approved = await lw('approvals', 'artifact', a.id, '--out', out);
    assert.equal(approved.code, 0, approved.stderr);
    assert.match(approved.stdout, /The approval is recorded in this file's Content Credentials/);
    assert.equal(sha(await readFile(out)), acted.exportReview.credentialRecord.sha256);
    const reviewed = await lw('approvals', 'artifact', a.id, '--out', out, '--reviewed', '--json');
    assert.equal(reviewed.code, 0, reviewed.stderr);
    assert.equal(sha(await readFile(out)), sha(PNG));
    assert.equal(JSON.parse(reviewed.stdout).approvalRecord, undefined, 'the reviewed file makes no claim');
    const optedOut = await raise(w, PNG, 'png', false);
    await approve(w, optedOut);
    const plainFile = await lw('approvals', 'artifact', optedOut.id, '--out', out);
    assert.match(plainFile.stdout, /not recorded in this file \(opted-out\)/);
    assert.equal(JSON.parse((await lw('approvals', 'artifact', optedOut.id, '--out', out, '--json')).stdout).reason, 'opted-out');
  } finally { await rm(home, { recursive: true, force: true }); }
});

// ── A real engine ─────────────────────────────────────────────────────────────

const named = process.env.LW_TEST_ENGINE;
const engine = named ? await import(named) : await loadEngine() as Record<string, any>;
const skip = typeof engine.recordApprovalInCredential === 'function' ? false : 'the pinned engine has no recordApprovalInCredential yet; runs after the re-pin, or set LW_TEST_ENGINE';

async function mintIdentity(org = 'Test Org'): Promise<{ certPem: string; keyPem: string }> {
  const eng = engine as unknown as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
  };
  const root = await eng.generateCaRoot({ commonName: `${org} Root`, organization: org, days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'lolly@test.invalid', organization: org, days: 365 });
  return {
    certPem: eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'),
    keyPem: eng.derToPem(keyDer, 'PRIVATE KEY'),
  };
}

const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="48" viewBox="0 0 64 48"><rect width="64" height="48" fill="#123456"/><circle cx="32" cy="24" r="16" fill="#f4c20d"/></svg>');
function pdf(): Buffer {
  let out = '%PDF-1.4\n%\xe2\xe3\xcf\xd3\n';
  const offsets: number[] = [];
  const push = (s: string): void => { offsets.push(out.length); out += s; };
  push('1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n');
  push('2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n');
  push('3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] >>\nendobj\n');
  const xrefOff = out.length;
  out += 'xref\n0 4\n0000000000 65535 f \n';
  for (const o of offsets) out += `${String(o).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size 4 /Root 1 0 R >>\nstartxref\n${xrefOff}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}
const plain = async (format: string): Promise<Uint8Array> => format === 'svg' ? SVG : format === 'pdf' ? pdf()
  : format === 'png' ? await sharp(SVG).png().toBuffer() : await sharp(SVG).jpeg({ quality: 90 }).toBuffer();

async function realWorld() {
  const dates = { notBefore: new Date(Date.now() - 60_000), notAfter: new Date(Date.now() + 86_400_000) };
  const { certPem, keyPem } = await mintIdentity('Acme');
  const signer = await buildSigner(certPem, keyPem, 'Lolly Work');
  const recorder = createApprovalRecorder({ signer: async () => signer, engine: async () => engine });
  return { signer, dates, w: await boot(recorder) };
}

for (const format of ['png', 'jpg', 'svg', 'pdf']) {
  test(`real engine, ${format}: approve, download, read the record back, and the artwork did not change`, { skip }, async () => {
    const { signer, dates, w } = await realWorld();
    const reviewed: Uint8Array = await engine.embedC2pa(await plain(format), format, { signer, dates, title: 'Launch card', claimGenerator: 'Lolly', environment: { tool: 'qr-code', format } });
    const a = await raise(w, reviewed, format, true);
    const acted = await approve(w, a);
    assert.equal(acted.exportReview.credentialRecord.state, 'recorded', JSON.stringify(acted.exportReview.credentialRecord));
    const { res, bytes } = await download(w, a.id);
    assert.equal(res.headers.get('x-lolly-approval-record'), 'recorded');
    const report = await engine.verifyC2pa(new Uint8Array(bytes));
    assert.equal(report.state, 'valid');
    assert.equal(report.approval.approvalId, a.id);
    assert.equal(report.approval.reviewedSha256, `sha256:${sha(reviewed)}`);
    assert.deepEqual(Object.keys(report.approval).sort(), ['approvalId', 'decidedAt', 'reviewedSha256']);
    assert.equal(report.environment.tool, 'qr-code', 'what the export recorded still reads');
    const raw = JSON.stringify(report.approval) + JSON.stringify(report.claim);
    assert.doesNotMatch(raw, /author@test|review@test|Brand/, 'no people and no chain in the record');

    assert.deepEqual((await download(w, a.id, '?file=reviewed')).bytes, Buffer.from(reviewed), 'reviewed bytes untouched');
    if (format === 'png' || format === 'jpg') {
      const [before, after_] = await Promise.all([sharp(reviewed).raw().toBuffer(), sharp(bytes).raw().toBuffer()]);
      assert.ok(before.equals(after_), 'decoded pixels are identical');
    } else if (format === 'pdf') {
      assert.deepEqual(bytes.subarray(0, reviewed.length), Buffer.from(reviewed), 'the reviewed file is an exact prefix');
    } else {
      const outside = (b: Uint8Array) => Buffer.from(b).toString('latin1').replace(/(<c2pa:manifest[^>]*>)[^<]*(<\/c2pa:manifest>)/, '$1$2');
      assert.equal(outside(bytes), outside(reviewed), 'every byte outside the manifest element is the same');
    }
  });
}

test('real engine: a format with no route and a file with no credential stay byte-identical', { skip }, async () => {
  const { signer, dates, w } = await realWorld();
  const noCredential = await plain('png');
  const a = await raise(w, noCredential, 'png', true);
  assert.equal((await approve(w, a)).exportReview.credentialRecord.reason, 'no-credential');
  assert.deepEqual((await download(w, a.id)).bytes, Buffer.from(noCredential));
  // WebP is a format the engine can credential but has no proved update route here.
  const webp = await engine.embedC2pa(new Uint8Array(await sharp(SVG).webp().toBuffer()), 'webp', { signer, dates, claimGenerator: 'Lolly' });
  const b = await raise(w, webp, 'webp', true);
  assert.equal((await approve(w, b)).exportReview.credentialRecord.reason, 'no-route');
  assert.deepEqual((await download(w, b.id)).bytes, Buffer.from(webp));
});

