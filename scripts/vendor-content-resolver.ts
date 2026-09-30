// SPDX-License-Identifier: MPL-2.0
/** Copy the canonical resolver from the committed submodule; never patch its bytes. */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const pinPath = join(root, 'content-resolver-pin.json');
const target = join(root, 'vendor/@lolly/content-resolver');
const sources = ['packages/node-shell/src/content-roots.ts', 'packages/node-shell/src/repo-root.ts', 'LICENSE'];
const hash = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
if (process.argv.includes('--write')) {
  const source = join(root, 'vendor/lolly');
  const commit = execFileSync('git', ['-C', source, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const files: Record<string, { source: string; checksum: string }> = {};
  mkdirSync(target, { recursive: true });
  for (const path of sources) {
    const bytes = execFileSync('git', ['-C', source, 'show', `${commit}:${path}`]);
    const name = path.split('/').at(-1)!;
    writeFileSync(join(target, name), bytes);
    files[name] = { source: path, checksum: hash(bytes) };
  }
  writeFileSync(pinPath, JSON.stringify({ repository: 'https://github.com/lolly-tools/lolly', commit, files }, null, 2) + '\n');
}
const pin = JSON.parse(readFileSync(pinPath, 'utf8')) as { files: Record<string, { checksum: string }> };
for (const [name, file] of Object.entries(pin.files)) {
  if (hash(readFileSync(join(target, name))) !== file.checksum) throw new Error(`Vendored content resolver differs: ${name}`);
}
console.log('Content resolver matches its committed source pin.');
