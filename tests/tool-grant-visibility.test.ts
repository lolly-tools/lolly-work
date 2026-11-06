/**
 * `tool.use` grants decide tool visibility on every surface (plans/82 fault A).
 *
 * org-config, Preview, server renders and the automation contract always read
 * `tool.use` grants. The tool feed and the tool files read only the overlay's
 * visibility clause, so a programme denied a tool was told "hidden" in Preview
 * and still received the tool in the app, and an explicit allow showed in
 * Preview while the app got 404. These tests pin the surfaces to one answer.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { mayUseTool } from '../server/src/automation/effective-contract.ts';
import { catalogVisibilityScope } from '../server/src/catalog/delivery.ts';
import { toolVisibleWithGrants } from '../server/src/policy/overlay.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let pack = '';

const TOOLS = ['open-tool', 'brand-only', 'price-sheet'];

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-tool-grants-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: TOOLS.map(id => ({ id })) }));
  for (const id of TOOLS) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id, inputs: [{ id: 'title' }] }));
  }
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Grant Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', groups: ['admin'] },
        { email: 'isv@test', groups: ['isv-partners'] },
        { email: 'isv2@test', groups: ['isv-partners'] },
        { email: 'reseller@test', groups: ['resellers'] },
      ],
    },
  }));
  store = createMemoryStore({
    // brand-only is governed and visible to brand-team alone; price-sheet and
    // open-tool have no overlay at all.
    overlays: [{ toolId: 'brand-only', version: 1, visibility: { groups: ['brand-team'] } }],
    grants: [
      // The ISV programme loses an ungoverned tool...
      { principal: 'group:isv-partners', action: 'tool.use', resource: 'tool:price-sheet', effect: 'deny' },
      // ...and resellers gain a governed tool outside its visibility clause.
      { principal: 'group:resellers', action: 'tool.use', resource: 'tool:brand-only', effect: 'allow' },
    ],
  });
  const app = buildApp({ config, store, secrets: { session: 'sg', link: 'lg' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0] as string;
}

async function feed(cookie: string): Promise<string[]> {
  const res = await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { tools: Array<{ id: string }> }).tools.map(t => t.id).sort();
}

async function preview(cookie: string, groups: string): Promise<string[]> {
  const res = await fetch(`${base}/api/v1/org-config/preview?groups=${encodeURIComponent(groups)}`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return ((await res.json()) as { preview: { hiddenTools: string[] } }).preview.hiddenTools;
}

test('a deny on an ungoverned tool removes it from the feed, its files and Preview alike', async () => {
  const isv = await login('isv@test');
  assert.deepEqual(await feed(isv), ['open-tool'], 'price-sheet denied, brand-only outside its visibility');
  assert.equal((await fetch(`${base}/tools/price-sheet/tool.json`, { headers: { cookie: isv } })).status, 404);
  assert.equal((await fetch(`${base}/tools/open-tool/tool.json`, { headers: { cookie: isv } })).status, 200);
  const admin = await login('admin@test');
  assert.deepEqual(await preview(admin, 'isv-partners'), ['brand-only', 'price-sheet'],
    'Preview names the ungoverned tool the deny hides, not only governed ones');
});

test('an explicit allow outside the visibility clause reaches the feed and the files', async () => {
  const reseller = await login('reseller@test');
  assert.deepEqual(await feed(reseller), ['brand-only', 'open-tool', 'price-sheet']);
  assert.equal((await fetch(`${base}/tools/brand-only/tool.json`, { headers: { cookie: reseller } })).status, 200);
  const admin = await login('admin@test');
  assert.deepEqual(await preview(admin, 'resellers'), []);
  const orgConfig = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: reseller } })).json() as { tools: Record<string, unknown> };
  assert.ok('brand-only' in orgConfig.tools, 'org-config agrees with the feed');
});

test('a user: grant moves only that person, and the feed scope keeps them apart', async () => {
  const isv2 = await login('isv2@test');
  const userId = (await store.getUserBySub('dev:isv2@test'))?.id;
  assert.ok(userId, 'the member has an id');
  await store.putGrant({ principal: `user:${userId}`, action: 'tool.use', resource: 'tool:price-sheet', effect: 'allow' });
  try {
    // Deny wins over the personal allow, as it does for every grant.
    assert.deepEqual(await feed(isv2), ['open-tool']);
    await store.putGrant({ principal: `user:${userId}`, action: 'tool.use', resource: 'tool:brand-only', effect: 'allow' });
    assert.deepEqual(await feed(isv2), ['brand-only', 'open-tool']);
    assert.deepEqual(await feed(await login('isv@test')), ['open-tool'], 'a colleague in the same groups is unaffected');
  } finally {
    await store.deleteGrant({ principal: `user:${userId}`, action: 'tool.use', resource: 'tool:price-sheet', effect: 'allow' });
    await store.deleteGrant({ principal: `user:${userId}`, action: 'tool.use', resource: 'tool:brand-only', effect: 'allow' });
  }
});

test('the visibility scope separates callers with different tool grants and keeps the old scope without them', () => {
  const overlays = new Map();
  const grants = [{ principal: 'user:u1', action: 'tool.use', resource: 'tool:x', effect: 'allow' as const }];
  const plain = catalogVisibilityScope({ overlays, groups: ['g'] });
  assert.equal(catalogVisibilityScope({ overlays, groups: ['g'], grants: [], userId: 'u2' }), plain,
    'no applicable tool grants: the scope is the groups alone, as before');
  assert.equal(catalogVisibilityScope({ overlays, groups: ['g'], grants, userId: 'u2' }), plain, 'another person\'s grant does not apply');
  assert.notEqual(catalogVisibilityScope({ overlays, groups: ['g'], grants, userId: 'u1' }), plain);
});

test('the automation contract and the shared decision agree, anonymous callers included', () => {
  const overlays = new Map([['brand-only', { toolId: 'brand-only', version: 1, visibility: { groups: ['brand-team'] } }]]);
  const grants = [
    { principal: '*', action: 'tool.use', resource: 'tool:retired', effect: 'deny' as const },
    { principal: 'group:isv-partners', action: 'tool.use', resource: 'tool:price-sheet', effect: 'deny' as const },
  ];
  const isv = { id: 'u-isv', groups: ['isv-partners'], role: 'member' };
  for (const toolId of ['open-tool', 'brand-only', 'price-sheet', 'retired']) {
    assert.equal(mayUseTool(isv, toolId, overlays, grants, 'gated'),
      toolVisibleWithGrants(overlays.get(toolId), toolId, { userId: isv.id, groups: isv.groups }, grants), toolId);
  }
  assert.equal(mayUseTool(null, 'retired', overlays, grants, 'open'), false, 'a deny for everyone reaches anonymous callers too');
  assert.equal(mayUseTool(null, 'open-tool', overlays, grants, 'open'), true);
});
