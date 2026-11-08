// SPDX-License-Identifier: MPL-2.0
/** Partner reads stay within their served feed, including metadata around renders and submissions. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { VIEW_AS_HEADER } from '../server/src/programmes/view-as.ts';
import { createApproval } from '../server/src/approvals/engine.ts';

let server: Server;
let base = '';
let pack = '';
let admin = '';
let staff = '';
let rita = '';
let agentToken = '';
let logoId = '';
let config: ReturnType<typeof parseConfig>;
const store = createMemoryStore();
const blobs = createMemoryBlobStore();
const assets = [
  { id: 'acme/tokens', type: 'tokens', formats: [{ format: 'json', url: '/catalog/assets/tokens.json' }] },
  { id: 'internal/roadmap', name: 'Internal roadmap', type: 'image', formats: [{ format: 'png', url: '/catalog/assets/internal.png' }] },
];
const writeIndex = () => writeFile(join(pack, 'catalog/assets/index.json'), JSON.stringify({ version: 1, assets }));
const get = (cookie: string, path: string, headers: Record<string, string> = {}) => fetch(`${base}${path}`, { headers: { cookie, ...headers } });
const send = (cookie: string, method: string, path: string, body: unknown) => fetch(`${base}${path}`, {
  method, headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
});
async function login(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return response.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function putAsset(id: string, by?: string, state: 'submitted' | 'live' = 'live', approvalId?: string) {
  const stat = await blobs.put(`${id}/png`, Buffer.from(id), 'image/png');
  return store.putInstanceAsset({
    id, entry: instanceAssetEntry(id, { name: id, type: 'image' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]),
    blobs: { png: `${id}/png` }, groups: ['marketing'], createdAt: new Date().toISOString(),
    ...(by ? { submission: { state, by: `user:${by}`, at: new Date().toISOString(), checksum: stat.checksum, size: stat.size, contentType: 'image/png', ...(approvalId ? { approvalId } : {}) } } : {}),
  });
}
async function rows(cookie: string, state = 'submitted') {
  const response = await get(cookie, `/api/v1/catalog/submissions?state=${state}`);
  assert.equal(response.status, 200);
  return (await response.json() as { submissions: Array<{ id: string; relation: string; data?: { toolName?: string; undeclared?: number } }> }).submissions;
}
async function render(cookie: string, inputs: Record<string, unknown>) {
  const response = await send(cookie, 'POST', '/api/v1/render', { toolId: 'scope-card', format: 'svg', inputs });
  const text = await response.text();
  assert.equal(response.status, 200, text);
  return { response, text };
}
async function startApp() {
  if (server?.listening) {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
  const app = buildApp({ config, store, blobs, secrets: { session: 'scope-3-session', link: 'scope-3-link' }, backgroundPollMs: 0 });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(0, resolve); });
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
}
async function unavailable(response: Response) {
  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: { code: 'NOT_FOUND', message: 'not available' } });
}

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-scope-3-'));
  await mkdir(join(pack, 'catalog/assets'), { recursive: true });
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await writeFile(join(pack, 'catalog/assets/tokens.json'), JSON.stringify({ lolly: { foundation: { radius: { sm: { $type: 'dimension', $value: '8px' } } } } }));
  await writeIndex();
  for (const id of ['scope-card', 'hidden-tool']) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({
      id, name: id === 'hidden-tool' ? 'Confidential launch planner' : 'Scope card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
      render: { width: 400, height: 200, formats: ['svg'] },
      inputs: id === 'hidden-tool' ? [{ id: 'secretLaunchCode', label: 'Launch code', type: 'text', default: '' }] : [
        { id: 'title', label: 'Title', type: 'text', default: 'Hello' },
        { id: 'logo', label: 'Logo', type: 'asset' },
        { id: 'note', label: 'Note', type: 'text', default: '' },
      ],
    }));
    await writeFile(join(pack, 'tools', id, 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200" viewBox="0 0 400 200"><image href="{{asset logo}}" width="100" height="40"/><text x="20" y="100">{{title}}</text></svg>');
  }
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify({ tools: [{ id: 'scope-card' }, { id: 'hidden-tool' }] }));
  const provider = (id: string, enabled: boolean, groups: string[]) => ({
    id, kind: 'mock', label: `Private ${id}`, enabled, exposure: { groups },
    options: { assets: [{ remoteId: 'hidden', name: 'Secret campaign photo', nativeType: 'file', sections: [], tags: [], approved: true,
      updatedAt: '2026-05-01T00:00:00.000Z', formats: [{ format: 'json', remoteRef: 'f1', filename: 'secret-campaign.json' }] }], blobText: { hidden: '{}' } },
    mapping: { defaultType: 'image' },
  });
  config = parseConfig(JSON.stringify({
    instance: { name: 'Scope Hub', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] }, { email: 'staff@test', groups: ['marketing'] }, { email: 'rita@reseller.test', groups: [] },
    ] },
    catalogProviders: [provider('private', true, ['marketing']), provider('disabled', false, ['marketing']), provider('unexposed', true, ['other-team'])],
  }));
  await putAsset('inst/kit');
  await putAsset('inst/internal');
  const kit = (await store.getInstanceAsset('inst/kit'))!;
  kit.groups = '*';
  kit.entry.replacedBy = 'inst/internal';
  kit.entry.meta = { replacedBy: 'inst/internal' };
  await store.putInstanceAsset(kit);
  await store.putCollection({ id: 'emea-kit', name: 'EMEA kit', members: ['inst/kit'], groups: ['marketing'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await startApp();
  admin = await login('admin@test');
  staff = await login('staff@test');
  await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  const staffId = (await store.getUserBySub('dev:staff@test'))!.id;
  assert.equal((await send(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['scope-card'], collections: ['emea-kit'] })).status, 201);
  assert.equal((await send(admin, 'PUT', `/api/v1/users/${ritaId}/local-groups`, { groups: ['programme-resellers'] })).status, 200);
  const approval = createApproval({ id: 'staff-review', subjectType: 'asset', subjectRef: 'inst/staff-pending', title: 'Staff upload',
    chain: { id: 'partner-review', name: 'Review', steps: [{ name: 'Review', approvers: { groups: ['programme-resellers', 'marketing'] }, rule: 'any' }], onReject: 'return-to-submitter' },
    nominees: [], createdBy: staffId, now: new Date().toISOString() });
  await store.putApproval(approval);
  await putAsset('inst/staff-pending', staffId, 'submitted', approval.id);
  const ownReview = { ...approval, id: 'rita-review', subjectRef: 'inst/rita-pending', createdBy: ritaId };
  await store.putApproval(ownReview);
  await putAsset('inst/rita-pending', ritaId, 'submitted', ownReview.id);
  await putAsset('inst/rita-live', ritaId);
  await putAsset('inst/staff-live', staffId);
  for (const principal of ['group:programme-resellers', 'group:marketing']) {
    for (const action of ['catalog.submit', 'export.server']) await store.putGrant({ principal, action, resource: '*', effect: 'allow' });
  }
  assert.equal((await send(admin, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status, 201);
  assert.equal((await send(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@reseller.test', company: 'northwind' }], apply: true })).status, 200);
  await store.setLocalGroups(staffId, ['company-northwind']);
  const profile = '/api/v1/programmes/resellers/companies/northwind/profile';
  const logo = await fetch(`${base}${profile}/logo?surface=light`, { method: 'POST', headers: { cookie: admin, 'content-type': 'image/svg+xml' },
    body: '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 4"><path d="M0 0H10V4H0Z" fill="#0b3d91"/></svg>' });
  assert.equal(logo.status, 200, await logo.text());
  logoId = (await (await get(admin, profile)).json() as { profile: { logoLight: string } }).profile.logoLight;
  await store.putOverlay({ toolId: 'scope-card', version: 1, bindings: { logo: 'logo' } });
  const minted = await (await send(admin, 'POST', '/api/v1/programmes/resellers/tokens', { label: 'Northwind agent', company: 'northwind' })).json() as { secret?: string; token?: string };
  agentToken = (minted.secret ?? minted.token)!;
  assert.ok(agentToken);
  rita = await login('rita@reseller.test');
});

after(async () => {
  server?.closeAllConnections();
  if (server?.listening) await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  if (pack) await rm(pack, { recursive: true, force: true });
});

test('2: matching approval groups never give a partner another submitter\'s inbox or bytes', async () => {
  const theirs = await rows(rita);
  assert.ok(theirs.some(row => row.id === 'inst/rita-pending' && row.relation === 'mine'));
  assert.ok(!theirs.some(row => row.id === 'inst/staff-pending'));
  await unavailable(await get(rita, '/api/v1/catalog/submissions/staff-pending/bytes'));
  assert.equal((await get(rita, '/api/v1/catalog/submissions/rita-pending/bytes')).status, 200);
  assert.ok((await rows(staff)).some(row => row.id === 'inst/staff-pending'));
  assert.ok((await rows(staff)).some(row => row.id === 'inst/rita-pending' && row.relation === 'inbox'));
  assert.equal((await get(staff, '/api/v1/catalog/submissions/rita-pending/bytes')).status, 200);
  assert.equal((await get(staff, '/api/v1/catalog/submissions/staff-pending/bytes')).status, 200);
});

test('3: a partner render never bakes a future company logo; staff keep the previous logo rule', async () => {
  assert.match((await render(rita, { title: 'Live logo' })).text, /data:image\/svg\+xml;base64,/);
  await store.putLifecycle({ assetId: logoId, onExpiry: 'hide', validFrom: new Date(Date.now() + 86_400_000).toISOString() });
  try {
    assert.doesNotMatch((await render(rita, { title: 'Scheduled logo' })).text, /data:image\/svg\+xml;base64,/);
    assert.match((await render(staff, { title: 'Staff scheduled logo' })).text, /data:image\/svg\+xml;base64,/);
  } finally { await store.putLifecycle({ assetId: logoId, onExpiry: 'hide' }); }
});

test('4: an unused hidden catalog URL in render values discloses no partner provenance', async () => {
  const inputs = { title: 'Provenance', note: '/catalog/ext/private/hidden/f1' };
  const partner = await render(rita, inputs);
  assert.ok(!partner.response.headers.get('x-lolly-provenance')?.includes('ext/private/hidden'));
  assert.doesNotMatch(partner.text, /Secret campaign photo|secret-campaign.json|ext\/private\/hidden/);
  const own = await render(staff, inputs);
  assert.match(own.text, /Secret campaign photo/);
  const other = { ...inputs, title: 'Staff cache first' };
  assert.match((await render(staff, other)).text, /Secret campaign photo/);
  assert.doesNotMatch((await render(rita, other)).text, /Secret campaign photo|ext\/private\/hidden/);
});

test('5: partner design revisions use their own feed and do not track internal asset edits', async () => {
  const schema = async (cookie: string, headers: Record<string, string> = {}) => {
    const response = await get(cookie, '/api/v1/schema/scope-card', headers);
    assert.equal(response.status, 200, await response.clone().text());
    const body = await response.json() as { versions: { design: string } };
    return { header: response.headers.get('x-lolly-brand-revision'), design: body.versions.design };
  };
  const beforeRita = await schema(rita);
  const beforeStaff = await schema(staff);
  const tokenHeaders = { authorization: `Bearer ${agentToken}` };
  const beforeAgent = await schema('', tokenHeaders);
  const original = assets[1]!.name;
  assets[1]!.name = 'Internal roadmap revised for next quarter';
  await writeIndex();
  try {
    // Mounted sources are immutable for one app, so an updated pack starts a new app.
    await startApp();
    await get(rita, '/catalog/assets/index.json');
    const afterRita = await schema(rita);
    const afterStaff = await schema(staff);
    assert.deepEqual(afterRita, beforeRita);
    assert.notEqual(afterStaff.header, beforeStaff.header);
    assert.notEqual(afterStaff.design, beforeStaff.design);
    assert.notEqual(afterRita.header, afterStaff.header);
    assert.notEqual(afterRita.design, afterStaff.design);
    assert.deepEqual(await schema('', tokenHeaders), beforeAgent);
    await schema(rita, { 'x-lolly-brand-revision': beforeRita.header! });
    assert.equal((await get(staff, '/api/v1/schema/scope-card', { 'x-lolly-brand-revision': beforeStaff.header! })).status, 409);
  } finally { assets[1]!.name = original; await writeIndex(); }
});

test('6: editing a partner\'s own live submission outside their feed gives plain absence', async () => {
  await unavailable(await send(rita, 'PATCH', '/api/v1/catalog/submissions/rita-live', { name: 'Changed' }));
  assert.equal((await send(rita, 'PATCH', '/api/v1/catalog/submissions/rita-pending', { name: 'Still mine' })).status, 200);
  const own = await send(staff, 'PATCH', '/api/v1/catalog/submissions/staff-live', { name: 'Changed' });
  assert.equal(own.status, 409);
  assert.match(await own.text(), /ALREADY_SETTLED.*live/);
});

test('7: a template submission cannot reveal a tool the partner may not use; staff keep the summary', async () => {
  const submit = (cookie: string, name: string, group: string) => send(cookie, 'POST', `/api/v1/catalog/submit?type=template&name=${name}&groups=${group}`, {
    toolId: 'hidden-tool', values: { secretLaunchCode: 'x', unknown: 'y' },
  });
  const partner = await submit(rita, 'Partner-template', 'programme-resellers');
  const body = await partner.text();
  assert.doesNotMatch(body, /Confidential launch planner|secretLaunchCode/);
  if (partner.ok) {
    const row = (await rows(rita, 'all')).find(row => row.id === JSON.parse(body).assetId);
    assert.ok(row);
    assert.doesNotMatch(JSON.stringify(row), /Confidential launch planner|undeclared|secretLaunchCode/);
  } else assert.equal(partner.status, 422, body);
  const own = await submit(staff, 'Staff-template', 'marketing');
  assert.equal(own.status, 201, await own.clone().text());
  const id = (await own.json() as { assetId: string }).assetId;
  const summary = (await rows(staff, 'all')).find(row => row.id === id)?.data;
  assert.equal(summary?.toolName, 'Confidential launch planner');
  assert.equal(summary?.undeclared, 1);
});

test('8: a scoped feed omits both replacement references to a successor outside the feed', async () => {
  const entry = async (cookie: string, headers: Record<string, string> = {}) => {
    const response = await get(cookie, '/catalog/assets/index.json', headers);
    assert.equal(response.status, 200);
    const feed = await response.json() as { assets: Array<{ id: string; replacedBy?: string; meta?: { replacedBy?: string } }> };
    return feed.assets.find(asset => asset.id === 'inst/kit')!;
  };
  const partner = await entry(rita);
  assert.ok(partner);
  assert.equal(partner.replacedBy, undefined);
  assert.equal(partner.meta?.replacedBy, undefined);
  const own = await entry(staff);
  assert.equal(own.replacedBy, 'inst/internal');
  assert.equal(own.meta?.replacedBy, 'inst/internal');
  const collection = (await store.getCollection('emea-kit'))!;
  await store.putCollection({ ...collection, members: [...collection.members, 'inst/internal'] });
  try {
    const included = await entry(rita);
    assert.equal(included.replacedBy, 'inst/internal', 'a successor in the feed stays named');
    assert.equal(included.meta?.replacedBy, 'inst/internal');
    const started = await send(admin, 'POST', '/api/v1/programmes/resellers/view-as', {});
    assert.equal(started.status, 201);
    const { token } = await started.json() as { token: string };
    const viewed = await entry(admin, { [VIEW_AS_HEADER]: token });
    assert.ok(viewed, 'the viewer and the programme both hold the kit');
    assert.equal(viewed.replacedBy, undefined, 'the viewer does not hold the successor');
    assert.equal(viewed.meta?.replacedBy, undefined);
  } finally { await store.putCollection(collection); }
});

test('9: partner brand sources omit namespaces while staff keep the inventory', async () => {
  const sources = async (cookie: string) => (await (await get(cookie, '/api/v1/brand/profiles')).json() as { sources: Array<{ namespaces?: string[] }> }).sources;
  assert.ok((await sources(rita)).every(source => !Object.hasOwn(source, 'namespaces')));
  assert.ok((await sources(staff)).some(source => source.namespaces?.includes('internal/')));
});

test('10: missing, disabled and inaccessible providers all give partners the same plain absence', async () => {
  for (const provider of ['missing', 'disabled', 'unexposed']) await unavailable(await get(rita, `/catalog/ext/${provider}/hidden/f1`));
  for (const [provider, status, code] of [['missing', 404, 'NOT_FOUND'], ['disabled', 410, 'PROVIDER_DISABLED'], ['unexposed', 403, 'FORBIDDEN']] as const) {
    const own = await get(staff, `/catalog/ext/${provider}/hidden/f1`);
    assert.equal(own.status, status);
    assert.equal((await own.json() as { error: { code: string } }).error.code, code);
  }
});

test('the asset record names a successor to a partner only from their own feed', async () => {
  // The successor recorded in the metadata overlay, the way the console records one.
  const prior = await store.getAssetMeta('inst/kit');
  await store.putAssetMeta({ assetId: 'inst/kit', fields: prior?.fields ?? {}, replacedBy: 'inst/internal', updatedBy: 'user:x', updatedAt: new Date().toISOString() } as never);
  const record = async (cookie: string) => (await (await get(cookie, '/api/v1/catalog/assets/inst/kit')).json()) as { replacedBy?: string };
  assert.equal((await record(rita)).replacedBy, undefined, 'the stored successor is not in the partner\'s feed');
  assert.equal((await record(staff)).replacedBy, 'inst/internal', 'staff unchanged');
});

test('a retired template\'s 410 names its successor to a partner only when their feed carries it', async () => {
  const at = new Date().toISOString();
  const put = async (id: string, groups: string[], publication?: Record<string, unknown>) => {
    const stat = await blobs.put(`${id}/json`, Buffer.from(JSON.stringify({ values: { title: 'Retired card' } })), 'application/json');
    await store.putInstanceAsset({
      id, entry: { id, name: id, type: 'template', meta: { toolId: 'scope-card' }, formats: [{ format: 'json', url: `/catalog/${id}/json`, size: stat.size, checksum: stat.checksum }] },
      blobs: { json: `${id}/json` }, groups, createdAt: at,
      submission: { state: 'live', by: 'user:x', at, checksum: stat.checksum, size: stat.size, contentType: 'application/json' },
      ...(publication ? { publication } : {}),
    } as never);
  };
  await put('inst/internal-card', ['marketing']);
  await put('inst/retired-card', ['programme-resellers'], { retiredAt: at, retiredBy: 'user:x', replacedBy: 'inst/internal-card' });
  const res = await send(rita, 'POST', '/api/v1/render', { toolId: 'scope-card', format: 'svg', inputs: { template: 'inst/retired-card' } });
  assert.equal(res.status, 410);
  const body = await res.text();
  assert.doesNotMatch(body, /internal-card/, 'no successor outside the partner\'s feed');
});
