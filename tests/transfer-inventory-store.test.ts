// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { readMigrationFiles } from '../server/src/store/migrate.ts';
import { PROJECT_TRANSFER_METADATA_MAX_LIMITS, validateProjectTransferMetadataLimits, type Store, type SessionRecord } from '../server/src/store/types.ts';

const bounds = { sessions: 3, files: 3, folders: 3, members: 3 };
const at = '2026-01-01T00:00:00.000Z';
const expiresAt = '2099-01-01T00:00:00.000Z';
const digest = 'a'.repeat(64);

async function fixture(store: Store) {
  const owner = await store.upsertUserBySub({ sub: 'inventory-owner', email: 'owner@example.invalid', groups: [], role: 'member' });
  for (const id of ['prj_source', 'prj_foreign']) await store.putProject({ id, name: 'PRIVATE_PROJECT_NAME', visibility: 'private', ownerId: owner.id, createdAt: at });
  const session = (id: string, projectId = 'prj_source'): SessionRecord => ({ id, projectId, toolId: 'design', toolVersion: '1', rev: 4,
    inputs: { private: 'PRIVATE_INPUT' }, meta: { private: 'PRIVATE_META' }, createdBy: owner.id, updatedBy: owner.id, updatedAt: at });
  for (const suffix of ['c', 'b', 'a']) await store.putSession(session('ses_' + suffix));
  await store.putSession({ ...session('ses_deleted'), deletedAt: at });
  await store.putSession(session('ses_foreign', 'prj_foreign'));
  for (const [id, projectId, ready] of [
    ['fil_c', 'prj_source', true], ['fil_b', 'prj_source', true], ['fil_a', 'prj_source', true],
    ['fil_pending', 'prj_source', false], ['fil_foreign', 'prj_foreign', true],
  ] as const) {
    assert.equal(await store.reserveProjectFile({ id, projectId, name: 'PRIVATE_FILE_NAME', size: 3, checksum: digest, contentType: 'image/png',
      parts: [{ size: 3, checksum: digest }], asset: { url: 'https://example.invalid/PRIVATE_ASSET', secret: 'PRIVATE_TOKEN' },
      createdBy: owner.id, createdAt: at, expiresAt, ready: false },
    { projectBudgetBytes: 1000000, instanceBudgetBytes: 1000000, maxPending: 20, maxPendingBytes: 1000000 }), 'reserved');
    if (ready) assert.equal(await store.completeProjectFile(id), true);
  }
  for (const suffix of ['c', 'b', 'a']) {
    await store.putProjectFolder({ id: 'fld_' + suffix, projectId: 'prj_source', parentId: null, name: 'PRIVATE_FOLDER_NAME', createdAt: at, createdBy: owner.id, items: [] });
    await store.assignProjectFolderItem('prj_source', 'fld_' + suffix, 'session', 'ses_' + suffix);
    await store.assignProjectFolderItem('prj_source', 'fld_' + suffix, 'file', 'fil_' + suffix);
  }
  await store.putProjectFolder({ id: 'fld_foreign', projectId: 'prj_foreign', parentId: null, name: 'PRIVATE_FOREIGN', createdAt: at, createdBy: owner.id, items: [] });
  await store.assignProjectFolderItem('prj_foreign', 'fld_foreign', 'session', 'ses_foreign');
  for (const suffix of ['c', 'b', 'a']) {
    const user = await store.upsertUserBySub({ sub: 'inventory-' + suffix, email: suffix + '@example.invalid', groups: [], role: 'member' });
    await store.putProjectMember({ projectId: 'prj_source', userId: user.id, role: 'viewer', expiresAt, addedBy: 'PRIVATE_ADDED_BY', addedAt: at });
    await store.putProjectMember({ projectId: 'prj_foreign', userId: user.id, role: 'manager', addedBy: 'PRIVATE_FOREIGN_ADDED_BY', addedAt: at });
  }
}

