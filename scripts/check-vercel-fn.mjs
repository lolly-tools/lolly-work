// SPDX-License-Identifier: MPL-2.0
/** Exercise the packaged function, not workspace imports, before deployment.
 *  Build on the test platform first; native packages are platform-specific. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const func = join(root, '.vercel/output/functions/api/index.func');
const original = JSON.parse(readFileSync(join(root, 'vendor/@lolly/engine/package.json'), 'utf8'));
const shipped = JSON.parse(readFileSync(join(func, 'node_modules/@lolly/engine/package.json'), 'utf8'));
const runtime = JSON.parse(readFileSync(join(func, '.vc-config.json'), 'utf8'));
assert.equal(runtime.runtime, 'nodejs24.x');
assert.equal(shipped.version, original.version);
assert.equal(shipped.license, original.license);
assert.deepEqual(Object.keys(shipped.exports).sort(), Object.keys(original.exports).sort());
const require = createRequire(join(func, 'index.mjs'));
for (const subpath of Object.keys(original.exports)) {
  const name = '@lolly/engine' + (subpath === '.' ? '' : subpath.slice(1));
  await import(pathToFileURL(require.resolve(name)).href);
}

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
  const shell = await request('/admin'); assert.equal(shell.status, 200); assert.match(await shell.text(), /app\.js/);
  for (const name of ['app.js', 'provider-setup.js', 'provider-oauth-setup.js']) {
    const module = await request(`/admin/${name}`); assert.equal(module.status, 200);
    assert.equal(await module.text(), readFileSync(join(root, 'console', name), 'utf8'));
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
  console.log('✓ Packaged Vercel function: all engine exports, boot, console modules, owner session, provider setup, org-config and SVG rendering');
} finally {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
