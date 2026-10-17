// SPDX-License-Identifier: MPL-2.0
/**
 * Resumable uploads (docs/resumable-uploads.md) over real HTTP: the resume
 * report on project files, the scoped upload routes (catalog submission
 * originals and automation inputs) with their owner-only access and budgets,
 * the two consumers that name an upload by reference, the `lw upload` client
 * carrying on after an interruption, and an interrupted 500 MiB upload that
 * finishes once the per-file cap is lifted past migration 0041's old ceiling.
 */
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { createServer, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { runRetention } from '../server/src/audit/retention.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { bufferToStream, readPutBody, type BlobStat, type BlobStore } from '../server/src/blobs/types.ts';
import type { Store } from '../server/src/store/types.ts';
import { filePartBlobId, PROJECT_FILE_PART_BYTES, type ProjectFilePolicy, type ProjectFileRecord } from '../server/src/projects/files.ts';
import { sha256 } from '../server/src/uploads/parts.ts';
import { scheduleUploadSweep, UPLOAD_OVERHEAD_BYTES, UPLOAD_SWEEP_GRACE_MS, uploadPartId, type UploadPolicy, type UploadRecord } from '../server/src/uploads/scoped.ts';
import { resumableUpload, UploadClientError, type SavedUpload, type UploadSource, type UploadStateStore, type UploadTarget } from '../cli/upload-client.ts';
import { uploadRecord, uploadStoreConformance } from './upload-store-conformance.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const MIB = 1024 * 1024;
const P = PROJECT_FILE_PART_BYTES;
const R = UPLOAD_OVERHEAD_BYTES;
const HOUR = 60 * 60 * 1000;
/** dev users: name → groups. author holds catalog.submit; root is the owner. */
const PEOPLE: Record<string, string[]> = { alice: [], editor: [], viewer: [], author: ['author'], other: ['author'], root: ['owner'] };
/** A 1x1 PNG, real enough that the submission sniffer reads its IHDR. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

/** Project files are off on the memory store; these tests use its behaviour
 *  under a durable label, as tests/project-files.test.ts does. */
const durable = (store: Store): Store => Object.assign(store, { storageKind: 'postgres' as const });

async function listen(handler: ReturnType<typeof buildApp>): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

interface BootOptions { projectFiles?: Partial<ProjectFilePolicy>; uploads?: Partial<UploadPolicy>; submit?: Record<string, unknown>; store?: Store; blobs?: BlobStore }
async function boot(opts: BootOptions = {}) {
  const store = opts.store ?? durable(createMemoryStore()), blobs = opts.blobs ?? createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false },
    policy: { projectFiles: opts.projectFiles ?? {}, uploads: opts.uploads ?? {}, ...(opts.submit ? { submit: opts.submit } : {}) },
    dev: { enabled: true, users: Object.entries(PEOPLE).map(([name, groups]) => ({ email: `${name}@test`, name, groups })) } }));
  const app = () => buildApp({ config, store, blobs, secrets: { session: 'upload-session', link: 'upload-link' } });
  const base = await listen(app());
  const cookies = new Map<string, string>();
  for (const name of Object.keys(PEOPLE)) {
    const r = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, r.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!);
  }
  const auth = (who: string): Record<string, string> => who.startsWith('lwt_') ? { authorization: `Bearer ${who}` } : { cookie: cookies.get(who) ?? '' };
  const caller = (origin: string) => (who: string, method: string, path: string, body?: unknown) => fetch(origin + path, {
    method, headers: { ...auth(who), ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const call = caller(base);
  const userId = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!.id;
  const project = async () => {
    const made = await (await call('alice', 'POST', '/api/v1/projects', { name: 'Uploads', visibility: 'private' })).json() as { id: string };
    for (const [who, role] of [['editor', 'editor'], ['viewer', 'viewer']] as const) {
      await store.putProjectMember({ projectId: made.id, userId: await userId(who), role, addedBy: 'alice', addedAt: new Date().toISOString() });
    }
    return made.id;
  };
  const token = async (role = 'member') => {
    const minted = await call('root', 'POST', '/api/v1/tokens', { label: `Uploads ${role}`, role });
    assert.equal(minted.status, 201, await minted.clone().text());
    return (await minted.json() as { token: string }).token;
  };
  return { store, blobs, config, base, app, caller, call, auth, userId, project, token };
}
type Booted = Awaited<ReturnType<typeof boot>>;

function manifest(bytes: Uint8Array) {
  const parts = [];
  for (let n = 0; n < bytes.length; n += P) parts.push({ size: Math.min(P, bytes.length - n), checksum: sha256(bytes.subarray(n, n + P)) });
  return { size: bytes.length, checksum: sha256(bytes), parts };
}
const part = (bytes: Uint8Array, n: number): Uint8Array => bytes.subarray(n * P, (n + 1) * P);
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; maxBytes?: number } }).error;
const codeOf = async (r: Response): Promise<[number, string]> => [r.status, r.status >= 400 ? (await errorOf(r)).code : 'ok'];
const memorySource = (bytes: Uint8Array): UploadSource => ({ size: bytes.length, read: async (offset, length) => bytes.subarray(offset, offset + length) });
function memoryState(): UploadStateStore & { saved: Map<string, SavedUpload> } {
  const saved = new Map<string, SavedUpload>();
  return { saved, get: async (k) => saved.get(k) ?? null, set: async (k, v) => { saved.set(k, v); }, delete: async (k) => { saved.delete(k); } };
}
/** fetch that counts part PUTs and drops the connection for every PUT after the first `limit`. */
function interrupting(limit = Infinity) {
  let puts = 0;
  const wrapped = (async (url: string | URL | Request, init?: RequestInit) => {
    if (init?.method === 'PUT' && ++puts > limit) throw new TypeError('socket hang up');
    return fetch(url, init);
  }) as typeof fetch;
  return { fetch: wrapped, puts: () => puts };
}
/** Begin a scoped upload, send every part and optionally finalize. */
async function scopedUpload(b: Booted, who: string, bytes: Uint8Array, scope: UploadRecord['scope'] = 'automation-input', finalize = true) {
  const begun = await b.call(who, 'POST', '/api/v1/uploads', { scope, name: 'input.png', contentType: 'image/png', ...manifest(bytes) });
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: UploadRecord };
  for (let n = 0; n < upload.parts.length; n++) assert.equal((await b.call(who, 'PUT', `/api/v1/uploads/${upload.id}/parts/${n}`, part(bytes, n))).status, 204);
  if (finalize) assert.equal((await b.call(who, 'POST', `/api/v1/uploads/${upload.id}/finalize`, {})).status, 200);
  return upload;
}

