// SPDX-License-Identifier: MPL-2.0
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from 'node:crypto';
import { chmodSync, chownSync, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { brotliCompressSync, constants, gzipSync } from 'node:zlib';

const coordinate = /^[A-Za-z0-9_-]{43}$/;
const publicCoordinates = (key) => {
  if (key?.kty !== 'EC' || key.crv !== 'P-256' || !coordinate.test(key.x) || !coordinate.test(key.y)) throw new Error('Catalogue keys must be P-256 JWKs');
  return { kty: 'EC', crv: 'P-256', x: key.x, y: key.y };
};

/** The public half of this installation's catalogue signing key. */
export function installationCatalogueKey(keyFile) {
  return publicCoordinates(createPublicKey(createPrivateKey({ key: JSON.parse(readFileSync(keyFile, 'utf8')), format: 'jwk' })).export({ format: 'jwk' }));
}

/**
 * The release shell pins the publisher's catalogue key at build time, and refuses any
 * catalogue that key did not sign. Work signs each person's filtered catalogue with this
 * installation's key instead, so the shell this installation serves must pin that key.
 * The coordinates are rewritten in place (equal length) in the shell's own scripts, and
 * their precompressed copies are rebuilt. The pack copy keeps the publisher's signature,
 * which the server verifies against the pinned publisher key.
 */
export function bindShellCatalogueKey(shell, publisher, installation) {
  const from = publicCoordinates(publisher), to = publicCoordinates(installation);
  const app = join(shell, '_app'), files = [];
  for (const name of readdirSync(app).sort()) {
    const file = join(app, name);
    if (!name.endsWith('.js') || !lstatSync(file).isFile()) continue;
    const text = readFileSync(file, 'latin1'), x = text.split(from.x).length - 1, y = text.split(from.y).length - 1;
    if (x !== y) throw new Error(`${name} carries an incomplete catalogue key`);
    if (!x) continue;
    const bytes = Buffer.from(text.split(from.x).join(to.x).split(from.y).join(to.y), 'latin1');
    writeFileSync(file, bytes);
    if (existsSync(file + '.br')) writeFileSync(file + '.br', brotliCompressSync(bytes, { params: { [constants.BROTLI_PARAM_QUALITY]: 11, [constants.BROTLI_PARAM_SIZE_HINT]: bytes.length } }));
    if (existsSync(file + '.gz')) writeFileSync(file + '.gz', gzipSync(bytes, { level: 9 }));
    files.push(name);
  }
  if (!files.some((name) => name.startsWith('web-boot-'))) throw new Error('The shell does not pin the release catalogue key; content not installed');
  return { publisher: from, installation: to, files };
}

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
  // This service runs as root with only CHOWN, so it reads the key as the file's owner
  // and then hands the file back to the server's user.
  const asRoot = process.getuid?.() === 0;
  let installation = null;
  try {
    if (asRoot) chownSync(keyFile, 0, 0);
    if (release.catalogPublicKey) installation = installationCatalogueKey(keyFile);
  } finally {
    if (asRoot) chownSync(keyFile, 1000, 1000);
  }
  const target = join(contentRoot, release.sha256);
  if (existsSync(target)) {
    if (lstatSync(target).isSymbolicLink() || readFileSync(join(target, 'release.sha256'), 'utf8').trim() !== release.sha256) {
      throw new Error('Existing content differs; preserve it and inspect before retrying');
    }
    const marker = join(target, 'catalogue-key.json');
    const bound = installation && existsSync(marker) ? JSON.parse(readFileSync(marker, 'utf8')).installation : null;
    if (installation && (bound?.x !== installation.x || bound?.y !== installation.y)) {
      throw new Error('Existing content does not trust this installation\'s catalogue key; preserve it and inspect before retrying');
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
    if (installation) {
      const binding = bindShellCatalogueKey(shell, release.catalogPublicKey, installation);
      writeFileSync(join(staged, 'catalogue-key.json'), JSON.stringify(binding, null, 2) + '\n');
    }
    writeFileSync(join(staged, 'release.sha256'), release.sha256 + '\n');
    renameSync(staged, target);
    return target;
  } finally {
    rmSync(temporary, { recursive: true, force: true });
    rmSync(staged, { recursive: true, force: true });
  }
}

if (process.env.LW_DISTRIBUTION_INIT === '1') {
  await prepareContent({ url: process.env.LW_SHELL_URL, sha256: process.env.LW_SHELL_SHA256,
    catalogPublicKey: JSON.parse(process.env.LW_SOURCE_CATALOG_PUBLIC_KEY ?? 'null') ?? undefined }, '/content', '/keys');
  mkdirSync('/state', { recursive: true });
  const state = lstatSync('/state');
  if (!state.isDirectory() || state.isSymbolicLink()) throw new Error('Configuration state must be a physical directory');
  if (state.uid === 0) { chmodSync('/state', 0o700); chownSync('/state', 1000, 1000); }
  else if (state.uid !== 1000 || (state.mode & 0o777) !== 0o700) throw new Error('Inspect configuration state ownership and permissions');
}
