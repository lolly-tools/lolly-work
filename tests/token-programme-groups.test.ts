// SPDX-License-Identifier: MPL-2.0
/**
 * Service tokens placed in a partner programme (plans/82 M3, the first slice
 * of M7 item 3). An owner places a token in a programme and optionally one
 * company in it; the token then resolves to a principal carrying those groups,
 * so it reaches exactly what a person in that company reaches, through the
 * same code. Taking it out keeps the partner marker, and ending the company or
 * programme revokes it.
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
import { programmeTokenGroups, serviceAccountFor, tokenGroupsWithout, tokenPlacement } from '../server/src/iam/service-tokens.ts';
import { isProgrammeScoped } from '../server/src/programmes/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const ASSETS = [
  { id: 'acme/tokens', name: 'Tokens', type: 'tokens', file: 'tokens.json', body: '{}' },
  { id: 'acme/internal', name: 'Internal deck', type: 'raster', file: 'internal.png', body: 'png' },
  { id: 'acme/northwind-sheet', name: 'Northwind sheet', type: 'raster', file: 'northwind.png', body: 'png' },
  { id: 'acme/globex-sheet', name: 'Globex sheet', type: 'raster', file: 'globex.png', body: 'png' },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-token-programme-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'price-sheet' }] }));
  for (const a of ASSETS) await writeFile(join(pack, 'catalog', 'assets', 'acme', a.file), a.body);
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({
    version: 1,
    assets: ASSETS.map((a) => ({ id: a.id, name: a.name, type: a.type, formats: [{ format: a.file.split('.').pop(), url: `/catalog/assets/acme/${a.file}` }] })),
  }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Token Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
  }));
  store = createMemoryStore();
  await store.putCollection({ id: 'northwind-kit', name: 'Northwind kit', members: ['acme/northwind-sheet'], groups: ['company-northwind'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  await store.putCollection({ id: 'globex-kit', name: 'Globex kit', members: ['acme/globex-sheet'], groups: ['company-globex'], curator: 'user:x', createdAt: 'x', updatedAt: 'x' });
  const app = buildApp({ config, store, secrets: { session: 'stp', link: 'ltp' } });
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
const feed = async (secret: string) => {
  const res = await fetch(`${base}/catalog/assets/index.json`, { headers: { authorization: `Bearer ${secret}` } });
  assert.equal(res.status, 200);
  const f = await res.json() as { assets: Array<{ id: string }> };
  return f.assets.map((a) => a.id).sort();
};
const mint = async (owner: string, label: string, body: Record<string, unknown> = { scopes: ['catalog.read', 'render'] }) => {
  const made = await json(owner, 'POST', '/api/v1/tokens', { label, ...body });
  assert.equal(made.status, 201);
  return made.body as { id: string; token: string };
};

let setUp = false;
async function programme(): Promise<string> {
  const owner = await login('owner@test');
  if (setUp) return owner;
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers' })).status, 201);
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status, 201);
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/resellers/companies/globex', { name: 'Globex' })).status, 201);
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors' })).status, 201);
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/distributors/companies/initech', { name: 'Initech' })).status, 201);
  setUp = true;
  return owner;
}

test('the groups a placed token carries, read back, and what a delete leaves', () => {
  assert.deepEqual(programmeTokenGroups('resellers', 'northwind'), ['programme-resellers', 'company-northwind', 'partner']);
  assert.deepEqual(programmeTokenGroups('resellers'), ['programme-resellers', 'partner']);
  assert.deepEqual(tokenPlacement({ groups: ['programme-resellers', 'company-northwind', 'partner'] }), { programmeId: 'resellers', companyId: 'northwind', partner: true });
  assert.deepEqual(tokenPlacement({}), { partner: false });
  assert.deepEqual(tokenPlacement({ groups: ['partner'] }), { partner: true });
  assert.deepEqual(tokenGroupsWithout({ groups: ['programme-resellers', 'company-northwind', 'partner'] }, new Set(['company-northwind'])), ['programme-resellers', 'partner']);
  assert.equal(tokenGroupsWithout({}, new Set(['company-northwind'])), undefined);
});

test('a placed token resolves to a principal with its groups, and is scoped like a person', () => {
  const rec = { id: 'tok_x', label: 'agent', role: 'automation', scopes: ['render'], tokenHash: 'h', createdBy: 'user:o', createdAt: '2026-11-07T00:00:00.000Z',
    groups: ['programme-resellers', 'company-northwind', 'partner'] };
  const principal = serviceAccountFor(rec);
  assert.deepEqual(principal.groups, rec.groups);
  assert.deepEqual(principal.localGroups, rec.groups);
  assert.equal(isProgrammeScoped(principal.groups, principal.role), true);
  const plain = serviceAccountFor({ ...rec, groups: undefined });
  assert.deepEqual(plain.groups, []);
  assert.equal(isProgrammeScoped(plain.groups, plain.role), false);
});

test('an owner places a token in a company, and it then reaches what that company reaches and nothing internal', async () => {
  const owner = await programme();
  const agent = await mint(owner, 'northwind agent');
  assert.deepEqual(await feed(agent.token), ['acme/globex-sheet', 'acme/internal', 'acme/northwind-sheet', 'acme/tokens'], 'unplaced, the token has its role\'s full reach');

  const admin = await login('admin@test');
  assert.equal((await json(admin, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers', company: 'northwind' })).status, 403, 'placing is an owner act, like minting');

  const placed = await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers', company: 'northwind' });
  assert.equal(placed.status, 200);
  assert.deepEqual(placed.body, { id: agent.id, label: 'northwind agent', groups: ['programme-resellers', 'company-northwind', 'partner'], programme: 'resellers', company: 'northwind' });
  assert.deepEqual(await feed(agent.token), ['acme/northwind-sheet', 'acme/tokens'], 'the essentials and its company\'s collection, as for a person in Northwind');

  const listed = (await json(owner, 'GET', '/api/v1/tokens')).body.tokens.find((t: { id: string }) => t.id === agent.id);
  assert.equal(listed.programme, 'resellers');
  assert.equal(listed.company, 'northwind');

  const audit = (await store.listAudit()).find((e: { action: string; subject: string }) => e.action === 'token.programme' && e.subject === `token:${agent.id}`) as { payload?: Record<string, unknown> } | undefined;
  assert.deepEqual(audit?.payload, { before: {}, after: { programme: 'resellers', company: 'northwind' } });
});

test('placing refuses admin and owner tokens, a company of another programme and an unknown programme', async () => {
  const owner = await programme();
  const adminToken = await mint(owner, 'ops', { role: 'admin' });
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${adminToken.id}/programme`, { programme: 'resellers' })).body?.error?.code ?? 'x', 'TOKEN_NOT_SCOPED');
  const agent = await mint(owner, 'stray agent');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers', company: 'initech' })).status, 404);
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'nope' })).status, 404);
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { company: 'northwind' })).status, 400);
  assert.equal((await json(owner, 'PUT', '/api/v1/tokens/tok_missing/programme', { programme: 'resellers' })).status, 404);
});

test('taking a token out of its programme keeps the partner marker, so it never becomes internal', async () => {
  const owner = await programme();
  const agent = await mint(owner, 'leaving agent');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers' })).status, 200);
  const out = await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: null });
  assert.equal(out.status, 200);
  assert.deepEqual(out.body.groups, ['partner']);
  assert.deepEqual(await feed(agent.token), ['acme/tokens'], 'only the essentials');
  const never = await mint(owner, 'never placed');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${never.id}/programme`, { programme: null })).body.groups, null, 'a token never placed stays as it was');
});

test('deleting a company takes its group off the tokens placed in it, and they stay in the programme', async () => {
  const owner = await programme();
  assert.equal((await json(owner, 'PUT', '/api/v1/programmes/resellers/companies/hooli', { name: 'Hooli' })).status, 201);
  const agent = await mint(owner, 'hooli agent');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers', company: 'hooli' })).status, 200);
  assert.equal((await json(owner, 'DELETE', '/api/v1/programmes/resellers/companies/hooli')).status, 200);
  assert.deepEqual((await store.getApiToken(agent.id))?.groups, ['programme-resellers', 'partner']);
});

test('ending a company revokes the tokens placed in it, listed in the preview first', async () => {
  const owner = await programme();
  const agent = await mint(owner, 'globex agent');
  const other = await mint(owner, 'northwind second agent');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'resellers', company: 'globex' })).status, 200);
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${other.id}/programme`, { programme: 'resellers', company: 'northwind' })).status, 200);
  const preview = await json(owner, 'POST', '/api/v1/programmes/exit', { company: 'globex', projects: 'keep' });
  assert.equal(preview.status, 200);
  assert.deepEqual(preview.body.tokens, [{ id: agent.id, label: 'globex agent' }]);
  assert.equal((await store.getApiToken(agent.id))?.revokedAt, undefined, 'a preview changes nothing');

  const done = await json(owner, 'POST', '/api/v1/programmes/exit', { company: 'globex', projects: 'keep', apply: true });
  assert.equal(done.status, 200);
  assert.equal(done.body.tokensRevoked, 1);
  assert.ok((await store.getApiToken(agent.id))?.revokedAt);
  assert.equal((await store.getApiToken(other.id))?.revokedAt, undefined, 'another company\'s token is untouched');
  assert.equal((await fetch(`${base}/catalog/assets/index.json`, { headers: { authorization: `Bearer ${agent.token}` } })).status, 401);
});

test('deleting a programme takes its groups off its tokens and keeps the partner marker', async () => {
  const owner = await programme();
  const agent = await mint(owner, 'initech agent');
  assert.equal((await json(owner, 'PUT', `/api/v1/tokens/${agent.id}/programme`, { programme: 'distributors', company: 'initech' })).status, 200);
  assert.equal((await json(owner, 'DELETE', '/api/v1/programmes/distributors')).status, 200);
  assert.deepEqual((await store.getApiToken(agent.id))?.groups, ['partner']);
  assert.deepEqual(await feed(agent.token), ['acme/tokens']);
});
