// SPDX-License-Identifier: MPL-2.0
/** A browse must not wait for an upstream first page that has not returned. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createFederation } from '../server/src/catalog/federation.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { createServedIndex } from '../server/src/catalog/served-index.ts';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

test('background fragments return pending while one shared cold refresh waits for the source', async t => {
  const store = createMemoryStore();
  const record: ProviderRecord = { id: 'cold', kind: 'brandfolder', label: 'Cold', managedBy: 'config', enabled: true, options: { brandfolderId: 'fixture' }, mapping: {}, exposure: {}, sync: {}, state: { assetCount: 0 }, createdAt: '2026-10-15', updatedAt: '2026-10-15' };
  await store.putProvider(record);
  let finish!: (response: Response) => void, started!: () => void, calls = 0;
  const requested = new Promise<void>(resolve => { started = resolve; });
  const gate = new Promise<Response>(resolve => { finish = resolve; });
  const federation = createFederation({ store, configSecrets: new Map([['cold', 'fixture-key']]), fetchImpl: async () => { calls++; started(); return gate; } });
  assert.deepEqual(await federation.fragments({ background: true }), []);
  await requested;
  try {
    assert.deepEqual(await federation.fragments({ background: true }), []);
    assert.equal(calls, 1, 'concurrent browsing shares the cold refresh');
    const pack = await mkdtemp(join(tmpdir(), 'lw-cold-index-'));
    t.after(() => rm(pack, { recursive: true, force: true }));
    await mkdir(join(pack, 'catalog/assets'), { recursive: true });
    await writeFile(join(pack, 'catalog/assets/index.json'), '{"assets":[]}');
    const index = createServedIndex({ store, federation, pack: () => pack });
    const pending = await index.forCaller({ groups: [], paged: true, background: true });
    assert.deepEqual(pending.index.pendingProviders, ['cold'], 'pending is not a removed source during local cache pruning');
    await store.putProvider({ ...record, exposure: { groups: ['private'] } });
    const hidden = await index.forCaller({ groups: [], paged: true, background: true });
    assert.equal(hidden.index.pendingProviders, undefined, 'pending source IDs still follow current visibility');
  } finally { finish(Response.json({ data: [], included: [] })); }
  assert.equal((await federation.fragments()).length, 1);
  assert.equal(calls, 1);
});
