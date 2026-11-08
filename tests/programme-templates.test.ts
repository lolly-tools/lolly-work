// SPDX-License-Identifier: MPL-2.0
/**
 * Templates published to a partner programme (plans/82 M2, W3): the routes the
 * console's Templates card and Preview use.
 *
 * What this suite pins:
 *   - someone who manages programmes publishes a catalog template into a
 *     programme without joining it, as the programme's own copy, with the
 *     inputs partners may change; it reaches exactly that audience;
 *   - every input open is the same as no rules (decision D3);
 *   - who gets it and what they may change are edited in place, and an input
 *     the tool does not have is refused;
 *   - a new version must start the same tool;
 *   - retiring keeps the template in the feed for saved copies, names its
 *     replacement, and can be undone;
 *   - Preview lists what each template lets a group change, and why the rest
 *     is fixed, including that the programme can also open the tool on its own;
 *   - only a programme manager may do any of it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let catalogTemplate = '';
let published = '';

const manifest = {
  id: 'price-card', name: 'Price card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 400, height: 200, formats: ['svg'] },
  inputs: [
    { id: 'title', label: 'Product', type: 'text', default: 'Product' },
    { id: 'price', label: 'Price', type: 'text', default: '' },
    { id: 'bg', label: 'Background', type: 'color', default: '#204080' },
    { id: 'accent', label: 'Accent', type: 'color', default: '{color.semantic.primary}' },
  ],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programme-templates-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'price-card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'price-card', 'tool.json'), JSON.stringify(manifest));
  await writeFile(join(pack, 'tools', 'price-card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg"><text>{{title}} {{price}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'bruno@test', groups: ['brand'] },
      { email: 'rita@acme.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-card'] })).status, 201);
  assert.equal((await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme', { name: 'Acme Distribution' })).status, 201);
  await login('rita@acme.test');
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test', company: 'acme' }], apply: true })).status, 200);
  catalogTemplate = await submitTemplate(admin, 'Partner price sheet', 'SLES 16');
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as any };
};
async function submitTemplate(cookie: string, name: string, title: string): Promise<string> {
  const res = await fetch(`${base}/api/v1/catalog/submit?type=template&toolId=price-card`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'price-card', name, values: { title, price: '€ 1,240', bg: '#0c322c' } }),
  });
  const out = await res.json() as { assetId: string };
  assert.ok(res.status === 201 || res.status === 200, JSON.stringify(out));
  return out.assetId;
}
const listed = async () => (await call(await login('admin@test'), 'GET', '/api/v1/programmes/resellers/templates')).body;
const ritaEntry = async (id: string) => {
  const feed = (await call(await login('rita@acme.test'), 'GET', '/catalog/assets/index.json')).body as { assets: Array<{ id: string; meta?: Record<string, unknown> }> };
  return feed.assets.find((a) => a.id === id);
};
const bare = (id: string) => id.replace(/^inst\//, '');

test('a programme manager publishes a catalog template into the programme, with what partners may change', async () => {
  const before = await listed();
  assert.deepEqual(before.templates, []);
  assert.deepEqual(before.candidates.map((c: { id: string }) => c.id), [catalogTemplate]);
  assert.deepEqual(before.companyFields.filter((f: { kind: string }) => f.kind === 'logo').map((f: { id: string }) => f.id), ['logo', 'logoLight', 'logoDark', 'mark'],
    'a picture input is offered the logos and the mark, a text input the details');
  assert.deepEqual(before.candidates[0].inputs, [{ id: 'title', label: 'Product', type: 'text' }, { id: 'price', label: 'Price', type: 'text' }, { id: 'bg', label: 'Background', type: 'color' }, { id: 'accent', label: 'Accent', type: 'color' }]);

  const admin = await login('admin@test');
  const out = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'], editable: ['price'] });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  published = out.body.id;
  assert.notEqual(published, catalogTemplate, 'the programme gets its own copy');

  const after = await listed();
  const row = after.templates[0];
  assert.equal(row.id, published);
  assert.equal(row.kind, 'template');
  assert.equal(row.toolName, 'Price card');
  assert.deepEqual(row.editable, ['price']);
  assert.deepEqual(row.audience, [{ group: 'programme-resellers', label: 'Everyone in Resellers' }]);
  assert.deepEqual(row.toolOpenTo, ['Resellers'], 'the programme can also open Price card on its own');
  assert.equal(after.candidates.length, 1, 'the catalog template is still there to publish from');

  assert.deepEqual((await ritaEntry(published))?.meta?.editable, ['price']);
  assert.equal(await ritaEntry(catalogTemplate), undefined, 'the catalog original stays with your own people');
});

test('who gets it and what they may change are edited in place; every input open means no rules', async () => {
  const admin = await login('admin@test');
  const path = `/api/v1/programmes/resellers/templates/${bare(published)}`;
  assert.equal((await call(admin, 'PUT', path, { editable: ['prise'] })).status, 400);
  assert.equal((await call(admin, 'PUT', path, { groups: ['marketing'] })).status, 400, 'partner groups only');
  const open = await call(admin, 'PUT', path, { editable: null });
  assert.equal(open.status, 200);
  assert.equal(open.body.editable, null);
  assert.equal((await ritaEntry(published))?.meta?.editable, undefined);
  const acme = await call(admin, 'PUT', path, { groups: ['company-acme'], editable: ['price', 'title'] });
  assert.equal(acme.status, 200);
  const row = (await listed()).templates[0];
  assert.deepEqual(row.audience, [{ group: 'company-acme', label: 'Acme Distribution' }]);
  assert.deepEqual(row.toolOpenTo, ['Resellers'], 'a company\'s programme can open the tool too');
  assert.deepEqual((await ritaEntry(published))?.meta?.editable, ['price', 'title']);
});

test('a new version starts the same tool and moves the version partners see', async () => {
  const admin = await login('admin@test');
  const changed = await submitTemplate(admin, 'Partner price sheet v2', 'SLES 16 SP1');
  const out = await call(admin, 'POST', `/api/v1/programmes/resellers/templates/${bare(published)}/versions`, { from: changed });
  assert.equal(out.status, 201, JSON.stringify(out.body));
  assert.equal(out.body.version, 2);
  assert.equal((await ritaEntry(published))?.meta?.version, 2);
  assert.equal((await call(admin, 'POST', `/api/v1/programmes/resellers/templates/${bare(published)}/versions`, { from: published })).status, 404, 'only a catalog template');
});

test('retiring keeps it for saved copies, names the replacement, and can be undone', async () => {
  const admin = await login('admin@test');
  const second = (await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] })).body.id as string;
  const path = `/api/v1/programmes/resellers/templates/${bare(published)}`;
  assert.equal((await call(admin, 'POST', `${path}/retire`, { replacedBy: published })).status, 400, 'not itself');
  const retired = await call(admin, 'POST', `${path}/retire`, { replacedBy: second });
  assert.equal(retired.status, 200);
  const entry = await ritaEntry(published);
  assert.equal(entry?.meta?.retired, true);
  assert.equal(entry?.meta?.replacedBy, second);
  const row = (await listed()).templates.find((t: { id: string }) => t.id === published);
  assert.equal(row.retired.replacedByName, 'Partner price sheet');
  assert.equal((await call(admin, 'POST', `${path}/versions`, { from: catalogTemplate })).status, 409, 'no versions while retired');
  assert.equal((await call(admin, 'POST', `${path}/restore`)).status, 200);
  assert.equal((await ritaEntry(published))?.meta?.retired, undefined);
});

test('Preview says what each template lets a group change, and why the rest is fixed', async () => {
  const admin = await login('admin@test');
  const preview = (await call(admin, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,company-acme,partner')).body.preview;
  const t = preview.templates.find((x: { id: string }) => x.id === published);
  assert.deepEqual(t.canChange, ['Product', 'Price', 'Colourway and mode']);
  assert.deepEqual(t.fixed, ['Background', 'Accent']);
  assert.ok(t.why.includes('Fixed by the template’s rules.'));
  assert.ok(t.why.includes('Accent follows the colourway and mode partners pick.'), 'a fixed colour from the design system still moves with the colourway');
  assert.ok(t.why.some((line: string) => /can also open Price card on its own/.test(line)));
  // The member's own org-config never carries any of this.
  const rita = await login('rita@acme.test');
  const wire = JSON.stringify((await call(rita, 'GET', '/api/v1/org-config')).body);
  assert.ok(!wire.includes('Fixed by the template'));
});

test('a template can keep its colourway and mode, and Preview says so', async () => {
  const admin = await login('admin@test');
  const path = `/api/v1/programmes/resellers/templates/${bare(published)}`;
  assert.equal((await call(admin, 'PUT', path, { fixedTheme: 'yes' })).status, 400);
  const kept = await call(admin, 'PUT', path, { fixedTheme: true });
  assert.equal(kept.status, 200);
  assert.equal(kept.body.fixedTheme, true);
  assert.deepEqual(kept.body.editable, ['price', 'title'], 'the input rules stay as they were');
  assert.equal((await ritaEntry(published))?.meta?.fixedTheme, true);
  assert.equal((await listed()).templates.find((t: { id: string }) => t.id === published).fixedTheme, true);
  const preview = (await call(admin, 'GET', '/api/v1/org-config/preview?groups=programme-resellers,company-acme,partner')).body.preview;
  const t = preview.templates.find((x: { id: string }) => x.id === published);
  assert.deepEqual(t.fixed, ['Background', 'Accent', 'Colourway and mode']);
  assert.ok(t.why.includes('Colourway and mode: fixed by the template’s rules.'));
  assert.equal((await call(admin, 'PUT', path, { fixedTheme: false })).body.fixedTheme, false);
  const fresh = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'], editable: ['price'], fixedTheme: true });
  assert.equal(fresh.status, 201);
  assert.equal((await ritaEntry(fresh.body.id))?.meta?.fixedTheme, true);
});

test('only someone who manages programmes may publish', async () => {
  const bruno = await login('bruno@test');
  assert.equal((await call(bruno, 'GET', '/api/v1/programmes/resellers/templates')).status, 403);
  assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate })).status, 403);
});

test('publishing records the workspace\'s own mark, stated by the publisher, and the card\'s tick leaves it off or takes it away', async () => {
  const admin = await login('admin@test');
  const adminId = (await store.getUserBySub('dev:admin@test'))!.id;
  const marked = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
  assert.equal(marked.status, 201);
  const id = marked.body.id as string;
  assert.equal(marked.body.ownerMark.holder, 'Partner Hub', 'the workspace is the holder');
  assert.match(marked.body.ownerMark.terms, /^Published by Partner Hub .*Not an open licence\.$/);
  const mark = (await store.listAssetRightsMarks()).find((m) => m.scope === `asset:${id}`);
  assert.equal(mark?.statedBy, adminId, 'the publisher stated it');
  const audited = (await store.listAudit()).filter((a) => a.action === 'catalog.rights.mark' && a.subject === `rights-mark:asset:${id}`);
  assert.equal(audited.length, 1);
  assert.equal(audited[0]!.actor, `user:${adminId}`);
  assert.equal((audited[0]!.payload as { via?: string }).via, 'programme-template');
  // The partner's served entry carries the composed owner-published record, never who stated it.
  const entry = await ritaEntry(id) as { rights?: { works?: Array<{ creators?: Array<{ name: string; role: string }>; grants?: Array<{ kind: string }> }> } } | undefined;
  assert.deepEqual(entry?.rights?.works?.[0]?.creators, [{ name: 'Partner Hub', role: 'owner' }]);
  assert.equal(entry?.rights?.works?.[0]?.grants?.[0]?.kind, 'own-work');
  assert.ok(!JSON.stringify(entry).includes(adminId), 'no statedBy on the wire');
  const row = (await listed()).templates.find((t: { id: string }) => t.id === id);
  assert.equal(row.ownerMark.holder, 'Partner Hub');

  // Left off at publish.
  const plain = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'], ownerMark: false });
  assert.equal(plain.status, 201);
  assert.equal(plain.body.ownerMark, null);
  assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${plain.body.id}`));
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, ownerMark: 'yes' })).status, 400);

  // The tick on the card, later: off withdraws it, audited; on records it again.
  const off = await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(id)}`, { ownerMark: false });
  assert.equal(off.status, 200);
  assert.equal(off.body.ownerMark, null);
  assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${id}`));
  assert.equal((await store.listAudit()).filter((a) => a.action === 'catalog.rights.unmark' && a.subject === `rights-mark:asset:${id}`).length, 1);
  const on = await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(plain.body.id)}`, { ownerMark: true });
  assert.equal(on.body.ownerMark.holder, 'Partner Hub');
  assert.equal((await call(admin, 'POST', `/api/v1/programmes/resellers/templates/rules-file?ownerMark=maybe`)).status, 400);
});

test('only staff who may edit the catalog state or withdraw the workspace\'s mark', async () => {
  const admin = await login('admin@test');
  const delegated = { principal: 'group:brand', action: 'programme.manage', resource: '*', effect: 'allow' };
  await store.putGrant(delegated as never);
  try {
    const bruno = await login('bruno@test');
    const quiet = await call(bruno, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
    assert.equal(quiet.status, 201, 'a programme manager still publishes');
    assert.equal(quiet.body.ownerMark, null, 'without catalog.edit, no mark is stated');
    assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${quiet.body.id}`));
    assert.equal((await call(bruno, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, ownerMark: true })).status, 403);
    const marked = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
    assert.equal((await call(bruno, 'PUT', `/api/v1/programmes/resellers/templates/${bare(marked.body.id)}`, { ownerMark: false })).status, 403);
    assert.equal((await call(bruno, 'PUT', `/api/v1/programmes/resellers/templates/${bare(quiet.body.id)}`, { ownerMark: true })).status, 403);
    assert.ok((await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${marked.body.id}`), 'the admin\'s mark stays');
  } finally { await store.deleteGrant(delegated as never); }
});

test('a template from a file that records a licence is not stated as the workspace\'s own', async () => {
  const admin = await login('admin@test');
  const licensed = await submitTemplate(admin, 'Photo price sheet', 'With a CC BY photo');
  assert.equal((await call(admin, 'PUT', '/api/v1/catalog/rights/licences', { assetId: licensed, declaration: 'CC-BY-4.0', attribution: 'Photo by Someone' })).status < 300, true);
  const fromLicensed = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: licensed, groups: ['programme-resellers'] });
  assert.equal(fromLicensed.status, 201);
  assert.equal(fromLicensed.body.ownerMark, null, 'the file it came from records a licence');
  assert.equal((await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(fromLicensed.body.id)}`, { ownerMark: true })).status, 409, 'nor can the tick state it');
});

test('a new version from a file that records a licence withdraws the mark, audited', async () => {
  const admin = await login('admin@test');
  const licensed = await submitTemplate(admin, 'Second photo sheet', 'Another CC BY photo');
  assert.ok((await call(admin, 'PUT', '/api/v1/catalog/rights/licences', { assetId: licensed, declaration: 'CC-BY-4.0', attribution: 'Photo by Someone' })).status < 300);
  const own = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
  assert.ok(own.body.ownerMark, 'from the workspace\'s own template: marked');
  const version = await call(admin, 'POST', `/api/v1/programmes/resellers/templates/${bare(own.body.id)}/versions`, { from: licensed });
  assert.equal(version.status, 201, JSON.stringify(version.body));
  assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${own.body.id}`), 'the new head is not the workspace\'s own: the mark is withdrawn');
  const unmark = (await store.listAudit()).filter((a) => a.action === 'catalog.rights.unmark' && a.subject === `rights-mark:asset:${own.body.id}`);
  assert.equal((unmark.at(-1)?.payload as { why?: string } | undefined)?.why, 'not-own');
});

test('stating the mark never overwrites a statement already there, even read stale', async () => {
  const admin = await login('admin@test');
  const plain = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'], ownerMark: false });
  const scope = `asset:${plain.body.id}`;
  assert.ok((await call(admin, 'PUT', '/api/v1/catalog/rights/marks', { scope, holder: 'Acme legal', terms: 'Custom terms for this sheet.' })).status < 300);
  const before = (await store.listAudit()).filter((a) => a.action === 'catalog.rights.mark' && a.subject === `rights-mark:${scope}`).length;
  // A read taken before the other statement was saved: the write itself must not overwrite.
  const list = store.listAssetRightsMarks.bind(store);
  store.listAssetRightsMarks = async () => [];
  try {
    assert.equal((await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(plain.body.id)}`, { ownerMark: true })).status, 200);
  } finally { store.listAssetRightsMarks = list; }
  const mark = (await store.listAssetRightsMarks()).find((m) => m.scope === scope);
  assert.equal(mark?.terms, 'Custom terms for this sheet.', 'the custom statement stands');
  assert.equal(mark?.holder, 'Acme legal');
  assert.equal((await store.listAudit()).filter((a) => a.action === 'catalog.rights.mark' && a.subject === `rights-mark:${scope}`).length, before, 'nothing recorded, nothing audited');
});

test('a marked template\'s head changes only for staff who may withdraw the mark', async () => {
  const admin = await login('admin@test');
  const licensed = await submitTemplate(admin, 'Third photo sheet', 'Yet another CC BY photo');
  assert.ok((await call(admin, 'PUT', '/api/v1/catalog/rights/licences', { assetId: licensed, declaration: 'CC-BY-4.0', attribution: 'Photo by Someone' })).status < 300);
  const marked = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
  assert.ok(marked.body.ownerMark);
  const delegated = { principal: 'group:brand', action: 'programme.manage', resource: '*', effect: 'allow' };
  await store.putGrant(delegated as never);
  try {
    const bruno = await login('bruno@test');
    const refused = await call(bruno, 'POST', `/api/v1/programmes/resellers/templates/${bare(marked.body.id)}/versions`, { from: licensed });
    assert.equal(refused.status, 403, 'a programme manager without catalog.edit cannot move a marked head');
    assert.ok((await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${marked.body.id}`), 'the staff mark stands');
  } finally { await store.deleteGrant(delegated as never); }
});

test('every head change answers to the mark: a new version through the catalog, after a licence is recorded, withdraws it', async () => {
  const admin = await login('admin@test');
  const marked = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
  const id = marked.body.id as string;
  assert.ok(marked.body.ownerMark);
  assert.ok((await call(admin, 'PUT', '/api/v1/catalog/rights/licences', { assetId: id, declaration: 'CC-BY-4.0', attribution: 'Photo by Someone' })).status < 300);
  const res = await fetch(`${base}/api/v1/catalog/submit?assetId=${encodeURIComponent(id)}`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ toolId: 'price-card', name: 'Partner price sheet', values: { title: 'SLES 16 SP1', price: '€ 1,300', bg: '#0c322c' } }),
  });
  assert.ok(res.status === 200 || res.status === 201, await res.text());
  assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${id}`), 'the shared commit path withdrew it');
  const unmark = (await store.listAudit()).filter((a) => a.action === 'catalog.rights.unmark' && a.subject === `rights-mark:asset:${id}`);
  assert.equal((unmark.at(-1)?.payload as { why?: string } | undefined)?.why, 'not-own');
});

test('a head that moves while the mark is being stated is checked again before the mark stands', async () => {
  const admin = await login('admin@test');
  const licensed = await submitTemplate(admin, 'Fifth photo sheet', 'Licensed, racing');
  assert.ok((await call(admin, 'PUT', '/api/v1/catalog/rights/licences', { assetId: licensed, declaration: 'CC-BY-4.0', attribution: 'Photo by Someone' })).status < 300);
  const plain = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'], ownerMark: false });
  const id = plain.body.id as string;
  // Between the check and the insert, a new version from the licensed file becomes the head.
  const add = store.addAssetRightsMark.bind(store);
  store.addAssetRightsMark = async (rec) => {
    store.addAssetRightsMark = add;
    const head = (await store.getInstanceAsset(id))!;
    const v1 = (await store.listAssetVersions(id))[0] ?? { assetId: id, version: 1, formats: [], by: `user:x`, at: 'x' };
    await store.putAssetVersion(v1 as never);
    await store.putAssetVersion({ ...v1, version: 2, from: licensed, by: v1.by } as never);
    await store.putInstanceAsset({ ...head, headVersion: 2 });
    return add(rec);
  };
  try {
    await call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(id)}`, { ownerMark: true });
  } finally { store.addAssetRightsMark = add; }
  assert.ok(!(await store.listAssetRightsMarks()).some((m) => m.scope === `asset:${id}`), 'the head moved to a licensed file: no mark stands');
});

test('a source whose author can no longer be found is not the workspace\'s own', async () => {
  const admin = await login('admin@test');
  const source = (await store.getInstanceAsset(catalogTemplate))!;
  const ghost = { ...source, id: 'inst/ghost-source', submission: { ...source.submission!, by: 'user:no-longer-here' } };
  delete (ghost.submission as { byScoped?: boolean }).byScoped;
  await store.putInstanceAsset(ghost);
  const published = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: 'inst/ghost-source', groups: ['programme-resellers'] });
  assert.equal(published.status, 201);
  assert.equal(published.body.ownerMark, null);
});

test('two unticks at once withdraw the mark once, audited once', async () => {
  const admin = await login('admin@test');
  const marked = await call(admin, 'POST', '/api/v1/programmes/resellers/templates', { from: catalogTemplate, groups: ['programme-resellers'] });
  const scope = `asset:${marked.body.id}`;
  // Both requests read the mark before either removes it.
  const list = store.listAssetRightsMarks.bind(store);
  store.listAssetRightsMarks = async () => { const rows = await list(); await new Promise((r) => setTimeout(r, 30)); return rows; };
  try {
    await Promise.all([1, 2].map(() => call(admin, 'PUT', `/api/v1/programmes/resellers/templates/${bare(marked.body.id)}`, { ownerMark: false })));
  } finally { store.listAssetRightsMarks = list; }
  assert.equal((await store.listAudit()).filter((a) => a.action === 'catalog.rights.unmark' && a.subject === `rights-mark:${scope}`).length, 1);
});
