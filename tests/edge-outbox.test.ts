// SPDX-License-Identifier: MPL-2.0
/**
 * The edge purge outbox on the memory store: validation when rows are written,
 * merging and batching within a provider's request size, the token-bucket
 * budget with the rest moved to a later row, retries with backoff and
 * Retry-After, permanent failures, a missing credential, and one end-to-end
 * pass through the Cloudflare adapter with a mocked fetch.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { EdgePurgeOutbox, type EdgeOutboxOptions } from '../server/src/edge/outbox.ts';
import { validateEdgeConfig, type EdgeProviderConfig } from '../server/src/edge/config.ts';
import { createEdgeAdapter } from '../server/src/edge/registry.ts';
import { BUNNY_CAPABILITIES } from '../server/src/edge/bunny.ts';
import { cloudflareCapabilities } from '../server/src/edge/cloudflare.ts';
import { EdgeApiError, type EdgeAdapter, type EdgeCapabilities, type PurgeReceipt } from '../server/src/edge/types.ts';
import type { EdgePurgeRecord, EdgePurgeResult } from '../server/src/store/types.ts';

const config = validateEdgeConfig({ jurisdiction: 'any', providers: [
  { id: 'eu-cdn', kind: 'bunny', hostnames: ['work.example.eu'], options: { pullZoneId: 42, regions: ['europe'] }, jurisdiction: { logs: 'eu' } },
  { id: 'cf', kind: 'cloudflare', hostnames: ['assets.example.eu'], publicOnly: true, options: { zoneId: '0123456789abcdef0123456789abcdef' } },
] }, ['work.example.eu']);
const [bunnyProvider, cfProvider] = config.providers as [EdgeProviderConfig, EdgeProviderConfig];

/** A fake adapter that records each call and fails on demand. */
function fakeAdapter(provider: EdgeProviderConfig, capabilities: EdgeCapabilities, fail: () => EdgeApiError | null = () => null) {
  const calls: Array<{ kind: 'tags' | 'urls'; items: string[] }> = [];
  const adapter: EdgeAdapter = {
    id: provider.id, kind: provider.kind, jurisdiction: provider.jurisdiction, edgeRegion: 'europe', tagHeader: capabilities.tagHeader, capabilities,
    async purgeTags(items) { const error = fail(); if (error) throw error; calls.push({ kind: 'tags', items }); return { provider: provider.id, kind: 'tags', items: items.length, requests: 1, ids: [`req${calls.length}`] } satisfies PurgeReceipt; },
    async purgeUrls(items) { const error = fail(); if (error) throw error; calls.push({ kind: 'urls', items }); return { provider: provider.id, kind: 'urls', items: items.length, requests: 1, ids: [] } satisfies PurgeReceipt; },
    async verifyZone() { return []; },
  };
  return { adapter, calls };
}

function outbox(store: ReturnType<typeof createMemoryStore>, providers: EdgeProviderConfig[], adapters: Map<string, EdgeAdapter | null>, extra: Partial<EdgeOutboxOptions> = {}) {
  const settled: Array<[EdgePurgeRecord, EdgePurgeResult]> = [];
  const box = new EdgePurgeOutbox(store, { providers, adapterFor: async p => adapters.get(p.id) ?? null, coalesceMs: 0, onSettled: (r, s) => { settled.push([r, s]); }, ...extra });
  return { box, settled };
}

