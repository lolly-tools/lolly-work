/**
 * assembleOrgConfig with no readable manifest for a policied tool: the overlay's
 * own rule keys stand in for the declared list, so a lock or a hide the operator
 * wrote by id still reaches the shell instead of vanishing. This is the failure
 * the Lolly repo's 2026-09-11 fold exposed: a checkout stopped carrying tools/
 * at its root, every manifest read returned null, and the governed shell showed
 * every locked input as editable with nothing anywhere saying why.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleOrgConfig } from '../server/src/policy/org-config.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;

const OVERLAY: ToolOverlay = {
  toolId: 'qr-code',
  version: 1,
  name: 'Brand guardrails',
  inputAccess: {
    color: [{ groups: ['*'], level: 'locked', value: '#30ba78' }],
    background: [{ groups: ['marketing'], level: 'hidden' }],
    '*': [{ groups: ['contractors'], level: 'locked' }],
  },
};
const OVERLAYS = new Map<string, ToolOverlay>([['qr-code', OVERLAY]]);

function user(groups: string[]): UserRecord {
  const now = new Date().toISOString();
  return {
    id: 'u-1', sub: 'dev:one@x', email: 'one@x',
    idpGroups: groups, localGroups: [], groups, role: 'member',
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  };
}

type Inputs = Map<string, Array<{ id: string }> | null> | undefined;
const entryFor = (toolInputs: Inputs, groups: string[]) =>
  assembleOrgConfig({ config: CONFIG, user: user(groups), overlays: OVERLAYS, toolInputs, inboxUnread: 0 }).tools['qr-code']!;

test('a null manifest read still ships the lock and the hide the overlay names', () => {
  const entry = entryFor(new Map([['qr-code', null]]), ['marketing']);
  assert.deepEqual(entry.inputs?.map((i) => [i.id, i.access?.level, i.access?.by]), [['color', 'locked', 'Brand guardrails']]);
  assert.deepEqual(entry.hidden, ['background']);
});

test('no toolInputs map at all (a unit fixture) takes the same fallback', () => {
  const entry = entryFor(undefined, ['marketing']);
  assert.deepEqual(entry.hidden, ['background']);
});

test('the "*" rule cannot expand without a manifest: that is the documented loss', () => {
  // A contractor is locked on every input by the '*' rule; with no manifest only
  // the ids the overlay names by hand are known, so `url` is not annotated.
  const entry = entryFor(new Map([['qr-code', null]]), ['contractors']);
  assert.deepEqual(entry.inputs?.map((i) => i.id), ['color']);
  assert.equal(entry.hidden, undefined);
});

test('a readable manifest wins and the "*" rule expands over its declared inputs', () => {
  const declared = [{ id: 'url' }, { id: 'color' }, { id: 'background' }];
  const entry = entryFor(new Map([['qr-code', declared]]), ['contractors']);
  assert.deepEqual(entry.inputs?.map((i) => [i.id, i.access?.level]), [['url', 'locked'], ['color', 'locked']]);
});

test('an inputless manifest ([]) is not a miss: nothing is annotated', () => {
  const entry = entryFor(new Map([['qr-code', []]]), ['marketing']);
  assert.equal(entry.inputs, undefined);
  assert.equal(entry.hidden, undefined);
});
