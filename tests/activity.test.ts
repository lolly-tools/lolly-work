/**
 * Activity feed — the merged audit + attributed-telemetry timeline that backs
 * the Overview's activity section (plans/09/11). Pure fold; tested directly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { buildActivity, categoryOf, normalizeActivity } from '../server/src/activity/feed.ts';
import type { AuditEvent } from '../server/src/audit/chain.ts';
import type { StoredEvent } from '../server/src/telemetry/ingest.ts';

const names = new Map([['u1', 'Ada Byron'], ['u2', 'Grace Hopper']]);

const auditEvent = (seq: number, at: string, actor: string, action: string, subject: string, payload = {}): AuditEvent =>
  ({ seq, at, actor, action, subject, payload, prevHash: 'x', hash: 'y' });
const tele = (event: string, at: string, attrs: Record<string, string>, userId?: string): StoredEvent =>
  ({ event, at, attrs, ...(userId ? { userId } : {}) });

test('categoryOf folds render/tool and sessions heads', () => {
  assert.equal(categoryOf('render.export'), 'render');
  assert.equal(categoryOf('tool.open'), 'render');
  assert.equal(categoryOf('sessions.bulk'), 'session');
  assert.equal(categoryOf('link.create'), 'link');
});

test('normalize merges audit + attributed telemetry, drops unattributed usage', () => {
  const audit = [auditEvent(1, '2026-07-22T09:00:00Z', 'user:u1', 'link.create', 'link:abc', { kind: 'share', toolId: 'qr-code' })];
  const telemetry = [
    tele('render.export', '2026-07-22T10:00:00Z', { toolId: 'qr-code', format: 'png', destination: 'download' }, 'u1'),
    tele('render.export', '2026-07-22T10:05:00Z', { toolId: 'qr-code', format: 'svg' }), // no userId → dropped
    tele('app.boot', '2026-07-22T10:06:00Z', { shell: 'web' }, 'u1'),                    // not a feed action → dropped
    tele('catalog.asset-use', '2026-07-22T11:00:00Z', { assetId: 'logo/primary' }, 'u2'),
  ];
  const items = normalizeActivity(audit, telemetry, names);
  assert.equal(items.length, 3); // 1 audit + 2 attributed usage
  const exp = items.find((x) => x.action === 'render.export');
  assert.equal(exp?.actor.name, 'Ada Byron');
  assert.equal(exp?.subject, 'tool:qr-code');
  assert.equal(exp?.payload.format, 'png');
  const use = items.find((x) => x.action === 'catalog.asset-use');
  assert.equal(use?.subject, 'asset:logo/primary');
  assert.equal(use?.actor.name, 'Grace Hopper');
});

test('actor kinds: guest and system resolve without a users lookup', () => {
  const items = normalizeActivity([
    auditEvent(1, '2026-07-22T09:00:00Z', 'guest:lnk1', 'guest.admit', 'link:lnk1', { name: 'Sam' }),
    auditEvent(2, '2026-07-22T09:01:00Z', 'system', 'catalog.provider.sync', 'provider:p1'),
  ], [], names);
  assert.equal(items[0]!.actor.kind, 'guest');
  assert.equal(items[1]!.actor.kind, 'system');
  assert.equal(items[1]!.actor.id, null);
});

test('buildActivity filters, sorts newest-first, paginates with a cursor + facets', () => {
  const audit = [
    auditEvent(1, '2026-07-22T09:00:00Z', 'user:u1', 'link.create', 'link:a', { kind: 'share' }),
    auditEvent(2, '2026-07-22T09:30:00Z', 'user:u2', 'project.create', 'project:p', {}),
    auditEvent(3, '2026-07-22T10:00:00Z', 'user:u1', 'grant.create', 'grant:user:u2', { action: 'tool.use' }),
    auditEvent(4, '2026-07-22T10:30:00Z', 'user:u1', 'link.revoke', 'link:a', {}),
  ];
  const full = buildActivity(audit, [], names, { limit: 2 });
  assert.equal(full.total, 4);
  assert.equal(full.items.length, 2);
  assert.equal(full.items[0]!.id, 'a4');          // newest first
  assert.equal(full.items[1]!.id, 'a3');
  assert.equal(full.nextBefore, '2026-07-22T10:00:00Z'); // cursor = last item's at
  assert.deepEqual(full.categories.map((c) => c.key).sort(), ['grant', 'link', 'project']);

  // Filter by category, and by actor.
  const links = buildActivity(audit, [], names, { category: 'link' });
  assert.deepEqual(links.items.map((i) => i.id), ['a4', 'a1']);
  const byU2 = buildActivity(audit, [], names, { actor: 'u2' });
  assert.deepEqual(byU2.items.map((i) => i.id), ['a2']);
  // Full-text over action/subject/actor/payload.
  const q = buildActivity(audit, [], names, { q: 'tool.use' });
  assert.deepEqual(q.items.map((i) => i.id), ['a3']);
  // Cursor page: everything strictly before a3's timestamp.
  const next = buildActivity(audit, [], names, { before: '2026-07-22T10:00:00Z', limit: 2 });
  assert.deepEqual(next.items.map((i) => i.id), ['a2', 'a1']);
});

test('buildActivity filters by the actor’s group membership', () => {
  const audit = [
    auditEvent(1, '2026-07-22T09:00:00Z', 'user:u1', 'link.create', 'link:a', {}),
    auditEvent(2, '2026-07-22T09:30:00Z', 'user:u2', 'project.create', 'project:p', {}),
    auditEvent(3, '2026-07-22T10:00:00Z', 'system', 'catalog.provider.sync', 'provider:x', {}),
  ];
  const groupsByUser = new Map([['u1', ['marketing', 'brand']], ['u2', ['engineering']]]);
  const brand = buildActivity(audit, [], names, { group: 'brand' }, groupsByUser);
  assert.deepEqual(brand.items.map((i) => i.id), ['a1']); // only u1 is in brand; system excluded
  const eng = buildActivity(audit, [], names, { group: 'engineering' }, groupsByUser);
  assert.deepEqual(eng.items.map((i) => i.id), ['a2']);
});
