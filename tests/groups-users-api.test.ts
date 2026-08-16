/**
 * End-to-end over real HTTP for the People/Groups control surface (plans/02):
 * the group registry (IdP mirror + local groups), login-durable local-group
 * assignment, instant disable with the owner guard, and catalog asset inspect.
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
import { mintSessionCookie } from '../server/src/iam/sessions.ts';

let server: Server;
let base = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(
    join(pack, 'catalog', 'assets', 'index.json'),
    JSON.stringify({
      assets: [{
        id: 'brand/logo/primary', type: 'vector', tags: ['logo', 'horizontal'],
        formats: [{ format: 'svg', url: '/catalog/logos/primary.svg' }],
      }],
    }),
  );
  const config = parseConfig(JSON.stringify({
    instance: { name: 'People Hub', baseUrl: 'http://localhost', pack },
    policy: { telemetry: 'aggregate' },
    dev: {
      enabled: true,
      users: [
        { email: 'owner@test', name: 'Olive Owner', groups: ['owner'] },
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'staff@test', name: 'Sam Staff', groups: ['staff'] },
      ],
    },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!).split(';')[0] as string;
}

async function usersByEmail(cookie: string): Promise<Map<string, { id: string; role: string; idpGroups: string[]; localGroups: string[]; groups: string[]; disabled: boolean }>> {
  const { users } = await (await fetch(`${base}/api/v1/users?pageSize=200`, { headers: { cookie } })).json() as {
    users: Array<{ id: string; email: string; role: string; idpGroups: string[]; localGroups: string[]; groups: string[]; disabled: boolean }>;
  };
  return new Map(users.map((u) => [u.email, u]));
}

test('users list is paginated: total + page + pageSize, per-user idp/local split', async () => {
  const owner = await login('owner@test');
  await login('admin@test');
  await login('staff@test'); // three sessions → three users
  const res = await fetch(`${base}/api/v1/users?pageSize=2&page=1&sort=email&dir=asc`, { headers: { cookie: owner } });
  const body = await res.json() as { users: Array<{ email: string; idpGroups: string[]; localGroups: string[] }>; total: number; page: number; pageSize: number };
  assert.equal(body.total, 3);
  assert.equal(body.page, 1);
  assert.equal(body.pageSize, 2);
  assert.equal(body.users.length, 2);
  const staff = (await usersByEmail(owner)).get('staff@test')!;
  assert.deepEqual(staff.idpGroups, ['staff']);
  assert.deepEqual(staff.localGroups, []);
  // Opt-out invisibility (plans/09 §2a): consent is never on the admin wire,
  // and a ?telemetry= filter is not a recognised parameter (silently ignored,
  // never narrowing - an admin cannot enumerate who opted out).
  for (const u of body.users) assert.ok(!('telemetryConsent' in u), 'consent leaked onto the users wire');
  const filtered = await (await fetch(`${base}/api/v1/users?telemetry=out&pageSize=200`, { headers: { cookie: owner } })).json() as { total: number };
  assert.equal(filtered.total, 3);
});

test('a plain member cannot see the groups registry', async () => {
  const staff = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/groups`, { headers: { cookie: staff } })).status, 403);
});

test('group registry: create local, list mirror, collision guards, delete', async () => {
  const admin = await login('admin@test');
  // create a local group
  const created = await fetch(`${base}/api/v1/groups`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'contractors', description: 'Brand-account delegates' }),
  });
  assert.equal(created.status, 201);
  // GET mirrors idp groups (owner/admin/staff, source idp) + our local one
  const { groups } = await (await fetch(`${base}/api/v1/groups`, { headers: { cookie: admin } })).json() as {
    groups: Array<{ name: string; source: string; memberCount: number; description?: string }>;
  };
  const contractors = groups.find((g) => g.name === 'contractors');
  assert.equal(contractors?.source, 'local');
  assert.equal(contractors?.memberCount, 0);
  assert.equal(groups.find((g) => g.name === 'staff')?.source, 'idp');
  // a local group can't shadow an IdP group name
  const collide = await fetch(`${base}/api/v1/groups`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'staff' }),
  });
  assert.equal(collide.status, 409);
  // duplicate local name
  const dup = await fetch(`${base}/api/v1/groups`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'contractors' }),
  });
  assert.equal(dup.status, 409);
  // bad name shape
  const bad = await fetch(`${base}/api/v1/groups`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'has spaces!' }),
  });
  assert.equal(bad.status, 400);
});

test('local-groups are login-durable and can carry a role; delete strips membership', async () => {
  const admin = await login('admin@test');
  // a local group named after a role escalates via the effective union
  await fetch(`${base}/api/v1/groups`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'approver' }),
  });
  const staffId = (await usersByEmail(admin)).get('staff@test')!.id;

  // assign local groups (never touches idpGroups)
  const put = await fetch(`${base}/api/v1/users/${staffId}/local-groups`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ groups: ['contractors', 'approver'] }),
  });
  assert.equal(put.status, 200);
  const updated = await put.json() as { idpGroups: string[]; localGroups: string[]; groups: string[]; role: string };
  assert.deepEqual(updated.idpGroups, ['staff'], 'idp mirror untouched');
  assert.deepEqual(updated.localGroups.sort(), ['approver', 'contractors']);
  assert.deepEqual(updated.groups, ['staff', 'contractors', 'approver']);
  assert.equal(updated.role, 'approver', 'role recomputed on the union');

  // unknown local group is rejected
  const unknown = await fetch(`${base}/api/v1/users/${staffId}/local-groups`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ groups: ['not-a-group'] }),
  });
  assert.equal(unknown.status, 400);

  // re-login (dev auth upserts the same sub): idp refreshes, local groups DURABLE
  await login('staff@test');
  const after = (await usersByEmail(admin)).get('staff@test')!;
  assert.deepEqual(after.localGroups.sort(), ['approver', 'contractors'], 'local groups survive re-login');
  assert.equal(after.role, 'approver');

  // deleting the local group strips it from the member and recomputes role
  assert.equal((await fetch(`${base}/api/v1/groups/approver`, { method: 'DELETE', headers: { cookie: admin } })).status, 200);
  const stripped = (await usersByEmail(admin)).get('staff@test')!;
  assert.ok(!stripped.groups.includes('approver'));
  assert.equal(stripped.role, 'member');
  // deleting a non-local group → 404
  assert.equal((await fetch(`${base}/api/v1/groups/staff`, { method: 'DELETE', headers: { cookie: admin } })).status, 404);
});

test('disable is an instant lockout; an owner can only be disabled by an owner', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  const staffCookie = await login('staff@test');
  const staffId = (await usersByEmail(admin)).get('staff@test')!.id;
  const ownerId = (await usersByEmail(admin)).get('owner@test')!.id;

  // admin cannot disable an owner
  const guard = await fetch(`${base}/api/v1/users/${ownerId}/disabled`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(guard.status, 403);

  // admin disables staff → their live session is locked out immediately
  const off = await fetch(`${base}/api/v1/users/${staffId}/disabled`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: true }),
  });
  assert.equal(off.status, 200);
  assert.equal((await off.json() as { disabled: boolean }).disabled, true);
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: staffCookie } })).status, 401);

  // re-enable
  const on = await fetch(`${base}/api/v1/users/${staffId}/disabled`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
    body: JSON.stringify({ disabled: false }),
  });
  assert.equal(on.status, 200);
  assert.equal((await on.json() as { disabled: boolean }).disabled, false);
});

test('catalog inspect: index entry merged with lifecycle state; 404 when neither', async () => {
  const staff = await login('staff@test'); // member-readable
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/assets/brand/logo/primary`, { headers: { cookie: staff } });
  assert.equal(res.status, 200);
  const meta = await res.json() as { id: string; type: string; tags: string[]; formats: unknown[]; state: string; lifecycle: null | { state: string } };
  assert.equal(meta.id, 'brand/logo/primary');
  assert.equal(meta.type, 'vector');
  assert.deepEqual(meta.tags, ['logo', 'horizontal']);
  assert.equal(meta.state, 'live');
  assert.equal(meta.lifecycle, null);

  // revoke via lifecycle admin, then re-inspect → state follows
  await fetch(`${base}/api/v1/catalog/lifecycle/brand/logo/primary`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ revoke: true }),
  });
  const after = await (await fetch(`${base}/api/v1/catalog/assets/brand/logo/primary`, { headers: { cookie: staff } })).json() as {
    state: string; lifecycle: { state: string; revokedAt: string | null };
  };
  assert.equal(after.state, 'revoked');
  assert.ok(after.lifecycle.revokedAt);

  // an id in neither the index nor lifecycle → 404
  assert.equal((await fetch(`${base}/api/v1/catalog/assets/nope/nope`, { headers: { cookie: staff } })).status, 404);
});

test('revoke-sessions ends a live session pre-expiry; owner guard; fresh login restores', async () => {
  const admin = await login('admin@test');
  const staffCookie = await login('staff@test');
  const staffId = (await usersByEmail(admin)).get('staff@test')!.id;
  const ownerId = (await usersByEmail(admin)).get('owner@test')!.id;

  // the unexpired session works…
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: staffCookie } })).status, 200);

  // an admin cannot revoke an owner's sessions (same guard as disable)
  const guard = await fetch(`${base}/api/v1/users/${ownerId}/revoke-sessions`, { method: 'POST', headers: { cookie: admin } });
  assert.equal(guard.status, 403);

  // …until revoked: the same cookie is refused on its next request
  const revoked = await fetch(`${base}/api/v1/users/${staffId}/revoke-sessions`, { method: 'POST', headers: { cookie: admin } });
  assert.equal(revoked.status, 200);
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: staffCookie } })).status, 401);

  // signing in again mints a token at the new epoch - access restored
  const fresh = await login('staff@test');
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: fresh } })).status, 200);

  // unknown user → 404
  assert.equal((await fetch(`${base}/api/v1/users/nope/revoke-sessions`, { method: 'POST', headers: { cookie: admin } })).status, 404);
});

test('a pre-epoch token (no epoch field) stays valid until an actual bump', async () => {
  const owner = await login('owner@test');
  const ownerId = (await usersByEmail(owner)).get('owner@test')!.id;
  // Back-compat: tokens minted before the epoch existed carry none - a missing
  // epoch reads as 0, matching the column default, so it verifies fine…
  const legacy = mintSessionCookie(
    { sub: 'dev:owner@test', email: 'owner@test', name: 'Olive Owner', groups: ['owner'], role: 'owner' },
    's3', false,
  ).split(';')[0] as string;
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: legacy } })).status, 200);
  // …and dies like any other token once the epoch is bumped
  assert.equal((await fetch(`${base}/api/v1/users/${ownerId}/revoke-sessions`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/org-config`, { headers: { cookie: legacy } })).status, 401);
});
