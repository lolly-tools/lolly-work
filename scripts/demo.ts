/**
 * scripts/demo.ts - a one-command, richly-seeded local demo of the lolly-work
 * control plane.
 *
 *     npm run demo            # → open the printed URL
 *     PORT=8788 npm run demo  # a different port
 *
 * It builds an InstanceConfig in memory (nothing written to disk), seeds a
 * memory store across EVERY governance feature (overlays, grants, approval
 * chains, projects + sessions, catalog lifecycle, messages), boots the real
 * app handler on node:http, then fires a burst of HTTP self-calls (telemetry,
 * fleet, approvals) signed in as the right persona - so the console dashboards,
 * the governed catalog, the render plane, and the employee governance UX all
 * have something real to show.
 *
 * The one moving part is the WEB SHELL. The server serves it same-origin at
 * `/` when instance.shellDir points at a built shell. A shell built BEFORE the
 * org/ governance module lacks the session gate + locked-input UX; this script
 * DETECTS that (grepping the built bundle for an org-config marker) and, if the
 * dist is stale, boots in `open` access mode so the shipped shell still loads
 * the catalog + renders. A fresh dist boots `gated`, demoing the sign-in gate.
 * Rebuilding the shell (`npm run build:web` in the OSS repo) is the owner's to
 * run - this script never builds anything.
 */
import { createServer } from 'node:http';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { parseConfig, loadSecrets, type InstanceConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp, roleFromGroups } from '../server/src/api/app.ts';
import { randomId, hashPassword } from '../server/src/lib/crypto.ts';
import type { Store, UserRecord } from '../server/src/store/types.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';
import { createApproval, applyAction, type Approval, type Chain } from '../server/src/approvals/engine.ts';
import { parseClientHeader, type ClientInfo } from '../server/src/fleet/client-header.ts';
import type { StoredEvent } from '../server/src/telemetry/ingest.ts';
import type { LinkRecord } from '../server/src/links/sign.ts';
import type { RoomSnapshot, RoomMemberSnapshot, MemberRole } from '../server/src/collab/rooms.ts';
import type { LifecycleRow } from '../server/src/catalog/lifecycle.ts';
import type { Message } from '../server/src/inbox/target.ts';
import type { Grant } from '../server/src/rbac/evaluate.ts';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ── demo constants (real ids from the mounted pack) ──────────────────────────
// The demo mounts the sibling OSS repo as its pack + shell. Resolve its location
// portably so the demo runs on any machine (the easy-deploy goal), in
// priority order: LOLLY_OSS_DIR env → a sibling `lolly` checkout next to this
// repo → the original hard-coded dev path. First one that exists on disk wins.
function resolveOssDir(): string {
  const here = dirname(fileURLToPath(import.meta.url)); // .../lolly-work/scripts
  const candidates = [
    process.env.LOLLY_OSS_DIR,
    resolve(here, '..', '..', 'lolly'), // sibling checkout: ../../lolly
    '/Users/andy/Build/lolly',          // original dev default
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'shells', 'web'))) return resolve(c);
  }
  // Nothing found - return the first declared candidate so the boot error names
  // a concrete path the operator can fix (or set LOLLY_OSS_DIR).
  return resolve(candidates[0] ?? '/Users/andy/Build/lolly');
}

export const PACK = resolveOssDir();
export const SHELL_DIR = join(PACK, 'shells', 'web', 'dist');

/** Real logo asset id in the SUSE-profile catalog - the value a locked logo
 *  input bakes to. */
const BRAND_LOGO_ASSET = 'suse/logo/hor-pos-green';
/** SUSE green - the value the locked qr-code module colour bakes to. */
const BRAND_GREEN = '#30ba78';

/** Dev personas - the four sign-in identities the demo hands out. Groups drive
 *  role (roleFromGroups) and every policy/eligibility decision. */
export const PERSONAS: Array<{
  email: string;
  groups: string[];
  firstname: string;
  lastname: string;
  title: string;
}> = [
  { email: 'admin@suse.example', groups: ['admin'], firstname: 'Ada', lastname: 'Ops', title: 'Platform Admin' },
  { email: 'brand@suse.example', groups: ['brand-team', 'approver'], firstname: 'Bruno', lastname: 'Marques', title: 'Brand Lead' },
  { email: 'marketer@suse.example', groups: ['marketing'], firstname: 'Mia', lastname: 'Fields', title: 'Field Marketing Manager' },
  { email: 'contractor@suse.example', groups: ['contractors'], firstname: 'Cleo', lastname: 'Vidal', title: 'Contract Designer' },
];

// ── seed shapes ──────────────────────────────────────────────────────────────

/** RBAC grants - the deny rules that turn ordinary members into
 *  request-approval / no-delete members (plans/03). */
export function demoGrants(): Grant[] {
  return [
    // Marketing may create but not directly download exports → "Request approval".
    { principal: 'group:marketing', action: 'export.download', resource: '*', effect: 'deny' },
    // Contractors are the tightest tier: no direct download AND no deleting sessions.
    { principal: 'group:contractors', action: 'export.download', resource: '*', effect: 'deny' },
    { principal: 'group:contractors', action: 'session.delete', resource: '*', effect: 'deny' },
  ];
}

/** Tool policy overlays on REAL tools with REAL input ids. */
export function demoOverlays(): ToolOverlay[] {
  return [
    // qr-code: brand-team edits freely; everyone else gets the module colour
    // LOCKED (baked to SUSE green) and the background input HIDDEN entirely.
    {
      toolId: 'qr-code',
      version: 1,
      inputAccess: {
        color: [
          { groups: ['brand-team'], level: 'editable' },
          { groups: ['*'], level: 'locked', value: BRAND_GREEN },
        ],
        background: [
          { groups: ['brand-team'], level: 'editable' },
          { groups: ['*'], level: 'hidden' },
        ],
      },
    },
    // event-name-badge: the LOGO input is locked to the brand logo for everyone
    // but brand-team, AND the tool's outputs escalate through the brand-review
    // chain, with a preview watermark until an approval clears.
    {
      toolId: 'event-name-badge',
      version: 1,
      inputAccess: {
        eventLogo: [
          { groups: ['brand-team'], level: 'editable' },
          { groups: ['*'], level: 'locked', value: BRAND_LOGO_ASSET },
        ],
      },
      enforce: { escalation: 'brand-review', watermark: 'until-approved' },
    },
    // countdown-timer is hook-less, so the render plane can produce it in-process - 
    // watermark:'always' makes the preview watermark visible on its server render.
    {
      toolId: 'countdown-timer',
      version: 1,
      enforce: { watermark: 'always' },
    },
    // deck-builder is hidden from anyone outside brand/marketing/admin - demoing
    // per-caller catalog filtering (a contractor never learns it exists).
    {
      toolId: 'deck-builder',
      version: 1,
      visibility: { groups: ['brand-team', 'marketing', 'admin'] },
    },
  ];
}

