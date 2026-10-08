// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { boot, project, devLogin } from './invite-harness.ts';
import { buildProjectTransferInventory, InventoryLimitError, TRANSFER_INVENTORY_LIMITS } from '../server/src/projects/transfer-inventory.ts';
import type { Store, SessionRecord } from '../server/src/store/types.ts';

const now = () => new Date().toISOString();
async function session(store: Store, projectId: string, id: string, userId: string) {
  const row: SessionRecord = { id, projectId, toolId: 'design', toolVersion: '1', rev: 4, createdBy: userId,
    updatedBy: userId, updatedAt: now(), inputs: { token: 'PRIVATE_DOCUMENT_SENTINEL' }, meta: { token: 'PRIVATE_META_SENTINEL' } };
  await store.putSession(row); return row;
}

test('transfer inventory projects metadata only, preserves source and discloses incomplete coverage', async () => {
  const env = await boot(); await project(env, 'prj_preview', 'Move planning');
  const saved = await session(env.store, 'prj_preview', 'ses_preview', env.admin.id);
  const digest = 'a'.repeat(64);
  assert.equal(await env.store.reserveProjectFile({ id: 'fil_preview', projectId: 'prj_preview', name: 'PRIVATE_FILENAME_SENTINEL',
    size: 3, checksum: digest, contentType: 'image/png', parts: [{ size: 3, checksum: digest }], asset: { url: 'https://example.invalid/PRIVATE_URL_SENTINEL', secret: 'PRIVATE_ASSET_SENTINEL' },
    createdBy: env.admin.id, createdAt: now(), expiresAt: new Date(Date.now() + 10000).toISOString(), ready: false },
  { projectBudgetBytes: 1000000, instanceBudgetBytes: 1000000, maxPending: 10, maxPendingBytes: 1000000 }), 'reserved');
  await env.store.completeProjectFile('fil_preview');
  await env.store.putProjectFolder({ id: 'fld_preview', projectId: 'prj_preview', parentId: null, name: 'PRIVATE_FOLDER_SENTINEL',
    createdAt: now(), createdBy: env.admin.id, items: [{ kind: 'session', ref: 'ses_preview' }, { kind: 'file', ref: 'fil_preview' }] });
  await env.store.assignProjectFolderItem('prj_preview', 'fld_preview', 'session', 'ses_preview');
  await env.store.assignProjectFolderItem('prj_preview', 'fld_preview', 'file', 'fil_preview');
  await env.store.putSessionVersion({ sessionId: saved.id, rev: saved.rev, kind: 'save', inputs: saved.inputs, meta: saved.meta, contributors: [] });
  const before = await env.store.getSession(saved.id);
  const response = await fetch(env.base + '/api/v1/projects/prj_preview/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store');
  const text = await response.text(), result = JSON.parse(text);
  assert.equal(result.schema, 'lolly-project-transfer-inventory-v1');
  assert.equal(result.snapshotConsistent, false); assert.equal(result.importReady, false); assert.equal(result.complete, false);
  assert.deepEqual(result.counts, { folders: 1, sessions: 1, files: 1, declaredFileBytes: 3, explicitMembers: 0, omittedSessions: 0 });
  assert.equal(result.files[0].declaredSha256, digest); assert.equal(result.files[0].bytesVerified, false);
  assert.equal(result.sessions[0].revision, 4); assert.equal(result.sessions[0].versionSample.count, 1);
  assert.equal(result.coverage.legacyRevisionHistory.inspected, false);
  assert.equal(result.coverage.assetDependenciesComplete, false);
  assert.equal(result.coverage.sessionVersionHistory.fullHistoryVerified, false);
  assert.match(result.observationSha256, /^[a-f0-9]{64}$/);
  for (const sentinel of ['PRIVATE_DOCUMENT', 'PRIVATE_META', 'PRIVATE_FILENAME', 'PRIVATE_URL', 'PRIVATE_ASSET', 'PRIVATE_FOLDER']) assert.ok(!text.includes(sentinel), sentinel);
  assert.deepEqual(await env.store.getSession(saved.id), before);
  assert.equal(await env.store.collabLeaseActive(saved.id), false);
});

