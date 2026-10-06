// SPDX-License-Identifier: MPL-2.0
import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { Room, RoomRegistry, type RoomMember } from '../server/src/collab/rooms.ts';
import { CANVAS_OP_VERSION } from '@lolly-tools/core/canvas-op-v1';

const at = new Date().toISOString();
const session = (id = 's1', projectId = 'p1') => ({ id, projectId, toolId: 'design', toolVersion: '1', inputs: { private: 'PRIVATE DOCUMENT' }, meta: {}, createdBy: 'u1', updatedBy: 'u1', rev: 1, updatedAt: at });
test('project presence uses current membership and per-session permissions, never another project or document contents', async () => {
  const store = createMemoryStore();
  const user = await store.upsertUserBySub({ sub: 'viewer', email: 'viewer@test', groups: [], role: 'member' });
  await store.putProject({ id: 'p1', name: 'Shared', ownerId: 'u1', visibility: 'private', createdAt: at });
  await store.putProjectMember({ projectId: 'p1', userId: user.id, role: 'viewer', addedAt: at, addedBy: 'u1' });
  await store.putSession(session()); await store.putSession(session('s2', 'other'));
  const pack = await mkdtemp(join(tmpdir(), 'lw-presence-')); await mkdir(join(pack, 'catalog/tools'), { recursive: true }); await writeFile(join(pack, 'catalog/tools/index.json'), '{"version":1,"tools":[]}');
  const config = parseConfig(JSON.stringify({ instance: { pack, baseUrl: 'http://localhost' }, rateLimit: { enabled: false }, idp: { additional: [{ id: "email", kind: "password" }] } }));
  const app = buildApp({ config, store, secrets: { session: 'test', link: 'test' }, projectPresence: id => {
    assert.equal(id, 'p1'); return ['s1', 's2'].map(sessionId => ({ sessionId, peers: [{ id: 'u2', name: 'Ravan', color: '#009966', role: 'observer' as const, away: false, kind: 'person' as const }] }));
  } });
  const server = createServer((req, res) => void app(req, res)); await new Promise<void>(r => server.listen(0, '127.0.0.1', r)); const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const cookie = mintSessionCookie({ sub: user.sub, email: user.email, name: 'Viewer', groups: [], role: 'member', epoch: user.sessionEpoch }, 'test', false).split(';')[0]!;
  const read = () => fetch(base + '/api/v1/projects/p1/presence', { headers: { cookie } });
  try {
    assert.equal((await fetch(base + '/api/v1/projects/p1/presence')).status, 401);
    const response = await read(); assert.equal(response.status, 200); assert.equal(response.headers.get('cache-control'), 'private, no-store'); const data = await response.json() as { sessions: Array<{ sessionId: string }> }; assert.deepEqual(data.sessions.map(r => r.sessionId), ['s1']); assert.equal(JSON.stringify(data).includes('PRIVATE DOCUMENT'), false);
    await store.putGrant({ principal: `user:${user.id}`, action: 'session.view', resource: 'session:s1', effect: 'deny' });
    assert.deepEqual(((await (await read()).json()) as typeof data).sessions, []);
    await store.deleteProjectMember('p1', user.id); assert.equal((await read()).status, 403);
  } finally { server.closeAllConnections(); await new Promise<void>(r => server.close(() => r())); await rm(pack, { recursive: true, force: true }); }
});

test('room presence deduplicates tabs, keeps participant colours and away state, excludes cursor/chat/document fields', async () => {
  const registry = new RoomRegistry(); const room = await registry.acquire(session());
  const seat = (id: string, role: RoomMember['role']): RoomMember => ({ id, userId: 'u2', name: 'Ravan', role, opVersion: CANVAS_OP_VERSION, send: () => {} });
  const one = seat('one', 'writer'), two = seat('two', 'observer');room.join(one);room.join(two);
  room.relayPresence(one, { userId: 'spoof', name: 'spoof', color: '#009966', chat: 'PRIVATE CHAT' });
  const rows = registry.projectPresence('p1'); assert.equal(rows.length, 1); assert.deepEqual(rows[0]!.peers, [{ id: 'u2', name: 'Ravan', color: '#009966', away: false, role: 'writer', kind: 'person' }]);
  assert.deepEqual(registry.projectPresence('other'), []); assert.equal(JSON.stringify(rows).includes('PRIVATE CHAT'), false);
  room.leave('one'); assert.equal(registry.projectPresence('p1')[0]!.peers[0]!.role, 'observer'); room.leave('two'); assert.deepEqual(registry.projectPresence('p1'), []); await registry.sweep(Date.now() + 120_000);
});
