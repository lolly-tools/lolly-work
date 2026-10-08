/**
 * Hidden tags (plan 299, track B) - the labels an admin chooses not to show.
 *
 * A DAM's tags were written for the DAM: "approved-2019", "do-not-use-legal",
 * a section called "Internal". Federated as-is they arrive in every member's
 * facet list and popular-tag chips. Excluding the asset (`exposure.excludeTags`)
 * is the wrong tool for that: the asset is fine, its label is noise. A hidden
 * tag is dropped from what the feed SAYS about an asset and nothing else - the
 * asset, its exposure and its lifecycle are untouched.
 *
 * Three sources of rules, folded into one set:
 *  - the instance rule (scope `*`), which applies to every entry: pack assets,
 *    instance assets and every provider's;
 *  - one rule per provider (scope `provider:<id>`), which applies only to that
 *    provider's entries. Both rule kinds are rows the console writes and the
 *    policy document exports;
 *  - `mapping.hiddenTags` on a provider record, the declarative form for a
 *    provider that instance.json manages (the console cannot write those).
 *
 * The rules are applied when the index is SERVED, not when a provider syncs.
 * That is deliberate: a fragment keeps the upstream truth, so hiding and
 * showing a tag both take effect on the next index read with no provider walk,
 * and the admin census can still count a hidden tag so it can be shown again.
 *
 * A pattern is an exact tag or a prefix ending in `*` ("internal:*"), matched
 * without regard to case. The `provider:<id>` tag the feed uses to say where an
 * entry came from is never hidden: shells filter by it.
 *
 * Pure functions plus one small loader. No fs; the store is passed in.
 */
import type { AssetIndex, AssetIndexEntry } from './lifecycle.ts';
import type { ProviderRecord } from './providers/types.ts';
import type { Store } from '../store/types.ts';

/** The instance-wide scope. */
export const INSTANCE_SCOPE = '*';
const PROVIDER_SCOPE_RE = /^provider:[a-z0-9][a-z0-9-]*$/;

/** Bounds: a hidden list is a curated list, not a second taxonomy. */
export const MAX_HIDDEN_PATTERNS = 2000;
const MAX_PATTERN_LENGTH = 200;

/** One stored rule. `scope` is `*` or `provider:<id>`. */
export interface CatalogTagRule {
  scope: string;
  /** Exact tags or `prefix*` patterns, original spelling kept for display. */
  hidden: string[];
  /** 'user:<id>' who last changed the rule, and when. */
  updatedBy?: string;
  updatedAt?: string;
}

/** Whether a scope string names something this module knows how to apply. */
export function validTagScope(scope: string): boolean {
  return scope === INSTANCE_SCOPE || PROVIDER_SCOPE_RE.test(scope);
}

/** `provider:<id>` for a provider id. */
export const providerScope = (providerId: string): string => `provider:${providerId}`;

/** The structural tag shells filter by. Never hidden. */
const isSystemTag = (tag: string): boolean => /^provider:/i.test(tag);

/**
 * Validate an untrusted hidden list into a clean one, or return the refusal.
 * Trimmed, deduped without regard to case (first spelling wins), order kept.
 * A `*` anywhere but the end, a bare `*`, and control characters are refused
 * rather than normalized, because each would hide something other than what
 * the admin typed.
 */
export function normalizeHiddenTags(raw: unknown): string[] | { error: string } {
  if (!Array.isArray(raw)) return { error: 'hidden must be a list of tags' };
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: 'each hidden tag must be a string' };
    const tag = item.trim();
    if (!tag) continue;
    if (tag.length > MAX_PATTERN_LENGTH) return { error: `a hidden tag is at most ${MAX_PATTERN_LENGTH} characters` };
    if (/[\x00-\x1f]/.test(tag)) return { error: 'a hidden tag cannot contain control characters' };
    if (tag === '*' || tag.slice(0, -1).includes('*')) return { error: `"${tag}": a pattern is a tag, or a prefix followed by one *` };
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  if (out.length > MAX_HIDDEN_PATTERNS) return { error: `at most ${MAX_HIDDEN_PATTERNS} hidden tags per scope` };
  return out;
}

/** A compiled pattern list: exact tags in a set, prefixes in a short list. */
export interface TagMatcher {
  (tag: string): string | null;
  readonly size: number;
}

/**
 * Compile patterns into a matcher that answers WHICH pattern hid a tag (or
 * null), so the census can say "hidden by internal:*" rather than only "hidden".
 */
