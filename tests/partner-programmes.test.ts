/**
 * Partner programmes (plans/82 M1).
 *
 * A programme wraps the local group `programme-<id>`. Its people see nothing
 * internal except what a programme includes: tools through `tool.use` allow
 * grants for the group, assets through collections (and instance assets or
 * providers) whose groups name the group, and the design-system essentials.
 * "Everyone" never includes a programme. A person who leaves their last
 * programme keeps the partner marker and sees only the essentials, and links
 * they made stop. A person in two programmes gets the stricter input rule.
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
import { resolveInputAccess, type ToolOverlay } from '../server/src/policy/overlay.ts';
import { mayUseTool } from '../server/src/automation/effective-contract.ts';
import { isProgrammeScoped, withPartnerMarker } from '../server/src/programmes/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const TOOLS = ['price-sheet', 'qr-code', 'internal-deck'];
const ASSETS = [
  { id: 'acme/tokens', name: 'Acme tokens', type: 'tokens', file: 'tokens.json', body: '{}' },
  { id: 'acme/font', name: 'Acme Sans', type: 'font', file: 'sans.woff2', body: 'font' },
  { id: 'acme/logo', name: 'Acme logo', type: 'vector', file: 'logo.svg', body: '<svg xmlns="http://www.w3.org/2000/svg"/>' },
  { id: 'acme/emea-banner', name: 'EMEA banner', type: 'raster', file: 'emea.png', body: 'png' },
  { id: 'acme/roadmap', name: 'Internal roadmap', type: 'raster', file: 'roadmap.png', body: 'png' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programmes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: TOOLS.map((id) => ({ id })) }));
  for (const id of TOOLS) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id, inputs: [{ id: 'title' }, { id: 'price' }] }));
  }
  for (const a of ASSETS) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: ASSETS.map((a) => ({ id: a.id, name: a.name, type: a.type, formats: [{ format: a.file.split('.').pop(), url: `/catalog/assets/acme/${a.file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
      { email: 'pat@dual.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['acme/emea-banner'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putCollection({ id: 'everyone-kit', name: 'Everyone kit', members: ['acme/roadmap'], groups: '*', curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, secrets: { session: 'sp', link: 'lp' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const json = (cookie: string, method: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});
const feedTools = async (cookie: string) => ((await (await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } })).json()) as { tools: Array<{ id: string }> }).tools.map((t) => t.id).sort();
const feedAssets = async (cookie: string) => {
  const feed = (await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json()) as { assets: Array<{ id: string }>; collections?: Array<{ id: string; members: string[] }> };
  return { assets: feed.assets.map((a) => a.id).sort(), collections: (feed.collections ?? []).map((c) => `${c.id}:${c.members.join(',')}`).sort() };
};
const userId = async (email: string) => (await store.getUserBySub(`dev:${email}`))!.id;

test('an admin names a programme and sets what it includes, through grants and collection groups', async () => {
  const admin = await login('admin@test');
  const res = await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['price-sheet'], collections: ['emea-kit'] });
  assert.equal(res.status, 201);
  const view = await res.json() as { group: string; tools: string[]; collections: Array<{ id: string }> };
  assert.equal(view.group, 'programme-resellers');
  assert.deepEqual(view.tools, ['price-sheet']);
  assert.deepEqual(view.collections.map((c) => c.id), ['emea-kit']);
  assert.ok((await store.listGrants()).some((g) => g.principal === 'group:programme-resellers' && g.action === 'tool.use' && g.resource === 'tool:price-sheet'));
  assert.deepEqual((await store.getCollection('emea-kit'))!.groups, ['marketing', 'programme-resellers']);
  const groups = (await store.listLocalGroups()).map((g) => g.name);
  assert.ok(groups.includes('programme-resellers') && groups.includes('partner'));
  const audit = await store.listAudit();
  assert.ok(audit.some((a) => a.action === 'programme.create' && a.subject === 'programme:resellers'));
  assert.ok(audit.some((a) => a.action === 'grant.create' && (a.payload as { via?: string })?.via === 'programme:resellers'));
  await json(admin, 'PUT', '/api/v1/programmes/isv', { name: 'ISVs', tools: ['price-sheet', 'qr-code'], collections: [] });
});

test('a programme member sees only what their programme includes, and the essentials', async () => {
  const admin = await login('admin@test');
  await login('rita@reseller.test');
  assert.equal((await json(admin, 'PUT', `/api/v1/users/${await userId('rita@reseller.test')}/local-groups`, { groups: ['programme-resellers'] })).status, 200);
  const rita = await login('rita@reseller.test');
  assert.deepEqual(await feedTools(rita), ['price-sheet']);
  assert.equal((await fetch(`${base}/tools/internal-deck/tool.json`, { headers: { cookie: rita } })).status, 404);
  const { assets, collections } = await feedAssets(rita);
  assert.deepEqual(assets, ['acme/emea-banner', 'acme/font', 'acme/tokens'], 'essentials plus the granted collection, no logo, no roadmap');
  assert.deepEqual(collections, ['emea-kit:acme/emea-banner'], 'a collection shared with everyone does not reach a programme');
  assert.equal((await fetch(`${base}/catalog/assets/acme/logo.svg`, { headers: { cookie: rita } })).status, 404);
  assert.equal((await fetch(`${base}/catalog/assets/acme/emea.png`, { headers: { cookie: rita } })).status, 200);
  // An internal member is unaffected: everything, and the everyone collection.
  const staff = await login('staff@test');
  assert.deepEqual(await feedTools(staff), TOOLS.slice().sort());
  assert.ok((await feedAssets(staff)).collections.includes('everyone-kit:acme/roadmap'));
  // Preview tells the admin the same before anyone is invited.
  const preview = await (await fetch(`${base}/api/v1/org-config/preview?groups=programme-resellers`, { headers: { cookie: admin } })).json() as {
    preview: { scoped: boolean; visibleTools: string[]; assets: { count: number; collections: Array<{ id: string }> } } };
  assert.equal(preview.preview.scoped, true);
  assert.deepEqual(preview.preview.visibleTools, ['price-sheet']);
  assert.equal(preview.preview.assets.count, 3);
  assert.deepEqual(preview.preview.assets.collections.map((c) => c.id), ['emea-kit']);
});

test('a programme member cannot link what their programme does not include, and leaving stops their links', async () => {
  const admin = await login('admin@test');
  const rita = await login('rita@reseller.test');
  assert.ok([403, 404].includes((await json(rita, 'POST', '/api/v1/links', { kind: 'download', target: { assetId: 'acme/logo' } })).status), 'a logo the programme does not include is refused');
  const minted = await json(rita, 'POST', '/api/v1/links', { kind: 'download', target: { assetId: 'acme/emea-banner' } });
  assert.equal(minted.status, 201);
  const path = ((await minted.json()) as { url: string }).url.replace('http://localhost', base);
  assert.equal((await fetch(path)).status, 200);
  // Rita leaves the programme. The partner marker stays, so she sees only the essentials.
  assert.equal((await json(admin, 'PUT', `/api/v1/users/${await userId('rita@reseller.test')}/local-groups`, { groups: ['partner'] })).status, 200);
  const after = await login('rita@reseller.test');
  assert.deepEqual(await feedTools(after), []);
  assert.deepEqual((await feedAssets(after)).assets, ['acme/font', 'acme/tokens']);
  const stopped = await fetch(path);
  assert.equal(stopped.status, 410);
  assert.equal(((await stopped.json()) as { error: { code: string } }).error.code, 'LINK_MAKER_NO_ACCESS');
});

test('announcements to everyone do not reach a programme; one naming the programme does', async () => {
  const admin = await login('admin@test');
  await json(admin, 'PUT', `/api/v1/users/${await userId('rita@reseller.test')}/local-groups`, { groups: ['programme-resellers'] });
  await store.putMessage({ id: 'm-all', kind: 'announcement', title: 'Internal launch', body: '', audience: { groups: ['*'] }, createdAt: new Date().toISOString() } as never);
  await store.putMessage({ id: 'm-prog', kind: 'announcement', title: 'Reseller pricing', body: '', audience: { groups: ['programme-resellers'] }, createdAt: new Date().toISOString() } as never);
  const rita = await login('rita@reseller.test');
  const inbox = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: rita } })).json() as { messages: Array<{ id: string }> };
  const ids = inbox.messages.map((m) => m.id);
  assert.ok(!ids.includes('m-all'));
  assert.ok(ids.includes('m-prog'));
  const staff = await login('staff@test');
  const staffInbox = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: staff } })).json() as { messages: Array<{ id: string }> };
  assert.ok(staffInbox.messages.some((m) => m.id === 'm-all'));
});

test('programme groups and the partner marker are reserved', async () => {
  const admin = await login('admin@test');
  assert.equal((await json(admin, 'POST', '/api/v1/groups', { name: 'programme-sneaky' })).status, 400);
  assert.equal((await json(admin, 'POST', '/api/v1/groups', { name: 'partner' })).status, 400);
  assert.equal((await json(admin, 'DELETE', '/api/v1/groups/partner')).status, 400);
});

test('deleting a programme removes its grants and collection groups and leaves its people as partners', async () => {
  const admin = await login('admin@test');
  await login('pat@dual.test');
  await json(admin, 'PUT', `/api/v1/users/${await userId('pat@dual.test')}/local-groups`, { groups: ['programme-isv'] });
  assert.equal((await json(admin, 'DELETE', '/api/v1/programmes/isv')).status, 200);
  assert.ok(!(await store.listGrants()).some((g) => g.principal === 'group:programme-isv'));
  const pat = (await store.getUserBySub('dev:pat@dual.test'))!;
  assert.deepEqual(pat.localGroups, ['partner']);
  assert.ok(isProgrammeScoped(pat.groups, pat.role));
});

test('a person in two programmes gets the stricter input rule; others keep the overlay order', () => {
  const overlay: ToolOverlay = { toolId: 'price-sheet', version: 1, inputAccess: { price: [
    { groups: ['programme-isv'], level: 'editable' },
    { groups: ['programme-resellers'], level: 'locked', value: '99' },
    { groups: ['brand-team'], level: 'editable' },
    { groups: ['*'], level: 'choice', allow: ['1', '2'] },
  ] } };
  assert.equal(resolveInputAccess(overlay, 'price', ['programme-isv', 'programme-resellers', 'partner']).level, 'locked');
  assert.equal(resolveInputAccess(overlay, 'price', ['programme-isv', 'partner']).level, 'editable');
  assert.equal(resolveInputAccess(overlay, 'price', ['brand-team']).level, 'editable', 'first match for everyone else');
  const choices: ToolOverlay = { toolId: 't', version: 1, inputAccess: { size: [
    { groups: ['programme-a'], level: 'choice', allow: ['s', 'm', 'l'] },
    { groups: ['programme-b'], level: 'choice', allow: ['m', 'l', 'xl'] },
  ] } };
  assert.deepEqual(resolveInputAccess(choices, 'size', ['programme-a', 'programme-b']).allow, ['m', 'l'], 'two choices keep what both allow');
});

test('the automation contract scopes programme members the same way, and admins are never scoped', async () => {
  const grants = await store.listGrants();
  const overlays = new Map();
  const partner = { id: 'p', groups: withPartnerMarker(['programme-resellers']), role: 'member' };
  assert.equal(mayUseTool(partner, 'price-sheet', overlays, grants, 'gated'), true);
  assert.equal(mayUseTool(partner, 'internal-deck', overlays, grants, 'gated'), false);
  const admin = { id: 'a', groups: ['admin', 'programme-resellers', 'partner'], role: 'admin' };
  assert.equal(mayUseTool(admin, 'internal-deck', overlays, grants, 'gated'), true);
});

test('a project shared with everyone does not reach a programme member', async () => {
  const { projectAccess } = await import('../server/src/rbac/project-access.ts');
  const project = { id: 'p1', name: 'Launch', ownerId: 'someone', createdAt: 'x', updatedAt: 'x', visibility: 'private',
    sharing: { general: { audience: 'instance', role: 'commenter' } } } as never;
  const base = { sub: 's', email: 'e', idpGroups: [], localGroups: [], sessionEpoch: 0, createdAt: 'x', lastSeenAt: 'x', role: 'member' };
  assert.equal(projectAccess({ ...base, id: 'staff', groups: ['marketing'] } as never, project), 'commenter');
  assert.equal(projectAccess({ ...base, id: 'partner', groups: ['programme-resellers', 'partner'] } as never, project), 'none');
});

test('someone who manages programmes publishes into a programme without joining it', async () => {
  const admin = await login('admin@test');
  await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA' });
  const res = await fetch(`${base}/api/v1/catalog/submit?name=Reseller%20promo&groups=programme-resellers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="4" height="4"/>' });
  assert.equal(res.status, 201);
  const staff = await login('staff@test');
  const refused = await fetch(`${base}/api/v1/catalog/submit?name=X&groups=programme-resellers`, {
    method: 'POST', headers: { cookie: staff, 'content-type': 'image/svg+xml' }, body: '<svg xmlns="http://www.w3.org/2000/svg" width="5" height="5"/>' });
  assert.equal(refused.status, 403, 'a member without programme.manage still cannot');
});
