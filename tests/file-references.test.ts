// SPDX-License-Identifier: MPL-2.0
/**
 * File references (docs/api.md "File references", server/src/uploads/files.ts)
 * over real HTTP: small bytes kept in one request and larger ones through the
 * parts protocol in scope `file`, each with a digest, an expiry and the
 * operations its owner may run, and a report counted toward the budgets; an
 * account's references read back from a new session and a restarted server;
 * nobody but the owner learns that one exists; revoking access in any of the
 * ways Work has refuses the very next read, and all but signing out everywhere
 * fail a queued request when it runs; and the document verbs read a reference
 * and keep an optimize output as another.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { assertFileOperationReport } from '@lolly-tools/core/file-operation-v1';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import type { Store } from '../server/src/store/types.ts';
import { sha256, TRANSFER_PART_BYTES as P } from '../server/src/uploads/parts.ts';
import { uploadCharge, uploadPartId, type UploadPolicy } from '../server/src/uploads/scoped.ts';
import { FILE_INLINE_MAX_BYTES, FILE_REPORT_MAX_BYTES, manifestOf } from '../server/src/uploads/files.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;
/** dev users: name → groups. root is the owner; everyone else is a member. */
const PEOPLE: Record<string, string[]> = { alice: [], bob: [], carol: [], dave: [], erin: [], root: ['owner'] };
/** A 1x1 PNG. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

async function listen(handler: ReturnType<typeof buildApp>): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface BootOptions { uploads?: Partial<UploadPolicy>; store?: Store; blobs?: BlobStore; backgroundPollMs?: number }
async function boot(opts: BootOptions = {}) {
  const store = opts.store ?? createMemoryStore(), blobs = opts.blobs ?? createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false },
    policy: { uploads: { enabled: true, ...opts.uploads } },
    dev: { enabled: true, users: Object.entries(PEOPLE).map(([name, groups]) => ({ email: `${name}@test`, name, groups })) } }));
  const app = () => buildApp({ config, store, blobs, secrets: { session: 'file-session', link: 'file-link' },
    ...(opts.backgroundPollMs !== undefined ? { backgroundPollMs: opts.backgroundPollMs } : {}) });
  let base = await listen(app());
  const cookies = new Map<string, string>();
  const signIn = async (name: string): Promise<string> => {
    const r = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    const cookie = r.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
    cookies.set(name, cookie);
    return cookie;
  };
  for (const name of Object.keys(PEOPLE)) await signIn(name);
  const auth = (who: string): Record<string, string> => who.startsWith('lwt_') ? { authorization: `Bearer ${who}` }
    : who.startsWith('lw_session=') ? { cookie: who } : who === 'anonymous' ? {} : { cookie: cookies.get(who) ?? '' };
  const call = (who: string, method: string, path: string, body?: unknown) => fetch(base + path, {
    method, headers: { ...auth(who), ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const userId = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!.id;
  const token = async () => {
    const minted = await call('root', 'POST', '/api/v1/tokens', { label: 'Files automation', role: 'member' });
    assert.equal(minted.status, 201, await minted.clone().text());
    return await minted.json() as { id: string; token: string };
  };
  /** A new process over the same store and blob store. */
  const restart = async () => { base = await listen(app()); };
  return { store, blobs, config, call, auth, userId, token, signIn, restart, get base() { return base; } };
}
type Booted = Awaited<ReturnType<typeof boot>>;

