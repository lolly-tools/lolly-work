import { test } from 'node:test';
import assert from 'node:assert/strict';
import { foldRollups, sanitizeEvent, summarize, type IngestPolicy, type StoredEvent } from '../server/src/telemetry/ingest.ts';

const STANDARD_OPTIN: IngestPolicy = { level: 'standard', attribution: 'opt-in' };

test('unknown events and off-policy are dropped', () => {
  assert.equal(sanitizeEvent({ event: 'keylogger.dump' }, STANDARD_OPTIN, { id: 'u1' }), null);
  assert.equal(sanitizeEvent({ event: 'tool.open' }, { level: 'off', attribution: 'default' }, { id: 'u1' }), null);
});

test('attrs are a closed allowlist — nothing that could carry input values survives', () => {
  const e = sanitizeEvent(
    {
      event: 'render.export',
      attrs: { toolId: 'qr-code', format: 'png', headline: 'SECRET LAUNCH NAME', inputs: '{...}' },
    },
    STANDARD_OPTIN,
    { id: 'u1', telemetryConsent: true },
  );
  assert.deepEqual(Object.keys(e!.attrs).sort(), ['format', 'toolId']);
});

test('identity floor: profile.update field names pass the reportable allowlist, fail-closed', () => {
  // "A person's disability or language is never telemetry" - even as a field
  // NAME (plans/09 §2a). Contact-card fields survive; preference/identity
  // fields (and anything unknown - fail-closed) are stripped at the door.
  const ev = (fields: string) =>
    sanitizeEvent({ event: 'profile.update', attrs: { fields } }, STANDARD_OPTIN, { id: 'u1', telemetryConsent: true });
  assert.equal(ev('firstname, title')!.attrs.fields, 'firstname,title');
  assert.equal(ev('a11y, lang, firstname')!.attrs.fields, 'firstname');
  // An update touching ONLY sensitive fields still counts as an event, but
  // carries no fields attr at all - "a profile was maintained", nothing more.
  const sensitiveOnly = ev('a11y,lang,favourites,featureFlags,useDetails');
  assert.ok(sensitiveOnly);
  assert.equal(sensitiveOnly!.attrs.fields, undefined);
  // Fail-closed on unknown and prototype-shaped names alike.
  assert.equal(ev('somethingNew,constructor,__proto__')!.attrs.fields, undefined);
});

test('opt-in attribution: userId only with consent (the SUSE works-council posture)', () => {
  const raw = { event: 'tool.open', attrs: { toolId: 'qr-code' } };
  assert.equal(sanitizeEvent(raw, STANDARD_OPTIN, { id: 'u1' })!.userId, undefined);
  assert.equal(sanitizeEvent(raw, STANDARD_OPTIN, { id: 'u1', telemetryConsent: false })!.userId, undefined);
  assert.equal(sanitizeEvent(raw, STANDARD_OPTIN, { id: 'u1', telemetryConsent: true })!.userId, 'u1');
  // default attribution (post-works-council flip): consent flag not required
  assert.equal(sanitizeEvent(raw, { level: 'standard', attribution: 'default' }, { id: 'u1' })!.userId, 'u1');
  // aggregate level NEVER attributes, consent or not
  assert.equal(sanitizeEvent(raw, { level: 'aggregate', attribution: 'default' }, { id: 'u1', telemetryConsent: true })!.userId, undefined);
});

test('guests / no user context never attribute', () => {
  const e = sanitizeEvent({ event: 'tool.open', attrs: { toolId: 'x' } }, { level: 'standard', attribution: 'default' }, null);
  assert.equal(e!.userId, undefined);
});

test('seconds is a numeric label, not content — the no-values invariant holds', () => {
  // Only toolId/shell + seconds survive; a smuggled free-text attr is dropped.
  const e = sanitizeEvent(
    { event: 'session.tool', attrs: { toolId: 'qr-code', seconds: 42, notes: 'the secret headline' } },
    { level: 'standard', attribution: 'default' }, { id: 'u1' },
  );
  assert.deepEqual(Object.keys(e!.attrs).sort(), ['seconds', 'toolId']);
  assert.equal(e!.attrs.seconds, '42');
});