/** The brand-review approval chain: brand sign-off, then legal sign-off. Two
 *  steps so an approval can be pending at step 0 (brand's inbox) OR step 1
 *  (admin/legal's inbox) - both inboxes populate. */
export function demoChains(): Chain[] {
  return [
    {
      id: 'brand-review',
      name: 'Brand review',
      version: 1,
      steps: [
        { name: 'Brand sign-off', approvers: { groups: ['brand-team', 'approver'] }, rule: 'any' },
        { name: 'Legal sign-off', approvers: { groups: ['admin'] }, rule: 'any' },
      ],
      onReject: 'return-to-submitter',
    },
  ];
}

/** Catalog lifecycle rows on REAL assets: an upcoming warn, an expired-but-warned
 *  (still served), an expired-hidden (410), and a scheduled one (410). */
export function demoLifecycle(now = Date.now()): LifecycleRow[] {
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const DAY = 86_400_000;
  return [
    // Upcoming expiry - still live, console shows the date + warn policy.
    { assetId: 'suse/logo/hor-pos-green', validUntil: iso(2 * DAY), onExpiry: 'warn' },
    // Expired but warned - kept in the feed (flagged expired) and blob still 200s.
    { assetId: 'suse/logo/hor-neg-green', validUntil: iso(-2 * DAY), onExpiry: 'warn' },
    // Expired + hide - dropped from the feed and the blob 410s.
    { assetId: 'suse/logo/vert-pos-black', validUntil: iso(-2 * DAY), onExpiry: 'hide' },
    // Scheduled (not yet valid) - dropped from the feed and the blob 410s.
    { assetId: 'suse/lottie/pulse-rings', validFrom: iso(7 * DAY), onExpiry: 'hide' },
  ];
}

/** Bridge messages: a broad announcement + an upgrade nudge scoped to old Tauri. */
export function demoMessages(): Message[] {
  return [
    {
      id: `msg_${randomId(6)}`,
      kind: 'announcement',
      severity: 'info',
      audience: {},
      title: 'Brand pack v2026.3 is live',
      body: 'Embeds refresh automatically — nothing to re-download.',
      dismissible: true,
    },
    {
      id: `msg_${randomId(6)}`,
      kind: 'upgrade',
      severity: 'action',
      audience: { shells: ['tauri'], maxEngine: '1.52.99' },
      title: 'Tauri desktop: please update',
      body: 'Engine 1.52 and older miss the new provenance signing. Update to 1.61+.',
      cta: { label: 'How to update', url: '/admin#/fleet' },
      dismissible: true,
    },
  ];
}

export interface SeedResult {
  users: Record<string, UserRecord>; // by email
  projectIds: { summit: string; drafts: string };
  sessionIds: string[];
  /** Seeded sessions keyed by their generated id - lets demoRooms() anchor a mock
   *  live room to a REAL session (so the console's Rooms panel resolves its label
   *  and tool) without depending on seed order. */
  sessions: Array<{ id: string; toolId: string; label: string; projectId: string }>;
}

/**
 * Seed everything that does NOT need a running server: users (so their ids
 * exist for projects/sessions/approvals), overlays, chains, projects +
 * sessions, catalog lifecycle, and messages. (Grants are seeded into the store
 * at construction - see bootStore - because the Store has no putGrant.)
 */
