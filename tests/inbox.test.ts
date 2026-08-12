import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceMatches, compareVersions, targetedMessages, type Message } from '../server/src/inbox/target.ts';

test('version compare handles unequal lengths and double digits', () => {
  assert.equal(compareVersions('1.61.0', '1.61.0'), 0);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.61', '1.61.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('audience matrix: groups × shells × version range', () => {
  const upgradeNudge = { groups: ['*'], shells: ['tauri'], maxEngine: '1.52.99' };
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.50.0' }), true);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.61.0' }), false);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'web', engineVersion: '1.50.0' }), false);
  // version-scoped messages don't reach clients whose version is unknown
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri' }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['marketing'] }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['brand-team', 'x'] }), true);
  assert.equal(audienceMatches({}, { groups: [] }), true); // default = everyone
});

test('per-user audience: only the named users match, and it ANDs with groups', () => {
  const aud = { users: ['u1', 'u2'] };
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u1' }), true);
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u3' }), false);
  assert.equal(audienceMatches(aud, { groups: [] }), false); // no userId → no match
  // combined with a group selector, BOTH must hold
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u1' }), true);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['legal'], userId: 'u1' }), false);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u2' }), false);
});

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, kind: 'announcement', severity: 'info', audience: {}, title: id, ...over };
}

test('targeting excludes acked and out-of-window messages', () => {
  const now = new Date('2026-07-21T12:00:00Z');
  const messages = [
    msg('live'),
    msg('acked'),
    msg('future', { startsAt: '2026-08-01T00:00:00Z' }),
    msg('ended', { endsAt: '2026-07-01T00:00:00Z' }),
  ];
  const out = targetedMessages(messages, { groups: [] }, new Set(['acked']), now);
  assert.deepEqual(out.map((m) => m.id), ['live']);
});
