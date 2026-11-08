/**
 * The served asset feed (`/catalog/assets/index.json`), composed once per
 * input state instead of once per request.
 *
 * Composition folds five sources over the pack index: federated fragments,
 * instance assets, the org's metadata overlay, lifecycle and credentials, then
 * collections. With a DAM federated in, that is tens of thousands of entries
 * parsed, copied and stringified for every shell boot. This module keeps the
 * finished bytes per visibility key and serves them again until an input
 * changes, and gives every result an ETag so an unchanged feed costs a 304.
 *
 * What counts as an input, so a memo is never served past a change:
 * - the pack index file (mtime and size),
 * - each enabled provider's fragment hash, staleness, label and group exposure,
 * - every store row the composition reads (hashed as JSON; small next to the
 *   assets),
 * - the clock: lifecycle rows and upstream availability windows flip state at
 *   known instants, and a memo is treated as stale once the earliest of those
 *   after its composition has passed.
 *
 * The response body is the same `JSON.stringify` of the same object the route
 * built before this module existed, so a client sees identical bytes.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { sha256Hex } from '../lib/crypto.ts';
import type { Store } from '../store/types.ts';
import { callerSeesProvider, composeFederated, type Federation, type FragmentView } from './federation.ts';
import { applyLifecycleToIndex, assetState, type AssetIndex, type AssetIndexEntry, type LifecycleRow } from './lifecycle.ts';
import { composeInstanceAssets } from './instance-assets.ts';
import { applyTagRules, compileTagRules } from './tag-rules.ts';
import { composeAssetMeta } from './asset-meta.ts';
import { applyCredentialsToIndex } from './credentials.ts';
import { composeCollections } from './collections.ts';
import { ESSENTIAL_ASSET_TYPES, isProgrammeScoped, namesProgrammeGroup, partnerGroupsOf } from '../programmes/types.ts';
import { entryInFolders, foldersFor, nextFolderRuleEnd } from '../programmes/folders.ts';
import { composeRightsRecords, loadRightsEngine, rightsAnswer, type RightsEngine } from './rights.ts';
import type { PartnerRightsMode } from './rights-mode.ts';
import { currentFingerprint, pinLookup, type PinLookup, type RightsChoiceRecord } from '../programmes/rights.ts';
import { currentView } from '../rbac/view-context.ts';

export interface ServedProvider {
  id: string;
  label: string;
  /** Entries in the provider's fragment, before lifecycle. */
  size: number;
}

export interface ServedIndex {
  /** Global inputs before caller filtering, including time-based lifecycle state. */
  sourceFingerprint: string;
  /**
   * 'composed': `bytes` is the composed feed. 'raw': the pack index did not
   * have the expected shape, so `bytes` is the file as it is on disk (the
   * route serves it unchanged, as before). 'missing': the pack has no index;
   * the feed route answers 404, while search still sees federated entries.
   */
  status: 'composed' | 'raw' | 'missing';
  bytes: Buffer;
  /** Quoted strong ETag for `bytes`. */
  etag: string;
  /** The same value unquoted, for response bodies. */
  version: string;
  /** The composed index (over an empty pack when the file is raw or missing). */
  index: AssetIndex;
  /** Providers visible to this caller, in feed order. */
  providers: ServedProvider[];
  /** Entries sorted by lowercased name then id, computed on first use. */
  sorted(): AssetIndexEntry[];
}

export interface ServedIndexDeps {
  /** The pack root, read on every call: the selected design-system source
   *  can change while the process runs (brand/service.ts). */
  pack: () => string;
  store: Store;
  federation: Federation;
  /** Resolves once config-managed providers are in the store. */
  ready?: Promise<void>;
  now?: () => number;
  /** Providers with more entries than this leave the paged feed. */
  pagedThreshold?: number;
  /** Visibility keys kept at once (least recently used goes first). */
  maxKeys?: number;
  /** Serialized feed bytes kept across all keys. The parsed index each key
   *  also holds is a few times this size, so a DAM-sized feed with many
   *  distinct group sets is bounded by memory, not only by key count. */
  maxBytes?: number;
  /** The role a group set carries (rbac roleFromGroups with the deployment's
   *  mapping). An admin or owner in a partner programme is never scoped to it. */
  roleOf?: (groups: string[]) => string;
  /** The licence gate's mode (plans/82 M4). Absent, nothing is gated. */
  partnerRights?: () => Promise<PartnerRightsMode>;
}

