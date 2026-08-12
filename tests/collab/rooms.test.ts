// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * The ceilings on a room's own STATE (server/src/collab/rooms.ts).
 *
 * Everything else about rooms is exercised over a real socket (gateway.test.ts)
 * or against a real store (persistence.test.ts). These cases are neither: they
 * are about what one room may accumulate in memory, which no wire-level test can
 * reach without sending millions of frames. So the Room is driven directly, with
 * no persistence attached — the shape its own doc comment allows for ("it stays
 * optional so a room can be exercised as pure in-memory state").
 *
 * WHY THESE EXIST. MAX_ROW_FIELDS and MAX_SCALAR_CHARS bound ONE row; nothing
 * bounded the number of rows, collections or params, and the pinned contract's
 * `ensure` materialises a box for any `(col, id)` pair it has not seen. Since the
 * converged document is serialised WHOLE into `collab_room_snapshots.inputs` on
 * every cadence hit, an unbounded document is an unbounded jsonb write as well as
 * an unbounded heap. `origin.client` is likewise peer-chosen, so the replay
 * filter keyed by it needs a ceiling of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';

import type { SessionRecord } from '../../server/src/store/types.ts';
import {
  MAX_BOXES_PER_COLLECTION, MAX_COLLECTIONS_PER_ROOM, MAX_PARAMS_PER_ROOM, MAX_TRACKED_CLIENTS,
  Room, RoomRegistry, type RoomMember, type ServerFrame,
} from '../../server/src/collab/rooms.ts';

const now = new Date().toISOString();

function sessionOf(inputs: Record<string, unknown> = {}): SessionRecord {
  return {
    id: 'ses_caps', projectId: 'prj_caps', toolId: 'deck', toolVersion: '1.0.0',
    inputs, meta: {}, createdBy: 'u1', updatedBy: 'u1', rev: 1, updatedAt: now,
  };
}

function seatOf(id: string, role: RoomMember['role'] = 'writer'): RoomMember & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    id, userId: `user-${id}`, name: id, role, opVersion: CANVAS_OP_VERSION,
    send: (frame) => { sent.push(frame); },
    sent,
  };
}

const param = (key: string, client: string, clock: number): CanvasOp =>
  ({ k: 'param', key, value: 'v', origin: { client, clock } });

const add = (col: string, id: string, client: string, clock: number): CanvasOp =>
  ({ k: 'add', col, id, row: { heading: 'x' }, orderKey: 'a0', origin: { client, clock } });

test(`a room admits at most ${MAX_PARAMS_PER_ROOM} distinct params`, async () => {
  const room = await Room.open(sessionOf());
  const seat = seatOf('m1');
  room.join(seat);

  for (let i = 0; i < MAX_PARAMS_PER_ROOM; i++) {
    const op = param(`k${i}`, 'c', i + 1);
    assert.equal(room.admits(op), true, `param ${i} is inside the ceiling`);
    room.applyOps(seat, [op]);
  }
  assert.equal(room.admits(param('one-too-many', 'c', 9001)), false, 'a NEW key past the ceiling is refused');
  assert.equal(room.admits(param('k0', 'c', 9002)), true, 'a key the document already holds is still writable');

  // The refusal is real: an op the gateway pushes through anyway does not silently
  // become state, because the gateway asks `admits` before `applyOps`.
  assert.equal(Object.keys(room.snapshot().params).length, MAX_PARAMS_PER_ROOM);
});

test(`a room admits at most ${MAX_COLLECTIONS_PER_ROOM} collections and ${MAX_BOXES_PER_COLLECTION} boxes in one`, async () => {
  const room = await Room.open(sessionOf());
  const seat = seatOf('m1');
  room.join(seat);

  let clock = 1;
  for (let i = 0; i < MAX_COLLECTIONS_PER_ROOM; i++) {
    const op = add(`col${i}`, 'b0', 'c', clock++);
    assert.equal(room.admits(op), true, `collection ${i} is inside the ceiling`);
    room.applyOps(seat, [op]);
  }
  assert.equal(room.admits(add('col-too-many', 'b0', 'c', clock++)), false, 'a NEW collection past the ceiling is refused');
  assert.equal(room.admits(add('col0', 'b0', 'c', clock++)), true, 'an existing collection still takes writes');

  for (let i = 1; i < MAX_BOXES_PER_COLLECTION; i++) {
    room.applyOps(seat, [add('col0', `b${i}`, 'c', clock++)]);
  }
  assert.equal(room.admits(add('col0', 'b-too-many', 'c', clock++)), false, 'a NEW box past the ceiling is refused');
  assert.equal(room.admits(add('col0', 'b1', 'c', clock++)), true, 'an existing box is still writable');

  // Every box op mints a box, not just `add` — the contract's `ensure` does it for
  // geom/field/order/remove too, so all of them are counted.
  const geom: CanvasOp = { k: 'geom', col: 'col0', id: 'fresh', fields: { x: 1 }, origin: { client: 'c', clock: clock++ } };
  assert.equal(room.admits(geom), false, 'a geom op naming an unseen id is a box mint, and is capped like one');
  const remove: CanvasOp = { k: 'remove', col: 'col0', id: 'also-fresh', origin: { client: 'c', clock: clock++ } };
  assert.equal(room.admits(remove), false, 'so is a remove of an id the document has never seen');
});