test('a project file upload reports its stored parts to its uploader alone, and resumes from them', async () => {
  const b = await boot(), projectId = await b.project();
  const root = `/api/v1/projects/${projectId}/files`;
  const bytes = new Uint8Array(3 * P + 5).map((_, i) => (i * 31) % 251);
  const begun = await b.call('editor', 'POST', root, { name: 'clip.mov', contentType: 'video/quicktime', ...manifest(bytes), asset: {} });
  assert.equal(begun.status, 201);
  const { file } = await begun.json() as { file: ProjectFileRecord };
  const at = `${root}/${file.id}`;
  for (const n of [2, 0]) assert.equal((await b.call('editor', 'PUT', `${at}/parts/${n}`, part(bytes, n))).status, 204);
  const before = (await b.store.getProjectFile(file.id))!.expiresAt;
  const report = await b.call('editor', 'GET', `${at}/parts`);
  assert.equal(report.status, 200);
  assert.match(report.headers.get('cache-control') ?? '', /\bno-store\b/);
  assert.deepEqual(await report.json(), {
    id: file.id, ready: false, size: bytes.length, checksum: sha256(bytes), expiresAt: before,
    partBytes: P, parts: 4, missing: [1, 3], receivedParts: 2, receivedBytes: 2 * P, offset: P,
  });
  assert.equal((await b.store.getProjectFile(file.id))!.expiresAt, before, 'asking keeps nothing alive');
  assert.deepEqual(await codeOf(await b.call('alice', 'GET', `${at}/parts`)), [403, 'FORBIDDEN'], 'a manager is not the uploader');
  assert.deepEqual(await codeOf(await b.call('viewer', 'GET', `${at}/parts`)), [403, 'FORBIDDEN']);
  assert.deepEqual(await codeOf(await b.call('author', 'GET', `${at}/parts`)), [403, 'FORBIDDEN'], 'outside the project');
  assert.equal((await b.call('nobody', 'GET', `${at}/parts`)).status, 401);
  // A stored part whose bytes changed is reported missing, and replaced.
  await b.blobs.put(filePartBlobId(file, 2), part(bytes, 0), 'application/octet-stream');
  assert.deepEqual(((await (await b.call('editor', 'GET', `${at}/parts`)).json()) as { missing: number[] }).missing, [1, 2, 3]);
  // Carry on through another app with no running digest, as after a restart.
  const other = b.caller(await listen(b.app()));
  for (const n of [1, 2, 3]) assert.equal((await other('editor', 'PUT', `${at}/parts/${n}`, part(bytes, n))).status, 204);
  assert.equal((await other('editor', 'POST', `${at}/finalize`, {})).status, 200);
  assert.deepEqual(await (await other('editor', 'GET', `${at}/parts`)).json(), {
    id: file.id, ready: true, size: bytes.length, checksum: sha256(bytes), partBytes: P, parts: 4, missing: [], receivedParts: 4, receivedBytes: bytes.length, offset: bytes.length,
  });
  assert.deepEqual(Buffer.from(await (await b.call('viewer', 'GET', at)).arrayBuffer()), Buffer.from(bytes));
  // An expired upload has nothing left to resume.
  const stale: ProjectFileRecord = { ...file, id: 'fil_stale', createdAt: new Date(Date.now() - 2 * HOUR).toISOString(), expiresAt: new Date(Date.now() - 1000).toISOString(), createdBy: await b.userId('editor') };
  assert.equal(await b.store.reserveProjectFile(stale, { projectBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99, maxPendingBytes: 1e12 }), 'reserved');
  assert.deepEqual(await codeOf(await b.call('editor', 'GET', `${root}/fil_stale/parts`)), [410, 'UPLOAD_EXPIRED']);
});