async function conformance(store: Store) {
  await fixture(store);
  const original = await store.getSession('ses_a');
  const observed = await store.observeProjectTransferMetadata('prj_source', bounds);
  assert.deepEqual(observed.sessions.map(row => row.id), ['ses_a', 'ses_b', 'ses_c']);
  assert.deepEqual(observed.files.map(row => row.id), ['fil_a', 'fil_b', 'fil_c']);
  assert.deepEqual(observed.folders.map(row => row.id), ['fld_a', 'fld_b', 'fld_c']);
  assert.equal(observed.members.length, 3);
  assert.equal(observed.folderLinksTruncated, false);
  assert.equal(observed.folders.reduce((n, row) => n + row.items.length, 0), 6);
  assert.deepEqual(Object.keys(observed.sessions[0]!).sort(), ['id', 'projectId', 'rev', 'toolId', 'toolVersion', 'updatedAt']);
  assert.deepEqual(Object.keys(observed.files[0]!).sort(), ['checksum', 'contentType', 'id', 'partCount', 'projectId', 'size']);
  assert.deepEqual(Object.keys(observed.folders[0]!).sort(), ['id', 'items', 'parentId', 'projectId']);
  assert.deepEqual(Object.keys(observed.members[0]!).sort(), ['expiresAt', 'projectId', 'role', 'userId']);
  assert.ok(observed.files.every(row => row.partCount === 1 && row.size === 3 && row.checksum === digest));
  assert.ok(observed.members.every(row => row.expiresAt === expiresAt));
  assert.ok(!JSON.stringify(observed).includes('PRIVATE_'));
  assert.ok(!JSON.stringify(observed).includes('foreign'));
  const again = await store.observeProjectTransferMetadata('prj_source', bounds);
  assert.deepEqual(again, observed, 'stable unchanged observations have deterministic ordering');
  observed.sessions[0]!.toolId = 'changed';
  observed.folders[0]!.items[0]!.ref = 'changed';
  observed.members[0]!.role = 'manager';
  assert.deepEqual(await store.getSession('ses_a'), original);
  assert.deepEqual(await store.observeProjectTransferMetadata('prj_source', bounds), again, 'returned rows do not alias stored records');
  const limited = await store.observeProjectTransferMetadata('prj_source', { sessions: 1, files: 1, folders: 1, members: 1 });
  for (const key of ['sessions', 'files', 'folders', 'members'] as const) assert.equal(limited[key].length, 2, key + ' sentinel row');
  assert.equal(limited.folderLinksTruncated, true);
  assert.ok(limited.folders.reduce((n, row) => n + row.items.length, 0) <= 2, 'global links bound is independent of folder count');
  assert.deepEqual(await store.observeProjectTransferMetadata('prj_missing', bounds), { sessions: [], files: [], folders: [], members: [], folderLinksTruncated: false });
}

test('memory transfer metadata is bounded, scoped, detached and excludes private fields', async () => conformance(createMemoryStore()));

test('memory observation never clones documents and stops before rows beyond the sentinel', async () => {
  const store = createMemoryStore();
  for (let n = 0; n < 4; n++) {
    const row: SessionRecord = { id: 'ses_' + n, projectId: 'prj_bounded', toolId: 'design', toolVersion: '1', rev: 1, updatedAt: at,
      inputs: {}, meta: {}, createdBy: 'usr_owner', updatedBy: 'usr_owner' };
    await store.putSession(row);
    for (const field of ['inputs', 'meta']) Object.defineProperty(row, field, { get() { throw new Error('private field touched'); } });
    if (n === 3) Object.defineProperty(row, 'projectId', { get() { throw new Error('row beyond sentinel touched'); } });
  }
  const clone = globalThis.structuredClone;
  globalThis.structuredClone = () => { throw new Error('unexpected clone'); };
  try {
    const observed = await store.observeProjectTransferMetadata('prj_bounded', { sessions: 2, files: 1, folders: 1, members: 1 });
    assert.equal(observed.sessions.length, 3);
  } finally { globalThis.structuredClone = clone; }
});