export interface ServedIndexer {
  /** The feed for one caller. `paged` leaves large providers out of `assets`
   *  and lists them under `pagedProviders`. `ungated` leaves the licence gate
   *  out, for the admin's report and Preview, never for a caller's own feed. */
  forCaller(opts: { groups: string[]; paged?: boolean; background?: boolean; ungated?: boolean }): Promise<ServedIndex>;
  /** Full compositions run since creation (tests read this to prove the memo). */
  compositions(): number;
}

/** The key a name sort compares on: lowercased name, then id. */
export function sortKey(entry: AssetIndexEntry): [string, string] {
  const name = typeof entry.name === 'string' && entry.name ? entry.name : entry.id;
  return [name.toLowerCase(), entry.id];
}

export function compareKeys(a: [string, string], b: [string, string]): number {
  if (a[0] !== b[0]) return a[0] < b[0] ? -1 : 1;
  if (a[1] !== b[1]) return a[1] < b[1] ? -1 : 1;
  return 0;
}

const quoted = (version: string): string => `"${version}"`;

type ProviderRecordLike = { id: string; exposure: { groups?: string[] | '*' } };

/** A scoped entry names a successor only while the same feed carries that asset. */
function scopedReplacements(assets: AssetIndexEntry[]): AssetIndexEntry[] {
  const served = new Set(assets.map(entry => entry.id));
  return assets.map(entry => {
    const visible = { ...entry };
    if (typeof visible.replacedBy === 'string' && !served.has(visible.replacedBy)) delete visible.replacedBy;
    const meta = visible.meta as Record<string, unknown> | undefined;
    if (meta && typeof meta.replacedBy === 'string' && !served.has(meta.replacedBy)) {
      const shown = { ...meta };
      delete shown.replacedBy;
      visible.meta = shown;
    }
    return visible;
  });
}

/** Every group any asset source names, plus the caller's own: composing with
 *  this set sees every asset, so a programme scope can then keep exactly what
 *  it includes. */
function everyGroup(
  groups: string[], providers: Array<{ exposure: { groups?: string[] | '*' } }>,
  instAssets: Array<{ groups?: string[] | '*' }>, collections: Array<{ groups?: string[] | '*' }>,
): string[] {
  const all = new Set(groups);
  for (const list of [...providers.map((p) => p.exposure.groups), ...instAssets.map((a) => a.groups), ...collections.map((c) => c.groups)]) {
    if (Array.isArray(list)) for (const g of list) all.add(g);
  }
  return [...all].sort();
}

/**
 * Narrow a fully composed feed to what a partner programme member's programmes
 * include (plans/82 M1): design-system essentials, the members of collections
 * whose groups name one of their programme groups, and instance assets or
 * provider assets whose groups name one. Collections leave the feed unless
 * they name a programme group, and keep only the members that remain.
 */
export function applyProgrammeScope(
  index: AssetIndex,
  programmeGroups: ReadonlySet<string>,
  sources: {
    instAssets: Array<{ id: string; groups?: string[] | '*' }>;
    providerRecs: Array<{ id: string; exposure: { groups?: string[] | '*' } }>;
    collections: Array<{ id: string; members: string[]; groups?: string[] | '*' }>;
    /** Provider folders given to these groups (plans/82 M1 part 2c): provider
     *  id to the folder paths, each covering everything below it. */
    folders?: ReadonlyMap<string, string[]>;
    /** The licence gate (plans/82 M4): false holds an entry back. Absent, nothing is held. */
    rights?: (entry: AssetIndexEntry) => boolean;
  },
): AssetIndex {
  const granted = sources.collections.filter((c) => namesProgrammeGroup(c.groups, programmeGroups));
  const grantedIds = new Set(granted.map((c) => c.id));
  const members = new Set(granted.flatMap((c) => c.members));
  const inst = new Set(sources.instAssets.filter((a) => namesProgrammeGroup(a.groups, programmeGroups)).map((a) => a.id));
  const providers = new Set(sources.providerRecs.filter((p) => namesProgrammeGroup(p.exposure.groups, programmeGroups)).map((p) => p.id));
  const included = (entry: AssetIndexEntry): boolean => {
    if (typeof entry.type === 'string' && ESSENTIAL_ASSET_TYPES.has(entry.type)) return true;
    if (members.has(entry.id) || inst.has(entry.id)) return true;
    const ext = /^ext\/([^/]+)\//.exec(entry.id);
    if (!ext) return false;
    if (providers.has(ext[1]!)) return true;
    const meta = entry.meta as { providerFolder?: unknown } | undefined;
    return entryInFolders(meta?.providerFolder, sources.folders?.get(ext[1]!));
  };
  const rights = sources.rights;
  const keep = rights ? (entry: AssetIndexEntry): boolean => included(entry) && rights(entry) : included;
  const assets = (index.assets ?? []).filter(keep);
  const served = new Set(assets.map((a) => a.id));
  const out: AssetIndex = { ...index, assets: scopedReplacements(assets) };
  if (Array.isArray(index.collections)) {
    out.collections = (index.collections as Array<{ id: string; members: string[] }>)
      .filter((c) => grantedIds.has(c.id))
      .map((c) => ({ ...c, members: c.members.filter((m) => served.has(m)) }));
    if (!(out.collections as unknown[]).length) delete out.collections;
  }
  return out;
}

