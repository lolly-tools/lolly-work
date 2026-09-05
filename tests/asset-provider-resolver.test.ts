// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createHostedAssetResolver } from '../server/src/catalog/providers/asset-resolver.ts';

test('hosted net assets are allowlisted, optimized and content-cached', async () => {
  let fetched = 0; let optimized = 0;
  const resolve = createHostedAssetResolver({
    allowedOrigins: ['https://assets.example'],
    fetchImpl: async () => { fetched++; return new Response(new Uint8Array([1, 2, 3]), { headers: { 'content-type': 'image/png' } }); },
    optimize: async () => { optimized++; return { bytes: new Uint8Array([4, 5]), mime: 'image/webp', stages: ['resize', 'format-convert', 'strip'] }; },
  });
  const ref = { raw: 'net://assets.example/a.png?format=webp', provider: 'net', scope: 'assets.example', path: 'a.png', query: { format: 'webp' } };
  const a = await resolve(ref); const b = await resolve(ref);
  assert.equal(a?.asset.format, 'webp');
  assert.equal(a?.asset.checksum, digest([4, 5]), 'asset identity describes the transformed bytes');
  assert.equal(a?.asset.meta?.sourceChecksum, digest([1, 2, 3]));
  assert.deepEqual(a?.stages, ['resize', 'format-convert', 'strip']);
  assert.equal(b?.cacheKey, a?.cacheKey);
  assert.equal(fetched, 2, 'content hash is checked before the cache lookup');
  assert.equal(optimized, 1);
  await assert.rejects(() => resolve({ ...ref, scope: 'private.example', raw: 'net://private.example/x', path: 'x' }), /not allowed/);
});

const digest = (bytes: number[]): string => `sha256-${createHash('sha256').update(new Uint8Array(bytes)).digest('base64')}`;

const netRef = { raw: 'net://assets.example/a.png', provider: 'net', scope: 'assets.example', path: 'a.png', query: {} };

test('chunked or dishonest bodies are stopped and cancelled at the decoded byte limit', async () => {
  for (const headers of [{}, { 'content-length': '1' }, { 'content-length': '1000' }]) {
    let cancelled = false, pulls = 0;
    const resolve = createHostedAssetResolver({
      allowedOrigins: ['https://assets.example'], maxBytes: 5,
      fetchImpl: async () => new Response(new ReadableStream({
        pull(controller) { pulls++; controller.enqueue(new Uint8Array(3)); },
        cancel() { cancelled = true; },
      }), { headers }),
    });
    await assert.rejects(resolve(netRef), /byte limit/);
    assert.equal(cancelled, true);
    assert.ok(pulls <= 3, `must stop pulling, got ${pulls}`);
  }
});

test('source and optimized output limits also cover CMS drivers', async () => {
  const ref = { ...netRef, provider: 'cms' };
  const source = createHostedAssetResolver({ allowedOrigins: [], maxBytes: 2, cms: async () => ({ bytes: new Uint8Array(3), mime: 'image/png' }) });
  await assert.rejects(source(ref), /source exceeds/);
  const output = createHostedAssetResolver({ allowedOrigins: [], maxBytes: 2,
    cms: async () => ({ bytes: new Uint8Array(1), mime: 'image/png' }),
    optimize: async () => ({ bytes: new Uint8Array(3), mime: 'image/png', stages: [] }),
  });
  await assert.rejects(output(ref), /output exceeds/);
});

test('LRU is entry-bounded and oversized results are not retained', async () => {
  for (const limits of [{ cacheMaxEntries: 1 }, { cacheMaxBytes: 1 }]) {
    let optimized = 0;
    const resolve = createHostedAssetResolver({ allowedOrigins: ['https://assets.example'], ...limits,
      fetchImpl: async () => new Response(new Uint8Array([1])),
      optimize: async (bytes) => { optimized++; return { bytes, mime: 'image/png', stages: [] }; },
    });
    await resolve(netRef);
    await resolve({ ...netRef, path: 'b.png' });
    await resolve(netRef);
    assert.equal(optimized, 3);
  }
  assert.throws(() => createHostedAssetResolver({ allowedOrigins: [], maxBytes: Infinity }), /limits/);
});
