/**
 * The Lolly web shell this server serves carries the open-source app's security headers
 * (plans/58 WP0, server/src/api/shell-headers.ts). Pinned two ways: the header map equals
 * the YunoHost package's shell-headers.inc (itself pinned to the Lolly repository's copy
 * by tests/yunohost-package.test.ts), and a real GET of the shell and of one of its
 * assets returns every header.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { SHELL_SECURITY_HEADERS, shellSecurityHeaders } from '../server/src/api/shell-headers.ts';

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


test('only the isolated any-site route carries the approved iframe policy', () => {
  for (const path of ['/', 'design', '/any-site-other', 'nested/any-site', '/assets/app.js']) assert.equal(shellSecurityHeaders(path), SHELL_SECURITY_HEADERS);
  for (const path of ['any-site', '/any-site/', 'any-site/path']) {
    const headers = shellSecurityHeaders(path), csp = headers['content-security-policy']!;
    assert.match(csp, /frame-src 'self' blob: https: http:\/\/localhost:\* http:\/\/127\.0\.0\.1:\*/);
    for (const [key, value] of Object.entries(SHELL_SECURITY_HEADERS)) if (key !== 'content-security-policy') assert.equal(headers[key], value);
    assert.match(csp, /frame-ancestors 'self'/); assert.match(csp, /object-src 'none'/);
  }
});

test('GET of the shell and of a shell asset returns every header', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const shellDir = await mkdtemp(join(tmpdir(), 'lw-shell-'));
  await writeFile(join(shellDir, 'index.html'), '<!doctype html><title>shell</title>');
  await mkdir(join(shellDir, 'assets'));
  await writeFile(join(shellDir, 'assets', 'app.js'), 'console.log(1)');
  await mkdir(join(shellDir, 'review'));
  const recording = Buffer.from('review recording fixture');
  await writeFile(join(shellDir, 'review', 'agent-collaboration-review.mp4'), recording);
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
  const legacyRecording = await fetch(base + '/info/media/agent-collaboration-review.mp4', { redirect: 'manual' });
  assert.equal(legacyRecording.status, 307);
  assert.equal(legacyRecording.headers.get('location'), '/review/agent-collaboration-review.mp4');
  const servedRecording = await fetch(base + '/info/media/agent-collaboration-review.mp4');
  assert.equal(servedRecording.status, 200);
  assert.deepEqual(Buffer.from(await servedRecording.arrayBuffer()), recording);
  const isolated = await fetch(base + '/any-site/?url=https%3A%2F%2Fexample.com');
  assert.equal(isolated.status, 200);
  assert.equal(isolated.headers.get('content-security-policy'), shellSecurityHeaders('any-site/')['content-security-policy']);
  await isolated.arrayBuffer();
});


test('console documents protect their origin and allow only their own inline boot scripts', async () => {
  const config = parseConfig(JSON.stringify({ instance: { name: 'Console headers', baseUrl: 'http://localhost', pack: 'packs/demo' }, rateLimit: { enabled: false }, dev: { enabled: true, users: [] } }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's3', link: 'l3' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const document = await fetch(base + '/admin');
  assert.equal(document.status, 200);
  const html = await document.text();
  const policy = document.headers.get('content-security-policy')!;
  assert.ok(policy);
  assert.match(policy, /frame-ancestors 'none'/);
  assert.match(policy, /default-src 'none'/);
  assert.match(policy, /connect-src 'self'/);
  assert.match(policy, /base-uri 'none'/);
  const scriptPolicy = policy.split('; ').find((value) => value.startsWith('script-src '))!;
  assert.doesNotMatch(scriptPolicy, /unsafe-inline|unsafe-eval|https:/);
  const inline = [...html.matchAll(/<script>([^]*?)<\/script>/g)];
  assert.equal(inline.length, 2, 'both pre-paint preference scripts remain');
  for (const [, script] of inline) {
    const hash = createHash('sha256').update(script!).digest('base64');
    assert.ok(scriptPolicy.includes(`'sha256-${hash}'`), 'the returned HTML and allowed script bytes agree');
  }
  for (const path of ['/admin', '/admin/index.html', '/admin/app.js', '/admin/styles.css', '/admin/theme.css']) {
    const response = await fetch(base + path);
    assert.equal(response.status, 200, path);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff', path);
    assert.equal(response.headers.get('x-frame-options'), 'DENY', path);
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer', path);
    await response.arrayBuffer();
  }
});
