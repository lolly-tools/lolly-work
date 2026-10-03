// SPDX-License-Identifier: MPL-2.0
/**
 * The shell freshness scan must find the org-config marker in both build
 * layouts: current Lolly builds write scripts to `_app/`, older ones to
 * `assets/`. Missing either one made a gated instance refuse a current shell.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkShellDist } from '../server/src/lib/shell-dist.ts';
import { detectDist } from '../scripts/demo.ts';

function dist(layout: '_app' | 'assets' | null, marker: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), 'lw-shell-'));
  writeFileSync(join(dir, 'index.html'), '<!doctype html>');
  if (layout) {
    mkdirSync(join(dir, layout));
    writeFileSync(join(dir, layout, 'a.js'), marker ? 'fetch("/api/v1/org-config")' : 'console.log(1)');
  }
  return dir;
}

for (const layout of ['_app', 'assets'] as const) {
  test(`a ${layout}/ build with the marker is fresh for the server check and the demo`, () => {
    const dir = dist(layout, true);
    try {
      assert.deepEqual(checkShellDist(dir), { present: true, hasOrgConfig: true });
      assert.equal(detectDist(dir).fresh, true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
}

test('a build without the marker is stale, and a missing index is absent', () => {
  const stale = dist('_app', false);
  const empty = mkdtempSync(join(tmpdir(), 'lw-shell-'));
  try {
    assert.deepEqual(checkShellDist(stale), { present: true, hasOrgConfig: false });
    assert.equal(detectDist(stale).fresh, false);
    assert.deepEqual(checkShellDist(empty), { present: false, hasOrgConfig: false });
  } finally { rmSync(stale, { recursive: true, force: true }); rmSync(empty, { recursive: true, force: true }); }
});
