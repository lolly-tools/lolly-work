// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs, { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, truncateSync, writeFileSync } from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { RetentionRefusal, retainShellAssets } from '../scripts/retain-shell-assets.ts';
import type { RetainShellOptions } from '../scripts/retain-shell-assets.ts';
import { shellReleaseId } from '../scripts/shell-release-id.ts';

function put(root: string, path: string, bytes: string): void {
  mkdirSync(dirname(join(root, path)), { recursive: true }); writeFileSync(join(root, path), bytes);
}
function fixture(t: { after: (fn: () => void) => void }) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lw-retain-shell-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const previous = join(root, 'previous'), candidate = join(root, 'candidate');
  for (const dir of [previous, candidate]) {
    put(dir, 'index.html', dir === previous ? 'old active index' : 'new active index');
    put(dir, 'catalog/tools/index.json', dir === previous ? 'old catalog' : 'new catalog');
    put(dir, 'catalog/tools/index.sig.json', dir === previous ? 'old signature' : 'new signature');
    put(dir, 'precache.json', dir === previous ? 'old precache' : 'new precache');
    put(dir, '_app/shared-css-hash.css', 'shared styles');
  }
  put(previous, '_app/old-entry-hash.js', 'import "./nested/dependency-hash.js";');
  put(previous, '_app/nested/dependency-hash.js', 'new URL("./engine-hash.wasm", import.meta.url);');
  put(previous, '_app/nested/engine-hash.wasm', 'old wasm payload');
  put(previous, 'ort-hf/old/runtime.js', 'outside retention scope');
  put(candidate, '_app/new-entry-hash.js', 'new entry');
  return {
    root, candidate, previous,
    options: (): RetainShellOptions => ({ candidate, previous, expectedCandidateId: shellReleaseId(candidate), expectedPreviousId: shellReleaseId(previous), out: join(root, 'prepared'), receiptOut: join(root, 'receipt.json') }),
  };
}

test('retains the full bundled dependency tree, leaves active files exact and binds established shell IDs', t => {
  const f = fixture(t), options = f.options(), beforeCandidate = shellReleaseId(f.candidate), beforePrevious = shellReleaseId(f.previous);
  const receipt = retainShellAssets(options);
  assert.equal(receipt.candidate.shellId, beforeCandidate);
  assert.equal(receipt.previous.shellId, beforePrevious);
  assert.equal(receipt.output.shellId, shellReleaseId(options.out));
  assert.notEqual(receipt.output.shellId, beforeCandidate);
  assert.equal(receipt.runtimeQualified, false); assert.equal(receipt.promotionAttempted, false);
  assert.match(receipt.output.inventorySha256, /^[0-9a-f]{64}$/);
  for (const path of ['index.html', 'catalog/tools/index.json', 'catalog/tools/index.sig.json', 'precache.json', '_app/new-entry-hash.js']) {
    assert.deepEqual(readFileSync(join(options.out, path)), readFileSync(join(f.candidate, path)), path);
  }
  for (const path of ['_app/old-entry-hash.js', '_app/nested/dependency-hash.js', '_app/nested/engine-hash.wasm']) {
    assert.deepEqual(readFileSync(join(options.out, path)), readFileSync(join(f.previous, path)), path);
    assert.equal(receipt.retained.find(file => file.path === path)?.action, 'copied');
  }
  assert.equal(receipt.retained.find(file => file.path === '_app/shared-css-hash.css')?.action, 'unchanged');
  assert.equal(existsSync(join(options.out, 'ort-hf')), false);
  assert.equal(shellReleaseId(f.candidate), beforeCandidate); assert.equal(shellReleaseId(f.previous), beforePrevious);
  assert.deepEqual(JSON.parse(readFileSync(options.receiptOut, 'utf8')), receipt);
  assert.equal(lstatSync(options.receiptOut).mode & 0o777, 0o600);
  assert.equal(receipt.output.files.some(file => file.path.includes('receipt')), false);
});

test('inventories and merged identities are deterministic across file creation order and custody paths', t => {
  const f = fixture(t), first = retainShellAssets(f.options());
  const other = join(f.root, 'other'); mkdirSync(other);
  for (const [input, name, files] of [[f.candidate, 'candidate', first.candidate.files], [f.previous, 'previous', first.previous.files]] as const) {
    for (const file of [...files].reverse()) put(join(other, name), file.path, readFileSync(join(input, file.path), 'utf8'));
  }
  const second = retainShellAssets({ ...f.options(), candidate: join(other, 'candidate'), previous: join(other, 'previous'), out: join(other, 'prepared'), receiptOut: join(other, 'receipt.json') });
  assert.deepEqual(second, first);
});

