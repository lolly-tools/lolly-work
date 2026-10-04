// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { boot, devLogin, jar, openPage, postForm, project, snapshot, startAndReturn, type Env } from './invite-harness.ts';
import { readInviteToken } from '../server/src/access/invite-token.ts';
import { LINK_SECRET } from './invite-harness.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

async function mint(env: Env, role: 'viewer' | 'editor', cookie = env.adminSession, sessionId?: string) {
  const res = await fetch(`${env.base}/api/v1/projects/prj_event/invite-links`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', 'x-lolly-client': 'web' }, body: JSON.stringify({ role, ...(sessionId ? { sessionId } : {}) }) });
  assert.ok(res.ok, await res.clone().text());
  const value = await res.json() as { id: string; url: string; role: 'viewer' | 'editor'; allowNewPeople: boolean; expiresAt: string };
  return { ...value, path: new URL(value.url).pathname + new URL(value.url).search };
}
async function join(env: Env, link: Awaited<ReturnType<typeof mint>>, cookie: string) {
  const page = await openPage(env.base, link.path, cookie);
  return postForm(env.base, '/api/auth/project-link', { id: link.id, sig: new URL(link.url).searchParams.get('s')!, csrf: page.csrf, action: 'join' }, jar(cookie, page.form));
}
async function existing(env: Env, email: string) { const cookie = await devLogin(env.base, email), user = (await env.store.findUsersByEmail(email))[0]!; await env.store.upsertUserBySub({ ...user, groups: [] }); return cookie; }
async function setup() { const env = await boot(); await project(env, 'prj_event', 'Event materials'); return env; }

test('Postgres stores and revokes a reusable document invitation with its role and account scope', { skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async store => {
    const issuer = await store.upsertUserBySub({ sub: 'project-link-issuer', email: 'issuer@example.invalid', groups: [], role: 'admin' });
    const row = { id: 'lnk_reusable', kind: 'project-invite' as const, createdBy: issuer.id, createdAt: new Date().toISOString(), exp: Math.floor(Date.now() / 1000) + 3600,
      target: { sessionId: 'ses_deck', projectInvite: { projectId: 'prj_event', role: 'viewer' as const, allowNewPeople: true } } };
    await store.putLink(row); assert.deepEqual(await store.getLink(row.id), row);
    await store.revokeLink(row.id, new Date().toISOString()); assert.ok((await store.getLink(row.id))?.revokedAt);
  });
});

test('one reusable Editor link admits multiple signed-in people and GET does not grant access', async () => {
  const env = await setup(), link = await mint(env, 'editor');
  assert.equal((await mint(env, 'editor')).url, link.url, 'copying returns the active reusable link');
  const first = await existing(env, 'priya@admin.example'), second = await existing(env, 'owner@admin.example');
  const before = await snapshot(env.store);
  assert.equal((await openPage(env.base, link.path, second)).res.status, 200);
  assert.equal(await snapshot(env.store), before);
  assert.equal((await env.store.listProjectMembers('prj_event')).length, 0);
  for (const cookie of [first, second]) assert.equal((await join(env, link, cookie)).status, 303);
  const members = await env.store.listProjectMembers('prj_event');
  assert.equal(members.length, 2); assert.ok(members.every(member => member.role === 'editor'));
  const viewer = await mint(env, 'viewer'); assert.notEqual(viewer.url, link.url);
  await join(env, viewer, second); assert.ok((await env.store.listProjectMembers('prj_event')).every(member => member.role === 'editor'), 'a viewer link does not lower existing edit access');
});

test('a regular project owner can share reusable links with existing users and cannot admit new accounts', async () => {
  const env = await setup(), memberCookie = await existing(env, 'priya@admin.example'), member = (await env.store.findUsersByEmail('priya@admin.example'))[0]!;
  await project(env, 'prj_event', 'Member event', member.id);
  const link = await mint(env, 'viewer', memberCookie); assert.equal(link.allowNewPeople, false);
  const page = await openPage(env.base, link.path); assert.ok(page.html.includes('already have a workspace account')); assert.ok(!page.html.includes('name="email"'));
  const refused = await postForm(env.base, '/api/auth/project-link', { id: link.id, sig: new URL(link.url).searchParams.get('s')!, csrf: page.csrf, action: 'new', email: 'new@work.example' }, page.form);
  assert.equal(refused.status, 403); assert.equal((await env.store.listInvitations()).length, 0);
  const other = await existing(env, 'owner@admin.example'); assert.equal((await join(env, link, other)).status, 303);
  assert.equal((await env.store.listProjectMembers('prj_event'))[0]?.role, 'viewer');
});

test('an admin reusable deck link proves a new email through the personal invitation and returns to that deck', async () => {
  const env = await setup();
  await env.store.putSession({ id: 'ses_deck', projectId: 'prj_event', toolId: 'design', toolVersion: '1.0.0', inputs: {}, meta: {}, createdBy: env.admin.id, updatedBy: env.admin.id, rev: 1, updatedAt: new Date().toISOString() });
  const link = await mint(env, 'viewer', env.adminSession, 'ses_deck'), page = await openPage(env.base, link.path);
  assert.ok(page.html.includes('New to this workspace?')); assert.equal(link.allowNewPeople, true);
  const redirect = await postForm(env.base, '/api/auth/project-link', { id: link.id, sig: new URL(link.url).searchParams.get('s')!, csrf: page.csrf, action: 'new', email: env.script.google.email }, page.form);
  assert.equal(redirect.status, 303); assert.equal((await env.store.listUsers()).length, 1, 'entering an email does not admit anyone');
  const token = new URL(redirect.headers.get('location')!).pathname.split('/').at(-1)!;
  assert.equal(readInviteToken(token, [LINK_SECRET])?.sessionId, 'ses_deck');
  const accepted = await startAndReturn(env, token, 'primary');
  assert.equal(accepted.done.status, 302, await accepted.done.clone().text()); assert.equal(accepted.done.headers.get('location'), '/#/team/ses_deck');
  assert.equal((await env.store.listProjectMembers('prj_event'))[0]?.role, 'viewer');
});

test('signature tampering, missing CSRF, expiry, revocation and lost issuer access do not admit anyone', async () => {
  const env = await setup(), cookie = await existing(env, 'priya@admin.example'), link = await mint(env, 'editor');
  assert.equal((await openPage(env.base, link.path.replace(/s=.*/, 's=bad'))).res.status, 410);
  const page = await openPage(env.base, link.path, cookie);
  const noCsrf = await postForm(env.base, '/api/auth/project-link', { id: link.id, sig: new URL(link.url).searchParams.get('s')!, action: 'join' }, jar(cookie, page.form));
  assert.equal(noCsrf.status, 403);
  const row = (await env.store.getLink(link.id))!; await env.store.putLink({ ...row, exp: 1 });
  assert.equal((await openPage(env.base, link.path)).res.status, 410); await env.store.putLink(row);
  const revoked = await fetch(`${env.base}/api/v1/projects/prj_event/invite-links/${link.id}`, { method: 'DELETE', headers: { cookie: env.adminSession, 'x-lolly-client': 'web' } }); assert.equal(revoked.status, 204);
  assert.equal((await join(env, link, cookie)).status, 403);
  const next = await mint(env, 'editor');
  const member = (await env.store.findUsersByEmail('priya@admin.example'))[0]!; await project(env, 'prj_event', 'Transferred', member.id);
  await env.store.upsertUserBySub({ ...env.admin, role: 'member', groups: [] });
  assert.equal((await openPage(env.base, next.path)).res.status, 410);
  assert.equal((await env.store.listProjectMembers('prj_event')).length, 0);
});