test('caller limits cannot disable or raise bounds and are checked before reading rows', async () => {
  const store = createMemoryStore();
  const row: SessionRecord = { id: 'ses_poison', projectId: 'prj', toolId: 'design', toolVersion: '1', rev: 1, updatedAt: at, inputs: {}, meta: {}, createdBy: 'usr', updatedBy: 'usr' };
  await store.putSession(row);
  Object.defineProperty(row, 'projectId', { get() { throw new Error('store read before validation'); } });
  for (const key of Object.keys(bounds) as Array<keyof typeof bounds>) {
    for (const value of [0, -1, 1.5, NaN, Infinity, PROJECT_TRANSFER_METADATA_MAX_LIMITS[key] + 1]) {
      await assert.rejects(store.observeProjectTransferMetadata('prj', { ...bounds, [key]: value }), RangeError);
    }
    const missing = { ...bounds } as Partial<typeof bounds>; delete missing[key];
    await assert.rejects(store.observeProjectTransferMetadata('prj', missing as typeof bounds), RangeError);
  }
  assert.deepEqual(validateProjectTransferMetadataLimits(PROJECT_TRANSFER_METADATA_MAX_LIMITS), PROJECT_TRANSFER_METADATA_MAX_LIMITS);
  const input = { ...bounds }, validated = validateProjectTransferMetadataLimits(input); input.sessions = 100;
  assert.equal(validated.sessions, 3, 'validated limits are copied');
});

// This suite owns only a unique schema. Public-schema conformance suites may
// run concurrently without either fixture dropping the other's records.
test('Postgres transfer metadata uses five bounded projected SELECTs in its own schema', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  const { default: pg } = await import('pg');
  const schema = 'lw_transfer_' + randomUUID().replaceAll('-', '');
  const sourceUrl = process.env.LW_TEST_DATABASE_URL!;
  const scoped = new URL(sourceUrl); scoped.searchParams.set('options', '-csearch_path=' + schema);
  const admin = new pg.Client({ connectionString: sourceUrl });
  let store: Awaited<ReturnType<typeof createPostgresStore>> | undefined;
  let created = false;
  await admin.connect();
  try {
    await admin.query(`create schema "${schema}"`); created = true;
    const setup = new pg.Client({ connectionString: scoped.toString() });
    await setup.connect();
    try {
      for (const name of await readMigrationFiles()) await setup.query(await readFile(join('migrations', name), 'utf8'));
    } finally { await setup.end(); }
    store = await createPostgresStore(scoped.toString());
    await conformance(store);
    const prototype = pg.Pool.prototype as unknown as { query(text: string, values?: unknown[]): Promise<unknown> };
    const originalQuery = prototype.query, queries: Array<{ text: string; values?: unknown[] }> = [];
    prototype.query = function (text, values) { queries.push({ text, values }); return originalQuery.call(this, text, values); };
    try {
      await store.observeProjectTransferMetadata('prj_source', bounds);
      assert.equal(queries.length, 5);
      const tables = ['sessions', 'project_files', 'project_folders', 'project_members', 'project_folder_items'];
      for (let n = 0; n < queries.length; n++) {
        const query = queries[n]!;
        assert.match(query.text, new RegExp('^select .+ from ' + tables[n] + '\\s'));
        assert.match(query.text, /where project_id=\$1/);
        assert.match(query.text, /order by .+ collate "C"/);
        assert.match(query.text, /limit \$2$/);
        assert.doesNotMatch(query.text, /select\s+\*|\b(?:inputs|meta|asset|name|added_by|added_at|created_by|jsonb_agg)\b/i);
        assert.deepEqual(query.values, ['prj_source', n === 4 ? 7 : 4]);
      }
      assert.match(queries[1]!.text, /jsonb_array_length\(parts\) as part_count/);
    } finally { prototype.query = originalQuery; }
  } finally {
    await store?.close();
    if (created) await admin.query(`drop schema "${schema}" cascade`);
    await admin.end();
  }
});
