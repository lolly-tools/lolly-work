// SPDX-License-Identifier: MPL-2.0
/**
 * Scoped service tokens over the real app. Pinned here:
 *
 *  - a scope only narrows: a route must pass the scope table and the role;
 *  - the automation role renders without the admin role's other authority;
 *  - a token with no scopes behaves as it did before scopes existed;
 *  - every route the app registers is either in the table on purpose or refuses
 *    a scoped token before its handler runs, so a new route stays out of reach;
 *  - revocation stops a scoped token on the next use and stops its queued work.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { appRouteDescriptions, buildApp } from '../server/src/api/app.ts';
import { createRouter, sendJson } from '../server/src/api/router.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import { ROLES } from '../server/src/rbac/evaluate.ts';
import {
  TOKEN_ROLES, TOKEN_SCOPES, TOKEN_SCOPES_VERSION, parseTokenAuthority, routeScopes, scopedRouteKeys,
  scopesAllowRoute, scopesCoverAction, tokenScopeGuard, tokenScopeVocabulary,
} from '../server/src/iam/token-scopes.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const servers: Server[] = [];
let pack = '';

const toolJson = (id: string) => JSON.stringify({
  id, name: id, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
  render: { width: 100, height: 100, formats: ['svg', 'png'] },
  inputs: [{ id: 'bg', type: 'color', label: 'Background', default: '#112233' }],
});

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-token-scopes-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }, { id: 'other' }] }));
  for (const id of ['card', 'other']) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), toolJson(id));
    await writeFile(join(pack, 'tools', id, 'template.html'),
      '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="{{bg}}"/></svg>');
  }
});
after(async () => {
  for (const s of servers) s.close();
  await rm(pack, { recursive: true, force: true });
});

async function boot() {
  const store = createMemoryStore();
  const metrics = createMetrics();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Scopes', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  let runner: RenderRunner | undefined;
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), metrics, secrets: { session: 'sT', link: 'lT' },
    onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const owner = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const asOwner = (path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { cookie: owner, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const mint = async (body: Record<string, unknown>) => {
    const res = await asOwner('/api/v1/tokens', 'POST', { label: 'ci', ...body });
    assert.equal(res.status, 201, await res.clone().text());
    return await res.json() as { id: string; token: string; role: string; scopes: string[] | null; tools: string[] | null };
  };
  const as = (token: string, path: string, method = 'GET', body?: unknown) => fetch(`${base}${path}`, {
    method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  return { app, base, store, metrics, asOwner, mint, as, tick: () => runner!.tick() };
}

const code = async (res: Response) => ((await res.json()) as { error?: { code?: string } }).error?.code;
const renderBody = { toolId: 'card', format: 'svg', inputs: { bg: '#445566' } };

test('the vocabulary is closed and versioned, and the automation role is for tokens only', () => {
  assert.equal(TOKEN_SCOPES_VERSION, 1);
  assert.deepEqual(tokenScopeVocabulary().scopes.map((s) => s.id), [...TOKEN_SCOPES]);
  for (const scope of tokenScopeVocabulary().scopes) assert.ok(scope.label && scope.description, `${scope.id} has plain words`);
  assert.ok(!(ROLES as readonly string[]).includes('automation'), 'no person can be given this role');
  assert.ok(TOKEN_ROLES.includes('automation'));
  assert.ok(!TOKEN_ROLES.includes('guest'));
});

test('parsing a mint request', () => {
  assert.deepEqual(parseTokenAuthority({ scopes: ['files', 'render', 'render'] }), { role: 'automation', scopes: ['render', 'files'] });
  assert.deepEqual(parseTokenAuthority({ role: 'admin' }), { role: 'admin' });
  assert.deepEqual(parseTokenAuthority({ role: 'viewer', scopes: ['catalog.read'] }), { role: 'viewer', scopes: ['catalog.read'] });
  assert.deepEqual(parseTokenAuthority({ scopes: ['render'], tools: ['b', 'a', 'a'] }), { role: 'automation', scopes: ['render'], tools: ['a', 'b'] });
  const refused: Array<Record<string, unknown> | null> = [
    null, {}, { role: 'guest' }, { role: 'automation' },
    { scopes: [] }, { scopes: 'render' }, { scopes: ['everything'] }, { scopes: ['__proto__'] },
    { role: 'guest', scopes: ['render'] },
    { role: 'admin', tools: ['card'] },
    { scopes: ['audit.read'], tools: ['card'] },
    { scopes: ['render'], tools: [] },
    { scopes: ['render'], tools: ['../secret'] },
    { scopes: ['render'], tools: Array.from({ length: 65 }, (_, i) => `t${i}`) },
  ];
  for (const body of refused) assert.ok('error' in parseTokenAuthority(body), JSON.stringify(body));
});

test('a render token renders without the admin role, and reaches nothing else', async () => {
  const t = await boot();
  const { token, role, scopes } = await t.mint({ scopes: ['render'] });
  assert.equal(role, 'automation');
  assert.deepEqual(scopes, ['render']);

  const rendered = await t.as(token, '/api/v1/render', 'POST', renderBody);
  assert.equal(rendered.status, 200, await rendered.clone().text());
  assert.match(await rendered.text(), /<svg/);

  const schema = await t.as(token, '/api/v1/schema/card');
  assert.equal(schema.status, 200);
  assert.equal(((await schema.json()) as { unavailable: Array<{ code: string }> }).unavailable.some((u) => u.code === 'FORBIDDEN'), false);
  assert.equal((await t.as(token, '/api/v1/discovery/tools')).status, 200);
  assert.equal((await t.as(token, '/api/v1/validate', 'POST', { toolId: 'card', inputs: {} })).status, 200);

  const submitted = await t.as(token, '/api/v1/renders', 'POST', renderBody);
  assert.equal(submitted.status, 202, await submitted.clone().text());
  const job = await submitted.json() as { id: string };
  await t.tick();
  for (let i = 0; i < 100; i++) {
    const state = (await (await t.as(token, `/api/v1/renders/${job.id}`)).json() as { state: string }).state;
    if (state === 'succeeded') break;
    assert.notEqual(state, 'failed');
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.tick();
  }
  assert.equal((await t.as(token, `/api/v1/renders/${job.id}/output/default`)).status, 200);

  const batch = await t.as(token, '/api/v1/render-batches', 'POST', { toolId: 'card', format: 'svg', inputs: {}, rows: [{ key: 'one', inputs: { bg: '#000000' } }] });
  assert.equal(batch.status, 202, await batch.clone().text());

  const refusal = await t.as(token, '/api/v1/compile', 'POST', { toolId: 'card', inputs: {} });
  assert.equal(refusal.status, 403);
  const refused = await refusal.json() as { error: { code: string; requiredScopes?: string[] } };
  assert.equal(refused.error.code, 'TOKEN_SCOPE');
  assert.deepEqual(refused.error.requiredScopes, ['documents'], 'a declared route says which scope opens it');

  for (const [path, method] of [['/api/v1/audit', 'GET'], ['/api/v1/uploads', 'GET'], ['/api/v1/deliveries', 'GET'], ['/catalog/tools/index.json', 'GET'], ['/api/v1/tokens', 'GET'], ['/api/v1/approvals', 'GET'], ['/api/v1/users', 'GET']] as const) {
    const res = await t.as(token, path, method);
    assert.equal(res.status, 403, path);
    assert.equal(await code(res), 'TOKEN_SCOPE', path);
  }
});

test('each scope reaches its own routes on the automation role', async () => {
  const t = await boot();
  const documents = await t.mint({ scopes: ['documents'] });
  for (const verb of ['compile', 'validate', 'package']) {
    assert.equal((await t.as(documents.token, `/api/v1/${verb}`, 'POST', { toolId: 'card', inputs: {} })).status, 200, verb);
  }
  assert.notEqual(await code(await t.as(documents.token, '/api/v1/diff', 'POST', {})), 'TOKEN_SCOPE');
  const job = await t.as(documents.token, '/api/v1/compile?async=1', 'POST', { toolId: 'card', inputs: {} });
  assert.equal(job.status, 202, await job.clone().text());
  assert.equal((await t.as(documents.token, '/api/v1/jobs')).status, 200);

  const files = await t.mint({ scopes: ['files'] });
  assert.notEqual(await code(await t.as(files.token, '/api/v1/uploads')), 'TOKEN_SCOPE');
  assert.notEqual(await code(await t.as(files.token, '/api/v1/files')), 'TOKEN_SCOPE');

  const delivery = await t.mint({ scopes: ['delivery'] });
  assert.equal((await t.as(delivery.token, '/api/v1/destinations')).status, 200);
  assert.equal((await t.as(delivery.token, '/api/v1/deliveries')).status, 200);
  const noJob = await t.as(delivery.token, '/api/v1/jobs/none/deliveries', 'POST', { destinationId: 'none' });
  assert.notEqual(await code(noJob), 'TOKEN_SCOPE', 'a job send passes the scope, then the route decides');
  assert.equal(await code(await t.as(delivery.token, '/api/v1/destinations/none/deliveries', 'POST', {})), 'TOKEN_SCOPE', 'sending a raw body is not in this scope');

  const catalog = await t.mint({ scopes: ['catalog.read'] });
  assert.equal((await t.as(catalog.token, '/catalog/tools/index.json')).status, 200);
  for (const path of ['fields', 'search?q=x']) {
    assert.equal((await t.as(catalog.token, `/api/v1/catalog/${path}`)).status, 200, path);
  }
  assert.equal(await code(await t.as(catalog.token, '/api/v1/catalog/collections')), 'TOKEN_SCOPE', 'curating collections is not reading the catalog');

  const audit = await t.mint({ scopes: ['audit.read'] });
  assert.equal((await t.as(audit.token, '/api/v1/audit')).status, 200);
  assert.equal((await t.as(audit.token, '/api/v1/audit/head')).status, 200);
  assert.equal(await code(await t.as(audit.token, '/api/v1/schema/card')), 'TOKEN_SCOPE');
});

test('an MCP tool outside the token\'s scopes is absent, and refused when called by name', async () => {
  const t = await boot();
  const { token } = await t.mint({ scopes: ['catalog.read'] });
  const rpc = async (method: string, params?: unknown) => {
    const res = await t.as(token, '/api/v1/mcp', 'POST', { jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) });
    return (await res.json()) as { result: { tools: Array<{ name: string }>; isError?: boolean; content: Array<{ text: string }> } };
  };
  assert.deepEqual((await rpc('tools/list')).result.tools.map((tool) => tool.name), ['search_assets']);
  for (const [name, args] of [['render_tool', { toolId: 'card', format: 'svg' }], ['list_tools', {}], ['describe_tool', { toolId: 'card' }], ['get_batch', { batchId: 'rbt_x' }]] as const) {
    const { result } = await rpc('tools/call', { name, arguments: args });
    assert.equal(result.isError, true, name);
    const refusal = JSON.parse(result.content[0]!.text) as { code: string; status: number };
    assert.equal(refusal.code, 'TOKEN_SCOPE', name);
    assert.equal(refusal.status, 403, name);
  }
  assert.equal(await code(await t.as(token, '/api/v1/renders', 'POST', renderBody)), 'TOKEN_SCOPE', 'HTTP refuses the same way');
});

test('a scope never widens: the route opens, then the role still decides', async () => {
  const t = await boot();
  const viewer = await t.mint({ role: 'viewer', scopes: ['render'] });
  const viewerRender = await t.as(viewer.token, '/api/v1/render', 'POST', renderBody);
  assert.equal(viewerRender.status, 403);
  assert.equal(await code(viewerRender), 'FORBIDDEN', 'the scope opened the route and the role refused');

  const member = await t.mint({ role: 'member', scopes: ['audit.read'] });
  const audit = await t.as(member.token, '/api/v1/audit');
  assert.equal(audit.status, 403);
  assert.equal(await code(audit), 'FORBIDDEN');

  const automation = await t.mint({ scopes: ['render'] });
  const denied = await t.asOwner('/api/v1/grants', 'POST', { principal: `user:svc_${automation.id}`, action: 'export.server', resource: '*', effect: 'deny' });
  assert.ok(denied.status < 300, await denied.clone().text());
  const afterDeny = await t.as(automation.token, '/api/v1/render', 'POST', renderBody);
  assert.equal(afterDeny.status, 403, 'a deny grant still wins');
  assert.notEqual(await code(afterDeny), 'TOKEN_SCOPE');
});

test('scopes narrow an admin token too', async () => {
  const t = await boot();
  const { token } = await t.mint({ role: 'admin', scopes: ['documents'] });
  assert.equal((await t.as(token, '/api/v1/compile', 'POST', { toolId: 'card', inputs: {} })).status, 200);
  for (const [path, method, body] of [['/api/v1/audit', 'GET'], ['/api/v1/render', 'POST', renderBody], ['/api/v1/renders', 'POST', renderBody]] as const) {
    assert.equal(await code(await t.as(token, path, method, body)), 'TOKEN_SCOPE', path);
  }
  const raw = await t.as(token, '/api/v1/schema/card?view=raw');
  assert.equal(raw.status, 403, 'no scope covers the raw policy view');

  const tools = await (await t.as(token, '/api/v1/discovery/tools')).json() as { tools: Array<{ id: string; can: { render: boolean } }> };
  assert.ok(tools.tools.length);
  assert.ok(tools.tools.every((tool) => tool.can.render === false), 'discovery says this token cannot render');
  const schema = await (await t.as(token, '/api/v1/schema/card')).json() as { unavailable: Array<{ code: string }> };
  assert.ok(schema.unavailable.some((u) => u.code === 'FORBIDDEN'));
});

test('a token with no scopes behaves as it did before', async () => {
  const t = await boot();
  const { token, scopes, tools } = await t.mint({ role: 'admin' });
  assert.equal(scopes, null);
  assert.equal(tools, null);
  assert.equal((await t.as(token, '/api/v1/render', 'POST', renderBody)).status, 200);
  assert.equal((await t.as(token, '/api/v1/compile', 'POST', { toolId: 'card', inputs: {} })).status, 200);
  assert.equal((await t.as(token, '/api/v1/audit')).status, 200);
  assert.equal((await t.as(token, '/catalog/tools/index.json')).status, 200);
  assert.equal(await code(await t.as(token, '/api/v1/tokens')), 'FORBIDDEN', 'an admin token still cannot manage tokens');
  const me = await (await t.as(token, '/api/v1/discovery/me')).json() as Record<string, unknown>;
  assert.equal(me.token, undefined);
  assert.equal((me.can as Record<string, boolean>)['export.server'], true);
  const session = await (await t.as(token, '/api/auth/session')).json() as { user: Record<string, unknown> };
  assert.equal(session.user.scopes, undefined);

  // A person's session is never narrowed by any of this.
  assert.equal((await t.asOwner('/api/v1/audit')).status, 200);
});

test('mint, list, audit and discovery all report the scopes', async () => {
  const t = await boot();
  const { id, token } = await t.mint({ scopes: ['render', 'delivery'], tools: ['card'] });
  const listed = await (await t.asOwner('/api/v1/tokens')).json() as {
    tokens: Array<Record<string, unknown>>; scopeVocabulary: { version: number; scopes: Array<{ id: string }> };
  };
  const row = listed.tokens.find((row) => row.id === id)!;
  assert.deepEqual(row.scopes, ['render', 'delivery']);
  assert.deepEqual(row.tools, ['card']);
  assert.equal(row.token, undefined, 'the secret never comes back');
  assert.equal(listed.scopeVocabulary.version, TOKEN_SCOPES_VERSION);

  const events = await t.store.listAudit();
  const mintEvent = events.find((event) => event.action === 'token.create' && event.subject === `token:${id}`)!;
  assert.deepEqual(mintEvent.payload?.scopes, ['render', 'delivery']);
  assert.deepEqual(mintEvent.payload?.tools, ['card']);
  assert.equal(mintEvent.payload?.role, 'automation');

  const me = await (await t.as(token, '/api/v1/discovery/me')).json() as { token: { scopes: string[]; scopesVersion: number; tools: string[] }; can: Record<string, boolean>; principal: string };
  assert.equal(me.principal, 'service');
  assert.deepEqual(me.token, { scopes: ['render', 'delivery'], scopesVersion: TOKEN_SCOPES_VERSION, tools: ['card'] });
  assert.equal(me.can['export.server'], true);
  assert.equal(me.can['tool.use'], true);
  assert.equal(me.can['delivery.create'], true);
  assert.equal(me.can['catalog.read'], false, 'the role holds it, the scopes do not reach it');
  assert.equal(me.can['export.request'], false);

  const session = await (await t.as(token, '/api/auth/session')).json() as { user: { scopes: string[] } };
  assert.deepEqual(session.user.scopes, ['render', 'delivery']);
  assert.equal((await t.as(token, '/api/v1/discovery')).status, 200);
});

test('a tools list limits every request that names a tool', async () => {
  const t = await boot();
  const { token } = await t.mint({ scopes: ['render', 'documents'], tools: ['card'] });
  assert.equal((await t.as(token, '/api/v1/render', 'POST', renderBody)).status, 200);
  assert.equal((await t.as(token, '/api/v1/schema/card')).status, 200);
  const other = { ...renderBody, toolId: 'other' };
  assert.equal((await t.as(token, '/api/v1/render', 'POST', other)).status, 403);
  assert.equal((await t.as(token, '/api/v1/schema/other')).status, 403);
  assert.equal((await t.as(token, '/api/v1/renders', 'POST', other)).status, 403);
  assert.equal((await t.as(token, '/api/v1/compile', 'POST', { toolId: 'other', inputs: {} })).status, 403);
  assert.equal((await t.as(token, '/api/v1/batch', 'POST', { toolId: 'other', format: 'svg', rows: [{ bg: '#000000' }] })).status, 403);
  assert.equal((await t.as(token, '/api/v1/render-batches', 'POST', { toolId: 'other', format: 'svg', inputs: {}, rows: [{ key: 'one', inputs: {} }] })).status, 403);
  const listed = await (await t.as(token, '/api/v1/discovery/tools')).json() as { tools: Array<{ id: string }> };
  assert.deepEqual(listed.tools.map((tool) => tool.id), ['card']);
});

test('revoking a scoped token stops the next call and its queued work', async () => {
  const t = await boot();
  const { id, token } = await t.mint({ scopes: ['render'] });
  const submitted = await t.as(token, '/api/v1/renders', 'POST', renderBody);
  assert.equal(submitted.status, 202);
  const job = await submitted.json() as { id: string };
  assert.equal((await t.asOwner(`/api/v1/tokens/${id}`, 'DELETE')).status, 200);

  const next = await t.as(token, '/api/v1/render', 'POST', renderBody);
  assert.equal(next.status, 401);
  assert.equal(await code(next), 'UNAUTHORIZED', 'a revoked token gets the sign-in refusal, not a scope answer');

  await t.tick();
  const record = await t.store.getRender(job.id, `service:svc_${id}`);
  for (let i = 0; i < 100 && record && !['failed', 'succeeded', 'cancelled'].includes((await t.store.getRender(job.id, `service:svc_${id}`))!.state); i++) {
    await new Promise((resolve) => setTimeout(resolve, 10));
    await t.tick();
  }
  const settled = (await t.store.getRender(job.id, `service:svc_${id}`))!;
  assert.equal(settled.state, 'failed');
  assert.equal(settled.error?.code, 'PRINCIPAL_UNAVAILABLE');
});

test('every registered route is declared on purpose or refuses a scoped token before its handler', async () => {
  const t = await boot();
  const routes = appRouteDescriptions(t.app);
  const registered = new Set(routes.map((route) => `${route.method} ${route.path}`));

  for (const key of scopedRouteKeys()) assert.ok(registered.has(key), `the table names a route the app no longer has: ${key}`);

  // Asking for approval is the one approvals reach a token has, and only under its own
  // scope (plans/82 M7). Acting, approvers and the file stay with people.
  const asking = new Set(['POST /api/v1/approvals', 'GET /api/v1/approvals', 'GET /api/v1/approvals/:id', 'POST /api/v1/approvals/:id/withdraw']);
  for (const key of scopedRouteKeys()) {
    if (asking.has(key)) {
      const [method, path] = key.split(' ') as [string, string];
      assert.deepEqual(routeScopes(method, path), ['approvals.request'], key);
      continue;
    }
    for (const forbidden of ['/api/v1/tokens', '/api/v1/approvals', '/api/v1/grants', '/api/v1/users', '/api/v1/catalog/providers', '/api/v1/scim', '/scim/', '/api/internal', '/metrics', '/api/workspace', '/admin']) {
      assert.ok(!key.includes(forbidden), `${key} must stay out of reach of a scoped token`);
    }
  }

  const { token } = await t.mint({ scopes: [...TOKEN_SCOPES] });
  const before = (await t.store.listAudit()).length;
  let walked = 0;
  for (const route of routes) {
    if (routeScopes(route.method, route.path) !== null) continue;
    const path = route.path.split('/').map((part) => (part.startsWith(':') || part === '*' ? 'x' : part)).join('/') || '/';
    const res = await fetch(`${t.base}${path}`, {
      method: route.method, redirect: 'manual',
      headers: { authorization: `Bearer ${token}`, ...(['GET', 'HEAD', 'OPTIONS'].includes(route.method) ? {} : { 'content-type': 'application/json' }) },
      ...(['GET', 'HEAD', 'OPTIONS'].includes(route.method) ? {} : { body: '{}' }),
    });
    assert.equal(res.status, 403, `${route.method} ${route.path}`);
    if (route.method !== 'HEAD') assert.equal(await code(res), 'TOKEN_SCOPE', `${route.method} ${route.path}`);
    walked++;
  }
  assert.ok(walked > 250, `walked ${walked} undeclared routes`);
  assert.equal((await t.store.listAudit()).length, before, 'no handler ran');
  assert.match(t.metrics.renderText([]), /lw_token_scope_refused_total\{route="\/api\/v1\/tokens"\} /);
});

test('the guard refuses a new route by default and leaves other callers alone', async () => {
  const router = createRouter();
  let ran = 0;
  router.setGuard(tokenScopeGuard({ scopesOf: async (req) => (req.headers.authorization === 'scoped' ? ['render'] : null) }));
  router.add('POST', '/api/v1/brand-new', (_req, res) => { ran++; sendJson(res, 200, { ok: true }); });
  router.add('POST', '/api/v1/render', (_req, res) => { ran++; sendJson(res, 200, { ok: true }); });
  const server = createServer((req, res) => void router.dispatch(req, res));
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  const call = (path: string, authorization?: string) => fetch(`http://127.0.0.1:${address.port}${path}`, { method: 'POST', headers: authorization ? { authorization } : {} });

  const refused = await call('/api/v1/brand-new', 'scoped');
  assert.equal(refused.status, 403);
  assert.deepEqual((await refused.json() as { error: unknown }).error, { code: 'TOKEN_SCOPE', message: 'This service token\'s scopes do not cover this route.' });
  assert.equal(ran, 0);
  assert.equal((await call('/api/v1/render', 'scoped')).status, 200);
  assert.equal((await call('/api/v1/brand-new')).status, 200);
  assert.equal(ran, 2);
});

test('route and action helpers fail closed', () => {
  assert.equal(routeScopes('GET', '/api/v1/nothing'), null);
  assert.equal(routeScopes('GET', 'constructor'), null);
  assert.equal(scopesAllowRoute(['render'], 'GET', '/api/v1/nothing'), false);
  assert.equal(scopesAllowRoute(['render'], 'GET', '/api/v1/discovery/me'), true);
  assert.equal(scopesAllowRoute(['audit.read'], 'GET', '/api/v1/discovery/tools'), false);
  assert.equal(scopesCoverAction(['render'], 'export.server'), true);
  assert.equal(scopesCoverAction(['documents'], 'export.server'), false);
  assert.equal(scopesCoverAction(['render'], 'policy.edit'), false);
  assert.equal(scopesCoverAction(['render'], 'toString'), false);
});

test('lw tokens create takes scopes and lists them', async () => {
  const t = await boot();
  const { token: ownerToken } = await t.mint({ role: 'owner' });
  const lw = (...args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/lw.ts', import.meta.url)), ...args, '--base', t.base, '--token', ownerToken], { stdio: 'pipe', env: { ...process.env, HOME: pack } });
    let out = ''; let err = '';
    child.stdout.on('data', (chunk) => { out += chunk; });
    child.stderr.on('data', (chunk) => { err += chunk; });
    child.on('close', (exit) => resolve({ code: exit, out, err }));
  });
  const created = await lw('tokens', 'create', '--label', 'nightly', '--scopes', 'render,files', '--tools', 'card', '--json');
  assert.equal(created.code, 0, created.err);
  const parsed = JSON.parse(created.out) as { role: string; scopes: string[]; tools: string[]; token: string };
  assert.equal(parsed.role, 'automation');
  assert.deepEqual(parsed.scopes, ['render', 'files']);
  assert.deepEqual(parsed.tools, ['card']);

  const listed = await lw('tokens');
  assert.equal(listed.code, 0, listed.err);
  assert.match(listed.out, /nightly {2}role automation {2}scopes render,files {2}tools card/);

  const missing = await lw('tokens', 'create', '--label', 'nothing');
  assert.equal(missing.code, 1);
  assert.match(missing.err, /--scopes or --role required/);
});