test('the lw upload client resumes an interrupted upload, sending only the missing parts', async () => {
  const b = await boot(), projectId = await b.project();
  const bytes = new Uint8Array(6 * P + 77).map((_, i) => (i * 17 + 3) % 256);
  const state = memoryState();
  const target: UploadTarget = { kind: 'project', projectId };
  const common = { base: b.base, headers: b.auth('editor'), target, name: 'deck.pdf', contentType: 'application/pdf', source: memorySource(bytes), state, retries: 1, retryDelayMs: 1 };
  // The connection drops after three parts and stays down through the retry.
  const cut = interrupting(3);
  await assert.rejects(resumableUpload({ ...common, fetch: cut.fetch }), (e: unknown) => e instanceof UploadClientError && e.status === 0);
  assert.equal(state.saved.size, 1, 'the upload id was saved before the first part');
  const [saved] = [...state.saved.values()];
  const fileId = saved!.id;
  assert.equal((await b.store.getProjectFile(fileId))?.ready, false);
  // The next run asks what arrived and sends the other four parts.
  const counted = interrupting();
  const progress: number[] = [];
  const done = await resumableUpload({ ...common, fetch: counted.fetch, onProgress: (sent) => progress.push(sent) });
  assert.deepEqual(done, { id: fileId, checksum: sha256(bytes), size: bytes.length, resumed: true, sentParts: 4 });
  assert.equal(counted.puts(), 4);
  assert.equal(progress[0], 3 * P, 'progress starts from what the instance already held');
  assert.equal(progress.at(-1), bytes.length);
  assert.equal(state.saved.size, 0, 'a finished upload is forgotten');
  assert.deepEqual(Buffer.from(await (await b.call('viewer', 'GET', `/api/v1/projects/${projectId}/files/${fileId}`)).arrayBuffer()), Buffer.from(bytes));

  // A saved upload that was cancelled meanwhile starts again under a new id.
  const second = new Uint8Array(2 * P + 1).fill(9);
  const again = { ...common, source: memorySource(second) };
  await assert.rejects(resumableUpload({ ...again, fetch: interrupting(1).fetch }));
  const cancelled = [...state.saved.values()][0]!.id;
  assert.equal((await b.call('editor', 'DELETE', `/api/v1/projects/${projectId}/files/${cancelled}`)).status, 204);
  const fresh = await resumableUpload(again);
  assert.equal(fresh.resumed, false);
  assert.notEqual(fresh.id, cancelled);
  assert.equal(fresh.sentParts, 3);

  // A service token resumes a scoped upload the same way.
  const token = await b.token();
  const input = new Uint8Array(3 * P).map((_, i) => i % 7);
  const scoped = { ...common, headers: b.auth(token), target: { kind: 'upload', scope: 'automation-input' } as UploadTarget, source: memorySource(input) };
  await assert.rejects(resumableUpload({ ...scoped, fetch: interrupting(2).fetch }));
  const resumed = await resumableUpload(scoped);
  assert.equal(resumed.resumed, true);
  assert.equal(resumed.sentParts, 1);
  assert.equal((await b.store.getUpload(resumed.id))?.owner, `service:svc_${(await b.store.listApiTokens())[0]!.id}`);
});

test('lw upload, run again after a dropped connection, sends only the missing parts', async () => {
  const b = await boot(), projectId = await b.project();
  const home = await mkdtemp(join(tmpdir(), 'lw-upload-'));
  try {
    const config = join(home, '.config', 'lolly-work');
    await mkdir(config, { recursive: true });
    await writeFile(join(config, 'session'), b.auth('editor').cookie!);
    const file = join(home, 'clip.mp4');
    const bytes = new Uint8Array(5 * P + 3).map((_, i) => (i * 13) % 256);
    await writeFile(file, bytes);
    // In front of the instance: drop every part after the first `allowed`.
    let allowed = 2, puts = 0;
    const instance = b.app();
    const base = await listen(((req, res) => {
      if (req.method === 'PUT' && ++puts > allowed) { req.socket.destroy(); return Promise.resolve(); }
      return instance(req, res);
    }) as ReturnType<typeof buildApp>);
    const cli = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
    const lw = () => new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
      const env: NodeJS.ProcessEnv = { ...process.env, HOME: home, LW_BASE: base };
      delete env.LW_TOKEN;
      const child = spawn(process.execPath, [cli, 'upload', file, '--project', projectId], { env, stdio: ['ignore', 'pipe', 'pipe'] });
      let stdout = '', stderr = '';
      child.stdout.on('data', (d: Buffer) => { stdout += d; });
      child.stderr.on('data', (d: Buffer) => { stderr += d; });
      child.on('error', reject);
      child.on('close', (code) => resolve({ code: code ?? -1, stdout, stderr }));
    });
    const stopped = await lw();
    assert.equal(stopped.code, 1, stopped.stdout);
    assert.match(stopped.stderr, /run the same command again to resume/);
    const saved = await readdir(join(config, 'uploads'));
    assert.equal(saved.length, 1);
    assert.equal((await stat(join(config, 'uploads', saved[0]!))).mode & 0o777, 0o600, 'the saved upload is private to its owner');

    allowed = Infinity; puts = 0;
    const finished = await lw();
    assert.equal(finished.code, 0, finished.stderr);
    const fileId = /resumed and finished (fil_\S+) \(5242883 bytes, sha256 ([a-f0-9]{64}), 4 part\(s\) sent\)/.exec(finished.stdout);
    assert.ok(fileId, finished.stdout);
    assert.equal(fileId[2], sha256(bytes));
    assert.equal(puts, 4);
    assert.deepEqual(await readdir(join(config, 'uploads')), [], 'a finished upload is forgotten');
    assert.deepEqual(Buffer.from(await (await b.call('viewer', 'GET', `/api/v1/projects/${projectId}/files/${fileId[1]}`)).arrayBuffer()), Buffer.from(bytes));
  } finally { await rm(home, { recursive: true, force: true }); }
});

