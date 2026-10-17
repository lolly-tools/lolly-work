// SPDX-License-Identifier: MPL-2.0
/**
 * File-count bounds in scripts/lib/release-pack.ts. A complete shell release
 * (application plus catalog) may list up to 120,000 files, the same bound the
 * server's shell release parser and the cohort preparer use, so a release they
 * accept is not refused by the pack builder. The catalog delivery inventory
 * keeps its own bound of 100,000 rows.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { INVENTORY_MAX_FILES, RELEASE_MAX_FILES, inventoryPaths, manifestRows } from '../scripts/lib/release-pack.ts';
import type { FileRow } from '../scripts/lib/release-pack.ts';
import { parseReleaseManifest } from '../server/src/lib/shell-release.ts';

const ROOT = realpathSync(mkdtempSync(join(tmpdir(), 'lw-release-bounds-')));
after(() => rmSync(ROOT, { recursive: true, force: true }));

const hash = (text: string): string => createHash('sha256').update(text).digest('hex');

/** A sorted complete-tree manifest of `count` one-byte files with a shell entry point. */
function releaseManifest(count: number): { version: 1; files: FileRow[]; totalBytes: number } {
  const files = Array.from({ length: count - 1 }, (_, i) => ({ path: `_app/f${String(i).padStart(6, '0')}.js`, size: 1, sha256: hash(String(i)) }));
  files.push({ path: 'index.html', size: 1, sha256: hash('index') });
  return { version: 1, files, totalBytes: count };
}

/** A delivery inventory of `count` content-addressed catalog files, written where the pack builder reads it. */
function inventoryFixture(name: string, count: number): { root: string; rows: Map<string, FileRow> } {
  const root = join(ROOT, name), rows = new Map<string, FileRow>();
  const files = Array.from({ length: count }, (_, i) => {
    const sha256 = hash(String(i));
    return { path: `catalog/assets/a${String(i).padStart(6, '0')}.${sha256.slice(0, 16)}.svg`, size: 1, sha256 };
  });
  for (const row of files) rows.set(row.path, row);
  const bytes = JSON.stringify({ version: 1, files });
  rows.set('catalog/delivery-manifest.json', { path: 'catalog/delivery-manifest.json', size: Buffer.byteLength(bytes), sha256: hash(bytes) });
  mkdirSync(join(root, 'catalog'), { recursive: true });
  writeFileSync(join(root, 'catalog/delivery-manifest.json'), bytes, { mode: 0o644 });
  return { root, rows };
}

test('a complete release manifest of up to 120,000 rows is accepted and 120,001 is refused', () => {
  for (const count of [103_421, 120_000]) {
    const rows = manifestRows(Buffer.from(JSON.stringify(releaseManifest(count))));
    assert.equal(rows.size, count);
  }
  assert.throws(() => manifestRows(Buffer.from(JSON.stringify(releaseManifest(120_001)))), /invalid complete tree manifest/);
});

test('the catalog delivery inventory still refuses more than 100,000 rows', () => {
  const full = inventoryFixture('inventory-full', 100_000);
  assert.equal(inventoryPaths(full.root, full.rows).size, 100_000);
  const over = inventoryFixture('inventory-over', 100_001);
  assert.throws(() => inventoryPaths(over.root, over.rows), /invalid catalog delivery inventory/);
});

test('the release bound matches the server shell parser and the cohort preparer', () => {
  assert.equal(RELEASE_MAX_FILES, 120_000);
  assert.equal(INVENTORY_MAX_FILES, 100_000);
  assert.equal(parseReleaseManifest(releaseManifest(120_000)).files.length, 120_000);
  assert.throws(() => parseReleaseManifest(releaseManifest(120_001)), /Invalid shell release manifest/);
  const cohort = spawnSync('python3', ['-B', '-c', `
import importlib.util,json
from pathlib import Path
spec=importlib.util.spec_from_file_location('cohort',Path('scripts/prepare-private-cohort.py'))
m=importlib.util.module_from_spec(spec);spec.loader.exec_module(m)
print(json.dumps([m.MAX_SHELL_FILES,m.MAX_FILES]))
`], { cwd: fileURLToPath(new URL('..', import.meta.url)), encoding: 'utf8' });
  assert.equal(cohort.status, 0, cohort.stderr);
  assert.deepEqual(JSON.parse(cohort.stdout), [RELEASE_MAX_FILES, INVENTORY_MAX_FILES]);
});
