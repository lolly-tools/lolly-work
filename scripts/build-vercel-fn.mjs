// SPDX-License-Identifier: MPL-2.0
/**
 * Build the lolly-work Vercel function via the Build Output API (.vercel/output).
 *
 * WHY this exists: the repo runs `.ts` directly under Node's native type-stripping
 * (every internal import carries a `.ts` extension). Vercel's zero-config @vercel/node
 * transpiles each `.ts` file to `.js` but leaves the `.ts` import specifiers, so the
 * deployed function can't resolve them (ERR_MODULE_NOT_FOUND), and Node refuses to
 * type-strip the vendored engine under node_modules. The fix is to esbuild-bundle the
 * whole graph (function + vendored engine + jsdom + pg) into plain JS, leaving only the
 * native @resvg/resvg-js external, and ship it as an explicit Build Output API function.
 *
 * MUST run on the deploy platform (Linux on Vercel), NOT be prebuilt on a Mac: it copies
 * the platform-specific @resvg/resvg-js binary from node_modules, which is not portable.
 * Vercel invokes it as the project's buildCommand (vercel.json).
 */
import { build } from 'esbuild';
import { mkdirSync, rmSync, cpSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const OUT = join(ROOT, '.vercel', 'output');
const FUNC = join(OUT, 'functions', 'api', 'index.func');
const NM = join(FUNC, 'node_modules');

// Native modules esbuild must not try to bundle — resvg is the real one (a .node
// binary); the rest are optional natives of pg/jsdom that they load only if present.
const NATIVE = ['@resvg/resvg-js', 'canvas', 'bufferutil', 'utf-8-validate', 'pg-native'];
// Loaded at runtime via a non-literal `import(specifier)` (contract.ts), so esbuild
// can't inline them — provide each as a self-contained bundle in the func node_modules.
const RUNTIME_DYNAMIC = ['@lolly/engine', 'jsdom'];

// ESM output that bundles CJS deps (handlebars, ajv, parts of jsdom) needs a real
// `require` — esbuild otherwise emits a stub that throws "Dynamic require of X is not
// supported" the moment that CJS code calls require() (e.g. require('path')). Define one
// from the module's own URL in every bundle's banner.
const REQUIRE_SHIM = "import { createRequire as __lwCreateRequire } from 'node:module'; const require = __lwCreateRequire(import.meta.url);";
const common = { bundle: true, platform: 'node', format: 'esm', target: 'node22', logLevel: 'warning' };

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
async function bundleDep(name, stdinContents) {
  const dir = join(NM, name);
  mkdirSync(dir, { recursive: true });
  console.log(`▶ bundle dep → node_modules/${name}`);
  await build({
    ...common,
    stdin: { contents: stdinContents, resolveDir: ROOT, sourcefile: `${name}-entry.mjs` },
    outfile: join(dir, 'index.mjs'),
    banner: { js: REQUIRE_SHIM },
    external: NATIVE,
  });
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ name, version: '0.0.0', type: 'module', main: 'index.mjs' }, null, 2));
}
// The engine is consumed as its whole namespace via `await import('@lolly/engine')` and
// bundles cleanly (pure TS/JS + the require shim covers its CJS deps).
await bundleDep('@lolly/engine', `export * from ${JSON.stringify(join(ROOT, 'vendor/@lolly/engine/src/index.ts'))};`);

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

// 4. Data dirs the handler reads at runtime, as siblings of index.mjs (FN_ROOT base).
for (const d of ['migrations', 'console', 'docs', join('packs', 'demo')]) {
  console.log('▶ copy data', d);
  cpSync(join(ROOT, d), join(FUNC, d), { recursive: true });
}

// 5. Function + platform config (Build Output API v3).
writeFileSync(join(FUNC, '.vc-config.json'), JSON.stringify({
  runtime: 'nodejs22.x',
  handler: 'index.mjs',
  launcherType: 'Nodejs',
  shouldAddHelpers: false,
  supportsResponseStreaming: false,
}, null, 2));

writeFileSync(join(OUT, 'config.json'), JSON.stringify({
  version: 3,
  // Everything funnels to the one catch-all function; the request.path transform restores
  // the caller's original path into req.url (mirrors the repo's vercel.json approach).
  routes: [
    { src: '^/(.*)$', dest: '/api/index', transforms: [{ type: 'request.path', op: 'set', args: '/$1' }] },
  ],
}, null, 2));

console.log('✓ Build Output API written to', OUT);
