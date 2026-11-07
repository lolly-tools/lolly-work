// SPDX-License-Identifier: MPL-2.0
/**
 * Reopen (plans/82 M5, W-M5-3): an ended partnership comes back from its
 * receipt within 30 days. People, groups, memberships, templates, folder
 * rules, live domain rules and projects return; links, tokens, sessions and
 * share-anyway choices stay ended.
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
import { REOPEN_DAYS, reopenExit, reopenOffered, reopenUntil } from '../server/src/programmes/reopen.ts';
import type { ProgrammeExitRecord } from '../server/src/programmes/exit.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const dns = new Map<string, string[][]>();

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-programme-reopen-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [{ id: 'acme/banner', name: 'Banner', type: 'raster', formats: [{ format: 'png', url: '/catalog/assets/acme/banner.png' }] }] }));
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'banner.png'), 'png');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Reopen Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'bruno@acme.test', groups: ['admin'] },
      { email: 'staff@acme.test', groups: ['marketing'] },
      { email: 'rita@northwind.test', groups: [] },
      { email: 'pat@northwind.test', groups: [] },
      { email: 'old@northwind.test', groups: [] },
    ] },
  }));
  store = createMemoryStore();
  await store.putCollection({ id: 'kit', name: 'Kit', members: ['acme/banner'], groups: ['programme-resellers'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, secrets: { session: 'spr', link: 'lpr' }, resolveTxt: async (name) => dns.get(name) ?? [] });
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
let exitId = '';
let linkPath = '';

test('Northwind IT ends: people, projects, a template, a folder rule, a token, a link and a domain', async () => {
  bruno = await login('bruno@acme.test');
  await login('staff@acme.test');
  for (const email of ['rita@northwind.test', 'pat@northwind.test', 'old@northwind.test']) await login(email);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', team: 'marketing' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/isv', { name: 'ISV partners' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status, 201);
  assert.equal((await json(bruno, 'PUT', '/api/v1/programmes/resellers/companies/globex', { name: 'Globex' })).status, 201);
  await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { apply: true, rows: [
    { email: 'rita@northwind.test', company: 'northwind' }, { email: 'pat@northwind.test', company: 'northwind' }, { email: 'old@northwind.test', company: 'northwind' },
  ] });
  await json(bruno, 'POST', '/api/v1/programmes/isv/people', { apply: true, rows: [{ email: 'pat@northwind.test' }] });
  // Someone an admin disabled before the end stays disabled after Reopen.
  await store.setUserDisabled((await user('old@northwind.test')).id, '2026-10-01T00:00:00.000Z');

  const rita = await user('rita@northwind.test');
  await store.putProject({ id: 'p-rita', name: 'Rita data sheets', ownerId: rita.id, visibility: 'private', createdAt: 'x', updatedAt: 'x' } as never);
  const minted = await json(await login('rita@northwind.test'), 'POST', '/api/v1/links', { kind: 'download', target: { assetId: 'acme/banner' } });
  assert.equal(minted.status, 201);
  linkPath = String(minted.body.url).replace('http://localhost', base);
  await store.putInstanceAsset(template('inst/only-northwind', 'Northwind data sheet', ['company-northwind']));
  await store.putInstanceAsset(template('inst/shared', 'Shared price list', ['company-northwind', 'company-globex']));
  await store.putPartnerFolder({ provider: 'dam', path: 'Partners/Northwind', programmeId: 'resellers', companyId: 'northwind', addedBy: 'x', addedAt: 'x' });
  await store.putApiToken({ id: 'tok_nw', label: 'Northwind agent', role: 'member', groups: programmeTokenGroups('resellers', 'northwind'), tokenHash: 'h-nw', createdBy: 'user:x', createdAt: 'x' } as never);
  assert.equal((await json(bruno, 'PUT', '/api/v1/partner-domains/northwind.test', { programme: 'resellers', company: 'northwind', proof: 'admin', reason: 'contract' })).status, 201);

  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', apply: true });
  assert.equal(done.status, 200);
  exitId = done.body.exit;
  assert.ok((await user('rita@northwind.test')).disabledAt);
  assert.equal((await fetch(linkPath)).status, 410);
});

test('the programme lists its exits with when Reopen closes', async () => {
  const listed = await json(bruno, 'GET', '/api/v1/programmes/resellers/exits');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.reopenDays, REOPEN_DAYS);
  const row = listed.body.exits[0];
  assert.equal(row.id, exitId);
  assert.equal(row.company, 'northwind');
  assert.equal(row.reopen.offered, true);
  assert.equal(Date.parse(row.reopen.until) - Date.parse(row.doneAt), REOPEN_DAYS * 86_400_000);
  assert.equal(row.counts.ended, 2, 'Rita, and the account disabled before the end');
  assert.equal(row.counts.stays, 1);
  const one = await json(bruno, 'GET', `/api/v1/programmes/exits/${exitId}`);
  assert.equal(one.body.result.accounts.length, 3);
});

test('Reopen previews first, then puts back what the exit took and leaves links, tokens and sessions ended', async () => {
  const preview = await json(bruno, 'POST', `/api/v1/programmes/exits/${exitId}/reopen`, {});
  assert.equal(preview.status, 200);
  assert.equal(preview.body.dryRun, true);
  assert.deepEqual(preview.body.accounts.map((a: { email: string; result: string }) => [a.email, a.result]).sort(), [
    ['old@northwind.test', 'left-disabled'], ['pat@northwind.test', 'rejoined'], ['rita@northwind.test', 'enabled'],
  ]);
  assert.deepEqual(preview.body.stayEnded.tokens, 1);
  assert.deepEqual(preview.body.stayEnded.links, 1);
  assert.ok((await user('rita@northwind.test')).disabledAt, 'a preview changes nothing');

  const done = await json(bruno, 'POST', `/api/v1/programmes/exits/${exitId}/reopen`, { apply: true });
  assert.equal(done.status, 200);
  const rita = await user('rita@northwind.test');
  assert.equal(rita.disabledAt, undefined, 'the account the exit disabled is enabled');
  assert.deepEqual([...rita.localGroups].sort(), ['company-northwind', 'partner', 'programme-resellers']);
  assert.ok(!(await store.listMemberships()).find((m) => m.email === 'rita@northwind.test' && m.programmeId === 'resellers')!.endedAt);
  assert.deepEqual([...(await user('pat@northwind.test')).localGroups].sort(), ['company-northwind', 'partner', 'programme-isv', 'programme-resellers']);
  assert.ok((await user('old@northwind.test')).disabledAt, 'one disabled before the end stays disabled');
  const project = (await store.getProject('p-rita'))!;
  assert.equal(project.ownerId, rita.id, 'her project goes back to her');
  assert.equal(project.archivedAt, undefined);
  assert.equal(project.visibility, 'private');
  assert.equal((await store.getInstanceAsset('inst/only-northwind'))!.publication?.retiredAt, undefined);
  assert.deepEqual((await store.getInstanceAsset('inst/shared'))!.groups, ['company-globex', 'company-northwind']);
  assert.deepEqual((await store.listPartnerFolders()).map((f) => f.path), ['Partners/Northwind']);
  const domain = (await store.listPartnerDomains()).find((d) => d.domain === 'northwind.test')!;
  assert.deepEqual(domain.rules.map((r) => [r.programmeId, r.companyId]), [['resellers', 'northwind']], "the admin's recorded proof is still live");
  assert.equal((await store.listCompanies()).find((c) => c.id === 'northwind')!.endedAt, undefined);
  // Still ended.
  assert.ok((await store.getApiToken('tok_nw'))!.revokedAt, 'tokens stay revoked');
  assert.equal((await fetch(linkPath)).status, 410, 'links stay revoked');
  const receipt = (await store.getProgrammeExit(exitId))!;
  assert.equal(receipt.state, 'reopened');
  assert.equal(receipt.reopened!.projects, true);
  assert.ok((await store.listAudit()).some((a) => a.action === 'programme.exit.reopen' && a.payload?.exit === exitId));
  // People can be added to the company again now.
  assert.equal((await json(bruno, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'new@northwind.test', company: 'northwind' }] })).status, 200);
  assert.equal((await json(bruno, 'POST', `/api/v1/programmes/exits/${exitId}/reopen`, { apply: true })).status, 409, 'an end reopens once');
});

test('Give their projects back unticked keeps the projects where the exit put them', async () => {
  const done = await json(bruno, 'POST', '/api/v1/programmes/exit', { company: 'northwind', apply: true });
  const reopened = await json(bruno, 'POST', `/api/v1/programmes/exits/${done.body.exit}/reopen`, { apply: true, projects: false });
  assert.equal(reopened.status, 200);
  assert.deepEqual(reopened.body.projects, []);
  assert.ok((await store.getProject('p-rita'))!.archivedAt, 'still archived with the owning team');
  assert.equal((await user('rita@northwind.test')).disabledAt, undefined);
});

test('after 30 days the receipt stays as the record and Reopen is not offered', async () => {
  const doneAt = new Date(Date.now() - (REOPEN_DAYS + 1) * 86_400_000).toISOString();
  const old: ProgrammeExitRecord = {
    id: 'pex_old', state: 'done', selection: { company: 'globex' }, programmeId: 'resellers', companyId: 'globex', projects: 'keep', transferTo: 'x',
    createdBy: 'x', createdAt: doneAt, doneAt,
    result: { accounts: [], skipped: [], invitations: [], tokens: [], templates: [], folders: [], domainRules: [], domainsRemoved: [], rightsChoices: [], ended: { companies: [] } },
  };
  await store.putProgrammeExit(old);
  assert.equal(reopenOffered(old), false);
  assert.equal(reopenUntil({ state: 'reopened', doneAt }), null);
  const refused = await json(bruno, 'POST', '/api/v1/programmes/exits/pex_old/reopen', {});
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code ?? refused.body.error?.code, 'REOPEN_CLOSED');
  assert.equal((await json(bruno, 'GET', '/api/v1/programmes/resellers/exits')).body.exits.find((e: { id: string }) => e.id === 'pex_old').reopen.offered, false);
});

test('a domain proved by DNS comes back only when its record is found again, and an erased account is listed as gone', async () => {
  const local = createMemoryStore();
  const doneAt = new Date().toISOString();
  await local.putProgramme({ id: 'resellers', name: 'Resellers', createdBy: 'x', createdAt: 'x', updatedAt: 'x', version: 1 });
  const removed = { domain: 'gone.test', proof: 'txt' as const, token: 'tok', verifiedAt: 'x', rules: [], createdBy: 'x', createdAt: 'x', updatedAt: 'x' };
  const rec: ProgrammeExitRecord = {
    id: 'pex_dns', state: 'done', selection: { domain: 'gone.test' }, programmeId: 'resellers', projects: 'keep', transferTo: 'x', createdBy: 'x', createdAt: doneAt, doneAt,
    result: {
      accounts: [{ id: 'usr_erased', email: 'erased@gone.test', name: 'Erased', outcome: 'ended', groupsRemoved: [], memberships: [], projects: [] }],
      skipped: [], invitations: [], tokens: [], templates: [], folders: [], rightsChoices: [], ended: { companies: [] },
      domainRules: [{ domain: 'gone.test', rule: { programmeId: 'resellers', addedBy: 'x', addedAt: 'x' } }], domainsRemoved: [removed],
    },
  };
  const opts = { projects: true, actorRef: 'user:x', actorId: 'x' };
  const preview = await reopenExit(local, async () => undefined, rec, { ...opts, apply: false, resolveTxt: async () => [] });
  assert.deepEqual(preview.domainRules.map((d) => d.result), ['needs-lookup']);
  assert.deepEqual(preview.accounts.map((a) => a.result), ['gone']);
  const missing = await reopenExit(local, async () => undefined, rec, { ...opts, apply: true, resolveTxt: async () => [] });
  assert.deepEqual(missing.domainRules.map((d) => d.result), ['proof-not-live']);
  assert.deepEqual(await local.listPartnerDomains(), []);
  const found = await reopenExit(local, async () => undefined, rec, { ...opts, apply: true, resolveTxt: async () => [['lw-verify=tok']] });
  assert.deepEqual(found.domainRules.map((d) => d.result), ['restored']);
  assert.deepEqual((await local.listPartnerDomains())[0]!.rules.map((r) => r.programmeId), ['resellers']);
});
