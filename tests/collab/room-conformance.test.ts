// SPDX-License-Identifier: MPL-2.0
/**
 * THE THIRD IMPLEMENTATION (OSS plans/100 §10 "three-way conformance", plans/99
 * §8). The shared `runConvergenceSuite` - shipped inside `@lolly-tools/core` so
 * both repos run the SAME BYTES - driven against the gateway's live room.
 *
 * The three implementations the plan names are the OSS `ReferenceCanvasDoc`, the
 * Track A provider, and lolly-work's room; a fourth (the Yjs adapter, the
 * multi-replica follow-up) joins when `yjs` is installed. Nothing here duplicates
 * the suite: it is imported, and a divergence in the room shows up as the same
 * failure message the OSS run would print.
 *
 * WHAT THE ADAPTER BELOW IS, PRECISELY. `Room.ingestOp` - the document DOOR - is
 * genuinely shared: it is the one server-side caller of `ingestOp` (`applyOps`
 * calls it per op, rooms.ts), so nothing was forked to build this leg, and
 * `state()` is the room's real join-ack document, ROUND-TRIPPED THROUGH JSON so
 * the leg covers the wire encoding (`WireDocState`) as well as the CRDT. But the
 * adapter's `apply()` is NOT the gateway's real acceptance path - it is this
 * file's own hand-rolled re-implementation of a SUBSET of `vetoOps`, in a
 * different order, over a `Room` seeded with no manifest at all. It calls, in
 * order:
 *
 *   1. `Room.admits` - the room-state ceiling, which is the LAST veto in the
 *      real gateway (gateway.ts `vetoOps` calls it after the overlay - this
 *      adapter calls it FIRST);
 *   2. `resolveInputAccess` (policy/overlay.ts, the real function) with an
 *      overlay that locks nothing and a writer principal's groups - the overlay
 *      veto, asserted to pass rather than assumed;
 *   3. `Room.ingestOp` - the document door `applyOps` feeds one op at a time.
 *
 * Absent, and therefore NOT covered by this leg at all: `parseOp` (the wire
 * parser and its hardening), the `declared`/`types` input whitelist, and the
 * `WRONG_LANE` lane check - three of the four things `vetoOps` actually does
 * before it ever reaches `resolveInputAccess`. This suite proves the DOCUMENT
 * converges under the door both paths share; it does not exercise the real
 * acceptance path end to end.
 *
 * TWO DELIBERATE DIVERGENCES FROM THE SOCKET PATH, both stated rather than
 * hidden, and both asserted below in `the two gates the suite cannot cross`:
 *
 *   (a) THE REPLAY FILTER IS NOT IN FRONT. `applyOps` drops an op whose
 *       `origin.clock` does not beat the highest already accepted for that
 *       `origin.client` - a transport-level dedup that is order-SENSITIVE by
 *       construction, while the property under test is that the DOCUMENT is
 *       order-INDEPENDENT (the suite applies one op log in many interleavings).
 *       Running the suite through the filter would assert something the filter
 *       never promised: every shuffle would lose an op and every seed would fail.
 *       `Room.ingestOp` is exactly the per-op body `applyOps` runs after the
 *       filter, so the document authority under test is the real one.
 *   (b) THE CANVAS COLLECTION IS UNGOVERNABLE, so the gateway refuses it. Most of
 *       the suite's ops carry no `col` (they are v1.0 canvas-box ops), and
 *       `governedInputId` returns null for those - a real socket answers
 *       `COLLECTION_REQUIRED`, because a box op that names no input is a write no
 *       overlay can be about. That refusal is a GATEWAY policy, not a document
 *       property, and the room's document must still converge on the ops it does
 *       accept; the collection-scoped half of the suite (`col`-scoped fuzz, the
 *       two collection cases) crosses the overlay veto in full.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { runConvergenceSuite } from '@lolly-tools/core/canvas-op-testkit';
import { DEFAULT_GEOMETRY_FIELDS, damageToOps, opsToDamage } from '@lolly-tools/core/canvas-op-v1';
import type {
  Awareness,
  BoxId,
  BoxRow,
  CanvasDocState,
  CanvasOp,
  CanvasSyncAdapter,
  Damage,
  OpOrigin,
  ParamValue,
} from '@lolly-tools/core/canvas-op-v1';
import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';

import { governedInputId } from '../../server/src/collab/gateway.ts';
import { resolveInputAccess } from '../../server/src/policy/overlay.ts';
import { Room, type RoomMember, type ServerFrame, type WireDocState } from '../../server/src/collab/rooms.ts';
import type { SessionRecord } from '../../server/src/store/types.ts';

/** The groups a writer principal carries. Any list works - the point is that the
 *  overlay consulted below is a real one that happens to lock nothing. */
