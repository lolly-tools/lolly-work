// SPDX-License-Identifier: MPL-2.0
/**
 * Build the lolly-work Vercel function via the Build Output API (.vercel/output).
 *
 * WHY this exists: the repo runs `.ts` directly under Node's native type-stripping
 * (every internal import carries a `.ts` extension). Vercel's zero-config @vercel/node
 * transpiles each `.ts` file to `.js` but leaves the `.ts` import specifiers, so the
 * deployed function can't resolve them (ERR_MODULE_NOT_FOUND), and Node refuses to
 * type-strip the vendored engine under node_modules. The fix is to esbuild-bundle the
 * function + vendored engine + pg into plain JS, copy jsdom and native dependencies,
 * and ship it as an explicit Build Output API function.
 *
 * MUST run on the deploy platform (Linux on Vercel), NOT be prebuilt on a Mac: it copies
 * the platform-specific @resvg/resvg-js binary from node_modules, which is not portable.
 * Vercel invokes it as the project's buildCommand (vercel.json).
 */
import { build, buildSync, transformSync } from 'esbuild';
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, readdirSync, existsSync, lstatSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { functionPrefixes, parseRegions, parseShellOrigin, vcFunctionConfig, vercelRoutes } from './vercel-routes.ts';
import { incompletePackReason } from './build-instance-pack.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel', 'output');
const FUNC = join(OUT, 'functions', 'api', 'index.func');
const NM = join(FUNC, 'node_modules');

// Native modules esbuild must not try to bundle — resvg is the real one (a .node
// binary); the rest are optional natives of pg/jsdom that they load only if present.
const NATIVE = ['@resvg/resvg-js', 'sharp', 'canvas', 'bufferutil', 'utf-8-validate', 'pg-native'];
// Loaded at runtime via a non-literal `import(specifier)` (contract.ts), so esbuild
// can't inline them — provide each as a self-contained bundle in the func node_modules.
const RUNTIME_DYNAMIC = ['@lolly/engine', 'jsdom'];

// ESM output that bundles CJS deps (handlebars, ajv, parts of jsdom) needs a real
// `require` — esbuild otherwise emits a stub that throws "Dynamic require of X is not
// supported" the moment that CJS code calls require() (e.g. require('path')). Define one
// from the module's own URL in every bundle's banner.
const REQUIRE_SHIM = "import { createRequire as __lwCreateRequire } from 'node:module'; const require = __lwCreateRequire(import.meta.url);";
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node24', logLevel: 'warning' };

// Private-instance options (deploy/vercel/README.md, "Private instance with the
// Lolly app"). Each is validated before anything is written; with none of them
// set the output is the demo build, byte for byte.
//   LW_SHELL_ORIGIN     https origin the Lolly app is proxied from; switches the
//                       route table to shell mode (scripts/vercel-routes.ts).
//   LW_PACK_DIR         repo-relative pack directory bundled beside packs/demo,
//                       as real files (symlinks dereferenced).
//   LW_FUNCTION_REGION  Vercel region id(s) for the function, e.g. fra1.
const env = (name) => process.env[name]?.trim() || undefined;
const SHELL_ORIGIN = env('LW_SHELL_ORIGIN') && parseShellOrigin(env('LW_SHELL_ORIGIN'));
const REGIONS = env('LW_FUNCTION_REGION') && parseRegions(env('LW_FUNCTION_REGION'));
const PACK_REL = env('LW_PACK_DIR') && (() => {
  const abs = resolve(ROOT, env('LW_PACK_DIR'));
  const rel = relative(ROOT, abs);
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new Error('LW_PACK_DIR must be a directory inside this repository, such as packs/my-instance');
  if (!existsSync(abs) || !statSync(abs).isDirectory()) throw new Error(`LW_PACK_DIR ${rel} does not exist; build it with scripts/build-instance-pack.ts`);
  const incomplete = incompletePackReason(abs);
  if (incomplete) throw new Error(`LW_PACK_DIR ${rel}: ${incomplete}`);
  return rel.split(sep).join('/');
})();

console.log('▶ clean', OUT);
rmSync(OUT, { recursive: true, force: true });
mkdirSync(FUNC, { recursive: true });

// 1. The function handler — inlines api/ + server/src (+ pg, which is only dynamically
//    imported when a DB is configured; harmless in the in-memory demo). The banner pins
//    the data-dir base to the function directory (see bootstrap.ts / app.ts FN_ROOT).
console.log('▶ bundle function → index.mjs');
await build({
  ...common,
  // Entry is api/_index.ts (underscore-prefixed so Vercel's zero-config @vercel/node
  // does NOT also try to build it as a function — that ran in parallel and collided
  // with this Build Output API output at the same path).
  entryPoints: [join(ROOT, 'api/_index.ts')],
  outfile: join(FUNC, 'index.mjs'),
  banner: { js: `${REQUIRE_SHIM}\nglobalThis.__LW_FN_ROOT = import.meta.url;` },
  external: [...NATIVE, ...RUNTIME_DYNAMIC],
});

