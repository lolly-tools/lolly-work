// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { LISTING_SHOTS, LISTING_VIEWPORT, MANIFEST_FILE, PINNED_KEY_REFUSAL, pngDimensions } from '../scripts/capture-marketplace-screenshots.ts';
import { release } from '../scripts/marketplace-packages.ts';

const assets = new URL('../deploy/marketplaces/assets/', import.meta.url);
// The assets README, SUBMISSIONS.md and QUALIFICATION.md name this release as the one
// whose shell views are withheld.
const WITHHELD_RELEASE = '1.1.1';

test('listing screenshots are the recorded captures from the neutral CI fixture', () => {
  const manifest = JSON.parse(readFileSync(new URL(MANIFEST_FILE, assets), 'utf8'));
  assert.equal(manifest.schemaVersion, 1);
  assert.match(manifest.source, /^[a-f0-9]{40}$/, 'captures name the Work source that ran the fixture');
  assert.match(manifest.run, /^https:\/\/github\.com\/lolly-tools\/lolly-work\/actions\/runs\/\d+$/, 'captures come from an upstream CI run');
  assert.deepEqual(manifest.release, { version: release.version, serverImage: release.serverImage, shellSha256: release.shell.sha256 },
    'captures show the release named in release.json; refresh them when the release changes');
  assert.deepEqual(manifest.viewport, { ...LISTING_VIEWPORT, deviceScaleFactor: 1, colorScheme: 'light' });
  type Entry = { file: string; title: string; path: string; ready: string; catalogue: boolean; status: string; sha256?: string; reason?: string };
  const entries: Entry[] = manifest.shots;
  assert.deepEqual(entries.map(({ file, title, path, ready, catalogue }) => ({ file, title, path, ready, catalogue })), LISTING_SHOTS, 'every recipe is recorded once, in order');
  const captured = entries.filter(entry => entry.status === 'captured');
  for (const entry of entries.filter(entry => entry.status !== 'captured')) {
    assert.equal(entry.status, 'withheld');
    assert.ok(entry.catalogue, `${entry.file} may be withheld only when the shell refuses the catalogue`);
    assert.equal(entry.reason, PINNED_KEY_REFUSAL);
    assert.equal(manifest.release.version, WITHHELD_RELEASE, `${entry.file} is documented as withheld for ${WITHHELD_RELEASE} only; update the docs with this check`);
  }
  for (const entry of captured) {
    const bytes = readFileSync(new URL(entry.file, assets));
    assert.equal(createHash('sha256').update(bytes).digest('hex'), entry.sha256, `${entry.file} matches its recorded capture`);
    assert.deepEqual(pngDimensions(bytes), LISTING_VIEWPORT, `${entry.file} is a ${LISTING_VIEWPORT.width} x ${LISTING_VIEWPORT.height} PNG`);
    assert.ok(bytes.length < 1024 * 1024, `${entry.file} stays under 1 MiB for listing uploads`);
  }
  const expected = [...captured.map(entry => entry.file), MANIFEST_FILE, 'README.md'].sort();
  assert.deepEqual(readdirSync(assets).sort(), expected, 'the directory holds only captured files and their notes');
});

test('PNG dimensions come from the IHDR chunk', () => {
  const header = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 0, 0, 0, 2, 0xd0]);
  assert.deepEqual(pngDimensions(header), { width: 1280, height: 720 });
  assert.equal(pngDimensions(header.subarray(0, 20)), null);
  assert.equal(pngDimensions(Uint8Array.from([0xff, 0xd8, 0xff, ...header.subarray(3)])), null);
});
