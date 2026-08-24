/**
 * SCIM 2.0 provisioning (plans/31 section 8) over real HTTP, plus the pure
 * resource mapping in isolation.
 *
 * The wave earns its place on ONE operation - `active=false` deprovisions a
 * person and every live session of theirs dies on its next request - and the
 * suite pins that composition down: the SCIM patch flips the SAME disabled flag
 * and bumps the SAME session epoch the console's disable does, because SCIM is
 * another writer of the one identity model, not a second one. It also pins the
 * linkage that makes that true: a user SCIM provisions by externalId and the
 * same person signing in through OIDC resolve to one row (externalId IS the
 * sub), and the groups SCIM sets survive that sign-in.
 *
 * The dev provider stands in for the IdP for the admin (token-minting) half; the
 * protocol half is driven by the minted bearer exactly as a real IdP would.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import {
  applyMemberOps, parseGroupPatch, parseScimFilter, parseUserCreate, parseUserPatch, toBool,
} from '../server/src/scim/resources.ts';
import { bearerFromHeader, mintScimSecret, SCIM_TOKEN_PREFIX } from '../server/src/scim/tokens.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Booted {
  base: string;
  store: ReturnType<typeof createMemoryStore>;
}

async function boot(): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-scim-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'SCIM Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'viewer@test', groups: ['viewer'] },
    ] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sF', link: 'lF' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** Mint a provisioning token as the owner and return its one-time secret. */
async function mintToken(base: string, cookie: string, idp = 'keycloak'): Promise<string> {
  const res = await fetch(`${base}/api/v1/scim/tokens`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ idp }),
  });
  assert.equal(res.status, 201);
  return (await res.json() as { token: string }).token;
}

