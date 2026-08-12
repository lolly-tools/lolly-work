import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluate, roleAllows, type Grant, type PrincipalCtx } from '../server/src/rbac/evaluate.ts';

const member: PrincipalCtx = { userId: 'u1', groups: ['marketing'], role: 'member' };

test('role defaults: member exports, viewer does not, guest gets nothing', () => {
  assert.equal(roleAllows('member', 'export.download'), true);
  assert.equal(roleAllows('viewer', 'export.download'), false);
  assert.equal(roleAllows('viewer', 'catalog.read'), true);
  assert.equal(roleAllows('guest', 'catalog.read'), false);
  assert.equal(roleAllows('admin', 'link.create-guest'), true);
  assert.equal(roleAllows('member', 'link.create-guest'), false);
});

test('deny wins over role default and over allow', () => {
  const grants: Grant[] = [
    { principal: 'group:marketing', action: 'export.download', resource: '*', effect: 'allow' },
    { principal: 'group:marketing', action: 'export.download', resource: 'tool:secret', effect: 'deny' },
  ];
  assert.equal(evaluate(member, 'export.download', ['tool:other', '*'], grants), true);
  assert.equal(evaluate(member, 'export.download', ['tool:secret', '*'], grants), false);
});

test('the contractors example from plans/03 §2: edit yes, export/delete no', () => {
  const contractor: PrincipalCtx = { userId: 'c1', groups: ['contractors'], role: 'member' };
  const grants: Grant[] = [
    { principal: 'group:contractors', action: 'export.download', resource: '*', effect: 'deny' },
    { principal: 'group:contractors', action: 'session.delete', resource: '*', effect: 'deny' },
  ];
  assert.equal(evaluate(contractor, 'session.create', ['project:summit-2026', '*'], grants), true);
  assert.equal(evaluate(contractor, 'session.edit', ['project:summit-2026', '*'], grants), true);
  assert.equal(evaluate(contractor, 'export.download', ['tool:event-badge', '*'], grants), false);
  assert.equal(evaluate(contractor, 'session.delete', ['project:summit-2026', '*'], grants), false);
  assert.equal(evaluate(contractor, 'export.request', ['tool:event-badge', '*'], grants), true);
});

test('grants can lift a role: viewer granted tool.use by tag', () => {
  const viewer: PrincipalCtx = { userId: 'v1', groups: ['partners'], role: 'viewer' };
  const grants: Grant[] = [
    { principal: 'group:partners', action: 'tool.use', resource: 'tool:tag/partner-safe', effect: 'allow' },
  ];
  assert.equal(evaluate(viewer, 'tool.use', ['tool:x', 'tool:tag/partner-safe'], grants), true);
  assert.equal(evaluate(viewer, 'tool.use', ['tool:y', 'tool:tag/internal'], grants), false);
});

test('user-scoped grants and principal mismatch', () => {
  const grants: Grant[] = [{ principal: 'user:u1', action: 'fleet.view', resource: '*', effect: 'allow' }];
  assert.equal(evaluate(member, 'fleet.view', ['*'], grants), true);
  assert.equal(evaluate({ ...member, userId: 'u2' }, 'fleet.view', ['*'], grants), false);
});
