// SPDX-License-Identifier: MPL-2.0
/** The history of a manager's edits behaves the same in memory and in Postgres. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryBrandEditStore, type BrandEditStore } from '../server/src/brand/edit-store.ts';
import type { BrandEditChange } from '../server/src/brand/edit-document.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const changes: BrandEditChange[] = [{ kind: 'token', set: 'base', path: ['color', 'brand', 'indigo'], before: { $value: '#1b2a6b' }, after: { $value: '#223377' } }];
const add = (store: BrandEditStore, sourceId: string, at: string, sentBy = 'user_1', restoredFrom?: number) =>
  store.addBrandEditRevision({ sourceId, digest: 'a'.repeat(64), baseChecksum: 'b'.repeat(64), changes, size: 12, sentBy, at, ...(restoredFrom ? { restoredFrom } : {}) });

async function conformance(store: BrandEditStore): Promise<void> {
  assert.deepEqual(await store.listBrandEditRevisions('profile:alpha', 10), []);
  assert.equal(await store.getBrandEditRevision('profile:alpha', 1), null);
  const first = await add(store, 'profile:alpha', '2026-11-06T00:00:00.000Z');
  assert.equal(first.n, 1);
  assert.equal(first.id, 'profile:alpha#1');
  assert.equal(first.state, 'staged');
  assert.equal(first.changeCount, 1);
  assert.deepEqual(first.changes, changes);
  assert.equal(first.createdAt, '2026-11-06T00:00:00.000Z');
  assert.equal(first.restoredFrom, null);

  assert.equal(await store.setBrandEditRevisionState('profile:alpha', 1, ['pending'], 'live'), false, 'only from a stated state');
  assert.equal(await store.setBrandEditRevisionState('profile:alpha', 1, ['staged'], 'pending', { approvalId: 'apr_1' }), true);
  assert.equal((await store.getBrandEditRevision('profile:alpha', 1))!.approvalId, 'apr_1');
  assert.equal(await store.setBrandEditRevisionState('profile:alpha', 1, ['pending'], 'live', { liveAt: '2026-11-06T01:00:00.000Z' }), true);
  assert.equal((await store.getBrandEditRevision('profile:alpha', 1))!.liveAt, '2026-11-06T01:00:00.000Z');
  assert.equal((await store.getBrandEditRevision('profile:alpha', 1))!.approvalId, 'apr_1', 'a later change keeps what an earlier one set');
  assert.equal(await store.setBrandEditRevisionState('profile:alpha', 1, ['live'], 'rolled-back', { endedAt: '2026-11-06T02:00:00.000Z', endedBy: 'user_2' }), true);
  const ended = (await store.getBrandEditRevision('profile:alpha', 1))!;
  assert.deepEqual([ended.state, ended.endedAt, ended.endedBy], ['rolled-back', '2026-11-06T02:00:00.000Z', 'user_2']);

  const second = await add(store, 'profile:alpha', '2026-11-06T03:00:00.000Z', 'user_1', 1);
  assert.equal(second.n, 2);
  assert.equal(second.restoredFrom, 1);
  const other = await add(store, 'profile:beta', '2026-11-06T03:00:00.000Z');
  assert.equal(other.n, 1, 'numbers are per source');
  const listed = await store.listBrandEditRevisions('profile:alpha', 10);
  assert.deepEqual(listed.map(row => row.n), [2, 1], 'newest first');
  assert.equal((listed[0] as unknown as { changes?: unknown }).changes, undefined, 'a list stays small');
  assert.equal(listed[0]!.changeCount, 1);
  assert.deepEqual((await store.listBrandEditRevisions('profile:alpha', 1)).map(row => row.n), [2]);
}

test('memory: one history per source, states move only from a stated state', () => conformance(createMemoryBrandEditStore()));
test('postgres: the same, and numbers hold when two replicas add at once', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async (store) => {
    await conformance(store);
    const rows = await Promise.all(Array.from({ length: 8 }, () => add(store, 'profile:gamma', '2026-11-06T00:00:00.000Z')));
    assert.deepEqual(rows.map(row => row.n).sort((a, b) => a - b), [1, 2, 3, 4, 5, 6, 7, 8]);
  });
});
