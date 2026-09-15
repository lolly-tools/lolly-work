// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Room, type RoomMember, type ServerFrame } from '../../server/src/collab/rooms.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import type { Store } from '../../server/src/store/types.ts';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { withFreshPostgres } from '../pg-test-schema.ts';
import { runMigrations } from '../../server/src/store/migrate.ts';

async function setup(store: Store) {
  const user = await store.upsertUserBySub({ sub: 'journal', email: 'journal@example.invalid', groups: [], role: 'member' });
  const now = new Date().toISOString();
  await store.putProject({ id: 'journal-project', name: 'Journal', visibility: 'private', ownerId: user.id, createdAt: now });
  const session = { id: 'journal-session', projectId: 'journal-project', toolId: 'design', toolVersion: '1',
    inputs: { boxes: [{ id: 'a', x: 0 }], title: 'initial' }, meta: {}, createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: now };
  await store.putSession(session);
  const sent: ServerFrame[] = [];
  const peer: RoomMember = { id: 'journal-peer', userId: user.id, name: 'Journal', role: 'writer', opVersion: '1.1.0', send: frame => sent.push(frame) };
  return { session, peer, sent };
}
const operation = (clock: number): CanvasOp => ({ k: 'param', key: 'title', value: `edit ${clock}`, origin: { client: 'journal-peer', clock } });
async function apply(room: Room, peer: RoomMember, clock: number, accepted = true) {
  const op = operation(clock);
  await room.applyBatch(peer, `batch-${clock}`, [`op-${clock}`], [op], new Set(accepted ? [op] : []));
}

async function exerciseJournal(store: Store) {
  const { session, peer } = await setup(store);
  let room = await Room.open(session, undefined, store);
  try {
    await apply(room, peer, 1);
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, 2);
    for (let i = 2; i <= 70; i++) await apply(room, peer, i, i !== 3);
    const saved = (await store.getCollabCheckpoint(session.id))!;
    assert.equal(saved.revision, 2, 'ordinary edits do not rewrite convergence checkpoints');
    assert.equal(saved.headRevision, 71);
    const journal = await store.getCollabJournal(session.id, saved.revision);
    assert.equal(journal.length, 69);
    assert.deepEqual(journal[1]!.ops, [], 'rejection-only commits retain a contiguous recovery chain');
    const before = room.snapshot();
    await room.quiesce();
    room = await Room.open(session, undefined, store);
    assert.deepEqual(room.snapshot(), before, 'checkpoint plus tail recovers exact converged state');
    for (let i = 71; i <= 130; i++) await apply(room, peer, i);
    const compacted = (await store.getCollabCheckpoint(session.id))!;
    assert.equal(compacted.revision, 130, 'cadence survives restart and includes rejection-only commits');
    assert.equal(compacted.headRevision, 131);
    assert.deepEqual((await store.getCollabJournal(session.id, 0)).map(row => row.revision), [131]);
    const history = await store.listSessionRevisions(session.id);
    assert.equal(history.length, 20);
    assert.equal(history[0]!.rev, 131);
    assert.equal(history.at(-1)!.rev, 112);
    assert.deepEqual(history[0]!.inputs, (await store.getSession(session.id))!.inputs);
    await apply(room, peer, 2, false);
    assert.equal((await store.getSession(session.id))!.rev, 131, 'compaction keeps immutable receipts for old outbox retries');
    assert.equal((await store.getCollabReceipts(session.id, peer.userId, ['op-2']))[0]!.accepted, true);
    await room.quiesce();
    const current = (await store.getSession(session.id))!;
    assert.equal(await store.casSession({ ...current, inputs: { ...current.inputs, title: 'REST replacement' }, rev: current.rev + 1 }, current.rev), true);
    room = await Room.open(session, undefined, store);
    assert.equal(room.snapshot().params.title, 'REST replacement', 'a later ordinary save supersedes the old recovery chain');
    const replayFrames: ServerFrame[] = [];
    await apply(room, { ...peer, send: frame => replayFrames.push(frame) }, 2, false);
    const replay = replayFrames.at(-1); assert.ok(replay?.t === 'receipt' && replay.checkpoint);
    assert.deepEqual(replay.acceptedIds, ['op-2']);
    assert.equal(replay.durableRevision, 132);
    assert.equal(replay.checkpoint.params.find(([key]) => key === 'title')?.[1].value, 'REST replacement');
    await apply(room, peer, 200);
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, 133, 'the next collaboration commit establishes a new checkpoint');
    assert.deepEqual(await store.getCollabJournal(session.id, 0), []);
  } finally { await room.quiesce(); }
}

