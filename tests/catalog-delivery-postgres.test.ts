// SPDX-License-Identifier: MPL-2.0
/** Qualify catalog fencing and retention in a disposable local PostgreSQL cluster. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCollabPostgresFixture } from './collab/postgres-fixture.ts';
import { createPostgresStore } from '../server/src/store/postgres.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const enabled = process.env.LW_TEST_LOCAL_POSTGRES === '1';
test('Postgres replicas fence publications atomically and retain bounded snapshots after restart', {
  skip: !enabled && 'set LW_TEST_LOCAL_POSTGRES=1 with local PostgreSQL installed',
}, async () => {
  const fixture = await createCollabPostgresFixture();
  let replica = await createPostgresStore(fixture.url);
  try {
    const publication = { generation: 0, digest: 'a'.repeat(64) }, a = 'b'.repeat(64), b = 'c'.repeat(64);
    const same = await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? replica : fixture.store!).catalogDeliverySequence(a, publication)));
    assert.deepEqual(same, Array(16).fill(1));
    assert.equal(await replica.catalogDeliverySequence(b, publication), 2);
    assert.equal(await fixture.store!.catalogDeliverySequence(a, publication), 3);
    const newer = { generation: 2, digest: 'd'.repeat(64) };
    assert.equal(await replica.catalogDeliverySequence(a, newer), 4);
    await assert.rejects(fixture.store!.catalogDeliverySequence(a, publication), /publication/i);
    await assert.rejects(fixture.store!.catalogDeliverySequence(a, { ...newer, digest: 'e'.repeat(64) }), /publication/i);
    await replica.close(); replica = await createPostgresStore(fixture.url);
    assert.equal(await replica.catalogDeliverySequence(a, newer), 4);
    const next = { generation: 3, digest: 'f'.repeat(64) };
    assert.deepEqual(await Promise.all(Array.from({ length: 16 }, (_, i) => (i % 2 ? replica : fixture.store!).catalogDeliverySequence(a, next))), Array(16).fill(5));

    const scope = 'a'.repeat(64), now = Date.now(), until = now + 3600000;
    const snapshots = ['first', 'other'].map(value => ({ scope, kind: 'tools' as const, hash: sha256Hex(value), bytes: Buffer.from(value), until, toolIds: ['open'], assetIds: [] }));
    const results = await Promise.all(snapshots.map((snapshot, i) => (i ? replica : fixture.store!).putCatalogDeliverySnapshot(snapshot, now, 5)));
    assert.equal(results.filter(Boolean).length, 1, 'the shared byte budget admits only one writer');
    const kept = snapshots[results.indexOf(true)]!;
    await replica.close(); replica = await createPostgresStore(fixture.url);
    assert.deepEqual((await replica.getCatalogDeliverySnapshot(scope, 'tools', kept.hash.slice(0, 16), now))?.bytes, kept.bytes);
    assert.equal(await replica.putCatalogDeliverySnapshot(kept, now, 0), true, 'already promised bytes are retained even after a budget reduction');
    assert.equal(await replica.getCatalogDeliverySnapshot(scope, 'tools', kept.hash.slice(0, 16), until), null);
    assert.equal(await replica.putCatalogDeliverySnapshot({ ...kept, until: until + 3600000 }, until, 5), true, 'expired rows free the bounded budget');
  } finally { await replica.close(); await fixture.close(); }
});
