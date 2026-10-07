/**
 * The catalog at DAM scale: a mock provider with 20000 synthetic assets
 * (providers/mock-generate.ts) federated into the feed, over real HTTP.
 *
 * Covers the memoised feed and its ETag/304, the opt-in paged feed, the paged
 * browse route with its cursor and facets, the federated-bytes route naming
 * SVGs for what they are and caching bytes by entry version, and a sync cap
 * that says it stopped.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { mockCalls } from '../server/src/catalog/providers/mock.ts';

const COUNT = 20_000;
let server: Server;
let base = '';
let cookie = '';

const RAW_INDEX = {
  version: 1,
  assets: [{
    id: 'acme/logo/primary', name: 'Acme Primary Logo', type: 'vector', tags: ['logo'],
    formats: [{ format: 'svg', url: '/catalog/assets/acme/logo/primary.svg', size: 32 }],
  }],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-scale-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify(RAW_INDEX));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Scale Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [{ email: 'designer@test', groups: ['design'] }] },
    catalogProviders: [
      {
        id: 'big', kind: 'mock', label: 'Big DAM', enabled: true,
        options: { generate: { count: COUNT, svgEvery: 2 } }, mapping: { defaultType: 'image' }, sync: { ttlSeconds: 3600 },
      },
      {
        // Lists 500 assets 50 at a time but may federate only 120 of them.
        id: 'capped', kind: 'mock', label: 'Capped DAM', enabled: true,
        options: { generate: { count: 500, seed: 3 }, pageSize: 50 }, mapping: { defaultType: 'image' }, sync: { ttlSeconds: 3600, maxAssets: 120 },
      },
      {
        // An SVG the upstream labels as a generic download.
        id: 'plain', kind: 'mock', label: 'Plain DAM', enabled: true,
        options: {
          assets: [{
            remoteId: 'p1', name: 'Plain Mark', nativeType: 'file', sections: ['Logos'], tags: [], approved: true,
            updatedAt: '2026-05-01T00:00:00.000Z', formats: [{ format: 'svg', remoteRef: 'file1', filename: 'mark.svg' }],
          }],
          blobText: { p1: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
          blobContentType: { p1: 'application/octet-stream' },
        },
        mapping: { defaultType: 'image' },
      },
    ],
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's9', link: 'l9' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = await fetch(`${base}/api/auth/dev?email=designer%40test`, { redirect: 'manual' });
  cookie = (login.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
});

after(() => server.close());

interface Entry { id: string; name: string; type: string; provider?: string; version: string; formats: Array<{ format: string; url: string }> }

const get = (path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { cookie, ...headers } });

test('the feed carries every synthetic asset, answers 304 to its own ETag, and keeps the body stable', async () => {
  const first = await get('/catalog/assets/index.json');
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag') as string;
  assert.match(etag, /^"[0-9a-f]{32}"$/);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const text = await first.text();
  const body = JSON.parse(text) as { assets: Entry[]; pagedProviders?: unknown };
  assert.equal(body.assets.filter((a) => a.provider === 'big').length, COUNT);
  assert.equal(body.assets.filter((a) => a.provider === 'capped').length, 120);
  assert.equal(body.assets[0]?.id, 'acme/logo/primary', 'pack entries lead, as before');
  assert.equal(body.pagedProviders, undefined, 'the unpaged feed has no pagedProviders key');

  const again = await get('/catalog/assets/index.json', { 'if-none-match': etag });
  assert.equal(again.status, 304);
  assert.equal(again.headers.get('etag'), etag);
  const weak = await get('/catalog/assets/index.json', { 'if-none-match': `"nope", W/${etag}` });
  assert.equal(weak.status, 304, 'a weak or listed tag matches too');

  const third = await get('/catalog/assets/index.json');
  assert.equal(third.headers.get('etag'), etag);
  assert.equal(await third.text(), text, 'the memoised bytes are the same bytes');
});

test('paged=1 leaves the large provider out and names it with its visible count', async () => {
  const full = await get('/catalog/assets/index.json');
  const res = await get('/catalog/assets/index.json?paged=1');
  assert.equal(res.status, 200);
  assert.notEqual(res.headers.get('etag'), full.headers.get('etag'));
  const body = await res.json() as { assets: Entry[]; pagedProviders: Array<{ id: string; label: string; count: number }> };
  assert.equal(body.assets.some((a) => a.provider === 'big'), false);
  assert.equal(body.assets.filter((a) => a.provider === 'capped').length, 120, 'a small provider stays in the feed');
  assert.deepEqual(body.pagedProviders, [{ id: 'big', label: 'Big DAM', count: COUNT }]);
  const cond = await get('/catalog/assets/index.json?paged=1', { 'if-none-match': res.headers.get('etag') as string });
  assert.equal(cond.status, 304);
});

test('the browse route walks a 20000-asset provider in name order with stable cursors and facets', async () => {
  const seen = new Set<string>();
  let cursor: string | null = null;
  let pages = 0;
  let previous: [string, string] | null = null;
  let facetTypes: Array<{ name: string; count: number }> = [];
  do {
    const qs = new URLSearchParams({ source: 'big', limit: '500', ...(cursor ? { cursor } : {}) });
    const res = await get(`/api/v1/catalog/assets?${qs}`);
    assert.equal(res.status, 200);
    const page = await res.json() as { assets: Entry[]; total: number; nextCursor: string | null; version: string; facets: { types: Array<{ name: string; count: number }>; sections: Array<{ name: string; count: number }>; sources: Array<{ id: string; label: string; count: number }> } };
    assert.equal(page.total, COUNT);
    if (pages === 0) {
      facetTypes = page.facets.types;
      assert.equal(page.facets.sections.reduce((n, s) => n + s.count, 0), COUNT);
      assert.deepEqual(page.facets.sources, [{ id: 'big', label: 'Big DAM', count: COUNT }]);
      assert.match(page.version, /^[0-9a-f]{32}$/);
    }
    for (const a of page.assets) {
      assert.ok(!seen.has(a.id), `no repeats across pages (${a.id})`);
      seen.add(a.id);
      const key: [string, string] = [a.name.toLowerCase(), a.id];
      if (previous) assert.ok(previous[0] < key[0] || (previous[0] === key[0] && previous[1] < key[1]), 'sorted by name, then id');
      previous = key;
    }
    cursor = page.nextCursor;
    pages++;
  } while (cursor && pages < 100);
  assert.equal(seen.size, COUNT);
  assert.equal(pages, COUNT / 500);
  assert.deepEqual(facetTypes.sort((a, b) => a.name.localeCompare(b.name)), [{ name: 'raster', count: COUNT / 2 }, { name: 'vector', count: COUNT / 2 }]);
});

test('browse filters, query, 304 and refusals', async () => {
  const bySection = await (await get('/api/v1/catalog/assets?source=big&section=Logos&type=vector&limit=5')).json() as { assets: Entry[]; total: number };
  assert.ok(bySection.total > 0 && bySection.total < COUNT / 2);
  assert.equal(bySection.assets.length, 5);
  assert.ok(bySection.assets.every((a) => a.type === 'vector'));

  const q = await (await get('/api/v1/catalog/assets?q=summit%201')).json() as { assets: Entry[]; total: number };
  assert.ok(q.total > 0);
  assert.ok(q.assets.every((a) => a.name.toLowerCase().includes('summit 1')));

  const tag = await (await get('/api/v1/catalog/assets?tag=logo')).json() as { assets: Entry[] };
  assert.deepEqual(tag.assets.map((a) => a.id), ['acme/logo/primary']);
  const pack = await (await get('/api/v1/catalog/assets?source=pack')).json() as { total: number };
  assert.equal(pack.total, 1);

  const first = await get('/api/v1/catalog/assets?source=capped&limit=10');
  const etag = first.headers.get('etag') as string;
  assert.ok(etag);
  assert.equal((await get('/api/v1/catalog/assets?source=capped&limit=10', { 'if-none-match': etag })).status, 304);
  assert.equal((await get('/api/v1/catalog/assets?source=capped&limit=11', { 'if-none-match': etag })).status, 200, 'another query, another tag');

  const clamped = await (await get('/api/v1/catalog/assets?limit=100000')).json() as { assets: Entry[] };
  assert.equal(clamped.assets.length, 500, 'limit is clamped to 500');
  assert.equal((await get('/api/v1/catalog/assets?cursor=not-ours')).status, 400);
  assert.equal((await get(`/api/v1/catalog/assets?q=${'x'.repeat(301)}`)).status, 400);
  assert.equal((await get('/api/v1/catalog/assets?limit=0')).status, 400);
  assert.equal((await fetch(`${base}/api/v1/catalog/assets`)).status, 401, 'gated like the feed');
  // The inspect wildcard still answers for a real id.
  assert.equal((await get('/api/v1/catalog/assets/acme/logo/primary')).status, 200);
});

test('federated bytes: SVG named as SVG, cached by entry version, 304 and immutable with ?v=', async () => {
  const feed = await (await get('/catalog/assets/index.json')).json() as { assets: Entry[] };
  const svgEntry = feed.assets.find((a) => a.id === 'ext/big/g000000') as Entry;
  const pngEntry = feed.assets.find((a) => a.id === 'ext/big/g000001') as Entry;
  assert.equal(svgEntry.type, 'vector');
  const svgUrl = svgEntry.formats.find((f) => f.format === 'svg')?.url as string;

  const before = mockCalls.get('big')?.blob ?? 0;
  const one = await get(svgUrl);
  assert.equal(one.status, 200);
  assert.equal(one.headers.get('content-type'), 'image/svg+xml');
  assert.equal(one.headers.get('x-content-type-options'), 'nosniff');
  assert.match(one.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.equal(one.headers.get('cache-control'), 'private, max-age=300');
  const etag = one.headers.get('etag') as string;
  assert.ok(etag);
  const svgText = await one.text();
  assert.ok(svgText.startsWith('<svg'));

  const two = await get(svgUrl);
  assert.equal(await two.text(), svgText);
  assert.equal(mockCalls.get('big')?.blob, before + 1, 'the second request came from the cache');
  assert.equal((await get(svgUrl, { 'if-none-match': etag })).status, 304);

  // Even a request naming the current version is kept for five minutes, not
  // forever: losing access to a provider must not leave a long-lived browser copy.
  const pinned = await get(`${svgUrl}?v=${svgEntry.version}`);
  assert.equal(pinned.headers.get('cache-control'), 'private, max-age=300');
  await pinned.arrayBuffer();
  const revalidated = await get(`${svgUrl}?v=${svgEntry.version}`, { 'if-none-match': etag });
  assert.equal(revalidated.status, 304, 'revalidating after the five minutes costs no bytes');
  assert.equal(revalidated.headers.get('cache-control'), 'private, max-age=300');

  const png = await get(pngEntry.formats.find((f) => f.format === 'png')?.url as string);
  assert.equal(png.headers.get('content-type'), 'image/png');
  const pngBytes = new Uint8Array(await png.arrayBuffer());
  assert.deepEqual([...pngBytes.slice(1, 4)], [0x50, 0x4e, 0x47]);
  const thumb = await get(svgEntry.formats.find((f) => f.format === 'thumb')?.url as string);
  assert.equal(thumb.headers.get('content-type'), 'image/png', 'a thumbnail keeps its own type');
  await thumb.arrayBuffer();

  const plain = await get('/catalog/ext/plain/p1/file1');
  assert.equal(plain.status, 200);
  assert.equal(plain.headers.get('content-type'), 'image/svg+xml', 'a generic upstream label is corrected for an svg file');
  await plain.text();
});

test('a sync cap stops the walk and says so in sources and the provider record', async () => {
  const sources = await (await get('/api/v1/catalog/sources')).json() as { sources: Array<{ id: string; count?: number; truncated?: boolean }> };
  const capped = sources.sources.find((s) => s.id === 'capped');
  assert.equal(capped?.count, 120);
  assert.equal(capped?.truncated, true);
  assert.equal(sources.sources.find((s) => s.id === 'big')?.truncated, undefined, 'a complete walk is not marked');
  assert.equal(sources.sources.find((s) => s.id === 'big')?.count, COUNT);
});