test('enqueue validates items and writes one row per provider and kind', async () => {
  const store = createMemoryStore();
  const { box } = outbox(store, config.providers, new Map());
  const { records, refused } = await box.enqueue({
    tags: ['b_0123456789abcdef', 't_qr-code', 'Bad Tag', 't_*'],
    paths: ['/catalog/og/qr-code.png', '/../etc/passwd', '//evil.example/x'],
    urls: ['https://assets.example.eu/brand.css', 'https://elsewhere.example/x', 'http://work.example.eu/x'],
    reason: 'test',
  });
  assert.deepEqual(records.map(r => [r.providerId, r.kind, r.items]), [
    ['eu-cdn', 'tags', ['b_0123456789abcdef', 't_qr-code']],
    ['eu-cdn', 'urls', ['https://work.example.eu/catalog/og/qr-code.png']],
    ['cf', 'tags', ['b_0123456789abcdef', 't_qr-code']],
    ['cf', 'urls', ['https://assets.example.eu/brand.css', 'https://assets.example.eu/catalog/og/qr-code.png']],
  ]);
  assert.equal(refused.length, 6, refused.join('\n'));
  assert.ok(records.every(r => r.state === 'pending' && r.attempt === 0 && r.reason === 'test'));
  const coalesced = new EdgePurgeOutbox(store, { providers: [bunnyProvider], adapterFor: async () => null });
  const [late] = (await coalesced.enqueue({ tags: ['t_later'], reason: 'test' })).records;
  assert.ok(Date.parse(late!.nextAttemptAt) - Date.now() > 4000, 'events inside the 5 s window go out together');
});

test('due rows are merged, de-duplicated and sent in batches of the provider\'s request size', async () => {
  const store = createMemoryStore();
  const cf = fakeAdapter(cfProvider, cloudflareCapabilities('pro'));
  const { box, settled } = outbox(store, [cfProvider], new Map([['cf', cf.adapter]]));
  await box.enqueue({ tags: ['t_a', 't_b'], reason: 'one' });
  await box.enqueue({ tags: ['t_b', 't_c'], reason: 'two' });
  const many = Array.from({ length: 120 }, (_, i) => `h_${i.toString(16).padStart(16, '0')}`);
  await box.enqueue({ tags: many, reason: 'three' });
  await box.poll();
  assert.deepEqual(cf.calls.map(c => c.items.length), [100, 23], 'three rows, 123 distinct tags, two requests');
  assert.deepEqual(cf.calls[0]!.items.slice(0, 3), ['t_a', 't_b', 't_c']);
  const rows = await store.listEdgePurges(10);
  assert.ok(rows.every(r => r.state === 'done' && r.attempt === 1), JSON.stringify(rows));
  assert.deepEqual(rows[0]!.receipt, { provider: 'cf', kind: 'tags', items: 123, requests: 2, ids: ['req1', 'req2'] });
  assert.equal(settled.length, 3);
  assert.equal(await store.nextEdgePurgeAt(), null);
});

test('the budget caps each pass, and the rest moves to a later row', async () => {
  const store = createMemoryStore();
  let clock = 1_000_000;
  // Two requests at once, refilling at 10 a second, so the deferred row falls due within 100 ms.
  const tight: EdgeCapabilities = { ...BUNNY_CAPABILITIES, tagPurge: { requestsPerSecond: 10, burst: 2, opsPerRequest: 1 }, urlPurge: { requestsPerSecond: 10, burst: 2, opsPerRequest: 1 } };
  const bunny = fakeAdapter(bunnyProvider, tight);
  const { box } = outbox(store, [bunnyProvider], new Map([['eu-cdn', bunny.adapter]]), { now: () => clock });
  await box.enqueue({ tags: ['t_1', 't_2', 't_3'], paths: ['/a.png'], reason: 'burst' });
  await box.poll();
  // Tags and URLs share Bunny's exact bucket: two requests in all, both tags.
  assert.deepEqual(bunny.calls, [{ kind: 'tags', items: ['t_1'] }, { kind: 'tags', items: ['t_2'] }]);
  const rows = await store.listEdgePurges(10);
  const deferred = rows.find(r => r.state === 'pending' && r.kind === 'tags');
  assert.deepEqual(deferred?.items, ['t_3'], 'the tag the budget could not cover waits in a new row');
  assert.deepEqual(rows.find(r => r.kind === 'tags' && r.state === 'done')?.receipt,
    { provider: 'eu-cdn', kind: 'tags', items: 2, requests: 2, ids: ['req1', 'req2'], deferred: 1, deferredTo: deferred!.id });
  assert.ok(rows.some(r => r.kind === 'urls' && r.state === 'pending' && r.attempt === 0), 'the URL row was not claimed without budget');
  clock += 1_000; // the bucket refills
  await new Promise(resolve => setTimeout(resolve, 150)); // the deferred row falls due on the store's clock
  await box.poll();
  assert.deepEqual(bunny.calls.slice(2).map(c => c.items[0]), ['t_3', 'https://work.example.eu/a.png']);
  assert.ok((await store.listEdgePurges(10)).every(r => r.state === 'done'));
});