export function tagMatcher(patterns: readonly string[]): TagMatcher {
  const exact = new Map<string, string>();
  const prefixes: Array<[string, string]> = [];
  for (const p of patterns) {
    const lower = p.toLowerCase();
    if (lower.endsWith('*')) prefixes.push([lower.slice(0, -1), p]);
    else if (!exact.has(lower)) exact.set(lower, p);
  }
  const match = ((tag: string): string | null => {
    if (typeof tag !== 'string' || isSystemTag(tag)) return null;
    const lower = tag.toLowerCase();
    const hit = exact.get(lower);
    if (hit) return hit;
    for (const [prefix, original] of prefixes) if (lower.startsWith(prefix)) return original;
    return null;
  }) as TagMatcher;
  Object.defineProperty(match, 'size', { value: exact.size + prefixes.length });
  return match;
}

/** Everything the serve-time pass needs, compiled once per request. */
export interface TagRuleSet {
  instance: TagMatcher;
  /** Provider id → matcher for that provider's own scope (rule row ∪ mapping). */
  providers: Map<string, TagMatcher>;
}

/** Fold stored rules and provider records into one compiled set. */
export function compileTagRules(rules: readonly CatalogTagRule[], providers: ReadonlyArray<Pick<ProviderRecord, 'id' | 'mapping'>>): TagRuleSet {
  const instance = tagMatcher(rules.find((r) => r.scope === INSTANCE_SCOPE)?.hidden ?? []);
  const byProvider = new Map<string, string[]>();
  for (const r of rules) {
    if (!r.scope.startsWith('provider:')) continue;
    byProvider.set(r.scope.slice('provider:'.length), [...r.hidden]);
  }
  for (const p of providers) {
    const declared = Array.isArray(p.mapping?.hiddenTags) ? p.mapping.hiddenTags.filter((t): t is string => typeof t === 'string') : [];
    if (declared.length) byProvider.set(p.id, [...(byProvider.get(p.id) ?? []), ...declared]);
  }
  const compiled = new Map<string, TagMatcher>();
  for (const [id, list] of byProvider) {
    const m = tagMatcher(list);
    if (m.size) compiled.set(id, m);
  }
  return { instance, providers: compiled };
}

/** Whether any rule would change anything - the common case is none. */
export function tagRulesEmpty(set: TagRuleSet): boolean {
  return set.instance.size === 0 && set.providers.size === 0;
}

/** The provider an entry came from, read the way the feed writes it. */
const entryProvider = (entry: AssetIndexEntry): string | undefined =>
  typeof entry.provider === 'string' ? entry.provider : undefined;

/** The meta keys a provider entry carries labels in, besides `tags`. */
const LABEL_META_KEYS = ['providerTags', 'providerSections', 'providerCollections'] as const;

/**
 * One entry with its hidden labels removed, or the SAME entry when nothing
 * matched (no copy), so an index with no matching tags stays byte-identical.
 */
export function hideEntryTags(entry: AssetIndexEntry, set: TagRuleSet): AssetIndexEntry {
  const providerId = entryProvider(entry);
  const own = providerId ? set.providers.get(providerId) : undefined;
  if (!set.instance.size && !own) return entry;
  const hidden = (label: unknown): boolean =>
    typeof label === 'string' && (set.instance(label) !== null || (own ? own(label) !== null : false));
  let next: AssetIndexEntry = entry;
  if (Array.isArray(entry.tags) && entry.tags.some(hidden)) {
    next = { ...next, tags: (entry.tags as unknown[]).filter((t) => !hidden(t)) };
  }
  const meta = entry.meta;
  if (meta && typeof meta === 'object' && !Array.isArray(meta)) {
    const m = meta as Record<string, unknown>;
    let nextMeta: Record<string, unknown> | null = null;
    for (const key of LABEL_META_KEYS) {
      const list = m[key];
      if (!Array.isArray(list) || !list.some(hidden)) continue;
      nextMeta ??= { ...m };
      nextMeta[key] = list.filter((t) => !hidden(t));
    }
    if (nextMeta) next = { ...next, meta: nextMeta };
  }
  return next;
}

/** The served index with every hidden label removed. Same reference when no rule applies. */
export function applyTagRules(index: AssetIndex, set: TagRuleSet): AssetIndex {
  if (tagRulesEmpty(set) || !Array.isArray(index.assets)) return index;
  let changed = false;
  const assets = index.assets.map((e) => {
    const next = hideEntryTags(e, set);
    if (next !== e) changed = true;
    return next;
  });
  return changed ? { ...index, assets } : index;
}