test('journal recovery, compaction, receipt retention and normal saves (memory)', () => exerciseJournal(createMemoryStore()));
test('journal recovery, compaction, receipt retention and normal saves (Postgres)', { skip: !process.env.LW_TEST_DATABASE_URL },
  () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    await exerciseJournal(store);
    const { default: pg } = await import('pg');
    const db = new pg.Client({ connectionString: process.env.LW_TEST_DATABASE_URL }); await db.connect();
    try {
      const result = await db.query('select count(*)::int as count from session_revisions where session_id=$1', ['journal-session']);
      assert.equal(result.rows[0].count, 20, 'history is physically bounded, not only limited when read');
    } finally { await db.end(); }
  }));

test('incomplete recovery fails closed and releases the acquired owner (memory)', async () => {
  const store = createMemoryStore(), { session, peer } = await setup(store);
  const room = await Room.open(session, undefined, store);
  await apply(room, peer, 1); await apply(room, peer, 2); await apply(room, peer, 3);
  await room.quiesce();
  const read = store.getCollabJournal;
  for (const omit of [0, 1]) {
    store.getCollabJournal = async (...args) => (await read(...args)).filter((_, i) => i !== omit);
    await assert.rejects(Room.open(session, undefined, store), /journal-gap/);
    assert.equal(await store.claimCollab(session.id, 'probe', 30000), true);
    await store.releaseCollab(session.id, 'probe');
  }
  store.getCollabJournal = read;
  const recovered = await Room.open(session, undefined, store);
  try { assert.equal(recovered.snapshot().params.title, 'edit 3'); } finally { await recovered.quiesce(); }
});

for (const dimension of ['operations', 'bytes'] as const) test(`checkpoint cadence bounds journal ${dimension} before the transaction limit`, async () => {
  const store = createMemoryStore(), { session, peer } = await setup(store);
  const room = await Room.open(session, undefined, store);
  try {
    await apply(room, peer, 1);
    const size = dimension === 'bytes' ? 100 : 128, rounds = dimension === 'bytes' ? 3 : 32;
    for (let round = 0; round < rounds; round++) {
      const ops: CanvasOp[] = Array.from({ length: size }, (_, i) => ({ k: 'param', key: 'title',
        value: dimension === 'bytes' ? 'x'.repeat(4000) : i, origin: { client: peer.id, clock: 2 + round * size + i } }));
      const ids = ops.map((_, i) => `budget-${round}-${i}`);
      await room.applyBatch(peer, ids[0]!, ids, ops, new Set(ops));
    }
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, rounds + 2);
    assert.deepEqual(await store.getCollabJournal(session.id, 0), []);
  } finally { await room.quiesce(); }
});

test('the next active commit checkpoints after the time interval', async t => {
  t.mock.timers.enable({ apis: ['Date', 'setInterval'], now: Date.now() });
  const store = createMemoryStore(), { session, peer } = await setup(store);
  const room = await Room.open(session, undefined, store);
  try {
    await apply(room, peer, 1); await apply(room, peer, 2);
    t.mock.timers.tick(30_001);
    await apply(room, peer, 3);
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, 4);
    assert.deepEqual(await store.getCollabJournal(session.id, 0), []);
  } finally { await room.quiesce(); }
});

test('Postgres journal and compaction roll back with receipts, preserving recovery and history', {
  skip: !process.env.LW_TEST_DATABASE_URL,
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
  const { session, peer, sent } = await setup(store), room = await Room.open(session, undefined, store);
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.LW_TEST_DATABASE_URL }); await db.connect();
  try {
    await apply(room, peer, 1);
    await db.query(`create function reject_journal_receipt() returns trigger language plpgsql as $$
      begin raise exception 'journal receipt failure'; end $$;
      create trigger reject_journal_receipt before insert on collab_receipts for each row execute function reject_journal_receipt();`);
    const before = room.snapshot(); sent.length = 0;
    await assert.rejects(apply(room, peer, 2), /journal receipt failure/);
    assert.deepEqual(await store.getCollabJournal(session.id, 0), []);
    assert.equal((await store.getCollabCheckpoint(session.id))!.headRevision, 2);
    assert.deepEqual(room.snapshot(), before); assert.equal(sent.length, 0);
    await db.query('alter table collab_receipts disable trigger reject_journal_receipt');
    for (let i = 2; i <= 128; i++) await apply(room, peer, i);
    const journal = await store.getCollabJournal(session.id, 0);
    const checkpoint = await store.getCollabCheckpoint(session.id);
    const history = await store.listSessionRevisions(session.id);
    await db.query('alter table collab_receipts enable trigger reject_journal_receipt');
    await assert.rejects(apply(room, peer, 129), /journal receipt failure/);
    assert.deepEqual(await store.getCollabJournal(session.id, 0), journal, 'failed compaction does not delete the tail');
    assert.deepEqual(await store.getCollabCheckpoint(session.id), checkpoint);
    assert.deepEqual(await store.listSessionRevisions(session.id), history);
    await db.query('alter table collab_receipts disable trigger reject_journal_receipt');
    await apply(room, peer, 129);
    assert.deepEqual(await store.getCollabJournal(session.id, 0), []);
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, 130);
  } finally { await room.quiesce(); await db.end(); }
}));

