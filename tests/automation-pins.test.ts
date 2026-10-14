// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { parse } from 'yaml';

test('workflow dependencies use immutable revisions', () => {
  const directory = new URL('../.github/workflows/', import.meta.url);
  let dependencies = 0;
  function inspect(value: unknown, file: string): void {
    if (!value || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value)) {
      if (key === 'uses' && typeof child === 'string' && !child.startsWith('./')) {
        dependencies++;
        const immutable = child.startsWith('docker://')
          ? /@sha256:[a-f0-9]{64}$/.test(child)
          : /@[a-f0-9]{40}$/.test(child);
        assert.ok(immutable, `${file}: dependency requires an immutable revision`);
      } else inspect(child, file);
    }
  }
  for (const file of readdirSync(directory).filter(name => /\.ya?ml$/.test(name))) {
    inspect(parse(readFileSync(new URL(file, directory), 'utf8')), file);
  }
  assert.ok(dependencies > 0);
});