export async function seedStore(store: Store, now = Date.now()): Promise<SeedResult> {
  // 1. Users - pre-created so their ids anchor ownership. Dev sign-in later
  //    upserts the SAME sub (`dev:<email>`) and keeps the id.
  const users: Record<string, UserRecord> = {};
  for (const p of PERSONAS) {
    users[p.email] = await store.upsertUserBySub({
      sub: `dev:${p.email}`,
      email: p.email,
      firstname: p.firstname,
      lastname: p.lastname,
      title: p.title,
      groups: p.groups,
      role: roleFromGroups(p.groups),
    });
  }

  // 2. Overlays + chains.
  for (const o of demoOverlays()) await store.putOverlay(o);
  for (const c of demoChains()) await store.putChain(c);

  // 2b. Feature-flag governance (This Deploy → Feature flags). Two shapes to
  // demo: an opt-in flag forced on org-wide, and a hidden-but-on flag standing in
  // for a staged seasonal surprise (default still applies; the profile toggle is
  // suppressed, replaced by a padlock in the shell).
  const flagAt = new Date().toISOString();
  await store.putFlagGovernance({ id: 'strip-upload-metadata', default: 'on', updatedAt: flagAt });
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'on', visibility: 'hide', updatedAt: flagAt });

  // Injectables (plans/19) - the rail that pushes capability into the governed
  // shell. Seed one of each kind so the console panel demonstrates the taxonomy.
  const injAt = new Date().toISOString();
  const inj = (id: string, kind: string, title: string, groups: string[], payload: Record<string, unknown>) =>
    store.putInjectable({ id, kind: kind as 'flag' | 'resource' | 'tool' | 'chrome', title, groups, payload, state: 'live', version: 1, createdBy: 'system', createdAt: injAt, updatedAt: injAt });
  await inj('maintenance-note', 'chrome', 'Maintenance banner', ['*'], { slot: 'banner', tone: 'warn', text: 'Planned maintenance this Sunday 02:00–03:00 UTC.', link: { label: 'Status', href: '/status' } });
  await inj('brand-rates', 'resource', 'Printer rate card', ['design', 'marketing'], { resourceType: 'ratecard', assetId: 'acme/rates-2026' });
  await inj('qr-tool', 'tool', 'QR code tool', ['*'], { toolId: 'qr-code', source: 'catalog' });
  // A url-source tool: the same tool preconfigured via a Lolly tool URL - the shell
  // opens it with those inputs already applied (#/tool/<id>?<query>).
  await inj('welcome-qr', 'tool', 'SUSE welcome QR', ['*'], { toolId: 'org-welcome', source: 'url', ref: 'https://demo.lolly.example/#/tool/org-welcome?url=https%3A%2F%2Fsuse.com' });
  await inj('seasonal-jelly', 'flag', 'Seasonal jelly effects', ['*'], { flagId: 'jelly-effects', default: 'on', visibility: 'show' });

  // 3. Projects + sessions (real tool ids + plausible inputs + labels).
  const iso = (ms = 0) => new Date(now + ms).toISOString();
  const brand = users['brand@suse.example']!;
  const marketer = users['marketer@suse.example']!;

  const summit = `prj_${randomId(6)}`;
  await store.putProject({
    id: summit,
    name: 'Summit 2026',
    visibility: { groups: ['marketing', 'brand-team'] },
    ownerId: brand.id,
    createdAt: iso(-9 * 86_400_000),
  });
  const drafts = `prj_${randomId(6)}`;
  await store.putProject({
    id: drafts,
    name: 'Mia’s drafts',
    visibility: 'private',
    ownerId: marketer.id,
    createdAt: iso(-4 * 86_400_000),
  });

  const sessionSeeds: Array<{
    project: string; by: UserRecord; toolId: string; toolVersion: string;
    inputs: Record<string, unknown>; label: string; ageDays: number;
  }> = [
    { project: summit, by: brand, toolId: 'event-name-badge', toolVersion: '1.0.0',
      inputs: { eventName: 'SUSE Summit 2026', firstname: 'Ada', lastname: 'Lovelace', jobTitle: 'Keynote Speaker', status: 'speaker' },
      label: 'Keynote badge — Ada', ageDays: 3 },
    { project: summit, by: marketer, toolId: 'event-name-badge', toolVersion: '1.0.0',
      inputs: { eventName: 'SUSE Summit 2026', firstname: 'Grace', lastname: 'Hopper', jobTitle: 'Track Host', status: 'staff' },
      label: 'Badge — Grace', ageDays: 2 },
    { project: summit, by: marketer, toolId: 'qr-code', toolVersion: '2.0.0',
      inputs: { url: 'https://summit.suse.com/register', color: BRAND_GREEN },
      label: 'Registration QR', ageDays: 2 },
    { project: summit, by: brand, toolId: 'deck-builder', toolVersion: '1.0.0',
      inputs: { size: '16:9', theme: 'pine', pageNumbers: true },
      label: 'Opening keynote deck', ageDays: 1 },
    { project: drafts, by: marketer, toolId: 'countdown-timer', toolVersion: '1.0.0',
      inputs: {}, label: 'Booth countdown', ageDays: 1 },
  ];
  const sessionIds: string[] = [];
  const sessions: SeedResult['sessions'] = [];
  for (const s of sessionSeeds) {
    const id = `ses_${randomId(6)}`;
    sessionIds.push(id);
    sessions.push({ id, toolId: s.toolId, label: s.label, projectId: s.project });
    await store.putSession({
      id,
      projectId: s.project,
      toolId: s.toolId,
      toolVersion: s.toolVersion,
      inputs: s.inputs,
      meta: { label: s.label },
      createdBy: s.by.id,
      updatedBy: s.by.id,
      rev: 1,
      updatedAt: iso(-s.ageDays * 86_400_000),
    });
  }

  // 4. Catalog lifecycle.
  for (const row of demoLifecycle(now)) await store.putLifecycle(row);

  // 4b. A federated catalog provider (plans/17) - the mock driver stands in
  // for a live DAM, so the console's Providers view and the ext/* federation
  // path demo without network or credentials. Enabled at seed so its assets
  // appear in the feed immediately; the kill switch works from the console.
  const nowIso = new Date(now).toISOString();
  await store.putProvider({
    id: 'demo-dam', kind: 'mock', label: 'Demo Brand DAM', managedBy: 'db', enabled: true,
    options: {
      assets: [
        {
          remoteId: 'summit-keynote-bg', name: 'Summit Keynote Background', nativeType: 'file',
          sections: ['Backgrounds'], tags: ['summit'], approved: true, updatedAt: nowIso,
          formats: [{ format: 'png', remoteRef: 'bg1', size: 2048 }], hasThumbnail: true,
        },
        {
          remoteId: 'partner-badge', name: 'Partner Program Badge', nativeType: 'file',
          sections: ['Logos'], tags: ['partner'], approved: true, updatedAt: nowIso,
          formats: [{ format: 'svg', remoteRef: 'badge1', size: 512 }],
        },
      ],
    },
    mapping: { defaultType: 'image' },
    exposure: { requireApproved: true, tier: 'reference' },
    sync: { ttlSeconds: 300 },
    createdAt: nowIso, updatedAt: nowIso, state: { assetCount: 0 },
  });

  // 5. Messages.
  for (const m of demoMessages()) await store.putMessage(m);

  return { users, projectIds: { summit, drafts }, sessionIds, sessions };
}

// ── activity seeding (no server needed) ──────────────────────────────────────
// seedStore above lays down CONFIG-shaped state (overlays, chains, projects, …).
// But the dashboards a signed-in visitor first lands on - the usage charts, the
// attributed activity timeline, the fleet, the approvals inbox, shared links - 
// are fed by RUNTIME activity. The local `npm run demo` produces that by firing
// real HTTP self-calls once its server is up (seedViaHttp). Serverless (the
// Vercel function) has no server to call during a cold-start boot, so the SAME
// activity is written DIRECTLY to the store here by seedActivity(). Both paths
// range over the shared vocabulary below, so the two demos stay in step.

/** Tools/formats the seeded usage telemetry ranges over - shared with seedViaHttp
 *  so the leaderboards read the same names whichever path seeded them. */
const ACTIVITY_TOOLS = ['deck-builder', 'qr-code', 'event-name-badge', 'd3', 'chart-creator', 'street-map', 'countdown-timer', 'mesh-gradient'];
const ACTIVITY_FORMATS = ['png', 'pdf', 'svg', 'pptx', 'webm'];
/** Catalog assets the usage telemetry attributes to (the Top assets panel) - 
 *  real ids from the SUSE profile catalog + the demo DAM seeded above. */
