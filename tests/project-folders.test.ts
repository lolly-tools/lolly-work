// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, devLogin, project } from './invite-harness.ts';

test('shared folder creation, nesting and assignment inherit project access without changing a document', async () => {
  const env = await boot(); await project(env, 'prj_folders', 'Shared folders'); await project(env, 'prj_elsewhere', 'Another project');
  const other = await devLogin(env.base, 'owner@admin.example');
  await env.store.upsertUserBySub({ sub: 'dev:owner@admin.example', email: 'owner@admin.example', groups: [], role: 'member' });
  const otherUser = await env.store.getUserBySub('dev:owner@admin.example'); assert.ok(otherUser);
  await env.store.putGrant({ principal: 'user:' + otherUser.id, action: 'project.manage', resource: '*', effect: 'deny' });
  await env.store.putProjectMember({ projectId: 'prj_folders', userId: otherUser.id, role: 'viewer', addedBy: 'user:' + env.admin.id, addedAt: new Date().toISOString() });
  const request = (path: string, method = 'GET', data?: unknown, cookie = env.adminSession) => fetch(env.base + path, { method, headers: { cookie, 'x-lolly-client': 'lw-cli engine/0', 'content-type': 'application/json' }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
  const base = '/api/v1/projects/prj_folders/folders';
  assert.equal((await request(base, 'POST', { name: 'Denied' }, other)).status, 403);
  const created = await request(base, 'POST', { name: 'Keynote material' }); assert.equal(created.status, 201);
  const { folder } = await created.json() as { folder: { id: string } };
  const child = await request(base, 'POST', { name: 'Images', parentId: folder.id }); assert.equal(child.status, 201);
  assert.equal((await request('/api/v1/projects/prj_elsewhere/folders', 'POST', { name: 'Cross project', parentId: folder.id })).status, 400);
  const listing = await request(base, 'GET', undefined, other); assert.equal(listing.status, 200); assert.equal((await listing.json() as { folders: unknown[] }).folders.length, 2);
  const now = new Date().toISOString(), session = { id: 'ses_folder', projectId: 'prj_folders', toolId: 'design', toolVersion: '1', inputs: { title: 'Keep this exactly' }, meta: {}, createdBy: env.admin.id, updatedBy: env.admin.id, rev: 1, updatedAt: now };
  await env.store.putSession(session);
  const path = base + '/items/session/ses_folder';
  assert.equal((await request(path, 'PUT', { folderId: folder.id }, other)).status, 403);
  assert.equal((await request(path, 'PUT', { folderId: folder.id })).status, 200);
  assert.deepEqual(await env.store.getSession(session.id), session);
  assert.deepEqual((await env.store.listProjectFolders('prj_folders')).find(f => f.id === folder.id)?.items, [{ kind: 'session', ref: session.id }]);
  assert.equal((await request('/api/v1/projects/prj_elsewhere/folders/items/session/ses_folder', 'PUT', { folderId: null })).status, 404);
  assert.equal((await request(path, 'PUT', { folderId: null })).status, 200);
  assert.equal((await request(base + '/' + folder.id, 'PATCH', { name: 'Renamed', parentId: folder.id })).status, 400);
  assert.equal((await request(base + '/' + folder.id, 'PATCH', { name: 'Renamed' })).status, 200);
  assert.equal((await request(base + '/items/file/missing', 'PUT', { folderId: folder.id })).status, 404);
});
