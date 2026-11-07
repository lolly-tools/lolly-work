// SPDX-License-Identifier: MPL-2.0
/**
 * Ending a partnership, widened (plans/82 M5, W-M5-1): the ended state, the
 * receipt, and an exit that covers templates, folder rules, tokens, domain
 * rules, share-anyway choices and people who are also in another programme.
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
import { programmeTokenGroups } from '../server/src/iam/service-tokens.ts';
import { applyExit, EXIT_ROW_BOUND, planExit, type ExitRightsChoice } from '../server/src/programmes/exit.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programme-exit-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await mkdir(join(pack, 'tools', 'price-sheet'), { recursive: true });
  await writeFile(join(pack, 'tools', 'price-sheet', 'tool.json'), JSON.stringify({ id: 'price-sheet', name: 'Price sheet', inputs: [{ id: 'price', label: 'Price' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Exit Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@acme.test', groups: ['admin'] },
      { email: 'owner@acme.test', groups: ['owner'] },
      { email: 'staff@acme.test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'pat@northwind.test', groups: [] },
      { email: 'gus@globex.test', groups: [] },
      { email: 'busy@bulk.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'spx', link: 'lpx' } });
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
const user = async (email: string) => (await store.getUserBySub(`dev:${email}`))!;
const template = (id: string, name: string, groups: string[]) => ({
  id, entry: { id, name, type: 'template', formats: [], meta: { toolId: 'price-sheet' } }, blobs: {}, groups,
  submission: { state: 'live' }, createdAt: '2026-11-01T00:00:00.000Z',
}) as never;

let bruno = '';

test('setting up Resellers, EMEA with two companies, and ISV partners', async () => {
  bruno = await login('bruno@acme.test');
  await login('staff@acme.test');
  for (const email of ['rita@northwind.test', 'pat@northwind.test', 'gus@globex.test']) await login(email);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', team: 'marketing', tools: ['price-sheet'] })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/isv', { name: 'ISV partners' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/globex', { name: 'Globex' })).status, 201);
  const added = await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { apply: true, rows: [
    { email: 'rita@northwind.test', company: 'northwind' }, { email: 'pat@northwind.test', company: 'northwind' }, { email: 'gus@globex.test', company: 'globex' },
  ] });
  assert.deepEqual(added.body.rows.map((r: { result: string }) => r.result), ['added', 'added', 'added']);
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/isv/people', { apply: true, rows: [{ email: 'pat@northwind.test' }] })).body.rows[0].result, 'added');
});

test('ending one company: the dry run lists who ends, who stays and what it owns, then one step does it and leaves a receipt', async () => {
  const rita = await user('rita@northwind.test');
  const ritaSession = await login('rita@northwind.test');
  await store.putProject({ id: 'p-rita', name: 'Rita data sheets', ownerId: rita.id, visibility: 'private', createdAt: 'x', updatedAt: 'x' } as never);
  // What Northwind IT owns beyond its people.
  await store.putInstanceAsset(template('inst/only-northwind', 'Northwind data sheet', ['company-northwind']));
  await store.putInstanceAsset(template('inst/shared', 'Shared price list', ['company-northwind', 'company-globex']));
  await store.putInstanceAsset(template('inst/programme', 'Resellers price list', ['programme-resellers']));
  const folder = { provider: 'dam', path: 'Partners/Northwind', programmeId: 'resellers', companyId: 'northwind', addedBy: 'x', addedAt: 'x' };
  await store.putPartnerFolder(folder);
  await store.putPartnerFolder({ provider: 'dam', path: 'Partners/All', programmeId: 'resellers', addedBy: 'x', addedAt: 'x' });
  await store.putApiToken({ id: 'tok_nw', label: 'Northwind agent', role: 'member', groups: programmeTokenGroups('resellers', 'northwind'), tokenHash: 'h-nw', createdBy: 'user:x', createdAt: 'x' } as never);
  await store.putApiToken({ id: 'tok_gx', label: 'Globex agent', role: 'member', groups: programmeTokenGroups('resellers', 'globex'), tokenHash: 'h-gx', createdBy: 'user:x', createdAt: 'x' } as never);
  assert.equal((await json(bruno, 'PUT', '/api/v1/partner-domains/northwind.test', { programme: 'resellers', company: 'northwind', proof: 'admin', reason: 'contract 2026-114' })).status, 201);

  const dry = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind' });
  assert.equal(dry.status, 200);
  assert.deepEqual(dry.body.accounts.map((a: { email: string }) => a.email), ['rita@northwind.test'], 'only the people whose access ends');
  assert.deepEqual(dry.body.accounts[0].projects, [{ id: 'p-rita', name: 'Rita data sheets' }]);
  assert.deepEqual(dry.body.stays.map((a: { email: string; stays: string[] }) => [a.email, a.stays]), [['pat@northwind.test', ['ISV partners']]]);
  assert.deepEqual(dry.body.cannotEnd, []);
  assert.deepEqual(dry.body.templates, [
    { id: 'inst/only-northwind', name: 'Northwind data sheet', action: 'retire' },
    { id: 'inst/shared', name: 'Shared price list', action: 'narrow', keeps: ['company-globex'] },
  ]);
  assert.deepEqual(dry.body.folders, [{ provider: 'dam', path: 'Partners/Northwind', company: 'northwind' }]);
  assert.deepEqual(dry.body.tokens, [{ id: 'tok_nw', label: 'Northwind agent' }]);
  assert.deepEqual(dry.body.domainRules.map((r: { domain: string }) => r.domain), ['northwind.test']);
  assert.equal(dry.body.rowBound, EXIT_ROW_BOUND);
  assert.equal((await store.getUser(rita.id))!.disabledAt, undefined, 'a dry run changes nothing');

  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', apply: true });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.accounts.map((a: { email: string }) => a.email), ['rita@northwind.test']);
  assert.deepEqual(done.body.stays.map((a: { email: string }) => a.email), ['pat@northwind.test']);
  assert.deepEqual(done.body.ended, { companies: ['northwind'] });

  // Rita: disabled, signed out, out of the company and the programme.
  const ritaAfter = (await store.getUser(rita.id))!;
  assert.ok(ritaAfter.disabledAt);
  assert.deepEqual(ritaAfter.localGroups, ['partner']);
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: ritaSession } })).status, 401);
  assert.ok((await store.getProject('p-rita'))!.archivedAt, 'her projects moved read-only to the owning team');
  // Pat: also in ISV partners, so Pat keeps the account and leaves only Resellers, EMEA.
  const patAfter = (await user('pat@northwind.test'));
  assert.equal(patAfter.disabledAt, undefined);
  assert.deepEqual([...patAfter.localGroups].sort(), ['partner', 'programme-isv']);
  const patMemberships = (await store.listMemberships()).filter((m) => m.email === 'pat@northwind.test');
  assert.ok(patMemberships.find((m) => m.programmeId === 'resellers')!.endedAt);
  assert.equal(patMemberships.find((m) => m.programmeId === 'isv')!.endedAt, undefined);
  // Gus at Globex is untouched.
  assert.ok((await user('gus@globex.test')).localGroups.includes('company-globex'));

  // What the company owned.
  assert.ok((await store.getInstanceAsset('inst/only-northwind'))!.publication?.retiredAt, 'a template published only to the company is retired');
  assert.equal((await store.getInstanceAsset('inst/only-northwind'))!.publication?.replacedBy, undefined);
  assert.deepEqual((await store.getInstanceAsset('inst/shared'))!.groups, ['company-globex'], 'a template also published elsewhere keeps its other audiences');
  assert.equal((await store.getInstanceAsset('inst/programme'))!.publication?.retiredAt, undefined, "the programme's own template is left");
  assert.deepEqual((await store.listPartnerFolders()).map((r) => r.path), ['Partners/All']);
  assert.ok((await store.getApiToken('tok_nw'))!.revokedAt);
  assert.equal((await store.getApiToken('tok_gx'))!.revokedAt, undefined);
  assert.equal((await store.listPartnerDomains()).length, 0, 'the domain fed only Northwind IT, so it goes');

  // The ended state and the receipt.
  const northwind = (await store.listCompanies()).find((c) => c.id === 'northwind')!;
  assert.ok(northwind.endedAt);
  assert.equal(northwind.endedBy, (await user('bruno@acme.test')).id);
  assert.equal(northwind.endedExit, done.body.exit);
  assert.equal((await store.getProgramme('resellers'))!.endedAt, undefined, 'the programme keeps running');
  const receipt = (await store.getProgrammeExit(done.body.exit))!;
  assert.equal(receipt.state, 'done');
  assert.equal(receipt.companyId, 'northwind');
  assert.equal(receipt.programmeId, 'resellers');
  assert.deepEqual(receipt.result!.accounts.map((a) => [a.email, a.outcome]), [['rita@northwind.test', 'ended'], ['pat@northwind.test', 'stays']]);
  assert.deepEqual(receipt.result!.accounts[0]!.projects[0]!.before, { ownerId: rita.id, visibility: 'private', archivedAt: null }, 'how each project was, for Reopen');
  assert.deepEqual(receipt.result!.accounts[0]!.groupsRemoved.sort(), ['company-northwind', 'programme-resellers']);
  assert.deepEqual(receipt.result!.folders, [folder]);
  assert.equal(receipt.result!.domainsRemoved[0]!.domain, 'northwind.test');
  assert.deepEqual(receipt.result!.templates.map((t) => [t.id, t.action, t.groupsBefore]), [
    ['inst/only-northwind', 'retire', ['company-northwind']], ['inst/shared', 'narrow', ['company-northwind', 'company-globex']],
  ]);

  const audit = await store.listAudit();
  const exitRow = audit.find((a) => a.action === 'programme.exit')!;
  assert.equal(exitRow.payload?.exit, done.body.exit);
  assert.equal(exitRow.payload?.stays, 1);
  assert.ok(audit.some((a) => a.action === 'programme.template.retire' && a.payload?.via === 'programme-exit'));
  assert.ok(audit.some((a) => a.action === 'programme.folder.end' && a.payload?.via === 'programme-exit'));
  assert.ok(audit.some((a) => a.action === 'programme.member.leave' && a.payload?.stays));
});

test('an ended company answers 409 PROGRAMME_ENDED to a list import, a domain rule and a token placement, and a rename keeps it ended', async () => {
  const owner = await login('owner@acme.test');
  const listed = await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'new@northwind.test', company: 'Northwind IT' }] });
  assert.equal(listed.status, 409);
  assert.equal(listed.body.code ?? listed.body.error?.code, 'PROGRAMME_ENDED');
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'new@globex.test', company: 'globex' }] })).status, 200, 'the programme still takes people');
  assert.equal((await json(bruno, 'PUT', '/api/v1/partner-domains/northwind.test', { programme: 'resellers', company: 'northwind', proof: 'admin' })).status, 409);
  await store.putApiToken({ id: 'tok_new', label: 'New agent', role: 'member', tokenHash: 'h-new', createdBy: 'user:x', createdAt: 'x' } as never);
  assert.equal((await json(owner, 'PUT', '/api/v1/tokens/tok_new/programme', { programme: 'resellers', company: 'northwind' })).status, 409);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT Ltd' })).status, 200);
  assert.ok((await store.listCompanies()).find((c) => c.id === 'northwind')!.endedAt, 'a rename keeps it ended');
});

test('ending the whole programme marks it and its companies ended, and an edit keeps the ended state and the templates-only switch', async () => {
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/templates-only/price-sheet', { on: true })).status, 200);
  const dry = await json(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'resellers' });
  assert.deepEqual(dry.body.accounts.map((a: { email: string }) => a.email), ['gus@globex.test']);
  assert.deepEqual(dry.body.templates.map((t: { id: string; action: string }) => [t.id, t.action]), [['inst/shared', 'retire'], ['inst/programme', 'retire']]);
  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'resellers', apply: true });
  assert.equal(done.status, 200);
  assert.deepEqual(done.body.ended, { programme: 'resellers', companies: ['globex'] }, 'Northwind IT stays ended from its own exit');
  assert.ok((await store.getApiToken('tok_gx'))!.revokedAt);
  const programme = (await store.getProgramme('resellers'))!;
  assert.ok(programme.endedAt);
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'x@y.test' }] })).status, 409);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/initech', { name: 'Initech' })).status, 409, 'no new company in an ended programme');
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA (ended)' })).status, 200);
  const edited = (await store.getProgramme('resellers'))!;
  assert.equal(edited.endedAt, programme.endedAt, 'an edit keeps the ended state');
  assert.deepEqual(edited.templatesOnly, ['price-sheet'], 'and the templates-only switch');
  const again = await json(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'resellers' });
  assert.equal(again.body.alreadyEnded.at, programme.endedAt, 'the dry run says it has ended');
  const listed = await store.listProgrammeExits({ programmeId: 'resellers' });
  assert.equal(listed.length, 2, "the programme's receipts include its companies'");
});

test('an account over the offboarding bound is listed as not ended, leaves the programme and keeps signing in', async () => {
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/bulk', { name: 'Bulk partners' })).status, 201);
  await login('busy@bulk.test');
  await json(bruno, 'POST', '/api/v1/programmes/bulk/people', { apply: true, rows: [{ email: 'busy@bulk.test' }] });
  const busy = await user('busy@bulk.test');
  for (let i = 0; i <= EXIT_ROW_BOUND; i++) {
    await store.putLink({ id: `lnk_${String(i).padStart(5, '0')}`, kind: 'download', target: { assetId: 'a' }, exp: 4102444800, createdBy: busy.id, createdAt: 'x' } as never);
  }
  const dry = await json(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'bulk' });
  assert.deepEqual(dry.body.accounts, []);
  assert.equal(dry.body.cannotEnd.length, 1);
  assert.match(dry.body.cannotEnd[0].reason, /More than 1000 live links/);
  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { programme: 'bulk', apply: true });
  assert.deepEqual(done.body.accounts, []);
  assert.deepEqual(done.body.notEnded.map((a: { email: string }) => a.email), ['busy@bulk.test']);
  const after = await user('busy@bulk.test');
  assert.equal(after.disabledAt, undefined, 'still signing in');
  assert.deepEqual(after.localGroups, ['partner'], 'but out of the programme');
  assert.equal((await store.listAudit()).filter((a) => a.action === 'programme.exit').at(-1)!.payload?.notEnded, 1);
});

test('a domain exit revokes the tokens of the one company it feeds, and never another company\'s', async () => {
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/distributors/companies/initech', { name: 'Initech' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/distributors/companies/hooli', { name: 'Hooli' })).status, 201);
  await store.putApiToken({ id: 'tok_in', label: 'Initech agent', role: 'member', groups: programmeTokenGroups('distributors', 'initech'), tokenHash: 'h-in', createdBy: 'user:x', createdAt: 'x' } as never);
  await store.putApiToken({ id: 'tok_ho', label: 'Hooli agent', role: 'member', groups: programmeTokenGroups('distributors', 'hooli'), tokenHash: 'h-ho', createdBy: 'user:x', createdAt: 'x' } as never);
  await store.putApiToken({ id: 'tok_di', label: 'Distributors agent', role: 'member', groups: programmeTokenGroups('distributors'), tokenHash: 'h-di', createdBy: 'user:x', createdAt: 'x' } as never);
  assert.equal((await json(bruno, 'PUT', '/api/v1/partner-domains/initech.test', { programme: 'distributors', company: 'initech', proof: 'admin' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/partner-domains/dist.test', { programme: 'distributors', proof: 'admin' })).status, 201);
  assert.deepEqual((await json(bruno, 'POST', '/api/v1/programmes/exit', { domain: 'initech.test' })).body.tokens.map((t: { id: string }) => t.id), ['tok_in']);
  assert.deepEqual((await json(bruno, 'POST', '/api/v1/programmes/exit', { domain: 'dist.test' })).body.tokens.map((t: { id: string }) => t.id), ['tok_di'],
    'a domain feeding the programme alone takes only the tokens that name no company');
  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { domain: 'initech.test', apply: true });
  assert.equal(done.body.tokensRevoked, 1);
  assert.equal((await store.getApiToken('tok_ho'))!.revokedAt, undefined);
  assert.equal((await store.listCompanies()).find((c) => c.id === 'initech')!.endedAt, undefined, 'a domain exit selects people and ends no company');
});

test('deleting a company removes the grants and collection entries naming its group, and its receipts', async () => {
  await store.putGrant({ principal: 'group:company-hooli', action: 'tool.use', resource: 'tool:price-sheet', effect: 'allow' });
  await store.putCollection({ id: 'hooli-kit', name: 'Hooli kit', members: [], groups: ['company-hooli', 'programme-distributors'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'hooli', apply: true });
  assert.equal((await store.listProgrammeExits({ companyId: 'hooli' })).length, 1);
  assert.equal((await json(bruno, 'DELETE', '/api/v1/programmes/distributors/companies/hooli')).status, 200);
  assert.equal((await store.listGrants()).filter((g) => g.principal === 'group:company-hooli').length, 0);
  assert.deepEqual((await store.getCollection('hooli-kit'))!.groups, ['programme-distributors']);
  assert.equal((await store.listProgrammeExits({ companyId: 'hooli' })).length, 0);
});

test('the exit withdraws the selection\'s share-anyway choices through the store it is given, and lists them first', async () => {
  const local = createMemoryStore();
  await local.putProgramme({ id: 'resellers', name: 'Resellers', createdBy: 'x', createdAt: 'x', updatedAt: 'x', version: 1 });
  await local.putCompany({ id: 'northwind', programmeId: 'resellers', name: 'Northwind IT', createdBy: 'x', createdAt: 'x', updatedAt: 'x' });
  await local.upsertUserBySub({ sub: 'dev:bruno', email: 'bruno@acme.test', groups: ['admin'], role: 'admin' });
  const actor = (await local.getUserBySub('dev:bruno'))!;
  const choices: ExitRightsChoice[] = [{ assetId: 'event-photos/IMG_2231.jpg', group: 'company-northwind', licence: 'CC-BY-NC-4.0' }];
  const calls: unknown[] = [];
  const rights = {
    list: async (pick: { companyId?: string }) => (pick.companyId === 'northwind' ? choices : []),
    withdraw: async (by: string, pick: { companyId?: string }, via: string) => { calls.push([by, pick, via]); return pick.companyId === 'northwind' ? choices : []; },
  };
  const planned = await planExit(local, { company: 'northwind' }, actor, { projects: 'keep', rights });
  assert.ok(planned.ok);
  if (!planned.ok) return;
  assert.deepEqual(planned.plan.rightsChoices, choices);
  const receipt = await applyExit(local, async () => undefined, planned.plan, { actorRef: `user:${actor.id}`, actorId: actor.id, rights });
  assert.deepEqual(calls, [[`user:${actor.id}`, { companyId: 'northwind' }, 'programme-exit']]);
  assert.deepEqual(receipt.result!.rightsChoices, choices);
});