// 2. Each runtime-dynamic dep → its own self-contained bundle in the func node_modules.
async function bundleDep(name, pkg, sourceDir) {
  const dir = join(NM, name);
  mkdirSync(dir, { recursive: true });
  console.log(`▶ bundle dep → node_modules/${name}`);
  const exports = {};
  // Non-literal engine imports include public subpaths, including top-level
  // brand-policy and production imports. Ship the pinned package's full map.
  for (const [subpath, source] of Object.entries(pkg.exports)) {
    if (typeof source !== 'string' || !subpath.startsWith('.') || !source.startsWith('./')) throw new Error(`Unsupported export ${name}:${subpath}`);
    const output = subpath === '.' ? 'index.mjs' : `${subpath.slice(2)}.mjs`;
    await build({
      ...common,
      stdin: { contents: `export * from ${JSON.stringify(join(sourceDir, source))};`, resolveDir: ROOT, sourcefile: `${name}${subpath}-entry.mjs` },
      outfile: join(dir, output), banner: { js: REQUIRE_SHIM }, external: NATIVE,
    });
    exports[subpath] = `./${output}`;
  }
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: pkg.version, license: pkg.license, type: 'module', main: 'index.mjs', exports }, null, 2));
}
// The engine is consumed as its whole namespace via `await import('@lolly/engine')` and
// bundles cleanly (pure TS/JS + the require shim covers its CJS deps).
const engineDir = join(ROOT, 'vendor/@lolly/engine');
await bundleDep('@lolly/engine', JSON.parse(readFileSync(join(engineDir, 'package.json'), 'utf8')), engineDir);

// jsdom does NOT survive bundling — it dynamic-requires sibling files (xhr-sync-worker.js)
// and spawns a worker by path. Ship the real package + its runtime dependency closure
// instead, resolved from the installed node_modules (Linux on Vercel via buildCommand).
function copyPkgClosure(rootName) {
  const seen = new Set();
  const queue = [rootName];
  while (queue.length) {
    const name = queue.shift();
    if (seen.has(name)) continue;
    seen.add(name);
    const src = join(ROOT, 'node_modules', name);
    if (!existsSync(src)) continue; // optional/native dep not installed — skip
    const dest = join(NM, name);
    rmSync(dest, { recursive: true, force: true }); // idempotent — never collide on re-copy
    cpSync(src, dest, {
      recursive: true, force: true, dereference: true,
      // Flat layout: skip each package's own nested node_modules. npm hoists deps to
      // the top level, so the BFS below copies every dependency there; keeping nested
      // trees would only duplicate them (and collide, e.g. xmlchars via jsdom+saxes).
      filter: (s) => !s.slice(src.length + 1).split(/[/\\]/).includes('node_modules'),
    });
    // Lambda disables require(ESM). jsdom's CJS files require these ESM-only
    // packages, so compile their copied JS to CJS while retaining file paths
    // and package metadata. Keep jsdom itself intact for its worker/data files.
    if (['@exodus/bytes', 'parse5', 'entities'].includes(name)) {
      const compile = dir => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          const path = join(dir, entry.name);
          if (entry.isDirectory()) compile(path);
          else if (entry.name.endsWith('.js')) writeFileSync(path, transformSync(readFileSync(path, 'utf8'), {
            loader: 'js', format: 'cjs', target: 'node24', legalComments: 'inline',
          }).code);
        }
      };
      compile(dest);
      const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
      writeFileSync(join(dest, 'package.json'), JSON.stringify({ ...pkg, type: 'commonjs' }, null, 2));
    }
    // These two jsdom dependencies expose a single ESM-only entry and import
    // further ESM-only CSS helpers. Bundle that closure into a CJS entry instead
    // of rewriting its .mjs imports; preserve licenses and the package's files.
    if (['@asamuzakjp/css-color', '@asamuzakjp/dom-selector'].includes(name)) {
      const pkg = JSON.parse(readFileSync(join(dest, 'package.json'), 'utf8'));
      const entry = pkg.exports?.['.']?.default;
      if (typeof entry !== 'string' || !entry.startsWith('./')) throw new Error(`Unsupported jsdom dependency entry ${name}`);
      buildSync({
        entryPoints: [join(src, entry)], outfile: join(dest, 'lolly-require.cjs'),
        bundle: true, platform: 'node', format: 'cjs', target: 'node24',
        // css-tree already has a CJS entry and reads data by its own file path.
        legalComments: 'inline', logLevel: 'warning', external: [...NATIVE, 'css-tree'],
      });
      pkg.exports['.'].default = './lolly-require.cjs';
      pkg.main = './lolly-require.cjs';
      writeFileSync(join(dest, 'package.json'), JSON.stringify(pkg, null, 2));
    }
    try {
      const pj = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8'));
      for (const dep of Object.keys(pj.dependencies ?? {})) queue.push(dep);
    } catch { /* ignore unreadable package.json */ }
  }
}
console.log('▶ copy jsdom + dependency closure');
copyPkgClosure('jsdom');

// 3. The native @resvg/resvg-js (main package + its platform subpackage) — copied as-is
//    from THIS platform's node_modules. Correct only when this script runs on the deploy
//    platform (Vercel Linux); that is why it is the buildCommand, not a prebuilt upload.
console.log('▶ copy native @resvg/resvg-js');
cpSync(join(ROOT, 'node_modules', '@resvg'), join(NM, '@resvg'), { recursive: true, dereference: true });

