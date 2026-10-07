/**
 * The memoised asset feed (catalog/served-index.ts), the sync cap
 * (federation.ts buildFragment) and the federated-bytes cache
 * (catalog/ext-cache.ts), driven without HTTP against a memory store.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildFragment, createFederation, pageCeiling } from '../server/src/catalog/federation.ts';
import { createServedIndex, nextLifecycleFlip } from '../server/src/catalog/served-index.ts';
import { createExtCache } from '../server/src/catalog/ext-cache.ts';
import { createProvider } from '../server/src/catalog/providers/registry.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';

const provider = (over: Partial<ProviderRecord> = {}): ProviderRecord => ({
  id: 'dam', kind: 'mock', label: 'DAM', managedBy: 'db', enabled: true,
  options: { generate: { count: 300 } }, mapping: { defaultType: 'image' }, exposure: {}, sync: { ttlSeconds: 3600 },
  createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', state: { assetCount: 0 },
  ...over,
});

async function setup(now: () => number) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-served-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1, assets: [{ id: 'pack/one', name: 'One', type: 'vector', formats: [{ format: 'svg', url: '/catalog/assets/one.svg' }] }],
  }));
  const store = createMemoryStore();
  await store.putProvider(provider());
  const federation = createFederation({ store, now });
  const served = createServedIndex({ pack: () => pack, store, federation, now, pagedThreshold: 100 });
  return { pack, store, served };
}

test('the feed composes once per input state and recomposes on a store change', async () => {
  let clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { store, served } = await setup(() => clock);
  const a = await served.forCaller({ groups: ['design'] });
  assert.equal(a.status, 'composed');
  assert.equal(a.index.assets?.length, 301);
  const b = await served.forCaller({ groups: ['design'] });
  assert.equal(served.compositions(), 1, 'the second call is a memo hit');
  assert.equal(b.etag, a.etag);
  assert.equal(b.bytes, a.bytes, 'the same Buffer, not a re-stringify');
  // The group key is sorted and deduplicated, so the same visibility is one key.
  await served.forCaller({ groups: ['design', 'design'] });
  assert.equal(served.compositions(), 1);

  await store.putLifecycle({ assetId: 'ext/dam/g000000', revokedAt: '2026-06-01T00:00:00.000Z', onExpiry: 'hide' });
  const c = await served.forCaller({ groups: ['design'] });
  assert.equal(served.compositions(), 2, 'a lifecycle row is an input');
  assert.equal(c.index.assets?.length, 300);
  assert.notEqual(c.etag, a.etag);
  clock += 1000;
  await served.forCaller({ groups: ['design'] });
  assert.equal(served.compositions(), 2, 'time alone does not recompose without a pending flip');
});

test('the memo is bounded by feed bytes as well as by key count', async () => {
  const clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { pack, store } = await setup(() => clock);
  const federation = createFederation({ store, now: () => clock });
  const one = await createServedIndex({ pack: () => pack, store, federation, now: () => clock }).forCaller({ groups: ['a'] });
  // Room for one feed only: a second visibility key evicts the first.
  const served = createServedIndex({ pack: () => pack, store, federation, now: () => clock, maxBytes: one.bytes.length + 10 });
  await served.forCaller({ groups: ['a'] });
  await served.forCaller({ groups: ['b'] });
  await served.forCaller({ groups: ['b'] });
  assert.equal(served.compositions(), 2, 'the most recent key stays');
  await served.forCaller({ groups: ['a'] });
  assert.equal(served.compositions(), 3, 'the older key was evicted to stay inside the byte budget');
});

test('a pending lifecycle flip ends the memo at the flip instant', async () => {
  let clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { store, served } = await setup(() => clock);
  await store.putLifecycle({ assetId: 'pack/one', validUntil: '2026-06-01T01:00:00.000Z', onExpiry: 'hide' });
  const before = await served.forCaller({ groups: [] });
  assert.ok(before.index.assets?.some((e) => e.id === 'pack/one'));
  clock += 30 * 60 * 1000;
  await served.forCaller({ groups: [] });
  assert.equal(served.compositions(), 1, 'still before the flip');
  clock += 31 * 60 * 1000;
  const afterFlip = await served.forCaller({ groups: [] });
  assert.equal(served.compositions(), 2, 'past the flip, the memo is stale');
  assert.ok(!afterFlip.index.assets?.some((e) => e.id === 'pack/one'), 'the expired asset left the feed');
});

test('nextLifecycleFlip finds the earliest future instant across rows and windows', () => {
  const now = Date.parse('2026-06-01T00:00:00.000Z');
  assert.equal(nextLifecycleFlip([], [], now), Infinity);
  const flip = nextLifecycleFlip(
    [{ id: 'a', availableUntil: '2026-06-03T00:00:00.000Z' }, { id: 'b', availableFrom: '2026-05-01T00:00:00.000Z' }],
    [{ assetId: 'c', validFrom: '2026-06-02T00:00:00.000Z', onExpiry: 'hide' }],
    now,
  );
  assert.equal(flip, Date.parse('2026-06-02T00:00:00.000Z'));
});

test('the paged feed is derived from the full one and memoised with it', async () => {
  const clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { served } = await setup(() => clock);
  const pagedOnce = await served.forCaller({ groups: [], paged: true });
  const pagedTwice = await served.forCaller({ groups: [], paged: true });
  assert.equal(pagedOnce, pagedTwice);
  assert.equal(served.compositions(), 1, 'the paged variant does not compose again');
  assert.deepEqual(pagedOnce.index.assets?.map((e) => e.id), ['pack/one']);
  assert.deepEqual(pagedOnce.index.pagedProviders, [{ id: 'dam', label: 'DAM', count: 300 }]);
  const sorted = pagedOnce.sorted();
  assert.equal(sorted, pagedOnce.sorted(), 'the sort is computed once');
});

test('a pack index that is not JSON is served raw and search still sees federated entries', async () => {
  const clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { pack, served } = await setup(() => clock);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), 'not json');
  const raw = await served.forCaller({ groups: [] });
  assert.equal(raw.status, 'raw');
  assert.equal(raw.bytes.toString('utf8'), 'not json');
  assert.equal(raw.index.assets?.length, 300);
});

test('buildFragment stops at sync.maxAssets with a note, and an uncapped walk is unmarked', async () => {
  const now = () => 0;
  const capped = provider({ options: { generate: { count: 500 }, pageSize: 50 }, sync: { maxAssets: 120 } });
  const frag = await buildFragment(capped, createProvider(capped, undefined), now);
  assert.equal(frag.assets.length, 120);
  assert.equal(frag.truncated, true);
  assert.match(frag.notes?.[0] ?? '', /Stopped after 120 assets/);
  assert.match(frag.notes?.[0] ?? '', /sync\.maxAssets/);

  const exact = provider({ options: { generate: { count: 100 }, pageSize: 50 }, sync: { maxAssets: 100 } });
  const whole = await buildFragment(exact, createProvider(exact, undefined), now);
  assert.equal(whole.assets.length, 100);
  assert.equal(whole.truncated, undefined, 'reaching the end exactly at the cap is not truncation');

  const instanceDefault = provider({ options: { generate: { count: 300 }, pageSize: 100 } });
  const byDefault = await buildFragment(instanceDefault, createProvider(instanceDefault, undefined), now, { maxAssets: 250 });
  assert.equal(byDefault.assets.length, 250);
  assert.equal(byDefault.truncated, true);
  assert.ok(pageCeiling(100_000) >= 5000);
});

test('buildFragment stops a runaway upstream at the page ceiling', async () => {
  let calls = 0;
  const rec = provider({ sync: { maxAssets: 100 } });
  const runaway = {
    ...createProvider(rec, undefined),
    async listAssets(cursor?: string) {
      calls++;
      return { assets: [], next: String(Number(cursor ?? 0) + 1) };
    },
  };
  const frag = await buildFragment(rec, runaway, () => 0);
  assert.equal(calls, pageCeiling(100));
  assert.equal(frag.truncated, true);
  assert.match(frag.notes?.[0] ?? '', /Stopped after 50 pages/);
});

test('the ext byte cache keeps items under the limits and drops the least recently used', async () => {
  const cache = createExtCache({ maxBytes: 10, maxItemBytes: 6 });
  cache.put('a', { bytes: Buffer.from('aaaa'), contentType: 'x' });
  cache.put('b', { bytes: Buffer.from('bbbb'), contentType: 'x' });
  assert.ok(cache.get('a'), 'a is now the most recent');
  cache.put('c', { bytes: Buffer.from('cccc'), contentType: 'x' });
  assert.equal(cache.get('b'), undefined, 'b was the least recently used');
  assert.ok(cache.get('a') && cache.get('c'));
  cache.put('big', { bytes: Buffer.from('1234567'), contentType: 'x' });
  assert.equal(cache.get('big'), undefined, 'an item over maxItemBytes is never kept');

  const out: Buffer[] = [];
  await pipeline(Readable.from([Buffer.from('ab'), Buffer.from('cd')]), cache.tee('t', 'image/png'), async function* (src) {
    for await (const chunk of src) out.push(chunk as Buffer);
  });
  assert.equal(Buffer.concat(out).toString(), 'abcd', 'the tee passes bytes through');
  assert.equal(cache.get('t')?.bytes.toString(), 'abcd');
  assert.equal(cache.get('t')?.contentType, 'image/png');

  const off = createExtCache({ maxBytes: 0, maxItemBytes: 0 });
  off.put('a', { bytes: Buffer.from('a'), contentType: 'x' });
  assert.equal(off.get('a'), undefined, 'maxBytes 0 turns the cache off');
});

test('hiding a tag is an input: the next read recomposes without it, and showing it again brings it back', async () => {
  const clock = Date.parse('2026-06-01T00:00:00.000Z');
  const { store, served } = await setup(() => clock);
  const before = await served.forCaller({ groups: ['design'] });
  const tagOf = (index: typeof before.index) => (index.assets ?? []).flatMap((e) => (e.tags as string[] | undefined) ?? []).find((t) => !t.startsWith('provider:'));
  const tag = tagOf(before.index);
  assert.ok(tag, 'the mock DAM carries tags');
  await store.putCatalogTagRule({ scope: '*', hidden: [tag!] });
  const hidden = await served.forCaller({ groups: ['design'] });
  assert.equal(served.compositions(), 2, 'a tag rule moves the fingerprint');
  assert.notEqual(hidden.etag, before.etag);
  assert.ok(!(hidden.index.assets ?? []).some((e) => ((e.tags as string[] | undefined) ?? []).some((t) => t.toLowerCase() === tag!.toLowerCase())), 'the tag is gone from every entry');
  await store.deleteCatalogTagRule('*');
  const shown = await served.forCaller({ groups: ['design'] });
  assert.equal(shown.etag, before.etag, 'the same feed as before the rule');
});
