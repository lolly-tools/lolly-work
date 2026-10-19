// SPDX-License-Identifier: MPL-2.0
import { readFileSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';

export const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const sha256 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export interface DocsPin {
  version: 1;
  repository: string;
  commit: string;
  manifestSha256: string;
  files: Record<string, { sha256: string; source: string }>;
}

export function verifyDocsPin(root = ROOT): DocsPin {
  const pin = JSON.parse(readFileSync(join(root, 'docs-pin.json'), 'utf8')) as DocsPin;
  if (pin.version !== 1 || pin.repository !== 'https://github.com/lolly-tools/lolly' || !/^[a-f0-9]{40}$/.test(pin.commit) || !/^[a-f0-9]{64}$/.test(pin.manifestSha256)) throw new Error('Invalid documentation source pin.');
  const actual: string[] = [];
  const walk = (dir: string, prefix = ''): void => {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const path = prefix + item.name;
      if (item.isDirectory()) walk(join(dir, item.name), path + '/');
      else if (item.isFile()) actual.push(path);
      else throw new Error(`Unsupported documentation bundle entry: ${path}`);
    }
  };
  walk(join(root, 'docs'));
  const expected = Object.keys(pin.files).sort();
  if (!expected.length || JSON.stringify(actual.sort()) !== JSON.stringify(expected)) throw new Error('Documentation bundle file set differs from its pin. Regenerate the bundle from canonical source.');
  for (const path of expected) {
    if (!/^(?:[a-zA-Z0-9._-]+\/)*[a-zA-Z0-9._-]+$/.test(path) || path.split('/').includes('..')) throw new Error(`Invalid pinned documentation path: ${path}`);
    const entry = pin.files[path]!;
    if (!/^[a-f0-9]{64}$/.test(entry.sha256) || sha256(readFileSync(join(root, 'docs', path))) !== entry.sha256) throw new Error(`Documentation bundle changed: ${path}. Edit the canonical Lolly source and regenerate.`);
  }
  return pin;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pin = verifyDocsPin();
  console.log(`Documentation bundle verified: ${Object.keys(pin.files).length} files from ${pin.commit}.`);
}
