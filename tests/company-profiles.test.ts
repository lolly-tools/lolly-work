// SPDX-License-Identifier: MPL-2.0
/**
 * Partner company profiles over real HTTP (plans/82 M3, W-M3-1). The brand
 * team sets a company up once: details, a logo for light surfaces, one for
 * dark surfaces and a mark. Each change is a revision the history keeps. Logos
 * are instance assets only that company sees, replaced in place as versions.
 * A company can name contacts who may edit, and an approval chain their
 * changes wait for; both are off by default.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { LIMITS, MAX_EDITORS, readProfileBody } from '../server/src/programmes/profile.ts';
import { LOGO_TYPES, PNG_MAX_BYTES, PNG_MIN_LONG_SIDE, SVG_MAX_BYTES } from '../server/src/programmes/logo-checks.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let blobs: ReturnType<typeof createMemoryBlobStore>;

const svg = (fill: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 240 80"><path d="M10 70 L40 10 L70 70 Z" fill="${fill}"/><text x="90" y="52" fill="${fill}">Northwind IT</text></svg>`);
const fixture = (name: string): Buffer => readFileSync(join(import.meta.dirname, 'fixtures', 'company-logos', name));

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-company-profiles-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Profile Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    // A submit chain gates ordinary contributions; a brand team's company logo never waits for it.
    policy: { submit: { chain: 'catalog-review' } },
    dev: { enabled: true, users: [
      { email: 'bruno@brand.test', groups: ['admin'] },
      { email: 'owner@brand.test', groups: ['owner'] },
      { email: 'staff@brand.test', groups: ['marketing'] },
      { email: 'reviewer@brand.test', groups: ['approver', 'review'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'nils@northwind.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  blobs = createMemoryBlobStore();
  await store.putChain({ id: 'catalog-review', name: 'Catalog review', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putChain({ id: 'partner-details', name: 'Partner details', steps: [{ name: 'Brand', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const app = buildApp({ config, store, blobs, secrets: { session: 'scp', link: 'lcp' } });
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
const call = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
};
const upload = async (cookie: string, path: string, bytes: Buffer, type = 'image/svg+xml') => {
  const res = await fetch(`${base}${path}`, { method: 'POST', headers: { cookie, 'content-type': type }, body: new Uint8Array(bytes) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
};
const feed = async (cookie: string) => ((await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } })).json()) as { assets: Array<{ id: string }> }).assets.map((a) => a.id);
const auditOf = async (action: string) => (await store.listAudit()).filter((e) => e.action === action) as Array<{ actor: string; payload?: Record<string, any> }>;

const P = '/api/v1/programmes/resellers-emea/companies/northwind-it/profile';
let ready = false;
async function setUp(): Promise<string> {
  const bruno = await login('bruno@brand.test');
  if (ready) return bruno;
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea', { name: 'Resellers, EMEA' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/northwind-it', { name: 'Northwind IT' })).status, 201);
  assert.equal((await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/globex', { name: 'Globex' })).status, 201);
  for (const email of ['rita@northwind.test', 'nils@northwind.test', 'gus@globex.test']) await login(email);
  const added = await call(bruno, 'POST', '/api/v1/programmes/resellers-emea/people', {
    rows: [{ email: 'rita@northwind.test', company: 'northwind-it' }, { email: 'nils@northwind.test', company: 'northwind-it' }, { email: 'gus@globex.test', company: 'globex' }], apply: true,
  });
  assert.equal(added.status, 200);
  ready = true;
  return bruno;
}

test('the details read: limits, clearing and what a contact may not set', () => {
  assert.deepEqual(readProfileBody({ website: 'northwind.example', currency: 'eur', taxNote: ' Prices exclude VAT ', address: 'Unter den Linden 1\r\n10117 Berlin' }, { allowName: true }),
    { website: 'https://northwind.example/', currency: 'EUR', taxNote: 'Prices exclude VAT', address: 'Unter den Linden 1\n10117 Berlin' });
  assert.deepEqual(readProfileBody({ website: null, contact: {} }, { allowName: true }), { website: null, contact: null });
  for (const bad of [{ currency: 'EURO' }, { currency: 'XYZ' }, { website: 'ftp://x.example' }, { contact: { email: 'not-mail' } }, { contact: { phone: 'call me' } },
    { address: 'a\nb\nc\nd\ne\nf\ng' }, { taxNote: 'x'.repeat(201) }, { name: '' }, { website: 'https://user:pw@x.example' }]) {
    assert.ok('error' in readProfileBody(bad, { allowName: true }), JSON.stringify(bad));
  }
  assert.ok('error' in readProfileBody({ name: 'Other' }, { allowName: false }), 'a contact cannot rename the company');
  assert.deepEqual(readProfileBody({ logoLight: 'inst/elsewhere', website: 'https://n.example' }, { allowName: true }), { website: 'https://n.example/' }, 'logos change only through the logo route');
});

test('the brand team fills the details in once, and each change is a revision the history keeps', async () => {
  const bruno = await setUp();
  const empty = await call(bruno, 'GET', P);
  assert.equal(empty.status, 200);
  assert.equal(empty.body.revision, 0);
  assert.deepEqual(empty.body.profile, {});
  assert.deepEqual(empty.body.settings, { editors: [], approvalChain: null }, 'contacts and approval are off by default');
  assert.deepEqual(empty.body.surfaces, { light: '#ffffff', dark: '#000000', source: 'default' });

  const saved = await call(bruno, 'PUT', P, {
    website: 'https://northwind.example', contact: { name: 'Rita Ortiz', email: 'Rita@Northwind.test', phone: '+49 30 1234 567' },
    address: 'Unter den Linden 1\n10117 Berlin', currency: 'EUR', taxNote: 'Prices exclude VAT',
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.revision, 1);
  assert.deepEqual(saved.body.profile, { website: 'https://northwind.example/', contact: { name: 'Rita Ortiz', email: 'rita@northwind.test', phone: '+49 30 1234 567' },
    address: 'Unter den Linden 1\n10117 Berlin', currency: 'EUR', taxNote: 'Prices exclude VAT' });
  assert.equal((await call(bruno, 'PUT', P, { currency: 'EUR' })).body.revision, 1, 'a save that changes nothing keeps the revision');
  assert.equal((await call(bruno, 'PUT', P, { currency: 'EURO' })).status, 400);
  assert.equal((await call(bruno, 'PUT', P, { taxNote: 'Prices include VAT', revision: 0 })).status, 409, 'a stale revision is refused');
  const edited = await call(bruno, 'PUT', P, { taxNote: 'Prices include VAT', revision: 1 });
  assert.equal(edited.body.revision, 2);

  const edit = (await auditOf('programme.company.profile.edit')).at(-1)!;
  assert.deepEqual(edit.payload, { revision: 2, fields: ['taxNote'], before: { taxNote: 'Prices exclude VAT' }, after: { taxNote: 'Prices include VAT' } });
  const history = await call(bruno, 'GET', `${P}/history`);
  assert.deepEqual(history.body.revisions.map((r: { revision: number }) => r.revision), [2, 1]);
  const first = await call(bruno, 'GET', `${P}?revision=1`);
  assert.equal(first.body.profile.taxNote, 'Prices exclude VAT', 'a revision a file cites reads back');
  assert.equal(first.body.company.name, 'Northwind IT');

  const rita = await login('rita@northwind.test');
  assert.equal((await call(rita, 'PUT', P, { taxNote: 'x' })).status, 403, 'a partner cannot use the brand team\'s routes');
});

test('renaming the company from its profile renames the company and its group', async () => {
  const bruno = await setUp();
  const renamed = await call(bruno, 'PUT', P, { name: 'Northwind IT GmbH' });
  assert.equal(renamed.body.company.name, 'Northwind IT GmbH');
  assert.ok((await store.listLocalGroups()).some((g) => g.name === 'company-northwind-it' && /Northwind IT GmbH/.test(g.description ?? '')));
  await call(bruno, 'PUT', P, { name: 'Northwind IT' });
});

test('a logo is checked, stored for that company only and named in the profile; a replaced logo is the next version', async () => {
  const bruno = await setUp();
  const dry = await upload(bruno, `${P}/logo?surface=light&dryRun=1`, svg('#0b3d91'));
  assert.equal(dry.status, 200);
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(dry.body.warnings, []);
  assert.equal((await call(bruno, 'GET', P)).body.profile.logoLight, undefined, 'a dry run stores nothing');

  const before = (await call(bruno, 'GET', P)).body.revision as number;
  const stored = await upload(bruno, `${P}/logo?surface=light`, svg('#0b3d91'));
  assert.equal(stored.status, 200, JSON.stringify(stored.body));
  const id = stored.body.asset.id as string;
  assert.match(id, /^inst\//);
  assert.equal(stored.body.asset.version, 1);
  assert.equal(stored.body.profile.revision, before + 1);
  assert.equal(stored.body.profile.profile.logoLight, id);
  assert.equal(stored.body.profile.logos.light.format, 'svg');
  const rec = await store.getInstanceAsset(id);
  assert.deepEqual(rec?.groups, ['company-northwind-it']);
  assert.equal(rec?.submission?.state, 'live', 'the submit chain does not hold a brand team\'s logo');
  assert.equal(rec?.entry.type, 'vector');
  assert.deepEqual(rec?.entry.tags, ['logo', 'partner', 'on-light']);
  assert.deepEqual(rec?.entry.meta, { company: 'northwind-it', surface: 'light' });

  const rita = await login('rita@northwind.test');
  const gus = await login('gus@globex.test');
  const staff = await login('staff@brand.test');
  assert.ok((await feed(rita)).includes(id), 'Northwind\'s people get their logo');
  assert.ok(!(await feed(gus)).includes(id), 'another company never does');
  assert.ok(!(await feed(staff)).includes(id), 'nor do internal people');

  const replaced = await upload(bruno, `${P}/logo?surface=light`, svg('#123f8f'));
  assert.equal(replaced.body.asset.id, id, 'the same asset');
  assert.equal(replaced.body.asset.version, 2, 'its next version');
  assert.equal(replaced.body.profile.revision, before + 2);
  const read = await call(bruno, 'GET', `${P}?revision=${before + 2}`);
  assert.deepEqual(read.body.profile.logoVersions, { light: 2 }, 'a revision names the exact logo version');
  const again = await upload(bruno, `${P}/logo?surface=light`, svg('#123f8f'));
  assert.equal(again.body.profile.revision, before + 2, 'the same bytes again change nothing');

  const logo = (await auditOf('programme.company.logo')).at(-2)!;
  assert.equal(logo.payload?.surface, 'light');
  assert.equal(logo.payload?.asset, id);
  assert.equal(logo.payload?.version, 2);
  assert.ok(!JSON.stringify(logo.payload).includes('<svg'), 'never the bytes');

  const bytes = await fetch(`${base}${P}/logo?surface=light`, { headers: { cookie: bruno } });
  assert.equal(bytes.status, 200);
  assert.equal(bytes.headers.get('content-type'), 'image/svg+xml');
  assert.match(bytes.headers.get('content-security-policy') ?? '', /sandbox/);
  assert.match(await bytes.text(), /#123f8f/);
});

test('a refused logo stores nothing and says why; a warning is returned as data', async () => {
  const bruno = await setUp();
  const count = (await store.listInstanceAssets()).length;
  const script = await upload(bruno, `${P}/logo?surface=dark`, fixture('script.svg'));
  assert.equal(script.status, 422);
  assert.equal(script.body.error.code, 'LOGO_ACTIVE_CONTENT');
  const jpeg = await upload(bruno, `${P}/logo?surface=dark`, Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16]), 'image/jpeg');
  assert.equal(jpeg.status, 415);
  assert.equal((await store.listInstanceAssets()).length, count);

  // A dark-ink logo for dark surfaces warns, with both surfaces to draw the previews on.
  const dark = await upload(bruno, `${P}/logo?surface=dark`, svg('#0b3d91'));
  assert.equal(dark.status, 200);
  assert.deepEqual(dark.body.warnings.map((w: { code: string; surface: string }) => [w.code, w.surface]), [['low-contrast', 'dark']]);
  assert.deepEqual(dark.body.surfaces, { light: '#ffffff', dark: '#000000', source: 'default' });
  assert.deepEqual((await auditOf('programme.company.logo')).at(-1)!.payload?.warnings, ['low-contrast']);
  const png = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 0 } } })
    .composite([{ input: await sharp({ create: { width: 200, height: 200, channels: 4, background: '#e3001b' } }).png().toBuffer(), left: 100, top: 100 }]).png().toBuffer();
  const mark = await upload(bruno, `${P}/logo?surface=mark`, png, 'image/png');
  assert.equal(mark.status, 200, JSON.stringify(mark.body));
  assert.equal((await store.getInstanceAsset(mark.body.asset.id))?.entry.type, 'raster');
});

test('removing a logo takes it off the profile and stops it being served', async () => {
  const bruno = await setUp();
  const id = (await call(bruno, 'GET', P)).body.profile.mark as string;
  assert.ok(id);
  const removed = await call(bruno, 'DELETE', `${P}/logo?surface=mark`);
  assert.equal(removed.status, 200);
  assert.equal(removed.body.profile.mark, undefined);
  assert.ok((await store.getLifecycle(id))?.revokedAt);
  assert.ok(!(await feed(await login('rita@northwind.test'))).includes(id));
  assert.equal((await call(bruno, 'DELETE', `${P}/logo?surface=mark`)).status, 404);
});

test('a partner reads their own company\'s details, and edits only once named a contact', async () => {
  const bruno = await setUp();
  const rita = await login('rita@northwind.test');
  const own = await call(rita, 'GET', '/api/v1/me/company/profile');
  assert.equal(own.status, 200);
  assert.equal(own.body.company.id, 'northwind-it');
  assert.equal(own.body.mayEdit, false);
  assert.equal(own.body.settings, undefined, 'who edits is the brand team\'s business');
  assert.equal(own.body.updatedBy, undefined);
  assert.equal((await call(rita, 'PUT', '/api/v1/me/company/profile', { taxNote: 'Hello' })).status, 403);
  assert.equal((await call(await login('staff@brand.test'), 'GET', '/api/v1/me/company/profile')).status, 404);

  assert.equal((await call(bruno, 'PUT', `${P}/settings`, { editors: ['gus@globex.test'] })).status, 400, 'a contact is a person in the company');
  const on = await call(bruno, 'PUT', `${P}/settings`, { editors: ['rita@northwind.test'] });
  assert.equal(on.status, 200);
  assert.deepEqual(on.body.settings.editors.map((e: { email: string }) => e.email), ['rita@northwind.test']);
  const revision = on.body.revision as number;
  assert.equal((await call(bruno, 'GET', P)).body.revision, revision, 'settings are never a revision');

  const edited = await call(rita, 'PUT', '/api/v1/me/company/profile', { taxNote: 'Prices exclude VAT', contact: { name: 'Rita Ortiz', email: 'rita@northwind.test' } });
  assert.equal(edited.status, 200, 'a contact\'s change applies at once');
  assert.equal(edited.body.revision, revision + 1);
  assert.equal(edited.body.mayEdit, true);
  assert.equal((await call(rita, 'PUT', '/api/v1/me/company/profile', { name: 'Rita Inc' })).status, 400);
  assert.equal((await auditOf('programme.company.profile.edit')).at(-1)!.payload?.via, 'contact');
  const logo = await upload(rita, '/api/v1/me/company/profile/logo?surface=dark', svg('#f5f5f5'));
  assert.equal(logo.status, 200);
  assert.equal((await call(await login('nils@northwind.test'), 'PUT', '/api/v1/me/company/profile', { taxNote: 'x' })).status, 403, 'only the named contacts');
});

test('with the approval switch on, a contact\'s change waits for the chain and applies on approval', async () => {
  const bruno = await setUp();
  const rita = await login('rita@northwind.test');
  const reviewer = await login('reviewer@brand.test');
  assert.equal((await call(bruno, 'PUT', `${P}/settings`, { approvalChain: 'no-such-chain' })).status, 409);
  assert.equal((await call(bruno, 'PUT', `${P}/settings`, { editors: ['rita@northwind.test'], approvalChain: 'partner-details' })).status, 200);
  const before = (await call(bruno, 'GET', P)).body.revision as number;

  const asked = await call(rita, 'PUT', '/api/v1/me/company/profile', { taxNote: 'Prices exclude VAT and shipping' });
  assert.equal(asked.status, 202);
  assert.equal(asked.body.state, 'pending');
  assert.equal((await call(bruno, 'GET', P)).body.revision, before, 'nothing changes yet');
  assert.equal((await call(bruno, 'GET', P)).body.pending.approvalId, asked.body.approvalId);
  assert.equal((await call(rita, 'PUT', '/api/v1/me/company/profile', { taxNote: 'again' })).status, 409, 'one waiting change at a time');
  // A manager's own change never waits, and survives the contact's approval.
  assert.equal((await call(bruno, 'PUT', P, { currency: 'GBP' })).body.revision, before + 1);
  const approved = await call(reviewer, 'POST', `/api/v1/approvals/${asked.body.approvalId}/act`, { action: 'approve' });
  assert.equal(approved.status, 200, JSON.stringify(approved.body));
  const after = (await call(bruno, 'GET', P)).body;
  assert.equal(after.revision, before + 2);
  assert.equal(after.profile.taxNote, 'Prices exclude VAT and shipping');
  assert.equal(after.profile.currency, 'GBP');
  assert.equal(after.pending, undefined);

  const logo = await upload(rita, '/api/v1/me/company/profile/logo?surface=light', svg('#222222'));
  assert.equal(logo.status, 202);
  const held = (await store.getApproval(logo.body.approvalId))?.companyProfile?.logo?.blobId;
  assert.ok(held && await blobs.get(held), 'the checked bytes wait in the blob store');
  const rejected = await call(reviewer, 'POST', `/api/v1/approvals/${logo.body.approvalId}/act`, { action: 'reject', comment: 'Use the blue one' });
  assert.equal(rejected.status, 200);
  assert.equal(await blobs.get(held!), null, 'a refused logo\'s bytes go');
  assert.equal((await call(bruno, 'GET', P)).body.revision, before + 2, 'nothing changed');
  await call(bruno, 'PUT', `${P}/settings`, { approvalChain: null });
});

test('deleting a company deletes its profile and history and stops its logos', async () => {
  const bruno = await setUp();
  const assets = Object.values((await call(bruno, 'GET', '/api/v1/programmes/resellers-emea/companies/globex/profile')).body.logos ?? {});
  assert.deepEqual(assets, []);
  await call(bruno, 'PUT', '/api/v1/programmes/resellers-emea/companies/globex/profile', { website: 'https://globex.example' });
  const logo = await upload(bruno, '/api/v1/programmes/resellers-emea/companies/globex/profile/logo?surface=light', svg('#222222'));
  assert.equal(logo.status, 200);
  assert.equal((await call(bruno, 'DELETE', '/api/v1/programmes/resellers-emea/companies/globex')).status, 200);
  assert.equal(await store.getCompanyProfile('globex'), null);
  assert.deepEqual(await store.listCompanyProfileHistory('globex'), []);
  assert.ok((await store.getLifecycle(logo.body.asset.id))?.revokedAt);
});

test('lw companies profile shows, sets, checks and stores a logo, and lists the history', async () => {
  await setUp();
  const owner = await login('owner@brand.test');
  const minted = await call(owner, 'POST', '/api/v1/tokens', { label: 'brand team cli', role: 'admin' });
  assert.equal(minted.status, 201);
  const home = await mkdtemp(join(tmpdir(), 'lw-company-cli-'));
  const lw = (...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/lw.ts', import.meta.url)), ...args, '--base', base, '--token', minted.body.token], { stdio: 'pipe', env: { ...process.env, HOME: home } });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (exit) => resolve({ code: exit, out, err }));
  });
  const set = await lw('companies', 'profile', 'set', 'resellers-emea', 'northwind-it', '--field', 'website=https://northwind.example/cli', '--field', 'contact.phone=+49 30 9999');
  assert.equal(set.code, 0, set.err);
  assert.match(set.out, /website {5}https:\/\/northwind\.example\/cli/);
  assert.match(set.out, /\+49 30 9999/);
  const file = join(home, 'logo.svg');
  await writeFile(file, svg('#0b3d91'));
  const dry = await lw('companies', 'profile', 'logo', 'resellers-emea', 'northwind-it', 'dark', file, '--dry-run');
  assert.equal(dry.code, 0, dry.err);
  assert.match(dry.out, /warning: #0b3d91 in this logo has a contrast of/);
  assert.match(dry.out, /it would be accepted with the warnings above/);
  const bad = join(home, 'bad.svg');
  await writeFile(bad, fixture('script.svg'));
  const refusedLogo = await lw('companies', 'profile', 'logo', 'resellers-emea', 'northwind-it', 'dark', bad);
  assert.equal(refusedLogo.code, 1);
  assert.match(refusedLogo.err, /LOGO_ACTIVE_CONTENT/);
  const stored = await lw('companies', 'profile', 'logo', 'resellers-emea', 'northwind-it', 'mark', file);
  assert.equal(stored.code, 0, stored.err);
  assert.match(stored.out, /stored as inst\/\S+ v1; revision \d+/);
  const shown = await lw('companies', 'profile', 'show', 'resellers-emea', 'northwind-it');
  assert.match(shown.out, /logo mark +inst\//);
  const history = await lw('companies', 'profile', 'history', 'resellers-emea', 'northwind-it');
  assert.equal(history.code, 0, history.err);
  assert.match(history.out, /mark/);
});

test('the profile view shows an admin the limits the server enforces, from the same constants', async () => {
  const bruno = await setUp();
  const view = (await call(bruno, 'GET', P)).body;
  assert.deepEqual(view.limits.logo.types, [...LOGO_TYPES]);
  assert.equal(view.limits.logo.svgMaxBytes, SVG_MAX_BYTES);
  assert.equal(view.limits.logo.pngMaxBytes, PNG_MAX_BYTES);
  assert.equal(view.limits.logo.pngMinLongSide, PNG_MIN_LONG_SIDE);
  assert.deepEqual(view.limits.fields, { ...LIMITS });
  assert.equal(view.limits.editors, MAX_EDITORS);
  assert.equal(view.limits.history, 'all', 'every revision is kept');
  assert.ok((await call(await login('rita@northwind.test'), 'GET', '/api/v1/me/company/profile')).body.limits, 'a contact sees the same limits');
});