const ACTIVITY_ASSETS = ['suse/logo/hor-pos-green', 'suse/logo/hor-neg-green', 'summit-keynote-bg', 'partner-badge', 'suse/tokens/brand'];
/** A believable mixed fleet: web/tauri/cli across a couple of engine versions
 *  and platforms (one lagging tauri on the old 1.52 engine - the upgrade nudge). */
const FLEET_CLIENT_HEADERS = [
  'web engine/1.61.0',
  'web/2.4.0 engine/1.61.0 platform/macos',
  'web engine/1.60.0',
  'tauri engine/1.61.0 platform/windows',
  'tauri engine/1.52.0 platform/linux',
  'cli engine/1.61.0',
];

/** A tiny deterministic PRNG (mulberry32). The seeded activity must be STABLE
 *  across cold starts - every serverless instance should show the same shaped
 *  dashboards - and reproducible in tests; Math.random would make both flaky. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 14 days of usage telemetry with a weekday rhythm: a `tool.open` each iteration
 * plus a fraction of `render.export` / `catalog.asset-use` / `session.tool`, and
 * one `session.shell` a day. ~60% attributes to a consented persona (marketer or
 * admin), so the active-users count, the attribution timeline and the
 * leaderboards populate; the rest stays aggregate (a stand-in for unconsented
 * seats). Deterministic given `now`.
 */
export function demoTelemetryEvents(seeded: SeedResult, now = Date.now()): StoredEvent[] {
  const rnd = mulberry32(0x5eed);
  const attributed = [seeded.users['marketer@suse.example']!.id, seeded.users['admin@suse.example']!.id];
  const pick = <T>(arr: T[], skew = 1): T => arr[Math.floor(rnd() ** skew * arr.length)]!;
  const attribution = (): { userId?: string } => (rnd() < 0.6 ? { userId: attributed[Math.floor(rnd() * attributed.length)]! } : {});
  const DAY = 86_400_000;
  const events: StoredEvent[] = [];
  for (let d = 13; d >= 0; d--) {
    const date = new Date(now - d * DAY);
    const weekday = ![0, 6].includes(date.getDay());
    const n = (weekday ? 14 : 4) + Math.floor(rnd() * (weekday ? 16 : 6));
    for (let i = 0; i < n; i++) {
      const toolId = pick(ACTIVITY_TOOLS, 1.6);
      const at = new Date(date.getTime() - i * 137_000).toISOString(); // minus: never future-dated
      const who = attribution(); // one actor per burst - a person's related actions share attribution
      events.push({ event: 'tool.open', at, attrs: { toolId }, ...who });
      if (rnd() < 0.55) {
        events.push({ event: 'render.export', at, attrs: { toolId, format: pick(ACTIVITY_FORMATS, 1.4), destination: rnd() < 0.72 ? 'download' : 'server-render' }, ...who });
      }
      if (rnd() < 0.4) {
        events.push({ event: 'catalog.asset-use', at, attrs: { assetId: pick(ACTIVITY_ASSETS, 1.3) }, ...who });
      }
      if (rnd() < 0.5) {
        events.push({ event: 'session.tool', at, attrs: { toolId, seconds: String(60 + Math.floor(rnd() * 1200)) }, ...who });
      }
    }
    events.push({ event: 'session.shell', at: new Date(date.getTime() - 1_800_000).toISOString(), attrs: { shell: 'web', seconds: String(600 + Math.floor(rnd() * 5400)) }, ...attribution() });
  }
  return events;
}

/**
 * Sixty days of back-dated audit history - what makes every console view's
 * activity header (plans/23 §3.D-adjacent, the per-view 30-day charts) tell a
 * story instead of flatlining: the charts fold audit actions by day, and until
 * this seed the demo's audit log began at first visit. Sixty days, not thirty,
 * so the "vs prior 30 days" delta tiles have a prior window to compare against;
 * a gentle growth ramp keeps those deltas pointing up. Weekday rhythm mirrors
 * demoTelemetryEvents. Counts and ids only - a seeded audit row never carries
 * input values, exactly like the real emitters.
 */