/** Read the stored rules and the providers' declared lists, compiled. */
export async function loadTagRules(store: Pick<Store, 'listCatalogTagRules' | 'listProviders'>): Promise<TagRuleSet> {
  const [rules, providers] = await Promise.all([
    store.listCatalogTagRules(),
    store.listProviders({ includeFragment: false }),
  ]);
  return compileTagRules(rules, providers);
}

// -- the admin census ----------------------------------------------------------

/** Where a label was seen: `pack`, `instance`, or a provider id. */
export type TagSource = string;
export type TagKind = 'tag' | 'section' | 'collection';

export interface TagCensusRow {
  tag: string;
  /** Assets carrying it, over every source. */
  count: number;
  /** Assets carrying it, per source. */
  sources: Record<TagSource, number>;
  /** What the label is to the DAM it came from. */
  kinds: TagKind[];
  /** The scopes and patterns hiding it right now, e.g. `{ scope: '*', pattern: 'internal:*' }`. */
  hiddenBy: Array<{ scope: string; pattern: string; declared?: boolean }>;
}

/** A source of entries for the census, named for the counts it contributes. */
export interface CensusInput {
  source: TagSource;
  entries: readonly AssetIndexEntry[];
}

/**
 * Count every label the catalog carries, unhidden, so an admin sees the noise
 * they are deciding about - including the labels already hidden, which is how
 * one is found again to be shown. Entry-level dedupe: an asset that carries
 * "Logos" as a tag and as a section counts once.
 */
export function tagCensus(
  inputs: readonly CensusInput[],
  rules: readonly CatalogTagRule[],
  providers: ReadonlyArray<Pick<ProviderRecord, 'id' | 'mapping'>>,
): TagCensusRow[] {
  const rows = new Map<string, TagCensusRow>();
  for (const { source, entries } of inputs) {
    for (const e of entries) {
      const labels = new Map<string, { tag: string; kinds: Set<TagKind> }>();
      const add = (raw: unknown, kind: TagKind): void => {
        if (typeof raw !== 'string') return;
        const tag = raw.trim();
        if (!tag || isSystemTag(tag)) return;
        const key = tag.toLowerCase();
        const at = labels.get(key) ?? { tag, kinds: new Set<TagKind>() };
        at.kinds.add(kind);
        labels.set(key, at);
      };
      for (const t of Array.isArray(e.tags) ? e.tags : []) add(t, 'tag');
      const meta = (e.meta && typeof e.meta === 'object' ? e.meta : {}) as Record<string, unknown>;
      for (const t of Array.isArray(meta.providerTags) ? meta.providerTags : []) add(t, 'tag');
      for (const t of Array.isArray(meta.providerSections) ? meta.providerSections : []) add(t, 'section');
      for (const t of Array.isArray(meta.providerCollections) ? meta.providerCollections : []) add(t, 'collection');
      for (const [key, { tag, kinds }] of labels) {
        const row = rows.get(key) ?? { tag, count: 0, sources: {}, kinds: [], hiddenBy: [] };
        row.count += 1;
        row.sources[source] = (row.sources[source] ?? 0) + 1;
        for (const k of kinds) if (!row.kinds.includes(k)) row.kinds.push(k);
        rows.set(key, row);
      }
    }
  }
  const instance = tagMatcher(rules.find((r) => r.scope === INSTANCE_SCOPE)?.hidden ?? []);
  const stored = new Map(rules.filter((r) => r.scope.startsWith('provider:')).map((r) => [r.scope.slice('provider:'.length), tagMatcher(r.hidden)]));
  const declared = new Map(providers
    .filter((p) => Array.isArray(p.mapping?.hiddenTags) && p.mapping.hiddenTags.length)
    .map((p) => [p.id, tagMatcher(p.mapping.hiddenTags as string[])]));
  for (const row of rows.values()) {
    const hit = instance(row.tag);
    if (hit) row.hiddenBy.push({ scope: INSTANCE_SCOPE, pattern: hit });
    for (const providerId of Object.keys(row.sources)) {
      const own = stored.get(providerId)?.(row.tag);
      if (own) row.hiddenBy.push({ scope: providerScope(providerId), pattern: own });
      const fixed = declared.get(providerId)?.(row.tag);
      if (fixed) row.hiddenBy.push({ scope: providerScope(providerId), pattern: fixed, declared: true });
    }
  }
  return [...rows.values()].sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}
