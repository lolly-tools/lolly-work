/**
 * The demo seed helper (scripts/demo.ts) must populate a store across EVERY
 * governance feature the console draws - this asserts the store-level shape the
 * HTTP burst then builds on. It never boots a server (the HTTP burst is covered
 * live in the demo's own verify step).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createMemoryStore } from '../server/src/store/memory.ts';
import { resolveInputAccess } from '../server/src/policy/overlay.ts';
import { summarize } from '../server/src/telemetry/ingest.ts';
import {
  seedStore, seedActivity, demoRooms, demoGrants, demoOverlays, demoChains, demoLifecycle, demoMessages,
  buildDemoConfig, detectDist, PERSONAS,
} from '../scripts/demo.ts';

test('seedStore populates the store across every governance feature', async () => {
  const store = createMemoryStore({ grants: demoGrants() });
  const seeded = await seedStore(store);

  // Users - one per persona, ids captured for ownership.
  const users = await store.listUsers();
  assert.equal(users.length, PERSONAS.length);
  assert.ok(Object.values(seeded.users).every((u) => u.id));

  // Overlays - all four real tools, with the qr-code lock actually enforcing.
  const overlays = await store.listOverlays();
  assert.equal(overlays.size, 4);
  for (const id of ['qr-code', 'event-name-badge', 'countdown-timer', 'deck-builder']) assert.ok(overlays.has(id));
  const qr = overlays.get('qr-code');
  assert.equal(resolveInputAccess(qr, 'color', ['marketing']).level, 'locked');
  assert.equal(resolveInputAccess(qr, 'color', ['brand-team']).level, 'editable');
  assert.equal(resolveInputAccess(qr, 'background', ['marketing']).level, 'hidden');
  assert.equal(overlays.get('event-name-badge')?.enforce?.escalation, 'brand-review');
  assert.equal(overlays.get('countdown-timer')?.enforce?.watermark, 'always');

  // Chain - brand-review, two steps.
  const chains = await store.listChains();
  assert.equal(chains.length, 1);
  assert.equal(chains[0]?.id, 'brand-review');
  assert.equal(chains[0]?.steps.length, 2);

  // Projects + sessions.
  const projects = await store.listProjects();
  assert.equal(projects.length, 2);
  assert.ok(projects.some((p) => p.name === 'Summit 2026' && p.visibility !== 'private'));
  assert.ok(projects.some((p) => p.visibility === 'private'));
  const sessions = await store.listSessionsFiltered({});
  assert.equal(sessions.length, seeded.sessionIds.length);
  assert.ok(sessions.length >= 4);
  // At least two event-name-badge sessions in one project → multi-edit is demoable.
  assert.ok(sessions.filter((s) => s.toolId === 'event-name-badge').length >= 2);

  // Catalog lifecycle - a hide, a warn, and a scheduled row all present.
  const lifecycle = await store.listLifecycle();
  assert.equal(lifecycle.length, 4);
  assert.ok(lifecycle.some((r) => r.onExpiry === 'hide' && r.validUntil));
  assert.ok(lifecycle.some((r) => r.onExpiry === 'warn'));
  assert.ok(lifecycle.some((r) => r.validFrom));

  // Messages + grants.
  assert.equal((await store.listMessages()).length, 2);
  assert.equal((await store.listGrants()).length, 3);
});

test('seedActivity populates the runtime dashboards a signed-in visitor lands on', async () => {
  const store = createMemoryStore({ grants: demoGrants() });
  const seeded = await seedStore(store);
  const now = Date.parse('2026-08-10T12:00:00Z');
  const res = await seedActivity(store, seeded, now);

  // Telemetry - events present, a mix of attributed + aggregate, and the
  // dashboard fold lights up every panel the console renders.
  const events = await store.listEvents();
  assert.equal(events.length, res.telemetryEvents);
  assert.ok(events.length > 100, 'a fortnight of usage, not a handful');
  assert.ok(events.some((e) => e.userId), 'some events attribute to a consented persona');
  assert.ok(events.some((e) => !e.userId), 'some events stay aggregate (unconsented seats)');
  assert.ok(events.every((e) => Date.parse(e.at) <= now), 'no event is future-dated');
  const summary = summarize(events, 14, new Date(now));
  assert.ok(summary.totals.events > 0);
  assert.ok(summary.totals.activeUsers >= 1, 'attributed events give an active-user count');
  assert.ok(summary.topTools.length > 0, 'tool leaderboard populated');
  assert.ok(summary.topAssets.length > 0, 'catalog.asset-use → top assets');
  assert.ok(summary.formats.length > 0 && summary.destinations.length > 0, 'export breakdowns populated');
  assert.ok(summary.sessions.tool.count > 0 && summary.sessions.shell.count > 0, 'seat-utility durations present');

  // Consent recorded for the two attributed personas (opt-in attribution).
  const marketer = await store.getUser(seeded.users['marketer@suse.example']!.id);
  assert.equal(marketer?.telemetryConsent, true);

  // Fleet - every client bucket recorded, with real counts, incl. a tauri shell.
  const fleet = await store.fleetSummary();
  assert.equal(fleet.length, res.fleetClients);
  assert.ok(fleet.every((r) => r.count >= 1));
  assert.ok(fleet.some((r) => r.info.shell === 'tauri'));

  // Links - four kinds, exactly one revoked, one genuinely password-gated.
  const links = await store.listAllLinks();
  assert.equal(links.length, res.links);
  assert.equal(links.filter((l) => l.revokedAt).length, 1);
  assert.ok(links.some((l) => l.kind === 'guest-edit' && l.pwHash));

  // Approvals - the real engine yields every inbox state the console filters by.
  const approvals = await store.listApprovals();
  assert.equal(approvals.length, res.approvals);
  assert.ok(approvals.some((a) => a.state === 'approved'), 'a fully-approved run');
  assert.ok(approvals.some((a) => a.state === 'rejected'), 'a rejected run with a comment');
  assert.ok(approvals.some((a) => a.state === 'in_review' && a.stepIndex === 0), 'one pending at brand sign-off');
  assert.ok(approvals.some((a) => a.state === 'in_review' && a.stepIndex === 1), 'one pending at legal sign-off');
  // Separation of duties held: the submitter never acted on their own request.
  const submitter = seeded.users['marketer@suse.example']!.id;
  assert.ok(approvals.every((a) => a.actions.every((act) => act.actor !== submitter)));
});

test('demoRooms fabricates live rooms anchored to real seeded sessions', async () => {
  const store = createMemoryStore({ grants: demoGrants() });
  const seeded = await seedStore(store);
  const now = Date.parse('2026-08-10T12:00:00Z');
  const rooms = demoRooms(seeded, now);

  assert.ok(rooms.length >= 2, 'a couple of rooms, so the panel has something to show');

  const seededIds = new Set(seeded.sessions.map((s) => s.id));
  for (const r of rooms) {
    // Every room anchors to a REAL seeded session (so the console resolves label + tool).
    assert.ok(seededIds.has(r.sessionId), `room points at a seeded session (${r.sessionId})`);
    assert.equal(r.toolId, seeded.sessions.find((s) => s.id === r.sessionId)!.toolId);
    // Counters are internally consistent with the roster.
    assert.equal(r.memberCount, r.members.length);
    assert.equal(r.writerCount + r.observerCount, r.memberCount);
    assert.equal(r.writerCount, r.members.filter((m) => m.role === 'writer').length);
    // Never future-dated, and each member joined at/after the room started.
    assert.ok(r.startedAt <= now, 'room started in the past');
    assert.ok(r.members.every((m) => m.joinedAt >= r.startedAt - 1 && m.joinedAt <= now));
    assert.ok(r.members.every((m) => m.name.length > 0));
  }

  // At least one multi-writer room, and at least one guest observer, so the panel
  // shows the full range of roles.
  assert.ok(rooms.some((r) => r.writerCount >= 2), 'a multi-writer room');
  assert.ok(rooms.some((r) => r.members.some((m) => m.role === 'observer' && m.name.startsWith('Guest'))), 'a guest observer');

  // now-relative: the same seed at a later clock reads as freshly live again
  // (rooms never age out) - startedAt tracks the clock, not a frozen boot time.
  const later = demoRooms(seeded, now + 3_600_000);
  assert.equal(later[0]!.startedAt - rooms[0]!.startedAt, 3_600_000);
});

test('demo helpers are internally consistent', () => {
  // Grants encode the exact denials the personas rely on.
  const grants = demoGrants();
  assert.ok(grants.some((g) => g.principal === 'group:marketing' && g.action === 'export.download' && g.effect === 'deny'));
  assert.ok(grants.some((g) => g.principal === 'group:contractors' && g.action === 'session.delete' && g.effect === 'deny'));

  // Lifecycle math: exactly one live-in-future (scheduled), rest date-bounded.
  const rows = demoLifecycle(Date.parse('2026-07-22T00:00:00Z'));
  assert.equal(rows.filter((r) => r.validFrom).length, 1);
  assert.equal(rows.filter((r) => r.validUntil).length, 3);

  // Config builds + validates for both access modes.
  assert.equal(buildDemoConfig({ baseUrl: 'http://localhost:9', accessMode: 'open' }).policy.defaultAccessMode, 'open');
  assert.equal(buildDemoConfig({ baseUrl: 'http://localhost:9', accessMode: 'gated', shellDir: '/x' }).instance.shellDir, '/x');

  // Static shapes.
  assert.equal(demoChains()[0]?.onReject, 'return-to-submitter');
  assert.equal(demoOverlays().length, 4);
  assert.equal(demoMessages().length, 2);

  // detectDist returns a well-formed verdict regardless of what's on disk.
  const v = detectDist('/nonexistent-dist-path');
  assert.equal(typeof v.present, 'boolean');
  assert.equal(typeof v.fresh, 'boolean');
  assert.equal(v.present, false);
});