test('different-byte collision refuses before output or receipt creation', t => {
  const f = fixture(t); put(f.candidate, '_app/shared-css-hash.css', 'different bytes');
  const options = f.options();
  assert.throws(() => retainShellAssets(options), /Same-path/);
  assert.equal(existsSync(options.out), false); assert.equal(existsSync(options.receiptOut), false);
});

test('file/directory conflicts refuse before output creation in both directions', t => {
  for (const shape of ['file', 'directory']) {
    const f = fixture(t);
    if (shape === 'file') put(f.candidate, '_app/nested', 'blocks child');
    else put(f.candidate, '_app/old-entry-hash.js/child', 'blocks file');
    const options = f.options(); assert.throws(() => retainShellAssets(options), /conflicts/);
    assert.equal(existsSync(options.out), false);
  }
});

test('reviewed IDs bind all input files, including non-retained baseline and active candidate files', t => {
  for (const input of ['previous', 'candidate'] as const) {
    const f = fixture(t), options = f.options(); put(f[input], 'index.html', 'tampered active file');
    assert.throws(() => retainShellAssets(options), /reviewed IDs/);
    assert.equal(existsSync(options.out), false); assert.equal(existsSync(options.receiptOut), false);
  }
});

test('refuses symbolic root, ancestor, file and directory paths without reading external contents', t => {
  for (const shape of ['root', 'ancestor', 'file', 'directory'] as const) {
    const f = fixture(t), options = f.options();
    const outside = join(f.root, 'outside'); put(outside, 'secret', 'private bytes');
    if (shape === 'root') { symlinkSync(f.previous, join(f.root, 'link')); options.previous = join(f.root, 'link'); }
    if (shape === 'ancestor') { symlinkSync(f.root, join(f.root, 'alias')); options.previous = join(f.root, 'alias', 'previous'); }
    if (shape === 'file') symlinkSync(join(outside, 'secret'), join(f.previous, '_app', 'escape'));
    if (shape === 'directory') symlinkSync(outside, join(f.previous, '_app', 'escape'));
    assert.throws(() => retainShellAssets(options), /symbolic|regular/);
    assert.equal(existsSync(options.out), false); assert.equal(readFileSync(join(outside, 'secret'), 'utf8'), 'private bytes');
  }
});

test('overlapping input/output and in-tree receipts are refused without changing inputs', t => {
  for (const mutation of [
    (o: RetainShellOptions) => { o.out = join(o.candidate, 'prepared'); },
    (o: RetainShellOptions) => { o.out = dirname(o.candidate); },
    (o: RetainShellOptions) => { o.previous = o.candidate; },
    (o: RetainShellOptions) => { o.receiptOut = join(o.out, 'receipt.json'); },
    (o: RetainShellOptions) => { o.receiptOut = join(o.previous, 'receipt.json'); },
  ]) {
    const f = fixture(t), options = f.options(), before = shellReleaseId(f.candidate); mutation(options);
    assert.throws(() => retainShellAssets(options), /overlap|separate/);
    assert.equal(shellReleaseId(f.candidate), before);
  }
});

test('pre-existing output or receipt is never overwritten', t => {
  for (const occupied of ['out', 'receiptOut'] as const) {
    const f = fixture(t), options = f.options();
    if (occupied === 'out') put(options.out, 'foreign', 'keep output'); else writeFileSync(options.receiptOut, 'keep receipt');
    assert.throws(() => retainShellAssets(options), /exclusive/);
    assert.equal(readFileSync(occupied === 'out' ? join(options.out, 'foreign') : options.receiptOut, 'utf8'), occupied === 'out' ? 'keep output' : 'keep receipt');
  }
});

test('input change after inventories refuses and removes only owned incomplete output', t => {
  const f = fixture(t), options = f.options(), original = fs.writeSync;
  let changed = false;
  t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (!changed) { changed = true; writeFileSync(join(f.previous, '_app/nested/engine-hash.wasm'), 'concurrent input change'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && !error.partialOutput && /inventory|changed/.test(error.message));
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(existsSync(options.out), false); assert.equal(existsSync(options.receiptOut), false);
  assert.equal(readFileSync(join(f.previous, '_app/nested/engine-hash.wasm'), 'utf8'), 'concurrent input change');
});

test('receipt creation race cannot overwrite a competing receipt or claim preparation success', t => {
  const f = fixture(t), options = f.options(), original = fs.openSync;
  let raced = false;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (!raced && args[0] === options.receiptOut) { raced = true; writeFileSync(options.receiptOut, 'competing receipt'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && !error.partialOutput);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(options.out), false); assert.equal(readFileSync(options.receiptOut, 'utf8'), 'competing receipt');
});

test('destination-file creation race refuses O_EXCL and preserves the competing file', t => {
  const f = fixture(t), options = f.options(), original = fs.openSync, destination = join(options.out, '_app/new-entry-hash.js');
  let raced = false;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    if (!raced && args[0] === destination) { raced = true; writeFileSync(destination, 'competing destination'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(destination, 'utf8'), 'competing destination'); assert.equal(existsSync(options.receiptOut), false);
});

test('receipt write failure closes its descriptor and removes tracked incomplete files', t => {
  const f = fixture(t), options = f.options(), originalOpen = fs.openSync, originalWrite = fs.writeSync;
  let receiptFd: number | undefined;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args); if (args[0] === options.receiptOut) receiptFd = fd; return fd;
  });
  t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (args[0] === receiptFd) throw new Error('PRIVATE-IO-DETAIL');
    return originalWrite(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && !error.partialOutput && !error.message.includes('PRIVATE')); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(options.out), false); assert.equal(existsSync(options.receiptOut), false);
  assert.ok(receiptFd !== undefined); const closedFd = receiptFd;
  assert.throws(() => fs.fstatSync(closedFd), { code: 'EBADF' });
});

