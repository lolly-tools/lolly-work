/**
 * A grant that can never match is refused (plans/82 fault B).
 *
 * The permissions page and the console offered `tool:tag/<tag>` and
 * `catalog:tag/<tag>`, which no route produces, so a deny written to keep logos
 * from a partner programme was stored and decided nothing. The write paths now
 * refuse such a rule and say what the permission is checked against, and a
 * rule stored before the check is marked.
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
import { grantNeverMatches } from '../server/src/rbac/grant-shape.ts';
import { knownActions } from '../server/src/rbac/evaluate.ts';

test('the rules that can match are accepted', () => {
  for (const [action, resource] of [
    ['tool.use', 'tool:qr-code'], ['tool.use', '*'], ['export.download', 'tool:price-sheet'],
    ['export.server', 'tool:qr-code'], ['link.create-guest', 'tool:event-badge'],
    ['delivery.create', 'destination:campaign-archive'], ['project.manage', 'project:Ab-3_x'],
    ['programme.manage', 'programme:resellers'],
    ['session.view', 'session:s1'], ['comment.create', 'project:p1'],
    ['approval.act', 'chain:brand-review'], ['approval.act', 'asset:inst/hero'],
    ['catalog.read', '*'], ['policy.edit', '*'], ['catalog.hold', '*'],
  ]) assert.equal(grantNeverMatches({ action: action!, resource: resource! }), null, `${action} ${resource}`);
});

test('the rules that can never match are named, with the reason', () => {
  assert.match(grantNeverMatches({ action: 'catalog.read', resource: 'catalog:tag/logo' })!, /whole deployment/);
  assert.match(grantNeverMatches({ action: 'tool.use', resource: 'tool:tag/partner-safe' })!, /Tag selectors are not checked/);
  assert.match(grantNeverMatches({ action: 'export.download', resource: 'catalog:lolly/logo/primary' })!, /tool:<id>/);
  assert.match(grantNeverMatches({ action: 'delivery.create', resource: 'tool:qr-code' })!, /destination:<id>/);
  assert.match(grantNeverMatches({ action: 'export.downlaod', resource: '*' })!, /not a permission/);
  assert.match(grantNeverMatches({ action: 'catalog.hold', resource: 'catalog:inst/hero' })!, /must be "\*"/);
  assert.match(grantNeverMatches({ action: 'tool.use', resource: 'tool:' })!, /never match/);
  // `programme.manage` is checked against one programme, never a company or a tool.
  assert.match(grantNeverMatches({ action: 'programme.manage', resource: 'company:northwind' })!, /programme:<id>/);
  assert.match(grantNeverMatches({ action: 'programme.manage', resource: 'tool:card' })!, /programme:<id>/);
});

test('every action the table narrows is one the routes check', () => {
  for (const action of ['tool.use', 'export.download', 'export.request', 'export.server', 'link.create', 'link.create-guest',
    'delivery.create', 'project.manage', 'programme.manage', 'session.view', 'session.edit', 'comment.view', 'comment.create', 'comment.edit',
    'comment.resolve', 'comment.moderate', 'approval.act']) assert.ok(knownActions().has(action), action);
});

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-grant-shape-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Shape Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }] },
  }));
  store = createMemoryStore({
    grants: [{ principal: 'group:msp', action: 'catalog.read', resource: 'catalog:tag/logo', effect: 'deny' }],
  });
  const app = buildApp({ config, store, secrets: { session: 'ss', link: 'll' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function admin(): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=admin@test`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}

test('POST /api/v1/grants refuses a rule that can never match and stores nothing', async () => {
  const cookie = await admin();
  const before = (await store.listGrants()).length;
  const res = await fetch(`${base}/api/v1/grants`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'group:msp', action: 'catalog.read', resource: 'catalog:tag/photo', effect: 'deny' }) });
  assert.equal(res.status, 400);
  const body = await res.json() as { error: { code: string; message: string; accepted: string[] } };
  assert.equal(body.error.code, 'GRANT_NEVER_MATCHES');
  assert.deepEqual(body.error.accepted, ['*']);
  assert.equal((await store.listGrants()).length, before);
  const ok = await fetch(`${base}/api/v1/grants`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'group:msp', action: 'tool.use', resource: 'tool:qr-code', effect: 'deny' }) });
  assert.equal(ok.status, 201);
});

test('a stored rule that can never match is marked, and can still be deleted', async () => {
  const cookie = await admin();
  const list = await (await fetch(`${base}/api/v1/grants`, { headers: { cookie } })).json() as { grants: Array<{ resource: string; neverMatches?: string }> };
  const inert = list.grants.find((g) => g.resource === 'catalog:tag/logo');
  assert.match(inert?.neverMatches ?? '', /whole deployment/);
  assert.equal(list.grants.find((g) => g.resource === 'tool:qr-code')?.neverMatches, undefined);
  const del = await fetch(`${base}/api/v1/grants`, { method: 'DELETE', headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ principal: 'group:msp', action: 'catalog.read', resource: 'catalog:tag/logo', effect: 'deny' }) });
  assert.equal(del.status, 200);
});

test('applying a governance document refuses a NEW rule that can never match, and re-applies a stored one', async () => {
  const cookie = await admin();
  await store.putGrant({ principal: 'group:old', action: 'tool.use', resource: 'tool:tag/legacy', effect: 'deny' });
  const doc = await (await fetch(`${base}/api/v1/config/export`, { headers: { cookie } })).json() as { grants: unknown[] };
  const same = await fetch(`${base}/api/v1/config/apply?dryRun=1`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  assert.equal(same.status, 200, 'an exported document still applies');
  doc.grants.push({ principal: 'group:msp', action: 'catalog.read', resource: 'catalog:tag/logo', effect: 'deny' });
  const added = await fetch(`${base}/api/v1/config/apply?dryRun=1`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(doc) });
  assert.equal(added.status, 400);
  assert.equal(((await added.json()) as { error: { code: string } }).error.code, 'GRANT_NEVER_MATCHES');
});