// 3b. sharp (asset-resolver's raster optimiser) is native too: its JS loader picks a
//     platform package at runtime (`@img/sharp-linux-x64` + the matching libvips), which
//     esbuild cannot inline. Ship sharp with its dependency closure, plus every @img
//     package pnpm installed for THIS platform - on Vercel Linux that is the x64 pair.
//     Bundling sharp instead left the loader with no @img package beside it, and the
//     first request to any route died on the module-level import (2026-09-05).
console.log('▶ copy native sharp + @img platform packages');
copyPkgClosure('sharp');
if (existsSync(join(ROOT, 'node_modules', '@img'))) {
  cpSync(join(ROOT, 'node_modules', '@img'), join(NM, '@img'), { recursive: true, dereference: true });
}

// 4. Data dirs the handler reads at runtime, as siblings of index.mjs (FN_ROOT base).
for (const d of ['migrations', 'console', 'docs', join('packs', 'demo')]) {
  console.log('▶ copy data', d);
  cpSync(join(ROOT, d), join(FUNC, d), { recursive: true });
}

// The demo pack's catalog is a brand-profile SYMLINK (packs/demo/catalog ->
// brands/suse/catalog). Never trust a copy to carry it: cpSync's dereference
// rewrote the relative link into an ABSOLUTE one pointing at the build
// sandbox - alive at build time, dead at runtime, and every /catalog, brand
// and render surface 404'd. Materialize instead: drop whatever the copy
// produced and copy the ACTIVE profile's catalog in as real files, always.
// A read-only deploy cannot switch profiles anyway; the marker keeps the
// profile listing honest.
function materializeBrandCatalog(packOut) {
  if (!existsSync(join(packOut, 'brands'))) return;
  rmSync(join(packOut, 'catalog'), { recursive: true, force: true });
  let active;
  try {
    active = readFileSync(join(packOut, '.lolly-profile'), 'utf8').trim();
  } catch {
    active = readdirSync(join(packOut, 'brands'))[0];
  }
  console.log('▶ materialize brand-profile catalog:', active);
  cpSync(join(packOut, 'brands', active, 'catalog'), join(packOut, 'catalog'), { recursive: true });
}
materializeBrandCatalog(join(FUNC, 'packs', 'demo'));

// engine-pin.json beside index.mjs: the instance manifest and the fleet drift
// line read the vendored engine version from it (app.ts pinnedEngineVersion),
// and without it /api/v1/instance reported engineVersion null.
cpSync(join(ROOT, 'engine-pin.json'), join(FUNC, 'engine-pin.json'));

// 4b. An instance pack (LW_PACK_DIR), copied as real files. `filter` forces Node's
//     JS copy path, which honours `dereference` (the native recursive path has not
//     always, which is how the demo once shipped absolute links into the build
//     sandbox). Any link that survives fails the build rather than the runtime.
if (PACK_REL && PACK_REL !== 'packs/demo') {
  const packOut = join(FUNC, ...PACK_REL.split('/'));
  console.log('▶ copy instance pack', PACK_REL);
  rmSync(packOut, { recursive: true, force: true });
  cpSync(join(ROOT, PACK_REL), packOut, { recursive: true, dereference: true, filter: () => true });
  materializeBrandCatalog(packOut);
  const links = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (lstatSync(path).isSymbolicLink()) links.push(relative(packOut, path));
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(packOut);
  if (links.length) throw new Error(`instance pack ${PACK_REL} still holds symbolic links after copying: ${links.slice(0, 5).join(', ')}`);
  for (const dir of ['tools', 'catalog']) {
    if (!existsSync(join(packOut, dir))) throw new Error(`instance pack ${PACK_REL} has no ${dir}/ directory; build it with scripts/build-instance-pack.ts`);
  }
}

// 5. Function + platform config (Build Output API v3).
// A private instance streams its responses so a pack file over Vercel's 4.5 MB
// buffered limit can still be served; the demo's config is unchanged
// (scripts/vercel-routes.ts vcFunctionConfig).
writeFileSync(join(FUNC, '.vc-config.json'), JSON.stringify(
  vcFunctionConfig({ shellOrigin: SHELL_ORIGIN, pack: PACK_REL, regions: REGIONS }), null, 2));

writeFileSync(join(OUT, 'config.json'), JSON.stringify({
  version: 3,
  // Demo: everything funnels to the one catch-all function; the request.path transform
  // restores the caller's original path into req.url. Shell mode (LW_SHELL_ORIGIN): the
  // router's own prefixes go to the function and the rest is proxied to the Lolly app.
  routes: vercelRoutes(SHELL_ORIGIN ? { shellOrigin: SHELL_ORIGIN, prefixes: functionPrefixes(join(ROOT, 'server', 'src')) } : {}),
}, null, 2));
if (SHELL_ORIGIN) console.log('▶ routes: shell mode, app proxied from', SHELL_ORIGIN);

console.log('✓ Build Output API written to', OUT);