export function demoAuditHistory(seeded: SeedResult, now = Date.now()): Array<{
  at: string; actor: string; action: string; subject: string; payload?: Record<string, unknown>;
}> {
  const rnd = mulberry32(0xa0d17);
  const DAY = 86_400_000;
  const people = ['admin@suse.example', 'brand@suse.example', 'marketer@suse.example', 'contractor@suse.example']
    .map((e) => seeded.users[e]).filter((u): u is UserRecord => !!u);
  const actor = (skew = 1): string => `user:${people[Math.floor(rnd() ** skew * people.length)]!.id}`;
  const session = (): SeedResult['sessions'][number] => seeded.sessions[Math.floor(rnd() * seeded.sessions.length)]!;
  const events: Array<{ at: string; actor: string; action: string; subject: string; payload?: Record<string, unknown> }> = [];
  // Oldest first, business-hours-ish stamps, so the hash chain reads naturally.
  for (let d = 59; d >= 0; d--) {
    const date = new Date(now - d * DAY);
    const weekday = ![0, 6].includes(date.getDay());
    const growth = 1 + (59 - d) / 90;             // ~1.0 → ~1.65 across the window
    const level = (weekday ? 1 : 0.25) * growth;
    let tick = 0;
    const at = (): string => new Date(date.getTime() - DAY / 3 + tick++ * 411_000).toISOString();
    const n = (base: number): number => Math.round(base * level * (0.6 + rnd() * 0.8));
    for (let i = n(4); i > 0; i--) events.push({ at: at(), actor: actor(1.4), action: 'auth.login', subject: 'auth:dev' });
    for (let i = n(1.6); i > 0; i--) {
      const link = `link:${Math.floor(rnd() * 1e8).toString(36)}`;
      events.push({ at: at(), actor: actor(), action: 'link.create', subject: link, payload: { kind: rnd() < 0.25 ? 'guest-edit' : 'share' } });
      if (rnd() < 0.18) events.push({ at: at(), actor: actor(1.6), action: 'link.revoke', subject: link });
    }
    for (let i = n(0.9); i > 0; i--) {
      const s = session();
      events.push({ at: at(), actor: actor(), action: 'approval.submit', subject: `approval:${Math.floor(rnd() * 1e6)}`, payload: { toolId: s.toolId } });
      if (rnd() < 0.8) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: rnd() < 0.85 ? 'approval.approve' : 'approval.reject', subject: `approval:${Math.floor(rnd() * 1e6)}` });
      else if (rnd() < 0.3) events.push({ at: at(), actor: actor(), action: 'approval.withdraw', subject: `approval:${Math.floor(rnd() * 1e6)}` });
    }
    for (let i = n(5); i > 0; i--) {
      const s = session();
      events.push({ at: at(), actor: actor(), action: 'session.update', subject: `session:${s.id}`, payload: { rev: 2 + Math.floor(rnd() * 30), projectId: s.projectId, toolId: s.toolId } });
    }
    if (rnd() < 0.5) events.push({ at: at(), actor: actor(), action: 'session.create', subject: `session:${session().id}` });
    // Conflicts skew recent - the collab-gate instrument trending is the story.
    if (rnd() < (d < 14 ? 0.45 : 0.15)) {
      const s = session();
      events.push({ at: at(), actor: actor(), action: 'session.conflict', subject: `session:${s.id}`, payload: { rev: 3 + Math.floor(rnd() * 20), sentRev: 2, toolId: s.toolId } });
    }
    if (rnd() < 0.12) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: 'sessions.bulk', subject: 'sessions:all', payload: { matched: 3 + Math.floor(rnd() * 9), applied: 3 + Math.floor(rnd() * 9), keys: ['date'] } });
    for (let i = n(2.2); i > 0; i--) events.push({ at: at(), actor: actor(1.8), action: 'collab.join', subject: `session:${session().id}` });
    for (let i = n(1.4); i > 0; i--) events.push({ at: at(), actor: actor(1.8), action: 'collab.quiesce', subject: `session:${session().id}`, payload: { ops: 40 + Math.floor(rnd() * 400) } });
    if (rnd() < 0.4) events.push({ at: at(), actor: actor(), action: 'collab.invite', subject: `session:${session().id}` });
    for (let i = n(0.8); i > 0; i--) events.push({ at: at(), actor: `guest:${Math.floor(rnd() * 1e6).toString(36)}`, action: 'guest.admit', subject: `tool:${session().toolId}` });
    if (rnd() < 0.85) events.push({ at: at(), actor: 'system', action: 'catalog.provider.sync', subject: 'provider:brand-dam', payload: { assets: 120 + Math.floor(rnd() * 40) } });
    if (weekday && rnd() < 0.3) events.push({ at: at(), actor: 'user:' + people[1]!.id, action: 'policy.overlay.edit', subject: `tool:${session().toolId}` });
    if (weekday && rnd() < 0.15) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: 'policy.flag.edit', subject: 'flag:net-radio' });
    if (weekday && rnd() < 0.18) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: rnd() < 0.6 ? 'grant.create' : 'grant.delete', subject: 'grant:group:marketing' });
    if (weekday && rnd() < 0.12) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: 'config.apply', subject: 'config:governance', payload: { dryRun: false } });
    if (weekday && rnd() < 0.28) events.push({ at: at(), actor: 'user:' + people[0]!.id, action: 'message.send', subject: `message:${Math.floor(rnd() * 1e6)}` });
    if (weekday && rnd() < 0.1) events.push({ at: at(), actor: 'user:' + people[1]!.id, action: rnd() < 0.7 ? 'catalog.injectable.publish' : 'catalog.injectable.revoke', subject: 'injectable:campaign-banner' });
  }
  return events;
}

/** The fleet rows to record (each recorded `count` times so the summary bucket
 *  counts add up to something believable). Deterministic per-bucket counts. */
export function demoFleetClients(): Array<{ info: ClientInfo; count: number }> {
  const rnd = mulberry32(0xf1ee7);
  return FLEET_CLIENT_HEADERS.map((h) => ({ info: parseClientHeader(h)!, count: 6 + Math.floor(rnd() * 20) }));
}

/** Four shared links spanning every kind, one of them revoked (index 3). The
 *  guest-edit link carries a real scrypt password hash ('summit'), so it is
 *  genuinely gated - not merely flagged protected in the console. */
export function demoLinks(adminId: string, now = Date.now()): { records: LinkRecord[]; revokeIndex: number } {
  const expSec = (hours: number) => Math.floor(now / 1000) + hours * 3600;
  const createdAt = new Date(now).toISOString();
  const mk = (kind: LinkRecord['kind'], target: LinkRecord['target'], hours: number, extra: Partial<LinkRecord> = {}): LinkRecord => ({
    id: `lnk_${randomId(6)}`, kind, target, exp: expSec(hours), createdBy: adminId, createdAt, ...extra,
  });
  const records: LinkRecord[] = [
    mk('embed', { toolId: 'qr-code', params: { url: 'https://suse.com' } }, 2160),
    mk('guest-edit', { toolId: 'event-name-badge' }, 72, { pwHash: hashPassword('summit') }),
    mk('download', { toolId: 'countdown-timer' }, 24),
    mk('share', { toolId: 'street-map' }, 168),
  ];
  return { records, revokeIndex: 3 };
}

/**
 * Four approvals spanning every inbox state, built with the REAL approval engine
 * (createApproval/applyAction) so their stepIndex/state are exactly what the
 * routes would have produced. Marketer submits; brand/admin act - never the
 * submitter (separation of duties). Mirrors seedViaHttp's four.
 */
