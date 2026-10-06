// SPDX-License-Identifier: MPL-2.0
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { SHELL_SECURITY_HEADERS } from '../server/src/api/shell-headers.ts';
import { shellDocsPath } from '../server/src/api/shell-docs.ts';

let server: Server;
let base = '';
let root = '';
let shell = '';
const html = (title: string, path: string) => `<!doctype html><title>${title}</title><link rel="canonical" href="https://lolly.tools/info/${path}"><h1>${title}</h1>`;
const documents = new Map([
  ['info/index.html', html('Documentation', 'index.html')],
  ['info/operate/deployment.html', html('Deployment', 'operate/deployment.html')],
  ['info/deployment.html', html('Deployment alias', 'deployment.html')],
  ['info/de/operate/deployment.html', html('Bereitstellung', 'de/operate/deployment.html')],
  ['info/de/deployment.html', html('Bereitstellung alias', 'de/deployment.html')],
  ['info/format/convert/index.html', html('Convert', 'format/convert/index.html')],
  ['info/search-index.json', JSON.stringify({ title: 'public search' })],
  ['info/sitemap.xml', '<?xml version="1.0"?><urlset><url><loc>https://lolly.tools/info/operate/deployment.html</loc></url></urlset>'],
  ['robots-lolly-tools.txt', 'User-agent: *\nAllow: /\n\nSitemap: https://lolly.tools/info/sitemap.xml\n'],
]);

before(async () => {
  root = await mkdtemp(join(tmpdir(), 'lw-shell-docs-'));
  const pack = join(root, 'pack');
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  await mkdir(join(pack, 'catalog', 'fonts', 'ttf'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'fonts', 'ttf', 'Private.ttf'), 'private font');
  shell = join(root, 'shell');
  for (const [path, bytes] of documents) {
    const target = join(shell, path);
    await mkdir(join(target, '..'), { recursive: true });
    await writeFile(target, bytes);
  }
  await writeFile(join(shell, 'index.html'), '<!doctype html><title>App shell</title><div id="app-root"></div>');
  await mkdir(join(shell, 'assets'));
  await writeFile(join(shell, 'assets', 'app.js'), 'console.log("app")');
  // Signed-shell copies of reserved files must never override private routes.
  for (const path of ['catalog/assets/index.json', 'api/v1/projects', 'render/private.png', 'tools/private/tool.json']) {
    await mkdir(join(shell, path, '..'), { recursive: true });
    await writeFile(join(shell, path), 'private-looking shell decoy');
  }
  await writeFile(join(root, 'private.html'), 'outside the signed release');
  await symlink(join(root, 'private.html'), join(shell, 'info', 'outside.html'));
  await mkdir(join(shell, 'info', 'directory.html'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Public docs, private workspace', baseUrl: 'https://workspace.example.com', pack, shellDir: shell },
    idp: { issuer: 'https://idp.invalid', clientId: '', groupsClaim: 'groups', claimMap: { email: 'email' } },
    policy: { defaultAccessMode: 'gated' },
    rateLimit: { enabled: false },
    dev: { enabled: false, users: [] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'session', link: 'link' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  base = `http://127.0.0.1:${address.port}`;
});

after(async () => {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>(resolve => server.close(() => resolve()));
  }
  if (root) await rm(root, { recursive: true, force: true });
});

test('documentation classification leaves private and ordinary app paths untouched', () => {
  for (const path of ['', 'design', 'api/v1/docs', 'catalog/index.json', 'render/card.png', 'assets/app.js']) {
    assert.equal(shellDocsPath(path), null, path);
  }
  for (const path of ['info/../private.html', 'info/.env', 'info/a\\b.html', 'info/a\0.html', 'docs/a/b/c/d']) {
    assert.deepEqual(shellDocsPath(path), { kind: 'invalid' }, path);
  }
});

test('GET and HEAD serve the actual public docs home instead of the SPA', async () => {
  for (const path of ['/info', '/info/', '/info/index.html', '/docs', '/docs/']) {
    const get = await fetch(base + path);
    assert.equal(get.status, 200, path);
    assert.equal(await get.text(), documents.get('info/index.html'), path);
    assert.equal(get.headers.get('content-type'), 'text/html; charset=utf-8');
    for (const [key, value] of Object.entries(SHELL_SECURITY_HEADERS)) assert.equal(get.headers.get(key), value);
    const head = await fetch(base + path, { method: 'HEAD' });
    assert.equal(head.status, 200, path);
    assert.equal(head.headers.get('content-type'), get.headers.get('content-type'));
    assert.equal(head.headers.get('content-length'), get.headers.get('content-length'));
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
});

test('nested, flat and localized aliases retain the signed document bytes and canonical URLs', async () => {
  const aliases = new Map([
    ['/info/operate/deployment', 'info/operate/deployment.html'],
    ['/info/operate/deployment.html', 'info/operate/deployment.html'],
    ['/docs/operate/deployment', 'info/operate/deployment.html'],
    ['/docs/deployment', 'info/deployment.html'],
    ['/docs/de/operate/deployment', 'info/de/operate/deployment.html'],
    ['/docs/de/deployment', 'info/de/deployment.html'],
    ['/info/format/convert/', 'info/format/convert/index.html'],
  ]);
  for (const [path, target] of aliases) {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 200, `${method} ${path}`);
      assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(documents.get(target)!));
      if (method === 'GET') assert.equal(await res.text(), documents.get(target));
      else assert.equal((await res.arrayBuffer()).byteLength, 0);
    }
  }
});

