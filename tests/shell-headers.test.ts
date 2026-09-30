/**
 * The Lolly web shell this server serves carries the open-source app's security headers
 * (plans/58 WP0, server/src/api/shell-headers.ts). Pinned two ways: the header map equals
 * the YunoHost package's shell-headers.inc (itself pinned to the Lolly repository's copy
 * by tests/yunohost-package.test.ts), and a real GET of the shell and of one of its
 * assets returns every header.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { SHELL_SECURITY_HEADERS } from '../server/src/api/shell-headers.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

test('the header map is the YunoHost package\'s shell header set, name for name and value for value', () => {
  const inc = readFileSync(new URL('../deploy/yunohost/conf/shell-headers.inc', import.meta.url), 'utf8');
  const fromInc = Object.fromEntries([...inc.matchAll(/^more_set_headers "([^:]+): (.*)";$/gm)].map((m) => [m[1]!.toLowerCase(), m[2]!]));
  assert.deepEqual({ ...SHELL_SECURITY_HEADERS }, fromInc);
});

test('the base keeps the properties the open-source policy is built on', () => {
  const csp = SHELL_SECURITY_HEADERS['content-security-policy']!;
  const directive = (name: string) => csp.split(';').map((d) => d.trim()).find((d) => d.startsWith(name + ' ')) ?? '';
  for (const name of ['frame-src', 'child-src', 'worker-src']) {
    assert.ok(directive(name), `${name} present`);
    assert.doesNotMatch(directive(name), /(^|\s)(https:|\*)(\s|$)/, `${name} never opens to a scheme or a wildcard`);
  }
  assert.match(directive('frame-ancestors'), /'self'/);
  assert.equal(SHELL_SECURITY_HEADERS['referrer-policy'], 'no-referrer');
  assert.equal(SHELL_SECURITY_HEADERS['cross-origin-embedder-policy'], 'credentialless');
});

test('GET of the shell and of a shell asset returns every header', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const shellDir = await mkdtemp(join(tmpdir(), 'lw-shell-'));
  await writeFile(join(shellDir, 'index.html'), '<!doctype html><title>shell</title>');
  await mkdir(join(shellDir, 'assets'));
  await writeFile(join(shellDir, 'assets', 'app.js'), 'console.log(1)');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Headers', baseUrl: 'http://localhost', pack, shellDir },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'member@test', name: 'Mo Member', groups: ['staff'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's3', link: 'l3' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const path of ['/', '/tool/sandbox', '/assets/app.js']) {
    const res = await fetch(base + path);
    assert.equal(res.status, 200, path);
    for (const [name, value] of Object.entries(SHELL_SECURITY_HEADERS)) assert.equal(res.headers.get(name), value, `${path} ${name}`);
    await res.arrayBuffer();
  }
});
