import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { parseConfig } from '../server/src/config/instance.ts';
import { resolveAiPolicy } from '../server/src/policy/ai.ts';
import { assembleOrgConfig } from '../server/src/policy/org-config.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const config = (ai?: unknown) => parseConfig(JSON.stringify({
  policy: ai === undefined ? {} : { ai },
  rateLimit: { enabled: false },
  dev: { enabled: true, users: [
    { email: 'admin@test', name: 'Admin', groups: ['admin'] },
    { email: 'member@test', name: 'Member', groups: [] },
  ] },
}));
const on = new Map([['ai', { id: 'ai', default: 'on' as const, updatedAt: '2026-09-11T00:00:00Z' }]]);

test('AI requires both deployment approval and an explicit operator On', () => {
  assert.deepEqual(config().policy.ai, { enabled: false, capabilities: [] });
  assert.equal(resolveAiPolicy(config().policy.ai, on).enabled, false);
  const approved = config({ enabled: true, capabilities: ['ocr'] }).policy.ai;
  assert.equal(resolveAiPolicy(approved, new Map()).enabled, false);
  assert.deepEqual(resolveAiPolicy(approved, on), { version: 1, enabled: true, capabilities: ['ocr'], maxAgeSeconds: 60 });
});

test('AI configuration refuses malformed, empty enabled, and unrecognised capability policies', () => {
  for (const ai of [null, false, { enabled: 'false' }, { enabled: true },
    { enabled: true, capabilities: ['all'] }, { enabled: true, capabilities: ['ocr', 'ocr'] },
    { enabled: false, capabilites: ['ocr'] }]) {
    assert.throws(() => config(ai), /policy.ai/);
  }
});

test('AI approval ceiling and capability changes move org-config ETags', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'test', email: 'test@local', groups: [], role: 'member' });
  const project = (ai: unknown) => assembleOrgConfig({ config: config(ai), user, overlays: new Map(), flagGovernance: on, inboxUnread: 0 });
  const disabled = project({ enabled: false, capabilities: [] });
  const ocr = project({ enabled: true, capabilities: ['ocr'] });
  const matte = project({ enabled: true, capabilities: ['matte'] });
  assert.equal(disabled.ai.enabled, false);
  assert.notEqual(disabled.policyVersion, ocr.policyVersion);
  assert.notEqual(ocr.policyVersion, matte.policyVersion);
});

test('HTTP: member-only uncached leases, admin switch, audit and account revocation', async (t) => {
  const store = createMemoryStore();
  const app = buildApp({ config: config({ enabled: true, capabilities: ['ocr'] }), store, secrets: { session: 'test-session', link: 'test-link' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const read = (cookie = '') => fetch(`${base}/api/v1/policy/ai`, { headers: { cookie } });
  const toggle = (cookie: string, value: string) => fetch(`${base}/api/v1/policy/flags/ai`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ default: value }),
  });
  assert.equal((await read()).status, 401);
  const admin = await login('admin@test');
  const member = await login('member@test');
  assert.equal((await (await read(member)).json() as { enabled: boolean }).enabled, false);
  assert.equal((await toggle(member, 'on')).status, 403);
  assert.equal((await toggle(admin, 'on')).status, 200);
  const lease = await read(member);
  assert.equal(lease.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await lease.json(), { version: 1, enabled: true, capabilities: ['ocr'], maxAgeSeconds: 60 });
  assert.equal((await toggle(admin, 'off')).status, 200);
  assert.equal((await (await read(member)).json() as { enabled: boolean }).enabled, false);
  const audit = (await store.listAudit()).filter((e) => e.action === 'policy.flag.edit' && e.subject === 'flag:ai');
  assert.equal(audit.length, 2);
  const user = await store.getUserBySub('dev:member@test');
  assert.ok(user);
  await store.setUserDisabled(user.id, new Date().toISOString());
  assert.equal((await read(member)).status, 401);
});