test('authentication and project-specific deny grants gate preview, including an owner', async () => {
  const env = await boot(); await project(env, 'prj_denied', 'Denied');
  const path = env.base + '/api/v1/projects/prj_denied/transfer-inventory';
  assert.equal((await fetch(path)).status, 401);
  await env.store.putGrant({ principal: 'user:' + env.admin.id, action: 'project.manage', resource: 'project:prj_denied', effect: 'deny' });
  assert.equal((await fetch(path, { headers: { cookie: env.adminSession } })).status, 403);
});

test('automation and agent bearers never fall back to the signed-in administrative cookie', async () => {
  const env = await boot(); await project(env, 'prj_bearer', 'Bearer boundary');
  for (const bearer of ['lwt_service_example', 'lwa_document_example', 'lwp_project_example']) {
    const response = await fetch(env.base + '/api/v1/projects/prj_bearer/transfer-inventory', { headers: { cookie: env.adminSession, authorization: 'Bearer ' + bearer } });
    assert.equal(response.status, 403); assert.equal((await response.json() as { error: { code: string } }).error.code, 'MEMBER_SESSION_REQUIRED');
  }
});

test('viewers and managers without the inventory action cannot inspect', async () => {
  const env = await boot(); await project(env, 'prj_standing', 'Standing');
  const cookie = await devLogin(env.base, 'owner@admin.example');
  const user = (await env.store.findUsersByEmail('owner@admin.example'))[0]!;
  await env.store.upsertUserBySub({ sub: user.sub, email: user.email, role: 'member', groups: [] });
  await env.store.putProjectMember({ projectId: 'prj_standing', userId: user.id, role: 'manager', addedBy: env.admin.id, addedAt: now() });
  const path = env.base + '/api/v1/projects/prj_standing/transfer-inventory';
  assert.equal((await fetch(path, { headers: { cookie } })).status, 403);
  await env.store.putGrant({ principal: 'user:' + user.id, action: 'project.manage', resource: '*', effect: 'allow' });
  assert.equal((await fetch(path, { headers: { cookie } })).status, 200);
});

