/**
 * Telemetry ingest (plans/09).
 *
 * Three invariants enforced HERE, at the door, not in the query layer:
 *   1. No input values, ever - each event type has a closed attr allowlist;
 *      anything else is dropped before storage.
 *   2. Attribution policy is applied at ingest: below `standard` (or without
 *      the user's consent when attribution is opt-in) the user id is
 *      stripped, so unconsented events are aggregate from the first byte.
 *   3. Identity attributes are never telemetry - unconditionally, in any mode
 *      (plans/09 §2a). The public product promises "a person's disability or
 *      language is never telemetry", and employment does not suspend that:
 *      workplace telemetry covers work artifacts, not who a person is. The
 *      one event that brushes against it is `profile.update`, whose `fields`
 *      attr names the changed profile fields - a changed `a11y` or `lang`
 *      field IS the sensitive signal even with the value absent. So the
 *      field names pass a closed reportable allowlist (fail-closed: any
 *      field this file doesn't know is dropped, so a future sensitive
 *      Profile field is safe by default).
 */

export type TelemetryLevel = 'off' | 'aggregate' | 'standard';

export interface RawEvent {
  event: string;
  at?: string;
  attrs?: Record<string, unknown>;
}

export interface StoredEvent {
  event: string;
  at: string;
  userId?: string;
  attrs: Record<string, string>;
}

/** Closed vocabulary: event → allowed attr keys (plans/09 §1). */
export const EVENT_ATTRS: Record<string, readonly string[]> = {
  'app.boot': ['shell', 'shellVersion', 'engine', 'platform'],
  'tool.open': ['toolId'],
  'session.save': ['toolId', 'projectId'],
  'render.export': ['toolId', 'format', 'destination', 'approved'],
  'link.create': ['linkKind'],
  'link.visit': ['linkKind'],
  'catalog.asset-use': ['assetId'],
  // A catalog asset left as a file (plans/31 §7). `via` is a coarse label -
  // direct / link / zip - never a URL or a filename, so the no-values invariant
  // holds the same way `linkKind` does. Distinct from `asset-use` (opened or
  // placed in a tool): this is the download the console used to disclose it did
  // not measure, and now does.
  'catalog.asset-download': ['assetId', 'via'],
  'approval.requested': ['chainId', 'step'],
  'approval.approved': ['chainId', 'step'],
  'approval.rejected': ['chainId', 'step'],
  'profile.update': ['fields'],
  'collab.join': ['toolId'],
  // Seat-utility session durations (plans/09). `seconds` is a numeric LABEL, not
  // content - sanitizeEvent already string-coerces + length-caps it, and no
  // free-text attr exists here, so the no-values invariant holds. CLI sessions
  // are intentionally NOT captured (short/instant by design).
  'session.tool': ['toolId', 'seconds'],
  'session.shell': ['shell', 'seconds'],
};

/**
 * Profile field names that may appear in `profile.update`'s `fields` attr - 
 * contact-card facts an org directory legitimately cares about being kept
 * current. Everything else on the OSS `Profile` type (a11y preferences, `lang`,
 * favourites, feature flags, per-user catalog overlays, consent flags, …) is a
 * preference or an identity signal and is dropped at the door, invariant 3
 * above. A Set, not an object: `WHITELIST[v]` is truthy for prototype keys
 * like 'constructor'.
 */
export const REPORTABLE_PROFILE_FIELDS: ReadonlySet<string> = new Set([
  'firstname', 'lastname', 'email', 'phone', 'title', 'city', 'country', 'headshot',
]);

export interface IngestPolicy {
  level: TelemetryLevel;
  attribution: 'default' | 'opt-in';
}

/** Attrs are labels, not content - reject anything long enough to be a value. */
const MAX_ATTR_LEN = 200;

/**
 * Validate + sanitize one event. Returns null for unknown events or when
 * telemetry is off. Attrs are coerced to strings and filtered to the
 * allowlist - a value that survives is a label, never content.
 */
