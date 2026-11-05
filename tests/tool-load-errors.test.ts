// SPDX-License-Identifier: MPL-2.0
/** A tool that does not load is refused in plain words: no error body names a server path. */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import { loadToolOrRefuse, toolLoadRefusal, ToolLoadRefusal, withoutServerPaths } from '../server/src/render/tool-load.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

const servers: Server[] = [];
let pack = '';

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-tool-load-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }, { id: 'unreadable' }] }));
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] }, inputs: [],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"></svg>');
  // A directory where the manifest should be: a filesystem error other than a missing file.
  await mkdir(join(pack, 'tools', 'unreadable', 'tool.json'), { recursive: true });
});
after(async () => {
  for (const server of servers) server.close();
  await rm(pack, { recursive: true, force: true });
});

async function boot() {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Tool load', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), metrics: createMetrics(), secrets: { session: 'sT', link: 'lT' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  return (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

/** Fails on anything that reads as a server path, the pack root above all. */
function assertNoServerPath(label: string, text: string): void {
  assert.equal(text.includes(pack), false, `${label} names the pack root: ${text}`);
  assert.doesNotMatch(text, /ENOENT|EISDIR|EACCES|no such file or directory/, `${label} reads as a filesystem error: ${text}`);
  assert.doesNotMatch(text, /(^|[\s'"`:=(])\/(?:[\w.@+-]+\/)+[\w.@+-]*tool\.json/, `${label} names a tool path: ${text}`);
}

test('every route that loads a tool answers a missing tool with a stable 404 and no path', async (t) => {
  const call = await boot();
  const missing = 'no-such-tool';
  const routes: Array<[string, string, unknown?]> = [
    [`/api/v1/schema/${missing}`, 'GET'],
    ['/api/v1/compile', 'POST', { toolId: missing }],
    ['/api/v1/validate', 'POST', { toolId: missing }],
    ['/api/v1/measure', 'POST', { toolId: missing }],
    ['/api/v1/package', 'POST', { toolId: missing }],
    ['/api/v1/render', 'POST', { toolId: missing, format: 'svg' }],
    [`/render/${missing}.svg`, 'GET'],
  ];
  for (const [path, method, body] of routes) {
    await t.test(`${method} ${path}`, async () => {
      const res = await call(path, method, body);
      const text = await res.text();
      assertNoServerPath(path, text);
      assert.equal(res.status, 404, text);
      assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'TOOL_NOT_FOUND', text);
    });
  }
});

test('a batch row against a missing tool keeps the same code', async () => {
  const call = await boot();
  const res = await call('/api/v1/batch', 'POST', { toolId: 'no-such-tool', format: 'svg', rows: [{}] });
  const text = await res.text();
  assertNoServerPath('batch', text);
  assert.equal(res.status, 404, text);
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'TOOL_NOT_FOUND');
});

test('a filesystem failure other than a missing file is one plain sentence', async () => {
  const call = await boot();
  for (const [path, method, body] of [
    ['/api/v1/schema/unreadable', 'GET', undefined],
    ['/api/v1/compile', 'POST', { toolId: 'unreadable' }],
    ['/api/v1/render', 'POST', { toolId: 'unreadable', format: 'svg' }],
  ] as Array<[string, string, unknown]>) {
    const res = await call(path, method, body);
    const text = await res.text();
    assertNoServerPath(path, text);
    assert.equal(res.status, 500, text);
    const error = (JSON.parse(text) as { error: { code: string; message: string } }).error;
    assert.equal(error.code, 'TOOL_UNAVAILABLE');
    assert.equal(error.message, 'This server could not read tool "unreadable".');
  }
});

test('an id that could not name a tool directory reads nothing outside the tools folder', async () => {
  const call = await boot();
  // pack/tools/../tools/card/tool.json exists, so a path walk would succeed.
  for (const toolId of ['../tools/card', 'card/../card', '/etc/passwd']) {
    const res = await call('/api/v1/compile', 'POST', { toolId });
    const text = await res.text();
    assertNoServerPath(toolId, text);
    assert.equal(res.status, 404, `${toolId}: ${text}`);
    assert.equal((JSON.parse(text) as { error: { message: string } }).error.message, 'No such tool.');
  }
});

test('a verb with no tool id says what it needs', async () => {
  const call = await boot();
  const res = await call('/api/v1/compile', 'POST', {});
  const text = await res.text();
  assertNoServerPath('compile', text);
  assert.equal(res.status, 400, text);
  assert.equal((JSON.parse(text) as { error: { code: string } }).error.code, 'INVALID_INPUT');
});

test('a background job that fails to load its tool stores no path', async () => {
  const call = await boot();
  const res = await call('/api/v1/compile?async=1', 'POST', { toolId: 'no-such-tool' });
  assert.equal(res.status, 202);
  const { statusUrl, jobId } = await res.json() as { statusUrl?: string; jobId: string };
  const url = statusUrl ?? `/api/v1/jobs/${jobId}`;
  let body = '';
  for (let i = 0; i < 100; i++) {
    const job = await call(url);
    body = await job.text();
    if ((JSON.parse(body) as { state: string }).state === 'failed') break;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal((JSON.parse(body) as { state: string }).state, 'failed', body);
  assertNoServerPath('job', body);
});

test('a known tool still answers', async () => {
  const call = await boot();
  assert.equal((await call('/api/v1/schema/card')).status, 200);
});

test('withoutServerPaths takes out paths and leaves routes and words', () => {
  for (const message of [
    "ENOENT: no such file or directory, open '/srv/pack/tools/x/tool.json'",
    'failed at file:///app/server/src/render/pipeline.ts:12:3',
    'cannot read /Users/andy/Build/pack/tools/x/hooks.js now',
    "EACCES: permission denied, open 'C:\\pack\\tools\\x\\tool.json'",
    'cannot read C:\\pack\\tools\\x\\tool.json now',
  ]) {
    const clean = withoutServerPaths(message);
    assert.doesNotMatch(clean, /srv\/pack|file:\/\/|Users\/andy|C:\\pack/, clean);
    assert.match(clean, /\[server path\]/, clean);
  }
  const route = 'Use callbackUrl on /api/v1/renders, at /compat/placid/u/:uuid.';
  assert.equal(withoutServerPaths(route), route);
  assert.equal(withoutServerPaths('colour must be 1/2 of 3/4'), 'colour must be 1/2 of 3/4');
});

test('refusals: an engine refusal keeps its words, a repeat keeps its refusal', async () => {
  const engine = toolLoadRefusal('card', new Error('manifest refused: bad inputs'));
  assert.equal(engine.code, 'TOOL_LOAD_FAILED');
  assert.equal(engine.status, 400);
  assert.equal(engine.message, 'Tool "card" failed to load: manifest refused: bad inputs');
  assert.equal(toolLoadRefusal('card', engine), engine);
  await assert.rejects(loadToolOrRefuse(undefined, async () => 'x'), (e: ToolLoadRefusal) => e.code === 'INVALID_INPUT');
  assert.equal(await loadToolOrRefuse('card', async (id) => id), 'card');
});