test('the replay filter is bounded, and forgets the oldest client rather than growing', async () => {
  const room = await Room.open(sessionOf());
  const seat = seatOf('m1');
  const peer = seatOf('m2');
  room.join(seat);
  room.join(peer);

  // The first client's high-water mark, then enough distinct client ids to push it
  // out. `origin.client` is peer-chosen and unbounded in cardinality, so without a
  // ceiling this map grows for the life of the room — 200 fresh ids per message,
  // forever.
  room.applyOps(seat, [param('k', 'client-0', 5)]);
  for (let i = 1; i <= MAX_TRACKED_CLIENTS; i++) room.applyOps(seat, [param('k', `client-${i}`, 5)]);

  const before = peer.sent.filter((f) => f.t === 'ops').length;
  // The newest client is still remembered: its replay is deduped and nobody hears it.
  room.applyOps(seat, [param('k', `client-${MAX_TRACKED_CLIENTS}`, 5)]);
  assert.equal(
    peer.sent.filter((f) => f.t === 'ops').length, before,
    'a replay from a client still in the window is dropped, as it always was',
  );
  // The oldest was evicted, so its replay is treated as fresh — the documented cost
  // of the bound: one re-broadcast, against a map that otherwise never stops growing.
  room.applyOps(seat, [param('k', 'client-0', 5)]);
  assert.equal(
    peer.sent.filter((f) => f.t === 'ops').length, before + 1,
    'the evicted client is simply no longer remembered',
  );
});

test('a seeded document counts toward the ceilings it was seeded past', async () => {
  // The seed is ops too. A room that hydrates from a session already holding a
  // large document must not start its counters at zero.
  const inputs: Record<string, unknown> = {};
  for (let i = 0; i < MAX_PARAMS_PER_ROOM; i++) inputs[`k${i}`] = 'v';
  const room = await Room.open(sessionOf(inputs));
  assert.equal(room.admits(param('k0', 'c', 1)), true, 'a seeded key is writable');
  assert.equal(room.admits(param('brand-new', 'c', 1)), false, 'but the ceiling is already reached');
});

// ── admin introspection (OSS plans/100 §7, plans/14 §6) ───────────────────────

test('RoomRegistry.list() is empty with no rooms, and one snapshot per open room otherwise', async () => {
  const registry = new RoomRegistry();
  assert.deepEqual(registry.list(), [], 'nothing open yet');

  const room = await registry.acquire(sessionOf());
  assert.deepEqual(registry.list(), [room.snapshotForAdmin()]);
});

test('a room’s admin snapshot is a copy — names, roles, join times, counters, never a value', async () => {
  const room = await Room.open(sessionOf({ title: 'secret headline' }));
  const writer = seatOf('m1', 'writer');
  const onlooker = seatOf('m2', 'observer');
  room.join(writer);
  room.join(onlooker);
  room.applyOps(writer, [
    { k: 'param', key: 'title', value: 'new value nobody should see here', origin: { client: 'c', clock: 1 } },
  ]);

  const snap = room.snapshotForAdmin();
  assert.equal(snap.sessionId, 'ses_caps');
  assert.equal(snap.toolId, 'deck');
  assert.equal(snap.memberCount, 2);
  assert.equal(snap.writerCount, 1);
  assert.equal(snap.observerCount, 1);
  // Seeding the document does not count as an applied op — only what a member
  // actually sent does.
  assert.equal(snap.opsApplied, 1);
  assert.equal(typeof snap.startedAt, 'number');
  assert.deepEqual(snap.members.map((m) => m.role).sort(), ['observer', 'writer']);
  assert.deepEqual(snap.members.map((m) => m.name).sort(), ['m1', 'm2']);
  for (const m of snap.members) {
    assert.equal(typeof m.joinedAt, 'number');
    assert.deepEqual(Object.keys(m).sort(), ['joinedAt', 'name', 'role'], 'no userId, no presence');
  }
  const dump = JSON.stringify(snap);
  assert.ok(!dump.includes('new value nobody should see here'), 'never the value a member just wrote');
  assert.ok(!dump.includes('secret headline'), 'not even the value the room was seeded from');

  // It is a COPY: mutating what came back must not touch the room.
  snap.members.length = 0;
  assert.equal(room.snapshotForAdmin().members.length, 2, 'the room itself is untouched');
});

test('a departed member drops out of the admin snapshot immediately', async () => {
  const room = await Room.open(sessionOf());
  const seat = seatOf('m1');
  room.join(seat);
  assert.equal(room.snapshotForAdmin().memberCount, 1);
  room.leave(seat.id);
  assert.equal(room.snapshotForAdmin().memberCount, 0);
});
