/**
 * People in partner programmes (plans/82 M1 part 2): companies, adding many
 * people from a list with a preview, end dates and ending a partnership.
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
import { parsePeopleList } from '../server/src/programmes/people.ts';
import { sweepProgrammeEnds } from '../server/src/programmes/people-routes.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programme-people-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'banner.png'), 'png');
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1,
    assets: [{ id: 'acme/banner', name: 'Banner', type: 'raster', formats: [{ format: 'png', url: '/catalog/assets/acme/banner.png' }] }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'People Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@acme.test', groups: ['marketing'] },
      { email: 'rita@reseller.test', groups: [] },
      { email: 'sam@reseller.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  await store.putCollection({ id: 'kit', name: 'Kit', members: ['acme/banner'], groups: '*', curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, secrets: { session: 'spp', link: 'lpp' } });
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
const json = async (cookie: string, method: string, path: string, body?: unknown) => {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
};

test('a pasted list or CSV reads email, name, company and end date, and skips a header', () => {
  assert.deepEqual(parsePeopleList('email,name,company,ends\nAna@X.test, Ana, Acme, 2027-01-31\n\nbo@x.test'), [
    { line: 2, email: 'ana@x.test', name: 'Ana', company: 'Acme', endsAt: '2027-01-31' },
    { line: 4, email: 'bo@x.test' },
  ]);
});

test('companies wrap a reserved group, and the plain groups route cannot make one', async () => {
  const admin = await login('admin@test');
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: ['price-sheet'], collections: ['kit'] })).status, 201);
  const made = await json(admin, 'PUT', '/api/v1/programmes/resellers/companies/acme-reseller', { name: 'Acme Reseller' });
  assert.equal(made.status, 201);
  assert.ok((await store.listLocalGroups()).some((g) => g.name === 'company-acme-reseller' && /Acme Reseller/.test(g.description ?? '')));
  assert.equal((await json(admin, 'POST', '/api/v1/groups', { name: 'company-sneaky' })).status, 400);
});

test('adding people from a list previews first, applies with a result per row, and changes nothing the second time', async () => {
  const admin = await login('admin@test');
  await login('rita@reseller.test');
  const text = 'email,name,company,ends\nrita@reseller.test,Rita,Acme Reseller\nnew.person@reseller.test,New Person,acme-reseller,2030-06-30\nnot-an-address\nrita@reseller.test\nadmin@test';
  const preview = await json(admin, 'POST', '/api/v1/programmes/resellers/people', { text });
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.deepEqual(preview.body.rows.map((r: { status: string }) => r.status), ['existing', 'new', 'invalid', 'duplicate', 'existing']);
  assert.ok(!(await store.getUserBySub('dev:rita@reseller.test'))!.groups.includes('programme-resellers'), 'a preview changes nothing');

  const applied = await json(admin, 'POST', '/api/v1/programmes/resellers/people', { text, apply: true });
  assert.deepEqual(applied.body.rows.map((r: { result: string }) => r.result), ['added', 'invited', 'skipped', 'skipped', 'refused']);
  const rita = (await store.getUserBySub('dev:rita@reseller.test'))!;
  assert.deepEqual(rita.localGroups.sort(), ['company-acme-reseller', 'partner', 'programme-resellers']);
  const invitation = (await store.listInvitations()).find((i) => i.email === 'new.person@reseller.test')!;
  assert.deepEqual(invitation.groups.sort(), ['company-acme-reseller', 'programme-resellers']);
  assert.ok(invitation.expiresAt && Date.parse(invitation.expiresAt) <= Date.parse('2030-06-30T23:59:59.999Z'));

  const again = await json(admin, 'POST', '/api/v1/programmes/resellers/people', { text, apply: true });
  assert.deepEqual(again.body.rows.map((r: { result: string }) => r.result), ['unchanged', 'unchanged', 'skipped', 'skipped', 'refused'], 'running the same list twice changes nothing');

  const people = await json(admin, 'GET', '/api/v1/programmes/resellers/people');
  assert.deepEqual(people.body.people.map((p: { email: string; company?: { name: string } }) => [p.email, p.company?.name]), [['rita@reseller.test', 'Acme Reseller']]);
  assert.deepEqual(people.body.invited.map((p: { email: string; endsAt?: string }) => [p.email, !!p.endsAt]), [['new.person@reseller.test', true]]);
});

test('an end date ends access without anyone acting, and the partner keeps only the essentials', async () => {
  const admin = await login('admin@test');
  await login('sam@reseller.test');
  const added = await json(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'sam@reseller.test', endsAt: '2031-01-15' }], apply: true });
  assert.equal(added.body.rows[0].result, 'added');
  const sam = await login('sam@reseller.test');
  const feed = async () => ((await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: sam } })).json()) as { assets: Array<{ id: string }> }).assets.map((a) => a.id);
  assert.deepEqual(await feed(), ['acme/banner']);
  assert.equal(await sweepProgrammeEnds(store, async () => undefined, Date.parse('2029-01-01T00:00:00Z')), 0, 'not yet');
  // Both end dates have passed by now: Sam's, and the invited address's from the list.
  assert.equal(await sweepProgrammeEnds(store, async (actor, action) => { assert.equal(action, 'programme.member.end'); }, Date.parse('2031-01-16T00:00:00Z')), 2);
  assert.ok((await store.listInvitations()).find((i) => i.email === 'new.person@reseller.test')!.revokedAt, 'an invitation the membership made ends with it');
  assert.deepEqual((await store.getUserBySub('dev:sam@reseller.test'))!.localGroups, ['partner']);
  assert.deepEqual(await feed(), [], 'only the essentials now, and this pack has none');
  assert.equal(await sweepProgrammeEnds(store, async () => undefined, Date.parse('2031-01-17T00:00:00Z')), 0, 'the sweep is idempotent');
});

test('ending a partnership previews who and what, leaves internal accounts alone, then disables, revokes and transfers in one step', async () => {
  const admin = await login('admin@test');
  const rita = await login('rita@reseller.test');
  const ritaId = (await store.getUserBySub('dev:rita@reseller.test'))!.id;
  await store.putProject({ id: 'p-rita', name: 'Rita price sheets', ownerId: ritaId, visibility: 'private', createdAt: 'x', updatedAt: 'x' } as never);
  const minted = await json(rita, 'POST', '/api/v1/links', { kind: 'download', target: { assetId: 'acme/banner' } });
  assert.equal(minted.status, 201);
  const linkPath = String(minted.body.url).replace('http://localhost', base);
  assert.equal((await fetch(linkPath)).status, 200);
  // An internal account sneaks into the selection.
  await login('staff@acme.test');
  await json(admin, 'PUT', `/api/v1/users/${(await store.getUserBySub('dev:staff@acme.test'))!.id}/local-groups`, { groups: [] });
  await json(admin, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'late@reseller.test' }], apply: true });
  const emails = ['rita@reseller.test', 'staff@acme.test', 'late@reseller.test'];
  const dry = await json(admin, 'POST', '/api/v1/programmes/exit', { emails });
  assert.equal(dry.body.dryRun, true);
  assert.deepEqual(dry.body.accounts.map((a: { email: string }) => a.email), ['rita@reseller.test']);
  assert.deepEqual(dry.body.accounts[0].projects.map((p: { id: string }) => p.id), ['p-rita']);
  assert.equal(dry.body.accounts[0].links, 1);
  assert.deepEqual(dry.body.skipped.map((s: { email: string; reason: string }) => [s.email, s.reason]), [['staff@acme.test', 'not a partner account']]);
  assert.deepEqual(dry.body.pendingInvitations.map((i: { email: string }) => i.email), ['late@reseller.test']);
  assert.equal((await fetch(linkPath)).status, 200, 'a dry run changes nothing');

  const done = await json(admin, 'POST', '/api/v1/programmes/exit', { emails, apply: true });
  assert.equal(done.status, 200);
  assert.ok((await store.getUserBySub('dev:rita@reseller.test'))!.disabledAt);
  assert.equal((await store.getUserBySub('dev:staff@acme.test'))!.disabledAt, undefined, 'an internal account is never touched');
  assert.equal((await fetch(linkPath)).status, 410);
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: rita } })).status, 401, 'her sessions ended');
  const project = (await store.getProject('p-rita'))!;
  assert.equal(project.ownerId, (await store.getUserBySub('dev:admin@test'))!.id);
  assert.ok(project.archivedAt, 'transferred read-only by default');
  assert.ok((await store.listInvitations()).find((i) => i.email === 'late@reseller.test')!.revokedAt);
  assert.ok((await store.listAudit()).some((a) => a.action === 'programme.exit'));
});

test('someone already in the programme gets the company a list gives them, and the result carries one sign-in message', async () => {
  const admin = await login('admin@test');
  await store.upsertUserBySub({ sub: 'dev:pat@reseller.test', email: 'pat@reseller.test', groups: [], role: 'member' });
  const pat = (await store.getUserBySub('dev:pat@reseller.test'))!;
  await store.setLocalGroups(pat.id, ['programme-resellers']);
  const applied = await json(admin, 'POST', '/api/v1/programmes/resellers/people', {
    text: 'pat@reseller.test,Pat,Acme Reseller\nfresh@reseller.test,,,2032-03-01', apply: true });
  assert.deepEqual(applied.body.rows.map((r: { result: string }) => r.result), ['added', 'invited']);
  assert.ok((await store.getUser(pat.id))!.localGroups.includes('company-acme-reseller'), 'the company is set for someone already in');
  assert.match(applied.body.message, /You are invited to People Hub as part of Resellers\./);
  assert.match(applied.body.message, /Open http:\/\/localhost and sign in/);
  assert.match(applied.body.message, /until 2032-03-01 \(UTC\)/);
});

test('ending a partnership moves projects to the team that owns the programme, read-only, by default', async () => {
  const admin = await login('admin@test');
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', team: 'marketing' })).status, 200);
  assert.equal((await json(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', team: 'programme-resellers' })).status, 400, 'the owning team is an internal group');
  const pat = (await store.getUserBySub('dev:pat@reseller.test'))!;
  await store.putProject({ id: 'p-pat', name: 'Pat data sheets', ownerId: pat.id, visibility: 'private', createdAt: 'x', updatedAt: 'x' } as never);
  const dry = await json(admin, 'POST', '/api/v1/programmes/exit', { programme: 'resellers' });
  assert.equal(dry.body.projects, 'team-readonly');
  assert.equal(dry.body.team, 'marketing');
  const done = await json(admin, 'POST', '/api/v1/programmes/exit', { programme: 'resellers', apply: true });
  assert.equal(done.status, 200);
  const project = (await store.getProject('p-pat'))!;
  assert.ok(project.archivedAt);
  assert.deepEqual(project.visibility, { groups: ['marketing'] });
  assert.deepEqual(project.sharing?.groups, [{ kind: 'directory', name: 'marketing', role: 'viewer' }]);
  assert.equal(project.ownerId, (await store.getUserBySub('dev:admin@test'))!.id, 'owned by whoever made the programme');
});

test('the one sign-in message states an end date only when everyone invited shares it', async () => {
  const { batchSignInMessage } = await import('../server/src/programmes/people-routes.ts');
  const info = { workspace: 'Hub', url: 'https://work.example', providers: ['Google'], note: null };
  assert.match(batchSignInMessage(info, 'Resellers', ['2030-01-31T23:59:59.999Z', '2030-01-31T23:59:59.999Z']), /until 2030-01-31 \(UTC\)/);
  const mixed = batchSignInMessage(info, 'Resellers', ['2030-01-31T23:59:59.999Z', undefined]);
  assert.doesNotMatch(mixed, /until/);
  assert.match(mixed, /If your access has an end date/);
  assert.doesNotMatch(batchSignInMessage(info, 'Resellers', [undefined]), /end date|until/);
  assert.match(batchSignInMessage(info, 'Resellers', [undefined]), /sign in with Google/);
});
