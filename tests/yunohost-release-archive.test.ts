// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { gunzipSync } from 'node:zlib';
import { tarballName, parseArgs } from '../scripts/yunohost-release.ts';

const sha = (data: Buffer) => createHash('sha256').update(data).digest('hex');

test('release archive survives an excluded manifest commit but detects installed-source changes', async () => {
  const root = mkdtempSync(join(tmpdir(), 'lolly-work-release-tree-'));
  const artifacts = mkdtempSync(join(tmpdir(), 'lolly-work-release-archives-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
  try {
    mkdirSync(join(root, 'scripts')); mkdirSync(join(root, 'console')); mkdirSync(join(root, 'server'));
    mkdirSync(join(root, 'deploy'));
    for (const name of ['yunohost-release.ts', 'console-assets.ts']) {
      cpSync(new URL(`../scripts/${name}`, import.meta.url), join(root, 'scripts', name));
    }
    writeFileSync(join(root, 'package.json'), '{"type":"module","version":"1.1.0"}\n');
    writeFileSync(join(root, 'console', 'index.html'), '<link href="/admin/styles.css"><script src="/admin/app.js"></script>');
    writeFileSync(join(root, 'console', 'app.js'), 'console.log("fixture");\n');
    writeFileSync(join(root, 'console', 'styles.css'), 'body{color:black}\n');
    writeFileSync(join(root, 'server', 'main.ts'), 'export const value = 1;\n');
    writeFileSync(join(root, 'deploy', 'manifest.toml'), 'version = "0.2.0~ynh1"\n');
    const consoleModule = await import(pathToFileURL(join(root, 'scripts', 'console-assets.ts')).href);
    consoleModule.buildConsoleAssets();
    git('init', '--quiet'); git('config', 'user.name', 'Lolly release fixture');
    git('config', 'user.email', 'release-fixture@invalid'); git('config', 'commit.gpgsign', 'false');
    git('add', '.'); git('commit', '--quiet', '-m', 'Application source');
    const release = await import(pathToFileURL(join(root, 'scripts', 'yunohost-release.ts')).href);
    const first = join(artifacts, 'first.tar.gz');
    const firstSource = release.archiveHead('1.1.0', first);
    writeFileSync(join(root, 'deploy', 'manifest.toml'), 'version = "1.1.0~ynh1"\n');
    git('add', 'deploy/manifest.toml'); git('commit', '--quiet', '-m', 'Generated excluded manifest');
    const second = join(artifacts, 'second.tar.gz');
    const secondSource = release.archiveHead('1.1.0', second);
    assert.notEqual(firstSource.commit, secondSource.commit);
    assert.notEqual(firstSource.tree, secondSource.tree);
    assert.equal(firstSource.mtime, 1); assert.equal(secondSource.mtime, 1);
    assert.equal(sha(readFileSync(first)), sha(readFileSync(second)), 'two genuine commits preserve exactly the installed archive bytes');
    const tar = gunzipSync(readFileSync(second));
    let headers = 0;
    for (let offset = 0; offset + 512 <= tar.length && tar[offset];) {
      const header = tar.subarray(offset, offset + 512);
      assert.equal(Number.parseInt(header.subarray(136, 148).toString('ascii').replace(/\0/g, '').trim(), 8), 1, 'every entry has the exact fixed UTC timestamp');
      assert.notEqual(String.fromCharCode(header[156]!), 'g', 'tree archives contain no commit-ID global PAX record');
      const size = Number.parseInt(header.subarray(124, 136).toString('ascii').replace(/\0/g, '').trim(), 8) || 0;
      offset += 512 + Math.ceil(size / 512) * 512; headers++;
    }
    assert.ok(headers > 0);
    const files = execFileSync('tar', ['tzf', second], { encoding: 'utf8' });
    assert.match(files, /lolly-work-1\.1\.0\/server\/main\.ts/);
    assert.doesNotMatch(files, /\/deploy\//);
    assert.throws(() => release.archiveHead('1.1.0', second), /EEXIST/, 'an existing archive is never overwritten');
    writeFileSync(join(root, 'server', 'main.ts'), 'export const value = 2;\n');
    const dirty = join(artifacts, 'dirty.tar.gz');
    assert.throws(() => release.archiveHead('1.1.0', dirty), /working tree is dirty/);
    assert.equal(existsSync(dirty), false);
    git('add', 'server/main.ts'); git('commit', '--quiet', '-m', 'Changed installed source');
    const third = join(artifacts, 'third.tar.gz'); release.archiveHead('1.1.0', third);
    assert.notEqual(sha(readFileSync(second)), sha(readFileSync(third)), 'an installed-source change cannot keep the old archive identity');
  } finally {
    rmSync(root, { recursive: true, force: true }); rmSync(artifacts, { recursive: true, force: true });
  }
});

test('new packaging revisions use distinct immutable URLs and legacy names remain readable', () => {
  assert.equal(tarballName('0.2.0'), 'lolly-work-0.2.0.tar.gz');
  assert.equal(tarballName('1.1.0', 1), 'lolly-work-1.1.0-ynh1.tar.gz');
  assert.equal(tarballName('1.1.0', 2), 'lolly-work-1.1.0-ynh2.tar.gz');
  for (const value of [0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    assert.throws(() => tarballName('1.1.0', value), /positive integer/);
    assert.throws(() => parseArgs(['--ynh-rev', String(value)]), /positive integer/);
  }
});