test('ambiguous created-receipt identity preserves the file, closes its descriptor and reports partial output', t => {
  const f = fixture(t), options = f.options(), originalOpen = fs.openSync, originalStat = fs.fstatSync;
  let receiptFd: number | undefined;
  t.mock.method(fs, 'openSync', (...args: Parameters<typeof fs.openSync>) => {
    const fd = originalOpen(...args); if (args[0] === options.receiptOut) receiptFd = fd; return fd;
  });
  t.mock.method(fs, 'fstatSync', (...args: Parameters<typeof fs.fstatSync>) => {
    if (args[0] === receiptFd) throw new Error('PRIVATE-IDENTITY-DETAIL');
    return originalStat(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput && !error.message.includes('PRIVATE')); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(options.out), false); assert.equal(lstatSync(options.receiptOut).size, 0);
  assert.ok(receiptFd !== undefined); const closedFd = receiptFd;
  assert.throws(() => fs.fstatSync(closedFd), { code: 'EBADF' });
});

test('changed source inode becoming a symlink cannot bring outside bytes into output', t => {
  const f = fixture(t), options = f.options(), original = fs.writeSync;
  const source = join(f.previous, '_app/nested/engine-hash.wasm'), external = join(f.root, 'outside-secret');
  writeFileSync(external, 'never retain outside'); let changed = false;
  t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (!changed) { changed = true; rmSync(source); symlinkSync(external, source); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && !error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(existsSync(options.out), false); assert.equal(readFileSync(external, 'utf8'), 'never retain outside');
});

test('oversized sparse input is refused from metadata before unbounded reads', t => {
  const f = fixture(t), options = f.options(), sparse = join(f.previous, '_app/oversized.bin');
  writeFileSync(sparse, ''); truncateSync(sparse, 9 * 1024 * 1024 * 1024);
  assert.throws(() => retainShellAssets(options), /bounded regular/);
  assert.equal(existsSync(options.out), false); assert.equal(existsSync(options.receiptOut), false);
});

test('foreign additions to staging are preserved and a partial-output refusal is explicit', t => {
  const f = fixture(t), options = f.options(), original = fs.writeSync;
  let added = false;
  t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (!added) { added = true; writeFileSync(join(options.out, 'foreign'), 'do not delete'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try {
    assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput);
  } finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(options.out, 'foreign'), 'utf8'), 'do not delete'); assert.equal(existsSync(options.receiptOut), false);
});

test('relocated output parents cause an explicit uncertain refusal and preserve the replacement parent', t => {
  const f = fixture(t), options = f.options(), original = fs.writeSync;
  const parent = join(f.root, 'output-parent'), moved = join(f.root, 'relocated-parent');
  mkdirSync(parent); options.out = join(parent, 'prepared'); let relocated = false;
  t.mock.method(fs, 'writeSync', (...args: Parameters<typeof fs.writeSync>) => {
    if (!relocated) { relocated = true; renameSync(parent, moved); put(parent, 'foreign', 'replacement owner'); }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(readFileSync(join(parent, 'foreign'), 'utf8'), 'replacement owner');
  assert.equal(existsSync(join(moved, 'prepared')), true); assert.equal(existsSync(options.receiptOut), false);
});

test('CLI reports only bounded sanitized refusal and never logs local input contents or paths', t => {
  const f = fixture(t);
  const result = spawnSync(process.execPath, ['scripts/retain-shell-assets.ts', '--candidate', join(f.root, 'PRIVATE-SOURCE-PATH')], { encoding: 'utf8' });
  assert.equal(result.status, 1); assert.equal(result.stdout, '');
  const refusal = JSON.parse(result.stderr.trim());
  assert.equal(refusal.result, 'REFUSED'); assert.equal(refusal.promotionAttempted, false);
  assert.ok(result.stderr.length < 512); assert.equal(result.stderr.includes(f.root), false); assert.equal(result.stderr.includes('PRIVATE'), false);
});

test('documented six-option CLI prepares only local files and rejects duplicate options', t => {
  const f = fixture(t), options = f.options();
  const args = ['--candidate', options.candidate, '--expected-candidate-id', options.expectedCandidateId, '--previous', options.previous,
    '--expected-previous-id', options.expectedPreviousId, '--out', options.out, '--receipt-out', options.receiptOut];
  const duplicate = spawnSync(process.execPath, ['scripts/retain-shell-assets.ts', ...args, '--candidate', options.candidate], { encoding: 'utf8' });
  assert.equal(duplicate.status, 1); assert.equal(existsSync(options.out), false);
  const result = spawnSync(process.execPath, ['scripts/retain-shell-assets.ts', ...args], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stderr, '');
  assert.deepEqual(JSON.parse(result.stdout), { result: 'PREPARED', shellId: shellReleaseId(options.out), runtimeQualified: false, promotionAttempted: false });
});

test('opt-in clones retain complete lazy closure with separate inodes and unchanged default receipts', t => {
  const f = fixture(t), options = { ...f.options(), copyMode: 'clone' as const }, before = shellReleaseId(f.previous);
  const receipt = retainShellAssets(options);
  assert.equal(receipt.copyMode, 'clone'); assert.equal(receipt.hardlinksUsed, false);
  for (const path of ['index.html', 'catalog/tools/index.json', '_app/nested/engine-hash.wasm']) {
    const source = path.startsWith('_app/nested/') ? f.previous : f.candidate;
    assert.notEqual(lstatSync(join(options.out, path)).ino, lstatSync(join(source, path)).ino);
  }
  writeFileSync(join(options.out, 'catalog/tools/index.json'), 'output-only write');
  assert.equal(readFileSync(join(f.candidate, 'catalog/tools/index.json'), 'utf8'), 'new catalog');
  assert.equal(shellReleaseId(f.previous), before);
});

test('clone mode keeps the same collision and unsupported-mode refusals before output', t => {
  const f = fixture(t); put(f.candidate, '_app/shared-css-hash.css', 'collision');
  assert.throws(() => retainShellAssets({ ...f.options(), copyMode: 'clone' }), /Same-path/); assert.equal(existsSync(f.options().out), false);
  assert.throws(() => retainShellAssets({ ...f.options(), copyMode: 'other' as 'clone' }), /Unknown/);
});

test('clone output replacement is refused and preserves the competing inode', t => {
  const f = fixture(t), options = { ...f.options(), copyMode: 'clone' as const }, original = fs.readdirSync;
  const destination = join(options.out, '_app/new-entry-hash.js'); let replaced = false;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (!replaced && args[0] === options.out && existsSync(destination)) {
      replaced = true; rmSync(destination); writeFileSync(destination, 'competing replacement');
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(replaced, true); assert.equal(readFileSync(destination, 'utf8'), 'competing replacement');
  assert.equal(readFileSync(join(f.candidate, '_app/new-entry-hash.js'), 'utf8'), 'new entry');
});

test('clone adoption refuses changed bytes even when the target keeps its inode and size', t => {
  const f = fixture(t), options = { ...f.options(), copyMode: 'clone' as const }, original = fs.readdirSync;
  const destination = join(options.out, '_app/new-entry-hash.js'); let changed = false;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (!changed && args[0] === options.out && existsSync(destination)) {
      changed = true; const before = lstatSync(destination, { bigint: true });
      writeFileSync(destination, 'bad entry');
      const after = lstatSync(destination, { bigint: true });
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(readFileSync(destination, 'utf8'), 'bad entry');
  assert.equal(existsSync(options.receiptOut), false);
});

test('cleanup preserves an adopted clone changed in place before final inventory', t => {
  const f = fixture(t), options = { ...f.options(), copyMode: 'clone' as const }, original = fs.readdirSync;
  const destination = join(options.out, '_app/new-entry-hash.js'); let inventories = 0, changed = false;
  t.mock.method(fs, 'readdirSync', (...args: Parameters<typeof fs.readdirSync>) => {
    if (args[0] === options.out && ++inventories === 2) {
      const before = lstatSync(destination, { bigint: true }); writeFileSync(destination, 'bad entry');
      const after = lstatSync(destination, { bigint: true });
      assert.equal(after.dev, before.dev); assert.equal(after.ino, before.ino); assert.equal(after.size, before.size);
      changed = true;
    }
    return original(...args);
  });
  syncBuiltinESMExports();
  try { assert.throws(() => retainShellAssets(options), error => error instanceof RetentionRefusal && error.partialOutput); }
  finally { t.mock.restoreAll(); syncBuiltinESMExports(); }
  assert.equal(changed, true); assert.equal(readFileSync(destination, 'utf8'), 'bad entry');
  assert.equal(existsSync(options.receiptOut), false);
});
