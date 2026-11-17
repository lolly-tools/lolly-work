// SPDX-License-Identifier: MPL-2.0
/** One console source tree; revision URLs replace manually copied bundles. The
 *  revision algorithm lives in server/src/lib/console-revision.ts, which the
 *  server also uses before it calls an entry immutable. */
import { readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { consoleAssetPlan as planOf } from '../server/src/lib/console-revision.ts';

export const CONSOLE_DIR = fileURLToPath(new URL('../console/', import.meta.url));

export function consoleAssetPlan(dir = CONSOLE_DIR): { revision: string; html: string; files: string[] } {
  return planOf(dir);
}

export function checkConsoleAssets(dir = CONSOLE_DIR): string {
  const plan = consoleAssetPlan(dir);
  if (readFileSync(join(dir, 'index.html'), 'utf8') !== plan.html) throw new Error('Console asset revision is stale; run pnpm console:build and commit console/index.html');
  return plan.revision;
}

export function buildConsoleAssets(dir = CONSOLE_DIR): string {
  const plan = consoleAssetPlan(dir);
  if (readFileSync(join(dir, 'index.html'), 'utf8') !== plan.html) writeFileSync(join(dir, 'index.html'), plan.html);
  return plan.revision;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv.slice(2).some(arg => arg !== '--check')) throw new Error('Usage: node scripts/console-assets.ts [--check]');
  const revision = process.argv.includes('--check') ? checkConsoleAssets() : buildConsoleAssets();
  console.log(`PASS console asset revision ${revision}`);
}
