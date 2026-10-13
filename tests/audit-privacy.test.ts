// SPDX-License-Identifier: MPL-2.0
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deriveAuditMacKey, hashEvent, nextEvent, verifyChain, GENESIS_HASH, type AuditEvent } from '../server/src/audit/chain.ts';
import { AUDIT_EMAIL_OMITTED } from '../server/src/audit/privacy.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import type { Store } from '../server/src/store/types.ts';

const body = () => ({ at: '2026-10-01T00:00:00.000Z', actor: 'email:Ana@example.invalid', action: 'auth.denied', subject: 'identity:ana@example.invalid',
  payload: { email: 'ana@example.invalid', nested: { emails: ['ANA@example.invalid'], message: 'Contact ana@example.invalid', encoded: 'https://example.invalid/person/ana%40example.invalid', 'ana@example.invalid': 'address key' } } });
const key = deriveAuditMacKey('audit-privacy-test-secret');

test('new audit rows replace email values, text, keys and actor/subject references before hashing', () => {
  const source = body();
  const event = nextEvent(null, source, key);
  assert.ok(!JSON.stringify(event).toLowerCase().includes('ana@example.invalid'));
  assert.ok(!JSON.stringify(event).toLowerCase().includes('ana%40example.invalid'));
  const email = event.payload!.email as string;
  assert.match(email, /^email:[A-Za-z0-9_-]{43}$/);
  assert.equal((event.payload!.nested as { emails: string[] }).emails[0], email);
  assert.equal(event.actor, `email:${email}`);
  assert.equal(nextEvent(null, body(), key).payload!.email, email);
  assert.notEqual(nextEvent(null, body(), deriveAuditMacKey('other-key')).payload!.email, email);
  assert.equal(source.payload.email, 'ana@example.invalid');
  assert.deepEqual(verifyChain([event], null, key), { ok: true, unkeyed: 0 });
  assert.equal(verifyChain([{ ...event, payload: { email: 'changed' } }], null, key).ok, false);
});

test('unkeyed audit rows omit email values and bound recursive input', () => {
  const payload: Record<string, unknown> = { email: 'ana@example.invalid', deep: {} };
  payload.deep = payload;
  const event = nextEvent(null, { ...body(), payload });
  assert.equal(event.payload!.email, AUDIT_EMAIL_OMITTED);
  assert.equal(event.payload!.deep, '[value omitted]');
  assert.ok(!JSON.stringify(event).includes('ana@example.invalid'));
  assert.deepEqual(verifyChain([event]), { ok: true });
});

test('retained audit rows keep their original bytes and remain verifiable across new appends', () => {
  const source = body();
  const legacy: AuditEvent = { ...source, seq: 1, prevHash: GENESIS_HASH, hash: hashEvent(GENESIS_HASH, 1, source) };
  const latest = nextEvent(legacy, body(), key);
  assert.equal(legacy.payload!.email, 'ana@example.invalid');
  assert.deepEqual(verifyChain([legacy, latest], null, key), { ok: true, unkeyed: 1 });
});

async function auditWriterConformance(store: Store): Promise<void> {
  store.setAuditMacKey?.(key);
  const first = await store.appendAudit(body());
  assert.ok(store.appendAuditIfTail);
  const second = await store.appendAuditIfTail({ seq: first.seq, hash: first.hash }, body());
  assert.ok(second);
  const prior = await store.getBrandState();
  const { revision, ...next } = prior;
  assert.ok(await store.casBrandState(revision, next, body()));
  const rows = await store.listAudit();
  assert.ok(!JSON.stringify(rows).toLowerCase().includes('ana@example.invalid'));
  assert.deepEqual(verifyChain(rows, null, key), { ok: true, unkeyed: 0 });
}

test('memory audit writers enforce the shared privacy filter', async () => { await auditWriterConformance(createMemoryStore()); });
test('PostgreSQL audit writers enforce the shared privacy filter', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, auditWriterConformance);
});

const servers: Server[] = [];
after(() => { for (const server of servers) server.close(); });
async function boot(mode: 'off' | 'owner-only' | 'delegated', auditSessionUpdates = false) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-activity-policy-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({ instance: { name: 'Activity policy', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    policy: { activity: { mode, auditSessionUpdates } }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'admin@test', groups: ['admin'] }, { email: 'member@test', groups: ['staff'] }] } }));
  const store = createMemoryStore(); store.setAuditMacKey?.(key);
  const app = buildApp({ config, store, secrets: { session: 'audit-privacy-test-secret', link: 'activity-links' } });
  const server = createServer((req, res) => void app(req, res)); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
  return { store, base, login };
}

