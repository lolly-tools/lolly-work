// SPDX-License-Identifier: MPL-2.0
import { afterEach, test } from 'node:test';
import assert from 'node:assert/strict';
import { effectiveAccessFor } from '../server/src/projects/effective-access.ts';
import { configureSharingLimits } from '../server/src/rbac/project-access.ts';
import type { ProjectRecord, ShareGroupRecord, UserRecord } from '../server/src/store/types.ts';

afterEach(() => configureSharingLimits(undefined));
const NOW = Date.parse('2026-10-13T12:00:00Z');
const user = (id: string, extra: Partial<UserRecord> = {}): UserRecord => ({
  id, sub: id, email: `${id}@example.test`, idpGroups: [], localGroups: [], groups: [], role: 'member',
  sessionEpoch: 0, createdAt: '2026-01-01', lastSeenAt: '2026-01-01', ...extra,
});
const project = (extra: Partial<ProjectRecord> = {}): ProjectRecord => ({
  id: 'p', name: 'Project', visibility: 'private', ownerId: 'owner', createdAt: '2026-01-01', ...extra,
});
const group = (id: string): ShareGroupRecord => ({ id, name: `${id} team`, ownerId: 'owner', managers: [], createdBy: 'owner', createdAt: '2026-01-01' });
function fixture(users: UserRecord[]) {
  const lookedUp: string[] = [];
  return { lookedUp, store: { listUsers: async () => users, getShareGroup: async (id: string) => { lookedUp.push(id); return group(id); } } };
}

test('custom group access lists only peers, without hidden group membership or stronger roles', async () => {
  const f = fixture([user('peer', { shareGroups: ['known', 'secret'], role: 'admin' }), user('outsider', { shareGroups: ['secret'] })]);
  const p = project({ sharing: { general: { audience: 'instance', role: 'editor' }, groups: [
    { kind: 'custom', id: 'known', role: 'viewer' }, { kind: 'custom', id: 'secret', role: 'manager' },
  ] } });
  const result = await effectiveAccessFor(f.store, user('caller', { shareGroups: ['known'] }), p, new Set(), [], NOW);
  assert.deepEqual(f.lookedUp, ['known']);
  assert.deepEqual(result.effective, [{ userId: 'peer', name: 'peer', role: 'viewer', via: 'custom-group', group: 'known team' }]);
  assert.deepEqual(result.instanceAudience, { role: 'commenter' });
  assert.equal(result.adminAccess, 'note');
});

test('a directory peer cannot infer a hidden custom grant or another directory grant', async () => {
  const f = fixture([user('peer', { groups: ['known', 'secret'], shareGroups: ['private'] })]);
  const p = project({ visibility: { groups: ['known', 'secret'] }, sharing: { groups: [
    { kind: 'directory', name: 'known', role: 'viewer' }, { kind: 'directory', name: 'secret', role: 'manager' },
    { kind: 'custom', id: 'private', role: 'manager' },
  ] } });
  const result = await effectiveAccessFor(f.store, user('caller', { groups: ['known'] }), p, new Set(), [], NOW);
  assert.equal(result.effective[0]?.role, 'viewer');
  assert.deepEqual(f.lookedUp, []);
});

test('administrators see custom group access, excluding expired grants, disabled and listed people', async () => {
  const f = fixture([user('peer', { shareGroups: ['known'] }), user('listed', { shareGroups: ['known'] }),
    user('disabled', { shareGroups: ['known'], disabledAt: '2026-01-01' }), user('expired', { shareGroups: ['expired'] })]);
  const p = project({ sharing: { groups: [{ kind: 'custom', id: 'known', role: 'editor' },
    { kind: 'custom', id: 'expired', role: 'editor', expiresAt: '2026-01-01' }] } });
  const result = await effectiveAccessFor(f.store, user('caller', { role: 'admin' }), p, new Set(['listed']), [], NOW);
  assert.deepEqual(result.effective.map((r) => [r.userId, r.role, r.via]), [['peer', 'editor', 'custom-group']]);
  assert.deepEqual(f.lookedUp, ['known']);
  configureSharingLimits({ customGroups: false });
  assert.deepEqual((await effectiveAccessFor(f.store, user('caller', { role: 'admin' }), p, new Set(), [], NOW)).effective, []);
});

test('instance audience is a capped summary, never a list of all accounts', async () => {
  const f = fixture([user('unrelated')]);
  const p = project({ sharing: { general: { audience: 'instance', role: 'manager' } } });
  configureSharingLimits({ instanceMaxRole: 'viewer' });
  const viewer = await effectiveAccessFor(f.store, user('caller'), p, new Set(), [], NOW);
  assert.deepEqual(viewer.instanceAudience, { role: 'viewer' });
  assert.deepEqual(viewer.effective, []);
  configureSharingLimits({ instanceMaxRole: 'manager' });
  assert.deepEqual((await effectiveAccessFor(f.store, user('caller'), p, new Set(), [], NOW)).instanceAudience, { role: 'editor' });
  configureSharingLimits({ instanceAudience: false });
  assert.equal((await effectiveAccessFor(f.store, user('caller'), p, new Set(), [], NOW)).instanceAudience, undefined);
});

test('custom group rows retain the 200-person cap and do not repeat a directory peer', async () => {
  const f = fixture(Array.from({ length: 205 }, (_, i) => user(`p${i}`, { shareGroups: ['known'], groups: ['directory'] })));
  const p = project({ visibility: { groups: ['directory'] }, sharing: { groups: [{ kind: 'custom', id: 'known', role: 'editor' }] } });
  const result = await effectiveAccessFor(f.store, user('caller', { role: 'admin' }), p, new Set(), [], NOW);
  assert.equal(result.effective.length, 200);
  assert.equal(result.effectiveTruncated, true);
  assert.equal(new Set(result.effective.map((r) => r.userId)).size, 200);
  assert.ok(result.effective.every((r) => r.via === 'group'));
});