interface FileView {
  id: string; name: string; contentType: string; size: number; checksum: string; role: string;
  derivedFrom: { id: string; checksum: string } | null; reportedBy: string | null; createdAt: string; expiresAt: string;
  operations: Array<{ id: string; method: string; path: string; body?: Record<string, unknown> }>;
  unavailable: Array<{ operation: string; code: string; reason: string }>;
}
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string } }).error;
const codeOf = async (r: Response): Promise<[number, string]> => [r.status, r.status >= 400 ? (await errorOf(r)).code : 'ok'];
/** Keep `bytes` as a reference of `who` in one request. */
async function keep(b: Booted, who: string, bytes: Uint8Array, extra: Record<string, unknown> = {}): Promise<FileView> {
  const r = await b.call(who, 'POST', '/api/v1/files', { name: 'pic.png', contentType: 'image/png', bytesBase64: Buffer.from(bytes).toString('base64'), ...extra });
  assert.equal(r.status, 201, await r.clone().text());
  return (await r.json() as { file: FileView }).file;
}
const ref = (f: FileView) => ({ id: f.id, checksum: f.checksum });
async function content(b: Booted, who: string, f: { id: string }): Promise<Buffer> {
  const r = await b.call(who, 'GET', `/api/v1/files/${f.id}/content`);
  assert.equal(r.status, 200, r.status === 200 ? '' : await r.clone().text());
  return Buffer.from(await r.arrayBuffer());
}
/** A report the owner attaches to an output it made elsewhere. */
const clientReport = (input: Uint8Array, output: Uint8Array) => ({
  version: 1, operation: 'convert', state: 'succeeded', options: { target: 'webp' }, changes: ['PNG → WEBP'], findings: [], metadata: 'removed', execution: 'device',
  inputs: [{ name: 'pic.png', format: 'png', mime: 'image/png', size: input.length, sha256: sha256(input) }],
  outputs: [{ name: 'pic.webp', format: 'webp', mime: 'image/webp', size: output.length, sha256: sha256(output) }],
});

test('file references are off until uploads are, and discovery says which', async () => {
  const off = await boot({ uploads: { enabled: false } });
  assert.deepEqual(await codeOf(await off.call('alice', 'GET', '/api/v1/files')), [404, 'NOT_FOUND']);
  assert.deepEqual(await codeOf(await off.call('alice', 'POST', '/api/v1/files', { name: 'a', contentType: 'text/plain', bytesBase64: 'YQ==' })), [404, 'NOT_FOUND']);
  const offDiscovery = await (await off.call('anonymous', 'GET', '/api/v1/discovery')).json() as { files: { references: boolean }; links: { files: string } };
  assert.deepEqual([offDiscovery.files, offDiscovery.links.files], [{ references: false }, '/api/v1/files']);
  const on = await boot();
  assert.deepEqual((await (await on.call('anonymous', 'GET', '/api/v1/discovery')).json() as { files: unknown }).files, { references: true });
  assert.deepEqual(await codeOf(await on.call('anonymous', 'GET', '/api/v1/files')), [401, 'UNAUTHORIZED']);
});

test('a reference keeps small bytes with a digest, an expiry and its operations, and reads back verified', async () => {
  const b = await boot();
  const before = Date.now();
  const file = await keep(b, 'alice', PNG, { checksum: sha256(PNG) });
  assert.match(file.id, /^fil_/);
  assert.deepEqual([file.name, file.contentType, file.size, file.checksum, file.role, file.derivedFrom, file.reportedBy],
    ['pic.png', 'image/png', PNG.length, sha256(PNG), 'original', null, null]);
  const ttl = Date.parse(file.expiresAt) - before;
  assert.ok(ttl >= 168 * HOUR - 5000 && ttl <= 168 * HOUR + 5000, 'a week by default (policy.uploads.fileTtlHours)');
  assert.deepEqual(file.operations, [
    { id: 'read', method: 'GET', path: `/api/v1/files/${file.id}/content` },
    { id: 'inspect', method: 'POST', path: '/api/v1/inspect', body: { file: ref(file) } },
    { id: 'optimize', method: 'POST', path: '/api/v1/optimize', body: { file: ref(file), opts: { format: 'png' }, output: 'file' } },
    { id: 'delete', method: 'DELETE', path: `/api/v1/files/${file.id}` },
  ]);
  assert.deepEqual(file.unavailable, []);

  const read = await b.call('alice', 'GET', `/api/v1/files/${file.id}/content`);
  assert.equal(read.status, 200);
  assert.deepEqual(Buffer.from(await read.arrayBuffer()), PNG);
  assert.equal(read.headers.get('etag'), `"${sha256(PNG)}"`);
  assert.equal(read.headers.get('repr-digest'), `sha-256=:${Buffer.from(sha256(PNG), 'hex').toString('base64')}:`);
  assert.match(read.headers.get('content-disposition') ?? '', /^attachment; filename\*=UTF-8''pic\.png$/);
  assert.equal(read.headers.get('x-content-type-options'), 'nosniff');
  assert.match(read.headers.get('content-security-policy') ?? '', /\bsandbox\b/);
  assert.match(read.headers.get('cache-control') ?? '', /\bno-store\b/);

  const described = await (await b.call('alice', 'GET', `/api/v1/files/${file.id}`)).json() as { file: FileView; report: unknown };
  assert.deepEqual(described, { file, report: null });

  const text = await keep(b, 'alice', Buffer.from('plain words'), { name: 'notes.txt', contentType: 'text/plain' });
  assert.deepEqual(text.operations.map(o => o.id), ['read', 'inspect', 'delete']);
  assert.deepEqual(text.unavailable, [{ operation: 'optimize', code: 'FORMAT_UNSUPPORTED', reason: 'optimize removes metadata from PNG, JPEG and SVG files only' }]);

  const create = (body: Record<string, unknown>) => b.call('alice', 'POST', '/api/v1/files', { name: 'x.png', contentType: 'image/png', bytesBase64: PNG.toString('base64'), ...body });
  assert.deepEqual(await codeOf(await create({ checksum: 'a'.repeat(64) })), [422, 'CHECKSUM_MISMATCH']);
  assert.deepEqual(await codeOf(await create({ bytesBase64: 'YQ' })), [400, 'INVALID_INPUT'], 'not canonical base64');
  assert.deepEqual(await codeOf(await create({ bytesBase64: '' })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await create({ name: '' })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await create({ contentType: 'not a type' })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await create({ role: 'copy' })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await create({ derivedFrom: ref(file) })), [400, 'INVALID_INPUT'], 'only an output names its source');
  assert.deepEqual(await codeOf(await create({ role: 'output', report: { version: 1 } })), [400, 'INVALID_INPUT'], 'a report passes the contract check');
  const huge = await b.call('alice', 'POST', '/api/v1/files', { name: 'x', contentType: 'application/octet-stream', bytesBase64: Buffer.alloc(FILE_INLINE_MAX_BYTES + 1).toString('base64') });
  assert.deepEqual(await codeOf(huge), [413, 'UPLOAD_TOO_LARGE'], 'a larger file goes in parts');
  assert.deepEqual(await codeOf(await b.call('alice', 'GET', '/api/v1/files?limit=0')), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await b.call('alice', 'GET', '/api/v1/files?cursor=bm90IGEgY3Vyc29y')), [400, 'INVALID_INPUT']);
});

