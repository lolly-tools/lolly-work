// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Room, type RoomMember, type ServerFrame } from '../../server/src/collab/rooms.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import type { SessionRecord, Store } from '../../server/src/store/types.ts';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { withFreshPostgres } from '../pg-test-schema.ts';

async function exercise(store: Store): Promise<void> {
  const user = await store.upsertUserBySub({ sub: 'receipt-test', email: 'receipt@example.invalid', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.putProject({ id: 'receipt-project', name: 'Receipts', visibility: 'private', ownerId: user.id, createdAt: now });
  const session: SessionRecord = { id: 'receipt-session', projectId: 'receipt-project', toolId: 'design', toolVersion: '1',
    inputs: { boxes: [] }, meta: {}, createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: now };
  await store.putSession(session);
  const sent: ServerFrame[] = [];
  const peer: RoomMember = { id: 'one', userId: user.id, name: 'One', role: 'writer', opVersion: '1.1.0', send: f => sent.push(f) };
  let room = await Room.open(session, undefined, store);
  try {
    room.join(peer);
    await assert.rejects(Room.open(session, undefined, store), /owned/);
    assert.equal(await store.casSession({ ...session, rev: 2, inputs: {} }, 1), false, 'REST/automation cannot race the owner');
    await assert.rejects(store.putSession({ ...session, deletedAt: now }), /collab-active/);
    const add: CanvasOp = { k: 'add', id: 'a', col: 'boxes', row: { x: 1, fill: 'red' }, orderKey: 'a', origin: { client: 'c', clock: 1 } };
    const field: CanvasOp = { k: 'field', id: 'a', col: 'boxes', field: 'fill', value: 'blue', origin: { client: 'c', clock: 2 } };
    const geom: CanvasOp = { k: 'geom', id: 'a', col: 'boxes', fields: { x: 9 }, origin: { client: 'c', clock: 2 } };
    await room.applyBatch(peer, 'batch-add', ['add'], [add], new Set([add]));
    // Two messages from one gesture carry the same clock; both must survive.
    await Promise.all([
      room.applyBatch(peer, 'batch-field', ['field'], [field], new Set([field])),
      room.applyBatch(peer, 'batch-geom', ['geom'], [geom], new Set([geom])),
    ]);
    const stored = await store.getSession(session.id);
    assert.deepEqual(stored?.inputs.boxes, [{ id: 'a', fill: 'blue', x: 9 }]);
    const rev = stored!.rev;
    sent.length = 0;
    await room.applyBatch(peer, 'lost-ack', ['geom'], [geom], new Set());
    assert.equal((await store.getSession(session.id))!.rev, rev, 'lost receipt replay does not write twice or reauthorize an already committed result');
    const replay = sent.at(-1); assert.ok(replay?.t === 'receipt' && replay.checkpoint);
    const { checkpoint, serverClock, ...receipt } = replay;
    assert.equal(serverClock, 2);
    assert.ok(checkpoint.collections.length);
    assert.deepEqual(receipt, { t: 'receipt', batchId: 'lost-ack', durableRevision: rev, acceptedIds: ['geom'], rejectedIds: [] });
    await assert.rejects(room.applyBatch(peer, 'tampered', ['geom'], [{ ...geom, fields: { x: 999 } }], new Set()), /receipt-conflict/);
    const remove: CanvasOp = { k: 'remove', id: 'a', col: 'boxes', origin: { client: 'c', clock: 3 } };
    const refused: CanvasOp = { k: 'param', key: 'locked', value: 'bad', origin: { client: 'c', clock: 3 } };
    await room.applyBatch(peer, 'partial', ['remove', 'refused'], [remove, refused], new Set([remove]));
    assert.deepEqual((sent.at(-1) as Extract<ServerFrame,{t:'receipt'}>).rejectedIds, ['refused']);
    await room.quiesce();
    room = await Room.open(session, undefined, store);
    room.join(peer);
    assert.deepEqual(room.snapshot().collections?.boxes?.order, [], 'tombstones survive restart');
    const late: CanvasOp = { ...add, origin: { client: 'c', clock: 2 } };
    await room.applyBatch(peer, 'late', ['late'], [late], new Set([late]));
    assert.deepEqual(room.snapshot().collections?.boxes?.order, [], 'older add cannot resurrect a deleted object after restart');
    const commit = store.commitCollab;
    store.commitCollab = async () => { throw new Error('disk full'); };
    const before = JSON.stringify(room.snapshot()); sent.length = 0;
    await assert.rejects(room.applyBatch(peer, 'failed', ['failed'], [field], new Set([field])), /disk full/);
    assert.equal(JSON.stringify(room.snapshot()), before);
    assert.equal(sent.length, 0, 'no broadcast or receipt on storage failure');
    store.commitCollab = commit;
  } finally { await room.quiesce(); }
  const current = (await store.getSession(session.id))!;
  assert.equal(await store.casSession({ ...current, rev: current.rev + 1 }, current.rev), true, 'REST resumes after drain');
}

test('durable receipts, chunked gestures, owner exclusion and restart (memory)', () => exercise(createMemoryStore()));
test('durable receipts, chunked gestures, owner exclusion and restart (Postgres)', { skip: !process.env.LW_TEST_DATABASE_URL },
  () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, exercise));

test('Postgres rolls back checkpoint and session if the receipt insert fails, and fences a replaced owner', {
  skip: !process.env.LW_TEST_DATABASE_URL,
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
  const { default: pg } = await import('pg');
  const admin = new pg.Client({ connectionString: process.env.LW_TEST_DATABASE_URL });
  await admin.connect();
  try {
    const user = await store.upsertUserBySub({ sub: 'transaction', email: 'transaction@example.invalid', groups: [], role: 'member' });
    const now = new Date().toISOString();
    await store.putProject({ id: 'p', name: 'Test', visibility: 'private', ownerId: user.id, createdAt: now });
    await store.putSession({ id: 's', projectId: 'p', toolId: 'design', toolVersion: '1', inputs: { title: 'before' }, meta: {},
      createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: now });
    assert.equal(await store.claimCollab('s', 'old-owner', 30000), true);
    const { ReferenceCanvasDoc } = await import('@lolly-tools/core/canvas-op-v1');
    const batch = { sessionId: 's', owner: 'old-owner', principal: user.id, expectedRev: 1, inputs: { title: 'after' },
      checkpoint: new ReferenceCanvasDoc().checkpoint(), ops: [], receipts: [{ id: 'op', digest: 'digest', accepted: true }], actor: 'collab', updatedBy: user.id };
    await admin.query(`create function fail_receipt_test() returns trigger language plpgsql as $$
      begin raise exception 'synthetic receipt failure'; end $$;
      create trigger fail_receipt_test before insert on collab_receipts for each row execute function fail_receipt_test();`);
    await assert.rejects(store.commitCollab(batch), /synthetic receipt failure/);
    assert.equal((await store.getSession('s'))!.rev, 1);
    assert.deepEqual((await store.getSession('s'))!.inputs, { title: 'before' });
    assert.equal(await store.getCollabCheckpoint('s'), null);
    assert.deepEqual(await store.getCollabReceipts('s', user.id, ['op']), []);
    await admin.query('drop trigger fail_receipt_test on collab_receipts');
    await admin.query("update sessions set collab_lease_until=clock_timestamp()-interval '1 second' where id='s'");
    assert.equal(await store.claimCollab('s', 'new-owner', 30000), true);
    await assert.rejects(store.commitCollab(batch), /collab-owner-conflict/);
    await store.releaseCollab('s', 'old-owner');
    assert.equal(await store.claimCollab('s', 'third-owner', 30000), false, 'stale release cannot clear the successor lease');
    assert.equal(await store.commitCollab({ ...batch, owner: 'new-owner' }), 2);
    assert.equal((await store.getCollabCheckpoint('s'))!.revision, 2);
  } finally { await admin.end(); }
}));

