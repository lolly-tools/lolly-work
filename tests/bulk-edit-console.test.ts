// SPDX-License-Identifier: MPL-2.0
// The console's multi-edit toast tells a session skipped by a revision conflict
// (apply again now) from one a live collaboration room holds (apply again once
// the room closes), using the `reason` POST /api/v1/sessions/bulk sends.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';

const require = createRequire(import.meta.url);
const { JSDOM } = require('jsdom');
const source = readFileSync(new URL('../console/app.js', import.meta.url), 'utf8')
  .replace(/^import .*;$/gm, '').replace(/\nboot\(\);\s*$/, '');

function bulkApplyMessage(out: unknown): string {
  const dom = new JSDOM('<div id="app"></div><div id="live"></div><div id="tip"></div>', { url: 'https://work.test/admin#/projects', runScripts: 'outside-only' });
  try {
    dom.window.matchMedia = () => ({ matches: false });
    dom.window.eval(source + '\nwindow.helpers = { bulkApplyMessage };');
    return dom.window.helpers.bulkApplyMessage(out);
  } finally { dom.window.close(); }
}

test('bulk apply toast counts live-room skips apart from concurrent edits', () => {
  assert.equal(bulkApplyMessage({ applied: 3, skipped: [] }), 'Applied 3 sessions');
  assert.equal(bulkApplyMessage({ applied: 1 }), 'Applied 1 session');
  assert.equal(bulkApplyMessage({ applied: 2, skipped: [{ sessionId: 'a', rev: 1 }] }),
    'Applied 2; skipped 1 with concurrent edits (apply again to retry)');
  assert.equal(bulkApplyMessage({ applied: 0, skipped: [{ sessionId: 'a', rev: 1, reason: 'collab-active' }] }),
    'Applied 0; skipped 1 open in a live collaboration room (apply again after it closes)');
  assert.equal(bulkApplyMessage({ applied: 1, skipped: [
    { sessionId: 'a', rev: 1 }, { sessionId: 'b', rev: 4 },
    { sessionId: 'c', rev: 2, reason: 'collab-active' }, { sessionId: 'd', rev: 7, reason: 'collab-active' },
  ] }), 'Applied 1; skipped 2 with concurrent edits (apply again to retry) and 2 open in a live collaboration room (apply again after they close)');
});
