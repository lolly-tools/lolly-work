// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import type { Store } from '../server/src/store/types.ts';
import { LastOwnerError, readSubjectCursor, subjectCursor, subjectRow, SUBJECT_CATEGORIES } from '../server/src/privacy/subject.ts';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { resolveMember } from '../server/src/iam/member.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';

const now = '2026-10-13T00:00:00.000Z', secret = 'subject-control-session';
async function seed(store: Store) {
  const owner = await store.upsertUserBySub({ sub: 'owner', email: 'owner@fixture.test', groups: ['owner'], role: 'owner' });
  const subject = await store.upsertUserBySub({ sub: 'subject', email: 'subject@fixture.test', groups: [], role: 'member' });
  await store.linkIdentity({ identitySub: 'subject-alias', userId: subject.id, idp: 'primary', email: 'alias@fixture.test', emailVerified: true, linkedAt: now });
  await store.putProject({ id: 'project', name: 'Preserved project', visibility: 'private', ownerId: subject.id, createdAt: now });
  await store.putProjectMember({ projectId: 'project', userId: subject.id, role: 'manager', addedBy: owner.id, addedAt: now });
  for (const id of ['a', 'b', 'c']) {
    await store.putApiToken({ id, label: id, role: 'member', tokenHash: `hash-${id}`, createdBy: `user:${subject.id}`, createdAt: now });
    await store.putLink({ id, kind: 'share', target: { params: { private: 'hidden-content' }, toolId: 'sample' }, exp: 2e9, pwHash: 'hidden-password-hash', createdBy: subject.id, createdAt: now });
  }
  await store.putApiToken({ id: 'other', label: 'other', role: 'member', tokenHash: 'other-token-hash', createdBy: `user:${owner.id}`, createdAt: now });
  await store.putApiToken({ id: 'descendant', label: 'descendant', role: 'member', tokenHash: 'descendant-hash', createdBy: 'user:svc_a', createdAt: now });
  await store.createPasswordLink({ tokenHash: 'password-link-hash', email: 'alias@fixture.test', purpose: 'reset', createdBy: `user:${owner.id}`, createdAt: now, expiresAt: '2030-01-01T00:00:00.000Z' });
  await store.upsertInstall('device', { shell: 'web', shellVersion: '1', engine: '1', platform: 'linux' }, subject.id);
  await store.putEvents([{ event: 'tool.open', at: now, userId: subject.id, attrs: { toolId: 'sample' } }]);
  await store.appendAudit({ at: now, actor: `user:${subject.id}`, action: 'session.create', subject: 'session:sample', payload: { private: 'hidden-payload' } });
  return { owner, subject };
}

async function conformance(store: Store) {
  const { owner, subject } = await seed(store);
  for (const category of SUBJECT_CATEGORIES) {
    const page = await store.subjectRows(subject.id, category, '', 2);
    assert.ok(page.length >= 1 && page.length <= 2, category);
    assert.doesNotMatch(JSON.stringify(page), /hash-a|password-hash|hidden-content|hidden-payload|password-link-hash/);
  }
  const first = await store.subjectRows(subject.id, 'credentials', '', 2);
  assert.deepEqual(first.map(r => r.key), ['a', 'b']);
  assert.deepEqual((await store.subjectRows(subject.id, 'credentials', 'b', 2)).map(r => r.key), ['c']);
  const session = mintSessionCookie({ sub: subject.sub, email: subject.email, groups: [], role: 'member', name: 'Subject', epoch: subject.sessionEpoch }, secret, false).split(';')[0]!;
  assert.equal((await store.offboardUser(subject.id, owner.id, now, 2)).status, 'limit');
  assert.equal((await store.getUser(subject.id))!.disabledAt, undefined);
  assert.equal((await store.getLink('a'))!.revokedAt, undefined);
  const result = await store.offboardUser(subject.id, owner.id, now, 1000);
  assert.deepEqual(result, { status: 'disabled', sessionEpoch: subject.sessionEpoch + 1, credentialsRevoked: 3, linksRevoked: 3, passwordLinksRevoked: 1 });
  assert.equal(await resolveMember(store, session, secret), null);
  assert.equal((await store.getLink('a'))!.revokedAt, now);
  assert.equal((await store.findApiTokenByHash('hash-a'))!.revokedAt, now);
  assert.equal((await store.findApiTokenByHash('other-token-hash'))!.revokedAt, undefined);
  assert.equal((await store.findApiTokenByHash('descendant-hash'))!.revokedAt, undefined);
  assert.equal((await store.getProject('project'))!.ownerId, subject.id);
  assert.equal((await store.listIdentities(subject.id)).length, 1);
  assert.equal((await store.findLivePasswordLink('password-link-hash', now)), null);
  assert.equal((await store.offboardUser(owner.id, 'another-principal', now, 1000)).status, 'last-owner');
  await assert.rejects(store.setUserDisabled(owner.id, now), LastOwnerError);
  assert.equal((await store.offboardUser(owner.id, owner.id, now, 1000)).status, 'self');
}

test('memory subject pages omit secrets and bounded offboarding retains ownership and indirect issuance', async () => { await conformance(createMemoryStore()); });
test('PostgreSQL subject pages and offboarding have the same scope and last-owner safeguards', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, conformance);
});

