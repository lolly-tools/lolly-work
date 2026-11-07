// SPDX-License-Identifier: MPL-2.0
/**
 * What a programme's tokens did, counted (plans/82 M7 section 7), over the real
 * app. Pinned here:
 *
 *  - calls, renders by tool, format and state, batches with rows, approval
 *    requests by state, and refusals by stable code, per token, by day or week,
 *    with totals per company and per programme;
 *  - nothing a render was asked to say ever reaches the answer or its CSV;
 *  - a manager of one programme reads only that programme's counts.
 */
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
import { createMetrics } from '../server/src/observability/metrics.ts';
import { createApproval } from '../server/src/approvals/engine.ts';
import { readWindow, usageCsv, weekOf } from '../server/src/programmes/usage-routes.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const SECRET = 'Codename Bluebird launch';
let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let runner: RenderRunner | undefined;
const cookies: Record<string, string> = {};
const tokens: Record<string, { id: string; token: string }> = {};

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-programme-usage-'));
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({ id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] }, inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' }] }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>{{title}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  store = createMemoryStore();
  await store.putChain({ id: 'partner-review', name: 'Partner review', steps: [{ name: 'Brand team', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Usage', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'bruno@test', groups: [] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), metrics: createMetrics(), secrets: { session: 'sU', link: 'lU' },
    onRenderRunner: (r) => { runner = r; r.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const who of ['owner', 'bruno']) {
    const login = await fetch(`${base}/api/auth/dev?email=${who}@test`, { redirect: 'manual' });
    cookies[who] = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  }
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['card'], tokenLimits: { callsPerMinute: 8 } })).status, 201);
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/distributors', { name: 'Distributors', tools: ['card'] })).status, 201);
  for (const [id, name] of [['northwind', 'Northwind IT'], ['globex', 'Globex']]) assert.ok((await as('owner', 'PUT', `/api/v1/programmes/resellers/companies/${id}`, { name })).status < 300);
  const bruno = (await store.listUsers()).find((u) => u.email === 'bruno@test')!;
  await store.putGrant({ principal: `user:${bruno.id}`, action: 'programme.manage', resource: 'programme:distributors', effect: 'allow' });
  for (const [key, company, scopes] of [['rita', 'northwind', ['render', 'catalog.read']], ['gus', 'globex', ['render']]] as const) {
    const made = await as('owner', 'POST', '/api/v1/programmes/resellers/tokens', { label: `${key}'s agent`, company, scopes });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokens[key] = { id: made.body.id, token: made.body.token };
  }

  // Rita's agent: two durable renders, a batch of three, one sync render, an approval request, and a burst over its minute.
  for (let i = 0; i < 2; i++) assert.equal((await bearer('rita', 'POST', '/api/v1/renders', { toolId: 'card', format: 'svg', inputs: { title: SECRET } })).status, 202);
  assert.equal((await bearer('rita', 'POST', '/api/v1/render-batches', { toolId: 'card', format: 'png', rows: [{ key: 'a' }, { key: 'b' }, { key: 'c', inputs: { title: SECRET } }] })).status, 202);
  assert.equal((await bearer('rita', 'POST', '/api/v1/render', { toolId: 'card', format: 'svg', inputs: { title: SECRET } })).status, 200);
  for (let i = 0; i < 40 && (await store.listRenders(`service:svc_${tokens.rita!.id}`, 100, 0)).some((r) => r.state === 'queued' || r.state === 'running'); i++) {
    await runner!.tick();
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  const chain = (await store.getChain('partner-review'))!;
  await store.putApproval(createApproval({ id: 'apr_usage1', subjectType: 'export-review', subjectRef: 'export-review:x', title: SECRET, chain, nominees: [], createdBy: `svc_${tokens.rita!.id}`, now: new Date().toISOString() }));
  for (let i = 0; i < 6; i++) await bearer('rita', 'GET', '/api/v1/discovery/me');
  // Gus's agent asks the MCP for a tool its scopes do not reach: refused with TOKEN_SCOPE, as its audit row records.
  await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens.gus!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'search_assets', arguments: { query: SECRET } } }) });
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

async function as(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const text = await res.text();
  let parsed: Record<string, any> | null = null;
  try { parsed = JSON.parse(text); } catch { /* CSV */ }
  return { status: res.status, body: parsed as Record<string, any>, text, type: res.headers.get('content-type') ?? '' };
}
async function bearer(key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tokens[key]!.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}

test('the window: four weeks by week by default, at most 92 days, weeks start on Monday', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  assert.deepEqual(readWindow(new URL('http://x/'), now), { from: '2026-10-11', to: '2026-11-07', by: 'week' });
  assert.match((readWindow(new URL('http://x/?from=2026-01-01&to=2026-12-31'), now) as { error: string }).error, /at most 92 days/);
  assert.match((readWindow(new URL('http://x/?from=2026-11-08&to=2026-11-07'), now) as { error: string }).error, /not be after/);
  assert.match((readWindow(new URL('http://x/?by=month'), now) as { error: string }).error, /day or week/);
  assert.equal(weekOf('2026-11-07'), '2026-11-02');
  assert.equal(weekOf('2026-11-02'), '2026-11-02');
});