const WRITER_GROUPS = ['team-eng'];

const now = new Date().toISOString();

function sessionOf(inputs: Record<string, unknown> = {}): SessionRecord {
  return {
    id: 'ses_conf', projectId: 'prj_conf', toolId: 'deck', toolVersion: '1.0.0',
    inputs, meta: {}, createdBy: 'u1', updatedBy: 'u1', rev: 1, updatedAt: now,
  };
}

/** A seated writer. `send` collects rather than drops, so a case that wants to
 *  prove a frame did NOT go out (presence) can look. */
function seatOf(id: string): RoomMember & { sent: ServerFrame[] } {
  const sent: ServerFrame[] = [];
  return {
    id, userId: `user-${id}`, name: id, role: 'writer', opVersion: CANVAS_OP_VERSION,
    send: (frame) => { sent.push(frame); },
    sent,
  };
}

// ── the room-backed adapter ───────────────────────────────────────────────────

let adapterN = 0;

/** `WireDocState` (what a joiner receives) → `CanvasDocState` (what the contract
 *  compares). The inverse of rooms.ts's `toWire`; `collections` stays ABSENT when
 *  the wire omits it, which is the v1.0-shaped-state guarantee. */
function fromWire(wire: WireDocState): CanvasDocState {
  const state: CanvasDocState = {
    order: wire.order,
    boxes: new Map<BoxId, BoxRow>(Object.entries(wire.boxes)),
    params: new Map<string, ParamValue>(Object.entries(wire.params)),
  };
  if (wire.collections) {
    state.collections = new Map(
      Object.entries(wire.collections).map(([col, c]) => [
        col,
        { order: c.order, boxes: new Map<BoxId, BoxRow>(Object.entries(c.boxes)) },
      ]),
    );
  }
  return state;
}

class RoomAdapter implements CanvasSyncAdapter {
  readonly room: Room;
  readonly seat: RoomMember & { sent: ServerFrame[] };
  private readonly clientId: string;
  private clock = 0;
  /** Ops this adapter has pushed through the room, split by whether the gateway's
   *  own `governedInputId` could name an input for them - the (b) divergence,
   *  counted so the file can assert the split is what it claims. */
  governed = 0;
  ungoverned = 0;

  constructor() {
    this.clientId = `lw:conf-${adapterN++}`;
    this.room = Room.create(sessionOf());
    this.seat = seatOf('m1');
    this.room.join(this.seat);
  }

  apply(op: CanvasOp): void {
    // 1. the room-state ceiling - called FIRST here; it is the LAST veto in the
    //    real `vetoOps` (this adapter does not reproduce the ordering, only the
    //    two checks it happens to call - see the file header).
    assert.ok(this.room.admits(op), 'the room admitted the op (no ceiling reached)');
    // 2. the overlay veto, real code, with an overlay that locks nothing.
    const input = governedInputId(op);
    if (input === null) {
      this.ungoverned++;
    } else {
      this.governed++;
      const access = resolveInputAccess(undefined, input, WRITER_GROUPS);
      assert.equal(access.level, 'editable', `nothing is locked in this room (${input})`);
    }
    // 3. the document door.
    if (op.origin.clock > this.clock) this.clock = op.origin.clock; // Lamport absorb
    this.room.ingestOp(op, this.seat.userId);
  }

