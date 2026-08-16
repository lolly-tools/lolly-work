// SPDX-License-Identifier: MPL-2.0
/**
 * The Yjs adapter must satisfy the SAME §8 conformance suite the OSS `ReferenceCanvasDoc`
 * passes - imported from the pinned SDK so both repos run IDENTICAL bytes (plans/99 §8,
 * plans/14 §11). If this ever fails, either the adapter or the contract drifted.
 *
 * v1.1 landed 2026-08-09: the adapter now implements `col`-scoped collection ops (every
 * collection's boxes in one flat root, keyed `<col>\0<BoxId>`, mirroring
 * `ReferenceCanvasDoc`'s per-collection registers and order), so the three collection
 * cases the vendored suite added pass and this test is no longer skipped. It was skipped
 * 2026-08-10 for exactly that gap - the drift the suite exists to surface - and the skip
 * is gone because the gap is. The adapter is still the deferred multi-replica follow-up
 * (plans/14 §8; rooms serve on the vendored `ReferenceCanvasDoc` - see
 * tests/collab/room-conformance.test.ts), and the cross-doc register caveat documented in
 * the adapter header still stands, per collection. Tracked in plans/14 §10.
 *
 * THE SUITE ITSELF DRIVES ONE DOC. Everything below it here drives TWO, because the
 * caveat the header makes a gate out of ("before enabling multi-replica sync…") is only
 * meaningful if its SIZE is pinned by a test: an adapter can pass every single-doc
 * conformance case and still lose a peer's whole collection on the first sync. These are
 * lolly-work's own legs, not the shared suite - a cross-doc merge is a property of the
 * Yjs storage model, so `ReferenceCanvasDoc` has no counterpart to run them against.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { runConvergenceSuite } from '@lolly-tools/core/canvas-op-testkit';
import { ReferenceCanvasDoc } from '@lolly-tools/core/canvas-op-v1';
import type { BoxId, CanvasDocState, CanvasOp } from '@lolly-tools/core/canvas-op-v1';
import { YjsCanvasAdapter } from '../../server/src/collab/yjs-canvas-adapter.ts';

test('Yjs adapter satisfies the canvas-op §8 shared conformance suite', () => {
  runConvergenceSuite(() => new YjsCanvasAdapter(), 'yjs');
});

// ── cross-doc merge (the multi-replica caveat, pinned by size) ──────────────────

/** A two-way Yjs sync - each doc sends the other exactly what it is missing. */
function sync(a: Y.Doc, b: Y.Doc): void {
  const fromA = Y.encodeStateAsUpdate(a, Y.encodeStateVector(b));
  const fromB = Y.encodeStateAsUpdate(b, Y.encodeStateVector(a));
  Y.applyUpdate(b, fromA);
  Y.applyUpdate(a, fromB);
}

const rowsOf = (d: YjsCanvasAdapter, col: string): BoxId[] => d.state().collections?.get(col)?.order ?? [];

const addOp = (id: BoxId, orderKey: string, client: string, clock: number, col?: string): CanvasOp =>
  ({ k: 'add', id, ...(col === undefined ? {} : { col }), row: { id }, orderKey, origin: { client, clock } });

test('two docs that first touch the SAME collection concurrently keep both peers\' rows', () => {
  // The regression this pins: with a nested `Y.Map` per collection, Yjs resolved the
  // CREATION of the collection itself by per-key LWW on the value - the losing doc's
  // whole subtree was deleted, so a peer that had written five rows before the first
  // sync converged on none of them, at any app clock. A flat key space makes the two
  // peers' writes different keys of a root type, which merges structurally.
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const a = new YjsCanvasAdapter('A', docA);
  const b = new YjsCanvasAdapter('B', docB);

  for (let i = 0; i < 5; i++) a.apply(addOp(`a${i}`, `00${i}`, 'A', i + 1, 'rows'));
  b.apply(addOp('b0', '900', 'B', 99, 'rows'));
  sync(docA, docB);

  const expected = ['a0', 'a1', 'a2', 'a3', 'a4', 'b0'];
  assert.deepEqual(rowsOf(a, 'rows'), expected, 'the peer that created the collection lost the other\'s rows');
  assert.deepEqual(rowsOf(b, 'rows'), expected, 'the peer that lost the creation race lost its OWN rows');
  assert.deepEqual(rowsOf(a, 'rows'), rowsOf(b, 'rows'), 'the two docs did not converge');
});