test('references count toward the upload budgets and caps', async () => {
  const b = await boot({ uploads: { maxFileBytes: 1024, ownerBudgetBytes: 2 * (600 + 4096), instanceBudgetBytes: 1e9 } });
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/files', { name: 'x', contentType: 'text/plain', bytesBase64: Buffer.alloc(1025).toString('base64') })), [413, 'UPLOAD_TOO_LARGE']);
  await keep(b, 'alice', Buffer.alloc(600, 1));
  await keep(b, 'alice', Buffer.alloc(600, 2));
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/files', { name: 'x', contentType: 'text/plain', bytesBase64: Buffer.alloc(600, 3).toString('base64') })), [413, 'UPLOAD_BUDGET']);
  await keep(b, 'bob', Buffer.alloc(600, 3));
});

test('a report counts toward the budgets, and an optimize repeats only the options the engine takes', async () => {
  const b = await boot();
  const used = async (who: string) => ((await (await b.call(who, 'GET', '/api/v1/uploads')).json()) as { limits: { ownerUsedBytes: number } }).limits.ownerUsedBytes;
  const source = await keep(b, 'alice', PNG);
  const webp = Buffer.from('RIFF....WEBP');

  // An owner's report: the reference costs its bytes, its rows and the report as JSON.
  const report = { ...clientReport(PNG, webp), changes: Array.from({ length: 12 }, (_, n) => `${n} ${'x'.repeat(4000)}`) };
  const before = await used('alice');
  const output = await keep(b, 'alice', webp, { name: 'pic.webp', contentType: 'image/webp', role: 'output', derivedFrom: ref(source), report });
  const grew = await used('alice') - before;
  assert.ok(grew >= webp.length + 4096 + Buffer.byteLength(JSON.stringify(report)), `the report is charged like bytes (grew ${grew})`);
  assert.equal(grew, uploadCharge((await b.store.getUpload(output.id))!));
  const tooBig = { ...clientReport(PNG, webp), changes: Array.from({ length: 17 }, (_, n) => `${n} ${'x'.repeat(4000)}`) };
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/files', { name: 'pic.webp', contentType: 'image/webp', bytesBase64: webp.toString('base64'), role: 'output', report: tooBig })),
    [400, 'INVALID_INPUT'], `a report is at most ${FILE_REPORT_MAX_BYTES} bytes of JSON`);

  // An instance report: 63 padded options the engine ignores stay out of it.
  const padded = Object.fromEntries(Array.from({ length: 63 }, (_, n) => [`k${n}`, 'x'.repeat(4096)]));
  const mid = await used('alice');
  const optimized = await b.call('alice', 'POST', '/api/v1/optimize', { bytesBase64: PNG.toString('base64'), opts: { format: 'png', strip: true, ...padded }, output: 'file' });
  assert.equal(optimized.status, 200, await optimized.clone().text());
  const kept = (await optimized.json() as { file: FileView }).file;
  const described = await (await b.call('alice', 'GET', `/api/v1/files/${kept.id}`)).json() as { report: { options: unknown } };
  assert.deepEqual(described.report.options, { format: 'png', strip: true }, 'only what the engine takes');
  const stored = (await b.store.getUpload(kept.id))!;
  assert.ok(Buffer.byteLength(JSON.stringify(stored.report)) < 8 * 1024, 'well inside the cap');
  assert.equal(await used('alice') - mid, uploadCharge(stored));
  assert.ok(uploadCharge(stored) >= kept.size + 4096 + Buffer.byteLength(JSON.stringify(stored.report)));

  // A format the instance does not know names nothing: neither the output nor the report repeats it.
  const odd = await b.call('alice', 'POST', '/api/v1/optimize', { bytesBase64: PNG.toString('base64'), opts: { format: 'x'.repeat(100_000) }, output: 'file' });
  assert.equal(odd.status, 200, await odd.clone().text());
  const oddFile = (await odd.json() as { file: FileView }).file;
  assert.deepEqual([oddFile.name, oddFile.contentType], ['optimized.bin', 'application/octet-stream']);
  assert.deepEqual((await (await b.call('alice', 'GET', `/api/v1/files/${oddFile.id}`)).json() as { report: { options: unknown } }).report.options, {});
});