  onLocalChange(_damage: Damage, rows: Map<BoxId, BoxRow>, col?: string): CanvasOp[] {
    const origin: OpOrigin = { client: this.clientId, clock: ++this.clock };
    const ops = damageToOps(this.currentRows(col), rows, origin, DEFAULT_GEOMETRY_FIELDS, col);
    for (const op of ops) this.apply(op);
    return ops;
  }

  applyRemotePatch(ops: readonly CanvasOp[]): Damage {
    for (const op of ops) this.apply(op);
    return opsToDamage(ops);
  }

  /** The REAL presence relay (rooms.ts `relayPresence`): sanitize, remember,
   *  broadcast. The suite asserts the document did not move; this file adds that
   *  the frame really did travel (below). */
  presence(a: Awareness): void {
    this.room.relayPresence(this.seat, a);
  }

  state(): CanvasDocState {
    // Through JSON, because that is how a client receives it.
    return fromWire(JSON.parse(JSON.stringify(this.room.snapshot())) as WireDocState);
  }

  /** Rows of one collection in PAINT ORDER - what `damageToOps` diffs against. */
  private currentRows(col?: string): Map<BoxId, BoxRow> {
    const state = this.state();
    const src = col === undefined
      ? { order: state.order, boxes: state.boxes }
      : state.collections?.get(col);
    const rows = new Map<BoxId, BoxRow>();
    if (!src) return rows;
    for (const id of src.order) {
      const row = src.boxes.get(id);
      if (row) rows.set(id, row);
    }
    return rows;
  }
}

// ── the conformance leg ───────────────────────────────────────────────────────

test('the gateway room passes the SHARED canvas-op conformance suite', () => {
  // The whole suite, unmodified, against the room: the fuzz convergence property
  // over ten seeds, idempotency, the lane/param/awareness cases, and the v1.1
  // collection cases. A failure here prints the suite's own message.
  runConvergenceSuite(() => new RoomAdapter(), 'lw:room');
});

test('the suite really drove the ROOM — its document, its counters, its write-back', () => {
  // A guard against the adapter quietly becoming a private CRDT that shares
  // nothing with the room: whatever the suite applied has to be visible through
  // the room's OWN surfaces (the ones persistence and the audit rollup read).
  const a = new RoomAdapter();
  const b = new RoomAdapter();
  const rows = new Map<BoxId, BoxRow>([
    ['r1', { heading: 'one' }],
    ['r2', { heading: 'two' }],
  ]);
  const ops = a.onLocalChange(
    { moved: [], restyled: [], added: ['r1', 'r2'], removed: [], zChanged: [], frames: [] },
    rows,
    'slides',
  );
  a.apply({ k: 'param', key: 'title', value: 'converged', origin: { client: 'peer', clock: 9 } });
  b.applyRemotePatch(ops);

  assert.equal(a.room.acceptedOps, ops.length + 1, 'the room counted every op the suite pushed');
  assert.equal(a.room.snapshot().params['title'], 'converged', 'the room’s own document holds it');
  assert.deepEqual(a.room.snapshotForAdmin().opsApplied, ops.length + 1);

  // The write-back seam persistence.ts uses, over empty stored inputs: the
  // collection comes back as the blocks input it was scoped to, the param as a
  // scalar. This is the shape a quiesce would commit.
  const written = a.room.toInputs({});
  assert.equal(written['title'], 'converged');
  const slides = written['slides'] as Array<Record<string, unknown>>;
  assert.deepEqual(slides.map((s) => s['heading']), ['one', 'two'], 'row order survives the round trip');
  assert.deepEqual(slides.map((s) => s['id']), ['r1', 'r2'], 'stable row ids ride back out');

  // …and the rollup reports the input KEYS the room touched, never a value.
  assert.deepEqual(a.room.rollup().keys, ['slides', 'title']);
  assert.ok(!JSON.stringify(a.room.rollup()).includes('converged'));
});