/**
 * The licence gate for one partner caller (plans/82 M4): an entry stays when
 * its rights answer lets the bytes travel, when it is exempt (the company-own
 * rule reads the caller's companies), or when a share anyway choice names one
 * of the caller's programme or company groups and the facts it was made about
 * still hold.
 */
export function licenceGate(engine: RightsEngine, partnerGroups: ReadonlySet<string>, choices: readonly RightsChoiceRecord[], pins?: PinLookup): (entry: AssetIndexEntry) => boolean {
  const companies = new Set([...partnerGroups].filter((g) => g.startsWith('company-')).map((g) => g.slice('company-'.length)));
  const byAsset = new Map<string, RightsChoiceRecord[]>();
  for (const c of choices) if (partnerGroups.has(c.group)) byAsset.set(c.assetId, [...(byAsset.get(c.assetId) ?? []), c]);
  return (entry) => {
    if (rightsAnswer(engine, entry, companies).state !== 'held') return true;
    return (byAsset.get(entry.id) ?? []).some((c) => currentFingerprint(engine, entry, c.group, pins) === c.fingerprint);
  };
}

/** The earliest instant after `now` at which any lifecycle row or availability
 *  window flips an entry's state, or Infinity when none will. */
export function nextLifecycleFlip(entries: AssetIndexEntry[], rows: LifecycleRow[], now: number): number {
  let next = Infinity;
  const consider = (iso: unknown): void => {
    if (typeof iso !== 'string') return;
    const t = Date.parse(iso);
    if (Number.isFinite(t) && t > now && t < next) next = t;
  };
  for (const r of rows) {
    consider(r.validFrom);
    consider(r.validUntil);
  }
  for (const e of entries) {
    if (e.availableFrom === undefined && e.availableUntil === undefined) continue;
    consider(e.availableFrom);
    consider(e.availableUntil);
  }
  return next;
}

/**
 * A view as a partner's feed: what the partner is served AND the admin behind the view
 * is served themselves (rbac/evaluate.ts). Collections keep only members still served,
 * and only providers both feeds show stay listed.
 */
export function intersectServed(theirs: ServedIndex, mine: ServedIndex): ServedIndex {
  // Whatever the pack index's state: a raw or missing pack still serves federated
  // and instance entries, so the intersection is the answer in every case, and its
  // bytes are always the intersected feed, never the file on disk.
  const admitted = new Set((mine.index.assets ?? []).map((entry) => entry.id));
  const assets = scopedReplacements((theirs.index.assets ?? []).filter((entry) => admitted.has(entry.id)));
  const served = new Set(assets.map((entry) => entry.id));
  const index: AssetIndex = { ...theirs.index, assets };
  if (Array.isArray(theirs.index.collections)) {
    index.collections = (theirs.index.collections as Array<{ members: string[] }>).map((c) => ({ ...c, members: c.members.filter((m) => served.has(m)) }));
  }
  const mineIds = new Set(mine.providers.map((provider) => provider.id));
  const providers = theirs.providers.filter((provider) => mineIds.has(provider.id));
  // Every provider id the feed names is one both sides see: the stale list too.
  const kept = new Set(providers.map((provider) => provider.id));
  const stale = (theirs.index as { staleProviders?: unknown }).staleProviders;
  if (Array.isArray(stale)) {
    const visible = stale.filter((id): id is string => typeof id === 'string' && kept.has(id));
    if (visible.length) (index as { staleProviders?: string[] }).staleProviders = visible;
    else delete (index as { staleProviders?: string[] }).staleProviders;
  }
  const bytes = Buffer.from(JSON.stringify(index));
  const version = sha256Hex(bytes).slice(0, 32);
  return withSort({ status: theirs.status === 'missing' ? 'missing' : 'composed', sourceFingerprint: sha256Hex(`${theirs.sourceFingerprint}\n${mine.sourceFingerprint}`), bytes, etag: quoted(version), version,
    index, providers });
}

