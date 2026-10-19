// SPDX-License-Identifier: MPL-2.0
/** Refresh the offline bundle from an explicitly selected, clean Lolly revision. */
import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ROOT, sha256, verifyDocsPin, type DocsPin } from './verify-docs-pin.ts';

const args = process.argv.slice(2);
const value = (name: string): string => args.find(arg => arg.startsWith(name + '='))?.slice(name.length + 1) ?? '';
const source = value('--source');
const commit = value('--commit');
const check = args.includes('--check');
if (!source || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('Usage: node scripts/sync-docs-bundle.ts --source=/path/to/lolly --commit=<full-sha> [--check]');
const canonical = resolve(source);
const git = (...argv: string[]): string => execFileSync('git', ['-C', canonical, ...argv], { encoding: 'utf8' }).trim();
if (git('rev-parse', 'HEAD') !== commit) throw new Error('Canonical checkout does not match the requested documentation commit.');
if (git('status', '--porcelain', '--untracked-files=normal')) throw new Error('Canonical checkout must be clean before generating a pinned bundle.');
if (!check && execFileSync('git', ['-C', ROOT, 'status', '--porcelain', '--untracked-files=all', '--ignored', '--', 'docs', 'docs-pin.json'], { encoding: 'utf8' }).trim()) throw new Error('Preserve or commit existing Work bundle edits before syncing.');
const { buildWorkBundle } = await import(pathToFileURL(join(canonical, 'scripts/export-work-docs.ts')).href) as {
  buildWorkBundle(root: string): { files: Record<string, Buffer>; sourcePaths: Record<string, string>; manifestSha256: string };
};
const bundle = buildWorkBundle(canonical);
const pin: DocsPin = {
  version: 1, repository: 'https://github.com/lolly-tools/lolly', commit,
  manifestSha256: bundle.manifestSha256,
  files: Object.fromEntries(Object.entries(bundle.files).sort(([a], [b]) => a.localeCompare(b)).map(([path, bytes]) => [path, { sha256: sha256(bytes), source: bundle.sourcePaths[path]! }])),
};
const pinBytes = JSON.stringify(pin, null, 2) + '\n';
if (check) {
  verifyDocsPin();
  if (readFileSync(join(ROOT, 'docs-pin.json'), 'utf8') !== pinBytes) throw new Error('Documentation pin differs from the selected canonical source.');
  for (const [path, bytes] of Object.entries(bundle.files)) if (!readFileSync(join(ROOT, 'docs', path)).equals(bytes)) throw new Error(`Generated documentation differs: ${path}`);
} else {
  rmSync(join(ROOT, 'docs'), { recursive: true });
  for (const [path, bytes] of Object.entries(bundle.files)) {
    const target = join(ROOT, 'docs', path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }
  writeFileSync(join(ROOT, 'docs-pin.json'), pinBytes);
}
console.log(`${check ? 'Checked' : 'Generated'} ${Object.keys(bundle.files).length} documentation files from ${commit}.`);