test('denied sessions are absent from rows and folder links, and their history is never read', async () => {
  const env = await boot(); await project(env, 'prj_hidden', 'Filtered');
  await session(env.store, 'prj_hidden', 'ses_allowed', env.admin.id);
  await session(env.store, 'prj_hidden', 'ses_DENIED_SENTINEL', env.admin.id);
  await env.store.putGrant({ principal: 'user:' + env.admin.id, action: 'session.view', resource: 'session:ses_DENIED_SENTINEL', effect: 'deny' });
  await env.store.putProjectFolder({ id: 'fld_links', projectId: 'prj_hidden', parentId: null, name: 'Links', createdAt: now(), createdBy: env.admin.id,
    items: [{ kind: 'session', ref: 'ses_allowed' }, { kind: 'session', ref: 'ses_DENIED_SENTINEL' }] });
  await env.store.assignProjectFolderItem('prj_hidden', 'fld_links', 'session', 'ses_allowed');
  await env.store.assignProjectFolderItem('prj_hidden', 'fld_links', 'session', 'ses_DENIED_SENTINEL');
  const versions = env.store.listSessionVersions.bind(env.store);
  env.store.listSessionVersions = (id, options) => { assert.notEqual(id, 'ses_DENIED_SENTINEL'); return versions(id, options); };
  const response = await fetch(env.base + '/api/v1/projects/prj_hidden/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 200); const text = await response.text(); assert.ok(!text.includes('ses_DENIED_SENTINEL'));
  const result = JSON.parse(text); assert.equal(result.counts.omittedSessions, 1); assert.deepEqual(result.folders[0].sessionIds, ['ses_allowed']);
  assert.ok(result.warnings.includes('SESSION_ACCESS_OMITTED'));
});

test('a permission revoked during inventory refuses the entire response', async () => {
  const env = await boot(); await project(env, 'prj_revoked', 'Revoked'); await session(env.store, 'prj_revoked', 'ses_revoke', env.admin.id);
  env.store.listSessionVersions = async () => {
    await env.store.putGrant({ principal: 'user:' + env.admin.id, action: 'session.view', resource: 'session:ses_revoke', effect: 'deny' }); return [];
  };
  const response = await fetch(env.base + '/api/v1/projects/prj_revoked/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 403); assert.equal((await response.json() as { error: { code: string } }).error.code, 'ACCESS_CHANGED');
});

test('large previews refuse before any history/lease or document reads', async () => {
  const env = await boot(); await project(env, 'prj_large', 'Large'); const p = (await env.store.getProject('prj_large'))!;
  const row = await session(env.store, p.id, 'ses_size', env.admin.id);
  const observe = env.store.observeProjectTransferMetadata.bind(env.store);
  env.store.observeProjectTransferMetadata = async (...args) => ({ ...await observe(...args), sessions: Array.from({ length: TRANSFER_INVENTORY_LIMITS.sessions + 1 }, (_, n) => ({ ...row, id: 'ses_' + n })) });
  env.store.listSessionVersions = async () => { throw new Error('unexpected history read'); };
  env.store.collabLeaseActive = async () => { throw new Error('unexpected lease read'); };
  await assert.rejects(buildProjectTransferInventory(env.store, p, () => true), InventoryLimitError);
  const response = await fetch(env.base + '/api/v1/projects/prj_large/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 413); assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVENTORY_LIMIT');
});

test('folder cycles and missing references are visible without exporting foreign identifiers', async () => {
  const env = await boot(); await project(env, 'prj_cycle', 'Folders');
  const observe = env.store.observeProjectTransferMetadata.bind(env.store);
  env.store.observeProjectTransferMetadata = async (...args) => ({ ...await observe(...args), folders: [{ id: 'fld_cycle', projectId: 'prj_cycle', parentId: 'fld_cycle',
    items: [{ kind: 'session', ref: 'FOREIGN_SESSION_SENTINEL' }, { kind: 'file', ref: 'FOREIGN_FILE_SENTINEL' }] }] });
  const inventory = await buildProjectTransferInventory(env.store, (await env.store.getProject('prj_cycle'))!, () => true);
  assert.ok(inventory.warnings.includes('FOLDER_CYCLE')); assert.equal(inventory.invalidFolderReferences, 2);
  assert.ok(!JSON.stringify(inventory).includes('FOREIGN_'));
});

test('a session moved to another project or deleted during inspection is withheld', async () => {
  for (const outcome of ['moved', 'deleted']) {
    const env = await boot(); await project(env, 'prj_before', 'Before'); await project(env, 'prj_after', 'After');
    const saved = await session(env.store, 'prj_before', 'ses_scope', env.admin.id);
    env.store.listSessionVersions = async () => {
      await env.store.putSession({ ...saved, ...(outcome === 'moved' ? { projectId: 'prj_after' } : { deletedAt: now() }) }); return [];
    };
    const response = await fetch(env.base + '/api/v1/projects/prj_before/transfer-inventory', { headers: { cookie: env.adminSession } });
    assert.equal(response.status, 403); const text = await response.text(); assert.ok(!text.includes('ses_scope'));
    assert.equal(JSON.parse(text).error.code, 'ACCESS_CHANGED');
  }
});

test('a changed durable revision refuses a stale preview without stopping collaboration', async () => {
  const env = await boot(); await project(env, 'prj_revision', 'Revisions'); const saved = await session(env.store, 'prj_revision', 'ses_revision', env.admin.id);
  env.store.listSessionVersions = async () => { await env.store.putSession({ ...saved, rev: saved.rev + 1 }); return []; };
  const response = await fetch(env.base + '/api/v1/projects/prj_revision/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 409); assert.equal((await response.json() as { error: { code: string } }).error.code, 'INVENTORY_CHANGED');
});

test('successful inspection never calls unbounded content or legacy listing methods', async () => {
  const env = await boot(); await project(env, 'prj_metadata', 'Metadata'); await session(env.store, 'prj_metadata', 'ses_metadata', env.admin.id);
  for (const method of ['getSession', 'listSessionRevisions', 'getCollabCheckpoint', 'getCollabJournal', 'listSessionSummaries', 'listProjectFiles', 'listProjectFolders', 'listProjectMembers'] as const) {
    Object.assign(env.store, { [method]: async () => { throw new Error('Unbounded or content read: ' + method); } });
  }
  const response = await fetch(env.base + '/api/v1/projects/prj_metadata/transfer-inventory', { headers: { cookie: env.adminSession } });
  assert.equal(response.status, 200);
});