test('an empty blocks input survives the initial join and checkpoint restart', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'empty', email: 'empty@test', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.putProject({ id: 'empty-project', name: 'Empty', visibility: 'private', ownerId: user.id, createdAt: now });
  const session: SessionRecord = { id: 'empty-session', projectId: 'empty-project', toolId: 'design', toolVersion: '1', inputs: { boxes: [] },
    meta: {}, rev: 1, createdBy: user.id, updatedBy: user.id, updatedAt: now };
  await store.putSession(session);
  const peer: RoomMember = { id: 'empty-peer', userId: user.id, name: 'Empty', role: 'writer', opVersion: '1.1.0', send: () => {} };
  let room = await Room.open(session, undefined, store);
  try {
    assert.deepEqual(room.join(peer).checkpoint.collections, [['boxes', []]]);
    assert.deepEqual(room.snapshot().collections?.boxes, { order: [], boxes: {} });
    const op: CanvasOp = { k: 'param', key: 'title', value: 'saved', origin: { client: 'writer', clock: 1 } };
    await room.applyBatch(peer, 'empty-save', ['empty-save'], [op], new Set([op]));
    await room.quiesce();
    room = await Room.open(session, undefined, store);
    assert.deepEqual(room.snapshot().collections?.boxes, { order: [], boxes: {} });
  } finally { await room.quiesce(); }
});
