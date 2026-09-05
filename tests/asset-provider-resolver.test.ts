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
