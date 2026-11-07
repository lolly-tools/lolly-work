// SPDX-License-Identifier: MPL-2.0
/**
 * Tokens a programme's manager issues for a partner's agent (plans/82 M7
 * section 3), over the real app. Pinned here:
 *
 *  - the server sets the role, the groups and `via`, never the body;
 *  - scopes are capped, and `delivery` and `audit.read` are refused;
 *  - the tools sit inside the programme's own list;
 *  - a manager of one programme is refused on another;
 *  - the list shows limits, use and expiry; a manager changes one token's
 *    limits and revokes one token, only inside their programme;
 *  - a programme token never leaves its programme.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import { parseProgrammeTokenScopes } from '../server/src/iam/token-scopes.ts';

const CLI = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'cli', 'lw.ts');
let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const cookies: Record<string, string> = {};

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-programme-tokens-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }, { id: 'sheet' }, { id: 'internal' }] }));
  store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Programme tokens', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'bruno@test', groups: [] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), metrics: createMetrics(), secrets: { session: 'sT', link: 'lT' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  for (const who of ['owner', 'admin', 'bruno']) {
    const login = await fetch(`${base}/api/auth/dev?email=${who}@test`, { redirect: 'manual' });
    cookies[who] = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  }
  assert.equal((await as('admin', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['card', 'sheet'] })).status, 201);
  assert.equal((await as('admin', 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors', tools: ['card'] })).status, 201);
  assert.ok((await as('admin', 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status < 300);
  assert.ok((await as('admin', 'PUT', '/api/v1/programmes/distributors/companies/globex', { name: 'Globex' })).status < 300);
  // Bruno manages Resellers, EMEA and nothing else.
  const bruno = (await store.listUsers()).find((u) => u.email === 'bruno@test')!;
  await store.putGrant({ principal: `user:${bruno.id}`, action: 'programme.manage', resource: 'programme:resellers', effect: 'allow' });
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

async function as(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}

test('the scope caps: render and catalog.read by default, never delivery or audit.read', () => {
  assert.deepEqual(parseProgrammeTokenScopes(undefined), ['render', 'catalog.read']);
  assert.deepEqual(parseProgrammeTokenScopes(['files', 'render', 'documents', 'catalog.read']), ['render', 'documents', 'files', 'catalog.read']);
  assert.equal((parseProgrammeTokenScopes(['delivery']) as { code: string }).code, 'SCOPE_NOT_FOR_PROGRAMME');
  assert.equal((parseProgrammeTokenScopes(['render', 'audit.read']) as { code: string }).code, 'SCOPE_NOT_FOR_PROGRAMME');
  assert.equal((parseProgrammeTokenScopes(['nope']) as { code: string }).code, 'INVALID_INPUT');
  assert.equal((parseProgrammeTokenScopes([]) as { code: string }).code, 'INVALID_INPUT');
});

test('a manager mints a token for their programme: the server sets the role, the groups and via', async () => {
  const made = await as('bruno', 'POST', '/api/v1/programmes/resellers/tokens', { label: "Rita's agent", company: 'northwind' });
  assert.equal(made.status, 201, JSON.stringify(made.body));
  assert.match(made.body.token, /^lwt_/);
  assert.deepEqual(made.body.scopes, ['render', 'catalog.read']);
  assert.equal(made.body.company, 'northwind');
  assert.equal(made.body.via, 'programme');
  assert.deepEqual(made.body.limitSources, { callsPerMinute: 'instance', rendersPerDay: 'instance', rendersPerMonth: 'instance' });
  assert.deepEqual(made.body.limits, { callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null });
  const days = (Date.parse(made.body.expiresAt) - Date.parse(made.body.createdAt)) / 86_400_000;
  assert.equal(Math.round(days), 90, 'the lifetime defaults to 90 days');
  const rec = (await store.getApiToken(made.body.id))!;
  assert.equal(rec.role, 'automation');
  assert.deepEqual(rec.groups, ['programme-resellers', 'company-northwind', 'partner']);
  assert.equal(rec.via, 'programme');
  const audit = (await store.listAudit()).filter((a) => a.action === 'token.create' && a.subject === `token:${rec.id}`);
  assert.equal(audit.length, 1);
  assert.equal(audit[0]!.payload?.programme, 'resellers');
  assert.equal(audit[0]!.payload?.company, 'northwind');
  assert.equal(audit[0]!.payload?.via, 'programme');
  assert.equal(JSON.stringify(audit[0]).includes(made.body.token), false, 'the secret is never audited');
  // The token reads its own limits.
  const me = await fetch(`${base}/api/v1/discovery/me`, { headers: { authorization: `Bearer ${made.body.token}` } });
  assert.deepEqual((await me.json() as { limits: { token: unknown } }).limits.token, { callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null });
});

test('what a mint may not ask for is refused', async () => {
  const mint = (body: Record<string, unknown>) => as('bruno', 'POST', '/api/v1/programmes/resellers/tokens', { label: 'agent', ...body });
  assert.equal((await mint({ scopes: ['render', 'delivery'] })).body.error.code, 'SCOPE_NOT_FOR_PROGRAMME');
  assert.equal((await mint({ scopes: ['audit.read'] })).body.error.code, 'SCOPE_NOT_FOR_PROGRAMME');
  assert.equal((await mint({ role: 'owner' })).status, 400);
  assert.equal((await mint({ groups: ['programme-distributors'] })).status, 400);
  assert.equal((await mint({ tools: ['internal'] })).body.error.code, 'TOOL_NOT_IN_PROGRAMME');
  assert.equal((await mint({ tools: ['card'], scopes: ['catalog.read'] })).status, 400, 'a tools list needs render or documents');
  assert.equal((await mint({ company: 'globex' })).status, 404, 'a company of another programme');
  assert.equal((await mint({ ttlDays: 400 })).status, 400);
  assert.equal((await mint({ limits: { rendersPerDay: 0 } })).status, 400);
  assert.equal((await mint({ label: '' })).status, 400);
  const fine = await mint({ tools: ['sheet'], scopes: ['render', 'files'], ttlDays: 30, limits: { rendersPerDay: 50 } });
  assert.equal(fine.status, 201, JSON.stringify(fine.body));
  assert.deepEqual(fine.body.tools, ['sheet']);
  assert.equal(fine.body.limitSources.rendersPerDay, 'token');
});

test('a manager of one programme is refused on another, and an admin keeps every programme', async () => {
  assert.equal((await as('bruno', 'POST', '/api/v1/programmes/distributors/tokens', { label: 'x' })).status, 403);
  assert.equal((await as('bruno', 'GET', '/api/v1/programmes/distributors/tokens')).status, 403);
  const theirs = await as('admin', 'POST', '/api/v1/programmes/distributors/tokens', { label: 'Globex agent', company: 'globex' });
  assert.equal(theirs.status, 201);
  assert.equal((await as('bruno', 'DELETE', `/api/v1/programmes/distributors/tokens/${theirs.body.id}`)).status, 403);
  // Through his own programme's address, another programme's token is not there.
  assert.equal((await as('bruno', 'DELETE', `/api/v1/programmes/resellers/tokens/${theirs.body.id}`)).status, 404);
  assert.equal((await as('bruno', 'PUT', `/api/v1/programmes/resellers/tokens/${theirs.body.id}`, { limits: {} })).status, 404);
  assert.equal((await as('bruno', 'GET', '/api/v1/tokens')).status, 403, 'the owner list stays the owner\'s');
});

test('the list shows each token\'s limits, use and expiry, and filters by company', async () => {
  const soon = await as('bruno', 'POST', '/api/v1/programmes/resellers/tokens', { label: 'short-lived', ttlDays: 10 });
  assert.equal(soon.status, 201);
  const listed = await as('bruno', 'GET', '/api/v1/programmes/resellers/tokens');
  assert.equal(listed.status, 200);
  assert.equal(listed.body.expiringWithinDays, 14);
  const row = listed.body.tokens.find((t: { id: string }) => t.id === soon.body.id);
  assert.equal(row.expiring, true);
  assert.equal(row.live, true);
  assert.equal(row.company, null);
  assert.ok(row.usage.today && row.limits && row.limitSources, 'limits and use on every row');
  assert.ok(listed.body.tokens.every((t: { id: string }) => t.id), 'only this programme');
  assert.ok(!listed.body.tokens.some((t: { label: string }) => t.label === 'Globex agent'));
  const northwind = await as('bruno', 'GET', '/api/v1/programmes/resellers/tokens?company=northwind');
  assert.ok(northwind.body.tokens.length >= 1);
  assert.ok(northwind.body.tokens.every((t: { company: string }) => t.company === 'northwind'));
  assert.equal(JSON.stringify(listed.body).includes('lwt_'), false, 'no secret in a list');
});

test('a manager changes one token\'s limits and revokes one token', async () => {
  const made = await as('bruno', 'POST', '/api/v1/programmes/resellers/tokens', { label: 'to change', company: 'northwind' });
  const changed = await as('bruno', 'PUT', `/api/v1/programmes/resellers/tokens/${made.body.id}`, { limits: { rendersPerDay: 10, rendersPerMonth: null } });
  assert.equal(changed.status, 200, JSON.stringify(changed.body));
  assert.deepEqual(changed.body.limitSources, { callsPerMinute: 'instance', rendersPerDay: 'token', rendersPerMonth: 'token' });
  assert.equal((await as('bruno', 'PUT', `/api/v1/programmes/resellers/tokens/${made.body.id}`, { limits: { rendersPerDay: -4 } })).status, 400);
  const revoked = await as('bruno', 'DELETE', `/api/v1/programmes/resellers/tokens/${made.body.id}`);
  assert.equal(revoked.status, 200);
  const use = await fetch(`${base}/api/v1/discovery/me`, { headers: { authorization: `Bearer ${made.body.token}` } });
  assert.equal(use.status, 401, 'a revoked token is refused');
  assert.equal((await as('bruno', 'DELETE', `/api/v1/programmes/resellers/tokens/${made.body.id}`)).status, 404, 'revoked once');
  assert.equal((await as('bruno', 'PUT', `/api/v1/programmes/resellers/tokens/${made.body.id}`, { limits: {} })).status, 409);
  const audit = await store.listAudit();
  assert.ok(audit.some((a) => a.action === 'token.limits' && a.subject === `token:${made.body.id}` && a.payload?.via === 'programme'));
  assert.ok(audit.some((a) => a.action === 'token.revoke' && a.subject === `token:${made.body.id}` && a.payload?.via === 'programme' && a.payload?.company === 'northwind'));
  const row = (await as('bruno', 'GET', '/api/v1/programmes/resellers/tokens')).body.tokens.find((t: { id: string }) => t.id === made.body.id);
  assert.ok(row.revokedAt, 'a revoked token stays listed');
  assert.equal(row.live, false);
});

test('a programme token never leaves its programme; an owner-placed token still moves', async () => {
  const minted = await as('bruno', 'POST', '/api/v1/programmes/resellers/tokens', { label: 'stays' });
  for (const body of [{ programme: null }, { programme: 'distributors' }]) {
    const moved = await as('owner', 'PUT', `/api/v1/tokens/${minted.body.id}/programme`, body);
    assert.equal(moved.status, 409, JSON.stringify(moved.body));
    assert.equal(moved.body.error.code, 'PROGRAMME_TOKEN');
  }
  assert.equal((await as('owner', 'PUT', `/api/v1/tokens/${minted.body.id}/programme`, { programme: 'resellers', company: 'northwind' })).status, 200, 'a company inside the same programme');
  assert.deepEqual((await store.getApiToken(minted.body.id))!.groups, ['programme-resellers', 'company-northwind', 'partner']);
  const owners = await as('owner', 'POST', '/api/v1/tokens', { label: 'internal', scopes: ['render'] });
  assert.equal((await as('owner', 'PUT', `/api/v1/tokens/${owners.body.id}/programme`, { programme: 'resellers' })).status, 200);
  assert.equal((await as('owner', 'PUT', `/api/v1/tokens/${owners.body.id}/programme`, { programme: null })).status, 200);
  const ownerList = (await as('owner', 'GET', '/api/v1/tokens')).body.tokens;
  assert.equal(ownerList.find((t: { id: string }) => t.id === minted.body.id).via, 'programme');
  assert.equal(ownerList.find((t: { id: string }) => t.id === owners.body.id).via, null);
});

test('lw tokens add, list and revoke --programme run through the manager\'s routes', async () => {
  const ownerToken = await as('owner', 'POST', '/api/v1/tokens', { label: 'cli', role: 'owner' });
  assert.equal(ownerToken.status, 201);
  const home = await mkdtemp(join(tmpdir(), 'lw-programme-tokens-cli-'));
  const lw = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--base', base], { env: { ...process.env, HOME: home, LW_TOKEN: ownerToken.body.token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const added = await lw(['tokens', 'add', '--programme', 'resellers', '--company', 'northwind', '--label', 'cli agent', '--ttl-days', '30']);
    assert.equal(added.code, 0, added.stderr);
    assert.match(added.stdout, /programme resellers\/northwind\s+scopes render,catalog\.read/);
    assert.match(added.stdout, /token \(shown once, hand it to the partner now\): lwt_/);
    const id = /^(tok_\S+)/m.exec(added.stdout)![1]!;
    const listed = await lw(['tokens', 'list', '--programme', 'resellers', '--company', 'northwind']);
    assert.equal(listed.code, 0, listed.stderr);
    assert.match(listed.stdout, new RegExp(`${id}\\s+cli agent\\s+company northwind`));
    const limited = await lw(['tokens', 'limits', id, '--programme', 'resellers', '--renders-per-day', '25']);
    assert.equal(limited.code, 0, limited.stderr);
    assert.match(limited.stdout, /renders a day\s+25\s+used 0\s+\(from the token\)/);
    const revoked = await lw(['tokens', 'revoke', id, '--programme', 'resellers']);
    assert.equal(revoked.code, 0, revoked.stderr);
    assert.ok((await store.getApiToken(id))!.revokedAt);
  } finally { await rm(home, { recursive: true, force: true }); }
});
