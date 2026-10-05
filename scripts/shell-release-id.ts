// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { closeSync, lstatSync, openSync, readSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function shellReleaseId(directory: string): string {
  const root = resolve(directory);
  if (!lstatSync(join(root, 'index.html')).isFile()) throw new Error('Shell index.html must be a file');
  const entries: [string, string][] = [];
  const buffer = Buffer.alloc(64 * 1024);
  function walk(relative: string): void {
    for (const name of readdirSync(join(root, relative)).sort()) {
      const child = relative ? `${relative}/${name}` : name;
      const full = join(root, child), stat = lstatSync(full);
      if (stat.isDirectory()) walk(child);
      else if (stat.isFile()) {
        const digest = createHash('sha256'), fd = openSync(full, 'r');
        try {
          let bytes: number;
          while ((bytes = readSync(fd, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, bytes));
        } finally { closeSync(fd); }
        entries.push([child, digest.digest('hex')]);
      } else throw new Error(`Shell release contains a non-regular file: ${child}`);
    }
  }
  walk('');
  return `release-${createHash('sha256').update(JSON.stringify(entries)).digest('hex').slice(0, 16)}`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (!process.argv[2]) throw new Error('Usage: node scripts/shell-release-id.ts <shell-dist>');
  console.log(shellReleaseId(process.argv[2]));
}
