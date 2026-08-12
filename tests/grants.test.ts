/**
 * Grants control plane over real HTTP (plans/03): list/create/delete under
 * `grant.edit`, the owner-only escalation guard (an admin cannot mint
 * instance.config or provider-credential grants), immediate effect on RBAC
 * evaluation (deny-wins shows up in org-config `can` bits), validation, and
 * the audit trail.
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

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-grants-'));
  await mkdir(join(pack, 'catalog'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools.gitkeep'), '');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Grants Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'owner@test', groups: ['owner'] },
        { email: 'admin@test', groups: ['admin'] },
        { email: 'marketer@test', groups: ['marketing'] },
      ],
    },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sg', link: 'lg' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const jsonHeaders = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

const DENY_DOWNLOAD = { principal: 'group:marketing', action: 'export.download', resource: '*', effect: 'deny' };

test('(a) member refused; admin creates a deny that bites RBAC immediately (org-config can-bit flips)', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await fetch(`${base}/api/v1/grants`, { headers: { cookie: marketer } })).status, 403);

  const before = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as { can: Record<string, boolean> };
  assert.equal(before.can['export.download'], true, 'member role default allows download');

  const admin = await login('admin@test');
  const post = await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(DENY_DOWNLOAD),
  });
  assert.equal(post.status, 201);

  const after = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as { can: Record<string, boolean> };
  assert.equal(after.can['export.download'], false, 'deny-wins is live for the next request');

  const { grants } = await (await fetch(`${base}/api/v1/grants`, { headers: { cookie: admin } })).json() as { grants: unknown[] };
  assert.equal(grants.length, 1);
  // Re-POST is idempotent — still one row.
  await fetch(`${base}/api/v1/grants`, { method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(DENY_DOWNLOAD) });
  const again = await (await fetch(`${base}/api/v1/grants`, { headers: { cookie: admin } })).json() as { grants: unknown[] };
  assert.equal(again.grants.length, 1);
});

test('(b) escalation guard: admin cannot create OR delete grants for owner-only actions; owner can', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  const escalation = { principal: 'group:admin', action: 'instance.config', resource: '*', effect: 'allow' };

  const denied = await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(escalation),
  });
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, 'OWNER_ONLY_ACTION');

  const credGrant = { principal: 'group:brand', action: 'catalog.provider.credential', resource: '*', effect: 'allow' };
  assert.equal((await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(credGrant),
  })).status, 403, 'provider credential power is owner-only too');

  const ok = await fetch(`${base}/api/v1/grants`, {
    method: 'POST', headers: jsonHeaders(owner), body: JSON.stringify(credGrant),
  });
  assert.equal(ok.status, 201, 'the owner may delegate an owner-only action deliberately');

  // …and an admin cannot quietly remove an owner-made owner-only grant either.
  assert.equal((await fetch(`${base}/api/v1/grants`, {
    method: 'DELETE', headers: jsonHeaders(admin), body: JSON.stringify(credGrant),
  })).status, 403);
  assert.equal((await fetch(`${base}/api/v1/grants`, {
    method: 'DELETE', headers: jsonHeaders(owner), body: JSON.stringify(credGrant),
  })).status, 200);
});

test('(c) delete removes the exact tuple and restores the role default', async () => {
  const admin = await login('admin@test');
  const del = await fetch(`${base}/api/v1/grants`, {
    method: 'DELETE', headers: jsonHeaders(admin), body: JSON.stringify(DENY_DOWNLOAD),
  });
  assert.equal(del.status, 200);
  const marketer = await login('marketer@test');
  const cfg = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: marketer } })).json() as { can: Record<string, boolean> };
  assert.equal(cfg.can['export.download'], true, 'role default back in force');
});

test('(d) validation: malformed principal/effect/action refused whole', async () => {
  const admin = await login('admin@test');
  for (const bad of [
    { principal: 'marketing', action: 'x', resource: '*', effect: 'deny' },   // bare name
    { principal: 'group:x', action: '', resource: '*', effect: 'deny' },
    { principal: 'group:x', action: 'x', resource: '*', effect: 'maybe' },
    { principal: 'group:x', action: 'x', effect: 'deny' },                     // no resource
  ]) {
    const res = await fetch(`${base}/api/v1/grants`, {
      method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(bad),
    });
    assert.equal(res.status, 400, JSON.stringify(bad));
  }
});

test('(e) every mutation audited with the full tuple', async () => {
  const actions = (await store.listAudit()).filter((e) => e.action.startsWith('grant.'));
  assert.ok(actions.some((e) => e.action === 'grant.create' && e.subject === 'grant:group:marketing'
    && e.payload?.action === 'export.download' && e.payload?.effect === 'deny'));
  assert.ok(actions.some((e) => e.action === 'grant.delete' && e.subject === 'grant:group:marketing'));
  assert.ok(actions.some((e) => e.action === 'grant.create' && e.payload?.action === 'catalog.provider.credential'));
});
