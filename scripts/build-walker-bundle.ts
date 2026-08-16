#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/**
 * build-walker-bundle - produce the capture-time DOM→SVG walker bundle.
 *
 * The control-plane docs render every admin-console screenshot as a real VECTOR
 * SVG (geometry that zooms/diffs/re-renders), not a raster - the same property
 * the OSS /info shots carry. The walker that turns a live DOM subtree into SVG
 * is the web shell's `renderSvgFromHtml` (shells/web/src/bridge/export.ts). It
 * MUST run inside a real browser (it reads getComputedStyle / getBoundingClientRect
 * for every node - jsdom returns zeros), so we bundle it into a single injectable
 * IIFE that the capture harness (scripts/capture-console.ts) drops into each
 * console page via Playwright `addScriptTag`, then calls `window.__lollyWalkerShot`.
 *
 * IMPORTANT - this is a CAPTURE-TIME tool, never shipped to the console. The
 * runtime `/admin` console stays air-gap-clean and no-build; this ~500 KB bundle
 * only ever lives in a headless browser during a shot capture. That is what lets
 * lolly-work have vector screenshots without grafting 6k LOC of web-shell walker
 * into the console itself.
 *
 * The walker source lives in the OSS monorepo (NOT vendored here - vendor/ carries
 * only engine/, and the walker is shell code). So this build needs the sibling
 * OSS repo present, with its node_modules (esbuild + harfbuzzjs). The produced
 * artifact scripts/lib/walker-bundle.js IS committed, so `capture-console.ts`
 * runs without the OSS repo - only rebuilding the bundle needs it.
 *
 *     node scripts/build-walker-bundle.ts
 *     LOLLY_OSS_DIR=/path/to/lolly node scripts/build-walker-bundle.ts
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, statSync, writeFileSync, rmSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir, tmpdir } from 'node:os';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Locate the sibling OSS repo: env override → ../lolly → ~/Build/lolly. */
function resolveOssDir(): string {
  const candidates = [
    process.env.LOLLY_OSS_DIR,
    resolve(ROOT, '..', 'lolly'),
    join(homedir(), 'Build', 'lolly'),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    if (existsSync(join(c, 'shells/web/src/bridge/export.ts'))) return resolve(c);
  }
  throw new Error(
    'Could not find the OSS Lolly repo (needs shells/web/src/bridge/export.ts).\n' +
      `Tried: ${candidates.join(', ')}\n` +
      'Set LOLLY_OSS_DIR=/path/to/lolly.',
  );
}

const ossDir = resolveOssDir();
const esbuild = join(ossDir, 'node_modules/.bin/esbuild');
const walkerSrc = join(ossDir, 'shells/web/src/bridge/export.ts');
if (!existsSync(esbuild)) {
  throw new Error(`OSS repo has no esbuild at ${esbuild} — run \`npm install\` in ${ossDir}.`);
}

// The entry: expose renderSvgFromHtml as window.__lollyWalkerShot(selector, opts).
// Written to a temp file so its absolute import resolves against the OSS tree;
// esbuild bundles everything reachable into one IIFE. Mirrors what main.ts installs
// in the real shell, minus the shell's own crop/settle plumbing (the harness owns that).
const entry = `import { renderSvgFromHtml } from ${JSON.stringify(walkerSrc)};
globalThis.__lollyWalkerShot = async (sel = 'body', opts = {}) => {
  const node = document.querySelector(sel);
  if (!node) throw new Error('walker: no element matches ' + sel);
  const blob = await renderSvgFromHtml(node, {
    convertPaths: true, stackingOrder: true, elementScopedRaster: true, ...opts,
  });
  return { svg: await blob.text() };
};
`;
const entryPath = join(tmpdir(), `lw-walker-entry-${process.pid}.ts`);
writeFileSync(entryPath, entry);

const outDir = join(ROOT, 'scripts/lib');
mkdirSync(outDir, { recursive: true });
const outFile = join(outDir, 'walker-bundle.js');

console.log(`▶ bundling walker from ${walkerSrc}`);
try {
  execFileSync(
    esbuild,
    [
      entryPath,
      '--bundle',
      '--format=iife',
      '--platform=browser',
      '--target=es2022',
      '--minify',
      '--loader:.wasm=binary',
      // The walker never spawns the audio/sequence Web Workers whose modules use
      // import.meta.url; silence the (harmless, dead-code) warnings so the build
      // log stays clean and CI-greppable.
      '--log-override:empty-import-meta=silent',
      `--outfile=${outFile}`,
    ],
    { cwd: ossDir, stdio: ['ignore', 'inherit', 'inherit'] },
  );
} finally {
  rmSync(entryPath, { force: true });
}

const bytes = readFileSync(outFile);
const kb = Math.round(statSync(outFile).size / 1024);
const sha = createHash('sha256').update(bytes).digest('hex').slice(0, 16);
console.log(`✓ wrote scripts/lib/walker-bundle.js — ${kb} KB, sha256:${sha}…`);
console.log('  (commit this artifact; capture-console.ts injects it and needs no OSS repo)');