/** A SCIM protocol call authed by the bearer. */
function scim(base: string, token: string, method: string, path: string, body?: unknown): Promise<Response> {
  return fetch(`${base}/scim/v2/${path}`, {
    method,
    headers: {
      authorization: `Bearer ${token}`,
      ...(body !== undefined ? { 'content-type': 'application/scim+json' } : {}),
    },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

// ── the pure mapping, in isolation ───────────────────────────────────────────

test('parseUserCreate: userName required, externalId is the durable subject and falls back to userName', () => {
  assert.deepEqual(parseUserCreate({ userName: 'a@x', externalId: 'kc-1', name: { givenName: 'A', familyName: 'X' } }), {
    sub: 'kc-1', email: 'a@x', firstname: 'A', lastname: 'X', active: true,
  });
  assert.deepEqual(parseUserCreate({ userName: 'a@x' }), { sub: 'a@x', email: 'a@x', active: true }, 'sub falls back to userName');
  assert.deepEqual(parseUserCreate({ userName: 'a@x', active: false }), { sub: 'a@x', email: 'a@x', active: false });
  assert.ok('error' in parseUserCreate({ name: { givenName: 'A' } }), 'no userName');
  assert.ok('error' in parseUserCreate({ userName: 'a@x', active: 'maybe' }), 'active must be boolean-ish');
});

test('toBool accepts booleans and the string form Azure sends', () => {
  assert.equal(toBool(true), true);
  assert.equal(toBool('False'), false);
  assert.equal(toBool('TRUE'), true);
  assert.equal(toBool('x'), null);
  assert.equal(toBool(1), null);
});

test('parseUserPatch reads active from path form, value-object form, and string boolean; ignores unknown attrs', () => {
  const asObj = (r: unknown) => r as { active?: boolean; firstname?: string; error?: string };
  assert.equal(asObj(parseUserPatch({ Operations: [{ op: 'replace', path: 'active', value: false }] })).active, false);
  assert.equal(asObj(parseUserPatch({ Operations: [{ op: 'replace', value: { active: false } }] })).active, false);
  assert.equal(asObj(parseUserPatch({ Operations: [{ op: 'replace', path: 'active', value: 'False' }] })).active, false);
  assert.equal(asObj(parseUserPatch({ Operations: [{ op: 'replace', path: 'name.givenName', value: 'Zed' }] })).firstname, 'Zed');
  // An IdP that also pushes displayName gets no 400 for the part we do not model.
  assert.deepEqual(parseUserPatch({ Operations: [{ op: 'replace', path: 'displayName', value: 'Z' }] }), {});
  assert.ok('error' in parseUserPatch({ Operations: [{ op: 'replace', path: 'active', value: 'yes' }] }));
  assert.ok('error' in parseUserPatch({ foo: 1 }));
});

test('parseGroupPatch understands add / replace / remove-all / the members[value eq] filter, and applyMemberOps folds them', () => {
  const ops = (b: unknown) => (parseGroupPatch(b) as { ops: unknown[] }).ops;
  assert.deepEqual(ops({ Operations: [{ op: 'add', path: 'members', value: [{ value: 'u1' }, { value: 'u2' }] }] }), [{ op: 'add', ids: ['u1', 'u2'] }]);
  assert.deepEqual(ops({ Operations: [{ op: 'remove', path: 'members[value eq "u1"]' }] }), [{ op: 'remove', ids: ['u1'] }]);
  assert.deepEqual(ops({ Operations: [{ op: 'remove', path: 'members' }] }), [{ op: 'removeAll' }]);
  assert.deepEqual(ops({ Operations: [{ op: 'replace', path: 'members', value: [{ value: 'u3' }] }] }), [{ op: 'replace', ids: ['u3'] }]);

  assert.deepEqual(applyMemberOps(['a', 'b'], [{ op: 'add', ids: ['c'] }]).sort(), ['a', 'b', 'c']);
  assert.deepEqual(applyMemberOps(['a', 'b'], [{ op: 'remove', ids: ['a'] }]), ['b']);
  assert.deepEqual(applyMemberOps(['a', 'b'], [{ op: 'removeAll' }]), []);
  assert.deepEqual(applyMemberOps(['a', 'b'], [{ op: 'replace', ids: ['x'] }]), ['x']);
});

test('parseScimFilter reads the one eq shape IdPs send, and nothing else', () => {
  assert.deepEqual(parseScimFilter('userName eq "a@x"'), { attr: 'userName', value: 'a@x' });
  assert.deepEqual(parseScimFilter('externalId eq "kc-1"'), { attr: 'externalId', value: 'kc-1' });
  assert.equal(parseScimFilter('displayName co "a"'), null, 'an unsupported filter is ignored, not misread');
  assert.equal(parseScimFilter(null), null);
});

test('bearerFromHeader is case-insensitive on the scheme and trims, and a minted secret carries its prefix', () => {
  assert.equal(bearerFromHeader('Bearer abc'), 'abc');
  assert.equal(bearerFromHeader('bearer  xyz '), 'xyz');
  assert.equal(bearerFromHeader('Basic abc'), null);
  assert.equal(bearerFromHeader(undefined), null);
  assert.ok(mintScimSecret().secret.startsWith(SCIM_TOKEN_PREFIX));
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0021 follows 0020 and declares the token store with no foreign key', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0021_scim.sql');
  assert.ok(at > 0, '0021 is on disk');
  assert.equal(files[at - 1], '0020_catalog_asset_versions.sql', '0021 follows 0020 with nothing between');
  // The ceiling assertion moved with the ceiling: tests/fleet-installs.test.ts
  // owns it now (0022, plans/34 wave 3).
  const sql = await readFile(join(dir, '0021_scim.sql'), 'utf8');
  assert.match(sql, /create table scim_tokens/);
  assert.match(sql, /token_hash\s+text not null unique/);
  assert.equal(/references\s+users/i.test(sql), false, 'idp is a label, not a foreign key');
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false, 'the runner wraps each file in its own transaction');
  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into scim_tokens/);
});

// ── admin: minting tokens ────────────────────────────────────────────────────

