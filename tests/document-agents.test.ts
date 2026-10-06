// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { WebSocket } from 'ws';
import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { Store } from '../server/src/store/types.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { createCollabGateway } from '../server/src/collab/gateway.ts';
import { buildApp } from '../server/src/api/app.ts';
interface Invitation { secret: string; agent: { id: string } }
interface RpcResult { result: { protocolVersion?: string; tools: unknown[]; isError?: boolean; content: { text: string }[]; structuredContent: { revision: number; rejectedIds: string[]; docState: { params: Record<string, unknown> } } } }
import { withFreshPostgres } from './pg-test-schema.ts';
import { agentDashboard } from '../server/src/agents/dashboard.ts';
import { agentSecret } from '../server/src/agents/access.ts';

async function exercise(store: Store) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-agents-'));
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await mkdir(join(pack, 'tools/design'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), JSON.stringify({ version: 1, tools: [] }));
  await writeFile(join(pack, 'tools/design/tool.json'), JSON.stringify({ id: 'design', inputs: [{ id: 'title', type: 'text' }, { id: 'locked', type: 'text' }, { id: 'boxes', type: 'blocks' }] }));
  let app: ReturnType<typeof buildApp>;
  const server = createServer((q, s) => void app(q, s));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const config = parseConfig(JSON.stringify({ instance: { name: 'Agent test', baseUrl: base, pack }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] } }));
  const gateway = createCollabGateway({ config, store, secrets: { session: 'session-test', link: 'link-test' } });
  app = buildApp({ config, store, secrets: { session: 'session-test', link: 'link-test' }, agentRooms: gateway.agents });
  server.on('upgrade', (q, socket, head) => { if (!gateway.handleUpgrade(q, socket, head)) socket.destroy(); });
  const owner = await store.upsertUserBySub({ sub: 'owner', email: 'owner@local.test', groups: ['team'], role: 'member' });
  const reader = await store.upsertUserBySub({ sub: 'reader', email: 'reader@local.test', groups: [], role: 'viewer' });
  const now = new Date().toISOString();
  await store.putProject({ id: 'project', name: 'Shared', ownerId: owner.id, visibility: 'private', createdAt: now });
  await store.putProjectMember({ projectId: 'project', userId: reader.id, role: 'viewer', addedBy: `user:${owner.id}`, addedAt: now });
  await store.putSession({ id: 'document', projectId: 'project', toolId: 'design', toolVersion: '1', inputs: { title: 'Before', locked: 'Approved', boxes: [{ id: 'title_box', x: 0, text: 'Title' }] }, meta: {}, createdBy: owner.id, updatedBy: owner.id, updatedAt: now, rev: 1 });
  const cookieOf = (u: typeof owner) => mintSessionCookie({ sub: u.sub, email: u.email, name: u.email, groups: u.groups, role: u.role, epoch: u.sessionEpoch }, 'session-test', false).split(';')[0]!;
  const http = (cookie: string, method: string, path: string, body?: unknown) => fetch(base + path, { method, headers: { cookie, 'content-type': 'application/json', origin: base }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const frames: Record<string, unknown>[] = [];
  const human = new WebSocket(base.replace('http:', 'ws:') + '/ws/collab/document', { headers: { cookie: cookieOf(owner), origin: base } });
  human.on('message', bytes => frames.push(JSON.parse(String(bytes))));
  const next = async (type: string) => {
    for (let n = 0; n < 100; n++) { const i = frames.findIndex(f => f.t === type); if (i >= 0) return frames.splice(i, 1)[0]!; await new Promise(r => setTimeout(r, 20)); }
    throw new Error(`No ${type} frame`);
  };
  try {
    await new Promise<void>((r, reject) => { human.once('open', r); human.once('error', reject); });
    human.send(JSON.stringify({ t: 'join', opVersion: CANVAS_OP_VERSION, presenceVersion: 1, interactionVersion: 1 }));
    const joined = await next('join-ack'); assert.ok(joined.you);
    const made = await http(cookieOf(owner), 'POST', '/api/v1/sessions/document/agents', { label: 'Design helper', role: 'editor', hours: 1 });
    assert.equal(made.status, 201); const invite = await made.json() as Invitation;
    assert.match(invite.secret, /^lwa_/); assert.equal((await store.getDocumentAgent(invite.agent.id))!.tokenHash.includes(invite.secret), false);
    const listed = await http(cookieOf(owner), 'GET', '/api/v1/sessions/document/agents'); const safe = await listed.text(); assert.equal(safe.includes(invite.secret), false); assert.equal(safe.includes('tokenHash'), false);
    const mcp = async (method: string, params?: unknown, secret = invite.secret, origin = base) => {
      const r = await fetch(base + '/api/workspace/mcp', { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'application/json', accept: 'application/json, text/event-stream', origin }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params ? { params } : {}) }) });
      return { status: r.status, body: await r.json() as RpcResult };
    };
    assert.equal((await mcp('initialize', { protocolVersion: '2025-11-25' })).body.result.protocolVersion, '2025-11-25');
    assert.equal((await mcp('ping', {}, invite.secret, 'https://evil.test')).status, 403);
    assert.equal((await mcp('ping', {}, 'lwa_invalid')).status, 401);
    const read = await mcp('tools/call', { name: 'read_document', arguments: {} });
    assert.equal(read.body.result.structuredContent.docState.params.title, 'Before');
    const agentJoin = await next('peer-join'); assert.match(String((agentJoin.member as { name: string }).name), /Design helper ·/);
    const revision = read.body.result.structuredContent.revision;
    const args = { batchId: 'change_title', expectedRevision: revision, ops: [{ k: 'param', key: 'title', value: 'Agent edit' }] };
    const changed = await mcp('tools/call', { name: 'apply_document_ops', arguments: args }); assert.equal(changed.body.result.isError, undefined);
    assert.equal(changed.body.result.structuredContent.docState.params.title, 'Agent edit');
    const live = await next('ops'); assert.equal((live.ops as { value: unknown }[])[0]!.value, 'Agent edit');
    const savedRev = (await store.getSession('document'))!.rev;
    assert.equal((await store.getSession('document'))!.updatedBy, owner.id, 'agent edits are attributed to the inviter');
    assert.equal((await store.listUsers()).length, 2, 'inviting an agent creates no independent account');
    assert.equal((await mcp('tools/call', { name: 'apply_document_ops', arguments: args })).body.result.isError, undefined);
    assert.equal((await store.getSession('document'))!.rev, savedRev, 'identical retry is not written twice');
    const conflict = await mcp('tools/call', { name: 'apply_document_ops', arguments: { ...args, batchId: 'stale_edit' } });
    assert.match(conflict.body.result.content[0]!.text, /collab-revision-changed/);
    human.send(JSON.stringify({ t: 'ops', batchId: 'human_change', ids: ['human_change'], ops: [{ k: 'param', key: 'title', value: 'Human edit', origin: { client: 'human', clock: 100 } }] }));
    await next('receipt');
    assert.equal((await mcp('tools/call', { name: 'read_document' })).body.result.structuredContent.docState.params.title, 'Human edit');
    human.send(JSON.stringify({ t: 'claim', requestId: 'claim_title', action: 'acquire', target: { kind: 'text', collection: 'boxes', ids: ['title_box'], param: 'title' } }));
    const claim = await next('claim-result'); assert.ok(claim.claim);
    const held = await mcp('tools/call', { name: 'apply_document_ops', arguments: { batchId: 'held_title', expectedRevision: (await store.getSession('document'))!.rev, ops: [{ k: 'param', key: 'title', value: 'Overwrite person' }] } });
    assert.deepEqual(held.body.result.structuredContent.rejectedIds, [`${invite.agent.id}_held_title_0`]);
    assert.equal((await store.getSession('document'))!.inputs.title, 'Human edit', 'an agent under the same identity still respects the human connection’s claim');
    human.send(JSON.stringify({ t: 'claim', requestId: 'release_title', action: 'release', claimId: (claim.claim as { id: string }).id }));
    await next('claim-result');
    await store.putOverlay({ toolId: 'design', version: 1, inputAccess: { locked: [{ groups: ['team'], level: 'locked', value: 'Approved' }] } });
    const locked = await mcp('tools/call', { name: 'apply_document_ops', arguments: { batchId: 'locked_edit', expectedRevision: (await store.getSession('document'))!.rev, ops: [{ k: 'param', key: 'locked', value: 'Bad' }] } });
    assert.deepEqual(locked.body.result.structuredContent.rejectedIds, [`${invite.agent.id}_locked_edit_0`]); assert.equal((await store.getSession('document'))!.inputs.locked, 'Approved');
    const viewerInvite = await http(cookieOf(reader), 'POST', '/api/v1/sessions/document/agents', { label: 'Reader helper', role: 'viewer' }); assert.equal(viewerInvite.status, 201);
    const viewer = await viewerInvite.json() as Invitation; assert.equal((await mcp('tools/list', {}, viewer.secret)).body.result.tools.length, 1);
    const refused = await mcp('tools/call', { name: 'apply_document_ops', arguments: { ...args, batchId: 'viewer_edit', expectedRevision: (await store.getSession('document'))!.rev } }, viewer.secret);
    assert.match(refused.body.result.content[0]!.text, /READ_ONLY/);
    assert.equal((await http(cookieOf(reader), 'POST', '/api/v1/sessions/document/agents', { label: 'Escalation', role: 'editor' })).status, 403);
    assert.equal((await http(cookieOf(reader), 'DELETE', `/api/v1/sessions/document/agents/${invite.agent.id}`)).status, 403);
    await store.putProject({ id: 'other_project', name: 'Private other', ownerId: reader.id, visibility: 'private', createdAt: now });
    await store.putSession({ id: 'other_document', projectId: 'other_project', toolId: 'design', toolVersion: '1', inputs: { title: 'Other private document' }, meta: {}, createdBy: reader.id, updatedBy: reader.id, updatedAt: now, rev: 1 });
    assert.equal((await http(cookieOf(owner), 'GET', '/api/v1/sessions/other_document/agents')).status, 404);
    assert.equal((await http(cookieOf(reader), 'DELETE', `/api/v1/sessions/other_document/agents/${invite.agent.id}`)).status, 404);
    const bounded = await mcp('tools/call', { name: 'read_document', arguments: { sessionId: 'other_document' } });
    assert.equal(bounded.body.result.structuredContent.docState.params.title, 'Human edit', 'a caller-supplied document cannot expand the credential scope');
    const observed = await agentDashboard(store, gateway.agents);
    assert.equal(observed.summary.agentsUsed, 2);
    assert.ok(observed.summary.succeeded > 0); assert.ok(observed.summary.rejected > 0);
    assert.equal(observed.summary.connected, 2);
    const viewerCall = observed.timeline.find(e => e.action === 'agent.tool-call' && e.actor.id === viewer.agent.id);
    assert.equal(viewerCall?.payload.outcome, 'rejected'); assert.equal(viewerCall?.payload.code, 'READ_ONLY');
    assert.equal(viewerCall?.actor.invitedBy?.id, reader.id);
    assert.equal(observed.timeline.some(e => e.action === 'agent.tool-call' && e.payload.arguments), false);
    const expiredKey = agentSecret();
    await store.createDocumentAgent({ ...(await store.getDocumentAgent(invite.agent.id))!, id: 'agt_expired', tokenHash: expiredKey.tokenHash, expiresAt: '2000-01-01T00:00:00Z' });
    assert.equal((await mcp('ping', {}, expiredKey.secret)).status, 401);
    assert.equal((await http(cookieOf(owner), 'DELETE', `/api/v1/sessions/document/agents/${invite.agent.id}`)).status, 204);
    assert.equal((await mcp('tools/call', { name: 'read_document' })).status, 401);
    const gone = await next('peer-leave'); assert.ok(gone.id);
    await store.setUserDisabled(reader.id, now);
    assert.equal((await mcp('tools/call', { name: 'read_document' }, viewer.secret)).status, 401, 'inviter offboarding removes agent access');
  } finally {
    human.close(); await gateway.drain(); server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(pack, { recursive: true, force: true });
  }
}
test('document agents share a live human room, durable retries, locks and revocation (memory)', () => exercise(createMemoryStore()));
test('document agents share a live human room, durable retries, locks and revocation (Postgres)', { skip: !process.env.LW_TEST_DATABASE_URL }, () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, exercise));