test('robots and sitemap expose the signed public discovery contract with correct MIME types', async () => {
  for (const [path, target, mime] of [
    ['/robots.txt', 'robots-lolly-tools.txt', 'text/plain; charset=utf-8'],
    ['/info/sitemap.xml', 'info/sitemap.xml', 'application/xml; charset=utf-8'],
    ['/info/search-index.json', 'info/search-index.json', 'application/json; charset=utf-8'],
  ]) {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 200, `${method} ${path}`);
      assert.equal(res.headers.get('content-type'), mime);
      assert.equal(Number(res.headers.get('content-length')), Buffer.byteLength(documents.get(target!)!));
      if (method === 'GET') assert.equal(await res.text(), documents.get(target!));
      else assert.equal((await res.arrayBuffer()).byteLength, 0);
    }
  }
  for (const method of ['GET', 'HEAD']) {
    const redirect = await fetch(base + '/sitemap.xml', { method, redirect: 'manual' });
    assert.equal(redirect.status, 308);
    assert.equal(redirect.headers.get('location'), '/info/sitemap.xml');
  }
});

test('missing public docs and file-shaped directories give 404 instead of an app soft error', async () => {
  for (const path of ['/info/no-such-page', '/info/no-such-page.html', '/docs/no-such-page', '/info/directory.html']) {
    for (const method of ['GET', 'HEAD']) {
      const res = await fetch(base + path, { method });
      assert.equal(res.status, 404, `${method} ${path}`);
      if (method === 'GET') assert.doesNotMatch(await res.text(), /App shell/);
    }
  }
});

test('traversal, hidden files and escaping document symlinks cannot leave the signed shell', async () => {
  for (const path of ['/info/%2e%2e%2fprivate.html', '/docs/%2e%2e%2fprivate', '/info/a%5cb.html', '/info/a%00.html', '/info/.env']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + path, { method })).status, 400, `${method} ${path}`);
  }
  for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + '/info/outside.html', { method })).status, 404);
});

test('public docs do not publish governed APIs, private assets, tools or renders on GET or HEAD', async () => {
  for (const path of ['/api/v1/docs', '/api/v1/docs/cloud-deployment', '/api/v1/projects', '/catalog/assets/index.json', '/catalog/fonts/ttf/Private.ttf', '/tools/private/tool.json', '/render/private.png']) {
    const get = await fetch(base + path, { redirect: 'manual' });
    assert.equal(get.status, 401, path);
    const head = await fetch(base + path, { method: 'HEAD', redirect: 'manual' });
    assert.ok([401, 404].includes(head.status), `${path} HEAD remains governed or unmatched`);
    assert.equal((await head.arrayBuffer()).byteLength, 0);
  }
});

test('ordinary app GETs and assets keep their fallback, while HEAD does not call their GET handlers', async () => {
  const app = await fetch(base + '/design');
  assert.equal(app.status, 200);
  assert.match(await app.text(), /App shell/);
  const asset = await fetch(base + '/assets/app.js');
  assert.equal(asset.status, 200);
  assert.equal(await asset.text(), 'console.log("app")');
  for (const path of ['/', '/design', '/assets/app.js']) assert.equal((await fetch(base + path, { method: 'HEAD' })).status, 404, path);
});

test('discovery files absent from a shell mount are refused rather than invented', async () => {
  await rm(join(shell, 'info', 'sitemap.xml'));
  await rm(join(shell, 'robots-lolly-tools.txt'));
  for (const path of ['/robots.txt', '/sitemap.xml', '/info/sitemap.xml']) {
    for (const method of ['GET', 'HEAD']) assert.equal((await fetch(base + path, { method, redirect: 'manual' })).status, 404);
  }
});
