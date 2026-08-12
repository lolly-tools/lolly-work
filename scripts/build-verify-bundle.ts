#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * build-verify-bundle — the client-side C2PA verifier the console's #/verify view
 * runs, so a reader checks a shot's credential ON THEIR OWN MACHINE, against the
 * exact bytes they received. The deployment never marks its own homework: the
 * credential line STATES claims (decoded server-side); verification is a separate,
 * independent act in the reader's browser.
 *
 * The verifier is the VENDORED engine's C2PA verify stack (verifyC2pa +
 * resolveVerdict + trust anchors). It is pure TypeScript — WebCrypto only, no
 * WASM, no network, no node: APIs (see vendor/@lolly/engine/src/bytes.ts) — so it
 * bundles into a small IIFE that runs in the browser as-is. Served from the
 * deployment at /admin/verify.js and loaded ON DEMAND by the verify view, so the
 * console's main path stays no-build and nothing external is ever fetched
 * (air-gap intact). Built from lolly-work's OWN vendored engine, so the verifier
 * is the pinned, checksum-verified code (engine-pin.json), not a drift.
 *
 * Uses the sibling OSS repo purely as the esbuild HOST (lolly-work is zero-dep and
 * ships no bundler); the SOURCE bundled is entirely lolly-work's vendor/.
 *
 *     node scripts/build-verify-bundle.ts
 *     LOLLY_OSS_DIR=/path/to/lolly node scripts/build-verify-bundle.ts
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function resolveEsbuild(): string {
  for (const c of [process.env.LOLLY_OSS_DIR, resolve(ROOT, '..', 'lolly'), join(homedir(), 'Build', 'lolly')]) {
    if (c && existsSync(join(c, 'node_modules/.bin/esbuild'))) return join(resolve(c), 'node_modules/.bin/esbuild');
  }
  throw new Error('No esbuild found (needs the sibling OSS repo). Set LOLLY_OSS_DIR=/path/to/lolly.');
}

const esbuild = resolveEsbuild();
const engineIndex = join(ROOT, 'vendor/@lolly/engine/src/index.ts');
if (!existsSync(engineIndex)) throw new Error(`vendored engine not found at ${engineIndex}`);

// Expose exactly the verify surface the #/verify view needs on window.__lollyVerify.
const entry = `import { verifyC2pa, resolveVerdict, c2paTrustAnchors, pemToDer } from ${JSON.stringify(engineIndex)};
globalThis.__lollyVerify = { verifyC2pa, resolveVerdict, c2paTrustAnchors, pemToDer };
`;
const entryPath = join(tmpdir(), `lw-verify-entry-${process.pid}.ts`);
writeFileSync(entryPath, entry);

const outFile = join(ROOT, 'console', 'verify.js');
console.log('▶ bundling the vendored C2PA verifier for the console');
try {
  execFileSync(esbuild, [
    entryPath, '--bundle', '--format=iife', '--platform=browser', '--target=es2022', '--minify',
    `--outfile=${outFile}`,
  ], { cwd: dirname(esbuild), stdio: ['ignore', 'inherit', 'inherit'] });
} finally {
  rmSync(entryPath, { force: true });
}

const bytes = readFileSync(outFile);
const kb = Math.round(statSync(outFile).size / 1024);
const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
console.log(`✓ wrote console/verify.js — ${kb} KB, sha256:${sha}…  (served at /admin/verify.js, loaded on demand)`);