test('a larger reference arrives in parts, and an output names its source and the report that made it', async () => {
  const b = await boot();
  const bytes = new Uint8Array(3 * P + 5).map((_, i) => (i * 13) % 251);
  const begun = await b.call('alice', 'POST', '/api/v1/uploads', { scope: 'file', name: 'clip.bin', contentType: 'application/octet-stream', ...manifestOf(bytes) });
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string; parts: unknown[] } };
  assert.match(upload.id, /^fil_/);
  assert.deepEqual(await codeOf(await b.call('alice', 'GET', `/api/v1/files/${upload.id}`)), [404, 'NOT_FOUND'], 'unfinished: not a reference yet');
  for (let n = 0; n < upload.parts.length; n++) assert.equal((await b.call('alice', 'PUT', `/api/v1/uploads/${upload.id}/parts/${n}`, bytes.subarray(n * P, (n + 1) * P))).status, 204);
  const finished = await b.call('alice', 'POST', `/api/v1/uploads/${upload.id}/finalize`, {});
  assert.equal(finished.status, 200);
  const { file } = await finished.json() as { file: FileView };
  assert.deepEqual([file.id, file.size, file.checksum, file.role], [upload.id, bytes.length, sha256(bytes), 'original']);
  assert.ok(Date.parse(file.expiresAt) - Date.now() > 167 * HOUR, 'a finished reference takes fileTtlHours, not readyTtlHours');
  assert.deepEqual(await content(b, 'alice', file), Buffer.from(bytes), 'every part, checked as it streams');
  assert.deepEqual(((await (await b.call('alice', 'GET', '/api/v1/files')).json()) as { files: FileView[] }).files.map(f => f.id), [file.id]);

  // An output made elsewhere: it names its source and carries its report.
  const webp = Buffer.from('RIFF....WEBP');
  const output = await b.call('alice', 'POST', '/api/v1/uploads', { scope: 'file', name: 'pic.webp', contentType: 'image/webp', ...manifestOf(webp),
    role: 'output', derivedFrom: ref(file), report: clientReport(bytes, webp) });
  assert.equal(output.status, 201, await output.clone().text());
  const outId = (await output.json() as { upload: { id: string } }).upload.id;
  assert.equal((await b.call('alice', 'PUT', `/api/v1/uploads/${outId}/parts/0`, new Uint8Array(webp))).status, 204);
  assert.equal((await b.call('alice', 'POST', `/api/v1/uploads/${outId}/finalize`, {})).status, 200);
  const described = await (await b.call('alice', 'GET', `/api/v1/files/${outId}`)).json() as { file: FileView; report: Record<string, unknown> };
  assert.deepEqual([described.file.role, described.file.derivedFrom, described.file.reportedBy], ['output', ref(file), 'owner']);
  assert.deepEqual(described.report, clientReport(bytes, webp));

  const begin = (body: Record<string, unknown>) => b.call('alice', 'POST', '/api/v1/uploads', { scope: 'file', name: 'x', contentType: 'image/webp', ...manifestOf(webp), ...body });
  assert.deepEqual(await codeOf(await begin({ role: 'output', report: { ...clientReport(bytes, webp), state: 'done' } })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await begin({ role: 'output', derivedFrom: { id: 'not-an-id', checksum: file.checksum } })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await begin({ role: 'output', derivedFrom: { ...ref(file), checksum: 'a'.repeat(64) } })), [404, 'NOT_FOUND']);
});

