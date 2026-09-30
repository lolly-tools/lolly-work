import assert from 'node:assert/strict';
import type { Store } from '../server/src/store/types.ts';

export async function checkBrandState(store: Store) {
  const initial = await store.getBrandState();
  assert.equal(initial.revision, 0);
  const next = { ...initial, activeSource: 'profile:alpha', retired: ['profile:beta'], download: { ...initial.download, suppressed: true } };
  const body = { at: new Date().toISOString(), actor: 'test:owner', action: 'brand.select', subject: 'profile:alpha' };
  const [a, b] = await Promise.all([store.casBrandState(0, next, body), store.casBrandState(0, next, body)]);
  assert.equal([a, b].filter(Boolean).length, 1, 'one revision has exactly one winner');
  const saved = await store.getBrandState();
  assert.equal(saved.revision, 1);
  assert.equal(saved.activeSource, 'profile:alpha');
  assert.equal(saved.download.suppressed, true);
  assert.deepEqual(saved.retired, ['profile:beta']);
  assert.equal((await store.listAudit()).filter(e => e.action === 'brand.select').length, 1);
  saved.retired.push('outside-mutation');
  next.download.suppressed = false;
  assert.deepEqual((await store.getBrandState()).retired, ['profile:beta']);
  assert.equal((await store.getBrandState()).download.suppressed, true);
  assert.equal(await store.casBrandState(0, next, body), null);
}