test('a programme\'s counts: per token, by tool, format and state, per company and in all', async () => {
  const res = await as('owner', 'GET', '/api/v1/programmes/resellers/usage?by=day');
  assert.equal(res.status, 200, res.text);
  const rita = res.body.tokens.find((t: { id: string }) => t.id === tokens.rita!.id);
  assert.equal(rita.company, 'northwind');
  assert.equal(rita.label, "rita's agent");
  const t = rita.totals;
  assert.equal(t.renders, 6, 'two renders, three batch rows and one sync render, counted when accepted');
  assert.deepEqual(t.rendersByTool.sort((a: { format: string }, b: { format: string }) => a.format.localeCompare(b.format)), [
    { toolId: 'card', format: 'png', succeeded: 3, failed: 0, cancelled: 0, unfinished: 0 },
    { toolId: 'card', format: 'svg', succeeded: 2, failed: 0, cancelled: 0, unfinished: 0 },
  ], 'a sync render leaves no record, so it is in the day\'s count only');
  assert.deepEqual(t.batches, { count: 1, rows: 3 });
  assert.equal(t.approvals.open, 1);
  assert.ok(t.refusals.RATE_LIMITED >= 1, 'the burst past eight calls a minute');
  assert.ok(t.calls >= 8);
  assert.equal(rita.periods.length, 1);
  assert.equal(rita.periods[0].period, new Date().toISOString().slice(0, 10));
  const gus = res.body.tokens.find((x: { id: string }) => x.id === tokens.gus!.id);
  assert.equal(gus.totals.refusals.TOKEN_SCOPE, 1, 'a refusal a route answered over MCP, from its audit row');
  const companies = Object.fromEntries(res.body.companies.map((c: { id: string; name: string; totals: { renders: number } }) => [c.id, c]));
  assert.equal(companies.northwind.name, 'Northwind IT');
  assert.equal(companies.northwind.totals.renders, 6);
  assert.equal(res.body.totals.renders, 6);
  assert.equal(res.text.includes(SECRET), false, 'nothing a render, a request or a search said reaches the counts');
  const one = await as('owner', 'GET', `/api/v1/programmes/resellers/usage?token=${tokens.gus!.id}`);
  assert.deepEqual(one.body.tokens.map((x: { id: string }) => x.id), [tokens.gus!.id]);
});

test('the CSV holds the same cells, one row per token per period, and never a render\'s words', async () => {
  const res = await as('owner', 'GET', '/api/v1/programmes/resellers/usage?by=day&format=csv');
  assert.equal(res.status, 200);
  assert.match(res.type, /^text\/csv/);
  const lines = res.text.trim().split('\r\n');
  assert.equal(lines[0], 'period,token,label,company,calls,renders,renders_succeeded,renders_failed,renders_cancelled,batches,batch_rows,deliveries,approvals_open,approvals_approved,approvals_rejected,approvals_withdrawn,refused_rate_limited,refused_budget_exhausted,refused_input_locked,refused_token_scope,refused_forbidden,refused_other');
  const row = lines.find((l) => l.includes(tokens.rita!.id))!.split(',');
  assert.equal(row[3], 'northwind');
  assert.equal(row[5], '6');
  assert.equal(row[6], '5');
  assert.equal(res.text.includes(SECRET), false);
  assert.match(usageCsv([{ id: 't', label: '=SUM(A1)', company: null, lastUsedAt: null, expiresAt: null, revokedAt: null, totals: {} as never,
    periods: [{ period: '2026-11-02', calls: 0, renders: 0, rendersByTool: [], batches: { count: 0, rows: 0 }, deliveries: [], approvals: { open: 0, approved: 0, rejected: 0, withdrawn: 0 },
      refusals: { RATE_LIMITED: 0, BUDGET_EXHAUSTED: 0, INPUT_LOCKED: 0, TOKEN_SCOPE: 0, FORBIDDEN: 0, other: 0 } }] }]), /,'=SUM\(A1\),/, 'a label that looks like a formula stays text');
});

test('a manager reads only their own programme\'s counts, and an owner reads one token\'s', async () => {
  assert.equal((await as('bruno', 'GET', '/api/v1/programmes/resellers/usage')).status, 403);
  assert.equal((await as('bruno', 'GET', '/api/v1/programmes/distributors/usage')).status, 200);
  assert.equal((await as('bruno', 'GET', `/api/v1/tokens/${tokens.rita!.id}/usage`)).status, 403);
  const one = await as('owner', 'GET', `/api/v1/tokens/${tokens.rita!.id}/usage?by=week`);
  assert.equal(one.status, 200);
  assert.equal(one.body.token.totals.renders, 6);
  assert.equal(one.body.token.periods[0].period, weekOf(new Date().toISOString().slice(0, 10)));
  assert.equal((await bearer('rita', 'GET', `/api/v1/tokens/${tokens.rita!.id}/usage`)).status, 403, 'a token does not read the admin counts');
});
