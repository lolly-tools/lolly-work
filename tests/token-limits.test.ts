// SPDX-License-Identifier: MPL-2.0
/**
 * Limits and budgets on service tokens (plans/82 M7 section 2), over the real
 * app. Pinned here:
 *
 *  - a token placed in a programme takes the instance default, its programme's
 *    figure or its own, in that order of strength, and says where each comes from;
 *  - an internal token has no limits unless an owner sets some;
 *  - calls past the minute limit answer 429 RATE_LIMITED with Retry-After;
 *  - renders count when accepted, a request that would pass the budget is
 *    refused whole with 429 BUDGET_EXHAUSTED, and an idempotent replay counts nothing;
 *  - one MCP message is one call, a ping is none, and the routes a tool call
 *    dispatches count nothing more;
 *  - admins read every figure, its source and the use against it; the token
 *    reads its own figures and use.
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
import {
  TOKEN_LIMIT_SEED, budgetRefusal, limitsSentence, parseLimitOverrides, rateLimitedRefusal, resolveTokenLimits,
} from '../server/src/iam/token-limits.ts';
import { programmeTokenGroups } from '../server/src/iam/service-tokens.ts';

const CLI = join(fileURLToPath(new URL('.', import.meta.url)), '..', 'cli', 'lw.ts');
const servers: Server[] = [];
let pack = '';
const SVG = '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="{{bg}}"/></svg>';

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-token-limits-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'bg', type: 'color', label: 'Background', default: '#112233' }],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), SVG);
});
after(async () => {
  for (const s of servers) s.close();
  await rm(pack, { recursive: true, force: true });
});

// ── the rules, without a server ─────────────────────────────────────────────

test('the instance seed is 120 calls a minute, 2,000 renders a day and no monthly cap', () => {
  assert.deepEqual({ ...TOKEN_LIMIT_SEED }, { callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null });
  const config = parseConfig(JSON.stringify({ instance: { name: 'x', baseUrl: 'http://localhost', pack: '/tmp' }, dev: { enabled: true, users: [] } }));
  assert.deepEqual(config.automation.tokenLimits, { callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null });
  assert.throws(() => parseConfig(JSON.stringify({ instance: { name: 'x', baseUrl: 'http://localhost', pack: '/tmp' }, dev: { enabled: true, users: [] },
    automation: { tokenLimits: { rendersPerDay: 0 } } })), /rendersPerDay must be a whole number from 1/);
});

test('the token wins, then the programme, then the instance; an internal token has none', () => {
  const instance = { callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null };
  const placed = { groups: programmeTokenGroups('resellers', 'northwind') };
  assert.deepEqual(resolveTokenLimits({}, null, instance), {
    limits: { callsPerMinute: null, rendersPerDay: null, rendersPerMonth: null }, sources: { callsPerMinute: 'none', rendersPerDay: 'none', rendersPerMonth: 'none' } });
  assert.deepEqual(resolveTokenLimits({ limits: { rendersPerDay: 50 } }, null, instance).limits, { callsPerMinute: null, rendersPerDay: 50, rendersPerMonth: null });
  assert.deepEqual(resolveTokenLimits(placed, null, instance), {
    limits: instance, sources: { callsPerMinute: 'instance', rendersPerDay: 'instance', rendersPerMonth: 'instance' } });
  assert.deepEqual(resolveTokenLimits(placed, { tokenLimits: { rendersPerDay: 500, rendersPerMonth: 5000 } }, instance), {
    limits: { callsPerMinute: 120, rendersPerDay: 500, rendersPerMonth: 5000 }, sources: { callsPerMinute: 'instance', rendersPerDay: 'programme', rendersPerMonth: 'programme' } });
  assert.deepEqual(resolveTokenLimits({ ...placed, limits: { rendersPerDay: null } }, { tokenLimits: { rendersPerDay: 500 } }, instance), {
    limits: { callsPerMinute: 120, rendersPerDay: null, rendersPerMonth: null }, sources: { callsPerMinute: 'instance', rendersPerDay: 'token', rendersPerMonth: 'instance' } });
  // A token that left its programme keeps the partner marker, so it keeps the instance default.
  assert.equal(resolveTokenLimits({ groups: ['partner'] }, null, instance).sources.callsPerMinute, 'instance');
});

test('a statement of limits is checked and kept in one key order', () => {
  assert.deepEqual(parseLimitOverrides({ rendersPerMonth: null, callsPerMinute: 60 }), { callsPerMinute: 60, rendersPerMonth: null });
  assert.deepEqual(Object.keys(parseLimitOverrides({ rendersPerMonth: 1, callsPerMinute: 1 })), ['callsPerMinute', 'rendersPerMonth']);
  assert.match((parseLimitOverrides({ calls: 1 }) as { error: string }).error, /not calls/);
  assert.match((parseLimitOverrides({ rendersPerDay: 0 }) as { error: string }).error, /from 1 to/);
  assert.match((parseLimitOverrides({ rendersPerDay: 1.5 }) as { error: string }).error, /whole number/);
  assert.match((parseLimitOverrides({ callsPerMinute: 100_001 }) as { error: string }).error, /from 1 to 100000/);
  assert.match((parseLimitOverrides([]) as { error: string }).error, /must be an object/);
  assert.match((parseLimitOverrides(JSON.parse('{"__proto__": 5}')) as { error: string }).error, /not __proto__/);
});

test('the refusals say what the limit is and when to try again', () => {
  const limited = rateLimitedRefusal(120, 12);
  assert.equal(limited.status, 429);
  assert.deepEqual({ code: limited.code, message: limited.message, ...limited.detail }, {
    code: 'RATE_LIMITED', message: 'This token may make 120 calls a minute. Try again in 12 seconds.', limit: 120, window: 'minute', retryAfterSec: 12 });
  assert.equal(rateLimitedRefusal(10, 1).message, 'This token may make 10 calls a minute. Try again in 1 second.');
  const at = Date.parse('2026-11-07T22:00:00Z');
  const spent = budgetRefusal({ ok: false, period: 'day', used: 2000, limit: 2000 }, 1, at);
  assert.deepEqual({ code: spent.code, message: spent.message, ...spent.detail }, {
    code: 'BUDGET_EXHAUSTED', message: 'This token has used its 2,000 renders for today. The budget renews at 00:00 UTC.',
    limit: 2000, period: 'day', used: 2000, remaining: 0, resetsAt: '2026-11-08T00:00:00Z' });
  assert.equal(spent.retryAfterSec, 7200);
  const crossing = budgetRefusal({ ok: false, period: 'day', used: 1990, limit: 2000 }, 20, at);
  assert.equal(crossing.message, 'This request needs 20 renders and this token has 10 left today. Nothing was started. The budget renews at 00:00 UTC.');
  assert.deepEqual(crossing.detail, { limit: 2000, period: 'day', used: 1990, remaining: 10, requested: 20, resetsAt: '2026-11-08T00:00:00Z' });
  const month = budgetRefusal({ ok: false, period: 'month', used: 50000, limit: 50000 }, 1, at);
  assert.equal(month.message, 'This token has used its 50,000 renders for this month. The budget renews at 00:00 UTC on 1 December.');
  assert.equal(month.detail.resetsAt, '2026-12-01T00:00:00Z');
});

test('one sentence names the limits for an agent', () => {
  assert.equal(limitsSentence({ callsPerMinute: 120, rendersPerDay: 2000, rendersPerMonth: null }),
    'This token may make 120 calls a minute and 2,000 renders a day, with no monthly cap. A call over a limit is refused with RATE_LIMITED or BUDGET_EXHAUSTED and says when to try again.');
  assert.equal(limitsSentence({ callsPerMinute: null, rendersPerDay: null, rendersPerMonth: 9000 }),
    'This token may make any number of calls a minute and any number of renders a day and 9,000 renders a month. A call over a limit is refused with RATE_LIMITED or BUDGET_EXHAUSTED and says when to try again.');
  assert.equal(limitsSentence({ callsPerMinute: null, rendersPerDay: null, rendersPerMonth: null }), 'This token has no call or render limits.');
});

// ── over the real app ───────────────────────────────────────────────────────

async function boot(tokenLimits: Record<string, number | null> = { callsPerMinute: 6, rendersPerDay: 3, rendersPerMonth: null }) {
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Limits', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    automation: { tokenLimits },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), metrics: createMetrics(), secrets: { session: 'sT', link: 'lT' },
    onRenderRunner: (r) => { r.kick = () => {}; } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const asOwner = async (path: string, method = 'GET', body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  assert.equal((await asOwner('/api/v1/programmes/resellers', 'PUT', { name: 'Resellers, EMEA', tools: ['card'] })).status, 201);
  assert.equal((await asOwner('/api/v1/programmes/resellers/companies/northwind', 'PUT', { name: 'Northwind IT' })).status < 300, true);
  const mint = async (label: string, placed: boolean, body: Record<string, unknown> = {}) => {
    const made = await asOwner('/api/v1/tokens', 'POST', { label, scopes: ['render', 'catalog.read'], ...body });
    assert.equal(made.status, 201, JSON.stringify(made.body));
    if (placed) assert.equal((await asOwner(`/api/v1/tokens/${made.body.id}/programme`, 'PUT', { programme: 'resellers', company: 'northwind' })).status, 200);
    return made.body as { id: string; token: string };
  };
  const as = (secret: string) => async (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) => {
    const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json().catch(() => null) as Record<string, any> };
  };
  const tokenView = async (id: string) => (await asOwner('/api/v1/tokens')).body.tokens.find((t: { id: string }) => t.id === id);
  return { base, store, asOwner, mint, as, tokenView };
}

test('a programme token takes the instance default and is braked past its minute limit', async () => {
  const app = await boot();
  const agent = await app.mint('Northwind agent', true);
  const call = app.as(agent.token);
  for (let i = 0; i < 6; i++) assert.equal((await call('/api/v1/discovery/me')).status, 200, `call ${i + 1} of 6`);
  const over = await call('/api/v1/discovery/me');
  assert.equal(over.status, 429);
  assert.ok(Number(over.retryAfter) >= 1, 'Retry-After is sent');
  assert.deepEqual(over.body, { error: { code: 'RATE_LIMITED', message: `This token may make 6 calls a minute. Try again in ${over.retryAfter === '1' ? '1 second' : `${over.retryAfter} seconds`}.`,
    limit: 6, window: 'minute', retryAfterSec: Number(over.retryAfter) } });
  // A route outside the automation surface is not a call, so the catalog still answers.
  assert.equal((await fetch(`${app.base}/catalog/assets/index.json`, { headers: { authorization: `Bearer ${agent.token}` } })).status, 200);

  const view = await app.tokenView(agent.id);
  assert.deepEqual(view.limits, { callsPerMinute: 6, rendersPerDay: 3, rendersPerMonth: null });
  assert.deepEqual(view.limitSources, { callsPerMinute: 'instance', rendersPerDay: 'instance', rendersPerMonth: 'instance' });
  assert.equal(view.usage.today.calls, 6);
  assert.equal(view.usage.today.busiestMinute >= 1, true);
  assert.equal(view.usage.week.rateLimited, 1);
  assert.equal(view.usage.lastRefusal.code, 'RATE_LIMITED');
  assert.match(view.usage.resetsAt, /T00:00:00\.000Z$/);
});

test('an internal token has no limits unless an owner sets some, and its use is still counted', async () => {
  const app = await boot({ callsPerMinute: 2, rendersPerDay: 1, rendersPerMonth: null });
  const ci = await app.mint('ci', false);
  const call = app.as(ci.token);
  for (let i = 0; i < 5; i++) assert.equal((await call('/api/v1/discovery/me')).status, 200);
  for (let i = 0; i < 3; i++) assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' })).status, 202);
  const view = await app.tokenView(ci.id);
  assert.deepEqual(view.limits, { callsPerMinute: null, rendersPerDay: null, rendersPerMonth: null });
  assert.deepEqual(view.limitSources, { callsPerMinute: 'none', rendersPerDay: 'none', rendersPerMonth: 'none' });
  assert.equal(view.usage.today.calls, 8);
  assert.equal(view.usage.today.renders, 3);

  // An owner sets one figure on the token, and only that figure applies.
  const set = await app.asOwner(`/api/v1/tokens/${ci.id}/limits`, 'PUT', { limits: { rendersPerDay: 4 } });
  assert.equal(set.status, 200, JSON.stringify(set.body));
  assert.deepEqual(set.body.limitSources, { callsPerMinute: 'none', rendersPerDay: 'token', rendersPerMonth: 'none' });
  assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' })).status, 202);
  assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' })).body.error.code, 'BUDGET_EXHAUSTED');
  const audit = (await app.store.listAudit()) as Array<{ action: string; payload?: Record<string, unknown> }>;
  const row = audit.find((a) => a.action === 'token.limits');
  assert.deepEqual(row?.payload, { before: {}, after: { rendersPerDay: 4 } });
  assert.equal((await app.asOwner(`/api/v1/tokens/${ci.id}/limits`, 'PUT', { limits: { rendersPerDay: -1 } })).status, 400);
  assert.equal((await app.asOwner(`/api/v1/tokens/${ci.id}/limits`, 'PUT', { limits: null })).body.limitOverrides && true, true);
  assert.deepEqual((await app.tokenView(ci.id)).limitOverrides, {});
  // A scoped token cannot change its own limits.
  assert.equal((await call(`/api/v1/tokens/${ci.id}/limits`, 'PUT', { limits: {} })).status, 403);
});

test('a programme states its tokens\' figures, and editing it keeps the templates-only switch', async () => {
  const app = await boot();
  const agent = await app.mint('Northwind agent', true);
  const programme = (await app.store.getProgramme('resellers'))!;
  await app.store.putProgramme({ ...programme, templatesOnly: ['card'] });
  const put = await app.asOwner('/api/v1/programmes/resellers', 'PUT', { name: 'Resellers, EMEA', tokenLimits: { rendersPerDay: 1, rendersPerMonth: 30 } });
  assert.equal(put.status, 200, JSON.stringify(put.body));
  assert.deepEqual(put.body.tokenLimitDefaults, {
    limits: { callsPerMinute: 6, rendersPerDay: 1, rendersPerMonth: 30 }, sources: { callsPerMinute: 'instance', rendersPerDay: 'programme', rendersPerMonth: 'programme' } });
  assert.deepEqual((await app.store.getProgramme('resellers'))!.templatesOnly, ['card'], 'an edit that does not name the switch keeps it');
  const view = await app.tokenView(agent.id);
  assert.deepEqual(view.limitSources, { callsPerMinute: 'instance', rendersPerDay: 'programme', rendersPerMonth: 'programme' });
  // A body without tokenLimits keeps them; null returns them to the instance.
  await app.asOwner('/api/v1/programmes/resellers', 'PUT', { name: 'Resellers' });
  assert.deepEqual((await app.store.getProgramme('resellers'))!.tokenLimits, { rendersPerDay: 1, rendersPerMonth: 30 });
  await app.asOwner('/api/v1/programmes/resellers', 'PUT', { name: 'Resellers', tokenLimits: null });
  assert.equal((await app.store.getProgramme('resellers'))!.tokenLimits, undefined);
  assert.equal((await app.asOwner('/api/v1/programmes/resellers', 'PUT', { name: 'Resellers', tokenLimits: { callsPerMinute: 0 } })).status, 400);
  const audits = (await app.store.listAudit()) as Array<{ action: string; payload?: Record<string, unknown> }>;
  const limits = audits.filter((a) => a.action === 'programme.limits').map((a) => a.payload);
  assert.equal(limits.length, 2, 'one row per change, none for an edit that keeps them');
  assert.ok(limits.some((p) => JSON.stringify(p) === JSON.stringify({ before: {}, after: { rendersPerDay: 1, rendersPerMonth: 30 } })));
  assert.ok(limits.some((p) => JSON.stringify(p) === JSON.stringify({ before: { rendersPerDay: 1, rendersPerMonth: 30 }, after: {} })));
});

test('renders count when accepted: a request the budget cannot hold is refused whole, and a replay counts nothing', async () => {
  const app = await boot({ callsPerMinute: 100, rendersPerDay: 3, rendersPerMonth: null });
  const agent = await app.mint('Northwind agent', true);
  const call = app.as(agent.token);
  const first = await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' }, { 'idempotency-key': 'one' });
  assert.equal(first.status, 202);
  assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' }, { 'idempotency-key': 'one' })).status, 200, 'a replay');
  // Two rows with two renders left fits; then a batch of two with one left is refused whole.
  assert.equal((await call('/api/v1/render-batches', 'POST', { toolId: 'card', format: 'svg', rows: [{ key: 'a' }] })).status, 202);
  const before = (await app.tokenView(agent.id)).usage.today.renders;
  assert.equal(before, 2);
  const batch = await call('/api/v1/render-batches', 'POST', { toolId: 'card', format: 'svg', rows: [{ key: 'b' }, { key: 'c' }] });
  assert.equal(batch.status, 429);
  assert.equal(batch.body.error.code, 'BUDGET_EXHAUSTED');
  assert.equal(batch.body.error.remaining, 1);
  assert.equal(batch.body.error.requested, 2);
  assert.equal(batch.body.error.period, 'day');
  assert.ok(Number(batch.retryAfter) >= 1);
  assert.equal((await call('/api/v1/render-batches')).body.batches.length, 1, 'nothing of the refused batch was started');
  // The last render fits; the next one is refused, and the replay of the first still answers.
  assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' })).status, 202);
  const spent = await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' });
  assert.equal(spent.status, 429);
  assert.equal(spent.body.error.message, 'This token has used its 3 renders for today. The budget renews at 00:00 UTC.');
  assert.equal((await call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' }, { 'idempotency-key': 'one' })).status, 200, 'a replay after the budget is spent');
  // The job route counts too, and a sync render is one render.
  assert.equal((await call('/api/v1/render', 'POST', { toolId: 'card', format: 'svg' })).body.error.code, 'BUDGET_EXHAUSTED');
  assert.equal((await call('/api/v1/batch', 'POST', { toolId: 'card', format: 'svg', rows: [{}] })).body.error.code, 'BUDGET_EXHAUSTED');
  const view = await app.tokenView(agent.id);
  assert.equal(view.usage.today.renders, 3);
  assert.equal(view.usage.week.budgetRefused, 4);
  assert.equal(view.usage.lastRefusal.code, 'BUDGET_EXHAUSTED');
});

test('a sync render counts one, and a monthly cap refuses with the month in its words', async () => {
  const app = await boot({ callsPerMinute: null, rendersPerDay: null, rendersPerMonth: 1 });
  const agent = await app.mint('Northwind agent', true);
  const call = app.as(agent.token);
  const res = await fetch(`${app.base}/api/v1/render`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'card', format: 'svg' }) });
  assert.equal(res.status, 200, await res.clone().text());
  const again = await call('/api/v1/render', 'POST', { toolId: 'card', format: 'svg' });
  assert.equal(again.status, 429);
  assert.equal(again.body.error.period, 'month');
  assert.match(again.body.error.message, /^This token has used its 1 renders for this month\. The budget renews at 00:00 UTC on 1 [A-Z][a-z]+\.$/);
});

test('the token reads its own limits and use, never where they come from', async () => {
  const app = await boot();
  const agent = await app.mint('Northwind agent', true);
  await app.as(agent.token)('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg' });
  const me = await app.as(agent.token)('/api/v1/discovery/me');
  assert.deepEqual(me.body.limits.token, { callsPerMinute: 6, rendersPerDay: 3, rendersPerMonth: null });
  assert.equal(me.body.usage.today.renders, 1);
  assert.equal(me.body.usage.today.calls, 2, 'the render and this call itself, counted before it answers');
  assert.equal(JSON.stringify(me.body).includes('instance'), false, 'no source in the token\'s own view');
  // A person has no token limits.
  const person = await app.asOwner('/api/v1/discovery/me');
  assert.equal(person.body.limits.token, undefined);
  assert.equal(person.body.usage, undefined);
});

test('over MCP one message is one call, a ping is none, and a refusal arrives in the tool result', async () => {
  const app = await boot({ callsPerMinute: 4, rendersPerDay: 3, rendersPerMonth: null });
  const agent = await app.mint('Northwind agent', true);
  let id = 0;
  const rpc = async (method: string, params?: unknown) => {
    const res = await fetch(`${app.base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${agent.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: ++id, method, ...(params === undefined ? {} : { params }) }) });
    return { status: res.status, retryAfter: res.headers.get('retry-after'), body: await res.json() as Record<string, any> };
  };
  const init = await rpc('initialize', { protocolVersion: '2025-11-25', capabilities: {}, clientInfo: { name: 'test-agent', version: '1' } });
  assert.match(init.body.result.instructions, /This token may make 4 calls a minute and 3 renders a day, with no monthly cap\./);
  await rpc('ping');
  await rpc('ping');
  assert.ok((await rpc('tools/list')).body.result.tools.length > 0, 'tools/list dispatches discovery/me inside and counts once');
  const made = await rpc('tools/call', { name: 'render_tool', arguments: { toolId: 'card', format: 'svg' } });
  assert.equal(made.body.result.isError, undefined, JSON.stringify(made.body));
  const view = await app.tokenView(agent.id);
  assert.equal(view.usage.today.calls, 3, 'initialize, tools/list and one tool call; pings and inner routes count nothing');
  assert.equal(view.usage.today.renders, 1);
  assert.equal((await rpc('tools/call', { name: 'validate', arguments: { toolId: 'card' } })).body.result.isError, undefined);
  const over = await rpc('tools/call', { name: 'validate', arguments: { toolId: 'card' } });
  assert.equal(over.status, 200);
  assert.ok(Number(over.retryAfter) >= 1);
  assert.equal(over.body.result.isError, true);
  assert.equal(over.body.result.structuredContent.code, 'RATE_LIMITED');
  assert.equal(over.body.result.structuredContent.status, 429);
  assert.equal(over.body.result.structuredContent.limit, 4);
  const listed = await rpc('tools/list');
  assert.equal(listed.body.error.code, -32000);
  assert.equal(listed.body.error.data.code, 'RATE_LIMITED');
  assert.equal((await rpc('ping')).body.result !== undefined, true, 'a ping is never refused');
  const audit = (await app.store.listAudit()) as Array<{ action: string; payload?: Record<string, unknown> }>;
  assert.ok(audit.some((a) => a.action === 'mcp.tool-call' && a.payload?.code === 'RATE_LIMITED' && a.payload?.tool === 'validate'), 'the refusal is in the audit trail');
});

test('lw tokens limits and lw programmes limits read and set the figures', async () => {
  const app = await boot();
  const agent = await app.mint('Northwind agent', true);
  const owner = await app.mint('owner-cli', false, { scopes: undefined, role: 'owner' });
  const home = await mkdtemp(join(tmpdir(), 'lw-limits-cli-'));
  const lw = (args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args, '--base', app.base], { env: { ...process.env, HOME: home, LW_TOKEN: owner.token } });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d: Buffer) => { stdout += d; });
    child.stderr.on('data', (d: Buffer) => { stderr += d; });
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
  try {
    const shown = await lw(['tokens', 'limits', agent.id]);
    assert.equal(shown.code, 0, shown.stderr);
    assert.match(shown.stdout, /calls a minute\s+6\s+\(from the instance\)/);
    const set = await lw(['tokens', 'limits', agent.id, '--renders-per-day', '10', '--renders-per-month', 'none']);
    assert.equal(set.code, 0, set.stderr);
    assert.match(set.stdout, /renders a day\s+10\s+used 0\s+\(from the token\)/);
    assert.match(set.stdout, /renders a month\s+no cap\s+used 0\s+\(from the token\)/);
    assert.deepEqual((await app.tokenView(agent.id)).limitOverrides, { rendersPerDay: 10, rendersPerMonth: null });
    assert.equal((await lw(['tokens', 'limits', agent.id, '--renders-per-day', 'default'])).code, 0);
    assert.deepEqual((await app.tokenView(agent.id)).limitOverrides, { rendersPerMonth: null });
    const programme = await lw(['programmes', 'limits', 'resellers', '--calls-per-minute', '30']);
    assert.equal(programme.code, 0, programme.stderr);
    assert.match(programme.stdout, /calls a minute\s+30\s+\(from the programme\)/);
    assert.equal((await lw(['tokens', 'limits', agent.id, '--calls-per-minute', 'lots'])).code, 1);
  } finally { await rm(home, { recursive: true, force: true }); }
});
