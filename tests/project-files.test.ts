// SPDX-License-Identifier: MPL-2.0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { runRetention } from '../server/src/audit/retention.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import type { Store } from '../server/src/store/types.ts';
import {
  fileChecksum, filePartBlobId, PROJECT_FILE_IDLE_MS, PROJECT_FILE_OVERHEAD_BYTES, PROJECT_FILE_PART_BYTES, PROJECT_FILE_SWEEP_GRACE_MS, projectFileInput,
  scheduleProjectFileSweep, type ProjectFilePolicy, type ProjectFileRecord,
} from '../server/src/projects/files.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { mintRenderRead } from '../server/src/render/read-ticket.ts';

const pgUrl = process.env.LW_TEST_DATABASE_URL;
const HOUR = 60 * 60 * 1000;
/** What each file costs a budget beyond its bytes. */
const R = PROJECT_FILE_OVERHEAD_BYTES;
const PEOPLE = ['alice', 'editor', 'editor2', 'manager', 'viewer', 'outside', 'root'];

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });

/** Shared files are off on the memory store, which forgets uploads with the
 *  process. These route tests use its behaviour under a durable label; the
 *  gated Postgres tests below run the real drivers. */
const durable = (store: Store): Store => Object.assign(store, { storageKind: 'postgres' as const });

