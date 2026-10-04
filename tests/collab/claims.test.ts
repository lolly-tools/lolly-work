// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CanvasClaims } from '../../server/src/collab/claims.ts';
import type { CanvasClaimTarget } from '@lolly-tools/core/canvas-interaction-v1';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';

const a = { id: 'a', name: 'Alice', role: 'writer' as const };
const b = { id: 'b', name: 'Bob', role: 'writer' as const };
const target: CanvasClaimTarget = { kind: 'transform', collection: 'boxes', ids: ['one', 'two'] };
const origin = { client: 'client', clock: 1 };
const move: CanvasOp = { k: 'geom', col: 'boxes', id: 'one', fields: { x: 10 }, origin };

test('multi-object claims acquire together; unrelated content and objects stay concurrent', () => {
  const claims = new CanvasClaims(() => {});
  const first = claims.acquire(a, target);
  assert.ok('claim' in first);
  assert.deepEqual(claims.acquire(b, { ...target, ids: ['two', 'three'] }), { reason: 'claimed', blockedBy: 'Alice' });
  assert.ok('claim' in claims.acquire(b, { ...target, ids: ['three'] }));
  assert.equal(claims.allows(b.id, [move]), false);
  assert.equal(claims.allows(a.id, [move], first.claim.id), true);
  assert.equal(claims.allows(b.id, [{ k: 'field', col: 'boxes', id: 'one', field: 'color', value: 'blue', origin }]), true);
  assert.ok('claim' in claims.acquire(b, { kind: 'text', collection: 'boxes', ids: ['one'], field: 'text' }));
});
test('leases expire, renew only for their holder, and clear on role loss or disconnect', () => {
  let now = 0;
  const publications: unknown[] = [];
  const claims = new CanvasClaims(value => publications.push(value), () => now);
  const first = claims.acquire(a, target); assert.ok('claim' in first);
  assert.deepEqual(claims.renew(b, first.claim.id), { reason: 'claim-lost' });
  now = 9_000; assert.ok('claim' in claims.renew(a, first.claim.id));
  now = 19_000; claims.expire();
  assert.equal(claims.allows(a.id, [move], first.claim.id), false, 'stale final geometry cannot overwrite a later gesture');
  assert.equal(claims.list().length, 0);
  assert.deepEqual(claims.acquire({ ...a, role: 'observer' }, target), { reason: 'view-only' });
  claims.acquire(a, target); claims.release(a.id); assert.equal(claims.list().length, 0);
  assert.ok(publications.length >= 4);
});
test('deleting a claimed object cancels its preview and late token without blocking deletion', () => {
  const claims = new CanvasClaims(() => {});
  const first = claims.acquire(a, target); assert.ok('claim' in first);
  const preview = { claimId: first.claim.id, collection: 'boxes', kind: 'move' as const, phase: 'active' as const,
    objects: [{ id: 'one', x: 10, y: 20, w: 50, h: 50, rot: 0 }] };
  assert.equal(claims.preview(a.id, preview), true);
  assert.equal(claims.preview(b.id, preview), false);
  const remove: CanvasOp = { k: 'remove', col: 'boxes', id: 'one', origin };
  assert.equal(claims.allows(b.id, [remove]), true);
  claims.removed([remove]);
  assert.equal(claims.preview(a.id, preview), false);
  assert.equal(claims.allows(a.id, [move], first.claim.id), false);
});
