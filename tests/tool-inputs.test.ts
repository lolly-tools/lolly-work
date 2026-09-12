/**
 * readToolInputs reads `<pack>/tools/<id>/tool.json` for ids only. Its two nulls
 * are not the same thing: null is "no manifest in this pack", [] is "a manifest
 * that declares no inputs". A miss is reported once per path, because the
 * silent version of it is how a mounted checkout with no tools/ dir once
 * shipped every tool policy without its manifest and nobody saw a line about it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readToolInputs } from '../server/src/policy/tool-inputs.ts';

/** Run `fn` with console.warn captured, returning what it printed. */
async function capturingWarn(fn: () => Promise<void>): Promise<string[]> {
  const seen: string[] = [];
  const orig = console.warn;
  console.warn = (...args: unknown[]) => {
    seen.push(String(args[0]));
  };
  try {
    await fn();
  } finally {
    console.warn = orig;
  }
  return seen;
}

test('missing manifest is null, an inputless one is [], otherwise ids with their declared types', async () => {
  const pack = mkdtempSync(join(tmpdir(), 'lw-pack-'));
  await capturingWarn(async () => {
    assert.equal(await readToolInputs(pack, 'absent'), null);
  });
  mkdirSync(join(pack, 'tools', 'bare'), { recursive: true });
  writeFileSync(join(pack, 'tools', 'bare', 'tool.json'), '{"id":"bare"}');
  assert.deepEqual(await readToolInputs(pack, 'bare'), []);
  mkdirSync(join(pack, 'tools', 'qr'), { recursive: true });
  writeFileSync(
    join(pack, 'tools', 'qr', 'tool.json'),
    JSON.stringify({ inputs: [{ id: 'url', type: 'url' }, { id: 'rows', type: 'blocks' }, { id: 'untyped' }, { type: 'text' }] }),
  );
  assert.deepEqual(await readToolInputs(pack, 'qr'), [{ id: 'url', type: 'url' }, { id: 'rows', type: 'blocks' }, { id: 'untyped' }]);
  assert.equal(await readToolInputs(pack, '../qr'), null); // ids are flat directory names
});

test('a missing manifest is reported once per path, not on every read', async () => {
  const pack = mkdtempSync(join(tmpdir(), 'lw-pack-'));
  const seen = await capturingWarn(async () => {
    await readToolInputs(pack, 'gone');
    await readToolInputs(pack, 'gone');
    await readToolInputs(pack, 'also-gone');
  });
  assert.equal(seen.length, 2);
  assert.match(seen[0]!, /no manifest for tool "gone" at /);
  assert.match(seen[0]!, /tools\/ \+ catalog\//);
  assert.match(seen[1]!, /"also-gone"/);
});