test('a reference belongs to the account: a new session and a restarted server read it, and the list pages', async () => {
  const b = await boot();
  const kept = [];
  for (let n = 0; n < 3; n++) kept.push(await keep(b, 'alice', Buffer.from(`file ${n}`), { name: `f${n}.txt`, contentType: 'text/plain' }));
  // Signing out everywhere ends every session; the account's references stay.
  assert.equal((await b.call('alice', 'POST', '/api/v1/me/revoke-sessions', {})).status, 204);
  assert.equal((await b.call('alice', 'GET', '/api/v1/files')).status, 401);
  await b.restart();
  const fresh = await b.signIn('alice');
  const page1 = await (await b.call(fresh, 'GET', '/api/v1/files?limit=2')).json() as { files: FileView[]; nextCursor: string };
  assert.deepEqual(page1.files.map(f => f.id), [kept[2]!.id, kept[1]!.id], 'newest first');
  const page2 = await (await b.call(fresh, 'GET', `/api/v1/files?limit=2&cursor=${page1.nextCursor}`)).json() as { files: FileView[]; nextCursor: string | null };
  assert.deepEqual([page2.files.map(f => f.id), page2.nextCursor], [[kept[0]!.id], null]);
  assert.equal((await content(b, fresh, kept[0]!)).toString(), 'file 0');

  // A service token is its own account: it sees its references and nobody else's.
  const { token } = await b.token();
  const mine = await keep(b, token, PNG);
  assert.deepEqual(((await (await b.call(token, 'GET', '/api/v1/files')).json()) as { files: FileView[] }).files.map(f => f.id), [mine.id]);
  assert.deepEqual(await content(b, token, mine), PNG);
  assert.ok(!((await (await b.call(fresh, 'GET', '/api/v1/files')).json()) as { files: FileView[] }).files.some(f => f.id === mine.id));
});

test('nobody but the owner learns that a reference exists', async () => {
  const b = await boot();
  const file = await keep(b, 'alice', PNG);
  const rootFile = await keep(b, 'root', PNG);
  const never = { id: 'fil_neverIssued000000000', checksum: file.checksum };
  const { token } = await b.token();
  // Bob, and a service token the owner minted, against a real reference and one never issued.
  for (const [who, target] of [['bob', file], [token, rootFile]] as const) {
    for (const [method, path] of [['GET', `/api/v1/files/${target.id}`], ['GET', `/api/v1/files/${target.id}/content`], ['DELETE', `/api/v1/files/${target.id}`]] as const) {
      const real = await b.call(who, method, path), missing = await b.call(who, method, path.replace(target.id, never.id));
      assert.equal(real.status, 404, `${method} ${path}`);
      assert.equal(await real.text(), await missing.text(), 'the same answer as for an id never issued');
    }
    const verbs = [
      (r: { id: string; checksum: string }) => b.call(who, 'POST', '/api/v1/inspect', { file: r }),
      (r: { id: string; checksum: string }) => b.call(who, 'POST', '/api/v1/optimize', { file: r, opts: { format: 'png' }, output: 'file' }),
      (r: { id: string; checksum: string }) => b.call(who, 'POST', '/api/v1/files', { name: 'x', contentType: 'image/png', bytesBase64: PNG.toString('base64'), role: 'output', derivedFrom: r }),
      (r: { id: string; checksum: string }) => b.call(who, 'POST', '/api/v1/uploads', { scope: 'file', name: 'x', contentType: 'image/png', ...manifestOf(PNG), role: 'output', derivedFrom: r }),
    ];
    for (const use of verbs) {
      const real = await use(ref(target)), missing = await use({ ...never, checksum: target.checksum });
      assert.equal(real.status, 404);
      assert.equal(await real.text(), await missing.text());
    }
  }
  // Same bytes, separate references: nothing is shared between owners.
  const bobs = await keep(b, 'bob', PNG);
  assert.notEqual(bobs.id, file.id);
  assert.deepEqual(((await (await b.call('bob', 'GET', '/api/v1/files')).json()) as { files: FileView[] }).files.map(f => f.id), [bobs.id]);
  assert.deepEqual(await codeOf(await b.call('anonymous', 'GET', `/api/v1/files/${file.id}/content`)), [401, 'UNAUTHORIZED']);
  assert.deepEqual(await content(b, 'alice', file), PNG, 'still there for its owner');
});

