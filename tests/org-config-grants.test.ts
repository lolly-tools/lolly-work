/**
 * assembleOrgConfig must consult per-user/group tool.use grants when deciding
 * tool visibility (plans/03): an allow grant surfaces a tool the caller's
 * groups couldn't otherwise see; a deny grant hides one they could - while
 * genuinely-hidden tools (no grant) stay ABSENT (the caller never learns).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assembleOrgConfig, policyVersionOf, sharingGroupsOf } from '../server/src/policy/org-config.ts';
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

// ── sharing: the groups a member may offer as project visibility ───────────────

test('sharingGroupsOf drops only the groups that grant admin or owner, sorted and unique', () => {
  // Only admins and owners see every project, so only their groups add nobody
  // when a project is shared with them. An approver or author group is a real
  // audience: those roles see a team project only through its groups.
  const roleGroups = { owner: ['lolly-owners'], admin: ['lolly-admins'], approver: ['lolly-approvers'], author: ['lolly-authors'], viewer: ['readers'] };
  assert.deepEqual(
    sharingGroupsOf(['team-eng', 'lolly-owners', 'lolly-admins', 'lolly-authors', 'lolly-approvers', 'brand', 'readers', 'brand'], roleGroups),
    ['brand', 'lolly-approvers', 'lolly-authors', 'readers', 'team-eng'],
  );
  // Once owner and admin are mapped, the literal names grant nothing and are
  // ordinary groups (rbac/evaluate.ts roleFromGroups).
  assert.deepEqual(sharingGroupsOf(['admin', 'owner', 'design'], roleGroups), ['admin', 'design', 'owner']);
  // With no mapping, the literal admin and owner names grant those roles, so
  // they go; the literal approver and author names stay.
  assert.deepEqual(sharingGroupsOf(['admin', 'owner', 'approver', 'author', 'design'], undefined), ['approver', 'author', 'design']);
  // A role mapped to no groups at all is granted by no group.
  assert.deepEqual(sharingGroupsOf(['admin', 'owner'], { owner: [], admin: [] }), ['admin', 'owner']);
  // A name the projects route would trim could never match its own group.
  assert.deepEqual(sharingGroupsOf([' padded ', '', 'ok'], {}), ['ok']);
});

test('org-config carries sharing.groups and can[project.create] for the caller', () => {
  const config = { ...CONFIG, idp: { roleGroups: { admin: ['it-admins'] } } } as unknown as InstanceConfig;
  const payload = assembleOrgConfig({ config, user: user(['sales', 'it-admins', 'author', 'owner']), overlays: OVERLAYS, grants: [], inboxUnread: 0 });
  assert.deepEqual(payload.sharing, { groups: ['author', 'sales'], projectFiles: false, instance: { enabled: true, maxRole: 'commenter' }, customGroups: true, maxGrantDays: null }, 'the admin group and the unmapped owner literal go; author stays');
  // Shared files are on only when the app says so, and turning them on moves the version.
  const withFiles = assembleOrgConfig({ config, user: user(['sales']), overlays: OVERLAYS, grants: [], inboxUnread: 0, projectFiles: true });
  assert.equal(withFiles.sharing.projectFiles, true);
  assert.notEqual(withFiles.policyVersion, assembleOrgConfig({ config, user: user(['sales']), overlays: OVERLAYS, grants: [], inboxUnread: 0 }).policyVersion);
  assert.equal(payload.can['project.create'], true);
  const denied: Grant = { principal: 'user:u-sales', action: 'project.create', resource: '*', effect: 'deny' };
  assert.equal(assembleOrgConfig({ config, user: user(['sales']), overlays: OVERLAYS, grants: [denied], inboxUnread: 0 }).can['project.create'], false);
});

test('policyVersion moves when the caller\'s groups move; the member term is opt-in', () => {
  const v = (groups: string[]) => assembleOrgConfig({ config: CONFIG, user: user(groups), overlays: OVERLAYS, grants: [], inboxUnread: 0 }).policyVersion;
  assert.equal(v(['sales', 'brand']), v(['brand', 'sales']), 'order does not matter');
  assert.notEqual(v(['sales']), v(['sales', 'brand']), 'a new group busts the ETag');
  // The member term is opt-in: the render cache key hashes policy alone and
  // passes none, so its version is the same as before the term existed.
  const member = { groups: ['sales'], role: 'member', sharingGroups: ['sales'] };
  assert.notEqual(
    policyVersionOf(OVERLAYS, {}),
    policyVersionOf(OVERLAYS, {}, undefined, undefined, undefined, true, [], [], undefined, member),
  );
});


test('with no collab gateway in the process, every collab bit says no and the version moves', () => {
  const base = { config: CONFIG, user: user(['sales']), overlays: OVERLAYS, grants: [], inboxUnread: 0 };
  const withGateway = assembleOrgConfig(base);
  const without = assembleOrgConfig({ ...base, liveCollab: false });
  assert.equal(withGateway.can['collab.join'], true);
  assert.equal(without.can['collab.join'], false);
  assert.equal(without.can['collab.edit'], false);
  assert.equal(without.can['collab.nearby'], false);
  assert.notEqual(without.policyVersion, withGateway.policyVersion);
  // Unset keeps the version a gateway deployment already had.
  assert.equal(assembleOrgConfig({ ...base, liveCollab: true }).policyVersion, withGateway.policyVersion);
});

test('instance.homeView reaches the shell as home, only when set, and moves the version', () => {
  const base = { config: CONFIG, user: user(['sales']), overlays: OVERLAYS, grants: [], inboxUnread: 0 };
  const unset = assembleOrgConfig(base);
  assert.ok(!('home' in unset), 'no home view set: the field is absent and the shell keeps its own default');
  const withHome = (homeView: 'tools' | 'projects') => assembleOrgConfig({
    ...base, config: { ...CONFIG, instance: { ...CONFIG.instance, homeView } } as InstanceConfig,
  });
  const projects = withHome('projects');
  assert.equal(projects.home, 'projects');
  assert.equal(withHome('tools').home, 'tools');
  // The payload differs, so the version (and the ETag built from it) differs too.
  assert.notEqual(projects.policyVersion, unset.policyVersion);
  assert.notEqual(projects.policyVersion, withHome('tools').policyVersion);
});

test('an instance home URL reaches members and moves the cached policy version', () => {
  const base = { config: CONFIG, user: user(['sales']), overlays: OVERLAYS, grants: [], inboxUnread: 0 };
  const unset = assembleOrgConfig(base);
  const destination = assembleOrgConfig({ ...base, config: { ...CONFIG, instance: { ...CONFIG.instance, homeUrl: '/#/p?team=prj_123' } } });
  assert.equal(destination.homeUrl, '/#/p?team=prj_123');
  assert.notEqual(destination.policyVersion, unset.policyVersion);
  assert.equal('homeUrl' in unset, false);
});