/** Bytes of a part drawn from seven 1 MiB patterns, so 500 MiB costs 7 MiB to hold. */
const PATTERNS = Array.from({ length: 7 }, (_, k) => {
  const bytes = new Uint8Array(P);
  let x = 0x9e3779b9 ^ (k * 0x85ebca6b);
  for (let i = 0; i < P; i++) { x ^= x << 13; x ^= x >>> 17; x ^= x << 5; bytes[i] = x & 0xff; }
  return bytes;
});
function patternSource(size: number): UploadSource {
  return {
    size,
    async read(offset, length) {
      // Parts are always read whole, at part boundaries.
      assert.equal(offset % P, 0);
      return PATTERNS[(offset / P) % PATTERNS.length]!.subarray(0, length);
    },
  };
}
/** A BlobStore that keeps one copy of each distinct content, so hundreds of
 *  repeated parts hold only the patterns. Every byte still travels and is
 *  hashed by the real routes; only the storage is shared. */
function dedupingBlobStore(): BlobStore & { distinct(): number } {
  const contents = new Map<string, Buffer>();
  const stats = new Map<string, BlobStat>();
  return {
    driver: 'memory',
    async put(blobId, body, contentType, declared) {
      const { content, checksum } = await readPutBody(body, declared);
      if (!contents.has(checksum)) contents.set(checksum, content);
      const stat = { blobId, size: content.length, checksum, contentType };
      stats.set(blobId, stat);
      return stat;
    },
    async head(blobId) { return stats.get(blobId) ?? null; },
    async get(blobId) {
      const stat = stats.get(blobId);
      return stat ? { body: bufferToStream(contents.get(stat.checksum)!), stat } : null;
    },
    async delete(blobId) { stats.delete(blobId); },
    distinct: () => contents.size,
  };
}

test('an interrupted 500 MiB upload resumes once the cap is lifted', async () => {
  const SIZE = 500 * MIB + 12_345;
  const store = durable(createMemoryStore()), blobs = dedupingBlobStore();
  const capped = await boot({ store, blobs });
  const projectId = await capped.project();
  // One address in front of whichever server process is running, so a
  // restart keeps the address the client saved its upload against.
  let running: ReturnType<typeof buildApp> = capped.app();
  const base = await listen((req, res) => running(req, res));
  const state = memoryState();
  const job = (fetchFn?: typeof fetch) => resumableUpload({
    base, headers: capped.auth('editor'), target: { kind: 'project', projectId }, name: 'keynote-recording.mp4', contentType: 'video/mp4',
    source: patternSource(SIZE), state, retries: 0, ...(fetchFn ? { fetch: fetchFn } : {}),
  });
  // The default cap (25 MiB) refuses it before any byte moves.
  await assert.rejects(job(), (e: unknown) => e instanceof UploadClientError && e.status === 413 && e.code === 'PROJECT_FILE_TOO_LARGE');
  assert.equal(state.saved.size, 0);

  // An operator lifts the cap past migration 0041's old 256 MiB ceiling and
  // restarts. The upload is cut off after 200 of its 501 parts.
  const lifted = { projectFiles: { maxFileBytes: 600 * MIB, projectBudgetBytes: 1024 * MIB, instanceBudgetBytes: 1024 * MIB }, store, blobs };
  running = (await boot(lifted)).app();
  const cut = interrupting(200);
  await assert.rejects(job(cut.fetch), (e: unknown) => e instanceof UploadClientError && e.status === 0);
  const fileId = [...state.saved.values()][0]!.id;
  const file = (await store.getProjectFile(fileId))!;
  assert.equal(file.size, SIZE);
  assert.equal(file.parts.length, 501);
  assert.equal(file.ready, false);

  // Another server process carries it on: it has no running digest, so
  // finalize reads all 501 parts back and hashes them.
  const second = await boot(lifted);
  running = second.app();
  const counted = interrupting();
  const done = await job(counted.fetch);
  assert.equal(done.resumed, true);
  assert.equal(done.sentParts, 301);
  assert.equal(counted.puts(), 301);
  assert.equal((await store.getProjectFile(fileId))?.ready, true);
  assert.equal(blobs.distinct(), 8, 'seven full patterns and the short last part');

  // The download streams every verified byte back.
  const response = await second.call('viewer', 'GET', `/api/v1/projects/${projectId}/files/${fileId}`);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-length'), String(SIZE));
  const hash = createHash('sha256');
  let received = 0;
  for await (const chunk of response.body!) { hash.update(chunk); received += chunk.byteLength; }
  assert.equal(received, SIZE);
  assert.equal(hash.digest('hex'), done.checksum);
});