test('session summary: seat-utility aggregates per kind, junk seconds ignored', () => {
  const today = new Date('2026-07-22T12:00:00Z');
  const mk = (event: string, at: string, attrs: Record<string, string>): StoredEvent => ({ event, at, attrs });
  const events: StoredEvent[] = [
    mk('session.tool', '2026-07-22T09:00:00Z', { toolId: 'qr-code', seconds: '30' }),
    mk('session.tool', '2026-07-22T10:00:00Z', { toolId: 'qr-code', seconds: '90' }),
    mk('session.tool', '2026-07-21T10:00:00Z', { toolId: 'deck', seconds: '60' }),
    mk('session.tool', '2026-07-22T11:00:00Z', { toolId: 'deck', seconds: '-5' }),  // negative → ignored
    mk('session.tool', '2026-07-22T11:30:00Z', { toolId: 'deck', seconds: 'NaN' }), // non-numeric → ignored
    mk('session.shell', '2026-07-22T09:30:00Z', { shell: 'web', seconds: '120' }),
  ];
  const s = summarize(events, 14, today);
  assert.equal(s.sessions.tool.count, 3);           // two Jul-22 + one Jul-21; junk dropped
  assert.equal(s.sessions.tool.totalSeconds, 180);  // 30 + 90 + 60
  assert.equal(s.sessions.tool.avgSeconds, 60);     // 180 / 3
  const jul22 = s.sessions.tool.perDay.find((d) => d.date === '2026-07-22');
  assert.equal(jul22?.seconds, 120);                // 30 + 90 only
  assert.equal(jul22?.count, 2);
  assert.equal(s.sessions.shell.count, 1);
  assert.equal(s.sessions.shell.totalSeconds, 120);
  assert.equal(s.sessions.shell.avgSeconds, 120);
  // existing fields untouched
  assert.equal(s.totals.events, 6);
});

test('popularity: top catalog assets + export destinations, descending', () => {
  const mk = (event: string, attrs: Record<string, string>): StoredEvent =>
    ({ event, at: '2026-07-22T09:00:00Z', attrs });
  const s = summarize([
    mk('catalog.asset-use', { assetId: 'logo/primary' }),
    mk('catalog.asset-use', { assetId: 'logo/primary' }),
    mk('catalog.asset-use', { assetId: 'poster/summit' }),
    mk('catalog.asset-use', {}),                                   // no assetId → ignored
    mk('render.export', { toolId: 'qr', format: 'png', destination: 'download' }),
    mk('render.export', { toolId: 'qr', format: 'svg', destination: 'download' }),
    mk('render.export', { toolId: 'deck', format: 'pdf', destination: 'server' }),
  ], 14, new Date('2026-07-22T12:00:00Z'));
  assert.deepEqual(s.topAssets, [
    { assetId: 'logo/primary', count: 2 },
    { assetId: 'poster/summit', count: 1 },
  ]);
  assert.deepEqual(s.destinations, [
    { destination: 'download', count: 2 },
    { destination: 'server', count: 1 },
  ]);
  assert.equal(s.totals.exports, 3); // existing export tally unchanged
});

test('downloads: catalog.asset-download is a closed-vocab event, and topDownloads folds it (plans/31 §7)', () => {
  // It survives ingest with only its two labels; `via` is a coarse label, and
  // any free-text a client tried to attach is dropped like every other event's.
  const clean = sanitizeEvent(
    { event: 'catalog.asset-download', attrs: { assetId: 'inst/hero', via: 'zip', filename: '/etc/passwd' } },
    { level: 'standard', attribution: 'default' }, { id: 'u1' },
  );
  assert.deepEqual(clean!.attrs, { assetId: 'inst/hero', via: 'zip' });

  const mk = (attrs: Record<string, string>): StoredEvent =>
    ({ event: 'catalog.asset-download', at: '2026-07-22T09:00:00Z', attrs });
  const s = summarize([
    mk({ assetId: 'inst/hero', via: 'direct' }),
    mk({ assetId: 'inst/hero', via: 'link' }),
    mk({ assetId: 'ext/dam/a1', via: 'zip' }),
    mk({ via: 'direct' }),                                          // no assetId → ignored
    { event: 'catalog.asset-use', at: '2026-07-22T09:00:00Z', attrs: { assetId: 'inst/hero' } },
  ], 14, new Date('2026-07-22T12:00:00Z'));
  assert.deepEqual(s.topDownloads, [
    { assetId: 'inst/hero', count: 2 },
    { assetId: 'ext/dam/a1', count: 1 },
  ]);
  // Download is its own axis: opened-or-placed use does not leak into it, nor
  // the reverse.
  assert.deepEqual(s.topAssets, [{ assetId: 'inst/hero', count: 1 }]);
});

test('rollups fold by day × dimension', () => {
  const mk = (at: string, toolId: string) =>
    sanitizeEvent({ event: 'tool.open', at, attrs: { toolId } }, { level: 'aggregate', attribution: 'default' }, null)!;
  const rollups = foldRollups([
    mk('2026-07-21T09:00:00Z', 'qr-code'),
    mk('2026-07-21T10:00:00Z', 'qr-code'),
    mk('2026-07-22T10:00:00Z', 'deck-builder'),
  ]);
  assert.equal(rollups.get('2026-07-21|tool|qr-code'), 2);
  assert.equal(rollups.get('2026-07-22|tool|deck-builder'), 1);
  assert.equal(rollups.get('2026-07-21|event|tool.open'), 2);
});
