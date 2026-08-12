// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * Room persistence — snapshot cadence, quiesce → session revision, outbox-replay
 * dedup, and crash recovery (server/src/collab/persistence.ts + the lifecycle
 * half in rooms.ts; lolly-work plans/14 §6, OSS plans/100 §7 items 3, 4, 10).
 *
 * DRIVER-PARAMETERISED, like tests/store-conformance.ts: every case runs against
 * the memory store always, and against Postgres when LW_TEST_DATABASE_URL is set.
 * Persistence is the one collab surface where the driver can genuinely disagree —
 * jsonb round-trips a blocks array, `sessions.updated_by` is a FOREIGN KEY to
 * users(id) (which is why a room's revision `actor` is 'collab' but its
 * `updatedBy` must stay a real user), and the snapshot row is an `on conflict`
 * upsert. Asserting all that on a Map alone would assert the wrong thing.
 *
 * It drives Room/RoomRegistry DIRECTLY rather than over a websocket: the wire,
 * the auth gates and the policy veto are gateway.test.ts's subject, and
 * everything here is about what reaches the store. Ops therefore arrive
 * pre-authorized, exactly as `applyOps`'s contract says they do.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { CanvasOp, Scalar } from '@lolly-tools/core/canvas-op-v1';

import { createMemoryStore } from '../../server/src/store/memory.ts';
import type { SessionRecord, Store } from '../../server/src/store/types.ts';
import { RoomRegistry, type Room, type RoomMember, type ServerFrame } from '../../server/src/collab/rooms.ts';
import {
  COLLAB_ACTOR, SNAPSHOT_EVERY_BATCHES, SNAPSHOT_EVERY_OPS, createRoomPersistence,
} from '../../server/src/collab/persistence.ts';
import { guestActor } from '../../server/src/iam/sessions.ts';
import { withFreshPostgres } from '../pg-test-schema.ts';

// ── fixtures ──────────────────────────────────────────────────────────────────

const TOOL_ID = 'deck';

/** A member as the gateway would seat one, with its outbound frames captured. */
function seatOf(id: string, userId: string): RoomMember & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    id, userId, name: id, role: 'writer', opVersion: CANVAS_OP_VERSION,
    send: (frame) => { sent.push(frame); },
    sent,
  };
}

/** A guest seat, as the gateway actually constructs one (`gateway.ts`'s
 *  `admitGuest`): `userId` is the guest's principal id (never a real user),
 *  and `guestLinkId` is set — which is the ONE thing that makes `Room.applyOps`
 *  attribute the write to the guest rather than to a member (persistence.ts
 *  `RoomWriter` / `roomRevisionActor`). */
function guestSeatOf(id: string, linkId: string): RoomMember & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    id, userId: guestActor(linkId), name: `${id} (guest)`, role: 'writer', opVersion: CANVAS_OP_VERSION,
    guestLinkId: linkId,
    send: (frame) => { sent.push(frame); },
    sent,
  };
}

const opsFrames = (seat: { sent: ServerFrame[] }): ServerFrame[] => seat.sent.filter((f) => f.t === 'ops');

const param = (key: string, value: Scalar, client: string, clock: number): CanvasOp =>
  ({ k: 'param', key, value, origin: { client, clock } });

const field = (id: string, col: string, name: string, value: Scalar, client: string, clock: number): CanvasOp =>
  ({ k: 'field', id, col, field: name, value, origin: { client, clock } });

interface Fixture {
  session: SessionRecord;
  userId: string;
}

/** One user + project + session per case, so cases cannot leak into each other
 *  (and so the Postgres FKs are satisfied the same way the app satisfies them). */
async function seed(store: Store, tag: string, inputs: Record<string, unknown>): Promise<Fixture> {
  const now = new Date().toISOString();
  const user = await store.upsertUserBySub({
    sub: `collab:${tag}`, email: `${tag}@collab.test`, firstname: 'Ada', lastname: 'Room',
    groups: ['team'], role: 'member',
  });
  await store.putProject({
    id: `prj_${tag}`, name: `Collab ${tag}`, visibility: 'private', ownerId: user.id, createdAt: now,
  });
  const session: SessionRecord = {
    id: `ses_${tag}`, projectId: `prj_${tag}`, toolId: TOOL_ID, toolVersion: '1.0.0',
    inputs, meta: { label: tag }, createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: now,
  };
  await store.putSession(session);
  return { session, userId: user.id };
}