export function sanitizeEvent(
  raw: RawEvent,
  policy: IngestPolicy,
  user: { id: string; telemetryConsent?: boolean } | null,
  now = new Date(),
): StoredEvent | null {
  if (policy.level === 'off') return null;
  const allowed = EVENT_ATTRS[raw.event];
  if (!allowed) return null;
  const attrs: Record<string, string> = {};
  for (const key of allowed) {
    const v = raw.attrs?.[key];
    if (v === undefined || v === null) continue;
    let s = typeof v === 'string' ? v : typeof v === 'number' || typeof v === 'boolean' ? String(v) : null;
    if (raw.event === 'profile.update' && key === 'fields' && s !== null) {
      // Invariant 3: only reportable field NAMES survive; an update that only
      // touched preference/identity fields ingests with no `fields` attr at
      // all (the event itself still counts - "a profile was maintained").
      const kept = s.split(',').map((f) => f.trim()).filter((f) => REPORTABLE_PROFILE_FIELDS.has(f));
      s = kept.length ? kept.join(',') : null;
    }
    if (s !== null && s.length <= MAX_ATTR_LEN) attrs[key] = s;
  }
  const at = typeof raw.at === 'string' && !Number.isNaN(Date.parse(raw.at)) ? raw.at : now.toISOString();
  const out: StoredEvent = { event: raw.event, at, attrs };
  const attributed =
    policy.level === 'standard' &&
    user !== null &&
    (policy.attribution === 'default' || user.telemetryConsent === true);
  if (attributed && user) out.userId = user.id;
  return out;
}

/** Seat-utility rollup for one session kind (tool editor / shell). */
export interface SessionUtility {
  count: number;
  totalSeconds: number;
  avgSeconds: number;
  perDay: Array<{ date: string; seconds: number; count: number }>;
}

export interface TelemetrySummary {
  totals: { events: number; exports: number; activeUsers: number };
  days: Array<{ date: string; events: number; exports: number; users: number }>;
  topTools: Array<{ toolId: string; count: number }>;
  formats: Array<{ format: string; count: number }>;
  /** Most-used catalog assets (catalog.asset-use) - item popularity. */
  topAssets: Array<{ assetId: string; count: number }>;
  /** Most-downloaded catalog assets (catalog.asset-download) - what actually
   *  leaves as a file, distinct from topAssets' opened-or-placed popularity
   *  (plans/31 §7). Empty until the shells emit the event. */
  topDownloads: Array<{ assetId: string; count: number }>;
  /** Exports broken down by where they went (render.export destination) - the
   *  download vs server-render split, shown in full on this internal instance. */
  destinations: Array<{ destination: string; count: number }>;
  /** Seat utility from session.tool / session.shell durations. CLI sessions are
   *  intentionally excluded (short/instant by design). */
  sessions: { tool: SessionUtility; shell: SessionUtility };
}

const MS_PER_DAY = 86_400_000;