async function listen(handler: ReturnType<typeof buildApp>): Promise<string> {
  const server = createServer(handler);
  servers.push(server);
  await new Promise<void>(r => server.listen(0, '127.0.0.1', () => r()));
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

async function boot(opts: { policy?: Partial<ProjectFilePolicy>; store?: Store; blobs?: BlobStore } = {}) {
  const store = opts.store ?? durable(createMemoryStore()), blobs = opts.blobs ?? createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, policy: { projectFiles: opts.policy ?? {} }, dev: { enabled: true,
    users: PEOPLE.map(name => ({ email: `${name}@test`, name, groups: name === 'root' ? ['owner'] : [] })) } }));
  const app = () => buildApp({ config, store, blobs, secrets: { session: 'file-session', link: 'file-link' } });
  const base = await listen(app());
  const cookies = new Map<string, string>();
  for (const name of PEOPLE) {
    const r = await fetch(`${base}/api/auth/dev?email=${name}@test`, { redirect: 'manual' });
    cookies.set(name, r.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!);
  }
  const caller = (origin: string) => (name: string, method: string, path: string, body?: unknown) => fetch(origin + path, {
    method, headers: { cookie: cookies.get(name) ?? '', ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const call = caller(base);
  const userId = async (name: string) => (await store.findUsersByEmail(`${name}@test`))[0]!.id;
  const newProject = async (name: string) => {
    const project = await (await call('alice', 'POST', '/api/v1/projects', { name, visibility: 'private' })).json() as { id: string };
    for (const [who, role] of [['editor', 'editor'], ['editor2', 'editor'], ['manager', 'manager'], ['viewer', 'viewer']] as const) {
      await store.putProjectMember({ projectId: project.id, userId: await userId(who), role, addedBy: 'alice', addedAt: new Date().toISOString() });
    }
    return project.id;
  };
  const projectId = await newProject('Shared uploads');
  /** Begin, send every part and finalize; returns the ready record. */
  const upload = async (who: string, bytes: Uint8Array, project = projectId, finalize = true) => {
    const begun = await call(who, 'POST', `/api/v1/projects/${project}/files`, metadata(bytes));
    assert.equal(begun.status, 201, await begun.clone().text());
    const { file } = await begun.json() as { file: ProjectFileRecord };
    for (let n = 0; n < file.parts.length; n++) {
      const sent = await call(who, 'PUT', `/api/v1/projects/${project}/files/${file.id}/parts/${n}`, bytes.subarray(n * PROJECT_FILE_PART_BYTES, (n + 1) * PROJECT_FILE_PART_BYTES));
      assert.equal(sent.status, 204);
    }
    if (finalize) assert.equal((await call(who, 'POST', `/api/v1/projects/${project}/files/${file.id}/finalize`, {})).status, 200);
    return file;
  };
  return { store, blobs, base, call, caller, app, config, cookies, projectId, newProject, upload, userId };
}
function metadata(bytes: Uint8Array, name = 'cover.png') {
  const parts = [];
  for (let n = 0; n < bytes.length; n += PROJECT_FILE_PART_BYTES) {
    const part = bytes.subarray(n, n + PROJECT_FILE_PART_BYTES);
    parts.push({ size: part.length, checksum: fileChecksum(part) });
  }
  return { name, contentType: 'image/png', size: bytes.length, checksum: fileChecksum(bytes), parts, asset: { type: 'raster', format: 'png' } };
}
const errorOf = async (r: Response) => ((await r.json()) as { error: { code: string; message: string; sessions?: unknown } }).error;
/** A record written straight to the store, for states the routes never make. */
const record = (id: string, projectId: string, createdBy: string, size: number, expiresAt: number): ProjectFileRecord => ({
  id, projectId, name: `${id}.png`, size, checksum: 'c'.repeat(64), contentType: 'image/png',
  parts: Array.from({ length: Math.ceil(size / PROJECT_FILE_PART_BYTES) }, (_, n) => ({ size: Math.min(PROJECT_FILE_PART_BYTES, size - n * PROJECT_FILE_PART_BYTES), checksum: 'c'.repeat(64) })),
  asset: {}, createdBy, createdAt: new Date(expiresAt - 24 * HOUR).toISOString(), expiresAt: new Date(expiresAt).toISOString(), ready: false,
});
const roomy = { projectBudgetBytes: 1e9, instanceBudgetBytes: 1e9, maxPending: 99, maxPendingBytes: 1e9 };

test('shared files survive a new HTTP app, and every route checks project membership', async () => {
  const { store, blobs, call, caller, app, projectId } = await boot();
  const root = `/api/v1/projects/${projectId}/files`;
  const bytes = new Uint8Array(PROJECT_FILE_PART_BYTES + 11).fill(17);
  assert.equal((await call('viewer', 'POST', root, metadata(bytes))).status, 403);
  assert.equal((await call('outside', 'GET', root)).status, 403);
  assert.equal((await call('', 'GET', root)).status, 401);
  const begun = await call('editor', 'POST', root, metadata(bytes));
  assert.equal(begun.status, 201);
  const { file } = await begun.json() as { file: ProjectFileRecord };
  const path = `${root}/${file.id}`;
  assert.equal((await call('viewer', 'GET', path)).status, 404);
  assert.equal((await call('editor', 'POST', `${path}/finalize`, {})).status, 409);
  assert.equal((await call('alice', 'PUT', `${path}/parts/0`, bytes.subarray(0, PROJECT_FILE_PART_BYTES))).status, 403);
  assert.equal((await call('editor', 'PUT', `${path}/parts/0`, new Uint8Array(PROJECT_FILE_PART_BYTES))).status, 422);
  assert.equal((await call('editor', 'PUT', `${path}/parts/2`, new Uint8Array(1))).status, 400);
  for (let n = 0; n < 2; n++) assert.equal((await call('editor', 'PUT', `${path}/parts/${n}`, bytes.subarray(n * PROJECT_FILE_PART_BYTES, (n + 1) * PROJECT_FILE_PART_BYTES))).status, 204);
  assert.equal((await call('editor', 'POST', `${path}/finalize`, {})).status, 200);
  assert.equal((await call('editor', 'POST', `${path}/finalize`, {})).status, 200);
  const ready = await call('editor', 'PUT', `${path}/parts/0`, bytes.subarray(0, PROJECT_FILE_PART_BYTES));
  assert.equal(ready.status, 409);
  assert.equal((await errorOf(ready)).code, 'FILE_READY');
  const read = await call('viewer', 'GET', path);
  assert.equal(read.status, 200);
  assert.match(read.headers.get('content-disposition')!, /^attachment/);
  assert.equal(read.headers.get('cache-control'), 'private, no-store');
  assert.deepEqual(new Uint8Array(await read.arrayBuffer()), bytes);
  assert.equal((await call('outside', 'GET', path)).status, 403);
  const viewer = (await store.findUsersByEmail('viewer@test'))[0]!;
  await store.deleteProjectMember(projectId, viewer.id);
  assert.equal((await call('viewer', 'GET', path)).status, 403);
  const reread = await caller(await listen(app()))('editor', 'GET', path);
  assert.deepEqual(new Uint8Array(await reread.arrayBuffer()), bytes);
  assert.equal((await store.getProjectFile(file.id))?.ready, true);
  assert.equal((await blobs.head(`project-file/${file.id}/0`))?.size, PROJECT_FILE_PART_BYTES);
});

test('metadata rejects oversized files, invalid parts and unsafe response headers', () => {
  const good = metadata(new Uint8Array([1, 2, 3]));
  assert.ok(projectFileInput(good));
  for (const bad of [{ ...good, size: 257 * 1024 * 1024 }, { ...good, name: 'x\r\ny' }, { ...good, contentType: 'image/png\r\nX: y' },
    { ...good, parts: [] }, { ...good, parts: [{ size: 2, checksum: good.checksum }] }, { ...good, checksum: 'oops' },
    // one part is the whole file, so its digest must be the file's
    { ...good, checksum: 'd'.repeat(64) }]) assert.equal(projectFileInput(bad), null);
});

test('policy.projectFiles: defaults sized for a small Postgres, validated at startup', () => {
  const MIB = 1024 * 1024;
  const files = (projectFiles?: unknown) => parseConfig(JSON.stringify({ dev: { enabled: true }, policy: { projectFiles } })).policy.projectFiles;
  assert.deepEqual(files(),
    { enabled: true, maxFileBytes: 25 * MIB, projectBudgetBytes: 128 * MIB, instanceBudgetBytes: 256 * MIB, uploadTtlHours: 24 });
  assert.deepEqual(files({ enabled: false, uploadTtlHours: 2 }),
    { enabled: false, maxFileBytes: 25 * MIB, projectBudgetBytes: 128 * MIB, instanceBudgetBytes: 256 * MIB, uploadTtlHours: 2 }, 'a partial block keeps the other defaults');
  assert.equal(files({ maxFileBytes: 256 * MIB, projectBudgetBytes: 256 * MIB }).maxFileBytes, 256 * MIB, 'the migration ceiling itself is allowed');
  for (const [bad, message] of [
    [false, /must be an object/], [{ enabled: 'yes' }, /enabled must be true or false/],
    [{ maxFileBytes: 0 }, /maxFileBytes/], [{ maxFileBytes: 1.5 }, /maxFileBytes/], [{ maxFileBytes: '10' }, /maxFileBytes/],
    [{ uploadTtlHours: -1 }, /uploadTtlHours/], [{ uploadTtlHours: 721 }, /uploadTtlHours/],
    [{ maxFileBytes: 256 * MIB + 1, projectBudgetBytes: 512 * MIB, instanceBudgetBytes: 512 * MIB }, /cannot exceed/],
    [{ maxFileBytes: 200 * MIB }, /maxFileBytes <= projectBudgetBytes <= instanceBudgetBytes/],
    [{ projectBudgetBytes: 300 * MIB }, /maxFileBytes <= projectBudgetBytes <= instanceBudgetBytes/],
  ] as const) assert.throws(() => files(bad), message, JSON.stringify(bad));
});

test('finalize trusts stored digests and a running digest, reads parts back otherwise, and refuses a lying file digest', async () => {
  const { blobs, call, caller, app, projectId, upload } = await boot();
  const root = `/api/v1/projects/${projectId}/files`;
  const bytes = new Uint8Array(2 * PROJECT_FILE_PART_BYTES + 5).map((_, i) => i % 251);
  // Parts through one app, finalize through another with no running digest:
  // the parts are read back and the whole file still verifies.
  const file = await upload('editor', bytes, projectId, false);
  const other = caller(await listen(app()));
  assert.equal((await other('editor', 'POST', `${root}/${file.id}/finalize`, {})).status, 200);
  // Valid parts under a whole-file digest they do not make: refused with and
  // without the running digest.
  for (const finalizer of [call, other]) {
    const lie = { ...metadata(bytes), checksum: 'e'.repeat(64) };
    const { file: liar } = await (await call('editor', 'POST', root, lie)).json() as { file: ProjectFileRecord };
    for (let n = 0; n < 3; n++) await call('editor', 'PUT', `${root}/${liar.id}/parts/${n}`, bytes.subarray(n * PROJECT_FILE_PART_BYTES, (n + 1) * PROJECT_FILE_PART_BYTES));
    const refused = await finalizer('editor', 'POST', `${root}/${liar.id}/finalize`, {});
    assert.equal(refused.status, 422);
    assert.equal((await errorOf(refused)).message, 'file failed verification');
  }
  // A stored part that changed after its PUT fails on its stat alone.
  const changed = await upload('editor', new Uint8Array([9, 8, 7]), projectId, false);
  await blobs.put(filePartBlobId(changed, 0), new Uint8Array([9, 8, 6]), 'application/octet-stream');
  assert.equal((await call('editor', 'POST', `${root}/${changed.id}/finalize`, {})).status, 422);
});

test('files are off, with 404s and a false org-config bit, on a memory store or when policy says so', async () => {
  for (const off of [await boot({ store: createMemoryStore() }), await boot({ policy: { enabled: false } })]) {
    const oc = await (await off.call('editor', 'GET', '/api/v1/org-config')).json() as { sharing: { projectFiles: boolean } };
    assert.equal(oc.sharing.projectFiles, false);
    const root = `/api/v1/projects/${off.projectId}/files`;
    for (const [method, path, body] of [['GET', root, undefined], ['POST', root, metadata(new Uint8Array([1]))], ['GET', `${root}/fil_x`, undefined],
      ['PUT', `${root}/fil_x/parts/0`, new Uint8Array([1])], ['POST', `${root}/fil_x/finalize`, {}], ['DELETE', `${root}/fil_x`, undefined]] as const) {
      const r = await off.call('editor', method, path, body);
      assert.equal(r.status, 404, `${method} ${path}`);
      assert.deepEqual(await errorOf(r), { code: 'NOT_FOUND', message: 'project files are off' });
    }
  }
  const on = await boot();
  assert.equal((await (await on.call('viewer', 'GET', '/api/v1/org-config')).json() as { sharing: { projectFiles: boolean } }).sharing.projectFiles, true);
});

test('the list shows ready files newest first with trimmed rows, names and the budgets', async () => {
  const { call, projectId, upload } = await boot({ policy: { maxFileBytes: 8 * PROJECT_FILE_PART_BYTES } });
  const first = await upload('editor', new Uint8Array([1, 2, 3]));
  const second = await upload('alice', new Uint8Array(PROJECT_FILE_PART_BYTES + 1).fill(4));
  await upload('editor', new Uint8Array([5, 6]), projectId, false);
  const listed = await call('viewer', 'GET', `/api/v1/projects/${projectId}/files`);
  assert.equal(listed.status, 200);
  assert.equal(listed.headers.get('cache-control'), 'private, no-store');
  const body = await listed.json() as { files: Array<Record<string, unknown>>; limits: Record<string, number> };
  assert.deepEqual(body.files.map(f => f.id), [second.id, first.id], 'ready only, newest first');
  assert.deepEqual(Object.keys(body.files[1]!).sort(),
    ['asset', 'checksum', 'contentType', 'createdAt', 'createdBy', 'createdByName', 'id', 'name', 'projectId', 'ready', 'size']);
  assert.equal(body.files[1]!.createdByName, 'editor');
  assert.equal(body.files[1]!.ready, true);
  assert.deepEqual(body.limits, {
    partBytes: PROJECT_FILE_PART_BYTES, maxBytes: 8 * PROJECT_FILE_PART_BYTES, projectBudgetBytes: 128 * 1024 * 1024,
    projectUsedBytes: 3 + PROJECT_FILE_PART_BYTES + 1 + 2 + 3 * R, instanceRemainingBytes: 256 * 1024 * 1024 - (3 + PROJECT_FILE_PART_BYTES + 1 + 2 + 3 * R),
  }, 'an unfinished upload holds its reservation; each file costs R more than its bytes');
});

test('begin enforces the file cap, both budgets and the pending limits; expired uploads count for nothing', async () => {
  // Room for two largest files in a project and three in the instance, each
  // counted with its overhead.
  const { store, call, projectId, newProject, userId } = await boot({ policy: { maxFileBytes: 4096, projectBudgetBytes: 2 * (4096 + R), instanceBudgetBytes: 3 * (4096 + R) } });
  const begin = (project: string, size: number, who = 'editor') => call(who, 'POST', `/api/v1/projects/${project}/files`, metadata(new Uint8Array(size).fill(size % 255)));
  const code = async (r: Response) => [r.status, r.status >= 400 ? (await errorOf(r)).code : 'ok'];
  // An expired upload larger than every budget changes nothing.
  assert.equal(await store.reserveProjectFile(record('fil_expired', projectId, await userId('editor'), 100_000, Date.now() - 1000), roomy), 'reserved');
  assert.deepEqual(await code(await begin(projectId, 4097)), [413, 'PROJECT_FILE_TOO_LARGE']);
  assert.deepEqual(await code(await begin(projectId, 4096)), [201, 'ok']);
  assert.deepEqual(await code(await begin(projectId, 4095, 'editor2')), [201, 'ok']);
  assert.deepEqual(await code(await begin(projectId, 2, 'manager')), [413, 'PROJECT_FILE_BUDGET']);
  const second = await newProject('Second');
  assert.deepEqual(await code(await begin(second, 4096, 'alice')), [201, 'ok']);
  assert.deepEqual(await code(await begin(second, 2)), [413, 'INSTANCE_FILE_BUDGET'], 'the instance budget spans projects');
  const limits = (await (await call('editor', 'GET', `/api/v1/projects/${second}/files`)).json() as { limits: Record<string, number> }).limits;
  assert.equal(limits.projectUsedBytes, 4096 + R);
  assert.equal(limits.instanceRemainingBytes, 1);

  // Sixteen unfinished uploads per person; expired ones do not count.
  const pending = await boot();
  const editor = await pending.userId('editor');
  for (let n = 0; n < 4; n++) assert.equal(await pending.store.reserveProjectFile(record(`fil_old${n}`, pending.projectId, editor, 1, Date.now() - 1000), roomy), 'reserved');
  for (let n = 0; n < 16; n++) assert.equal((await pending.call('editor', 'POST', `/api/v1/projects/${pending.projectId}/files`, metadata(new Uint8Array([n])))).status, 201);
  const refused = await pending.call('editor', 'POST', `/api/v1/projects/${pending.projectId}/files`, metadata(new Uint8Array([99])));
  assert.deepEqual([refused.status, (await errorOf(refused)).code], [413, 'PROJECT_FILE_PENDING']);
  assert.equal((await pending.call('editor2', 'POST', `/api/v1/projects/${pending.projectId}/files`, metadata(new Uint8Array([99])))).status, 201, 'per person');
});

test('delete: the uploader or a manager; a file in use needs ?force=1 from a manager; audited', async () => {
  const { store, blobs, call, projectId, upload } = await boot();
  const root = `/api/v1/projects/${projectId}/files`;
  const used = await upload('editor', new Uint8Array(PROJECT_FILE_PART_BYTES + 3).fill(1));
  const unused = await upload('editor', new Uint8Array([2]));
  const now = new Date().toISOString();
  const session = { projectId, toolId: 'poster', toolVersion: '1.0.0', meta: { label: 'Spring poster' }, createdBy: used.createdBy, updatedBy: used.createdBy, rev: 1, updatedAt: now };
  await store.putSession({ ...session, id: 'ses_uses', inputs: { image: `user/team/${used.id}` } });
  await store.putSession({ ...session, id: 'ses_gone', inputs: { image: `user/team/${used.id}` }, deletedAt: now });
  // A near-miss id is no match.
  await store.putSession({ ...session, id: 'ses_plain', inputs: { image: `user/team/${unused.id.slice(0, -1)}` }, meta: {} });

  for (const who of ['viewer', 'editor2', 'outside']) assert.equal((await call(who, 'DELETE', `${root}/${used.id}`)).status, 403, who);
  assert.equal((await call('', 'DELETE', `${root}/${used.id}`)).status, 401);
  assert.equal((await call('editor', 'DELETE', `${root}/fil_nope`)).status, 404);
  for (const [who, query] of [['editor', ''], ['editor', '?force=1'], ['manager', '']] as const) {
    const busy = await call(who, 'DELETE', `${root}/${used.id}${query}`);
    assert.equal(busy.status, 409, `${who}${query}`);
    assert.deepEqual(await errorOf(busy), { code: 'FILE_IN_USE', message: '1 session(s) in this project use this file', sessions: [{ id: 'ses_uses', title: 'Spring poster' }] });
  }
  assert.equal((await call('manager', 'DELETE', `${root}/${used.id}?force=1`)).status, 204);
  assert.equal(await store.getProjectFile(used.id), null);
  assert.equal(await blobs.head(filePartBlobId(used, 0)), null);
  assert.equal(await blobs.head(filePartBlobId(used, 1)), null);
  assert.equal((await call('viewer', 'GET', `${root}/${used.id}`)).status, 404);
  // A project owner deletes anyone's unused file.
  assert.equal((await call('alice', 'DELETE', `${root}/${unused.id}`)).status, 204);
  // Cancelling an unfinished upload is the uploader's delete.
  const half = await upload('editor2', new Uint8Array([3, 4]), projectId, false);
  assert.equal((await call('editor', 'DELETE', `${root}/${half.id}`)).status, 403);
  assert.equal((await call('editor2', 'DELETE', `${root}/${half.id}`)).status, 204);
  assert.equal(await store.getProjectFile(half.id), null);
  assert.equal(await blobs.head(filePartBlobId(half, 0)), null);
  assert.equal((await call('editor2', 'PUT', `${root}/${half.id}/parts/0`, new Uint8Array([3, 4]))).status, 404);

  const deletes = (await store.listAudit()).filter(e => e.action === 'project.file-delete');
  assert.deepEqual(deletes.map(e => [e.subject, e.payload?.fileId, e.payload?.forced ?? false]),
    [[`project:${projectId}`, used.id, true], [`project:${projectId}`, unused.id, false], [`project:${projectId}`, half.id, false]]);
  assert.deepEqual(deletes[0]!.payload?.sessions, ['ses_uses']);
});

test('expired uploads are swept, parts first, before a new upload and by the retention run', async () => {
  const { store, blobs, call, config, projectId, userId } = await boot();
  const editor = await userId('editor');
  const put = async (file: ProjectFileRecord) => {
    assert.equal(await store.reserveProjectFile(file, roomy), 'reserved');
    for (let n = 0; n < file.parts.length; n++) await blobs.put(filePartBlobId(file, n), new Uint8Array([n]), 'application/octet-stream');
  };
  const old = record('fil_old', projectId, editor, PROJECT_FILE_PART_BYTES + 1, Date.now() - PROJECT_FILE_SWEEP_GRACE_MS - 1000);
  const recent = record('fil_recent', projectId, editor, 1, Date.now() - 1000);
  await put(old); await put(recent);
  assert.equal((await call('editor2', 'POST', `/api/v1/projects/${projectId}/files`, metadata(new Uint8Array([1])))).status, 201);
  assert.equal(await store.getProjectFile(old.id), null, 'past the grace period: swept');
  assert.equal(await blobs.head(filePartBlobId(old, 1)), null);
  assert.ok(await store.getProjectFile(recent.id), 'inside the grace period: kept');
  // Past the grace period, the retention run takes the other one; the new
  // upload, which expires PROJECT_FILE_IDLE_MS after its begin, is not yet
  // past its own grace.
  const later = await runRetention({ config, store, blobs, now: () => new Date(Date.now() + PROJECT_FILE_SWEEP_GRACE_MS + 5 * 60_000) });
  assert.deepEqual(later, { telemetryTrimmed: 0, auditTrimmed: 0, projectFilesSwept: 1 });
  assert.equal(await store.getProjectFile(recent.id), null);
  assert.equal(await blobs.head(filePartBlobId(recent, 0)), null);
  assert.equal((await store.listUnfinishedProjectFiles({}, 10)).length, 1, 'the live upload stays');
  const run = await call('root', 'POST', '/api/v1/retention/run');
  assert.equal(run.status, 200);
  assert.deepEqual(await run.json(), { telemetryTrimmed: 0, auditTrimmed: 0, projectFilesSwept: 0 });
});

test('a file keeps only the asset fields the shell sends, and tiny files still fill the budgets', async () => {
  const bytes = new Uint8Array([1, 2, 3]);
  let deep: Record<string, unknown> = {};
  for (let n = 0; n < 4000; n++) deep = { deep };
  const asset = { type: 'raster', format: 'png', width: 640, height: 480, meta: { name: 'Cover', note: 'x'.repeat(1000) },
    credential: Array.from({ length: 50_000 }, (_, n) => n % 256), credentialFormat: 'application/c2pa', deep, extra: 'y'.repeat(100_000) };
  const kept = { type: 'raster', format: 'png', width: 640, height: 480, meta: { name: 'Cover' } };
  assert.deepEqual(projectFileInput({ ...metadata(bytes), asset })?.asset, kept);
  for (const bad of [{ type: 7, format: 'x'.repeat(65), width: -1, height: Infinity, meta: { name: 'half \ud83d' } }, [1], 'png', null]) {
    assert.deepEqual(projectFileInput({ ...metadata(bytes), asset: bad })?.asset, {}, JSON.stringify(bad));
  }
  assert.equal(projectFileInput({ ...metadata(bytes), name: 'half \ud83d' }), null, 'half an emoji');

  // Over HTTP: each 1-byte file costs its overhead, so a budget for three
  // takes three; a deep or bulky asset is dropped and the list still reads.
  const { call, projectId } = await boot({ policy: { maxFileBytes: 1024, projectBudgetBytes: 3 * (1 + R), instanceBudgetBytes: 3 * (1 + R) } });
  const root = `/api/v1/projects/${projectId}/files`;
  for (let n = 0; n < 4; n++) {
    const one = new Uint8Array([n]);
    const begun = await call('editor', 'POST', root, { ...metadata(one), asset });
    if (n === 3) { assert.deepEqual([begun.status, (await errorOf(begun)).code], [413, 'PROJECT_FILE_BUDGET']); break; }
    assert.equal(begun.status, 201);
    const { file } = await begun.json() as { file: ProjectFileRecord };
    assert.deepEqual(file.asset, kept);
    assert.equal((await call('editor', 'PUT', `${root}/${file.id}/parts/0`, one)).status, 204);
    assert.equal((await call('editor', 'POST', `${root}/${file.id}/finalize`, {})).status, 200);
  }
  const listed = await call('viewer', 'GET', root);
  assert.equal(listed.status, 200);
  const body = await listed.json() as { files: Array<{ asset: unknown }>; limits: { projectUsedBytes: number } };
  assert.deepEqual(body.files.map(f => f.asset), [kept, kept, kept]);
  assert.equal(body.limits.projectUsedBytes, 3 * (1 + R));
});

test('one person reserves at most two largest files at once; an abandoned upload expires after minutes, and each part keeps it alive', async () => {
  const { store, call, projectId, userId } = await boot({ policy: { maxFileBytes: 4096, uploadTtlHours: 1 } });
  const root = `/api/v1/projects/${projectId}/files`;
  const begin = (size: number, who = 'editor') => call(who, 'POST', root, metadata(new Uint8Array(size).fill(size % 255)));
  const first = await begin(4096);
  assert.equal(first.status, 201);
  const { file } = await first.json() as { file: ProjectFileRecord };
  assert.equal(Date.parse(file.expiresAt) - Date.parse(file.createdAt), PROJECT_FILE_IDLE_MS, 'a begin holds its room for the idle time');
  assert.equal((await begin(4096)).status, 201);
  const third = await begin(1);
  assert.deepEqual([third.status, (await errorOf(third)).code], [413, 'PROJECT_FILE_PENDING']);
  assert.equal((await begin(4096, 'editor2')).status, 201, 'per person');
  assert.equal((await call('editor', 'DELETE', `${root}/${file.id}`)).status, 204, 'a cancel frees the room');
  assert.equal((await begin(1)).status, 201);

  // An accepted part moves the expiry out to the idle time from now, but
  // never past uploadTtlHours after the begin.
  const editor = await userId('editor');
  const bytes = new Uint8Array([7, 7, 7]);
  for (const [id, startedAgo] of [['fil_idle', 10 * 60_000], ['fil_late', 55 * 60_000]] as const) {
    const createdAt = new Date(Date.now() - startedAgo).toISOString();
    assert.equal(await store.reserveProjectFile({ ...metadata(bytes), asset: {}, id, projectId, createdBy: editor, createdAt,
      expiresAt: new Date(Date.now() + 60_000).toISOString(), ready: false }, roomy), 'reserved');
    const before = Date.now();
    assert.equal((await call('editor', 'PUT', `${root}/${id}/parts/0`, bytes)).status, 204);
    const expires = Date.parse((await store.getProjectFile(id))!.expiresAt);
    if (id === 'fil_idle') assert.ok(expires >= before + PROJECT_FILE_IDLE_MS && expires <= Date.now() + PROJECT_FILE_IDLE_MS, 'the idle time from the part');
    else assert.equal(expires, Date.parse(createdAt) + HOUR, 'capped at uploadTtlHours');
  }
});

test("a cancel racing the uploader's own part leaves no part behind", async () => {
  // Part writes and deletes the test can hold, standing in for database round trips.
  const inner = createMemoryBlobStore();
  const held = new Map<string, { reached: () => void; go: Promise<void> }>();
  const hold = (op: 'put' | 'delete', id: string) => {
    let reached!: () => void, go!: () => void;
    const arrived = new Promise<void>(r => { reached = r; });
    held.set(`${op} ${id}`, { reached, go: new Promise<void>(r => { go = r; }) });
    return { arrived, go };
  };
  const pause = async (key: string) => {
    const h = held.get(key);
    if (h) { held.delete(key); h.reached(); await h.go; }
  };
  const blobs: BlobStore = { ...inner,
    put: async (id, body, type) => { await pause(`put ${id}`); return inner.put(id, body, type); },
    delete: async (id) => { await pause(`delete ${id}`); return inner.delete(id); } };
  const { call, projectId } = await boot({ blobs });
  const root = `/api/v1/projects/${projectId}/files`;
  const bytes = new Uint8Array(PROJECT_FILE_PART_BYTES + 1).fill(5);
  const part0 = bytes.subarray(0, PROJECT_FILE_PART_BYTES);
  const begin = async () => (await (await call('editor', 'POST', root, metadata(bytes))).json() as { file: ProjectFileRecord }).file;

  // The part is written after the cancel's first pass and finds the row still there.
  const early = await begin();
  const first = hold('delete', filePartBlobId(early, 1));
  const cancel = call('editor', 'DELETE', `${root}/${early.id}`);
  await first.arrived;
  assert.equal((await call('editor', 'PUT', `${root}/${early.id}/parts/0`, part0)).status, 204);
  first.go();
  assert.equal((await cancel).status, 204);
  assert.equal(await inner.head(filePartBlobId(early, 0)), null, 'the second pass took it');

  // The part is written after the row went: the PUT takes back its own part.
  const late = await begin();
  const write = hold('put', filePartBlobId(late, 0));
  const put = call('editor', 'PUT', `${root}/${late.id}/parts/0`, part0);
  await write.arrived;
  assert.equal((await call('editor', 'DELETE', `${root}/${late.id}`)).status, 204);
  write.go();
  const refused = await put;
  assert.deepEqual([refused.status, (await errorOf(refused)).code], [410, 'UPLOAD_EXPIRED']);
  assert.equal(await inner.head(filePartBlobId(late, 0)), null);
});

test('a service token gets a clean refusal from every file route', async () => {
  const { base, call, projectId } = await boot();
  const minted = await call('root', 'POST', '/api/v1/tokens', { label: 'Files', role: 'admin' });
  assert.equal(minted.status, 201);
  const { token } = await minted.json() as { token: string };
  const root = `${base}/api/v1/projects/${projectId}/files`;
  const bearer = (method: string, url: string, body?: unknown) => fetch(url, { method,
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const begun = await bearer('POST', root, metadata(new Uint8Array([1])));
  assert.equal(begun.status, 403);
  assert.deepEqual(await errorOf(begun), { code: 'FORBIDDEN', message: 'project files need a signed-in person' });
  for (const [method, url] of [['GET', root], ['GET', `${root}/fil_x`], ['DELETE', `${root}/fil_x`]] as const) {
    assert.equal((await bearer(method, url)).status, 401, `${method} ${url}`);
  }
});

test('downloads stop for the day at twice the instance budget per person', async () => {
  const { call, projectId, upload } = await boot({ policy: { maxFileBytes: 8192, projectBudgetBytes: 16384, instanceBudgetBytes: 16384 } });
  const file = await upload('editor', new Uint8Array(8000).fill(3));
  const path = `/api/v1/projects/${projectId}/files/${file.id}`;
  for (let n = 0; n < 4; n++) assert.equal((await call('viewer', 'GET', path)).status, 200, `download ${n}`);
  const stopped = await call('viewer', 'GET', path);
  assert.deepEqual([stopped.status, (await errorOf(stopped)).code], [429, 'RATE_LIMITED']);
  const wait = Number(stopped.headers.get('retry-after'));
  assert.ok(wait > 0 && wait <= 24 * 60 * 60, String(wait));
  assert.equal((await call('editor', 'GET', path)).status, 200, 'per person');
});

test('advisory lock keys are distinct, so a file reservation never waits on a migration', async () => {
  const { readFile, readdir } = await import('node:fs/promises');
  const src = new URL('../server/src/', import.meta.url);
  const files = [...(await readdir(src, { recursive: true })).filter(f => f.endsWith('.ts')).map(f => new URL(f, src)),
    new URL('./pg-test-schema.ts', import.meta.url)];
  const keys = new Map<string, number>();
  for (const file of files) {
    for (const m of (await readFile(file, 'utf8')).matchAll(/const (\w+_LOCK_KEY) = (0x[\da-f_]+);/gi)) keys.set(m[1]!, Number(m[2]!.replace(/_/g, '')));
  }
  assert.ok(keys.has('PROJECT_FILES_LOCK_KEY') && keys.has('MIGRATE_LOCK_KEY'), [...keys.keys()].join());
  assert.equal(new Set(keys.values()).size, keys.size, JSON.stringify([...keys]));
  // The old migration runner's session lock, which a pooler may still hold.
  assert.ok(![...keys.values()].includes(0x1011_0002));
});

test('account erasure: a ready file blocks it, unfinished uploads are removed first', async () => {
  const { store, blobs, call, projectId, upload, userId } = await boot();
  await upload('editor', new Uint8Array([1]));
  const editor = await userId('editor');
  const preview = await (await call('root', 'GET', `/api/v1/users/${editor}/erasure-preview`)).json() as { references: Record<string, number>; blocked: boolean };
  assert.equal(preview.references.projectFiles, 1);
  assert.equal(preview.blocked, true);
  const refused = await call('root', 'DELETE', `/api/v1/users/${editor}`);
  assert.deepEqual([refused.status, (await errorOf(refused)).code], [409, 'ERASE_REFERENCED']);
  assert.ok(await store.getUser(editor));

  const half = await upload('editor2', new Uint8Array([2, 3]), projectId, false);
  const editor2 = await userId('editor2');
  assert.equal((await call('root', 'DELETE', `/api/v1/users/${editor2}`)).status, 200);
  assert.equal(await store.getUser(editor2), null);
  assert.equal(await store.getProjectFile(half.id), null);
  assert.equal(await blobs.head(filePartBlobId(half, 0)), null);
});

test('Postgres: parallel reservations in two projects never pass the instance budget', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async (store) => {
    const owner = await store.upsertUserBySub({ sub: 'files-race', email: 'files-race@example.invalid', groups: [], role: 'member' });
    const at = new Date().toISOString();
    for (const id of ['prj_race1', 'prj_race2']) await store.putProject({ id, name: id, visibility: 'private', ownerId: owner.id, createdAt: at });
    // Only the instance budget binds: each project alone could take them all.
    const limits = { projectBudgetBytes: 50 * (100 + R), instanceBudgetBytes: 10 * (100 + R), maxPending: 99, maxPendingBytes: 1e9 };
    // Each call takes its own pool client; 24 files of 100 bytes against room for 10.
    const outcomes = await Promise.all(Array.from({ length: 24 }, (_, n) =>
      store.reserveProjectFile(record(`fil_race${n}`, n % 2 ? 'prj_race2' : 'prj_race1', owner.id, 100, Date.now() + HOUR), limits)));
    assert.equal(outcomes.filter(o => o === 'reserved').length, 10);
    assert.equal(outcomes.filter(o => o === 'instance-budget').length, 14);
    assert.deepEqual((await store.projectFileUsage('prj_race1')).instanceBytes, 10 * (100 + R));
    // The pending limit holds under the same race.
    const pending = await Promise.all(Array.from({ length: 12 }, (_, n) =>
      store.reserveProjectFile(record(`fil_pend${n}`, 'prj_race1', owner.id, 1, Date.now() + HOUR), { ...limits, instanceBudgetBytes: 1e9, projectBudgetBytes: 1e9, maxPending: 14 })));
    assert.equal(pending.filter(o => o === 'reserved').length, 4);
  });
});

test('Postgres: the routes end to end on the real drivers', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async (pgStore) => {
    const { createPostgresBlobStore } = await import('../server/src/blobs/postgres.ts');
    const pgBlobs = await createPostgresBlobStore(pgUrl!);
    try {
      const { call, projectId, upload } = await boot({ store: pgStore, blobs: pgBlobs });
      assert.equal((await (await call('editor', 'GET', '/api/v1/org-config')).json() as { sharing: { projectFiles: boolean } }).sharing.projectFiles, true);
      const bytes = new Uint8Array(PROJECT_FILE_PART_BYTES * 2 + 7).map((_, i) => (i * 7) % 256);
      const file = await upload('editor', bytes);
      const small = await upload('alice', new Uint8Array([1, 2, 3]));
      const root = `/api/v1/projects/${projectId}/files`;
      const listed = await (await call('viewer', 'GET', root)).json() as { files: Array<{ id: string }>; limits: { projectUsedBytes: number } };
      assert.deepEqual(listed.files.map(f => f.id), [small.id, file.id]);
      assert.equal(listed.limits.projectUsedBytes, bytes.length + 3 + 2 * R);
      assert.deepEqual(new Uint8Array(await (await call('viewer', 'GET', `${root}/${file.id}`)).arrayBuffer()), bytes);
      await pgStore.putSession({ id: 'ses_pg', projectId, toolId: 'poster', toolVersion: '1', inputs: { a: [{ b: `user/team/${file.id}` }] }, meta: {},
        createdBy: file.createdBy, updatedBy: file.createdBy, rev: 1, updatedAt: new Date().toISOString() });
      assert.equal((await call('editor', 'DELETE', `${root}/${file.id}`)).status, 409);
      assert.equal((await call('alice', 'DELETE', `${root}/${file.id}?force=1`)).status, 204);
      assert.equal(await pgBlobs.head(filePartBlobId(file, 2)), null);
      assert.deepEqual((await (await call('viewer', 'GET', root)).json() as { files: Array<{ id: string }> }).files.map(f => f.id), [small.id]);
    } finally { await pgBlobs.close(); }
  });
});

