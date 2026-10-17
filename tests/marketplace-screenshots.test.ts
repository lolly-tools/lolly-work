// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { LISTING_SHOTS, LISTING_VIEWPORT, MANIFEST_FILE, pngDimensions } from '../scripts/capture-marketplace-screenshots.ts';

const assets = new URL('../deploy/marketplaces/assets/', import.meta.url);

test('listing screenshots are the recorded captures from the neutral CI fixture', () => {
  const manifest = JSON.parse(readFileSync(new URL(MANIFEST_FILE, assets), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.source, /^[a-f0-9]{40}$/, 'captures name the Work source that ran the fixture');
  assert.match(manifest.run, /^https:\/\/github\.com\/lolly-tools\/lolly-work\/actions\/runs\/\d+$/, 'captures come from an upstream CI run');
  assert.match(manifest.release.version, /^\d+\.\d+\.\d+$/);
  assert.match(manifest.release.serverImage, /^ghcr\.io\/lolly-tools\/lolly-work-server@sha256:[a-f0-9]{64}$/);
  assert.match(manifest.release.shellSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(manifest.viewport, { ...LISTING_VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light' });
  assert.deepEqual(manifest.shots.map(({ file, title, path, ready }: Record<string, string>) => ({ file, title, path, ready })), LISTING_SHOTS);
  for (const shot of manifest.shots) {
    const bytes = readFileSync(new URL(shot.file, assets));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), shot.sha256, `${shot.file} matches its recorded capture`);
    assert.deepEqual(pngDimensions(bytes), LISTING_VIEWPORT, `${shot.file} is a ${LISTING_VIEWPORT.width} x ${LISTING_VIEWPORT.height} PNG`);
    assert.ok(bytes.length < 1024 * 1024, `${shot.file} stays under 1 MiB for listing uploads`);
  }
  const expected = [...manifest.shots.map((shot: { file: string }) => shot.file), MANIFEST_FILE, 'README.md'].sort();
  assert.deepEqual(readdirSync(assets).sort(), expected, 'the directory holds only recorded captures and their notes');
});

test('PNG dimensions come from the IHDR chunk', () => {
  const header = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0]);
  assert.deepEqual(pngDimensions(header), { width: 1280, height: 720 });
  assert.equal(pngDimensions(header.subarray(0, 20)), null);
  assert.equal(pngDimensions(Uint8Array.from([0xff, 0xd8, 0xff, ...header.subarray(3)])), null);
});