test('minting a token is owner-only, returns the secret once, and never again', async () => {
  const { base } = await boot();
  const viewer = await login(base, 'viewer@test');
  const owner = await login(base, 'owner@test');

  assert.equal((await fetch(`${base}/api/v1/scim/tokens`, {
    method: 'POST', headers: { cookie: viewer, 'content-type': 'application/json' }, body: JSON.stringify({ idp: 'kc' }),
  })).status, 403, 'a viewer cannot mint');

  const minted = await fetch(`${base}/api/v1/scim/tokens`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ idp: 'keycloak' }),
  });
  assert.equal(minted.status, 201);
  const body = await minted.json() as { id: string; token: string };
  assert.ok(body.token.startsWith(SCIM_TOKEN_PREFIX), 'the secret is returned once, at mint');

  // The list is metadata only: no secret, no hash.
  const list = await (await fetch(`${base}/api/v1/scim/tokens`, { headers: { cookie: owner } })).json() as { tokens: Array<Record<string, unknown>> };
  assert.equal(list.tokens.length, 1);
  assert.equal(list.tokens[0]!.idp, 'keycloak');
  assert.equal(list.tokens[0]!.token, undefined, 'never the secret');
  assert.equal(list.tokens[0]!.tokenHash, undefined, 'never the hash');

  assert.equal((await fetch(`${base}/api/v1/scim/tokens`, {
    method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({}),
  })).status, 400, 'idp label is required');
});

// ── protocol auth ────────────────────────────────────────────────────────────

test('the protocol half refuses no bearer, a garbage bearer, and a revoked one', async () => {
  const { base } = await boot();
  const owner = await login(base, 'owner@test');
  const token = await mintToken(base, owner);

  assert.equal((await fetch(`${base}/scim/v2/Users`)).status, 401, 'no bearer');
  assert.equal((await scim(base, 'scim_garbage', 'GET', 'Users')).status, 401, 'unknown token');

  // Revoke it, and the same bearer stops working.
  const list = await (await fetch(`${base}/api/v1/scim/tokens`, { headers: { cookie: owner } })).json() as { tokens: Array<{ id: string }> };
  const id = list.tokens[0]!.id;
  assert.equal((await fetch(`${base}/api/v1/scim/tokens/${id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200);
  assert.equal((await scim(base, token, 'GET', 'Users')).status, 401, 'a revoked token is dead');
  // Revoking again is a no-op 404 (it was already revoked).
  assert.equal((await fetch(`${base}/api/v1/scim/tokens/${id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 404);
});

// ── users ────────────────────────────────────────────────────────────────────

test('create, find, and read users; a duplicate externalId is a 409 uniqueness', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));

  const created = await scim(base, token, 'POST', 'Users', {
    schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
    userName: 'ada@corp', externalId: 'kc-ada', name: { givenName: 'Ada', familyName: 'Lovelace' },
  });
  assert.equal(created.status, 201);
  const user = await created.json() as { id: string; externalId: string; active: boolean };
  assert.equal(user.externalId, 'kc-ada');
  assert.equal(user.active, true);
  assert.equal(created.headers.get('location')?.endsWith(`/scim/v2/Users/${user.id}`), true);
  // externalId became the sub, which is what makes provisioning and OIDC login
  // resolve to one row.
  assert.equal((await store.getUser(user.id))?.sub, 'kc-ada');

  // A duplicate externalId is refused, not silently merged.
  assert.equal((await scim(base, token, 'POST', 'Users', { userName: 'ada2@corp', externalId: 'kc-ada' })).status, 409);

  // Found by the existence-check filters the IdP sends before create.
  const byName = await (await scim(base, token, 'GET', 'Users?filter=' + encodeURIComponent('userName eq "ada@corp"'))).json() as { totalResults: number; Resources: Array<{ id: string }> };
  assert.equal(byName.totalResults, 1);
  assert.equal(byName.Resources[0]!.id, user.id);
  const byExt = await (await scim(base, token, 'GET', 'Users?filter=' + encodeURIComponent('externalId eq "kc-ada"'))).json() as { totalResults: number };
  assert.equal(byExt.totalResults, 1);

  assert.equal((await scim(base, token, 'GET', `Users/${user.id}`)).status, 200);
  assert.equal((await scim(base, token, 'GET', 'Users/nope')).status, 404);
});

