import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mapProviderAsset, providerAssetType } from '../server/src/catalog/federation.ts';
import type { ProviderAssetRef, ProviderRecord } from '../server/src/catalog/providers/types.ts';

const rec: ProviderRecord = {
  id: 'brand', kind: 'brandfolder', label: 'Brand', managedBy: 'db', enabled: true,
  options: {}, mapping: {}, exposure: { groups: '*' }, sync: {},
  createdAt: '2026-10-04', updatedAt: '2026-10-04', state: { assetCount: 0 },
};
const asset: ProviderAssetRef = {
  remoteId: 'photo1', name: 'Photo', nativeType: 'generic_files', sections: ['Photos'], tags: [],
  updatedAt: '2026-10-04T12:00:00Z', hasThumbnail: true,
  formats: [{ format: 'jpeg', remoteRef: 'attachment1', filename: 'photo.jpeg', size: 123 }],
};

test('a real DAM image maps to a selectable, versioned, on-demand catalog asset', () => {
  const mapped = mapProviderAsset(rec, asset);
  assert.equal(mapped.id, 'ext/brand/photo1');
  assert.equal(mapped.type, 'raster');
  assert.equal(mapped.tier, 'on-demand');
  assert.match(mapped.version as string, /^[a-f0-9]{16}$/);
  assert.deepEqual(mapped.formats, [
    { format: 'jpeg', url: '/catalog/ext/brand/photo1/attachment1', filename: 'photo.jpeg', size: 123 },
    { format: 'thumb', url: '/catalog/ext/brand/photo1/thumb' },
  ]);
  assert.equal(mapProviderAsset(rec, { ...asset }).version, mapped.version);
  assert.notEqual(mapProviderAsset(rec, { ...asset, updatedAt: '2026-10-05T12:00:00Z' }).version, mapped.version);
  assert.notEqual(mapProviderAsset(rec, { ...asset, formats: [{ format: 'jpeg', remoteRef: 'new-attachment' }] }).version, mapped.version);
});

test('generic DAM types follow their actual files without classifying source documents as pictures', () => {
  for (const [format, expected] of Object.entries({ jpeg: 'raster', SVG: 'vector', mp4: 'video', mov: 'video', wav: 'audio', otf: 'font', pdf: 'data', ai: 'data', eps: 'data', srt: 'text', glb: 'model' })) {
    assert.equal(providerAssetType({ ...asset, formats: [{ format, remoteRef: 'file' }] }), expected, format);
  }
  assert.equal(providerAssetType({ ...asset, nativeType: 'colors', formats: [] }), 'data');
  assert.equal(providerAssetType({ ...asset, formats: [{ format: 'eps', remoteRef: 'source' }, { format: 'svg', remoteRef: 'web' }] }), 'vector');
});

test('legacy image mapping becomes a usable media type while explicit overrides remain authoritative', () => {
  assert.equal(mapProviderAsset({ ...rec, mapping: { defaultType: 'image' } }, asset).type, 'raster');
  assert.equal(mapProviderAsset({ ...rec, mapping: { typeMap: { generic_files: 'tokens' } }, exposure: { tier: 'core' } }, asset).type, 'tokens');
  assert.equal(mapProviderAsset({ ...rec, exposure: { tier: 'core' } }, asset).tier, 'core');
});
