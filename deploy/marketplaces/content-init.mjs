// SPDX-License-Identifier: MPL-2.0
import { createHash, generateKeyPairSync } from 'node:crypto';
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

export function archivePaths(listing) {
  const names = listing.trim().split('\n').map((name) => name.replace(/^\.\//, ''));
  if (names.some((name) => name.startsWith('/') || name.includes('\\') || name.split('/').includes('..'))) {
    throw new Error('Shell archive contains an unsafe path');
  }
  for (const expected of ['index.html', 'catalog/tools/index.json']) {
    if (!names.includes(expected)) throw new Error('Shell archive is incomplete');
  }
  return names;
}

function physicalTree(directory) {
  for (const name of readdirSync(directory)) {
    const entry = join(directory, name), info = lstatSync(entry);
    if (info.isSymbolicLink() || (!info.isFile() && !info.isDirectory())) throw new Error('Shell tree contains a special file');
    if (info.isDirectory()) physicalTree(entry);
  }
}

export async function prepareContent(release, contentRoot, keysRoot, download = fetch) {
  if (!/^https:\/\//.test(release.url) || !/^[a-f0-9]{64}$/.test(release.sha256)) throw new Error('Invalid shell release pin');
  for (const root of [contentRoot, keysRoot]) {
    mkdirSync(root, { recursive: true });
    if (!lstatSync(root).isDirectory() || lstatSync(root).isSymbolicLink()) throw new Error('Release roots must be physical directories');
  }
  const keyFile = join(keysRoot, 'catalog.jwk');
  if (!existsSync(keyFile)) {
    const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
    writeFileSync(keyFile, JSON.stringify(privateKey.export({ format: 'jwk' })), { flag: 'wx', mode: 0o600 });
  }
  if (!lstatSync(keyFile).isFile() || lstatSync(keyFile).isSymbolicLink()) throw new Error('Signing key must be a regular file');
  if (process.getuid?.() === 0) chownSync(keyFile, 1000, 1000);
  const target = join(contentRoot, release.sha256);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || readFileSync(join(target, 'release.sha256'), 'utf8').trim() !== release.sha256) {
      throw new Error('Existing content differs; preserve it and inspect before retrying');
    }
    return target;
  }
  // The neutral archive is larger than the container's memory budget.
  const temporary = mkdtempSync(join(contentRoot, '.download-'));
  const staged = mkdtempSync(join(contentRoot, '.staging-'));
  chmodSync(staged, 0o755);
  try {
    const response = await download(release.url, { signal: AbortSignal.timeout(900000), redirect: 'error' });
    if (!response.ok || !response.body) throw new Error('Pinned shell download failed');
    const archive = join(temporary, 'shell.tar.gz'), hash = createHash('sha256');
    const file = await open(archive, 'wx', 0o600);
    let bytes = 0;
    try {
      for await (const chunk of response.body) {
        bytes += chunk.length;
        if (bytes > 1024 * 1024 * 1024) throw new Error('Shell archive exceeds its download bound');
        hash.update(chunk);
        await file.write(chunk);
      }
    } finally { await file.close(); }
    if (hash.digest('hex') !== release.sha256) throw new Error('Pinned shell checksum differs; content not installed');
    const listing = execFileSync('tar', ['-tzf', archive], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    archivePaths(listing);
    const types = execFileSync('tar', ['-tvzf', archive], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    if (types.trim().split('\n').some((line) => !/^[-d]/.test(line))) throw new Error('Shell archive contains a link or special file');
    const shell = join(staged, 'shell');
    mkdirSync(shell);
    execFileSync('tar', ['-xzf', archive, '--no-same-owner', '-C', shell], { stdio: 'pipe' });
    physicalTree(shell);
    const pack = join(staged, 'pack');
    mkdirSync(pack);
    for (const name of ['tools', 'catalog']) cpSync(join(shell, name), join(pack, name), { recursive: true });
    writeFileSync(join(staged, 'release.sha256'), release.sha256 + '\n');
    renameSync(staged, target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.env.LW_DISTRIBUTION_INIT === '1') {
  await prepareContent({ url: process.env.LW_SHELL_URL, sha256: process.env.LW_SHELL_SHA256 }, '/content', '/keys');
  mkdirSync('/state', { recursive: true });
  const state = lstatSync('/state');
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Configuration state must be a physical directory');
  if (state.uid === 0) { chmodSync('/state', 0o700); chownSync('/state', 1000, 1000); }
  else if (state.uid !== 1000 || (state.mode & 0o777) !== 0o700) throw new Error('Inspect configuration state ownership and permissions');
}
