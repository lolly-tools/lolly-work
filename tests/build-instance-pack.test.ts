// SPDX-License-Identifier: MPL-2.0
/**
 * scripts/build-instance-pack.ts against a throwaway Lolly checkout whose
 * resolver writes a small pack. Pins three things a deploy depends on: an
 * excluded path takes its asset index entries with it (the boot check stats
 * every /catalog/ format URL, so a dangling one refuses the pack in production),
 * the pack's build-time catalog signature is not carried, and a rebuild that
 * fails never leaves the previous build's provenance describing new bytes.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { SOURCE_FILE, incompletePackReason, main, pruneAssetIndex } from '../scripts/build-instance-pack.ts';

const ROOT = mkdtempSync(join(tmpdir(), 'lw-build-pack-'));
const CHECKOUT = join(ROOT, 'lolly');

// The resolver the script runs inside the checkout. Plain JavaScript in a .ts
// file, so Node needs no type stripping for it. FAKE_RESOLVER_FAIL makes it fail
// halfway, after it has already replaced the pack's files.
const RESOLVER = `
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
export function contentRoots({ profile }) { return { profile }; }
export function materializeInto(out) {
  rmSync(join(out, 'tools'), { recursive: true, force: true });
  rmSync(join(out, 'catalog'), { recursive: true, force: true });
  const files = {
    'tools/t1/tool.json': '{"id":"t1"}',
    'catalog/tools/index.json': JSON.stringify({ version: 1, tools: [{ id: 't1' }] }),
    'catalog/tools/index.sig.json': JSON.stringify({ indexHash: 'x', files: { 't1/tool.json': 'y' } }),
    'catalog/tools/index.slim.json': JSON.stringify({ version: '1', tools: [{ id: 't1' }] }),
    'catalog/assets/a1.svg': '<svg/>',
    'catalog/assets/m.svg': '<svg/>',
    'catalog/packs/emoji/e1.json': '{}',
    'catalog/packs/emoji/m.json': '{}',
    'catalog/og/t1.png': 'png',
    'catalog/assets/index.json': JSON.stringify({ version: '1', assets: [
      { id: 'a1', formats: [{ format: 'svg', url: '/catalog/assets/a1.svg' }] },
      { id: 'e1', formats: [{ format: 'json', url: '/catalog/packs/emoji/e1.json' }] },
      { id: 'm1', formats: [{ format: 'json', url: '/catalog/packs/emoji/m.json' }, { format: 'svg', url: '/catalog/assets/m.svg' }] },
      { id: 'r1', formats: [{ format: 'svg', url: 'https://cdn.example.test/r1.svg' }] },
      { id: 'p1', formats: [{ format: 'svg', url: '/catalog/packsuffix/p1.svg' }] },
    ] }, null, 2),
  };
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
    if (process.env.FAKE_RESOLVER_FAIL && rel.startsWith('catalog/')) throw new Error('resolver failed halfway');
  }
}
`;

const git = (...args: string[]): string => {
  const r = spawnSync('git', ['-C', CHECKOUT, '-c', 'user.name=fixture', '-c', 'user.email=fixture@test', ...args], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout.trim();
};

before(() => {
  mkdirSync(join(CHECKOUT, 'packages', 'node-shell', 'src'), { recursive: true });
  writeFileSync(join(CHECKOUT, 'packages', 'node-shell', 'src', 'content-roots.ts'), RESOLVER);
  writeFileSync(join(CHECKOUT, 'package.json'), '{"type":"module"}');
  spawnSync('git', ['init', '-q', CHECKOUT]);
  git('add', '.');
  git('commit', '-q', '-m', 'fixture');
});

after(() => rmSync(ROOT, { recursive: true, force: true }));

/** Run the script quietly; the inspection step's verdict is not under test here. */
async function build(out: string, ...extra: string[]): Promise<number> {
  const original = { log: console.log, error: console.error, warn: console.warn };
  console.log = console.error = console.warn = () => {};
  try {
    return await main(['--lolly', CHECKOUT, '--profile', 'p', '--out', out, ...extra]);
  } finally {
    Object.assign(console, original);
  }
}