test('the two gates the suite cannot cross, stated', () => {
  // (b) an unscoped canvas op names no input, so no overlay can govern it and the
  // gateway refuses it outright (ERR.COLLECTION_REQUIRED). The suite's canvas
  // half is made of exactly these, which is why this leg drives the document door
  // rather than a socket - and why the collection half below is the part that
  // does cross the overlay veto.
  const canvas: CanvasOp = {
    k: 'add', id: 'b1', row: { x: 0 }, orderKey: '001', origin: { client: 'a', clock: 1 },
  };
  assert.equal(governedInputId(canvas), null, 'a canvas-collection op is ungovernable, by design');
  assert.equal(governedInputId({ ...canvas, col: 'slides' }), 'slides');
  assert.equal(governedInputId({ k: 'param', key: 'title', value: 1, origin: { client: 'a', clock: 1 } }), 'title');

  // The suite pushes both kinds through, and the split is real: the collection
  // cases are governed ops that passed the overlay, not ops that skipped it.
  const adapter = new RoomAdapter();
  adapter.apply(canvas);
  adapter.apply({ ...canvas, id: 'b2', col: 'slides' });
  assert.equal(adapter.ungoverned, 1, 'the canvas op could not be resolved to an input');
  assert.equal(adapter.governed, 1, 'the scoped op was resolved and cleared the overlay');

  // (a) the replay filter, in front of the door the suite uses, is order-
  // sensitive on purpose - the same log applied out of order loses ops. Two
  // rooms, same ops, two orders: through `applyOps` they disagree, through the
  // document door they do not.
  const inOrder = Room.create(sessionOf());
  const shuffled = Room.create(sessionOf());
  const seat = seatOf('m1');
  inOrder.join(seat);
  shuffled.join(seatOf('m1'));
  const log: CanvasOp[] = [
    { k: 'param', key: 'a', value: 1, origin: { client: 'c', clock: 1 } },
    { k: 'param', key: 'b', value: 2, origin: { client: 'c', clock: 2 } },
    { k: 'param', key: 'c', value: 3, origin: { client: 'c', clock: 3 } },
  ];
  for (const op of log) inOrder.applyOps(seat, [op]);
  for (const op of [log[2]!, log[0]!, log[1]!]) shuffled.applyOps(seat, [op]);
  assert.deepEqual(Object.keys(inOrder.snapshot().params).sort(), ['a', 'b', 'c']);
  assert.deepEqual(
    Object.keys(shuffled.snapshot().params).sort(), ['c'],
    'the replay filter drops a lower clock from a client it has already heard — transport dedup, not document semantics',
  );

  const door = Room.create(sessionOf());
  for (const op of [log[2]!, log[0]!, log[1]!]) door.ingestOp(op, 'user-m1');
  assert.deepEqual(
    Object.keys(door.snapshot().params).sort(), ['a', 'b', 'c'],
    'the DOCUMENT is order-independent — which is the property the suite asserts',
  );
});

test('presence crossed the real relay, and left the document alone', () => {
  // `caseAwarenessNeverMutatesDoc` in the shared suite asserts the doc half. This
  // is the other half, which only this repo can see: the frame went through
  // rooms.ts's `sanitizePresence` → peer broadcast, with the SERVER's identity
  // stamped over whatever was claimed.
  const adapter = new RoomAdapter();
  const peer = seatOf('m2');
  adapter.room.join(peer);
  const before = JSON.stringify(adapter.room.snapshot());

  adapter.presence({
    userId: 'spoofed', name: 'Someone Else', color: '#30ba78',
    cursor: { x: 0.5, y: 0.25 }, selection: ['r1'], chat: 'x'.repeat(200),
  });

  assert.equal(JSON.stringify(adapter.room.snapshot()), before, 'presence never touches the document');
  const relayed = peer.sent.filter((f): f is Extract<ServerFrame, { t: 'presence' }> => f.t === 'presence');
  assert.equal(relayed.length, 1, 'the peer got the frame');
  assert.equal(relayed[0]?.frame.userId, adapter.seat.userId, 'stamped with the authenticated identity');
  assert.notEqual(relayed[0]?.frame.userId, 'spoofed');
  assert.equal(relayed[0]?.frame.chat?.length, 64, 'clamped to the contract ceiling');
  assert.equal(adapter.room.internals().presence, 1, 'remembered for the next joiner, in memory only');
});