export function demoApprovals(seeded: SeedResult, now = Date.now()): Approval[] {
  const chain = demoChains()[0]!;
  const marketer = seeded.users['marketer@suse.example']!;
  const brand = seeded.users['brand@suse.example']!;
  const admin = seeded.users['admin@suse.example']!;
  const brandActor = { id: brand.id, groups: brand.groups };
  const adminActor = { id: admin.id, groups: admin.groups };
  const DAY = 86_400_000;
  const iso = (ms: number) => new Date(now + ms).toISOString();
  const raise = (title: string, subjectRef: string, ageDays: number): Approval =>
    createApproval({ id: `apr_${randomId(6)}`, subjectType: 'asset', subjectRef, title, chain, nominees: [], createdBy: marketer.id, now: iso(-ageDays * DAY) });

  // A: pending at Brand sign-off (brand's inbox).
  const a = raise('Summit keynote badge — brand check', 'event-name-badge/summit-keynote', 2);
  // B: fully approved (brand clears step 0, admin clears step 1).
  let b = raise('Booth QR — approved run', 'qr-code/booth', 3);
  b = applyAction(b, brandActor, 'approve', undefined, iso(-3 * DAY + 3_600_000));
  b = applyAction(b, adminActor, 'approve', 'Looks good, ship it.', iso(-2 * DAY));
  // C: rejected at Brand sign-off, with a comment.
  let c = raise('Sponsor logo lockup', 'event-name-badge/sponsor', 4);
  c = applyAction(c, brandActor, 'reject', 'Logo clear space is too tight — please redo.', iso(-4 * DAY + 7_200_000));
  // D: pending at Legal sign-off (admin's inbox) - brand cleared step 0.
  let d = raise('Registration deck — legal review', 'deck-builder/registration', 1);
  d = applyAction(d, brandActor, 'approve', undefined, iso(-1 * DAY + 3_600_000));
  return [a, b, c, d];
}

/**
 * Seed all RUNTIME activity directly into the store - the serverless equivalent
 * of seedViaHttp, minus the server. Marks the two attributed personas consented
 * (the instance runs opt-in attribution) so their usage attributes, writes the
 * usage telemetry, records the fleet, mints the shared links (revoking one), and
 * lands the four approvals. Idempotency is the caller's: a fresh store per boot.
 */
export async function seedActivity(
  store: Store,
  seeded: SeedResult,
  now = Date.now(),
): Promise<{ telemetryEvents: number; fleetClients: number; links: number; approvals: number; auditRows: number }> {
  const marketer = seeded.users['marketer@suse.example']!;
  const admin = seeded.users['admin@suse.example']!;
  await store.setTelemetryConsent(marketer.id, true);
  await store.setTelemetryConsent(admin.id, true);

  const events = demoTelemetryEvents(seeded, now);
  await store.putEvents(events);

  const clients = demoFleetClients();
  for (const { info, count } of clients) {
    for (let i = 0; i < count; i++) await store.recordClient(info);
  }

  const { records, revokeIndex } = demoLinks(admin.id, now);
  for (const link of records) await store.putLink(link);
  await store.revokeLink(records[revokeIndex]!.id, new Date(now).toISOString());

  const approvals = demoApprovals(seeded, now);
  for (const approval of approvals) await store.putApproval(approval);

  // Sixty days of audit history, appended oldest-first so the hash chain is
  // ordinary - this is what puts a curve on every console view's activity
  // header instead of a first-visit flatline.
  const auditRows = demoAuditHistory(seeded, now);
  for (const row of auditRows) await store.appendAudit(row);

  return { telemetryEvents: events.length, fleetClients: clients.length, links: records.length, approvals: approvals.length, auditRows: auditRows.length };
}

// ── mock live collaboration rooms ────────────────────────────────────────────
// The console's Rooms panel reads the collab gateway's OWN registry via the
// `listCollabRooms` callback injected into buildApp (server/src/api/app.ts). A
// live room is in-memory in the ws gateway process, and the serverless deploy
// never runs that gateway (plans/14 §6 "Vercel WS spike") - so the callback is
// absent and the panel is empty. demoRooms() fabricates a plausible registry so
// a signed-in visitor sees live collaboration too: bootstrap injects
// `listCollabRooms: () => demoRooms(seeded)`, computing timestamps fresh each
// call so the rooms always read as freshly-started and currently-live. Each room
// anchors to a REAL seeded session so the panel resolves its label + tool.

type RoomMemberSpec = { role: MemberRole; joinedMinAgo: number } & ({ email: string } | { guest: string });

/** Three rooms across three tools: a busy multi-writer deck, a quick QR with a
 *  guest observer, and a badge under a brand writer + a contractor watching. */
const ROOM_SPECS: Array<{ sessionLabel: string; startedMinAgo: number; opsApplied: number; members: RoomMemberSpec[] }> = [
  {
    sessionLabel: 'Opening keynote deck', startedMinAgo: 12, opsApplied: 428,
    members: [
      { email: 'brand@suse.example', role: 'writer', joinedMinAgo: 12 },
      { email: 'marketer@suse.example', role: 'writer', joinedMinAgo: 9 },
      { email: 'admin@suse.example', role: 'observer', joinedMinAgo: 4 },
    ],
  },
  {
    sessionLabel: 'Registration QR', startedMinAgo: 4, opsApplied: 73,
    members: [
      { email: 'marketer@suse.example', role: 'writer', joinedMinAgo: 4 },
      { guest: 'Guest · booth-ipad', role: 'observer', joinedMinAgo: 2 },
    ],
  },
  {
    sessionLabel: 'Keynote badge — Ada', startedMinAgo: 26, opsApplied: 216,
    members: [
      { email: 'brand@suse.example', role: 'writer', joinedMinAgo: 26 },
      { email: 'contractor@suse.example', role: 'observer', joinedMinAgo: 21 },
    ],
  },
];

/** A synthetic live-room registry for the console Rooms panel - the serverless
 *  stand-in for the ws gateway's `RoomRegistry.list()`. Timestamps are computed
 *  from `now` on every call, so the rooms never age out of "live". A spec whose
 *  session isn't in the seed is skipped (never a dangling room). */
export function demoRooms(seeded: SeedResult, now = Date.now()): RoomSnapshot[] {
  const MIN = 60_000;
  const sessionByLabel = new Map(seeded.sessions.map((s) => [s.label, s]));
  const nameOf = (email: string): string => {
    const u = seeded.users[email];
    const full = u ? `${u.firstname ?? ''} ${u.lastname ?? ''}`.trim() : '';
    return full || email;
  };
  const rooms: RoomSnapshot[] = [];
  for (const spec of ROOM_SPECS) {
    const session = sessionByLabel.get(spec.sessionLabel);
    if (!session) continue;
    const members: RoomMemberSnapshot[] = spec.members.map((m) => ({
      name: 'email' in m ? nameOf(m.email) : m.guest,
      role: m.role,
      joinedAt: now - m.joinedMinAgo * MIN,
    }));
    const writerCount = members.filter((m) => m.role === 'writer').length;
    rooms.push({
      sessionId: session.id,
      toolId: session.toolId,
      memberCount: members.length,
      writerCount,
      observerCount: members.length - writerCount,
      members,
      opsApplied: spec.opsApplied,
      startedAt: now - spec.startedMinAgo * MIN,
    });
  }
  return rooms;
}