test('scoped uploads: the begin wants the scope\'s action, and every other route is the owner\'s alone', async () => {
  const b = await boot();
  const bytes = new Uint8Array(P + 10).map((_, i) => i % 199);
  const body = (scope: string, extra: Record<string, unknown> = {}) => ({ scope, name: 'brand.png', contentType: 'image/png', ...manifest(bytes), ...extra });
  assert.equal((await b.call('nobody', 'POST', '/api/v1/uploads', body('automation-input'))).status, 401);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/uploads', body('catalog-submission'))), [403, 'FORBIDDEN'], 'catalog.submit is for authors');
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/uploads', body('elsewhere'))), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/uploads', body('automation-input', { parts: [] }))), [400, 'INVALID_INPUT']);
  await b.store.putGrant({ principal: `user:${await b.userId('viewer')}`, action: 'tool.use', resource: '*', effect: 'deny' });
  assert.deepEqual(await codeOf(await b.call('viewer', 'POST', '/api/v1/uploads', body('automation-input'))), [403, 'FORBIDDEN'], 'tool.use denied');

  const begun = await b.call('author', 'POST', '/api/v1/uploads', body('catalog-submission'));
  assert.equal(begun.status, 201);
  const { upload, partBytes } = await begun.json() as { upload: UploadRecord & { owner?: string }; partBytes: number };
  assert.equal(partBytes, P);
  assert.equal(upload.owner, undefined, 'the owner is the caller and never sent');
  assert.deepEqual(upload.parts, manifest(bytes).parts);
  const at = `/api/v1/uploads/${upload.id}`;
  for (const [method, path, payload] of [['GET', at], ['GET', `${at}/parts`], ['PUT', `${at}/parts/0`, part(bytes, 0)], ['POST', `${at}/finalize`, {}], ['DELETE', at]] as const) {
    assert.deepEqual(await codeOf(await b.call('other', method, path, payload)), [404, 'NOT_FOUND'], `${method} ${path} by another author`);
  }
  const token = await b.token('admin');
  assert.deepEqual(await codeOf(await b.call(token, 'GET', at)), [404, 'NOT_FOUND'], 'nor a service token');

  assert.deepEqual(await codeOf(await b.call('author', 'PUT', `${at}/parts/0`, part(bytes, 1))), [422, 'CHECKSUM_MISMATCH']);
  assert.deepEqual(await codeOf(await b.call('author', 'PUT', `${at}/parts/2`, new Uint8Array(1))), [400, 'INVALID_PART']);
  assert.equal((await b.call('author', 'PUT', `${at}/parts/1`, part(bytes, 1))).status, 204);
  assert.deepEqual(await codeOf(await b.call('author', 'POST', `${at}/finalize`, {})), [409, 'UPLOAD_INCOMPLETE']);
  assert.deepEqual(((await (await b.call('author', 'GET', `${at}/parts`)).json()) as { missing: number[]; offset: number }), {
    id: upload.id, ready: false, size: bytes.length, checksum: sha256(bytes), expiresAt: (await b.store.getUpload(upload.id))!.expiresAt,
    partBytes: P, parts: 2, missing: [0], receivedParts: 1, receivedBytes: 10, offset: 0,
  });
  assert.equal((await b.call('author', 'PUT', `${at}/parts/0`, part(bytes, 0))).status, 204);
  const finished = await b.call('author', 'POST', `${at}/finalize`, {});
  assert.equal(finished.status, 200);
  const ready = (await finished.json() as { upload: UploadRecord }).upload;
  assert.equal(ready.ready, true);
  const kept = Date.parse(ready.expiresAt) - Date.now();
  assert.ok(kept > 23 * HOUR && kept <= 24 * HOUR, 'a finished upload is kept readyTtlHours');
  assert.equal((await b.call('author', 'POST', `${at}/finalize`, {})).status, 200, 'finalizing again is harmless');
  assert.deepEqual(await codeOf(await b.call('author', 'PUT', `${at}/parts/0`, part(bytes, 0))), [409, 'UPLOAD_READY']);

  // A service token holds its own uploads, and lists only those.
  const mine = await scopedUpload(b, token, new Uint8Array([1, 2, 3]));
  const listed = await (await b.call(token, 'GET', '/api/v1/uploads')).json() as { uploads: Array<{ id: string }>; limits: Record<string, number> };
  assert.deepEqual(listed.uploads.map((u) => u.id), [mine.id]);
  assert.deepEqual(listed.limits, { partBytes: P, maxBytes: 64 * MIB, ownerBudgetBytes: 128 * MIB, ownerUsedBytes: 3 + R, instanceRemainingBytes: 256 * MIB - (bytes.length + 3 + 2 * R) });
  assert.deepEqual(((await (await b.call('author', 'GET', '/api/v1/uploads')).json()) as { uploads: Array<{ id: string }> }).uploads.map((u) => u.id), [upload.id]);

  // Cancel: parts first, then the row.
  assert.equal((await b.call('author', 'DELETE', at)).status, 204);
  assert.equal(await b.store.getUpload(upload.id), null);
  assert.equal(await b.blobs.head(uploadPartId(upload, 0)), null);
  assert.deepEqual(await codeOf(await b.call('author', 'GET', at)), [404, 'NOT_FOUND']);
});

