// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import fs, { appendFileSync, chmodSync, lstatSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { sha256, shellFileCustody, shellFileStamp } from '../scripts/shell-update-files.ts';

function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lw-shell-custody-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, path: join(root, 'asset') };
}

test('fresh custody hashes empty, tiny, chunk-boundary and large files with bounded read buffers', t => {
  const f = fixture(t), original = fs.readSync;
  let buffers: number[] = [];
  t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
    buffers.push(args[1].byteLength); return original(...args);
  });
  syncBuiltinESMExports();
  try {
    for (const length of [0, 1, 63, 65_535, 65_536, 65_537, 1_048_575, 1_048_576, 1_048_577, 4_194_321]) {
      const bytes = Buffer.alloc(length);
      for (let index = 0; index < length; index++) bytes[index] = index % 251;
      writeFileSync(f.path, bytes); buffers = [];
      const expected = { size: length, sha256: sha256(bytes), stamp: shellFileStamp(lstatSync(f.path, { bigint: true })) };
      assert.deepEqual(shellFileCustody(f.path), expected);
      assert.ok(buffers.length > 0, 'Even an empty file must attempt an EOF read.');
      assert.ok(buffers.every(size => size >= 1 && size <= Math.max(1, Math.min(length, 1024 * 1024))), `Oversized read buffer for ${length} bytes.`);
    }
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
});

test('custody refuses growth from empty and tiny files and closes the descriptor', t => {
  const f = fixture(t), original = fs.readSync;
  for (const initial of ['', 'abc']) {
    writeFileSync(f.path, initial); let descriptor: number | undefined, changed = false;
    t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      descriptor = args[0];
      if (!changed) { changed = true; appendFileSync(f.path, 'extra'); }
      return original(...args);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => shellFileCustody(f.path), /grew during reading/); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(changed, true); assert.ok(descriptor !== undefined);
    const closedDescriptor = descriptor;
    assert.throws(() => fs.fstatSync(closedDescriptor), { code: 'EBADF' });
  }
});

test('custody refuses truncation, same-size rewrites and path replacement during reads', t => {
  const f = fixture(t), original = fs.readSync;
  for (const mutation of ['truncate', 'rewrite', 'replace']) {
    const bytes = Buffer.alloc(1024 * 1024 + 17, 23); writeFileSync(f.path, bytes);
    let changed = false;
    t.mock.method(fs, 'readSync', (...args: Parameters<typeof fs.readSync>) => {
      const count = original(...args);
      if (!changed) {
        changed = true;
        if (mutation === 'truncate') truncateSync(f.path, 1);
        else if (mutation === 'rewrite') writeFileSync(f.path, Buffer.alloc(bytes.length, 42));
        else { renameSync(f.path, join(f.root, 'previous')); writeFileSync(f.path, bytes); }
      }
      return count;
    });
    syncBuiltinESMExports();
    try { assert.throws(() => shellFileCustody(f.path), /changed while reading/); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(changed, true);
  }
});

test('custody refuses inode and symlink substitutions between path stat and descriptor open', t => {
  const f = fixture(t), original = fs.openSync, outside = join(f.root, 'outside');
  writeFileSync(outside, 'outside bytes');
  for (const replacement of ['file', 'symlink']) {
    rmSync(f.path, { force: true }); writeFileSync(f.path, 'original bytes'); let changed = false;
    t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
      if (!changed && args[0] === f.path) {
        changed = true; renameSync(f.path, join(f.root, `before-${replacement}`));
        if (replacement === 'file') writeFileSync(f.path, 'original bytes'); else symlinkSync(outside, f.path);
      }
      return original(...args);
    });
    syncBuiltinESMExports();
    try { assert.throws(() => shellFileCustody(f.path), replacement === 'file' ? /changed before reading/ : { code: 'ELOOP' }); }
    finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
    assert.equal(changed, true); assert.equal(readFileSync(outside, 'utf8'), 'outside bytes');
  }
});

test('custody retains bounded regular-file and writable-file refusals', t => {
  const f = fixture(t);
  assert.throws(() => shellFileCustody(f.root), /Bounded regular/);
  writeFileSync(f.path, ''); truncateSync(f.path, 9 * 1024 ** 3);
  assert.throws(() => shellFileCustody(f.path), /Bounded regular/);
  truncateSync(f.path, 0); chmodSync(f.path, 0o666);
  assert.throws(() => shellFileCustody(f.path), /Bounded regular/);
  chmodSync(f.path, 0o644);
});
