// SPDX-License-Identifier: MPL-2.0
/**
 * Shared conformance for scoped upload records (uploads/scoped.ts), run on the
 * memory store and, with LW_TEST_DATABASE_URL, on Postgres by
 * tests/resumable-uploads.test.ts, so both keep one set of rules: budgets and
 * the pending limit count only uploads that have not expired, an id is
 * reserved once, a touch never shortens an expiry or revives an expired
 * upload, completing is idempotent, and the removal lists filter as declared.
 * A file reference's own fields read back unchanged, and the list narrows by
 * scope and state and pages from a position.
 */
import assert from 'node:assert/strict';
import { UPLOAD_OVERHEAD_BYTES, type UploadRecord, type UploadStore } from '../server/src/uploads/scoped.ts';

const R = UPLOAD_OVERHEAD_BYTES;
const HOUR = 60 * 60 * 1000;

export function uploadRecord(id: string, owner: string, size: number, { createdAt = Date.now(), expiresIn = HOUR, ready = false, scope = 'automation-input' as UploadRecord['scope'] } = {}): UploadRecord {
  const parts = Array.from({ length: Math.ceil(size / (1024 * 1024)) }, (_, n) => ({ size: Math.min(1024 * 1024, size - n * 1024 * 1024), checksum: 'c'.repeat(64) }));
  return {
    id, scope, owner, name: `${id}.bin`, size, checksum: 'c'.repeat(64), contentType: 'application/octet-stream', parts,
    createdAt: new Date(createdAt).toISOString(), expiresAt: new Date(createdAt + expiresIn).toISOString(), ready,
  };
}