test('scoped uploads: caps and budgets refuse at the begin, and expired uploads count for nothing', async () => {
  const b = await boot({ uploads: { maxFileBytes: 4096, ownerBudgetBytes: 2 * (4096 + R), instanceBudgetBytes: 3 * (4096 + R) }, submit: { maxBytes: 1000 } });
  const begin = (who: string, size: number, scope = 'automation-input') =>
    b.call(who, 'POST', '/api/v1/uploads', { scope, name: 'x.bin', contentType: 'application/octet-stream', ...manifest(new Uint8Array(size).fill(size % 251)) });
  const tooLarge = await begin('author', 4097);
  assert.deepEqual([tooLarge.status, (await errorOf(tooLarge)).maxBytes], [413, 4096]);
  const tooLargeForCatalog = await begin('author', 1001, 'catalog-submission');
  assert.deepEqual([tooLargeForCatalog.status, (await errorOf(tooLargeForCatalog)).maxBytes], [413, 1000], 'a catalog original is capped at policy.submit.maxBytes');
  // An expired upload larger than every budget changes nothing.
  await b.store.reserveUpload(uploadRecord('upl_expired', `user:${await b.userId('alice')}`, 1e6, { createdAt: Date.now() - 2 * HOUR }), { ownerBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99 });
  assert.deepEqual(await codeOf(await begin('alice', 4096)), [201, 'ok']);
  assert.deepEqual(await codeOf(await begin('alice', 4096)), [201, 'ok']);
  assert.deepEqual(await codeOf(await begin('alice', 1)), [413, 'UPLOAD_BUDGET']);
  assert.deepEqual(await codeOf(await begin('editor', 4096)), [201, 'ok']);
  assert.deepEqual(await codeOf(await begin('author', 1)), [413, 'INSTANCE_UPLOAD_BUDGET'], 'the instance budget spans owners');

  const many = await boot();
  for (let n = 0; n < 16; n++) assert.deepEqual(await codeOf(await many.call('alice', 'POST', '/api/v1/uploads', { scope: 'automation-input', name: 'x', contentType: 'text/plain', ...manifest(new Uint8Array([n])) })), [201, 'ok']);
  assert.deepEqual(await codeOf(await many.call('alice', 'POST', '/api/v1/uploads', { scope: 'automation-input', name: 'x', contentType: 'text/plain', ...manifest(new Uint8Array([99])) })), [413, 'UPLOAD_PENDING']);
  assert.deepEqual(await codeOf(await many.call('editor', 'POST', '/api/v1/uploads', { scope: 'automation-input', name: 'x', contentType: 'text/plain', ...manifest(new Uint8Array([99])) })), [201, 'ok'], 'per owner');

  const off = await boot({ uploads: { enabled: false } });
  for (const [method, path] of [['GET', '/api/v1/uploads'], ['POST', '/api/v1/uploads'], ['GET', '/api/v1/uploads/upl_x/parts'], ['DELETE', '/api/v1/uploads/upl_x']] as const) {
    const r = await off.call('alice', method, path, method === 'POST' ? {} : undefined);
    assert.deepEqual([r.status, await errorOf(r)], [404, { code: 'NOT_FOUND', message: 'uploads are off' }], `${method} ${path}`);
  }
});

