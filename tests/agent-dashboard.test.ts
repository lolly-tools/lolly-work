// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { agentDashboard } from '../server/src/agents/dashboard.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { auditWhere, matchesAudit } from '../server/src/audit/filter.ts';
import { consoleAccess } from '../server/src/setup/console-access.ts';
import type { AgentRoomBridge } from '../server/src/agents/types.ts';

const now = Date.parse('2026-10-06T12:00:00Z'), at = new Date(now - 3600000).toISOString();
async function fixture() {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'ada', email: 'ada@test', firstname: 'Ada', groups: ['owner'], role: 'owner' });
  await store.putProject({ id: 'p1', name: 'Keynote', ownerId: user.id, visibility: 'private', createdAt: at });
  await store.putSession({ id: 's1', projectId: 'p1', toolId: 'design', toolVersion: '1', inputs: { private: 'PRIVATE DOCUMENT' }, meta: { title: 'Deck' }, createdBy: user.id, updatedBy: user.id, updatedAt: at, rev: 1 });
  const record = { id: 'agt_1', label: 'Design helper', userId: user.id, createdBy: user.id, projectId: 'p1', sessionId: 's1', role: 'editor' as const, tokenHash: 'HASH NEVER DISCLOSE', createdAt: at, expiresAt: new Date(now + 3600000).toISOString() };
  await store.createDocumentAgent(record);
  const payload = { agentId: record.id, agentLabel: record.label, invitedBy: `user:${user.id}`, projectId: 'p1', sessionId: 's1' };
  await store.appendAudit({ at, actor: `user:${user.id}`, action: 'agent.invite', subject: 'session:s1', payload: { ...payload, role: 'editor' } });
  return { store, user, record, payload };
}
const rooms: AgentRoomBridge = { connected: id => id === 'agt_1', read: async () => ({}), apply: async () => ({}), disconnect: async () => {} };

test('dashboard distinguishes calls from writes, partial edits, legacy joins and human actions; excludes secrets and contents', async () => {
  const { store, user, payload } = await fixture();
  for (const [outcome, acceptedOps, rejectedOps] of [['succeeded', 2, 0], ['partial', 1, 3], ['rejected', 0, 2]] as const) {
    await store.appendAudit({ at, actor: 'agent:agt_1', action: 'agent.tool-call', subject: 'session:s1', payload: { ...payload, outcome, tool: 'apply_document_ops', acceptedOps, rejectedOps, secret: 'KEY NEVER DISCLOSE', arguments: 'PRIVATE ARGUMENTS' } });
  }
  await store.appendAudit({ at, actor: 'agent:agt_1', action: 'session.update', subject: 'session:s1', payload });
  await store.appendAudit({ at, actor: `user:${user.id}`, action: 'collab.join', subject: 'session:s1', payload });
  await store.appendAudit({ at, actor: `user:${user.id}`, action: 'session.update', subject: 'session:s1', payload: {} });
  const data = await agentDashboard(store, rooms, 30, now);
  assert.equal(data.summary.toolCalls, 3); assert.equal(data.summary.agentsUsed, 1);
  assert.equal(data.summary.succeeded, 1); assert.equal(data.summary.partial, 1); assert.equal(data.summary.rejected, 1);
  assert.equal(data.summary.acceptedOps, 3); assert.equal(data.summary.rejectedOps, 5); assert.equal(data.summary.connected, 1);
  assert.equal(data.timeline.length, 6); assert.equal(data.agents[0]!.label, 'Design helper');
  assert.deepEqual(data.agents[0]!.invitedBy, { id: user.id, name: 'Ada' });
  assert.deepEqual(data.agents[0]!.session, { id: 's1', name: 'Deck', toolId: 'design' });
  assert.equal(data.agents[0]!.status, 'active');
  for (const forbidden of ['HASH NEVER DISCLOSE', 'KEY NEVER DISCLOSE', 'PRIVATE DOCUMENT', 'PRIVATE ARGUMENTS', 'tokenHash']) assert.equal(JSON.stringify(data).includes(forbidden), false);
});

test('dashboard reports revoked/expired/disabled invitations and absence of a room host honestly', async () => {
  const { store, record, user } = await fixture();
  assert.equal((await agentDashboard(store, undefined, 30, now)).summary.connected, null);
  assert.equal((await agentDashboard(store, rooms, 30, now + 7200000)).agents[0]!.status, 'expired');
  await store.setUserDisabled(user.id, at);
  assert.equal((await agentDashboard(store, rooms, 30, now)).agents[0]!.status, 'unavailable');
  await store.revokeDocumentAgent(record.id, at);
  const data = await agentDashboard(store, rooms, 30, now);
  assert.equal(data.agents[0]!.status, 'revoked'); assert.equal(data.summary.connected, 0);
});

