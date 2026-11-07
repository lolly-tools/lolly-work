/**
 * View as a partner (plans/82 M6, W-M6-3).
 *
 * Someone who manages a programme sees what a member of it gets, read-only, in one
 * tab: the start route returns a token, the tab sends it in `x-lw-view-as`, and the
 * partner's reads answer as the partner. The token never works alone: the request
 * must be signed in as the admin it names, at the same session epoch. Every write,
 * and every read a partner's view does not need, is refused.
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
import { VIEW_AS_HEADER, VIEW_AS_TTL_SEC, readViewAs, signViewAs } from '../server/src/programmes/view-as.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const SECRET = 'view-as-session-secret';
const TOOLS = ['price-sheet', 'qr-code', 'internal-deck'];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-view-as-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: TOOLS.map((id) => ({ id })) }));
  for (const id of TOOLS) {
    await mkdir(join(pack, 'tools', id), { recursive: true });
    await writeFile(join(pack, 'tools', id, 'tool.json'), JSON.stringify({ id, inputs: [{ id: 'title' }] }));
  }
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Partner Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'staff@test', groups: ['marketing'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: SECRET, link: 'lv' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['price-sheet'] });
  await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' });
  await call(admin, 'PUT', '/api/v1/programmes/isv', { name: 'ISVs', tools: ['qr-code'] });
  await call(admin, 'PUT', '/api/v1/programmes/isv/companies/contoso', { name: 'Contoso' });
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}
async function call(cookie: string | null, method: string, path: string, body?: unknown, token?: string) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json', ...(token ? { [VIEW_AS_HEADER]: token } : {}) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const text = await res.text();
  let json: any = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: res.status, body: json };
}
const audits = async (action: string) => (await store.listAudit()).filter((a) => a.action === action);

test('an admin who manages the programme starts a view, audited, and gets a token for one company', async () => {
  const admin = await login('admin@test');
  const started = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', { company: 'northwind' });
  assert.equal(started.status, 201);
  assert.deepEqual({ programme: started.body.programme, company: started.body.company }, { programme: { id: 'resellers', name: 'Resellers, EMEA' }, company: { id: 'northwind', name: 'Northwind IT' } });
  const claim = readViewAs(started.body.token, SECRET)!;
  assert.equal(claim.p, 'resellers'); assert.equal(claim.c, 'northwind');
  assert.ok(Math.abs(claim.exp - (Date.now() / 1000 + VIEW_AS_TTL_SEC)) < 5);
  const [entry] = (await audits('programme.view-as')).slice(-1);
  assert.equal(entry?.subject, 'programme:resellers');
  assert.equal((entry?.payload as { via?: string; company?: string })?.via, 'view-as');
  // Not someone who does not manage it, and never a company from another programme.
  assert.equal((await call(await login('staff@test'), 'POST', '/api/v1/programmes/resellers/view-as', {})).status, 403);
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', { company: 'contoso' })).status, 404);
  assert.equal((await call(admin, 'POST', '/api/v1/programmes/nope/view-as', {})).status, 404);
});

test('the partner reads answer as the partner, exactly as the console Preview does, with no write offered', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', { company: 'northwind' });
  const viewed = await call(admin, 'GET', '/api/v1/org-config', undefined, body.token);
  assert.equal(viewed.status, 200);
  assert.equal(viewed.body.programmeScoped, true);
  assert.deepEqual(viewed.body.viewingAs, { programme: { id: 'resellers', name: 'Resellers, EMEA' }, company: { id: 'northwind', name: 'Northwind IT' } });
  assert.ok(Object.values(viewed.body.can).every((v) => v === false), 'every write bit is off');
  const preview = await call(admin, 'GET', '/api/v1/org-config/preview?groups=partner,programme-resellers,company-northwind');
  assert.deepEqual(Object.keys(viewed.body.tools).sort(), Object.keys(preview.body.orgConfig.tools).sort(), 'the same tools as Preview');
  assert.deepEqual(viewed.body.partner, preview.body.orgConfig.partner, 'the same partner block as Preview');
  // The served tool index and tool files follow the partner's groups.
  const feed = await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie: admin, [VIEW_AS_HEADER]: body.token } });
  assert.deepEqual(((await feed.json()) as { tools: Array<{ id: string }> }).tools.map((t) => t.id), ['price-sheet']);
  assert.equal((await fetch(`${base}/tools/internal-deck/tool.json`, { headers: { cookie: admin, [VIEW_AS_HEADER]: body.token } })).status, 404);
  // The admin's own reads, without the header, are unchanged.
  const own = await call(admin, 'GET', '/api/v1/org-config');
  assert.equal(own.body.viewingAs, undefined);
  assert.equal(own.body.programmeScoped, undefined);
});

test('a view writes nothing and reads nothing else: writes and other reads are refused', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', {});
  const before = (await store.listAudit()).length;
  for (const [method, path] of [['POST', '/api/v1/inbox/m1/ack'], ['PUT', '/api/v1/programmes/resellers'], ['POST', '/api/v1/telemetry'], ['GET', '/api/v1/projects'], ['GET', '/api/v1/users']] as const) {
    const res = await call(admin, method, path, method === 'GET' ? undefined : {}, body.token);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.code, 'VIEWING_AS', `${method} ${path}`);
  }
  assert.equal((await store.listAudit()).length, before, 'a refused request records nothing');
  // The admin's own sign-in plumbing stays theirs.
  assert.notEqual((await call(admin, 'GET', '/api/auth/session', undefined, body.token)).status, 403);
});

test('the token never works alone: no session, another session or an old epoch gets nothing, audited', async () => {
  const admin = await login('admin@test');
  const staff = await login('staff@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', { company: 'northwind' });
  const mismatches = (await audits('programme.view-as.mismatch')).length;
  for (const cookie of [null, staff]) {
    const res = await call(cookie, 'GET', '/api/v1/org-config', undefined, body.token);
    assert.equal(res.status, 403);
    assert.equal(res.body.error.code, 'VIEWING_AS_MISMATCH');
    const feed = await fetch(`${base}/catalog/tools/index.json`, { headers: { ...(cookie ? { cookie } : {}), [VIEW_AS_HEADER]: body.token } });
    assert.equal(feed.status, 403);
  }
  assert.equal((await audits('programme.view-as.mismatch')).length, mismatches + 4);
  // A token from before the admin's sessions were cut off (another epoch).
  const claim = readViewAs(body.token, SECRET)!;
  const stale = signViewAs({ ...claim, e: claim.e + 1 }, SECRET);
  assert.equal((await call(admin, 'GET', '/api/v1/org-config', undefined, stale)).body.error.code, 'VIEWING_AS_MISMATCH');
  // A forged or expired token is no view at all.
  assert.equal((await call(admin, 'GET', '/api/v1/org-config', undefined, signViewAs(claim, 'another-secret'))).body.error.code, 'VIEWING_AS_ENDED');
  assert.equal((await call(admin, 'GET', '/api/v1/org-config', undefined, signViewAs({ ...claim, exp: Math.floor(Date.now() / 1000) - 1 }, SECRET))).body.error.code, 'VIEWING_AS_ENDED');
});

test('stopping is audited, and a view of a programme the admin no longer manages ends', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/isv/view-as', {});
  const ended = await fetch(`${base}/api/v1/view-as/end`, { method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ token: body.token }) });
  assert.equal(ended.status, 204);
  assert.equal((await audits('programme.view-as.end')).slice(-1)[0]?.subject, 'programme:isv');
  // A deny on that programme for the admin ends the view on the next request.
  const adminId = (await store.getUserBySub('dev:admin@test'))!.id;
  await store.putGrant({ principal: `user:${adminId}`, action: 'programme.manage', resource: 'programme:isv', effect: 'deny' } as never);
  assert.equal((await call(admin, 'GET', '/api/v1/org-config', undefined, body.token)).body.error.code, 'VIEWING_AS_ENDED');
});