export async function uploadStoreConformance(store: UploadStore): Promise<void> {
  const t = Date.now();
  const roomy = { ownerBudgetBytes: 1e12, instanceBudgetBytes: 1e12, maxPending: 99 };
  const a = uploadRecord('upl_a', 'user:u1', 10, { createdAt: t - 3000 });
  assert.equal(await store.reserveUpload(a, roomy), 'reserved');
  assert.equal(await store.reserveUpload(a, roomy), 'refused', 'an id is reserved once');
  assert.deepEqual(await store.getUpload('upl_a'), a, 'the record reads back unchanged');
  assert.equal(await store.getUpload('upl_nope'), null);
  assert.equal(await store.reserveUpload(uploadRecord('upl_b', 'user:u1', 20, { createdAt: t - 2000, scope: 'catalog-submission' }), roomy), 'reserved');
  assert.equal(await store.reserveUpload(uploadRecord('upl_c', 'service:svc_t1', 30, { createdAt: t - 1000 }), roomy), 'reserved');
  assert.deepEqual((await store.listUploads('user:u1', 10)).map((u) => u.id), ['upl_b', 'upl_a'], 'one owner, newest first');
  assert.deepEqual((await store.listUploads('user:u1', 1)).map((u) => u.id), ['upl_b'], 'limited');
  assert.deepEqual(await store.uploadUsage('user:u1'), { ownerBytes: 30 + 2 * R, instanceBytes: 60 + 3 * R });

  // Expired uploads count for nothing and are not listed.
  const old = uploadRecord('upl_old', 'user:u1', 900, { createdAt: t - 3 * HOUR, expiresIn: HOUR });
  assert.equal(await store.reserveUpload(old, roomy), 'reserved');
  assert.deepEqual(await store.uploadUsage('user:u1'), { ownerBytes: 30 + 2 * R, instanceBytes: 60 + 3 * R });
  assert.ok(!(await store.listUploads('user:u1', 10)).some((u) => u.id === 'upl_old'));

  // The owner budget, the instance budget and the pending limit.
  const tight = { ownerBudgetBytes: 30 + 2 * R + 5 + R, instanceBudgetBytes: 1e12, maxPending: 99 };
  assert.equal(await store.reserveUpload(uploadRecord('upl_d', 'user:u1', 6), tight), 'owner-budget');
  assert.equal(await store.reserveUpload(uploadRecord('upl_d', 'user:u1', 5), tight), 'reserved');
  assert.equal(await store.reserveUpload(uploadRecord('upl_e', 'user:u2', 1), { ...roomy, instanceBudgetBytes: 65 + 4 * R }), 'instance-budget', 'the instance budget spans owners');
  assert.equal(await store.reserveUpload(uploadRecord('upl_e', 'user:u2', 1), { ...roomy, maxPending: 0 }), 'pending');

  // touch: moves an unfinished expiry out, never in; a finished upload keeps its own.
  const later = new Date(t + 2 * HOUR).toISOString(), earlier = new Date(t + 60_000).toISOString();
  assert.equal(await store.touchUpload('upl_a', later), true);
  assert.equal((await store.getUpload('upl_a'))?.expiresAt, later);
  assert.equal(await store.touchUpload('upl_a', earlier), true);
  assert.equal((await store.getUpload('upl_a'))?.expiresAt, later, 'never earlier');
  assert.equal(await store.touchUpload('upl_old', later), false, 'an expired upload stays expired');
  assert.equal(await store.touchUpload('upl_nope', later), false);

  // complete: sets ready and the finished expiry once; again changes nothing.
  const kept = new Date(t + 24 * HOUR).toISOString();
  assert.equal(await store.completeUpload('upl_b', kept), true);
  assert.deepEqual(await store.getUpload('upl_b'), { ...uploadRecord('upl_b', 'user:u1', 20, { createdAt: t - 2000, scope: 'catalog-submission' }), ready: true, expiresAt: kept });
  assert.equal(await store.completeUpload('upl_b', later), true, 'completing again is harmless');
  assert.equal((await store.getUpload('upl_b'))?.expiresAt, kept);
  assert.equal(await store.touchUpload('upl_b', new Date(t + 48 * HOUR).toISOString()), true, 'a finished upload that has not expired');
  assert.equal((await store.getUpload('upl_b'))?.expiresAt, kept, 'its expiry is its own');
  assert.equal(await store.completeUpload('upl_old', kept), false, 'an expired upload cannot be completed');
  assert.equal(await store.completeUpload('upl_nope', kept), false);
  // upl_a and upl_d are pending; the finished upl_b would make three.
  assert.equal(await store.reserveUpload(uploadRecord('upl_f', 'user:u1', 1), { ...roomy, maxPending: 3 }), 'reserved', 'a finished upload is not pending');

  // Removal lists: by expiry, by owner, earliest expiry first.
  assert.deepEqual((await store.listUploadsToRemove({ expiredBy: new Date(t).toISOString() }, 10)).map((u) => u.id), ['upl_old']);
  assert.deepEqual((await store.listUploadsToRemove({ owner: 'service:svc_t1' }, 10)).map((u) => u.id), ['upl_c']);
  assert.deepEqual((await store.listUploadsToRemove({ owner: 'user:u1' }, 2)).map((u) => u.id), ['upl_old', 'upl_d'], 'earliest expiry first, limited');
  assert.equal(await store.deleteUpload('upl_old'), true);
  assert.equal(await store.deleteUpload('upl_old'), false);
  assert.equal(await store.getUpload('upl_old'), null);

  // File references (migration 0076): the role, the source and the report read back unchanged.
  const report = { by: 'instance' as const, report: { version: 1, operation: 'optimize', changes: ['strip-metadata'] } };
  const source = { ...uploadRecord('fil_src', 'user:f1', 3, { createdAt: t - 500, scope: 'file' }), role: 'original' as const };
  const output = { ...uploadRecord('fil_out', 'user:f1', 4, { createdAt: t - 500, scope: 'file' }), role: 'output' as const, derivedFrom: { id: 'fil_src', checksum: 'c'.repeat(64) }, report };
  const pending = { ...uploadRecord('fil_pending', 'user:f1', 5, { createdAt: t - 100, scope: 'file' }), role: 'original' as const };
  for (const u of [source, output, pending]) assert.equal(await store.reserveUpload(u, roomy), 'reserved');
  assert.equal(await store.reserveUpload(uploadRecord('upl_input', 'user:f1', 6, { createdAt: t - 50 }), roomy), 'reserved');
  assert.deepEqual(await store.getUpload('fil_out'), output);
  assert.deepEqual(await store.getUpload('fil_src'), source);
  for (const id of ['fil_src', 'fil_out']) assert.equal(await store.completeUpload(id, kept), true);
  const files = (filter: Parameters<UploadStore['listUploads']>[2], limit = 10) => store.listUploads('user:f1', limit, filter).then((us) => us.map((u) => u.id));
  assert.deepEqual(await files({}), ['upl_input', 'fil_pending', 'fil_out', 'fil_src'], 'no filter: every scope, newest first, then by id');
  assert.deepEqual(await files({ scope: 'file' }), ['fil_pending', 'fil_out', 'fil_src']);
  assert.deepEqual(await files({ scope: 'file', ready: true }), ['fil_out', 'fil_src']);
  assert.deepEqual(await files({ scope: 'file', ready: true }, 1), ['fil_out']);
  assert.deepEqual(await files({ scope: 'file', ready: true, before: { createdAt: source.createdAt, id: 'fil_out' } }), ['fil_src'], 'after a position: as old with a later id');
  assert.deepEqual(await files({ scope: 'file', before: { createdAt: pending.createdAt, id: 'fil_pending' } }), ['fil_out', 'fil_src'], 'after a position: older');
  assert.deepEqual(await files({ scope: 'file', ready: true, before: { createdAt: source.createdAt, id: 'fil_src' } }), []);
}
