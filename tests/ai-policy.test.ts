import { test, type TestContext } from 'node:test';
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

/** A live app on a loopback port, with the policy lease and the admin switch. */
async function serve(t: TestContext, ai: unknown) {
  const store = createMemoryStore();
  const app = buildApp({ config: config(ai), store, secrets: { session: 'test-session', link: 'test-link' } });
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
  return { store, login, read, toggle };
}

test('HTTP: member-only uncached leases, admin switch, audit and account revocation', async (t) => {
  const { store, login, read, toggle } = await serve(t, { enabled: true, capabilities: ['ocr'] });
  assert.equal((await read()).status, 401);
  const admin = await login('admin@test');
  const member = await login('member@test');
  assert.equal((await (await read(member)).json() as { enabled: boolean }).enabled, false);
  assert.equal((await toggle(member, 'on')).status, 403);
  assert.equal((await toggle(admin, 'on')).status, 200);
  const lease = await read(member);
  assert.equal(lease.headers.get('cache-control'), 'private, no-store, max-age=0, no-transform');
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

test('sing can be approved like the other shell capabilities, and stays off by default', async (t) => {
  assert.deepEqual(config().policy.ai.capabilities, []);
  const approved = config({ enabled: true, capabilities: ['sing', 'ocr'] }).policy.ai;
  assert.deepEqual(approved, { enabled: true, capabilities: ['sing', 'ocr'] });
  assert.deepEqual(resolveAiPolicy(approved, new Map()), { version: 1, enabled: false, capabilities: [], maxAgeSeconds: 60 });
  for (const capabilities of [['singing'], ['Sing'], ['sing', 'vm'], ['sing', 'sing']]) {
    assert.throws(() => config({ enabled: true, capabilities }), /policy.ai.capabilities/, capabilities.join(','));
  }

  const { login, read, toggle } = await serve(t, { enabled: true, capabilities: ['sing', 'ocr'] });
  const admin = await login('admin@test');
  const member = await login('member@test');
  assert.deepEqual(await (await read(member)).json(), { version: 1, enabled: false, capabilities: [], maxAgeSeconds: 60 });
  assert.equal((await toggle(admin, 'on')).status, 200);
  const lease = await read(member);
  assert.equal(lease.status, 200);
  assert.deepEqual(await lease.json(), { version: 1, enabled: true, capabilities: ['ocr', 'sing'], maxAgeSeconds: 60 });
});
