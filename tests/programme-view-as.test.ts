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
import { VIEW_AS_HEADER, VIEW_AS_TTL_SEC, ViewAsEndedError, createViewAs, readViewAs, signViewAs } from '../server/src/programmes/view-as.ts';
import { createCollabGateway, COLLAB_WS_PREFIX, type CollabGateway } from '../server/src/collab/gateway.ts';
import { WebSocket } from 'ws';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { UserRecord } from '../server/src/store/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let collab: CollabGateway;
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
  collab = createCollabGateway({ config, store, secrets: { session: SECRET, link: 'lv' } });
  server = createServer((req, res) => void app(req, res));
  server.on('upgrade', (req, socket, head) => { if (!collab.handleUpgrade(req, socket, head)) socket.destroy(); });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const admin = await login('admin@test');
  await call(admin, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: ['price-sheet'] });
  await call(admin, 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' });
  await call(admin, 'PUT', '/api/v1/programmes/isv', { name: 'ISVs', tools: ['qr-code'] });
  await call(admin, 'PUT', '/api/v1/programmes/isv/companies/contoso', { name: 'Contoso' });
});

after(() => { collab.close(); server.close(); });

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

/** Open a WebSocket and report how the upgrade was answered. */
function upgrade(path: string, headers: Record<string, string>): Promise<{ status: number; body: string }> {
  return new Promise((resolve) => {
    const ws = new WebSocket(`${base.replace('http', 'ws')}${path}`, { headers });
    ws.on('unexpected-response', (_req, res) => {
      let body = ''; res.on('data', (c: Buffer) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
    });
    ws.on('open', () => { ws.close(); resolve({ status: 101, body: '' }); });
    ws.on('error', () => undefined);
  });
}

test('a tab viewing as a partner never joins a live room, by header or by the query marker', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', {});
  const byHeader = await upgrade(`${COLLAB_WS_PREFIX}ses_anything`, { cookie: admin, [VIEW_AS_HEADER]: body.token });
  assert.equal(byHeader.status, 403);
  assert.match(byHeader.body, /VIEWING_AS/);
  const byMarker = await upgrade(`${COLLAB_WS_PREFIX}ses_anything?view-as=1`, { cookie: admin });
  assert.equal(byMarker.status, 403);
  assert.match(byMarker.body, /VIEWING_AS/);
});

test('the browser cache is kept apart: a view is never stored, and every partner read varies on the view', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', { company: 'northwind' });
  for (const path of ['/catalog/tools/index.json', '/api/v1/org-config', '/tools/price-sheet/tool.json']) {
    const viewed = await fetch(`${base}${path}`, { headers: { cookie: admin, [VIEW_AS_HEADER]: body.token } });
    assert.equal(viewed.status, 200, path);
    assert.match(viewed.headers.get('cache-control') ?? '', /\bno-store\b/, `${path}: a view is never stored`);
    assert.match(viewed.headers.get('vary') ?? '', /x-lw-view-as/i, path);
    const own = await fetch(`${base}${path}`, { headers: { cookie: admin } });
    assert.match(own.headers.get('vary') ?? '', /x-lw-view-as/i, `${path}: the admin's own answer varies on the view too`);
  }
});