/** A duration label → non-negative number, or null (dropped) for junk. */
function seconds(v: string | undefined): number | null {
  if (v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/** Dashboard summary - pure fold over stored events (plans/09 §4). */
export function summarize(events: StoredEvent[], dayCount = 14, today = new Date()): TelemetrySummary {
  const dayIndex = new Map<string, { date: string; events: number; exports: number; users: number }>();
  // Distinct attributed users active per day ("visited the app at all"); folded
  // into days[].users at the end (a Set can't ride in the returned shape).
  const dayUsers = new Map<string, Set<string>>();
  for (let i = dayCount - 1; i >= 0; i--) {
    const d = new Date(today.getTime() - i * MS_PER_DAY).toISOString().slice(0, 10);
    dayIndex.set(d, { date: d, events: 0, exports: 0, users: 0 });
    dayUsers.set(d, new Set());
  }
  const tools = new Map<string, number>();
  const formats = new Map<string, number>();
  const assets = new Map<string, number>();
  const downloads = new Map<string, number>();
  const destinations = new Map<string, number>();
  const users = new Set<string>();
  let exports = 0;
  // Seat-utility session accumulators, day-windowed like dayIndex above.
  const sessionDays = (): Map<string, { date: string; seconds: number; count: number }> => {
    const m = new Map<string, { date: string; seconds: number; count: number }>();
    for (let i = dayCount - 1; i >= 0; i--) {
      const d = new Date(today.getTime() - i * MS_PER_DAY).toISOString().slice(0, 10);
      m.set(d, { date: d, seconds: 0, count: 0 });
    }
    return m;
  };
  const toolSessions = { count: 0, total: 0, days: sessionDays() };
  const shellSessions = { count: 0, total: 0, days: sessionDays() };
  for (const e of events) {
    const dayKey = e.at.slice(0, 10);
    const day = dayIndex.get(dayKey);
    if (day) day.events++;
    if (e.userId) {
      users.add(e.userId);
      dayUsers.get(dayKey)?.add(e.userId);
    }
    if (e.attrs.toolId) tools.set(e.attrs.toolId, (tools.get(e.attrs.toolId) ?? 0) + 1);
    if (e.event === 'render.export') {
      exports++;
      if (day) day.exports++;
      if (e.attrs.format) formats.set(e.attrs.format, (formats.get(e.attrs.format) ?? 0) + 1);
      if (e.attrs.destination) destinations.set(e.attrs.destination, (destinations.get(e.attrs.destination) ?? 0) + 1);
    }
    if (e.event === 'catalog.asset-use' && e.attrs.assetId) {
      assets.set(e.attrs.assetId, (assets.get(e.attrs.assetId) ?? 0) + 1);
    }
    if (e.event === 'catalog.asset-download' && e.attrs.assetId) {
      downloads.set(e.attrs.assetId, (downloads.get(e.attrs.assetId) ?? 0) + 1);
    }
    if (e.event === 'session.tool' || e.event === 'session.shell') {
      const s = seconds(e.attrs.seconds);
      if (s !== null) {
        const acc = e.event === 'session.tool' ? toolSessions : shellSessions;
        acc.count++;
        acc.total += s;
        const d = acc.days.get(e.at.slice(0, 10));
        if (d) { d.seconds += s; d.count++; }
      }
    }
  }
  for (const [date, entry] of dayIndex) entry.users = dayUsers.get(date)?.size ?? 0;
  const desc = (m: Map<string, number>) => [...m.entries()].sort((a, b) => b[1] - a[1]);
  const utility = (acc: { count: number; total: number; days: Map<string, { date: string; seconds: number; count: number }> }): SessionUtility => ({
    count: acc.count,
    totalSeconds: acc.total,
    avgSeconds: acc.count ? Math.round(acc.total / acc.count) : 0,
    perDay: [...acc.days.values()],
  });
  return {
    totals: { events: events.length, exports, activeUsers: users.size },
    days: [...dayIndex.values()],
    topTools: desc(tools).slice(0, 8).map(([toolId, count]) => ({ toolId, count })),
    formats: desc(formats).map(([format, count]) => ({ format, count })),
    topAssets: desc(assets).slice(0, 8).map(([assetId, count]) => ({ assetId, count })),
    topDownloads: desc(downloads).slice(0, 8).map(([assetId, count]) => ({ assetId, count })),
    destinations: desc(destinations).map(([destination, count]) => ({ destination, count })),
    sessions: { tool: utility(toolSessions), shell: utility(shellSessions) },
  };
}

/** Fold events into period×dimension×key counts for the dashboard rollups. */
export function foldRollups(events: StoredEvent[]): Map<string, number> {
  const out = new Map<string, number>();
  const bump = (k: string) => out.set(k, (out.get(k) ?? 0) + 1);
  for (const e of events) {
    const day = e.at.slice(0, 10);
    bump(`${day}|event|${e.event}`);
    if (e.attrs.toolId) bump(`${day}|tool|${e.attrs.toolId}`);
    if (e.event === 'render.export' && e.attrs.format) bump(`${day}|format|${e.attrs.format}`);
    if (e.userId) bump(`${day}|user|${e.userId}`);
  }
  return out;
}