// ── dist freshness detection ─────────────────────────────────────────────────
export interface DistVerdict {
  present: boolean;   // the shell dist directory + index.html exist
  fresh: boolean;     // the built bundle carries the org/ governance marker
  jsCount: number;    // how many assets/*.js were scanned
  reason: string;     // human-readable verdict
}

/**
 * A dist is "fresh" (carries the org/ governance module) when any built
 * assets/*.js references the org-config endpoint. A stale bundle predates the
 * governance UX; an absent one means the shell was never built.
 */
export function detectDist(distDir = SHELL_DIR): DistVerdict {
  const indexPresent = existsSync(join(distDir, 'index.html'));
  const assetsDir = join(distDir, 'assets');
  if (!indexPresent) {
    return { present: false, fresh: false, jsCount: 0, reason: 'no shell dist found (index.html missing)' };
  }
  let jsCount = 0;
  let fresh = false;
  try {
    for (const name of readdirSync(assetsDir)) {
      if (!name.endsWith('.js')) continue;
      jsCount++;
      if (fresh) continue;
      try {
        const src = readFileSync(join(assetsDir, name), 'utf8');
        if (src.includes('/api/v1/org-config') || src.includes('org-config')) fresh = true;
      } catch { /* unreadable chunk — skip */ }
    }
  } catch { /* no assets dir */ }
  return {
    present: true,
    fresh,
    jsCount,
    reason: fresh
      ? `shell dist carries the org governance module (scanned ${jsCount} JS chunks)`
      : `shell dist predates the org governance module (no org-config marker in ${jsCount} JS chunks)`,
  };
}

// ── config ───────────────────────────────────────────────────────────────────
export function buildDemoConfig(opts: { baseUrl: string; accessMode: 'open' | 'gated'; shellDir?: string }): InstanceConfig {
  return parseConfig(JSON.stringify({
    instance: {
      name: 'SUSE Content Automation',
      baseUrl: opts.baseUrl,
      pack: PACK,
      ...(opts.shellDir ? { shellDir: opts.shellDir } : {}),
    },
    policy: {
      defaultAccessMode: opts.accessMode,
      telemetry: 'standard',
      telemetryAttribution: 'opt-in',
      guestLinks: { enabled: true, maxTtlHours: 168, defaultTtlHours: 72 },
    },
    render: { allowHooksInFastPath: false },
    dev: {
      enabled: true,
      // No `name` here: the pre-seeded firstname/lastname/title survive dev
      // sign-in's upsert (which would otherwise overwrite firstname with `name`).
      users: PERSONAS.map((p) => ({ email: p.email, groups: p.groups })),
    },
  }));
}

// ── HTTP self-seeding (needs the server up) ──────────────────────────────────
type Cookie = string;

async function loginCookie(base: string, email: string): Promise<Cookie> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  if (!cookie) throw new Error(`dev sign-in for ${email} returned no session cookie (status ${res.status})`);
  return cookie.split(';')[0]!;
}