test('revoking access in any way Work has refuses the very next read', async () => {
  const b = await boot();
  const readable = async (who: string, f: FileView) => (await b.call(who, 'GET', `/api/v1/files/${f.id}/content`)).status;

  // The owner deletes the reference.
  const deleted = await keep(b, 'alice', PNG);
  assert.equal(await readable('alice', deleted), 200);
  assert.equal((await b.call('alice', 'DELETE', `/api/v1/files/${deleted.id}`)).status, 204);
  assert.equal(await readable('alice', deleted), 404);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { file: ref(deleted) })), [404, 'NOT_FOUND']);
  assert.equal(await b.blobs.head(uploadPartId(deleted, 0)), null, 'the bytes go with it');

  // A service token is revoked.
  const minted = await b.token();
  const tokens = await keep(b, minted.token, PNG);
  assert.equal(await readable(minted.token, tokens), 200);
  assert.equal((await b.call('root', 'DELETE', `/api/v1/tokens/${minted.id}`)).status, 200);
  assert.equal(await readable(minted.token, tokens), 401);

  // A person is disabled.
  const bobs = await keep(b, 'bob', PNG);
  assert.equal(await readable('bob', bobs), 200);
  assert.equal((await b.call('root', 'POST', `/api/v1/users/${await b.userId('bob')}/disabled`, { disabled: true })).status, 200);
  assert.equal(await readable('bob', bobs), 401);

  // tool.use is denied, then given back: the check is live, and nothing was removed.
  const carols = await keep(b, 'carol', PNG);
  assert.equal(await readable('carol', carols), 200);
  const deny = { principal: `user:${await b.userId('carol')}`, action: 'tool.use', resource: '*', effect: 'deny' };
  assert.equal((await b.call('root', 'POST', '/api/v1/grants', deny)).status, 201);
  assert.equal(await readable('carol', carols), 403);
  assert.deepEqual(await codeOf(await b.call('carol', 'POST', '/api/v1/inspect', { file: ref(carols) })), [403, 'FORBIDDEN']);
  assert.equal((await b.call('root', 'DELETE', '/api/v1/grants', deny)).status, 200);
  assert.equal(await readable('carol', carols), 200);

  // An admin signs the person out everywhere: the old session is refused at once.
  const daves = await keep(b, 'dave', PNG);
  const oldSession = (b.auth('dave') as { cookie: string }).cookie;
  assert.equal((await b.call('root', 'POST', `/api/v1/users/${await b.userId('dave')}/revoke-sessions`, {})).status, 200);
  assert.equal(await readable(oldSession, daves), 401);
  assert.equal(await readable(await b.signIn('dave'), daves), 200, 'a new session of the same account reads it');

  // The reference expires.
  const erins = await keep(b, 'erin', PNG);
  const record = (await b.store.getUpload(erins.id))!;
  await b.store.deleteUpload(erins.id);
  await b.store.reserveUpload({ ...record, expiresAt: new Date(Date.now() - 1000).toISOString() }, { ownerBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99 });
  assert.equal(await readable('erin', erins), 404);

  // Erasing the account removes its references.
  const alices = await keep(b, 'alice', PNG);
  assert.equal((await b.call('root', 'DELETE', `/api/v1/users/${await b.userId('alice')}`)).status, 200);
  assert.equal(await b.store.getUpload(alices.id), null);
});