test('dashboard supports project-scoped hosts and does not invent a document scope from a project tool call', async () => {
  const { store, record, payload, user } = await fixture();
  const project = { ...record, id: 'pag_1', sessionId: undefined, tokenHash: 'PROJECT PRIVATE HASH' };
  const observable = Object.assign(store, { getProjectAgent: async (id: string) => id === project.id ? project : null });
  await store.appendAudit({ at, actor: `user:${user.id}`, action: 'agent.project-invite', subject: 'project:p1', payload: { ...payload, agentId: project.id } });
  await store.appendAudit({ at, actor: 'agent:pag_1', action: 'agent.tool-call', subject: 'project:p1', payload: { ...payload, agentId: project.id, tool: 'read_document', outcome: 'succeeded' } });
  const data = await agentDashboard(observable, rooms, 30, now);
  const row = data.agents.find(a => a.id === project.id)!;
  assert.equal(row.scope, 'project'); assert.equal(row.session, null); assert.equal(row.status, 'active');
  assert.equal(JSON.stringify(data).includes(project.tokenHash), false);
});

test('dashboard reads a bounded agent-only period and discloses event coverage limits', async () => {
  const { store } = await fixture();
  store.listAudit = async () => { throw new Error('unbounded audit scan forbidden'); };
  const original = store.listAuditBefore.bind(store);
  store.listAuditBefore = async (before, limit, filter) => {
    assert.equal(before, 0); assert.equal(limit, 10001); assert.equal(filter?.agents, true);
    assert.equal(filter?.since, new Date(now - 7 * 86400000).toISOString());
    const sample = (await original(before, limit, filter))[0]!;
    return Array.from({ length: limit }, (_, i) => ({ ...sample, seq: i + 1 }));
  };
  const data = await agentDashboard(store, rooms, 7, now);
  assert.equal(data.truncated, true); assert.equal(data.summary.invited, 10000); assert.equal(data.timeline.length, 100);
});

test('agent audit filter includes modern delegated actions and legacy joins but excludes ordinary human activity', () => {
  assert.equal(matchesAudit({ seq: 1, prevHash: '', hash: '', subject: '', actor: 'agent:1', action: 'session.update', at }, { agents: true }), true);
  assert.equal(matchesAudit({ seq: 1, prevHash: '', hash: '', subject: '', actor: 'user:1', action: 'collab.join', at, payload: { agentId: '1' } }, { agents: true }), true);
  assert.equal(matchesAudit({ seq: 1, prevHash: '', hash: '', subject: '', actor: 'user:1', action: 'session.update', at, payload: { agentId: '1' } }, { agents: true }), false);
  assert.equal(matchesAudit({ seq: 1, prevHash: '', hash: '', subject: '', actor: 'user:1', action: 'agent.invite', at }, { agents: true }), true);
  const where = auditWhere(12, { agents: true, since: at });
  assert.match(where.sql, /jsonb_typeof/); assert.deepEqual(where.values, [12, at]);
});

test('agent dashboard and navigation enforce audit disclosure and validate the time period', async () => {
  const { store, user } = await fixture();
  const pack = await mkdtemp(join(tmpdir(), 'lw-agent-dashboard-'));
  await mkdir(join(pack, 'catalog/tools'), { recursive: true });
  await writeFile(join(pack, 'catalog/tools/index.json'), '{"version":1,"tools":[]}');
  const config = parseConfig(JSON.stringify({ instance: { pack, baseUrl: 'http://localhost' }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] } }));
  const app = buildApp({ config, store, secrets: { session: 'test', link: 'test' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(r => server.listen(0, '127.0.0.1', r));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = mintSessionCookie({ sub: user.sub, email: user.email, name: 'Ada', groups: user.groups, role: user.role, epoch: user.sessionEpoch }, 'test', false).split(';')[0]!;
  try {
    assert.equal((await fetch(base + '/api/v1/agents/activity')).status, 401);
    const ok = await fetch(base + '/api/v1/agents/activity', { headers: { cookie } });
    assert.equal(ok.status, 200); assert.equal(ok.headers.get('cache-control'), 'private, no-store');
    for (const days of ['0', '91', 'NaN', '2.5']) assert.equal((await fetch(base + '/api/v1/agents/activity?days=' + days, { headers: { cookie } })).status, 400);
    await store.putGrant({ principal: '*', action: 'audit.export', resource: '*', effect: 'deny' });
    assert.equal((await fetch(base + '/api/v1/agents/activity', { headers: { cookie } })).status, 403);
    assert.equal(consoleAccess({ role: 'owner', groups: [] }, await store.listGrants()).views.agents, false);
    assert.equal(consoleAccess({ role: 'member', groups: [] }, []).views.agents, false);
    assert.equal(consoleAccess({ role: 'admin', groups: [] }, []).views.agents, true);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(pack, { recursive: true, force: true }); }
});