test('continuation cursors bind account and category and output metadata has explicit limits', () => {
  const cursor = subjectCursor('one', 'credentials', 'b', secret);
  assert.equal(readSubjectCursor(cursor, 'one', 'credentials', secret), 'b');
  for (const args of [[cursor, 'two', 'credentials'], [cursor, 'one', 'links'], [`${cursor}x`, 'one', 'credentials']] as const) {
    assert.throws(() => readSubjectCursor(args[0], args[1], args[2], secret));
  }
  const row = subjectRow('key', { long: 'x'.repeat(2049), values: Array(129).fill('value') });
  assert.equal(row.value.metadataValuesOmitted, true);
  assert.equal((row.value.values as string[]).length, 128);
  assert.doesNotMatch(JSON.stringify(row), /x{2049}/);
});

test('HTTP export pages and offboarding require an owner, audit reads and enforce confirmation', async t => {
  const store = createMemoryStore(), config = parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, dev: { enabled: true }, rateLimit: { enabled: false } }));
  const app = buildApp({ store, config, secrets: { session: secret, link: 'subject-control-link' }, backgroundPollMs: 0 });
  const { owner, subject } = await seed(store);
  const admin = await store.upsertUserBySub({ sub: 'admin', email: 'admin@fixture.test', role: 'admin', groups: ['admin'] });
  await store.putGrant({ principal: `user:${admin.id}`, action: 'instance.config', resource: '*', effect: 'allow' });
  const cookie = (u: typeof owner) => mintSessionCookie({ sub: u.sub, email: u.email, groups: u.groups, role: u.role, name: 'Person', epoch: u.sessionEpoch }, secret, false).split(';')[0]!;
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => { server.closeAllConnections(); server.close(() => resolve()); }));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1/users/${subject.id}`;
  const get = (query = '', user = owner) => fetch(`${base}/subject-export?category=credentials&limit=2${query}`, { headers: { cookie: cookie(user) } });
  assert.equal((await fetch(`${base}/subject-export`)).status, 401);
  assert.equal((await get('', admin)).status, 403);
  const response = await get(); assert.equal(response.status, 200); assert.match(response.headers.get('cache-control')!, /\bno-store\b/);
  const first = await response.json() as { rows: { id: string }[]; nextCursor: string; completeSubjectExport: boolean; omissions: string[] };
  assert.deepEqual(first.rows.map(r => r.id), ['a', 'b']); assert.equal(first.completeSubjectExport, false); assert.ok(first.omissions.length);
  assert.deepEqual(((await (await get(`&cursor=${encodeURIComponent(first.nextCursor)}`)).json()) as { rows: { id: string }[] }).rows.map(r => r.id), ['c']);
  assert.equal((await get('&cursor=invalid')).status, 400);
  assert.equal((await fetch(`${base}/subject-export?limit=201`, { headers: { cookie: cookie(owner) } })).status, 400);
  const auth = mintServiceSecret();
  await store.putApiToken({ id: 'owner-operation', label: 'Owner operation', role: 'owner', tokenHash: auth.tokenHash, createdBy: `user:${owner.id}`, createdAt: now });
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/lw.ts', import.meta.url)), 'users', 'subject-export', subject.id,
      '--category', 'credentials', '--limit', '1', '--json', '--token', auth.secret, '--base', base.split('/api/v1/')[0]!], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.on('data', data => { stdout += data; }); child.stderr.on('data', data => { stderr += data; });
    child.on('error', reject); child.on('close', code => code === 0 ? resolve(stdout) : reject(new Error(stderr)));
  });
  assert.deepEqual((JSON.parse(output) as { rows: { id: string }[] }).rows.map(row => row.id), ['a']);
  const post = (body: unknown, user = owner) => fetch(`${base}/offboard`, { method: 'POST', headers: { cookie: cookie(user), 'content-type': 'application/json' }, body: JSON.stringify(body) });
  assert.equal((await post({ confirmUserId: subject.id }, admin)).status, 403);
  assert.equal((await post({})).status, 400);
  assert.equal((await fetch(`${base}/offboarding-preview`, { headers: { cookie: cookie(owner) } })).status, 200);
  const result = await post({ confirmUserId: subject.id }); assert.equal(result.status, 200);
  assert.equal((await result.json() as { completeOffboarding: boolean }).completeOffboarding, false);
  const log = await store.listAudit();
  assert.equal(log.filter(e => e.action === 'user.subject-export.read').length, 3);
  assert.ok(log.some(e => e.action === 'user.offboarding-preview.read'));
  assert.ok(log.some(e => e.action === 'user.offboard'));
  const ordinaryDisable = await fetch(`${base.replace(subject.id, owner.id)}/disabled`, { method: 'POST', headers: { cookie: cookie(owner), 'content-type': 'application/json' }, body: JSON.stringify({ disabled: true }) });
  assert.equal(ordinaryDisable.status, 409);
  assert.equal((await store.getUser(owner.id))!.disabledAt, undefined);
});

test('racing owner disable requests keep an active owner', async () => {
  const store = createMemoryStore();
  const users = await Promise.all(['one', 'two'].map(sub => store.upsertUserBySub({ sub, email: `${sub}@fixture.test`, groups: ['owner'], role: 'owner' })));
  const results = await Promise.allSettled(users.map(u => store.setUserDisabled(u.id, now)));
  assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
  assert.equal((await store.listUsers()).filter(u => !u.disabledAt && u.role === 'owner').length, 1);
});

test('PostgreSQL racing owner disable requests keep an active owner', { skip: !process.env.LW_TEST_DATABASE_URL }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    const users = await Promise.all(['one', 'two'].map(sub => store.upsertUserBySub({ sub, email: `${sub}@fixture.test`, groups: ['owner'], role: 'owner' })));
    const results = await Promise.allSettled(users.map(u => store.setUserDisabled(u.id, now)));
    assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
    assert.equal((await store.listUsers()).filter(u => !u.disabledAt && u.role === 'owner').length, 1);
  });
});