test('a queued request is checked when it runs: every revocation but signing out everywhere fails it unread', async () => {
  // The runner claims nothing while held, so each revocation happens after queueing and before running.
  const inner = createMemoryStore(), gate = { held: true };
  const store = new Proxy(inner, { get: (target, key, receiver) => key === 'claimAutomationJob'
    ? (...args: Parameters<Store['claimAutomationJob']>) => gate.held ? Promise.resolve(null) : target.claimAutomationJob(...args)
    : Reflect.get(target, key, receiver) });
  // Every part read, to show a refused job reads nothing.
  const blobStore = createMemoryBlobStore(), reads: string[] = [];
  const blobs = new Proxy(blobStore, { get: (target, key, receiver) => key === 'get'
    ? (...args: Parameters<BlobStore['get']>) => { reads.push(args[0]); return target.get(...args); }
    : Reflect.get(target, key, receiver) });
  const b = await boot({ store, blobs, backgroundPollMs: 0 });
  const queue = async (who: string, f: FileView) => {
    const owner = (await b.store.getUpload(f.id))!.owner;
    const r = await b.call(who, 'POST', '/api/v1/inspect?async=1', { file: ref(f) });
    assert.equal(r.status, 202, await r.clone().text());
    return { id: (await r.json() as { jobId: string }).jobId, owner, part: uploadPartId(f, 0) };
  };
  const settled = async (job: { id: string; owner: string }) => {
    for (let n = 0; n < 400; n++) {
      const record = await b.store.getAutomationJob(job.id, job.owner);
      if (record?.state === 'done' || record?.state === 'failed') return [record.state, record.error ?? null];
      await new Promise(r => setTimeout(r, 25));
    }
    throw new Error(`job ${job.id} did not settle`);
  };

  const minted = await b.token();
  const tokenJob = await queue(minted.token, await keep(b, minted.token, PNG));
  assert.equal((await b.call('root', 'DELETE', `/api/v1/tokens/${minted.id}`)).status, 200);

  const alices = await keep(b, 'alice', PNG);
  const deletedJob = await queue('alice', alices);
  assert.equal((await b.call('alice', 'DELETE', `/api/v1/files/${alices.id}`)).status, 204);

  const deniedJob = await queue('carol', await keep(b, 'carol', PNG));
  assert.equal((await b.call('root', 'POST', '/api/v1/grants', { principal: `user:${await b.userId('carol')}`, action: 'tool.use', resource: '*', effect: 'deny' })).status, 201);

  const disabledJob = await queue('bob', await keep(b, 'bob', PNG));
  assert.equal((await b.call('root', 'POST', `/api/v1/users/${await b.userId('bob')}/disabled`, { disabled: true })).status, 200);

  const signedOutJob = await queue('dave', await keep(b, 'dave', PNG));
  assert.equal((await b.call('root', 'POST', `/api/v1/users/${await b.userId('dave')}/revoke-sessions`, {})).status, 200);

  // Release the runner, and wake it with one more submission (no poll timer runs).
  reads.length = 0;
  gate.held = false;
  assert.equal((await b.call('root', 'POST', '/api/v1/inspect?async=1', { bytesBase64: PNG.toString('base64') })).status, 202);

  assert.deepEqual(await settled(tokenJob), ['failed', 'The job principal is no longer authorized.']);
  assert.deepEqual(await settled(deletedJob), ['failed', 'no such file reference']);
  assert.deepEqual(await settled(deniedJob), ['failed', 'tool.use required']);
  assert.deepEqual(await settled(disabledJob), ['failed', 'The job principal is no longer authorized.']);
  assert.deepEqual(await settled(signedOutJob), ['done', null], 'signing out ends sessions, not work queued for the account');
  assert.deepEqual(reads.filter(id => [tokenJob, deletedJob, deniedJob, disabledJob].some(job => job.part === id)), [], 'a refused job reads nothing');
  assert.ok(reads.includes(signedOutJob.part));
});

