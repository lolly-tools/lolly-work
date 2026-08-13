/**
 * Upstream availability windows (plans/27 §2), unit level: `combinedState`
 * joins a local lifecycle row with an imported DAM window most-restrictive-wins,
 * `entryWindow` reads it back off a feed entry, and `applyLifecycleToIndex`
 * folds it — including the rule that upstream expiry hides even under
 * onExpiry:'warn', while a purely-local expiry still warns.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyLifecycleToIndex, assetState, combinedState, entryWindow,
  type AssetIndex, type LifecycleRow,
} from '../server/src/catalog/lifecycle.ts';

const NOW = Date.parse('2026-08-13T00:00:00.000Z');
const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';

test('combinedState with no window reduces exactly to assetState', () => {
  const rows: Array<LifecycleRow | undefined> = [
    undefined,
    { assetId: 'x', onExpiry: 'hide' },
    { assetId: 'x', onExpiry: 'hide', validFrom: FUTURE },
    { assetId: 'x', onExpiry: 'hide', validUntil: PAST },
    { assetId: 'x', onExpiry: 'warn', validUntil: PAST },
    { assetId: 'x', onExpiry: 'hide', revokedAt: PAST },
    // never-live: scheduled beats expired even when the end has also passed
    { assetId: 'x', onExpiry: 'hide', validFrom: FUTURE, validUntil: PAST },
  ];
  for (const row of rows) {
    assert.equal(combinedState(row, undefined, NOW).state, assetState(row, NOW));
  }
});

test('most-restrictive-wins: either future start → scheduled, either passed end → expired', () => {
  // upstream schedules it even with no local row
  assert.deepEqual(combinedState(undefined, { availableFrom: FUTURE }, NOW), { state: 'scheduled', upstreamExpired: false });
  // upstream expiry, no local row → expired AND flagged upstream
  assert.deepEqual(combinedState(undefined, { availableUntil: PAST }, NOW), { state: 'expired', upstreamExpired: true });
  // both live → live
  assert.deepEqual(combinedState({ assetId: 'x', onExpiry: 'hide' }, { availableFrom: PAST, availableUntil: FUTURE }, NOW), { state: 'live', upstreamExpired: false });
});

test('a local admin can narrow an upstream window but never widen it', () => {
  const upstream = { availableFrom: PAST, availableUntil: FUTURE }; // upstream: live now
  // narrow the end earlier (local validUntil in the past) → expired, local-driven
  assert.deepEqual(
    combinedState({ assetId: 'x', onExpiry: 'hide', validUntil: PAST }, upstream, NOW),
    { state: 'expired', upstreamExpired: false },
  );
  // narrow the start later (local validFrom in the future) → scheduled
  assert.deepEqual(
    combinedState({ assetId: 'x', onExpiry: 'hide', validFrom: FUTURE }, upstream, NOW),
    { state: 'scheduled', upstreamExpired: false },
  );
  // try to WIDEN past an expired upstream: a generous local window can't rescue it
  assert.deepEqual(
    combinedState({ assetId: 'x', onExpiry: 'warn', validUntil: FUTURE }, { availableUntil: PAST }, NOW),
    { state: 'expired', upstreamExpired: true },
  );
});

test('revoked always wins, even over a live upstream window', () => {
  assert.equal(combinedState({ assetId: 'x', onExpiry: 'hide', revokedAt: PAST }, { availableFrom: PAST, availableUntil: FUTURE }, NOW).state, 'revoked');
});

test('entryWindow reads the stamped keys and returns undefined without allocating for none', () => {
  assert.equal(entryWindow({ id: 'a' }), undefined);
  assert.deepEqual(entryWindow({ id: 'a', availableUntil: FUTURE }), { availableUntil: FUTURE });
  assert.deepEqual(entryWindow({ id: 'a', availableFrom: PAST, availableUntil: FUTURE }), { availableFrom: PAST, availableUntil: FUTURE });
  // non-string keys are ignored
  assert.equal(entryWindow({ id: 'a', availableFrom: 123 as unknown as string }), undefined);
});

test('applyLifecycleToIndex folds windows off entries with no lifecycle rows at all', () => {
  const index: AssetIndex = {
    assets: [
      { id: 'live', availableFrom: PAST, availableUntil: FUTURE },
      { id: 'sched', availableFrom: FUTURE },
      { id: 'gone', availableUntil: PAST }, // upstream expired
      { id: 'plain' },
    ],
  };
  const out = applyLifecycleToIndex(index, [], NOW);
  assert.deepEqual((out.assets ?? []).map((a) => a.id), ['live', 'plain']);
  // gone is upstream-expired → hidden, not kept with a warn badge
  assert.ok(!(out.assets ?? []).some((a) => a.id === 'gone'));
});

test('upstream expiry hides even under onExpiry:warn; a purely-local expiry still warns', () => {
  const index: AssetIndex = {
    assets: [
      { id: 'ext/dam/up', availableUntil: PAST },   // upstream expired
      { id: 'ext/dam/loc', availableUntil: FUTURE }, // upstream live, local expiry warns
    ],
  };
  const rows: LifecycleRow[] = [
    { assetId: 'ext/dam/up', onExpiry: 'warn' },
    { assetId: 'ext/dam/loc', onExpiry: 'warn', validUntil: PAST },
  ];
  const out = applyLifecycleToIndex(index, rows, NOW);
  const ids = (out.assets ?? []).map((a) => a.id);
  assert.ok(!ids.includes('ext/dam/up'), 'upstream expiry ignores warn and hides');
  const loc = (out.assets ?? []).find((a) => a.id === 'ext/dam/loc');
  assert.ok(loc, 'local-only expiry under warn stays in the feed');
  assert.equal(loc?.expired, true);
});

test('the no-rows / no-window fast path returns the same reference untouched', () => {
  const index: AssetIndex = { assets: [{ id: 'a' }, { id: 'b' }] };
  assert.equal(applyLifecycleToIndex(index, [], NOW), index);
});