test('create with active:false lands a suspended account (disabled + epoch set from the start)', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const created = await (await scim(base, token, 'POST', 'Users', { userName: 'temp@corp', externalId: 'kc-temp', active: false })).json() as { id: string; active: boolean };
  assert.equal(created.active, false);
  const rec = await store.getUser(created.id);
  assert.ok(rec?.disabledAt, 'disabled from the start');
  assert.equal(rec?.sessionEpoch, 1, 'the epoch is already past 0, so no pre-mint session is live');
});

test('PATCH active=false is the deprovision: it disables AND bumps the epoch, exactly as the console disable does', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const { id } = await (await scim(base, token, 'POST', 'Users', { userName: 'leaver@corp', externalId: 'kc-leaver' })).json() as { id: string };
  assert.equal((await store.getUser(id))?.sessionEpoch, 0, 'epoch starts at 0 for a live account');

  const patched = await scim(base, token, 'PATCH', `Users/${id}`, {
    schemas: ['urn:ietf:params:scim:api:messages:2.0:PatchOp'],
    Operations: [{ op: 'replace', path: 'active', value: false }],
  });
  assert.equal(patched.status, 200);
  assert.equal((await patched.json() as { active: boolean }).active, false);
  const gone = await store.getUser(id);
  assert.ok(gone?.disabledAt, 'disabled - resolveMember now rejects the cookie');
  assert.equal(gone?.sessionEpoch, 1, 'and the epoch bumped, so any live session dies on its next request');

  // Re-enable clears the flag and does NOT bump again (the console rule).
  await scim(base, token, 'PATCH', `Users/${id}`, { Operations: [{ op: 'replace', value: { active: true } }] });
  const back = await store.getUser(id);
  assert.equal(back?.disabledAt, undefined);
  assert.equal(back?.sessionEpoch, 1, 're-enable does not bump');
});

test('PATCH of a name leaves membership and the disabled flag alone', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const { id } = await (await scim(base, token, 'POST', 'Users', { userName: 'nn@corp', externalId: 'kc-nn', name: { givenName: 'N', familyName: 'N' } })).json() as { id: string };
  // Give the user a local group and a disabled flag through the SCIM surfaces…
  await scim(base, token, 'POST', 'Groups', { displayName: 'design' });
  await scim(base, token, 'PATCH', 'Groups/design', { Operations: [{ op: 'add', path: 'members', value: [{ value: id }] }] });
  await scim(base, token, 'PATCH', `Users/${id}`, { Operations: [{ op: 'replace', path: 'active', value: false }] });
  const epochBefore = (await store.getUser(id))!.sessionEpoch;

  // …then rename, and neither moves.
  await scim(base, token, 'PATCH', `Users/${id}`, { Operations: [{ op: 'replace', path: 'name.givenName', value: 'Nora' }] });
  const rec = await store.getUser(id);
  assert.equal(rec?.firstname, 'Nora');
  assert.deepEqual(rec?.localGroups, ['design'], 'membership untouched by a name edit');
  assert.ok(rec?.disabledAt, 'still disabled');
  assert.equal(rec?.sessionEpoch, epochBefore, 'a name edit does not bump the epoch');
});

test('DELETE is a soft deprovision: the row and its trail stay, disabled', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const { id } = await (await scim(base, token, 'POST', 'Users', { userName: 'ex@corp', externalId: 'kc-ex' })).json() as { id: string };
  assert.equal((await scim(base, token, 'DELETE', `Users/${id}`)).status, 204);
  const rec = await store.getUser(id);
  assert.ok(rec, 'the row is not erased');
  assert.ok(rec?.disabledAt, 'it is disabled');
});

// ── the externalId ↔ OIDC linkage ─────────────────────────────────────────────