test('the document verbs read a reference, and an optimize keeps its output as another', async () => {
  const b = await boot();
  const file = await keep(b, 'alice', PNG);
  const inspected = await b.call('alice', 'POST', '/api/v1/inspect', { file: ref(file) });
  assert.equal(inspected.status, 200, await inspected.clone().text());
  assert.equal((await inspected.json() as { bytes: number }).bytes, PNG.length);

  const optimized = await b.call('alice', 'POST', '/api/v1/optimize', { file: ref(file), opts: { format: 'png' }, output: 'file' });
  assert.equal(optimized.status, 200, await optimized.clone().text());
  const result = await optimized.json() as { file: FileView; bytes: number; savedBytes: number; stages: string[]; bytesBase64?: string };
  assert.equal(result.bytesBase64, undefined, 'no bytes come back');
  assert.deepEqual([result.file.role, result.file.derivedFrom, result.file.reportedBy, result.file.contentType, result.file.name],
    ['output', ref(file), 'instance', 'image/png', 'pic.png']);
  assert.deepEqual(result.stages, ['strip-metadata']);
  const output = await content(b, 'alice', result.file);
  assert.equal(output.length, result.bytes);
  const { report } = await (await b.call('alice', 'GET', `/api/v1/files/${result.file.id}`)).json() as { report: Record<string, unknown> & { inputs: Array<{ sha256: string }>; outputs: Array<{ sha256: string }> } };
  assertFileOperationReport(report);
  assert.deepEqual([report.operation, report.execution, report.metadata, report.inputs[0]!.sha256, report.outputs[0]!.sha256],
    ['optimize', 'instance', 'removed', file.checksum, sha256(output)]);

  // Inline bytes can be kept as an output too; with no reference there is no source.
  const inline = await (await b.call('alice', 'POST', '/api/v1/optimize', { bytesBase64: PNG.toString('base64'), opts: { format: 'png' }, output: 'file' })).json() as { file: FileView };
  assert.deepEqual([inline.file.derivedFrom, inline.file.contentType, inline.file.name], [null, 'image/png', 'optimized.png']);

  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { file: ref(file), bytesBase64: PNG.toString('base64') })), [400, 'DOCUMENT_API_ERROR']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { file: ref(file), output: 'file' })), [400, 'DOCUMENT_API_ERROR']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/optimize', { file: ref(file), output: 'disk' })), [400, 'DOCUMENT_API_ERROR']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { file: { id: 'nope', checksum: file.checksum } })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { file: { ...ref(file), checksum: 'a'.repeat(64) } })), [404, 'NOT_FOUND']);
  assert.deepEqual(await codeOf(await b.call('anonymous', 'POST', '/api/v1/optimize', { bytesBase64: PNG.toString('base64'), opts: { format: 'png' }, output: 'file' })), [401, 'UNAUTHORIZED']);
});

test('Postgres: references, their fields and a restart on the real drivers', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async (pgStore) => {
    const { createPostgresBlobStore } = await import('../server/src/blobs/postgres.ts');
    const pgBlobs = await createPostgresBlobStore(pgUrl!);
    try {
      const b = await boot({ store: pgStore, blobs: pgBlobs });
      const file = await keep(b, 'alice', PNG);
      const optimized = await (await b.call('alice', 'POST', '/api/v1/optimize', { file: ref(file), opts: { format: 'png' }, output: 'file' })).json() as { file: FileView };
      await b.restart();
      assert.deepEqual(await content(b, 'alice', file), PNG);
      const described = await (await b.call('alice', 'GET', `/api/v1/files/${optimized.file.id}`)).json() as { file: FileView; report: unknown };
      assert.deepEqual([described.file.derivedFrom, described.file.reportedBy], [ref(file), 'instance']);
      assertFileOperationReport(described.report);
      assert.equal((await b.call('bob', 'GET', `/api/v1/files/${file.id}/content`)).status, 404);
      // Migration 0076: a file reference has a role, and only a file reference has the rest.
      const roomy = { ownerBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99 };
      const base = { scope: 'file' as const, owner: 'user:x', name: 'x', size: 1, checksum: 'c'.repeat(64), contentType: 'text/plain', parts: [{ size: 1, checksum: 'c'.repeat(64) }],
        createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + HOUR).toISOString(), ready: false };
      await assert.rejects(pgStore.reserveUpload({ ...base, id: 'fil_norole' }, roomy), /check constraint/);
      await assert.rejects(pgStore.reserveUpload({ ...base, id: 'upl_role', scope: 'automation-input', role: 'original' }, roomy), /check constraint/);
      await assert.rejects(pgStore.reserveUpload({ ...base, id: 'upl_from', scope: 'automation-input', derivedFrom: { id: 'fil_a', checksum: 'c'.repeat(64) } }, roomy), /check constraint/);
    } finally { await pgBlobs.close(); }
  });
});
