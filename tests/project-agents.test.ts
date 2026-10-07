// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { createCollabGateway } from '../server/src/collab/gateway.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import type { Store, UserRecord, ProjectAgentRecord } from '../server/src/store/types.ts';
import { fileChecksum, PROJECT_FILE_PART_BYTES } from '../server/src/projects/files.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { agentSecret } from '../server/src/agents/access.ts';

type Invitation = { secret: string; endpoint: string; agent: { id: string } };
type Value = { id: string; agent: { id: string; role: string }; revision: number; docState: { params: Record<string, unknown> }; replayed?: boolean; folder: { id: string }; file: { id: string }; assetId: string; dataBase64: string; sessions: unknown[]; assets: unknown[]; unfinishedUploads: { id: string }[]; folders: { items: unknown[] }[]; project: { archived: boolean } };
type Rpc = { result: { isError?: boolean; tools?: { name: string }[]; structuredContent?: Value; content?: { text: string }[] } };
async function exercise(store: Store) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-project-agents-'));
  await mkdir(join(pack, 'catalog/tools'), { recursive: true }); await mkdir(join(pack, 'tools/design'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify({ version: 1, tools: [] }));
  await writeFile(join(pack, 'tools/design/tool.json'), JSON.stringify({ id: 'design', inputs: [{ id: 'title', type: 'text' }, { id: 'boxes', type: 'blocks' }] }));
  const owner = await store.upsertUserBySub({ sub: 'owner', email: 'owner@example.invalid', groups: [], role: 'member' });
  const colleague = await store.upsertUserBySub({ sub: 'colleague', email: 'colleague@example.invalid', groups: [], role: 'member' });
  const viewer = await store.upsertUserBySub({ sub: 'viewer', email: 'viewer@example.invalid', groups: [], role: 'member' });
  const now = new Date().toISOString();
  for (const id of ['one', 'other']) await store.putProject({ id, name: id, ownerId: owner.id, visibility: 'private', createdAt: now });
  for (const [person, role] of [[colleague, 'editor'], [viewer, 'viewer']] as const) await store.putProjectMember({ projectId: 'one', userId: person.id, role, addedBy: owner.id, addedAt: now });
  await store.putSession({ id: 'outside', projectId: 'other', toolId: 'design', toolVersion: '1', inputs: { title: 'Private' }, meta: {}, createdBy: owner.id, updatedBy: owner.id, rev: 1, updatedAt: now });
  let app: ReturnType<typeof buildApp>;
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(JSON.stringify({ instance: { name: 'Projects', baseUrl: base, pack }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] } }));
  const gateway = createCollabGateway({ config, store, secrets: { session: 'test-session', link: 'test-link' } });
  const blobs = createMemoryBlobStore();
  app = buildApp({ config, store, blobs, agentRooms: gateway.agents, secrets: { session: 'test-session', link: 'test-link' } });
  // Live edits are attributed when the room closes (plan 76 M4); checked after the drain.
  let edited = { sessionId: '', agentId: '' };
  const cookie = (user: UserRecord) => mintSessionCookie({ sub: user.sub, email: user.email, name: user.sub, groups: user.groups, role: user.role, epoch: user.sessionEpoch }, 'test-session', false).split(';')[0]!;
  const http = (user: UserRecord, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { cookie: cookie(user), connection: 'close', ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const invite = async (user: UserRecord, role = 'editor') => {
    const response = await http(user, 'POST', '/api/v1/projects/one/agents', { label: `${user.sub} helper`, role, hours: 24 });
    assert.equal(response.status, 201); return await response.json() as Invitation;
  };
  const rpc = async (invitation: Invitation, method: string, params?: unknown, origin = base) => {
    const response = await fetch(base + '/api/workspace/mcp', { method: 'POST', headers: { authorization: `Bearer ${invitation.secret}`, origin, 'content-type': 'application/json', connection: 'close' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) });
    return { status: response.status, body: await response.json() as Rpc };
  };
  const call = async (invitation: Invitation, name: string, args: Record<string, unknown> = {}) => (await rpc(invitation, 'tools/call', { name, arguments: args })).body.result;
  const value = async (invitation: Invitation, name: string, args: Record<string, unknown> = {}) => {
    const result = await call(invitation, name, args); assert.equal(result.isError, undefined, result.content?.[0]?.text); assert.ok(result.structuredContent); return result.structuredContent;
  };
  try {
    const a = await invite(owner), b = await invite(colleague), readOnly = await invite(viewer, 'viewer');
    assert.equal((await http(viewer, 'POST', '/api/v1/projects/one/agents', { label: 'Escalation', role: 'editor', hours: 1 })).status, 403);
    const listing = await http(viewer, 'GET', '/api/v1/projects/one/agents'), listingText = await listing.text();
    assert.equal(listingText.includes(a.secret), false); assert.equal(listingText.includes('tokenHash'), false); assert.equal(listingText.includes('@'), false);
    const listed = JSON.parse(listingText) as { agents: { id: string; canRevoke: boolean }[] }; assert.equal(listed.agents.find(row => row.id === a.agent.id)?.canRevoke, false);
    assert.equal((await rpc(a, 'ping', {}, 'https://elsewhere.invalid')).status, 403);
    assert.equal((await fetch(base + '/api/v1/projects', { headers: { authorization: `Bearer ${a.secret}` } })).status, 401, 'project credentials do not grant REST access');
    const tools = (await rpc(readOnly, 'tools/list')).body.result.tools!.map(tool => tool.name);
    assert.ok(tools.includes('read_project')); assert.equal(tools.includes('create_session'), false); assert.equal(tools.includes('apply_document_ops'), false);
    assert.equal((await call(readOnly, 'create_session', { requestId: 'no', name: 'No', toolId: 'design' })).isError, true);

    const [first, simultaneous, second] = await Promise.all([value(a, 'create_session', { requestId: 'first', name: 'First', toolId: 'design' }),
      value(a, 'create_session', { requestId: 'first', name: 'First', toolId: 'design' }), value(b, 'create_session', { requestId: 'second', name: 'Second', toolId: 'design' })]);
    assert.equal(first.id, simultaneous.id); assert.equal([first, simultaneous].filter(result => result.replayed).length, 1);
    const creations = (await store.listAudit()).filter(event => event.action === 'session.create');
    assert.equal(creations.find(event => event.subject === `session:${first.id}`)?.actor, `agent:${a.agent.id}`);
    assert.equal(creations.find(event => event.subject === `session:${second.id}`)?.actor, `agent:${b.agent.id}`);
    assert.equal(creations.find(event => event.subject === `session:${second.id}`)?.payload?.invitedBy, `user:${colleague.id}`);
    assert.notEqual(first.id, second.id); assert.equal((await store.getSession(second.id))?.createdBy, colleague.id);
    const before = await value(a, 'read_document', { sessionId: first.id });
    const other = await value(a, 'read_document', { sessionId: second.id });
    assert.notEqual(before.agent.id, other.agent.id, 'room connections have separate identities');
    const changed = await value(b, 'apply_document_ops', { sessionId: first.id, expectedRevision: before.revision, batchId: 'title', ops: [{ k: 'param', key: 'title', value: 'By the team' }] });
    assert.equal(changed.docState.params.title, 'By the team');
    edited = { sessionId: first.id, agentId: b.agent.id };
    assert.ok((await store.listAudit()).some(event => event.action === 'collab.join' && event.actor === `agent:${b.agent.id}` && event.payload?.sessionId === first.id && event.payload?.invitedBy === `user:${colleague.id}`));
    const retry = await value(a, 'create_session', { requestId: 'first', name: 'First', toolId: 'design' });
    assert.equal(retry.id, first.id); assert.equal(retry.replayed, true); assert.equal((await store.getSession(first.id))?.inputs.title, 'By the team');
    assert.equal((await call(a, 'create_session', { requestId: 'first', name: 'Changed', toolId: 'design' })).isError, true);
    assert.equal((await call(a, 'read_document', { sessionId: 'outside' })).isError, true, 'even an owner’s agent stays inside its invited project');
    assert.equal((await call(a, 'read_project', { projectId: 'other' })).isError, true);
    const folder = await value(a, 'create_folder', { name: 'Campaign' });
    await value(b, 'move_project_item', { kind: 'session', ref: first.id, folderId: folder.folder.id });
    assert.deepEqual((await store.listProjectFolders('one'))[0]?.items, [{ kind: 'session', ref: first.id }]);
    assert.equal((await call(a, 'move_project_item', { kind: 'session', ref: 'outside', folderId: folder.folder.id })).isError, true);

    const bytes = Buffer.alloc(PROJECT_FILE_PART_BYTES + 37, 17), parts = [bytes.subarray(0, PROJECT_FILE_PART_BYTES), bytes.subarray(PROJECT_FILE_PART_BYTES)];
    const begun = await value(a, 'begin_asset_upload', { name: 'team-art.png', size: bytes.length, checksum: fileChecksum(bytes), contentType: 'image/png', parts: parts.map(part => ({ size: part.length, checksum: fileChecksum(part) })), asset: { type: 'raster', format: 'png', width: 1920, height: 640 } });
    const reserved = (await store.getProjectFile(begun.file.id))!;
    assert.equal(await store.reserveProjectFile({ ...reserved, id: 'fil_outside', projectId: 'other' }, { projectBudgetBytes: 100000000, instanceBudgetBytes: 100000000, maxPending: 16, maxPendingBytes: 100000000 }), 'reserved');
    for (let n = 0; n < 16; n++) assert.equal(await store.reserveProjectFile({ ...reserved, id: `expired_${n}`, expiresAt: '2000-01-01T00:00:00Z' },
      { projectBudgetBytes: 100000000, instanceBudgetBytes: 100000000, maxPending: 16, maxPendingBytes: 100000000 }), 'reserved');
    assert.deepEqual((await value(a, 'read_project')).unfinishedUploads.map(file => file.id), [begun.file.id], 'reservation recovery stays inside this project');
    assert.equal((await call(a, 'read_asset_part', { fileId: 'fil_outside', part: 0 })).isError, true);
    assert.equal((await call(a, 'upload_asset_part', { fileId: begun.file.id, part: 1, dataBase64: Buffer.alloc(37).toString('base64') })).isError, true, 'checksums are enforced');
    for (const [part, data] of parts.entries()) await value(a, 'upload_asset_part', { fileId: begun.file.id, part, dataBase64: data.toString('base64') });
    const finished = await value(a, 'finish_asset_upload', { fileId: begun.file.id }); assert.equal(finished.assetId, `user/team/${begun.file.id}`);
    await value(b, 'move_project_item', { kind: 'file', ref: begun.file.id, folderId: folder.folder.id });
    const asset = await value(readOnly, 'read_asset_part', { fileId: begun.file.id, part: 1 }); assert.deepEqual(Buffer.from(asset.dataBase64, 'base64'), parts[1]);
    assert.deepEqual(Buffer.from(await (await http(viewer, 'GET', `/api/v1/projects/one/files/${begun.file.id}`)).arrayBuffer()), bytes, 'people receive the same verified asset');
    const project = await value(readOnly, 'read_project'); assert.equal(project.sessions.length, 2); assert.equal(project.assets.length, 1); assert.equal(project.folders[0]!.items.length, 2);
    assert.equal((await call(a, 'read_project', { limit: 0 })).isError, true);
    assert.equal((await call(a, 'begin_asset_upload', { name: 'Huge', size: 999999999, checksum: '0'.repeat(64), contentType: 'image/png', parts: [] })).isError, true, 'workspace limits apply to agents');

    await store.updateProjectMemberRole('one', colleague.id, 'viewer');
    assert.equal((await call(b, 'create_session', { requestId: 'blocked', name: 'Blocked', toolId: 'design' })).isError, true);
    assert.equal((await value(b, 'read_project')).agent.role, 'viewer');
    await store.deleteProjectMember('one', colleague.id); assert.equal((await rpc(b, 'ping')).status, 401);
    assert.equal((await http(viewer, 'DELETE', `/api/v1/projects/one/agents/${a.agent.id}`)).status, 403);
    assert.equal(gateway.agents.connected(a.agent.id), true);
    assert.equal((await http(owner, 'DELETE', `/api/v1/projects/one/agents/${a.agent.id}`)).status, 204);
    assert.equal(gateway.agents.connected(a.agent.id), false, 'revocation closes every document connection'); assert.equal((await rpc(a, 'ping')).status, 401);
    const active = await invite(owner), original = (await store.getProject('one'))!;
    await store.putProject({ ...original, archivedAt: now });
    assert.equal((await call(active, 'create_session', { requestId: 'archived', name: 'Archived', toolId: 'design' })).isError, true);
    assert.equal((await value(active, 'read_project')).project.archived, true);
    await store.putProject(original);
    const expiredSecret = agentSecret();
    const expired: ProjectAgentRecord = { id: 'expired', projectId: 'one', userId: owner.id, createdBy: owner.id, label: 'Expired', role: 'viewer', tokenHash: expiredSecret.tokenHash, createdAt: now, expiresAt: '2000-01-01T00:00:00Z' };
    assert.equal(await store.createProjectAgent(expired), true);
    assert.equal((await rpc({ ...active, secret: expiredSecret.secret }, 'ping')).status, 401);
    const audit = await store.listAudit(); assert.ok(audit.some(event => event.action === 'agent.project-write' && event.actor === `agent:${a.agent.id}` && event.payload?.invitedBy === `user:${owner.id}`));
    assert.equal(JSON.stringify(audit).includes(active.secret), false);
    assert.ok(audit.some(event => event.action === 'agent.tool-call' && event.actor === `agent:${a.agent.id}` && event.payload?.tool === 'read_project' && event.payload?.outcome === 'succeeded'));
    assert.ok(audit.some(event => event.action === 'agent.tool-call' && event.actor === `agent:${readOnly.agent.id}` && event.payload?.tool === 'create_session' && event.payload?.outcome === 'rejected'));
    const humanFolder = await http(owner, 'POST', '/api/v1/projects/one/folders', { name: 'Human folder', agentId: a.agent.id, invitedBy: colleague.id });
    assert.equal(humanFolder.status, 201);
    const humanEvent = (await store.listAudit()).findLast(event => event.action === 'project.folder.create');
    assert.equal(humanEvent?.actor, `user:${owner.id}`);
    assert.equal(humanEvent?.payload?.agentId, undefined);
    for (const action of ['session.create', 'session.edit']) await store.putGrant({ principal: `user:${owner.id}`, action, resource: '*', effect: 'deny' });
    assert.equal((await rpc(active, 'tools/list')).body.result.tools!.some(tool => tool.name === 'create_session'), false, 'current action grants also narrow an owner’s agent');
    assert.equal((await http(owner, 'POST', '/api/v1/projects/one/agents', { label: 'No write rights', role: 'editor', hours: 1 })).status, 403);
    await store.setUserDisabled(owner.id, new Date().toISOString()); assert.equal((await rpc(active, 'ping')).status, 401);
  } finally {
    await gateway.drain(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true });
  }
  // Only the colleague's agent edited the first document, so the room's one
  // revision names it, and the version written when the room closed counts it.
  assert.equal((await store.listSessionRevisions(edited.sessionId))[0]?.actor, `agent:${edited.agentId}`);
  const [closed] = await store.listSessionVersions(edited.sessionId, { limit: 1 });
  assert.deepEqual(closed?.contributors.map(c => [c.kind, c.id]), [['agent', edited.agentId]]);
}

test('project agents create shared documents, folders and verified assets with current scoped access (memory)', () => exercise(Object.assign(createMemoryStore(), { storageKind: 'postgres' as const })));
test('project agents create shared documents, folders and verified assets with current scoped access (Postgres)', { skip: !process.env.LW_TEST_DATABASE_URL }, () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, exercise));
