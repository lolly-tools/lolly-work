/**
 * assembleOrgConfig must consult per-user/group tool.use grants when deciding
 * tool visibility (plans/03): an allow grant surfaces a tool the caller's
 * groups couldn't otherwise see; a deny grant hides one they could - while
 * genuinely-hidden tools (no grant) stay ABSENT (the caller never learns).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleOrgConfig } from '../server/src/policy/org-config.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';
import type { Grant } from '../server/src/rbac/evaluate.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;

// 'secret' is brand-only; 'open' is visible to everyone.
const OVERLAYS = new Map<string, ToolOverlay>([
  ['secret', { toolId: 'secret', version: 1, visibility: { groups: ['brand'] } }],
  ['open', { toolId: 'open', version: 1 }],
]);

function user(groups: string[]): UserRecord {
  const now = new Date().toISOString();
  return {
    id: 'u-sales', sub: 'dev:sales@x', email: 'sales@x',
    idpGroups: groups, localGroups: [], groups, role: 'member',
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  };
}

const toolIds = (grants: Grant[], groups = ['sales']): string[] =>
  Object.keys(assembleOrgConfig({ config: CONFIG, user: user(groups), overlays: OVERLAYS, grants, inboxUnread: 0 }).tools).sort();

test('no grants: a brand-only tool is absent for a non-brand caller', () => {
  assert.deepEqual(toolIds([]), ['open']); // 'secret' hidden, never learned
});

test('a per-user allow grant surfaces a tool outside the caller’s groups', () => {
  const allow: Grant = { principal: 'user:u-sales', action: 'tool.use', resource: 'tool:secret', effect: 'allow' };
  assert.deepEqual(toolIds([allow]), ['open', 'secret']);
});

test('a per-group allow grant works the same way', () => {
  const allow: Grant = { principal: 'group:sales', action: 'tool.use', resource: 'tool:secret', effect: 'allow' };
  assert.deepEqual(toolIds([allow]), ['open', 'secret']);
});

test('a deny grant hides an otherwise-visible tool, beating the role default', () => {
  const deny: Grant = { principal: 'user:u-sales', action: 'tool.use', resource: 'tool:open', effect: 'deny' };
  assert.deepEqual(toolIds([deny]), []); // 'open' denied, 'secret' still hidden
});

test('deny wins even when the caller IS in the tool’s visibility group', () => {
  const deny: Grant = { principal: 'user:u-sales', action: 'tool.use', resource: 'tool:secret', effect: 'deny' };
  assert.deepEqual(toolIds([deny], ['brand']), ['open']); // brand caller, but secret denied
});
