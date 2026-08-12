/**
 * Activity feed — a humane, merged timeline over two existing records:
 *   - the audit log (authoritative "who did what": links, sessions, projects,
 *     grants, providers, approvals, groups, lockouts, …), and
 *   - attributed usage telemetry (downloads/exports, tool opens, asset use) —
 *     only events that carry a userId, so the feed can name the actor.
 *
 * Pure: takes the two event lists + an id→name map and returns a filtered,
 * paginated page plus facets (categories, actors) for the console's filter bar.
 * The console owns the phrasing, deep links, and thumbnails — this only
 * normalises, merges, filters, and sorts.
 */
import type { AuditEvent } from '../audit/chain.ts';
import type { StoredEvent } from '../telemetry/ingest.ts';

export type ActorKind = 'user' | 'guest' | 'system';
export interface ActivityActor {
  id: string | null;
  name: string;
  kind: ActorKind;
}
export interface ActivityItem {
  id: string; // 'a<seq>' for audit, 't<index>' for telemetry — stable within a snapshot
  source: 'audit' | 'telemetry';
  at: string;
  action: string;
  category: string;
  actor: ActivityActor;
  subject: string | null; // 'type:id' (link:…, tool:…, asset:…) or null
  payload: Record<string, unknown>;
}
export interface ActivityQuery {
  category?: string | null;
  actor?: string | null; // actor id
  group?: string | null; // only items whose actor is a member of this group
  day?: string | null; // YYYY-MM-DD — only this calendar day (clicking a date filters to it)
  q?: string | null;
  before?: string | null; // ISO cursor, exclusive
  limit?: number;
}
export interface ActivityPage {
  items: ActivityItem[];
  total: number; // count matching the filters (before paging)
  nextBefore: string | null; // cursor for the next page, or null at the end
  categories: Array<{ key: string; count: number }>;
  actors: Array<{ id: string; name: string }>;
  /** id→name for every user referenced on this page (actor, user: subject, or a
   *  user: grant principal) so the console can render names, not opaque ids. */
  names: Record<string, string>;
}

// Usage events worth showing as attributed activity. Audit already records
// link.create / session.* / etc., so those telemetry twins are NOT re-listed
// here — only signals audit does not carry (a successful download is the key one).
const TELEMETRY_ACTIONS = new Set(['render.export', 'tool.open', 'catalog.asset-use']);

/** Coarse bucket for the filter bar — the action's head, with a few folds. */
export function categoryOf(action: string): string {
  const head = action.split('.')[0] ?? action;
  if (head === 'render' || head === 'tool') return 'render';
  if (head === 'sessions') return 'session';
  return head; // link, session, project, catalog, grant, group, user, approval, message, chain, auth, guest, telemetry
}

function parseActor(actor: string, nameById: Map<string, string>): ActivityActor {
  const i = actor.indexOf(':');
  const kind = i < 0 ? actor : actor.slice(0, i);
  const id = i < 0 ? null : actor.slice(i + 1);
  if (kind === 'user' && id) return { id, name: nameById.get(id) ?? 'a teammate', kind: 'user' };
  if (kind === 'guest' && id) return { id, name: 'a guest', kind: 'guest' };
  return { id: null, name: 'the system', kind: 'system' };
}

function telemetrySubject(e: StoredEvent): string | null {
  if (e.event === 'catalog.asset-use' && e.attrs.assetId) return `asset:${e.attrs.assetId}`;
  if (e.attrs.toolId) return `tool:${e.attrs.toolId}`;
  return null;
}

/** Fold both sources into one normalised item list (unfiltered, unsorted). */
export function normalizeActivity(
  audit: AuditEvent[],
  telemetry: StoredEvent[],
  nameById: Map<string, string>,
): ActivityItem[] {
  const items: ActivityItem[] = [];
  for (const e of audit) {
    items.push({
      id: `a${e.seq}`,
      source: 'audit',
      at: e.at,
      action: e.action,
      category: categoryOf(e.action),
      actor: parseActor(e.actor, nameById),
      subject: e.subject ?? null,
      payload: e.payload ?? {},
    });
  }
  telemetry.forEach((e, i) => {
    if (!e.userId || !TELEMETRY_ACTIONS.has(e.event)) return;
    items.push({
      id: `t${i}`,
      source: 'telemetry',
      at: e.at,
      action: e.event,
      category: categoryOf(e.event),
      actor: { id: e.userId, name: nameById.get(e.userId) ?? 'a teammate', kind: 'user' },
      subject: telemetrySubject(e),
      payload: { ...e.attrs },
    });
  });
  return items;
}

export function buildActivity(
  audit: AuditEvent[],
  telemetry: StoredEvent[],
  nameById: Map<string, string>,
  query: ActivityQuery = {},
  groupsByUser: Map<string, string[]> = new Map(),
): ActivityPage {
  const all = normalizeActivity(audit, telemetry, nameById);
  const limit = Math.min(Math.max(query.limit ?? 50, 1), 200);
  const q = (query.q ?? '').toLowerCase().trim();
  const matches = (x: ActivityItem): boolean => {
    if (query.category && x.category !== query.category) return false;
    if (query.actor && x.actor.id !== query.actor) return false;
    if (query.group && !(groupsByUser.get(x.actor.id ?? '') ?? []).includes(query.group)) return false;
    if (query.day && x.at.slice(0, 10) !== query.day) return false;
    if (query.before && !(x.at < query.before)) return false;
    if (q) {
      const hay = `${x.action} ${x.subject ?? ''} ${x.actor.name} ${Object.values(x.payload).join(' ')}`.toLowerCase();
      if (!hay.includes(q)) return false;
    }
    return true;
  };
  // Newest first; tie-break on id so the cursor is deterministic.
  const filtered = all.filter(matches).sort((a, b) => b.at.localeCompare(a.at) || b.id.localeCompare(a.id));
  const items = filtered.slice(0, limit);
  // Facets over the whole snapshot (not the current category/actor filter) so the
  // user can always switch to another bucket.
  const catCount = new Map<string, number>();
  const actorName = new Map<string, string>();
  for (const x of all) {
    catCount.set(x.category, (catCount.get(x.category) ?? 0) + 1);
    if (x.actor.kind === 'user' && x.actor.id) actorName.set(x.actor.id, x.actor.name);
  }
  // Names for every user referenced on THIS page (actor, user: subject, user:
  // grant principal) — keeps the payload small while making the feed readable.
  const names: Record<string, string> = {};
  const addName = (uid: string | null | undefined): void => {
    if (uid && nameById.has(uid)) names[uid] = nameById.get(uid)!;
  };
  for (const x of items) {
    addName(x.actor.id);
    if (x.subject?.startsWith('user:')) addName(x.subject.slice(5));
    const pr = x.payload.principal;
    if (typeof pr === 'string' && pr.startsWith('user:')) addName(pr.slice(5));
  }
  return {
    items,
    total: filtered.length,
    nextBefore: items.length === limit && filtered.length > limit ? items[items.length - 1]!.at : null,
    categories: [...catCount.entries()].sort((a, b) => b[1] - a[1]).map(([key, count]) => ({ key, count })),
    actors: [...actorName.entries()].sort((a, b) => a[1].localeCompare(b[1])).map(([id, name]) => ({ id, name })),
    names,
  };
}