/** The stored session, which every case reads back rather than assuming. */
const reload = async (store: Store, id: string): Promise<SessionRecord> => {
  const s = await store.getSession(id);
  assert.ok(s, `session ${id} exists`);
  return s;
};

// ── the suite ─────────────────────────────────────────────────────────────────

async function runCollabPersistence(t: TestContext, store: Store): Promise<void> {
  const persistence = createRoomPersistence({ store });
  const registryFor = (): RoomRegistry => new RoomRegistry(persistence);

  await t.test(`the cadence fires at ${SNAPSHOT_EVERY_BATCHES} batches, and not before`, async () => {
    const { session, userId } = await seed(store, 'cadence-batches', { title: 'seed' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);

    for (let i = 1; i < SNAPSHOT_EVERY_BATCHES; i++) room.applyOps(alice, [param('title', `v${i}`, 'a', i)]);
    await room.flush();
    assert.equal(
      await store.getCollabSnapshot(session.id), null,
      `${SNAPSHOT_EVERY_BATCHES - 1} batches is under the threshold — nothing persisted yet`,
    );

    room.applyOps(alice, [param('title', 'v20', 'a', SNAPSHOT_EVERY_BATCHES)]);
    await room.flush();
    const snap = await store.getCollabSnapshot(session.id);
    assert.equal(snap?.inputs['title'], 'v20', 'the snapshot carries the CONVERGED document, not a delta');
    assert.equal(snap?.baseRev, session.rev, 'stamped with the session rev it was taken against');
    assert.equal(snap?.ops, SNAPSHOT_EVERY_BATCHES);

    // A snapshot is a crash-recovery row, NOT a revision: history is untouched.
    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev, 'the session rev does not move on a snapshot');
    assert.equal(stored.inputs['title'], 'seed');
    assert.equal((await store.listSessionRevisions(session.id)).length, 0, 'no revision per snapshot');
  });

  await t.test(`…and at ${SNAPSHOT_EVERY_OPS} ops, whichever comes first`, async () => {
    const { session, userId } = await seed(store, 'cadence-ops', { title: 'seed' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);

    // ONE batch — far under the batch threshold — but a drag gesture's worth of
    // ops, which is exactly the case the batch counter alone would let sit
    // unpersisted.
    const burst = Array.from({ length: SNAPSHOT_EVERY_OPS }, (_, i) => param('title', `v${i}`, 'a', i + 1));
    room.applyOps(alice, burst);
    await room.flush();
    const snap = await store.getCollabSnapshot(session.id);
    assert.equal(snap?.ops, SNAPSHOT_EVERY_OPS, 'one batch tripped the op ceiling');
    assert.equal(snap?.inputs['title'], `v${SNAPSHOT_EVERY_OPS - 1}`, 'highest Lamport clock won');
  });

  await t.test('a replayed outbox batch is dropped: no double-count, no re-broadcast', async () => {
    const { session, userId } = await seed(store, 'dedup', {
      title: 'seed', slides: [{ id: 'row-a', heading: 'One', body: 'first' }],
    });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    const bob = seatOf('m2', userId);
    room.join(alice);
    room.join(bob);

    // ONE gesture — `damageToOps` mints a single origin for all of a gesture's
    // ops, so both of these carry clock 7. A dedup that recorded as it went would
    // let the first op cancel the second.
    const gesture: CanvasOp[] = [
      field('row-a', 'slides', 'heading', 'One!', 'ca', 7),
      field('row-a', 'slides', 'body', 'first!', 'ca', 7),
    ];
    room.applyOps(alice, gesture);
    assert.equal(room.acceptedOps, 2, 'a shared clock must not cancel the rest of its own gesture');
    assert.equal(opsFrames(bob).length, 1, 'the peer heard it once');

    room.applyOps(alice, gesture); // the outbox replays the same bytes on rejoin
    assert.equal(room.acceptedOps, 2, 'a replay adds nothing to the counters');
    assert.equal(opsFrames(bob).length, 1, '…and peers never hear it twice');

    // A PARTIAL replay — the outbox holds one acked gesture and one that never
    // landed — keeps only what is genuinely new.
    room.applyOps(alice, [...gesture, param('title', 'after', 'ca', 8)]);
    assert.equal(room.acceptedOps, 3);
    assert.equal(opsFrames(bob).length, 2);
    const relayed = opsFrames(bob)[1] as { ops: CanvasOp[] };
    assert.equal(relayed.ops.length, 1, 'only the new op is relayed');

    // Dedup is per client: a different client at the same clock is a different op.
    room.applyOps(bob, [param('title', 'from bob', 'cb', 7)]);
    assert.equal(room.acceptedOps, 4);
  });

  await t.test('quiesce lands the converged document as exactly one session revision', async () => {
    const { session, userId } = await seed(store, 'quiesce', {
      title: 'Draft',
      accent: '#0c322c',
      slides: [{ id: 'row-a', heading: 'One' }, { id: 'row-b', heading: 'Two' }],
      // Not expressible in canvas-op v1.1 (rooms.ts reports it as `unsynced`);
      // the write-back must carry it through untouched.
      logo: { assetId: 'suse/logo/primary', width: 120 },
    });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);

    room.applyOps(alice, [param('title', 'Final', 'ca', 2)]);
    room.applyOps(alice, [field('row-b', 'slides', 'heading', 'Two!', 'ca', 3)]);
    room.applyOps(alice, [
      { k: 'add', id: 'row-c', col: 'slides', row: { heading: 'Three' }, orderKey: 'k', origin: { client: 'ca', clock: 4 } },
    ]);

    room.leave(alice.id);
    assert.equal(await registry.releaseIfEmpty(room), true, 'the last member leaving disposes the room');
    assert.equal(registry.size(), 0);

    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev + 1, 'one rev bump for the whole room, not one per batch');
    assert.equal(stored.inputs['title'], 'Final');
    assert.equal(stored.inputs['accent'], '#0c322c', 'an untouched param survives the write-back');
    assert.deepEqual(
      stored.inputs['logo'], { assetId: 'suse/logo/primary', width: 120 },
      'an input the document cannot express is preserved verbatim, never dropped',
    );
    const slides = stored.inputs['slides'] as Array<Record<string, unknown>>;
    assert.deepEqual(slides.map((s) => s['id']), ['row-a', 'row-b', 'row-c'], 'converged paint order');
    assert.equal(slides[1]?.['heading'], 'Two!');
    assert.equal(slides[2]?.['heading'], 'Three');
    assert.equal(stored.updatedBy, userId, 'updatedBy stays a real user — it is an FK to users(id)');

    const revs = await store.listSessionRevisions(session.id);
    assert.equal(revs.length, 1, 'ONE history: a room writes an ordinary revision, not a parallel log');
    assert.equal(revs[0]?.rev, stored.rev);
    assert.equal(revs[0]?.actor, COLLAB_ACTOR, "a converged document has no single author — actor is 'collab'");
    assert.deepEqual(revs[0]?.inputs, stored.inputs);
    assert.deepEqual(revs[0]?.meta, session.meta, 'meta rides through untouched');
    assert.equal(await store.getCollabSnapshot(session.id), null, 'the quiesce clears the recovery row');
  });

  await t.test(
    "a guest's quiesce names the guest on the revision (free text) and never touches updated_by (FK to users)",
    async () => {
      // The guest wave's own coverage of this (tests/collab/guests.test.ts) drives
      // the full HTTP/WS gateway against the memory store only, so it can assert
      // the SHAPE of the write-back but not that the write path is actually safe
      // against the Postgres schema: `session_revisions.actor` is free text
      // (migrations/0004_sessions.sql), so any string lands there, but
      // `sessions.updated_by` is `references users(id)` — a guest id written there
      // would be a foreign-key violation, not a logic bug a memory store could ever
      // surface. This leg proves the write path never attempts it, on the driver
      // where attempting it would actually fail.
      const { session, userId } = await seed(store, 'guest-write', { title: 'before the guest' });
      const registry = registryFor();
      const room = await registry.acquire(session);
      const guest = guestSeatOf('g1', 'lnk_guest_pg');
      room.join(guest);
      room.applyOps(guest, [param('title', 'after the guest', 'g5', 1)]);
      room.leave(guest.id);
      assert.equal(await registry.releaseIfEmpty(room), true);

      const stored = await reload(store, session.id);
      assert.equal(stored.inputs['title'], 'after the guest', 'the guest edit landed as an ordinary revision');
      assert.equal(
        stored.updatedBy, userId,
        'updated_by is a FOREIGN KEY to users(id) in Postgres — a guest write must leave it exactly as it was',
      );

      const revs = await store.listSessionRevisions(session.id);
      assert.equal(revs.length, 1, 'one history — a guest room writes a normal session revision, not a parallel log');
      assert.equal(
        revs[0]?.actor, guestActor('lnk_guest_pg'),
        'session_revisions.actor is free text, so the guest principal is attributed there instead',
      );
      assert.notEqual(revs[0]?.actor, COLLAB_ACTOR, 'not the anonymous room actor a member-written room gets');
      assert.notEqual(revs[0]?.actor, userId, 'and not the seed user — the guest, not a member, made this edit');
    },
  );

  await t.test('a room that changed nothing — presence only — writes no revision at all', async () => {
    const { session, userId } = await seed(store, 'noop', { title: 'untouched' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    const bob = seatOf('m2', userId);
    room.join(alice);
    room.join(bob);

    // The whole presence path, exercised: it must reach neither the snapshot row
    // nor the session (plans/100 §7 item 5).
    room.relayPresence(alice, { cursor: { x: 0.4, y: 0.6 }, selection: ['row-a'], focus: 'title', chat: 'hi' });
    room.relayPresence(bob, { cursor: { x: 0.1, y: 0.2 }, selection: [] });
    await room.flush();
    assert.equal(await store.getCollabSnapshot(session.id), null, 'presence never snapshots');

    room.leave(alice.id);
    room.leave(bob.id);
    assert.equal(await registry.releaseIfEmpty(room), true);
    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev, 'no rev bump');
    assert.deepEqual(stored.inputs, session.inputs);
    assert.equal(
      (await store.listSessionRevisions(session.id)).length, 0,
      'history is bounded — a revision per join/leave churn would evict real history to record nothing',
    );
  });

  await t.test('a room whose edits cancelled back to the stored value also writes nothing', async () => {
    const { session, userId } = await seed(store, 'cancelled', { title: 'original' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'typo', 'ca', 2)]);
    room.applyOps(alice, [param('title', 'original', 'ca', 3)]);
    room.leave(alice.id);
    assert.equal(await registry.releaseIfEmpty(room), true);
    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev, 'ops were accepted, but the document converged back onto what is stored');
    assert.equal((await store.listSessionRevisions(session.id)).length, 0);
    assert.equal(await store.getCollabSnapshot(session.id), null);
  });

  await t.test('a crash-lost quiesce is recovered from the snapshot on the next join', async () => {
    const { session, userId } = await seed(store, 'crash', {
      title: 'before the crash', slides: [{ id: 'row-a', heading: 'One' }],
    });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    for (let i = 1; i <= SNAPSHOT_EVERY_BATCHES; i++) {
      room.applyOps(alice, [param('title', `v${i}`, 'ca', i)]);
    }
    room.applyOps(alice, [field('row-a', 'slides', 'heading', 'One!', 'ca', 99)]);
    await room.flush();
    assert.ok(await store.getCollabSnapshot(session.id), 'the room had persisted a snapshot');

    // …and here the process dies. No quiesce, no dispose — the surviving snapshot
    // row IS the signal, so a brand-new registry is a restart.
    const restarted = registryFor();
    const recovered = await restarted.acquire(await reload(store, session.id));
    assert.equal(recovered.recovered, true, 'the room reports that it recovered');

    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev + 1, 'recovery commits immediately — it must not wait for someone to edit');
    assert.equal(stored.inputs['title'], `v${SNAPSHOT_EVERY_BATCHES}`);
    const revs = await store.listSessionRevisions(session.id);
    assert.equal(revs.length, 1);
    assert.equal(revs[0]?.actor, COLLAB_ACTOR);
    assert.equal(await store.getCollabSnapshot(session.id), null, 'recovery consumes the row');

    // The recovered ROOM is seeded from the snapshot, not from the pre-crash
    // session — a joiner sees the work the crash swallowed.
    const doc = recovered.snapshot();
    assert.equal(doc.params['title'], `v${SNAPSHOT_EVERY_BATCHES}`);
    assert.equal(
      doc.collections?.['slides']?.boxes['row-a']?.['heading'], 'One!',
      'a collection edit made after the last clean save survives too',
    );

    // A second restart with nothing outstanding recovers nothing (the row is the
    // only signal, and it is gone).
    const again = await registryFor().acquire(await reload(store, session.id));
    assert.equal(again.recovered, false);
    assert.equal((await reload(store, session.id)).rev, stored.rev, 'no second recovery revision');
  });

  await t.test('a snapshot the stored session has moved past is discarded, not replayed', async () => {
    const { session } = await seed(store, 'stale', { title: 'v1' });
    await store.putCollabSnapshot({
      sessionId: session.id, inputs: { title: 'room state from before the crash' },
      baseRev: session.rev, ops: 9, updatedAt: new Date().toISOString(),
    });
    // An ordinary PUT lands while nobody is in the room — L0 moved on.
    await store.putSession({ ...session, inputs: { title: 'v2' }, rev: session.rev + 1, updatedAt: new Date().toISOString() });

    const room = await registryFor().acquire(await reload(store, session.id));
    assert.equal(room.recovered, false, 'replaying stale room state over newer work is worse than losing it');
    assert.equal(room.snapshot().params['title'], 'v2', 'the room seeds from the newer stored session');
    assert.equal(await store.getCollabSnapshot(session.id), null, 'the stale row is dropped, not left to rot');
    assert.equal((await reload(store, session.id)).rev, session.rev + 1, 'no revision written');
  });

  await t.test('a rejoin racing the disposal waits for the revision instead of re-seeding stale inputs', async () => {
    const { session, userId } = await seed(store, 'race', { title: 'before' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'after', 'ca', 2)]);
    room.leave(alice.id);

    // Dispose (quiesce + drop) WITHOUT awaiting, then immediately re-acquire with
    // the stale pre-quiesce record — the shape the gateway has by construction,
    // since it read the session at upgrade time.
    const disposing = registry.releaseIfEmpty(room);
    const next = await registry.acquire(session);
    assert.equal(await disposing, true);
    assert.notEqual(next, room, 'a fresh room, not the disposed one');
    assert.equal(
      next.snapshot().params['title'], 'after',
      'the rejoin waited for the revision and re-read the session — it did not undo the quiesce',
    );
    assert.equal((await reload(store, session.id)).rev, session.rev + 1, 'exactly one quiesce happened');
  });

  await t.test('an empty room that never saw a leave is swept after the grace period', async () => {
    const { session, userId } = await seed(store, 'sweep', { title: 'before' });
    const graceMs = 50;
    const registry = new RoomRegistry(persistence, graceMs);
    const room = await registry.acquire(session);
    // A socket that died between `acquire` and `join`: a room with a document and
    // nobody in it, which no leave handler will ever dispose.
    const ghost = seatOf('m1', userId);
    room.join(ghost);
    room.applyOps(ghost, [param('title', 'unsaved', 'ca', 2)]);
    room.leave(ghost.id);

    const t0 = Date.now();
    assert.deepEqual(await registry.sweep(t0), [], 'the first sweep only starts the clock');
    assert.deepEqual(await registry.sweep(t0 + graceMs - 1), [], 'still inside the grace period');
    const swept = await registry.sweep(t0 + graceMs);
    assert.equal(swept.length, 1, 'swept once the grace elapsed');
    assert.equal(registry.size(), 0);
    assert.equal((await reload(store, session.id)).inputs['title'], 'unsaved', 'the sweep quiesced it, losing nothing');
  });

  await t.test('drain quiesces every room, occupied or not', async () => {
    const { session, userId } = await seed(store, 'drain', { title: 'before' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice); // still seated — this is a shutdown, not a leave
    room.applyOps(alice, [param('title', 'shutdown-safe', 'ca', 2)]);

    const drained = await registry.drain();
    assert.equal(drained.length, 1);
    assert.equal(registry.size(), 0);
    assert.equal((await reload(store, session.id)).inputs['title'], 'shutdown-safe');
    assert.equal((await store.listSessionRevisions(session.id)).length, 1);
  });

  await t.test('a session tombstoned mid-room is never resurrected by its quiesce', async () => {
    const { session, userId } = await seed(store, 'tombstone', { title: 'before' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'written while alive', 'ca', 2)]);
    const deletedAt = new Date().toISOString();
    await store.putSession({ ...session, deletedAt, updatedAt: deletedAt });

    room.leave(alice.id);
    assert.equal(await registry.releaseIfEmpty(room), true);
    const stored = await reload(store, session.id);
    assert.equal(stored.deletedAt, deletedAt, 'still tombstoned');
    assert.equal(stored.rev, session.rev, 'no rev bump for a deleted session');
    assert.equal(stored.inputs['title'], 'before');
    assert.equal(await store.getCollabSnapshot(session.id), null, 'and no recovery row to resurrect it later');
  });

  await t.test('a live PUT and a room merge per input id rather than clobbering', async () => {
    const { session, userId } = await seed(store, 'merge', { title: 'before', accent: '#000000' });
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'from the room', 'ca', 2)]);

    // An ordinary PUT lands on a DIFFERENT input while the room is live.
    await store.putSession({
      ...session, inputs: { title: 'before', accent: '#30ba78', tagline: 'added by the PUT' },
      rev: session.rev + 1, updatedAt: new Date().toISOString(),
    });

    room.leave(alice.id);
    assert.equal(await registry.releaseIfEmpty(room), true);
    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev + 2, 'the quiesce succeeds the PUT rather than racing its rev');
    assert.equal(stored.inputs['title'], 'from the room', 'the room wins the keys it governs');
    assert.equal(stored.inputs['accent'], '#30ba78', '…and the PUT keeps the rest');
    assert.equal(stored.inputs['tagline'], 'added by the PUT', 'including inputs the room never knew about');
  });

  await t.test('a PUT landing INSIDE the write-back is merged rather than clobbered', async () => {
    // The merge documented on `docToInputs` ("the room wins what it edited, the PUT
    // keeps everything else") only holds if the PUT lands before the write-back
    // reads its base. This case makes it land AFTER — the interval an un-CAS'd
    // read-modify-write cannot survive: it would write the room's inputs over a
    // base it read at the old rev, discarding the PUT's inputs AND its meta, and
    // its own `session_revisions` row would then be dropped by the
    // `(session_id, rev)` conflict — leaving history recording the user's revision
    // while `sessions.inputs` holds the room's.
    const { session, userId } = await seed(store, 'cas-put', { title: 'before', accent: '#000000' });
    let armed = false;
    let landed = false;
    const racing: Store = {
      ...store,
      async getSession(id) {
        const read = await store.getSession(id);
        if (armed && !landed && id === session.id && read) {
          landed = true;
          const at = new Date().toISOString();
          const inputs = { ...read.inputs, accent: '#30ba78', tagline: 'from the PUT' };
          await store.putSession({ ...read, inputs, meta: { label: 'PUT touched this' }, rev: read.rev + 1, updatedBy: userId, updatedAt: at });
          await store.appendSessionRevision({ sessionId: id, rev: read.rev + 1, inputs, meta: { label: 'PUT touched this' }, actor: userId, at });
        }
        // The pre-PUT record, which is the whole point: the write-back is holding a
        // base that has already moved under it.
        return read;
      },
    };

    const registry = new RoomRegistry(createRoomPersistence({ store: racing }));
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'from the room', 'ca', 2)]);
    room.leave(alice.id);
    armed = true;
    assert.equal(await registry.releaseIfEmpty(room), true);
    assert.equal(landed, true, 'the racing PUT really did land inside the write-back');

    const stored = await reload(store, session.id);
    assert.equal(stored.rev, session.rev + 2, 'the room succeeded the PUT rather than overwriting its rev');
    assert.equal(stored.inputs['title'], 'from the room', 'the room still wins the key it edited');
    assert.equal(stored.inputs['accent'], '#30ba78', 'the PUT is not rolled back');
    assert.equal(stored.inputs['tagline'], 'from the PUT', 'nor is the key it added');
    assert.equal(stored.meta['label'], 'PUT touched this', 'and its meta survives — the room never re-writes meta it did not read');

    const revs = await store.listSessionRevisions(session.id);
    assert.deepEqual(revs.map((r) => r.rev), [session.rev + 2, session.rev + 1], 'both revisions exist, neither dropped');
    assert.equal(revs[1]?.actor, userId, 'the user keeps their revision');
    assert.equal(revs[0]?.actor, COLLAB_ACTOR, 'and the room gets its own');
  });

  await t.test('a DELETE landing INSIDE the write-back is never undone by it', async () => {
    // The same interval, with a tombstone instead of a PUT. A read-modify-write
    // carries `deletedAt: undefined` from the record it read before the DELETE, and
    // writing that back sets `deleted_at` to NULL — resurrecting a session the
    // DELETE route exists to make unresurrectable.
    const { session, userId } = await seed(store, 'cas-delete', { title: 'before' });
    let armed = false;
    let landed = false;
    let deletedAt = '';
    const racing: Store = {
      ...store,
      async getSession(id) {
        const read = await store.getSession(id);
        if (armed && !landed && id === session.id && read) {
          landed = true;
          deletedAt = new Date().toISOString();
          await store.putSession({ ...read, deletedAt, updatedAt: deletedAt });
        }
        return read;
      },
    };

    const registry = new RoomRegistry(createRoomPersistence({ store: racing }));
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'written while alive', 'ca', 2)]);
    room.leave(alice.id);
    armed = true;
    assert.equal(await registry.releaseIfEmpty(room), true);
    assert.equal(landed, true, 'the racing DELETE really did land inside the write-back');

    const stored = await reload(store, session.id);
    assert.equal(stored.deletedAt, deletedAt, 'still tombstoned');
    assert.equal(stored.rev, session.rev, 'no rev bump for a deleted session');
    assert.equal(stored.inputs['title'], 'before', 'and no inputs written into a dead session');
    assert.equal((await store.listSessionRevisions(session.id)).length, 0, 'no revision either');
    assert.equal(await store.getCollabSnapshot(session.id), null, 'and no recovery row to resurrect it later');
  });

  await t.test('quiesce and recovery are audited with counters and rev numbers, never input values', async () => {
    const { session, userId } = await seed(store, 'audit', { title: 'before' });
    const before = (await store.listAudit()).length;
    const registry = registryFor();
    const room = await registry.acquire(session);
    const alice = seatOf('m1', userId);
    room.join(alice);
    room.applyOps(alice, [param('title', 'a secret headline', 'ca', 2)]);
    room.leave(alice.id);
    await registry.releaseIfEmpty(room);

    const added = (await store.listAudit()).slice(before);
    const quiesce = added.filter((e) => e.action === 'collab.quiesce');
    assert.equal(quiesce.length, 1, 'one quiesce event per room close that wrote');
    const payload = quiesce[0]?.payload as { rev: number; ops: number; basedOnRev: number };
    assert.equal(payload.rev, session.rev + 1);
    assert.equal(payload.ops, 1);
    assert.equal(payload.basedOnRev, session.rev);
    assert.ok(
      !JSON.stringify(added).includes('a secret headline'),
      'the audit log carries counters and rev numbers — never an input value',
    );
  });
}

// ── the two drivers ───────────────────────────────────────────────────────────

test('memory store: collab room persistence', async (t) => {
  await runCollabPersistence(t, createMemoryStore());
});

const url = process.env.LW_TEST_DATABASE_URL;

test('postgres store: collab room persistence', { skip: !url && 'set LW_TEST_DATABASE_URL to run' }, async (t) => {
  await withFreshPostgres(url as string, (store) => runCollabPersistence(t, store));
});