test('pruneAssetIndex drops formats under excluded paths and assets left with none', () => {
  const { index, pruned } = pruneAssetIndex({ version: '1', assets: [
    { id: 'a', formats: [{ url: '/catalog/og/a.png' }] },
    { id: 'b', formats: [{ url: '/catalog/og/b.png' }, { url: '/catalog/assets/b.svg' }] },
    { id: 'c', formats: [{ url: '/catalog/ogre/c.png' }] },
    { id: 'd', formats: [{ url: '/catalog/og' }] },
  ] }, ['og']);
  assert.deepEqual((index.assets as Array<{ id: string }>).map((a) => a.id), ['b', 'c']);
  assert.deepEqual(pruned, [{ id: 'a', removed: true }, { id: 'b', removed: false }, { id: 'd', removed: true }]);
});

test('an excluded path takes its asset index entries with it, and the build-time signature is dropped', async () => {
  const out = join(ROOT, 'pack-exclude');
  await build(out, '--exclude', 'packs', '--exclude', 'og');
  assert.ok(!existsSync(join(out, 'catalog', 'packs')) && !existsSync(join(out, 'catalog', 'og')));
  const index = JSON.parse(readFileSync(join(out, 'catalog', 'assets', 'index.json'), 'utf8')) as { assets: Array<{ id: string; formats: Array<{ url: string }> }> };
  assert.deepEqual(index.assets.map((a) => a.id), ['a1', 'm1', 'r1', 'p1']);
  assert.deepEqual(index.assets.find((a) => a.id === 'm1')!.formats.map((f) => f.url), ['/catalog/assets/m.svg']);
  // Every /catalog/ URL left in the index names a file the pack holds.
  for (const asset of index.assets) for (const f of asset.formats) {
    if (f.url.startsWith('/catalog/') && asset.id !== 'p1') assert.ok(existsSync(join(out, f.url.slice(1))), f.url);
  }
  // The pack's build-time signature can never match the index the server
  // serves per caller, and its files map names every tool.
  assert.ok(!existsSync(join(out, 'catalog', 'tools', 'index.sig.json')));
  assert.ok(existsSync(join(out, 'catalog', 'tools', 'index.slim.json')), 'the slim index stays: the server filters it');
  const source = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as Record<string, unknown>;
  assert.deepEqual(source.excluded, ['catalog/packs', 'catalog/og']);
  assert.deepEqual(source.prunedAssets, [{ id: 'e1', removed: true }, { id: 'm1', removed: false }]);
  assert.deepEqual(source.removed, ['catalog/tools/index.sig.json']);
  assert.equal(source.commit, git('rev-parse', 'HEAD'));
  assert.equal(source.incomplete, undefined);
});

test('a rebuild that fails leaves no provenance describing the earlier build', async () => {
  const out = join(ROOT, 'pack-rebuild');
  await build(out);
  const first = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(first.incomplete, undefined);

  writeFileSync(join(CHECKOUT, 'README.md'), 'second commit');
  git('add', '.');
  git('commit', '-q', '-m', 'second');
  process.env.FAKE_RESOLVER_FAIL = '1';
  try {
    assert.equal(await build(out), 1);
  } finally {
    delete process.env.FAKE_RESOLVER_FAIL;
  }
  const after = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(after.incomplete, true, 'the record says the pack is incomplete');
  assert.notEqual(after.commit, first.commit, 'the earlier commit no longer describes these bytes');

  // The marker still lets the script rebuild into the same directory.
  await build(out);
  const rebuilt = JSON.parse(readFileSync(join(out, SOURCE_FILE), 'utf8')) as { commit: string; incomplete?: boolean };
  assert.equal(rebuilt.incomplete, undefined);
  assert.equal(rebuilt.commit, git('rev-parse', 'HEAD'));
});

test('a pack whose build did not finish is named as such for the function build', async () => {
  const out = join(ROOT, 'pack-incomplete');
  process.env.FAKE_RESOLVER_FAIL = '1';
  try {
    await build(out);
  } finally {
    delete process.env.FAKE_RESOLVER_FAIL;
  }
  assert.match(incompletePackReason(out) ?? '', /did not finish/);
  await build(out);
  assert.equal(incompletePackReason(out), null);
  assert.equal(incompletePackReason(join(ROOT, 'no-such-pack')), null);
});