test('a SCIM-provisioned user and the same person signing in are one row, and SCIM-set groups survive the sign-in', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const { id } = await (await scim(base, token, 'POST', 'Users', { userName: 'sync@corp', externalId: 'kc-sync' })).json() as { id: string };
  await scim(base, token, 'POST', 'Groups', { displayName: 'brand-council' });
  await scim(base, token, 'PATCH', 'Groups/brand-council', { Operations: [{ op: 'add', path: 'members', value: [{ value: id }] }] });

  // OIDC login is an upsert BY SUB - and the SCIM externalId is the sub. So the
  // same person signing in re-uses the row, refreshing idpGroups while the
  // SCIM-set localGroups stay.
  const afterLogin = await store.upsertUserBySub({ sub: 'kc-sync', email: 'sync@corp', groups: ['engineering'], role: 'member' });
  assert.equal(afterLogin.id, id, 'one row, not two');
  assert.deepEqual(afterLogin.idpGroups, ['engineering'], 'idp groups refreshed from the token');
  assert.ok(afterLogin.localGroups.includes('brand-council'), 'the SCIM-set group survived the sign-in');
  assert.ok(afterLogin.groups.includes('brand-council') && afterLogin.groups.includes('engineering'), 'effective membership is the union');
});

// ── groups (membership) ───────────────────────────────────────────────────────

test('group membership: create, add and remove members, list, and delete strips it from everyone', async () => {
  const { base, store } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const a = await (await scim(base, token, 'POST', 'Users', { userName: 'a@corp', externalId: 'kc-a' })).json() as { id: string };
  const b = await (await scim(base, token, 'POST', 'Users', { userName: 'b@corp', externalId: 'kc-b' })).json() as { id: string };

  assert.equal((await scim(base, token, 'POST', 'Groups', { displayName: 'marketing' })).status, 201);
  assert.equal((await scim(base, token, 'POST', 'Groups', { displayName: 'marketing' })).status, 409, 'duplicate group');

  // Add both, then remove one via the members[value eq] filter form.
  await scim(base, token, 'PATCH', 'Groups/marketing', { Operations: [{ op: 'add', path: 'members', value: [{ value: a.id }, { value: b.id }] }] });
  assert.deepEqual((await store.getUser(a.id))?.localGroups, ['marketing']);
  assert.deepEqual((await store.getUser(b.id))?.localGroups, ['marketing']);

  const view = await (await scim(base, token, 'GET', 'Groups/marketing')).json() as { members: Array<{ value: string }> };
  assert.deepEqual(view.members.map((m) => m.value).sort(), [a.id, b.id].sort());

  await scim(base, token, 'PATCH', 'Groups/marketing', { Operations: [{ op: 'remove', path: `members[value eq "${a.id}"]` }] });
  assert.deepEqual((await store.getUser(a.id))?.localGroups, [], 'removed');
  assert.deepEqual((await store.getUser(b.id))?.localGroups, ['marketing'], 'the other stays');

  // A member id naming no user is ignored, never invented.
  await scim(base, token, 'PATCH', 'Groups/marketing', { Operations: [{ op: 'add', path: 'members', value: [{ value: 'ghost' }] }] });
  assert.equal((await scim(base, token, 'GET', 'Groups/marketing')).status, 200);

  // Delete the group: gone from the registry and off every member.
  assert.equal((await scim(base, token, 'DELETE', 'Groups/marketing')).status, 204);
  assert.equal((await scim(base, token, 'GET', 'Groups/marketing')).status, 404);
  assert.deepEqual((await store.getUser(b.id))?.localGroups, [], 'stripped from the last member');
});

test('ServiceProviderConfig declares the honest capability set', async () => {
  const { base } = await boot();
  const token = await mintToken(base, await login(base, 'owner@test'));
  const spc = await (await scim(base, token, 'GET', 'ServiceProviderConfig')).json() as {
    patch: { supported: boolean }; bulk: { supported: boolean }; changePassword: { supported: boolean };
  };
  assert.equal(spc.patch.supported, true);
  assert.equal(spc.bulk.supported, false);
  assert.equal(spc.changePassword.supported, false);
});