test('activity policy gates feeds and console navigation while retaining audit access', async () => {
  const off = await boot('off'), owner = await off.login('owner@test');
  for (const path of ['/api/v1/activity?actor=user%3Atarget', '/api/v1/agents/activity']) assert.equal((await fetch(off.base + path, { headers: { cookie: owner } })).status, 403);
  const session = await (await fetch(off.base + '/api/auth/session', { headers: { cookie: owner } })).json() as { console: { views: Record<string, boolean> } };
  assert.equal(session.console.views.activity, false); assert.equal(session.console.views.agents, false); assert.equal(session.console.views.audit, true);
  const owners = await boot('owner-only'), admin = await owners.login('admin@test'), allowed = await owners.login('owner@test');
  assert.equal((await fetch(owners.base + '/api/v1/activity', { headers: { cookie: admin } })).status, 403);
  const response = await fetch(owners.base + '/api/v1/activity?actor=user%3Atarget&q=ana%40example.invalid', { headers: { cookie: allowed } });
  assert.equal(response.status, 200);
  const read = (await owners.store.listAudit()).find(row => row.action === 'activity.read')!;
  assert.deepEqual(read.payload!.filters, ['actor', 'q']); assert.ok(!JSON.stringify(read).includes('ana@example.invalid'));
  const delegated = await boot('delegated'), member = await delegated.login('member@test');
  await delegated.store.putGrant({ principal: 'group:staff', action: 'audit.export', resource: '*', effect: 'allow' });
  assert.equal((await fetch(delegated.base + '/api/v1/activity', { headers: { cookie: member } })).status, 200);
});

test('routine session save auditing is an explicit policy choice', async () => {
  for (const enabled of [false, true]) {
    const env = await boot('off', enabled), cookie = await env.login('owner@test');
    const user = (await env.store.findUsersByEmail('owner@test'))[0]!;
    const at = new Date().toISOString();
    await env.store.putProject({ id: 'project', name: 'Project', ownerId: user.id, visibility: 'private', createdAt: at });
    await env.store.putSession({ id: 'document', projectId: 'project', toolId: 'card', toolVersion: '1.0.0', inputs: {}, meta: {}, createdBy: user.id, updatedBy: user.id, rev: 1, updatedAt: at });
    const response = await fetch(env.base + '/api/v1/sessions/document', { method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ rev: 1, inputs: { title: 'Saved' } }) });
    assert.equal(response.status, 200);
    assert.equal((await env.store.listAudit()).some(row => row.action === 'session.update'), enabled);
  }
});


test('activity configuration preserves existing defaults and validates explicit choices', () => {
  const config = parseConfig(JSON.stringify({ dev: { enabled: true } }));
  assert.deepEqual(config.policy.activity, { mode: 'delegated', auditSessionUpdates: true });
  for (const activity of [{ mode: 'anyone' }, { auditSessionUpdates: 'no' }]) assert.throws(() => parseConfig(JSON.stringify({ dev: { enabled: true }, policy: { activity } })), /activity/);
  assert.deepEqual(config.policy.retention, { telemetryDays: 0, auditDays: 0 });
});


test('fleet attribution migration clears only associations without a live account row', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  const url = process.env.LW_TEST_DATABASE_URL!;
  await withFreshPostgres(url, async store => {
    const person = await store.upsertUserBySub({ sub: 'fleet-person', email: 'person@example.invalid', groups: [], role: 'member' });
    await store.upsertInstall('kept-install', { shell: 'web' }, person.id);
    await store.upsertInstall('orphan-install', { shell: 'web' }, 'removed-person');
    const { default: pg } = await import('pg');
    const client = new pg.Client({ connectionString: url }); await client.connect();
    try { await client.query(await readFile(new URL('../migrations/0069_fleet_attribution.sql', import.meta.url), 'utf8')); }
    finally { await client.end(); }
    const installs = await store.listInstalls();
    assert.equal(installs.find(row => row.installId === 'kept-install')?.userIdLastSeen, person.id);
    assert.equal(installs.find(row => row.installId === 'orphan-install')?.userIdLastSeen, undefined);
  });
});
