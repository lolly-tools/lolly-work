#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * verify-engine-pin — the MPL "consumed unmodified" compliance check
 * (plans/11-commercial-build.md §3.4). The engine + core are vendored under
 * `vendor/` as a pinned snapshot; this recomputes their content hashes and
 * fails if the vendored source drifts from engine-pin.json. Runs as `pretest`
 * and in CI, so a local patch of the engine can never sneak in.
 *
 * The pin is regenerated from the OSS repo's `scripts/pack-engine.ts` output
 * (see engine-pin.json `note`), never by editing vendor/ by hand.
 *
 *   node scripts/verify-engine-pin.ts
 */
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function contentHash(dir: string): string {
  const files: string[] = [];
  const walk = (d: string): void => {
    for (const name of readdirSync(d).sort()) {
      const full = join(d, name);
      if (statSync(full).isDirectory()) walk(full);
      else files.push(full);
    }
  };
  walk(dir);
  const h = createHash('sha256');
  for (const f of files.sort()) {
    h.update(relative(dir, f).split('\\').join('/'));
    h.update('\0');
    h.update(readFileSync(f));
    h.update('\0');
  }
  return h.digest('hex');
}

function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface Pin {
  core: { version: string; contentHash: string };
  engine: { version: string; contentHash: string };
  schemas: Record<string, string>;
}

const pin = JSON.parse(readFileSync(join(ROOT, 'engine-pin.json'), 'utf8')) as Pin;
const problems: string[] = [];

const checks: Array<{ label: string; dir: string; expect: string }> = [
  { label: `@lolly-tools/core@${pin.core.version}`, dir: join(ROOT, 'vendor', '@lolly-tools', 'core'), expect: pin.core.contentHash },
  { label: `@lolly/engine@${pin.engine.version}`, dir: join(ROOT, 'vendor', '@lolly', 'engine'), expect: pin.engine.contentHash },
];
for (const c of checks) {
  let got: string;
  try {
    got = contentHash(c.dir);
  } catch (err) {
    problems.push(`${c.label}: vendored source missing (${(err as Error).message})`);
    continue;
  }
  if (got !== c.expect) problems.push(`${c.label}: content hash drift\n    expected ${c.expect}\n    got      ${got}`);
}

for (const [name, expect] of Object.entries(pin.schemas)) {
  try {
    const got = sha256File(join(ROOT, 'vendor', '@lolly', 'schemas', name));
    if (got !== expect) problems.push(`schema ${name}: hash drift`);
  } catch {
    problems.push(`schema ${name}: missing from vendor/@lolly/schemas`);
  }
}

if (problems.length) {
  console.error('✗ engine pin verification FAILED — the vendored engine has been modified:\n');
  for (const p of problems) console.error(`  • ${p}`);
  console.error('\n  The engine must be consumed unmodified (MPL Larger-Work compliance).');
  console.error('  Re-vendor from the OSS repo: node scripts/pack-engine.ts, then re-extract into vendor/.');
  process.exit(1);
}
console.log(`✓ engine pin verified — @lolly/engine@${pin.engine.version}, @lolly-tools/core@${pin.core.version}, ${Object.keys(pin.schemas).length} schemas, unmodified.`);