test('a finished catalog-submission upload is submitted by reference, once, by its owner', async () => {
  const b = await boot();
  const upload = await scopedUpload(b, 'author', PNG, 'catalog-submission');
  const submit = (who: string, params: Record<string, string>, body: Uint8Array = new Uint8Array(0)) =>
    fetch(`${b.base}/api/v1/catalog/submit?${new URLSearchParams({ name: 'Mark', ...params })}`, { method: 'POST', headers: { ...b.auth(who), 'content-type': 'application/octet-stream' }, body });
  const ref = { uploadId: upload.id, checksum: sha256(PNG) };
  assert.deepEqual(await codeOf(await submit('other', ref)), [404, 'NOT_FOUND'], 'another author cannot name it');
  assert.deepEqual(await codeOf(await submit('author', { ...ref, checksum: '0'.repeat(64) })), [404, 'NOT_FOUND'], 'the checksum binds the bytes');
  assert.deepEqual(await codeOf(await submit('author', { ...ref, checksum: 'nope' })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await submit('author', ref, new Uint8Array([1]))), [400, 'INVALID_INPUT'], 'no request body beside a reference');
  assert.deepEqual(await codeOf(await submit('author', { ...ref, projectId: 'prj_x', fileId: 'fil_x' })), [400, 'INVALID_INPUT']);
  const input = await scopedUpload(b, 'author', PNG, 'automation-input');
  assert.deepEqual(await codeOf(await submit('author', { uploadId: input.id, checksum: sha256(PNG) })), [404, 'NOT_FOUND'], 'an automation input is not a catalog original');
  const unfinished = await scopedUpload(b, 'author', new Uint8Array([7, 7]), 'catalog-submission', false);
  assert.deepEqual(await codeOf(await submit('author', { uploadId: unfinished.id, checksum: sha256(new Uint8Array([7, 7])) })), [404, 'NOT_FOUND']);
  assert.equal((await b.store.listInstanceAssets()).length, 0);

  const accepted = await submit('author', ref);
  assert.equal(accepted.status, 201, await accepted.clone().text());
  const answer = await accepted.json() as { assetId: string; checksum: string; size: number };
  assert.deepEqual([answer.checksum, answer.size], [sha256(PNG), PNG.length]);
  const served = await fetch(`${b.base}/catalog/${answer.assetId}/png`, { headers: b.auth('author') });
  assert.deepEqual(Buffer.from(await served.arrayBuffer()), PNG);
  assert.equal(await b.store.getUpload(upload.id), null, 'a submission uses its upload');
  assert.equal(await b.blobs.head(uploadPartId(upload, 0)), null);
  assert.deepEqual(await codeOf(await submit('author', ref)), [404, 'NOT_FOUND'], 'and only once');
  const audited = (await b.store.listAudit()).find((e) => e.action === 'catalog.submit' && e.subject === `catalog:${answer.assetId}`);
  assert.equal(audited?.payload?.uploadId, upload.id);
});

test('the document verbs read an automation-input upload by reference, as often as its owner likes', async () => {
  const b = await boot();
  const upload = await scopedUpload(b, 'alice', PNG);
  const ref = { id: upload.id, checksum: sha256(PNG) };
  for (let n = 0; n < 2; n++) {
    const inspected = await b.call('alice', 'POST', '/api/v1/inspect', { upload: ref });
    assert.equal(inspected.status, 200, await inspected.clone().text());
    assert.equal((await inspected.json() as { bytes: number }).bytes, PNG.length);
  }
  assert.deepEqual(await codeOf(await b.call('editor', 'POST', '/api/v1/inspect', { upload: ref })), [404, 'NOT_FOUND'], 'someone else\'s upload');
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { upload: { ...ref, checksum: 'a'.repeat(64) } })), [404, 'NOT_FOUND']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { upload: { id: 'not-an-id', checksum: ref.checksum } })), [400, 'INVALID_INPUT']);
  assert.deepEqual(await codeOf(await b.call('alice', 'POST', '/api/v1/inspect', { upload: ref, bytesBase64: PNG.toString('base64') })), [400, 'DOCUMENT_API_ERROR']);
  const original = await scopedUpload(b, 'author', PNG, 'catalog-submission');
  assert.deepEqual(await codeOf(await b.call('author', 'POST', '/api/v1/inspect', { upload: { id: original.id, checksum: ref.checksum } })), [404, 'NOT_FOUND'], 'a catalog original is not an automation input');
  assert.ok(await b.store.getUpload(upload.id), 'reading uses nothing up');
});

test('account erasure removes the person\'s uploads, and the sweeps remove expired ones', async () => {
  const b = await boot();
  const held = await scopedUpload(b, 'editor', new Uint8Array(P + 1).fill(3), 'automation-input', false);
  const editor = await b.userId('editor');
  assert.equal((await b.call('root', 'DELETE', `/api/v1/users/${editor}`)).status, 200);
  assert.equal(await b.store.getUpload(held.id), null);
  assert.equal(await b.blobs.head(uploadPartId(held, 1)), null);

  const owner = `user:${await b.userId('alice')}`;
  const put = async (u: UploadRecord) => {
    assert.equal(await b.store.reserveUpload(u, { ownerBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99 }), 'reserved');
    for (let n = 0; n < u.parts.length; n++) await b.blobs.put(uploadPartId(u, n), new Uint8Array([n]), 'application/octet-stream');
  };
  // Expired past the grace period, and expired just now.
  const old = uploadRecord('upl_old', owner, P + 1, { createdAt: Date.now() - 3 * HOUR, expiresIn: 3 * HOUR - UPLOAD_SWEEP_GRACE_MS - 1000 });
  const recent = uploadRecord('upl_recent', owner, 1, { createdAt: Date.now() - HOUR, expiresIn: HOUR - 1000 });
  await put(old); await put(recent);
  assert.equal((await b.call('author', 'POST', '/api/v1/uploads', { scope: 'automation-input', name: 'x', contentType: 'text/plain', ...manifest(new Uint8Array([1])) })).status, 201);
  assert.equal(await b.store.getUpload(old.id), null, 'past the grace period: swept by a begin');
  assert.equal(await b.blobs.head(uploadPartId(old, 1)), null);
  assert.ok(await b.store.getUpload(recent.id), 'inside the grace period: kept');
  const later = await runRetention({ config: b.config, store: b.store, blobs: b.blobs, now: () => new Date(Date.now() + UPLOAD_SWEEP_GRACE_MS + 5 * 60_000) });
  assert.equal(later.uploadsSwept, 1);
  assert.equal(await b.store.getUpload(recent.id), null);

  const logs: string[] = [];
  await put(uploadRecord('upl_timer', owner, 1, { createdAt: Date.now() - 3 * HOUR, expiresIn: 3 * HOUR - UPLOAD_SWEEP_GRACE_MS - 1000 }));
  const timer = scheduleUploadSweep(b.store, b.blobs, { log: { log: (m: string) => logs.push(m), error: (m: string) => logs.push(m) } });
  await timer.first; timer.stop();
  assert.deepEqual(logs, ['[lolly-work] swept 1 expired upload(s)']);
});

