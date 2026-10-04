import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createFederation } from '../server/src/catalog/federation.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';

const at = '2026-10-04T12:00:00.000Z';
const provider = (): ProviderRecord => ({
  id: 'dam', kind: 'mock', label: 'DAM', managedBy: 'db', enabled: true,
  options: { assets: [{ remoteId: 'a1', name: 'Image', nativeType: 'file', sections: [], tags: [], formats: [{ format: 'png', remoteRef: 'png' }] }] },
  mapping: {}, exposure: { groups: ['design'] }, sync: { ttlSeconds: 300 },
  createdAt: at, updatedAt: at, state: { assetCount: 0 },
});

test('warm federation avoids snapshot reads while checking current visibility and disablement', async () => {
  const store = createMemoryStore(), rec = provider();
  await store.putProvider(rec);
  const federation = createFederation({ store, now: () => Date.parse(at) });
  await federation.sync(rec);
  const fullRead = store.getProvider.bind(store), list = store.listProviders.bind(store);
  let snapshotReads = 0, metadataReads = 0;
  store.getProvider = async (id, options) => {
    if (options?.includeFragment !== false) snapshotReads++;
    return fullRead(id, options);
  };
  store.listProviders = async options => {
    if (options?.includeFragment === false) metadataReads++;
    else snapshotReads++;
    return list(options);
  };
  for (let i = 0; i < 20; i++) {
    assert.equal((await federation.composeIndex({ version: 1, assets: [] }, ['design'])).assets?.length, 1);
    await federation.availabilityWindow('ext/dam/a1');
    await federation.version();
  }
  assert.equal(snapshotReads, 0, 'repeated thumbnail/lifecycle/version reads reuse the fragment');
  assert.equal(metadataReads, 60, 'authority remains fresh for every read');
  await store.putProvider({ ...rec, exposure: { groups: ['sales'] } });
  assert.equal((await federation.composeIndex({ version: 1, assets: [] }, ['design'])).assets?.length, 0);
  assert.equal((await federation.composeIndex({ version: 1, assets: [] }, ['sales'])).assets?.length, 1);
  await store.putProvider({ ...rec, enabled: false });
  assert.equal((await federation.composeIndex({ version: 1, assets: [] }, ['design'])).assets?.length, 0);
});

test('failed refresh preserves the latest durable fragment and cold boot serves that last good index', async () => {
  const store = createMemoryStore(), rec = provider();
  await store.putProvider(rec);
  const federation = createFederation({ store, now: () => Date.parse(at) });
  await federation.sync(rec);
  const latest = { assets: [{ id: 'ext/dam/new', name: 'New last good' }], hash: 'new-hash', syncedAt: at };
  await store.putProviderState(rec.id, { assetCount: 1, lastSyncAt: at, fragment: latest });
  await store.putProvider({ ...rec, options: { failWith: 'upstream offline' } });
  const metadata = await store.getProvider(rec.id, { includeFragment: false });
  await assert.rejects(federation.sync(metadata!), /upstream offline/);
  assert.deepEqual((await store.getProvider(rec.id))?.state.fragment, latest);
  const cold = createFederation({ store, now: () => Date.parse(at) });
  const index = await cold.composeIndex({ version: 1, assets: [] }, ['design']);
  assert.deepEqual(index.assets, latest.assets);
  assert.deepEqual(index.staleProviders, ['dam']);
});