const jpost = (base: string, path: string, body: unknown, cookie: Cookie) =>
  fetch(`${base}${path}`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/**
 * The burst that needs a live server: telemetry (14 days, weekday rhythm, split
 * across consented + unconsented personas), fleet traffic, links, and four
 * approvals spanning every state. Mirrors scratch/seed-lolly-work.mjs.
 */
export async function seedViaHttp(base: string): Promise<{ telemetryEvents: number; approvals: number; links: number }> {
  const cookies: Record<string, Cookie> = {};
  for (const p of PERSONAS) cookies[p.email] = await loginCookie(base, p.email);
  const admin = cookies['admin@suse.example']!;
  const brand = cookies['brand@suse.example']!;
  const marketer = cookies['marketer@suse.example']!;
  const contractor = cookies['contractor@suse.example']!;

  // Consent for two people so leaderboards attribute (opt-in policy).
  await jpost(base, '/api/v1/telemetry/consent', { consent: true }, marketer);
  await jpost(base, '/api/v1/telemetry/consent', { consent: true }, admin);

  // 14 days of tool.open / render.export with a believable weekly rhythm.
  // Same vocabulary the serverless path (seedActivity) uses, so the two demos
  // surface the same tool/format names.
  const TOOLS = ACTIVITY_TOOLS;
  const FORMATS = ACTIVITY_FORMATS;
  type Ev = { event: string; at: string; attrs: Record<string, unknown> };
  const byPersona: Record<string, Ev[]> = { marketer: [], admin: [], contractor: [] };
  const pickPersona = (): keyof typeof byPersona => {
    const r = Math.random();
    return r < 0.55 ? 'marketer' : r < 0.8 ? 'admin' : 'contractor';
  };
  let total = 0;
  for (let d = 13; d >= 0; d--) {
    const date = new Date(Date.now() - d * 86_400_000);
    const weekday = ![0, 6].includes(date.getDay());
    const n = (weekday ? 14 : 4) + Math.floor(Math.random() * (weekday ? 18 : 6));
    for (let i = 0; i < n; i++) {
      const toolId = TOOLS[Math.floor(Math.random() ** 1.6 * TOOLS.length)]!;
      const at = new Date(date.getTime() + i * 60_000).toISOString();
      const who = pickPersona();
      byPersona[who]!.push({ event: 'tool.open', at, attrs: { toolId } });
      total++;
      if (Math.random() < 0.55) {
        byPersona[who]!.push({
          event: 'render.export', at,
          attrs: { toolId, format: FORMATS[Math.floor(Math.random() ** 1.4 * FORMATS.length)]!, destination: 'download' },
        });
        total++;
      }
    }
  }
  const cookieOf = { marketer, admin, contractor };
  for (const [who, evs] of Object.entries(byPersona)) {
    for (let i = 0; i < evs.length; i += 400) {
      await jpost(base, '/api/v1/telemetry', { events: evs.slice(i, i + 400) }, cookieOf[who as keyof typeof cookieOf]);
    }
  }

  // Fleet: a mixed fleet of shells + engine versions (healthz needs no auth).
  const CLIENTS = FLEET_CLIENT_HEADERS;
  for (const c of CLIENTS) {
    for (let i = 0; i < 4 + Math.floor(Math.random() * 18); i++) {
      await fetch(`${base}/healthz`, { headers: { 'x-lolly-client': c } });
    }
  }

  // Links of each kind (+ one revoked). download→countdown-timer is hook-less,
  // so it actually resolves to bytes (used by the verify step).
  const mint = (body: unknown) => jpost(base, '/api/v1/links', body, admin).then((r) => r.json() as Promise<{ id: string; url: string }>);
  await mint({ kind: 'embed', target: { toolId: 'qr-code', params: { url: 'https://suse.com' } }, ttlHours: 2160 });
  await mint({ kind: 'guest-edit', target: { toolId: 'event-name-badge' }, password: 'summit', ttlHours: 72 });
  await mint({ kind: 'download', target: { toolId: 'countdown-timer' }, ttlHours: 24 });
  const dead = await mint({ kind: 'share', target: { toolId: 'street-map' } });
  await jpost(base, `/api/v1/links/${dead.id}/revoke`, {}, admin);
  let links = 4;

  // Approvals spanning every state. Marketer raises; brand-team/admin act
  // (never the submitter - separation of duties).
  const submit = (title: string, subjectRef: string, nominees: string[] = []) =>
    jpost(base, '/api/v1/approvals', { subjectType: 'asset', subjectRef, title, chainId: 'brand-review', nominees }, marketer)
      .then((r) => r.json() as Promise<{ id: string }>);
  const act = (id: string, cookie: Cookie, action: 'approve' | 'reject', comment?: string) =>
    jpost(base, `/api/v1/approvals/${id}/act`, { action, ...(comment ? { comment } : {}) }, cookie);

  // A: pending at Brand sign-off (brand's inbox). Nominate brand for the ping.
  await submit('Summit keynote badge — brand check', 'event-name-badge/summit-keynote');
  // B: fully approved (brand clears step 0, admin clears step 1 → approved).
  const b = await submit('Booth QR — approved run', 'qr-code/booth');
  await act(b.id, brand, 'approve');
  await act(b.id, admin, 'approve', 'Looks good, ship it.');
  // C: rejected with a comment at Brand sign-off.
  const c = await submit('Sponsor logo lockup', 'event-name-badge/sponsor');
  await act(c.id, brand, 'reject', 'Logo clear space is too tight — please redo.');
  // D: pending at Legal sign-off (admin's inbox) - brand cleared step 0.
  const dApr = await submit('Registration deck — legal review', 'deck-builder/registration');
  await act(dApr.id, brand, 'approve');
  const approvals = 4;

  return { telemetryEvents: total, approvals, links };
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main(): Promise<void> {
  const port = Number(process.env.PORT ?? 8787);
  const host = process.env.HOST ?? 'localhost';
  const baseUrl = `http://${host}:${port}`;

  const dist = detectDist(SHELL_DIR);
  const accessMode: 'open' | 'gated' = dist.fresh ? 'gated' : 'open';
  const shellDir = dist.present ? SHELL_DIR : undefined;

  const config = buildDemoConfig({ baseUrl, accessMode, shellDir });
  const secrets = loadSecrets();
  const store = createMemoryStore({ grants: demoGrants() });
  const seeded = await seedStore(store);
  // Sixty days of audit history, direct to the store - the serverless path gets
  // this via seedActivity(); the local demo seeds runtime activity over HTTP
  // (seedViaHttp) which can only ever write "today", so the per-view activity
  // headers would flatline without it. Same generator, same curves, both demos.
  for (const row of demoAuditHistory(seeded)) await store.appendAudit(row);

  // Mock live collab rooms for the console's Rooms panel. The local demo boots
  // buildApp directly (no ws gateway, same as serverless), so without this the
  // panel is empty; demoRooms() stands in for the gateway's live-room registry.
  const app = buildApp({ config, store, secrets, listCollabRooms: () => demoRooms(seeded) });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(port, () => resolve()));

  const http = await seedViaHttp(baseUrl);

  const line = '─'.repeat(64);
  const devUrl = (email: string, to = '/') => `${baseUrl}/api/auth/dev?email=${email}&returnTo=${encodeURIComponent(to)}`;
  console.log(`
${line}
  SUSE Content Automation — lolly-work demo
${line}
  ▸ OPEN   ${baseUrl}
  ▸ Console  ${baseUrl}/admin      ▸ Health  ${baseUrl}/healthz

  Access mode: ${accessMode.toUpperCase()}
  Shell dist:  ${dist.present ? SHELL_DIR : '(none — console + API only)'}
    ${dist.reason}
    ${dist.fresh
      ? 'FRESH → gated: the shell shows the sign-in gate + governance UX.'
      : 'STALE → open: the shipped shell loads catalog + renders; rebuild the'}
    ${dist.fresh ? '' : 'shell (npm run build:web in ../lolly) to demo the employee governance UX.'}

  Sign in (dev provider — click a link, no password):
    admin       ${devUrl('admin@suse.example', '/admin')}
    brand       ${devUrl('brand@suse.example')}
    marketer    ${devUrl('marketer@suse.example')}
    contractor  ${devUrl('contractor@suse.example')}

  Seeded: ${Object.keys(seeded.users).length} people · 4 overlays · 1 chain ·
    2 projects / ${seeded.sessionIds.length} sessions · 4 lifecycle rows · 2 messages ·
    ${http.telemetryEvents} telemetry events · 6 fleet clients · ${http.links} links ·
    ${http.approvals} approvals · ${demoRooms(seeded).length} live collab rooms
${line}
  Ctrl-C to stop. In-memory only — nothing is written to disk.
${line}
`);
}

// Run only when invoked directly (not when imported by the seed test).
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((err) => {
    console.error('[demo] failed to boot:', err);
    process.exit(1);
  });
}
