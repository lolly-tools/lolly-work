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
import { applyLifecycleToIndex, type AssetIndex, type AssetIndexEntry, type LifecycleRow } from './lifecycle.ts';
import { composeInstanceAssets } from './instance-assets.ts';
import { composeAssetMeta } from './asset-meta.ts';
import { applyCredentialsToIndex } from './credentials.ts';
import { composeCollections } from './collections.ts';

export interface ServedProvider {
  id: string;
  label: string;
  /** Entries in the provider's fragment, before lifecycle. */
  size: number;
}

export interface ServedIndex {
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
}

export interface ServedIndexer {
  /** The feed for one caller. `paged` leaves large providers out of `assets`
   *  and lists them under `pagedProviders`. */
  forCaller(opts: { groups: string[]; paged?: boolean }): Promise<ServedIndex>;
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

  const full = async (groups: string[]): Promise<ServedIndex> => {
    await deps.ready;
    const key = groups.join('\n');
    const packFile = join(deps.pack(), 'catalog', 'assets', 'index.json');
    let packStamp = `${packFile}:missing`;
    try {
      const st = await stat(packFile);
      packStamp = `${packFile}:${st.mtimeMs}:${st.size}`;
    } catch {
      /* no pack index: federated-only instances still compose */
    }
    const frags = await deps.federation.fragments();
    const [rows, creds, instAssets, metas, fieldDefs, collections] = await Promise.all([
      deps.store.listLifecycle(), deps.store.listCredentials(), deps.store.listInstanceAssets(),
      deps.store.listAssetMeta(), deps.store.listCatalogFields(), deps.store.listCollections(),
    ]);
    const fingerprint = sha256Hex([
      packStamp, providerStamp(frags), JSON.stringify(rows), JSON.stringify(creds), JSON.stringify(instAssets),
      JSON.stringify(metas), JSON.stringify(fieldDefs), JSON.stringify(collections),
    ].join('\n'));
    const t = now();
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
      const providers: ServedProvider[] = frags
        .filter(({ rec }) => callerSeesProvider(rec, groups))
        .map(({ rec, fragment }) => ({ id: rec.id, label: rec.label, size: fragment.assets.length }));
      const composeOver = (index: AssetIndex): { composed: AssetIndex; staleAt: number } => {
        // Federate before lifecycle so expire/revoke rows on ext/* ids gate
        // federated entries exactly like pack entries.
        const federated = composeFederated(index, frags, groups);
        // Org-defined values ride the feed as an additive `fields` bag on the
        // entries that carry any (plans/31 section 4). It folds over pack,
        // federated and instance entries alike, because the overlay is keyed by
        // catalog id rather than by which of the three produced the entry.
        const withInstance = composeAssetMeta(composeInstanceAssets(federated, instAssets, groups), metas, fieldDefs);
        const staleAt = nextLifecycleFlip(withInstance.assets ?? [], rows, t);
        const gated = applyLifecycleToIndex(withInstance, rows, t);
        // Collections ride the SAME feed as an additive `collections` key
        // (plans/31 section 5), folded last so a member that lifecycle just
        // dropped is already absent from the ids it can reference. A
        // deployment with no collections serves a byte-identical index.
        return { composed: composeCollections(applyCredentialsToIndex(gated, creds), collections, groups), staleAt };
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
          result = { status: 'composed', bytes, etag: quoted(version), version, index: composed, providers };
          staleAt = s;
        } catch {
          // Not the expected shape: the route serves the file as it is, and
          // search falls back to the federated half alone.
          const fallback = composeOver({});
          const version = sha256Hex(raw).slice(0, 32);
          result = { status: 'raw', bytes: raw, etag: quoted(version), version, index: fallback.composed, providers };
          staleAt = fallback.staleAt;
        }
      } else {
        const { composed, staleAt: s } = composeOver({});
        const bytes = Buffer.from(JSON.stringify(composed));
        const version = sha256Hex(bytes).slice(0, 32);
        result = { status: 'missing', bytes, etag: quoted(version), version, index: composed, providers };
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
  const pagedFrom = (base: ServedIndex, key: string): ServedIndex => {
    if (base.status !== 'composed') return base;
    const large = new Map(base.providers.filter((p) => p.size > threshold).map((p) => [p.id, p]));
    if (!large.size) return base;
    const hit = paged.get(key);
    if (hit && hit.basedOn === base.version) {
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
    const bytes = Buffer.from(JSON.stringify(index));
    const version = sha256Hex(bytes).slice(0, 32);
    const result = withSort({ status: 'composed', bytes, etag: quoted(version), version, index, providers: base.providers });
    remember(paged, key, { basedOn: base.version, result });
    return result;
  };

  return {
    async forCaller({ groups, paged: wantPaged }) {
      const key = [...new Set(groups)].sort();
      const base = await full(key);
      return wantPaged ? pagedFrom(base, key.join('\n')) : base;
    },
    compositions: () => compositions,
  };
}
