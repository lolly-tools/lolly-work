// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabPostgresFixture } from './collab/postgres-fixture.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import type { DeliveryRecord } from '../server/src/delivery/types.ts';

test('Postgres DAM progress survives restart, immutable sources stay fixed and only one replica claims a retry', {
  skip: process.env.LW_TEST_LOCAL_POSTGRES !== '1' && 'set LW_TEST_LOCAL_POSTGRES=1 with local PostgreSQL installed',
}, async () => {
  const fixture = await createCollabPostgresFixture();
  let replica = await createPostgresStore(fixture.url);
  try {
    const now = new Date().toISOString();
    const delivery: DeliveryRecord = { id: 'del_pg', principal: 'user:person', destinationId: 'dam', destinationVersion: 'version', name: 'Original.png', format: 'png', contentType: 'image/png', size: 1,
      sha256: 'a'.repeat(64), requestHash: 'b'.repeat(64), sourceRef: 'delivery/del_pg/source', projectSource: { projectId: 'project', fileId: 'file', checksum: 'a'.repeat(64) },
      providerProgress: { phase: 'created', remoteId: 'remote' }, state: 'failed', attempt: 1, idempotencyKey: 'once', createdAt: now, updatedAt: now };
    await fixture.store!.putDelivery(delivery);
    await replica.close(); replica = await createPostgresStore(fixture.url);
    assert.deepEqual((await replica.getDelivery(delivery.id, delivery.principal))?.projectSource, delivery.projectSource);
    assert.deepEqual((await replica.getDelivery(delivery.id, delivery.principal))?.providerProgress, delivery.providerProgress);
    const claims = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? replica : fixture.store!).claimDelivery(delivery)));
    assert.equal(claims.filter(Boolean).length, 1);
    const claimed = claims.find(Boolean)!; assert.equal(claimed.attempt, 2);
    await replica.putDelivery({ ...claimed, state: 'failed', projectSource: { projectId: 'other', fileId: 'other', checksum: '0'.repeat(64) } });
    assert.deepEqual((await fixture.store!.getDelivery(delivery.id, delivery.principal))?.projectSource, delivery.projectSource);
    await assert.rejects(replica.putDelivery({ ...delivery, id: 'del_duplicate' }), /unique/);
    assert.equal(await replica.claimDelivery({ ...delivery, principal: 'user:other' }), null);
  } finally { await replica.close(); await fixture.close(); }
});