test('the long-lived server sweeps expired uploads at boot and on its timer, and logs a failed pass', async () => {
  const { store, blobs, projectId, userId } = await boot();
  const editor = await userId('editor');
  const expired = (id: string) => record(id, projectId, editor, 1, Date.now() - PROJECT_FILE_SWEEP_GRACE_MS - 1000);
  const put = async (file: ProjectFileRecord) => {
    assert.equal(await store.reserveProjectFile(file, roomy), 'reserved');
    await blobs.put(filePartBlobId(file, 0), new Uint8Array([1]), 'application/octet-stream');
  };
  const lines: string[] = [], errors: string[] = [];
  const log = { log: (line: string) => { lines.push(line); }, error: (line: string) => { errors.push(line); } };
  await put(expired('fil_boot'));
  const sweeper = scheduleProjectFileSweep(store, blobs, { intervalMs: 20, log });
  try {
    await sweeper.first;
    assert.equal(await store.getProjectFile('fil_boot'), null, 'the boot pass removed it');
    assert.equal(await blobs.head(filePartBlobId(expired('fil_boot'), 0)), null, 'parts too');
    assert.deepEqual(lines, ['[lolly-work] swept 1 expired project-file upload(s)']);
    await put(expired('fil_tick'));
    for (let waited = 0; await store.getProjectFile('fil_tick') && waited < 2000; waited += 10) await new Promise(r => setTimeout(r, 10));
    assert.equal(await store.getProjectFile('fil_tick'), null, 'the timer removed the next one');
  } finally { sweeper.stop(); }
  assert.deepEqual(errors, []);

  const failing: Store = { ...store, listUnfinishedProjectFiles: async () => { throw new Error('database unavailable'); } };
  const broken = scheduleProjectFileSweep(failing, blobs, { log });
  try { await broken.first; } finally { broken.stop(); }
  assert.deepEqual(errors, ['[lolly-work] project-file sweep failed: database unavailable'], 'logged, not thrown');
});