/** What a paged feed is built from: the base feed's content, its providers (ids,
 *  labels and sizes, which decide what is paged and what is named) and the pending
 *  ones. The paged memo reuses a result only while all three are the same. */
export function pagedBasis(base: Pick<ServedIndex, 'version' | 'providers'>, pending: readonly string[]): string {
  return `${base.version}\n${JSON.stringify(base.providers.map((p) => [p.id, p.label, p.size]))}\n${JSON.stringify(pending)}`;
}

function withSort(result: Omit<ServedIndex, 'sorted'>): ServedIndex {
  let sorted: AssetIndexEntry[] | null = null;
  return {
    ...result,
    sorted() {
      if (!sorted) {
        const keyed = (result.index.assets ?? []).map((e) => ({ e, k: sortKey(e) }));
        keyed.sort((a, b) => compareKeys(a.k, b.k));
        sorted = keyed.map((x) => x.e);
      }
      return sorted;
    },
  };
}

export function createServedIndex(deps: ServedIndexDeps): ServedIndexer {
  const now = deps.now ?? Date.now;
  const maxKeys = deps.maxKeys ?? 16;
  const maxBytes = deps.maxBytes ?? 256 * 1024 * 1024;
  const threshold = deps.pagedThreshold ?? 2000;
  const memo = new Map<string, { fingerprint: string; staleAt: number; result: ServedIndex }>();
  const paged = new Map<string, { basedOn: string; result: ServedIndex }>();
  const inflight = new Map<string, Promise<ServedIndex>>();
  let compositions = 0;
  const packInputs = new Map<string, { stamp: string; bytes: Buffer | null; entries: AssetIndexEntry[] }>();

  // Least recently used goes first once a map holds more than maxKeys keys
  // or, together with the other map, more than maxBytes of feed. The entry
  // just stored always stays, so one oversized feed is still served.
  const heldBytes = (): number => {
    let total = 0;
    for (const v of memo.values()) total += v.result.bytes.length;
    for (const v of paged.values()) total += v.result.bytes.length;
    return total;
  };
  const remember = <V>(map: Map<string, V>, key: string, value: V): void => {
    map.delete(key);
    map.set(key, value);
    while (map.size > 1 && (map.size > maxKeys || heldBytes() > maxBytes)) map.delete(map.keys().next().value as string);
  };

  const providerStamp = (frags: FragmentView[]): string =>
    frags.map((f) => [
      f.rec.id, f.fragment.hash, f.stale ? 1 : 0, f.fragment.assets.length, f.rec.label, JSON.stringify(f.rec.exposure.groups ?? '*'),
    ].join(':')).join('|');

  const full = async (groups: string[], background = false, ungatedAsked = false): Promise<ServedIndex> => {
    await deps.ready;
    // Only a programme-scoped caller is ever gated, so for anyone else the
    // ungated feed is the feed and shares its memo.
    const ungated = ungatedAsked && isProgrammeScoped(groups, deps.roleOf?.(groups));
    const key = `${groups.join('\n')}${ungated ? '\n(ungated)' : ''}`;
    const packFile = join(deps.pack(), 'catalog', 'assets', 'index.json');
    let packStamp = `${packFile}:missing`;
    try {
      const st = await stat(packFile);
      packStamp = `${packFile}:${st.mtimeMs}:${st.size}`;
    } catch {
      /* no pack index: federated-only instances still compose */
    }
    let input = packInputs.get(packFile);
    if (!input || input.stamp !== packStamp) {
      const bytes = await readFile(packFile).catch(() => null);
      let entries: AssetIndexEntry[] = [];
      try { const index = bytes && JSON.parse(bytes.toString()) as AssetIndex; if (index && Array.isArray(index.assets)) entries = index.assets; } catch { /* Raw compatibility is handled below. */ }
      input = { stamp: packStamp, bytes, entries }; packInputs.set(packFile, input);
    }
    const frags = await deps.federation.fragments({ background });
    const [rows, creds, instAssets, metas, fieldDefs, collections, tagRuleRows, providerRecs, folderRules, rightsMarks, assetLicences] = await Promise.all([
      deps.store.listLifecycle(), deps.store.listCredentials(), deps.store.listInstanceAssets(),
      deps.store.listAssetMeta(), deps.store.listCatalogFields(), deps.store.listCollections(),
      deps.store.listCatalogTagRules(), deps.store.listProviders({ includeFragment: false }), deps.store.listPartnerFolders(),
      deps.store.listAssetRightsMarks(), deps.store.listAssetLicences(),
    ]);
    // The licence gate (plans/82 M4): its mode and the share anyway choices are inputs too.
    const rightsMode = deps.partnerRights ? await deps.partnerRights() : 'report';
    const rightsChoices = rightsMode === 'gate' ? await deps.store.listRightsChoices() : [];
    // Hidden tags (catalog/tag-rules.ts) are an input too: hiding or showing one
    // moves the fingerprint, so the next read composes afresh with no re-sync.
    const tagRules = compileTagRules(tagRuleRows, providerRecs);
    const t = now();
    const fingerprint = sha256Hex([
      sha256Hex(input.bytes ?? Buffer.alloc(0)), providerStamp(frags), JSON.stringify(rows), JSON.stringify(creds), JSON.stringify(instAssets),
      JSON.stringify(metas), JSON.stringify(fieldDefs), JSON.stringify(collections),
      JSON.stringify(tagRuleRows), JSON.stringify(providerRecs.map((p) => [p.id, p.mapping?.hiddenTags ?? []])),
      JSON.stringify(folderRules),
      // Marks and licence records (plans/82 M4): a memo never outlives one.
      JSON.stringify(rightsMarks), JSON.stringify(assetLicences), rightsMode, JSON.stringify(rightsChoices),
      JSON.stringify(rows.map(row => [row.assetId, assetState(row, t)])),
      JSON.stringify([...input.entries, ...instAssets.map(asset => asset.entry), ...frags.flatMap(fragment => fragment.fragment.assets)].map(entry => [entry.id,
        typeof entry.availableFrom === 'string' ? Date.parse(entry.availableFrom) <= t : true,
        typeof entry.availableUntil === 'string' ? Date.parse(entry.availableUntil) > t : true])),
    ].join('\n'));
    const hit = memo.get(key);
    if (hit && hit.fingerprint === fingerprint && t < hit.staleAt) {
      remember(memo, key, hit);
      return hit.result;
    }
    const flightKey = `${key}\n${fingerprint}`;
    const running = inflight.get(flightKey);
    if (running) return running;
    const work = (async (): Promise<ServedIndex> => {
      compositions += 1;
      // The engine reads each entry's own declaration; an instance with no mark
      // and no licence record never loads it, and its feed keeps its bytes.
      const scopedNow = isProgrammeScoped(groups, deps.roleOf?.(groups));
      const gating = rightsMode === 'gate' && scopedNow && !ungated;
      const rightsEngine = rightsMarks.length || assetLicences.length || gating ? await loadRightsEngine() : null;
      // A partner programme member (plans/82 M1) is composed as if they could
      // see every group's assets, then narrowed to what their programmes
      // include: essentials, granted collections' members, and instance assets
      // or providers whose groups name a programme group. `*` never counts.
      const scoped = isProgrammeScoped(groups, deps.roleOf?.(groups));
      // Programme and company groups both count (company-<id>, plans/82 M1 part 2).
      const programmeGroups = new Set(partnerGroupsOf(groups));
      // Provider folders given to their programmes or companies (part 2c).
      const folders = scoped ? foldersFor(folderRules, programmeGroups, t) : new Map<string, string[]>();
      const composeGroups = scoped ? everyGroup(groups, providerRecs, instAssets, collections) : groups;
      const providers: ServedProvider[] = frags
        .filter(({ rec }) => scoped ? namesProgrammeGroup(rec.exposure.groups, programmeGroups) || folders.has(rec.id) : callerSeesProvider(rec, groups))
        .map(({ rec, fragment }) => ({ id: rec.id, label: rec.label, size: fragment.assets.length }));
      const composeOver = (index: AssetIndex): { composed: AssetIndex; staleAt: number } => {
        // Federate before lifecycle so expire/revoke rows on ext/* ids gate
        // federated entries exactly like pack entries.
        const federated = composeFederated(index, frags, composeGroups);
        // Org-defined values ride the feed as an additive `fields` bag on the
        // entries that carry any (plans/31 section 4). It folds over pack,
        // federated and instance entries alike, because the overlay is keyed by
        // catalog id rather than by which of the three produced the entry.
        const withMeta = composeAssetMeta(composeInstanceAssets(federated, instAssets, composeGroups), metas, fieldDefs);
        // A licence record or the narrowest mark reaches every entry that records
        // nothing of its own (plans/82 M4), for every caller, so the app's details
        // sheet and its .lolly builder read the same record the server gates on.
        const withInstance = rightsEngine && Array.isArray(withMeta.assets)
          ? { ...withMeta, assets: composeRightsRecords(rightsEngine, withMeta.assets, rightsMarks, assetLicences) }
          : withMeta;
        // A folder rule's end date is a flip too: the feed recomposes then.
        const staleAt = Math.min(nextLifecycleFlip(withInstance.assets ?? [], rows, t), scoped ? nextFolderRuleEnd(folderRules, t) : Infinity);
        const gated = applyLifecycleToIndex(withInstance, rows, t);
        // Collections ride the SAME feed as an additive `collections` key
        // (plans/31 section 5), folded last so a member that lifecycle just
        // dropped is already absent from the ids it can reference. A
        // deployment with no collections serves a byte-identical index.
        // Hidden tags come off last, so a label an admin hid is neither shown nor
        // matched by search or the paged browse, which all read this feed.
        const composed = applyTagRules(composeCollections(applyCredentialsToIndex(gated, creds), collections, composeGroups), tagRules);
        const rights = gating && rightsEngine ? licenceGate(rightsEngine, programmeGroups, rightsChoices, pinLookup(instAssets)) : undefined;
        return { composed: scoped ? applyProgrammeScope(composed, programmeGroups, { instAssets, providerRecs, collections, folders, ...(rights ? { rights } : {}) }) : composed, staleAt };
      };
      let raw: Buffer | null = null;
      try {
        raw = await readFile(packFile);
      } catch {
        /* missing: handled below */
      }
      let result: Omit<ServedIndex, 'sorted'>;
      let staleAt = Infinity;
      if (raw) {
        try {
          const { composed, staleAt: s } = composeOver(JSON.parse(raw.toString('utf8')) as AssetIndex);
          const bytes = Buffer.from(JSON.stringify(composed));
          const version = sha256Hex(bytes).slice(0, 32);
          result = { status: 'composed', sourceFingerprint: fingerprint, bytes, etag: quoted(version), version, index: composed, providers };
          staleAt = s;
        } catch {
          // Not the expected shape: the route serves the file as it is, and
          // search falls back to the federated half alone.
          const fallback = composeOver({});
          const version = sha256Hex(raw).slice(0, 32);
          result = { status: 'raw', sourceFingerprint: fingerprint, bytes: raw, etag: quoted(version), version, index: fallback.composed, providers };
          staleAt = fallback.staleAt;
        }
      } else {
        const { composed, staleAt: s } = composeOver({});
        const bytes = Buffer.from(JSON.stringify(composed));
        const version = sha256Hex(bytes).slice(0, 32);
        result = { status: 'missing', sourceFingerprint: fingerprint, bytes, etag: quoted(version), version, index: composed, providers };
        staleAt = s;
      }
      const served = withSort(result);
      remember(memo, key, { fingerprint, staleAt, result: served });
      return served;
    })().finally(() => inflight.delete(flightKey));
    inflight.set(flightKey, work);
    return work;
  };

  /** The paged feed, derived from the full one: large providers' entries
   *  leave `assets`, collections keep only ids still served, and the
   *  providers are named under `pagedProviders` with their visible count. */
  const pagedFrom = (base: ServedIndex, key: string, pending: string[] = []): ServedIndex => {
    if (base.status !== 'composed') return base;
    const large = new Map(base.providers.filter((p) => p.size > threshold).map((p) => [p.id, p]));
    if (!large.size && !pending.length) return base;
    const basedOn = pagedBasis(base, pending);
    const hit = paged.get(key);
    if (hit && hit.basedOn === basedOn) {
      remember(paged, key, hit);
      return hit.result;
    }
    const counts = new Map<string, number>();
    const kept: AssetIndexEntry[] = [];
    for (const e of base.index.assets ?? []) {
      const provider = typeof e.provider === 'string' ? e.provider : undefined;
      if (provider && large.has(provider)) counts.set(provider, (counts.get(provider) ?? 0) + 1);
      else kept.push(e);
    }
    const served = new Set(kept.map((e) => e.id));
    const index: AssetIndex = { ...base.index, assets: kept };
    if (Array.isArray(base.index.collections)) {
      index.collections = (base.index.collections as Array<{ members: string[] }>).map((c) => ({ ...c, members: c.members.filter((m) => served.has(m)) }));
    }
    index.pagedProviders = [...large.values()].map((p) => ({ id: p.id, label: p.label, count: counts.get(p.id) ?? 0 }));
    if (pending.length) index.pendingProviders = pending;
    const bytes = Buffer.from(JSON.stringify(index));
    const version = sha256Hex(bytes).slice(0, 32);
    const sourceFingerprint = pending.length ? sha256Hex(`${base.sourceFingerprint}\n${JSON.stringify(pending)}`) : base.sourceFingerprint;
    const result = withSort({ status: 'composed', sourceFingerprint, bytes, etag: quoted(version), version, index, providers: base.providers });
    remember(paged, key, { basedOn, result });
    return result;
  };

  /** The feed for one group set, with no view applied. */
  const plain = async ({ groups, paged: wantPaged, background, ungated }: { groups: string[]; paged?: boolean; background?: boolean; ungated?: boolean }): Promise<ServedIndex> => {
    const key = [...new Set(groups)].sort();
    const base = await full(key, background, ungated === true);
    if (!wantPaged) return base;
    // An ungated feed (the admin's report and Preview) is paged on its own key.
    const scoped = isProgrammeScoped(key, deps.roleOf?.(key));
    return pagedFrom(base, `${key.join('\n')}${ungated && scoped ? '\n(ungated)' : ''}`, await pendingFor(key, base, background));
  };
  /** Providers this group set sees that the feed does not represent yet. */
  const pendingFor = async (key: string[], base: ServedIndex, background?: boolean): Promise<string[]> => {
    if (!background) return [];
    const represented = new Set(base.providers.map(provider => provider.id));
    // The same provider rule the feed applies: a partner programme member
    // waits only on providers whose groups name one of their programmes.
    const scoped = isProgrammeScoped(key, deps.roleOf?.(key));
    const programmeGroups = new Set(partnerGroupsOf(key));
    const folders = scoped ? foldersFor(await deps.store.listPartnerFolders(), programmeGroups, Date.now()) : new Map<string, string[]>();
    const sees = (provider: ProviderRecordLike): boolean => scoped ? namesProgrammeGroup(provider.exposure.groups, programmeGroups) || folders.has(provider.id) : callerSeesProvider(provider as never, key);
    return (await deps.store.listProviders({ includeFragment: false }))
      .filter(provider => provider.enabled && sees(provider) && !represented.has(provider.id))
      .map(provider => provider.id).sort();
  };
  const indexer: ServedIndexer = {
    async forCaller({ groups, paged: wantPaged, background, ungated }) {
      // A view as a partner (rbac/view-context.ts): the partner's feed AND the admin's
      // own, for the partner's groups only, with paging built from the intersection.
      const view = currentView();
      const key = [...new Set(groups)].sort();
      if (!view || key.join('\n') !== [...new Set(view.subjectGroups)].sort().join('\n')) return plain({ groups, paged: wantPaged, background, ungated });
      const viewerKey = [...new Set(view.viewer.groups)].sort();
      const [theirs, mine] = await Promise.all([full(key, background, ungated === true), full(viewerKey, background, ungated === true)]);
      const both = intersectServed(theirs, mine);
      if (!wantPaged) return both;
      const [theirsPending, minePending] = await Promise.all([pendingFor(key, theirs, background), pendingFor(viewerKey, mine, background)]);
      const pending = theirsPending.filter((id) => minePending.includes(id));
      return pagedFrom(both, `view-as\n${view.viewer.userId}\n${key.join('\n')}${ungated ? '\n(ungated)' : ''}`, pending);
    },
    compositions: () => compositions,
  };
  return indexer;
}
