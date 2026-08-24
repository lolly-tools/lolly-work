/**
 * Collections (plans/31 section 5) - a named, ORDERED set of catalog assets a
 * curator assembles by hand, visible to the groups they name.
 *
 * Three properties do the work, and each is a deliberate choice:
 *
 *  - Members are catalog asset ids, so one collection mixes `inst/*` (bytes we
 *    own), `ext/*` (federated, owned by an upstream DAM) and pack ids freely.
 *    Nothing here dereferences a member; a collection is a list of names, and
 *    every surface that serves one re-asks the gates for each id at the moment
 *    it serves. That is what lets a member be revoked, expired or deleted
 *    without the collection needing to know.
 *  - Order is the curator's and is preserved exactly - a lookbook is a sequence,
 *    not a set. Duplicates collapse to their FIRST position, so re-adding an
 *    asset never silently moves it.
 *  - Visibility is groups, the same shape instance assets and providers use, so
 *    "the brand team's launch set" is one field rather than a new access model.
 *
 * Pure functions only - no store, no fs - so the routes, the per-caller feed
 * and the bearer page all fold identical rules.
 */
import type { AssetIndex } from './lifecycle.ts';

/** A collection id is a slug: it rides a URL path and a link target. */
const COLLECTION_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
/** A member is a catalog asset id: `inst/x`, `ext/dam/a1`, `suse/tokens/brand`. */
const MEMBER_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

/** Bounds. A collection is a curated set, not a second catalog: the cap keeps
 *  the bearer page and the zip-all a bounded amount of work, and it is high
 *  enough that no real lookbook meets it. */
export const MAX_MEMBERS = 500;

export interface CollectionRecord {
  id: string;
  name: string;
  description?: string;
  /** Ordered member catalog asset ids - mixed shapes, deduped, order kept. */
  members: string[];
  /** Groups that may see it; '*' or absent = every member of the instance. */
  groups?: string[] | '*';
  /** 'user:<id>' who curates it - carried on the record, shown on the page. */
  curator: string;
  createdAt: string;
  updatedAt: string;
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an untrusted collection body into a record, or return the refusal.
 *
 * `prior` is the stored record on an update: it carries createdAt and the
 * curator forward, so an edit never silently re-owns somebody else's set, and a
 * PUT that omits a key keeps what was there rather than clearing it.
 */
export function normalizeCollection(
  id: string,
  raw: unknown,
  ctx: { curator: string; now: string; prior?: CollectionRecord | null },
): CollectionRecord | { error: string } {
  if (!COLLECTION_ID_RE.test(id)) return { error: 'a collection id is a slug: lowercase letters, digits and dashes' };
  if (!isObj(raw)) return { error: 'body required' };
  const prior = ctx.prior ?? null;

  const rawName = raw.name === undefined ? prior?.name : raw.name;
  const name = typeof rawName === 'string' ? rawName.trim().slice(0, 200) : '';
  if (!name) return { error: 'name required' };

  let description = prior?.description;
  if (raw.description !== undefined) {
    if (typeof raw.description !== 'string') return { error: 'description must be a string' };
    description = raw.description.trim().slice(0, 1000) || undefined;
  }

  let members = prior?.members ?? [];
  if (raw.members !== undefined) {
    if (!Array.isArray(raw.members)) return { error: 'members must be a list of catalog asset ids' };
    const seen = new Set<string>();
    const out: string[] = [];
    for (const m of raw.members) {
      const memberId = String(m).trim();
      if (!memberId) continue;
      // A traversal-shaped id is refused rather than normalized: a member id is
      // handed straight to the same resolvers a link target is, and those read
      // the pack filesystem.
      if (memberId.includes('..') || !MEMBER_ID_RE.test(memberId)) return { error: `bad member id "${memberId}"` };
      if (seen.has(memberId)) continue;
      seen.add(memberId);
      out.push(memberId);
    }
    if (out.length > MAX_MEMBERS) return { error: `a collection holds at most ${MAX_MEMBERS} assets` };
    members = out;
  }

  let groups = prior?.groups;
  if (raw.groups !== undefined) {
    if (raw.groups === '*' || raw.groups === null) groups = '*';
    else if (Array.isArray(raw.groups)) {
      const list = [...new Set(raw.groups.map((g) => String(g).trim()).filter(Boolean))].slice(0, 64);
      groups = list.length ? list : '*';
    } else return { error: "groups must be a list of group names, or '*'" };
  }

  return {
    id,
    name,
    ...(description ? { description } : {}),
    members,
    ...(groups && groups !== '*' ? { groups } : {}),
    curator: prior?.curator ?? ctx.curator,
    createdAt: prior?.createdAt ?? ctx.now,
    updatedAt: ctx.now,
  };
}

/** Whether this caller's groups admit the collection at all. Mirrors
 *  `instanceAssetVisible` on purpose: one visibility shape across the catalog. */
export function collectionVisible(rec: CollectionRecord, callerGroups: string[]): boolean {
  const g = rec.groups;
  if (!g || g === '*') return true;
  return g.some((x) => callerGroups.includes(x));
}

/** Stable order for every surface: by name, then id, so the console, the CLI
 *  and the feed agree without each sorting for itself. */
export function sortCollections(recs: CollectionRecord[]): CollectionRecord[] {
  return [...recs].sort((a, b) => (a.name === b.name ? (a.id < b.id ? -1 : 1) : a.name < b.name ? -1 : 1));
}

/** What a served feed carries for one collection - the curator's own list,
 *  narrowed to the assets this caller is actually being served. */
export interface ServedCollection {
  id: string;
  name: string;
  description?: string;
  members: string[];
  updatedAt: string;
}

/**
 * Fold the caller's visible collections onto a served index as an ADDITIVE
 * `collections` key.
 *
 * Additive is the whole point (plans/31 section 5, section 10): the OSS catalog
 * view renders a Collections section when the feed carries any, a public build
 * carries none and renders byte-identically, and no shell version is ever
 * required in lockstep - so the OSS side can light this up later with no server
 * change.
 *
 * Two independent gates, deliberately not collapsed into one:
 *   - the COLLECTION is admitted by its own groups, and
 *   - each MEMBER is narrowed to the ids that survive into this caller's feed,
 *     which is where per-asset exposure and lifecycle have already been decided.
 * A collection whose every member has expired therefore still lists, empty,
 * rather than vanishing: "why is this empty" is a question a curator can answer
 * and "where did my collection go" is not.
 *
 * Called AFTER lifecycle and instance/federated composition, because it reads
 * the ids that composition left behind.
 */
export function composeCollections(
  index: AssetIndex, recs: CollectionRecord[], callerGroups: string[],
): AssetIndex {
  const visible = sortCollections(recs.filter((r) => collectionVisible(r, callerGroups)));
  if (!visible.length) return index;
  const served = new Set((index.assets ?? []).map((a) => a.id));
  const collections: ServedCollection[] = visible.map((r) => ({
    id: r.id,
    name: r.name,
    ...(r.description ? { description: r.description } : {}),
    members: r.members.filter((m) => served.has(m)),
    updatedAt: r.updatedAt,
  }));
  return { ...index, collections };
}