// Render worker reads (plan 76 M4j, render/read-ticket.ts). A ticket names one
// project, its file ids and the person who submitted the render.
test('a render ticket reads a listed file for its submitter and opens no other file route', async () => {
  const { store, base, cookies, projectId, newProject, upload, userId } = await boot();
  const bytes = new Uint8Array(PROJECT_FILE_PART_BYTES + 5).fill(42);
  const listed = await upload('editor', bytes), unlisted = await upload('editor', new Uint8Array([1, 2, 3]));
  const other = await newProject('Other uploads'), elsewhere = await upload('editor', new Uint8Array([4]), other);
  const viewer = await userId('viewer');
  const ticket = (ids: string[], who = viewer, project = projectId) => mintRenderRead([], 'rev', 'file-link', { projectId: project, ids, userId: who });
  const token = ticket([listed.id]);
  const read = (path: string, method = 'GET', key = token, who = '', body?: unknown) => fetch(base + path, {
    method, headers: { 'x-lw-render-read': key, ...(who ? { cookie: cookies.get(who)! } : {}),
      ...(body === undefined ? {} : { 'content-type': body instanceof Uint8Array ? 'application/octet-stream' : 'application/json' }) },
    ...(body === undefined ? {} : { body: body instanceof Uint8Array ? body : JSON.stringify(body) }),
  });
  const root = `/api/v1/projects/${projectId}/files`;
  const got = await read(`${root}/${listed.id}`);
  assert.equal(got.status, 200);
  assert.deepEqual(new Uint8Array(await got.arrayBuffer()), bytes, 'every part, verified');
  assert.match(got.headers.get('content-disposition')!, /^attachment/);
  assert.equal(got.headers.get('cache-control'), 'private, no-store');
  // Refused: another project's path, an unlisted file, the list, and every write or delete.
  assert.equal((await read(`/api/v1/projects/${other}/files/${elsewhere.id}`)).status, 401);
  assert.equal((await read(`/api/v1/projects/${other}/files/${elsewhere.id}`, 'GET', ticket([elsewhere.id], viewer, other))).status, 200, 'its own ticket');
  assert.equal((await read(`/api/v1/projects/${other}/files/${elsewhere.id}`, 'GET', ticket([elsewhere.id], await userId('outside'), other))).status, 401, 'a submitter who cannot see that project');
  assert.equal((await read(`${root}/${unlisted.id}`)).status, 401);
  assert.equal((await read(root)).status, 401);
  assert.equal((await read(root, 'POST', token, '', metadata(new Uint8Array([1])))).status, 401);
  assert.equal((await read(`${root}/${listed.id}/parts/0`, 'PUT', token, '', new Uint8Array([1]))).status, 401);
  assert.equal((await read(`${root}/${listed.id}/finalize`, 'POST', token, '', {})).status, 401);
  assert.equal((await read(`${root}/${listed.id}`, 'DELETE')).status, 401);
  assert.ok(await store.getProjectFile(listed.id), 'nothing was deleted');
  // A person's own cookie decides for them; the ticket adds nothing to it.
  assert.equal((await read(`${root}/${listed.id}`, 'GET', token, 'outside')).status, 403);
  // The submitter is read again on every request.
  await store.setUserDisabled(viewer, new Date().toISOString());
  assert.equal((await read(`${root}/${listed.id}`)).status, 401, 'disabled');
  await store.setUserDisabled(viewer, null);
  assert.equal((await read(`${root}/${listed.id}`)).status, 200);
  await store.deleteProjectMember(projectId, viewer);
  assert.equal((await read(`${root}/${listed.id}`)).status, 401, 'removed from the project after minting');
  assert.equal((await read(`${root}/${listed.id}`, 'GET', ticket([listed.id], await userId('outside')))).status, 401, 'never had access');
});

test('a render ticket\u2019s reads count toward the submitter\u2019s daily download allowance', async () => {
  // The allowance is two instance budgets a day: 4 reads of this file fit, the 5th does not.
  const { base, call, projectId, upload, userId } = await boot({ policy: { maxFileBytes: 8000, instanceBudgetBytes: 10_000, projectBudgetBytes: 10_000 } });
  const file = await upload('editor', new Uint8Array(5000).fill(3));
  const token = mintRenderRead([], 'rev', 'file-link', { projectId, ids: [file.id], userId: await userId('viewer') });
  const path = `/api/v1/projects/${projectId}/files/${file.id}`;
  for (let n = 0; n < 3; n++) assert.equal((await call('viewer', 'GET', path)).status, 200);
  assert.equal((await fetch(base + path, { headers: { 'x-lw-render-read': token } })).status, 200);
  const refused = await fetch(base + path, { headers: { 'x-lw-render-read': token } });
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
});
