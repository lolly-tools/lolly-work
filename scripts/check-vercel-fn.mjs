// SPDX-License-Identifier: MPL-2.0
/** Exercise the packaged function, not workspace imports, before deployment.
 *  Build on the test platform first; native packages are platform-specific.
 *  Run via check:vercel so require(ESM) is disabled as in the hosted runtime. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, lstatSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { FUNCTION_PREFIX_BASELINE, functionPrefixes, parseRegions, parseShellOrigin, resolveRoute, vcFunctionConfig, vercelRoutes } from './vercel-routes.ts';
import { checkConsoleAssets, consoleAssetPlan } from './console-assets.ts';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
assert.equal(process.features.require_module, false, 'Run pnpm run check:vercel to exercise the hosted require(ESM) restriction');
const func = join(root, '.vercel/output/functions/api/index.func');
const original = JSON.parse(readFileSync(join(root, 'vendor/@lolly/engine/package.json'), 'utf8'));
const shipped = JSON.parse(readFileSync(join(func, 'node_modules/@lolly/engine/package.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(join(func, '.vc-config.json'), 'utf8'));
assert.equal(runtime.runtime, 'nodejs24.x');

// Route table. The build mode is read from the same variables the build used,
// before the fixture below clears every LW_* variable.
const shellOrigin = process.env.LW_SHELL_ORIGIN?.trim() ? parseShellOrigin(process.env.LW_SHELL_ORIGIN.trim()) : undefined;
const regions = process.env.LW_FUNCTION_REGION?.trim() ? parseRegions(process.env.LW_FUNCTION_REGION.trim()) : undefined;
const packRel = process.env.LW_PACK_DIR?.trim();
const routes = JSON.parse(readFileSync(join(root, '.vercel/output/config.json'), 'utf8')).routes;
const prefixes = functionPrefixes(join(root, 'server/src'));
for (const prefix of FUNCTION_PREFIX_BASELINE) assert.ok(prefixes.includes(prefix), `router scan lost the ${prefix} prefix`);
// Both modes, from the generator, whichever one this build used.
assert.deepEqual(vercelRoutes(), [{ src: '^/(.*)$', dest: '/api/index', transforms: [{ type: 'request.path', op: 'set', args: '/$1' }] }]);
const assertShellMode = (table, origin) => {
  // Vercel keeps matching later routes after a rewrite to the function, so the
  // function row must be the last route and the only one (scripts/vercel-routes.ts).
  assert.equal(table.length, 3, 'shell mode: bt functions, shell catch-all that skips function paths, function');
  assert.match(table[0].dest, /^https:\/\//, 'shell mode: bt functions are proxied first');
  assert.match(table[1].dest, /^https:\/\//, 'shell mode: the shell catch-all is proxied before the function row');
  assert.deepEqual(table.flatMap((r, i) => (r.dest === '/api/index' ? [i] : [])), [2], 'the function row is the only one and the last');
  assert.equal(table[2].src, '^/(.*)$');
  for (const prefix of prefixes.filter(p => p !== 'tools')) {
    for (const path of [`/${prefix}`, `/${prefix}/x/y`]) assert.equal(resolveRoute(table, path)?.to, 'function', `${path} must reach the function`);
  }
  assert.deepEqual(resolveRoute(table, '/tools/qr-code/tool.json'), { to: 'function', path: '/tools/qr-code/tool.json' });
  assert.deepEqual(resolveRoute(table, '/catalog/tools/index.sig.json'), { to: 'function', path: '/catalog/tools/index.sig.json' });
  for (const path of ['/', '/tools', '/t/qr-code', '/info/index.html', '/sw.js', '/api/ca/sign', '/api/penpot/x', '/api/mcp', '/api/fetch-image']) {
    assert.deepEqual(resolveRoute(table, path), { to: 'proxy', url: `${origin}${path}` }, `${path} must go to the shell origin`);
  }
  // The instance's session cookie never leaves for the shell origin.
  for (const route of table.filter(r => /^https:/.test(r.dest))) {
    assert.ok((route.transforms ?? []).some(t => t.type === 'request.headers' && t.op === 'delete' && t.target?.key === 'cookie'),
      `${route.src} must delete the Cookie header before proxying`);
  }
};
assertShellMode(vercelRoutes({ shellOrigin: 'https://shell.fixture.test', prefixes }), 'https://shell.fixture.test');
if (shellOrigin) assertShellMode(routes, shellOrigin);
else assert.deepEqual(routes, vercelRoutes(), 'without LW_SHELL_ORIGIN the build keeps the demo catch-all');
assert.deepEqual(runtime.regions, regions, 'function regions follow LW_FUNCTION_REGION');
assert.deepEqual(runtime, vcFunctionConfig({ shellOrigin, pack: packRel, regions }), 'function config follows the build variables');
// Vercel answers 413 for a buffered function response over 4.5 MB; only a
// streaming function may serve a bundled file larger than that.
const BUFFERED_LIMIT = 4.5 * 1000 * 1000;
const oversized = [];
const walkPack = (dir, onFile) => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    assert.ok(!lstatSync(path).isSymbolicLink(), `bundled pack holds a symbolic link: ${path}`);
    if (entry.isDirectory()) walkPack(path, onFile);
    else onFile(path);
  }
};
for (const rel of new Set(['packs/demo', ...(packRel ? [packRel] : [])])) {
  const pack = join(func, rel);
  assert.ok(existsSync(join(pack, 'tools')) && existsSync(join(pack, 'catalog')), `bundled pack ${rel} has tools/ and catalog/`);
  for (const dir of ['tools', 'catalog']) {
    walkPack(join(pack, dir), path => { if (statSync(path).size > BUFFERED_LIMIT) oversized.push(relative(func, path)); });
  }
}
if (oversized.length) {
  assert.equal(runtime.supportsResponseStreaming, true,
    `these bundled files are over Vercel's 4.5 MB buffered response limit, so the function must stream: ${oversized.slice(0, 5).join(', ')}`);
}
assert.equal(shipped.version, original.version);
assert.equal(shipped.license, original.license);
assert.deepEqual(Object.keys(shipped.exports).sort(), Object.keys(original.exports).sort());
const require = createRequire(join(func, 'index.mjs'));
for (const subpath of Object.keys(original.exports)) {
  const name = '@lolly/engine' + (subpath === '.' ? '' : subpath.slice(1));
  await import(pathToFileURL(require.resolve(name)).href);
}
// Exercise the converted jsdom dependency paths, including encoding/entities,
// the selector engine and CSS colour computation, without workspace resolution.
const { JSDOM } = require('jsdom');
const dom = new JSDOM(Buffer.from('<meta charset=utf-8><style>.swatch { color: rgb(12 34 56) }</style><main><span class=swatch>Café &amp; tea</span></main>'));
try {
  const swatch = dom.window.document.querySelector('main > .swatch:is(span)');
  assert.ok(swatch);
  assert.equal(swatch.textContent, 'Café & tea');
  assert.equal(dom.window.getComputedStyle(swatch).color, 'rgb(12, 34, 56)');
} finally { dom.window.close(); }

// This command owns an isolated process. Never inherit a database or instance
// credential from the operator's environment into the fixture bootstrap.
for (const name of Object.keys(process.env)) if (name.startsWith('LW_') || name === 'DATABASE_URL') delete process.env[name];
process.env.LW_CONFIG_JSON = JSON.stringify({
  deployment: { mode: 'evaluation' }, instance: { baseUrl: 'http://localhost', pack: 'packs/demo' },
  dev: { enabled: true, users: [{ email: 'owner@fixture.test', groups: ['owner'] }] },
  policy: { defaultAccessMode: 'open' }, render: { allowHooksInFastPath: true }, rateLimit: { enabled: false },
});
process.env.LW_SESSION_SECRET = 'fixture-session-key'.repeat(3);
process.env.LW_LINK_SECRET = 'fixture-link-key'.repeat(3);
process.env.LW_CREDENTIAL_SECRET = 'fixture-credential-key'.repeat(3);
const { default: handler } = await import(pathToFileURL(join(func, 'index.mjs')).href);
const server = createServer((req, res) => {
  void handler(req, res).catch(error => {
    console.error(error);
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const request = (path, options = {}) => fetch(base + path, { ...options, signal: AbortSignal.timeout(30000) });
try {
  assert.equal((await request('/healthz')).status, 200, 'packaged function boots with its copied brand/catalog data');
  // engine-pin.json is bundled, so the manifest names the engine this build serves.
  const manifest = await request('/api/v1/instance'); assert.equal(manifest.status, 200);
  assert.equal((await manifest.json()).engineVersion, JSON.parse(readFileSync(join(root, 'engine-pin.json'), 'utf8')).engine.version);
  const consoleDir = join(func, 'console');
  checkConsoleAssets(consoleDir);
  const assets = consoleAssetPlan(consoleDir);
  const shell = await request('/admin'); assert.equal(shell.status, 200); assert.equal(await shell.text(), assets.html);
  for (const name of assets.files.filter(name => /\.(?:js|css)$/.test(name))) {
    const module = await request(`/admin/${name}`); assert.equal(module.status, 200);
    assert.equal(module.headers.get('cache-control'), 'no-cache');
    assert.equal(await module.text(), readFileSync(join(root, 'console', name), 'utf8'));
  }
  for (const path of [`/admin/app.js?v=${assets.revision}`, `/admin/styles.css?v=${assets.revision}`]) {
    const selected = await request(path); assert.equal(selected.status, 200);
    assert.equal(await selected.text(), readFileSync(join(consoleDir, new URL(path, 'https://console.invalid').pathname.slice('/admin/'.length)), 'utf8'));
  }
  const login = await request('/api/auth/dev?email=owner%40fixture.test', { redirect: 'manual' });
  assert.equal(login.status, 302);
  const cookie = login.headers.getSetCookie().find(value => value.startsWith('lw_session='))?.split(';')[0];
  assert.ok(cookie);
  const setup = await request('/api/v1/catalog/providers/setup', { headers: { cookie } });
  assert.equal(setup.status, 200);
  assert.deepEqual((await setup.json()).providers.map(provider => provider.kind), ['webdav', 'gdrive']);
  const config = await request('/api/v1/org-config', { headers: { cookie } });
  assert.equal(config.status, 200); assert.ok((await config.json()).render.formats.includes('svg'));
  const render = await request('/render/qr-code.svg?url=https%3A%2F%2Ffixture.test', { headers: { cookie } });
  assert.equal(render.status, 200, await render.clone().text());
  assert.match(render.headers.get('content-type'), /image\/svg\+xml/); assert.match(await render.text(), /<svg[\s>]/);
  console.log('✓ Packaged Vercel function: restricted require(ESM), all engine exports, jsdom parsing/styles, boot, console modules, owner session, provider setup, org-config and SVG rendering');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
