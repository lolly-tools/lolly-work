// SPDX-License-Identifier: MPL-2.0
/** Hash an isolated full tree or an owning Pod's read-only source. */
import fs from 'node:fs';
import crypto from 'node:crypto';
import path from 'node:path';
const need = (value, message) => { if (!value) throw Error(message); };
const sha = value => crypto.createHash('sha256').update(value).digest('hex');
const parts = []; let count = 0;
for await (const bytes of process.stdin) { count += bytes.length; need(count <= 32 * 1024 ** 2, 'Input exceeds bound'); parts.push(bytes); }
const input = JSON.parse(Buffer.concat(parts));
need(path.isAbsolute(input.root) && fs.realpathSync(input.root) === input.root && Array.isArray(input.files) && input.files.length > 0 && input.files.length <= 100000, 'Canonical full-tree request required');
const expected = new Map(); let total = 0;
for (const file of input.files) {
  need(file.path && !file.path.startsWith('/') && !file.path.includes('\\') && file.path.split('/').every(part => part && part !== '.' && part !== '..') && !expected.has(file.path)
    && /^[a-f0-9]{64}$/.test(file.sha256) && Number.isSafeInteger(file.size) && file.size >= 0, 'Malformed full manifest');
  expected.set(file.path, file); total += file.size;
}
need(total <= 8 * 1024 ** 3, 'Tree bytes exceed bound');
const seen = new Set(); let seal = false;
function walk(relative, depth = 0) {
  need(depth <= 64, 'Tree depth exceeds bound'); const folder = path.join(input.root, relative), stat = fs.lstatSync(folder, { bigint: true });
  need(stat.isDirectory(), 'No linked directories'); const names = fs.readdirSync(folder).sort();
  for (const name of names) {
    need(!/[\u0000-\u001f\u007f\\]/.test(name), 'Unsafe tree name'); const leaf = relative ? `${relative}/${name}` : name, full = path.join(input.root, leaf), before = fs.lstatSync(full, { bigint: true });
    if (before.isDirectory()) { walk(leaf, depth + 1); continue; }
    need(before.isFile(), 'No links or special files');
    const fd = fs.openSync(full, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW), digest = crypto.createHash('sha256'), buffer = Buffer.alloc(1024 * 1024); let bytes = 0;
    try { for (let n; (n = fs.readSync(fd, buffer, 0, buffer.length, null)) > 0;) { bytes += n; need(bytes <= Number(before.size), 'File changed'); digest.update(buffer.subarray(0, n)); } }
    finally { fs.closeSync(fd); }
    const hash = digest.digest('hex'), after = fs.lstatSync(full, { bigint: true });
    need(before.dev === after.dev && before.ino === after.ino && before.size === after.size && before.mtimeNs === after.mtimeNs && before.ctimeNs === after.ctimeNs, 'Tree changed while hashing');
    if (leaf === '.__lolly_release_seal.json' && input.allowSeal === true) { need(hash === input.sealSha256, 'Owner transport seal differs'); seal = true; continue; }
    const expectedFile = expected.get(leaf); need(expectedFile && expectedFile.size === bytes && expectedFile.sha256 === hash, 'Full tree file differs'); seen.add(leaf);
  }
  const after = fs.lstatSync(folder, { bigint: true });
  need(stat.dev === after.dev && stat.ino === after.ino && stat.mtimeNs === after.mtimeNs && stat.ctimeNs === after.ctimeNs
    && JSON.stringify(names) === JSON.stringify(fs.readdirSync(folder).sort()), 'Tree directory changed');
}
walk(''); need(seen.size === expected.size, 'Incomplete full tree');
need(input.allowSeal !== true || input.sealSha256 == null || seal, 'Expected owner transport seal is missing');
console.log(JSON.stringify({ version: 1, status: 'COMPLETE_TREE_HASHES_VERIFIED', verified: true, files: seen.size, totalBytes: total, sealVerified: seal, network: false, database: false }));