test('upload records keep one set of rules on the memory store', async () => {
  await uploadStoreConformance(createMemoryStore());
});

test('Postgres: upload records, the lifted size CHECKs and a resumed upload on the real drivers', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async (pgStore) => {
    await uploadStoreConformance(pgStore);
    // Parallel reservations never pass the instance budget.
    const limits = { ownerBudgetBytes: 1e12, instanceBudgetBytes: 10 * (100 + R), maxPending: 99 };
    const room = Math.floor((limits.instanceBudgetBytes - (await pgStore.uploadUsage('nobody')).instanceBytes) / (100 + R));
    assert.ok(room > 0 && room < 24);
    const outcomes = await Promise.all(Array.from({ length: 24 }, (_, n) => pgStore.reserveUpload(uploadRecord(`upl_race${n}`, `user:race${n % 3}`, 100), limits)));
    assert.equal(outcomes.filter((o) => o === 'reserved').length, room);
    assert.equal(outcomes.filter((o) => o === 'instance-budget').length, 24 - room);

    // Migration 0075: a 500 MiB project file row, which 0041 refused, and the new ceiling.
    const owner = await pgStore.upsertUserBySub({ sub: 'uploads-pg', email: 'uploads-pg@example.invalid', groups: [], role: 'member' });
    await pgStore.putProject({ id: 'prj_big', name: 'Big', visibility: 'private', ownerId: owner.id, createdAt: new Date().toISOString() });
    const size = 500 * MIB;
    const big: ProjectFileRecord = { id: 'fil_big', projectId: 'prj_big', name: 'big.mp4', size, checksum: 'c'.repeat(64), contentType: 'video/mp4',
      parts: Array.from({ length: size / P }, () => ({ size: P, checksum: 'c'.repeat(64) })), asset: {}, createdBy: owner.id,
      createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + HOUR).toISOString(), ready: false };
    assert.equal(await pgStore.reserveProjectFile(big, { projectBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99, maxPendingBytes: 1e12 }), 'reserved');
    assert.equal((await pgStore.getProjectFile('fil_big'))?.size, size);
    await assert.rejects(pgStore.reserveProjectFile({ ...big, id: 'fil_huge', size: 4 * 1024 * MIB + 1 }, { projectBudgetBytes: 1e13, instanceBudgetBytes: 1e13, maxPending: 99, maxPendingBytes: 1e13 }), /check constraint/);
    await assert.rejects(pgStore.reserveUpload({ ...uploadRecord('upl_huge', 'user:x', 1), size: 4 * 1024 * MIB + 1 }, { ownerBudgetBytes: 1e13, instanceBudgetBytes: 1e13, maxPending: 99 }), /check constraint/);
    await assert.rejects(pgStore.reserveUpload(uploadRecord('upl_badowner', 'guest:1.2.3.4', 1), { ...limits, instanceBudgetBytes: 1e13 }), /check constraint/, 'an anonymous caller owns nothing');

    // A resumed scoped upload through the routes on the Postgres drivers.
    const { createPostgresBlobStore } = await import('../server/src/blobs/postgres.ts');
    const pgBlobs = await createPostgresBlobStore(pgUrl!);
    try {
      const b = await boot({ store: pgStore, blobs: pgBlobs });
      const bytes = new Uint8Array(4 * P + 3).map((_, i) => (i * 5) % 241);
      const state = memoryState();
      const common = { base: b.base, headers: b.auth('alice'), target: { kind: 'upload', scope: 'automation-input' } as UploadTarget, name: 'pg.bin', contentType: 'application/octet-stream', source: memorySource(bytes), state, retries: 0 };
      await assert.rejects(resumableUpload({ ...common, fetch: interrupting(2).fetch }));
      const progress = await (await b.call('alice', 'GET', `/api/v1/uploads/${[...state.saved.values()][0]!.id}/parts`)).json() as { missing: number[] };
      assert.deepEqual(progress.missing, [2, 3, 4]);
      const done = await resumableUpload(common);
      assert.deepEqual([done.resumed, done.sentParts], [true, 3]);
      const inspected = await b.call('alice', 'POST', '/api/v1/inspect', { upload: { id: done.id, checksum: done.checksum } });
      assert.equal((await inspected.json() as { bytes: number }).bytes, bytes.length);
    } finally { await pgBlobs.close(); }
  });
});