test('SIGKILL after journal commit and before receipt recovers the edit exactly once (Postgres)', {
  skip: !process.env.LW_TEST_DATABASE_URL, timeout: 20000,
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
  const { session, peer, sent } = await setup(store);
  const initial = await Room.open(session, undefined, store);
  await apply(initial, peer, 1); await initial.quiesce();
  const worker = fork(new URL('./journal-crash-worker.ts', import.meta.url), [session.id, peer.userId], { execArgv: [], stdio: ['ignore', 'ignore', 'inherit', 'ipc'] });
  try {
    const [message] = await once(worker, 'message');
    assert.deepEqual(message, { committed: 3 });
    const exited = once(worker, 'exit'); worker.kill('SIGKILL');
    const [, signal] = await exited; assert.equal(signal, 'SIGKILL');
  } finally { worker.kill('SIGKILL'); }
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.LW_TEST_DATABASE_URL }); await db.connect();
  try {
    // Simulate the elapsed owner timeout without sleeping through a real 30s lease.
    await db.query("update sessions set collab_lease_until=clock_timestamp()-interval '1 second' where id=$1", [session.id]);
  } finally { await db.end(); }
  const recovered = await Room.open(session, undefined, store);
  try {
    assert.equal(recovered.snapshot().params.title, 'edit 2');
    assert.equal((await store.getCollabCheckpoint(session.id))!.revision, 2);
    assert.equal((await store.getCollabJournal(session.id, 2)).length, 1);
    await apply(recovered, peer, 2, false);
    const replay = sent.at(-1); assert.ok(replay?.t === 'receipt' && replay.checkpoint);
    const { checkpoint, serverClock, ...receipt } = replay;
    assert.equal(serverClock, 2);
    assert.equal(checkpoint.params.find(([key]) => key === 'title')?.[1].value, 'edit 2');
    assert.deepEqual(receipt, { t: 'receipt', batchId: 'batch-2', durableRevision: 3, acceptedIds: ['op-2'], rejectedIds: [] });
    assert.equal((await store.getSession(session.id))!.rev, 3);
  } finally { await recovered.quiesce(); }
}));

test('0036 upgrades an existing full checkpoint without losing deletion origins (Postgres)', {
  skip: !process.env.LW_TEST_DATABASE_URL,
}, async () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
  const { session, peer } = await setup(store);
  const { ReferenceCanvasDoc } = await import('@lolly-tools/core/canvas-op-v1');
  const doc = new ReferenceCanvasDoc();
  doc.apply({ k: 'remove', col: 'boxes', id: 'a', origin: { client: 'old-writer', clock: 50 } });
  await store.putSession({ ...session, inputs: { boxes: [] } });
  const { default: pg } = await import('pg');
  const db = new pg.Client({ connectionString: process.env.LW_TEST_DATABASE_URL }); await db.connect();
  try {
    // Reconstruct the previous deployed schema with an existing durable row.
    await db.query(`drop table collab_journal; alter table collab_checkpoints drop column head_revision;
      delete from schema_migrations where name='0036_collab_journal.sql'`);
    await db.query('insert into collab_checkpoints(session_id,revision,checkpoint) values($1,1,$2::jsonb)', [session.id, JSON.stringify(doc.checkpoint())]);
    assert.deepEqual(await runMigrations(process.env.LW_TEST_DATABASE_URL!), ['0036_collab_journal.sql']);
    assert.equal((await store.getCollabCheckpoint(session.id))!.headRevision, 1);
    const room = await Room.open(session, undefined, store);
    try {
      const late: CanvasOp = { k: 'add', col: 'boxes', id: 'a', row: { x: 5 }, orderKey: 'a', origin: { client: 'late', clock: 49 } };
      await room.applyBatch(peer, 'late', ['late'], [late], new Set([late]));
      assert.deepEqual(room.snapshot().collections?.boxes?.order, []);
      assert.equal((await store.getCollabJournal(session.id, 1)).length, 1);
    } finally { await room.quiesce(); }
  } finally { await db.end(); }
}));