test('a failure retries with backoff and Retry-After, then stops; a malformed request stops at once', async () => {
  const store = createMemoryStore();
  let failure: EdgeApiError | null = new EdgeApiError('Bunny tag purge answered 503', { status: 503 });
  const bunny = fakeAdapter(bunnyProvider, BUNNY_CAPABILITIES, () => failure);
  const { box, settled } = outbox(store, [bunnyProvider], new Map([['eu-cdn', bunny.adapter]]), { retryDelaysMs: [0, 0] });
  // Rows written in the same millisecond tie on createdAt, so each check finds its row by reason.
  const byReason = async (reason: string) => (await store.listEdgePurges(50)).find(r => r.reason === reason)!;
  await box.enqueue({ tags: ['t_retry'], reason: 'retry' });
  await box.poll();
  let row = await byReason('retry');
  assert.deepEqual([row!.state, row!.attempt, row!.lastError], ['pending', 1, 'Bunny tag purge answered 503']);
  await box.poll();
  await box.poll();
  row = await byReason('retry');
  assert.equal(row!.state, 'failed');
  assert.equal(row!.attempt, 3);
  assert.match(row!.lastError!, /No attempts remain \(limit 3\)/);
  assert.deepEqual(settled.map(([, s]) => s.state), ['failed']);

  failure = new EdgeApiError('slow down', { status: 429, retryAfterMs: 60_000 });
  const patient = outbox(store, [bunnyProvider], new Map([['eu-cdn', bunny.adapter]]), { retryDelaysMs: [5_000] }).box;
  await patient.enqueue({ tags: ['t_later'], reason: 'retry-after' });
  await patient.poll();
  row = await byReason('retry-after');
  assert.equal(row!.state, 'pending');
  assert.ok(Date.parse(row!.nextAttemptAt) - Date.now() > 55_000, 'Retry-After outranks a shorter backoff');

  failure = new EdgeApiError('bad tag', { status: 400, permanent: true });
  const strict = outbox(store, [bunnyProvider], new Map([['eu-cdn', bunny.adapter]]));
  await strict.box.enqueue({ tags: ['t_malformed'], reason: 'permanent' });
  await strict.box.poll();
  row = await byReason('permanent');
  assert.deepEqual([row!.state, row!.attempt, row!.lastError], ['failed', 1, 'bad tag']);
  assert.equal(strict.settled.length, 1);
});

test('without a credential the rows wait with a clear error and never reach a provider', async () => {
  const store = createMemoryStore();
  const { box } = outbox(store, [cfProvider], new Map([['cf', null]]));
  await box.enqueue({ tags: ['t_x'], reason: 'missing' });
  await box.poll();
  const [row] = await store.listEdgePurges(1);
  assert.equal(row!.state, 'pending');
  assert.match(row!.lastError!, /No credential is available for edge provider cf/);
});

test('end to end through the Cloudflare adapter with a mocked API', async () => {
  const store = createMemoryStore();
  const bodies: unknown[] = [];
  const fetchImpl = (async (_url: string, init?: RequestInit) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(JSON.stringify({ success: true, errors: [], messages: [], result: { id: 'abc123' } }), { status: 200 });
  }) as typeof fetch;
  const adapter = createEdgeAdapter(cfProvider, 'fake-token-for-tests', fetchImpl);
  const { box } = outbox(store, [cfProvider], new Map([['cf', adapter]]));
  await box.enqueue({ tags: ['b_0123456789abcdef'], paths: ['/catalog/og/qr-code.png'], reason: 'brand.change' });
  await box.poll();
  assert.deepEqual(bodies, [{ tags: ['b_0123456789abcdef'] }, { files: ['https://assets.example.eu/catalog/og/qr-code.png'] }]);
  const rows = await store.listEdgePurges(5);
  assert.ok(rows.every(r => r.state === 'done'));
  assert.doesNotMatch(JSON.stringify(rows), /fake-token-for-tests/);
});