test('a collection\'s cross-doc loss is one box — exactly the canvas\'s, never the collection', () => {
  // The caveat that REMAINS (adapter header): two docs that concurrently create the same
  // BoxId keep one box map and lose the other's registers. This asserts its size - one
  // box, siblings untouched - in a collection and on the canvas, so a later fix to the
  // register comparison cannot quietly widen it back out.
  const docA = new Y.Doc();
  const docB = new Y.Doc();
  const a = new YjsCanvasAdapter('A', docA);
  const b = new YjsCanvasAdapter('B', docB);

  for (const col of [undefined, 'rows'] as const) {
    a.apply(addOp('same', '001', 'A', 1, col));
    a.apply(addOp('onlyA', '003', 'A', 2, col));
    b.apply(addOp('same', '002', 'B', 9, col));
    b.apply(addOp('onlyB', '004', 'B', 10, col));
  }
  sync(docA, docB);

  for (const col of [undefined, 'rows'] as const) {
    const where = col ?? 'canvas';
    const order = col === undefined ? a.state().order : rowsOf(a, col);
    const peer = col === undefined ? b.state().order : rowsOf(b, col);
    assert.deepEqual(order, peer, `${where}: the two docs did not converge`);
    for (const id of ['same', 'onlyA', 'onlyB']) {
      assert.ok(order.includes(id), `${where}: a concurrent same-id add took the sibling '${id}' with it`);
    }
  }
});

// ── reserved register keys are not a field namespace ────────────────────────────

/** The comparison key: the two implementations' full state as one string. */
function serialize(s: CanvasDocState): string {
  const cols = [...(s.collections ?? new Map()).entries()]
    .map(([id, c]) => [id, { order: c.order, boxes: [...c.boxes.entries()] }] as const)
    .sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0));
  return JSON.stringify({ order: s.order, boxes: [...s.boxes.entries()], params: [...s.params.entries()], cols });
}

test('a field named __alive/__order is an ordinary field, not the membership register', () => {
  // The two registers share the box's Y.Map with fields, so an unescaped field name
  // would BE the register: `{k:'field', field:'__alive', value:false}` would delete a
  // box with no `remove` op ever authorized (box field names are not whitelisted on the
  // gateway's accept path - `governedInputId` resolves a box op to `op.col` only), and
  // the reference, which keeps alive/order in their own slots, would keep it as a field.
  // Same op log, both implementations, byte-identical state.
  const ops: CanvasOp[] = [
    { k: 'add', id: 'b1', row: { id: 'b1', text: 'hi' }, orderKey: '001', origin: { client: 'a', clock: 1 } },
    { k: 'field', id: 'b1', field: '__alive', value: false, origin: { client: 'a', clock: 9 } },
    { k: 'field', id: 'b1', field: '__order', value: 'zzz', origin: { client: 'a', clock: 10 } },
    { k: 'field', id: 'b1', field: '___alive', value: 'escaped', origin: { client: 'a', clock: 11 } },
    // …and the same names arriving as ROW fields on an add, in a collection.
    { k: 'add', id: 'r1', col: 'rows', row: { id: 'r1', __alive: false, __order: '000' }, orderKey: '001', origin: { client: 'a', clock: 12 } },
  ];
  const yjs = new YjsCanvasAdapter();
  const ref = new ReferenceCanvasDoc();
  for (const op of ops) {
    yjs.apply(op);
    ref.apply(op);
  }

  const row = yjs.state().boxes.get('b1');
  assert.ok(row, 'a __alive FIELD write deleted the box');
  assert.equal(row['__alive'], false, 'the __alive field lost its value');
  assert.equal(row['__order'], 'zzz', 'the __order field lost its value');
  assert.equal(row['___alive'], 'escaped', 'the escape target collided with a real field name');
  assert.deepEqual(yjs.state().order, ['b1'], 'a __order FIELD write moved the box in paint order');
  assert.deepEqual(yjs.state().collections?.get('rows')?.order, ['r1'], 'an add row\'s __alive killed the row');
  assert.equal(serialize(yjs.state()), serialize(ref.state()), 'the Yjs adapter and the reference diverged');
});