test('a later authentication in the same request checks the admin again, so a view that ended mid-request answers nothing', async () => {
  const admin = { id: 'u-admin', sessionEpoch: 2, groups: ['admin'], role: 'admin' } as unknown as UserRecord;
  let session: UserRecord | null = admin;
  let manages = true;
  const audits: string[] = [];
  const view = createViewAs({
    sessionMember: async () => session, delegated: () => false, mayManage: async () => manages,
    programme: async (id) => ({ id, name: 'Resellers' }), company: async (id) => ({ id, programmeId: 'resellers', name: 'Northwind IT' }),
    roleOf: () => 'member', secret: SECRET, verifySecrets: SECRET, audit: async (_a, action) => { audits.push(action); },
  });
  const token = signViewAs({ v: 1, u: 'u-admin', e: 2, p: 'resellers', c: 'northwind', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const headers: Record<string, unknown> = {};
  const res = { setHeader(n: string, v: unknown) { headers[n] = v; }, getHeader(n: string) { return headers[n]; }, writeHead() { return this; }, end() { return this; } } as unknown as ServerResponse;
  const request = () => ({ method: 'GET', url: '/catalog/x.png', headers: { cookie: 'lw_session=x', [VIEW_AS_HEADER]: token } }) as unknown as IncomingMessage;
  // Passed at the gate, then the admin loses the programme before the route checks again:
  // the request ends, at this check and at any later one, and never falls back.
  let req = request();
  assert.equal(await view.gate(req, res, '/catalog/x.png'), false);
  assert.ok((await view.member(req))?.groups.includes('company-northwind'));
  manages = false;
  await assert.rejects(view.member(req), ViewAsEndedError, 'no longer managing the programme');
  manages = true;
  await assert.rejects(view.member(req), ViewAsEndedError, 'an ended view stays ended for the rest of the request');
  // The same for an admin disabled or signed out everywhere in between.
  req = request();
  assert.equal(await view.gate(req, res, '/catalog/x.png'), false);
  session = { ...admin, sessionEpoch: 3 } as UserRecord;
  await assert.rejects(view.member(req), ViewAsEndedError, 'signed out everywhere');
  session = admin; req = request();
  assert.equal(await view.gate(req, res, '/catalog/x.png'), false);
  session = null;
  await assert.rejects(view.member(req), ViewAsEndedError, 'disabled');
  // A request that is not a view is not this module's to answer.
  assert.equal(await view.member({ method: 'GET', url: '/', headers: {} } as unknown as IncomingMessage), undefined);
});

test('a view that ends between the gate and the route answers 403, never as anonymous or as the admin', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', {});
  const adminId = (await store.getUserBySub('dev:admin@test'))!.id;
  const original = store.listGrants.bind(store);
  // The gate asks once; from the route's own authentication on, programme.manage is denied.
  let calls = 0;
  store.listGrants = async () => {
    calls++;
    const grants = await original();
    return calls > 1 ? [...grants, { principal: `user:${adminId}`, action: 'programme.manage', resource: 'programme:resellers', effect: 'deny' } as never] : grants;
  };
  try {
    for (const path of ['/api/v1/org-config', '/catalog/tools/index.json', '/tools/price-sheet/tool.json']) {
      calls = 0;
      const res = await call(admin, 'GET', path, undefined, body.token);
      assert.equal(res.status, 403, path);
      assert.equal(res.body?.error?.code, 'VIEWING_AS_ENDED', path);
    }
  } finally { store.listGrants = original; }
});

test('no sign-in route but the session, the boot probe and sign-out is reachable from a view', async () => {
  const admin = await login('admin@test');
  const { body } = await call(admin, 'POST', '/api/v1/programmes/resellers/view-as', {});
  // A recently signed-in admin's real passkey cannot be removed from a viewing tab.
  const removed = await call(admin, 'POST', '/api/auth/passkeys/pk-1/remove', {}, body.token);
  assert.equal(removed.status, 403);
  assert.equal(removed.body.error.code, 'VIEWING_AS');
  for (const [method, path] of [['POST', '/api/auth/password/set'], ['POST', '/api/auth/invite'], ['POST', '/api/auth/passkeys/register/options'], ['GET', '/api/auth/security']] as const) {
    const res = await call(admin, method, path, method === 'GET' ? undefined : {}, body.token);
    assert.equal(res.status, 403, `${method} ${path}`);
    assert.equal(res.body.error.code, 'VIEWING_AS', `${method} ${path}`);
  }
  assert.equal((await call(admin, 'GET', '/api/auth/config', undefined, body.token)).status, 200);
  assert.notEqual((await call(admin, 'GET', '/api/auth/session', undefined, body.token)).status, 403);
});

test('a view that ends answers 403 VIEWING_AS_ENDED itself, so a route catch that would answer 502 cannot change it', async () => {
  const admin = { id: 'u-admin', sessionEpoch: 2, groups: ['admin'], role: 'admin' } as unknown as UserRecord;
  let manages = true;
  const view = createViewAs({
    sessionMember: async () => admin, delegated: () => false, mayManage: async () => manages,
    programme: async (id) => ({ id, name: 'Resellers' }), company: async () => null,
    roleOf: () => 'member', secret: SECRET, verifySecrets: SECRET, audit: async () => undefined,
  });
  const token = signViewAs({ v: 1, u: 'u-admin', e: 2, p: 'resellers', exp: Math.floor(Date.now() / 1000) + 60 }, SECRET);
  const sent: Array<{ status: number; body: string }> = [];
  let headersSent = false;
  const res = {
    get headersSent() { return headersSent; },
    setHeader() {}, getHeader() { return undefined; },
    writeHead(status: number) { if (headersSent) throw new Error('ERR_HTTP_HEADERS_SENT'); headersSent = true; sent.push({ status, body: '' }); return this; },
    end(body?: string) { if (body) sent.at(-1)!.body += body; return this; },
  } as unknown as ServerResponse;
  const req = { method: 'GET', url: '/catalog/ext/dam/a1/att1?view=1', headers: { cookie: 'lw_session=x', [VIEW_AS_HEADER]: token } } as unknown as IncomingMessage;
  assert.equal(await view.gate(req, res, '/catalog/ext/dam/a1/att1'), false);
  manages = false;
  // A route that catches everything and answers 502, as the conversion path did.
  try { await view.member(req); } catch { try { res.writeHead(502); } catch { /* headers already out */ } }
  assert.equal(sent.length, 1, 'one answer only');
  assert.equal(sent[0]!.status, 403);
  assert.match(sent[0]!.body, /VIEWING_AS_ENDED/);
});
