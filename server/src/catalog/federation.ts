/**
 * Catalog federation (plans/17 §7) - folds enabled providers' assets into the
 * served feed. Request-driven like everything else: each provider has an
 * in-process fragment cache with a TTL; an expired fragment is served as-is
 * while a background refresh runs (stale-while-revalidate), and the last
 * successful fragment is persisted to the store so a cold boot or provider
 * outage still serves something ("stale", never a 500).
 *
 * Exposure governance (plans/17 §6) is applied in two places: slice filters
 * (requireApproved / includeSections / excludeTags) at fragment-build time - 
 * excluded assets never enter the feed or the store - and group visibility at
 * compose time, per caller.
 */
import { canonicalJson, openSecret, sha256Hex } from '../lib/crypto.ts';
import { EXT_PREFIX, extAssetId, type CatalogProvider, type ProviderAssetRef, type ProviderFragment, type ProviderRecord } from './providers/types.ts';
import { createProvider, type ProviderDeps } from './providers/registry.ts';
import { entryWindow, type AssetIndex, type AssetIndexEntry, type AvailabilityWindow } from './lifecycle.ts';
import type { Store } from '../store/types.ts';

/** HKDF domain-separation context for a provider's sealed credential. */
export function credentialContext(providerId: string): string {
  return `catalog-provider-credential:${providerId}`;
}

const DEFAULT_TTL_SECONDS = 300;
/** Most assets one provider federates unless its `sync.maxAssets` or the
 *  instance's `catalogServing.maxProviderAssets` says otherwise. Large enough
 *  for a real DAM estate; a walk that stops here says so on the fragment. */
export const DEFAULT_MAX_PROVIDER_ASSETS = 100_000;
/** Cold providers synced at once when the feed finds several with no cached
 *  fragment (a fresh boot): enough to overlap slow upstreams, few enough that
 *  a large estate does not open a connection per provider. */
const COLD_SYNC_CONCURRENCY = 3;

/**
 * The page ceiling for one walk, derived from the asset cap: a driver that
 * keeps answering with `next` but few or no assets (a runaway upstream) still
 * stops. Twenty assets a page on average is well under every driver's page
 * size, so an honest walk reaches the asset cap first.
 */
export function pageCeiling(maxAssets: number): number {
  return Math.max(50, Math.ceil(maxAssets / 20));
}

/** Use file formats when a DAM reports a broad native type such as generic_files. */
export function providerAssetType(asset: ProviderAssetRef): string {
  if (asset.formats.some(format => /^(3mf|stl|glb|gltf)$/i.test(format.format))) return 'model';
  const types: Record<string, string> = {
    svg: 'vector',
    png: 'raster', jpg: 'raster', jpeg: 'raster', webp: 'raster', gif: 'raster',
    avif: 'raster', heic: 'raster', heif: 'raster', tiff: 'raster', tif: 'raster', jxl: 'raster',
    mp4: 'video', webm: 'video', mov: 'video', m4v: 'video',
    mp3: 'audio', wav: 'audio', ogg: 'audio', flac: 'audio', m4a: 'audio', aac: 'audio',
    otf: 'font', ttf: 'font', woff: 'font', woff2: 'font',
    glb: 'model', gltf: 'model', stl: 'model', '3mf': 'model', cube: 'lut', txt: 'text', md: 'text', srt: 'text',
  };
  for (const format of asset.formats) {
    const type = types[format.format.toLowerCase()];
    if (type) return type;
  }
  return 'data';
}

export function mapProviderAsset(rec: ProviderRecord, asset: ProviderAssetRef): AssetIndexEntry {
  const mappedType = rec.mapping.typeMap?.[asset.nativeType] ?? rec.mapping.defaultType;
  const type = mappedType === undefined || mappedType === 'image' ? providerAssetType(asset) : mappedType;
  const sectionTags = rec.mapping.sectionTags === false ? [] : asset.sections;
  const idPath = extAssetId(rec.id, asset.remoteId);
  return {
    id: idPath,
    name: asset.name,
    ...(asset.description ? { description: asset.description } : {}),
    type,
    version: sha256Hex(canonicalJson({ updatedAt: asset.updatedAt ?? null, formats: asset.formats })).slice(0, 16),
    tier: rec.exposure.tier ?? 'on-demand',
    tags: [...new Set([`provider:${rec.id}`, ...sectionTags, ...asset.tags])],
    provider: rec.id,
    meta: {
      providerLabel: rec.label,
      providerSections: asset.sections,
      providerCollections: asset.collections ?? [],
      ...(asset.taxonomy ? { providerTaxonomy: asset.taxonomy } : {}),
      providerTags: asset.tags,
      assetFiles: asset.formats.filter((f, i, all) => f.format !== 'thumb' && all.findIndex(other => other.remoteRef === f.remoteRef) === i).map(f => ({
        id: sha256Hex(f.remoteRef).slice(0, 24), format: f.format,
        url: `/catalog/${idPath}/${f.remoteRef}`, name: f.filename ?? `${asset.name}.${f.format}`,
        ...(f.size !== undefined ? { size: f.size } : {}),
        ...(f.width !== undefined ? { width: f.width } : {}), ...(f.height !== undefined ? { height: f.height } : {}),
        ...(rec.kind === 'brandfolder' ? { thumbnail: `/catalog/${idPath}/${f.remoteRef}?preview=1` } : {}),
      })),
    },
    ...(asset.updatedAt ? { updatedAt: asset.updatedAt } : {}),
    ...(asset.availableFrom ? { availableFrom: asset.availableFrom } : {}),
    ...(asset.availableUntil ? { availableUntil: asset.availableUntil } : {}),
    ...(asset.hasThumbnail ? { thumbnail: `/catalog/${idPath}/thumb` } : {}),
    formats: [...asset.formats.map((f) => ({
      format: f.format,
      url: `/catalog/${idPath}/${f.remoteRef}`,
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.filename ? { filename: f.filename } : {}),
      ...(f.width !== undefined ? { width: f.width } : {}), ...(f.height !== undefined ? { height: f.height } : {}),
    })), ...(asset.hasThumbnail ? [{ format: 'thumb', url: `/catalog/${idPath}/thumb` }] : [])],
  };
}

/** Slice filters - the provider-side subset an admin chose to federate.
 *  Exported because live search results must pass the same gate as synced
 *  fragments (plans/17 §9). */
export function passesExposure(rec: ProviderRecord, asset: ProviderAssetRef): boolean {
  const exp = rec.exposure;
  if (exp.requireApproved && asset.approved !== true) return false;
  if (exp.includeSections?.length && !asset.sections.some((s) => exp.includeSections?.includes(s))) return false;
  if (exp.excludeTags?.length && asset.tags.some((t) => exp.excludeTags?.includes(t))) return false;
  return true;
}

/** Group visibility - whether this caller sees the provider's assets at all. */
export function callerSeesProvider(rec: ProviderRecord, callerGroups: string[]): boolean {
  const groups = rec.exposure.groups;
  if (!groups || groups === '*') return true;
  return groups.some((g) => callerGroups.includes(g));
}

/** The asset cap for one provider: its own `sync.maxAssets` when that is a
 *  positive whole number, else the instance default. */
export function maxAssetsFor(rec: ProviderRecord, instanceDefault = DEFAULT_MAX_PROVIDER_ASSETS): number {
  const own = rec.sync?.maxAssets;
  return typeof own === 'number' && Number.isInteger(own) && own > 0 ? own : instanceDefault;
}

export async function buildFragment(
  rec: ProviderRecord, provider: CatalogProvider, now: () => number,
  opts: { maxAssets?: number } = {},
): Promise<ProviderFragment> {
  const assets: AssetIndexEntry[] = [];
  // What the driver could not map, and what it wants the operator to know
  // (plans/33 §5): a sync that quietly federates none of a full page is the
  // failure most likely to cost an afternoon, so both travel with the fragment.
  let skipped = 0;
  const notes: string[] = [];
  const maxAssets = maxAssetsFor(rec, opts.maxAssets);
  const maxPages = pageCeiling(maxAssets);
  // A cap that stops the walk with more upstream left is never silent: the
  // fragment carries `truncated` and a note the sources view and the sync
  // result both show, naming the setting that moves the cap.
  let truncated = false;
  let cursor: string | undefined;
  for (let page = 0; ; page++) {
    if (page >= maxPages) {
      truncated = true;
      notes.push(`Stopped after ${maxPages} pages with more left upstream; the provider kept returning pages with few assets. Raise sync.maxAssets if this source really holds more.`);
      break;
    }
    const batch = await provider.listAssets(cursor);
    for (const a of batch.assets) {
      if (!passesExposure(rec, a)) continue;
      if (assets.length >= maxAssets) {
        truncated = true;
        break;
      }
      assets.push(mapProviderAsset(rec, a));
    }
    skipped += batch.skipped ?? 0;
    for (const n of batch.notes ?? []) if (!notes.includes(n)) notes.push(n);
    if (!truncated && assets.length >= maxAssets && batch.next) truncated = true;
    if (truncated) {
      notes.push(`Stopped after ${maxAssets} assets with more left upstream. Raise sync.maxAssets on this provider (or catalogServing.maxProviderAssets for the instance) to federate more.`);
      break;
    }
    if (!batch.next) break;
    cursor = batch.next;
  }
  return {
    assets,
    syncedAt: new Date(now()).toISOString(),
    hash: sha256Hex(canonicalJson(assets)).slice(0, 16),
    ...(skipped ? { skipped } : {}),
    ...(notes.length ? { notes } : {}),
    ...(truncated ? { truncated: true } : {}),
  };
}

export interface FragmentView { rec: ProviderRecord; fragment: ProviderFragment; stale: boolean }

/**
 * Append the caller-visible fragments onto a served index. Pure, so the served
 * feed (served-index.ts) can fingerprint the exact fragments it composes from
 * instead of asking the federation twice. `exclude` leaves named providers out
 * of `assets` (the paged feed lists them separately).
 */
export function composeFederated(
  index: AssetIndex, frags: FragmentView[], callerGroups: string[], exclude?: ReadonlySet<string>,
): AssetIndex {
  const visible = frags.filter(({ rec }) => callerSeesProvider(rec, callerGroups));
  if (!visible.length) return index;
  const included = exclude?.size ? visible.filter((f) => !exclude.has(f.rec.id)) : visible;
  const assets = [...(index.assets ?? []), ...included.flatMap((f) => f.fragment.assets)];
  const staleProviders = visible.filter((f) => f.stale).map((f) => f.rec.id);
  return { ...index, assets, ...(staleProviders.length ? { staleProviders } : {}) };
}

/** Run `tasks` with at most `limit` in flight, results in input order. */
async function boundedAll<T>(tasks: Array<() => Promise<T>>, limit: number): Promise<T[]> {
  const out = new Array<T>(tasks.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < tasks.length) {
      const i = next++;
      out[i] = await (tasks[i] as () => Promise<T>)();
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return out;
}

export interface FederationDeps extends ProviderDeps {
  store: Store;
  /** Master key for sealed credentials (secrets.credential) - absent is fine
   *  until a db-managed provider actually stores one. */
  credentialSecret?: string;
  /** Config-managed providers' credentials, resolved from env at boot. */
  configSecrets?: Map<string, string>;
  now?: () => number;
  /** Instance default asset cap per provider (`catalogServing.maxProviderAssets`). */
  maxProviderAssets?: number;
}

export interface Federation {
  /** Plaintext credential for a provider (memory only, never serialized). */
  resolveSecret(rec: ProviderRecord): string | undefined;
  /** Driver instance for a record. */
  instantiate(rec: ProviderRecord): CatalogProvider;
  /** Eager refresh: build + persist + cache a provider's fragment. Throws on
   *  driver failure (after recording lastError). */
  sync(rec: ProviderRecord): Promise<ProviderFragment>;
  /** Enabled providers' fragments for feed composition - cached, refreshed in
   *  the background past TTL, last-good on failure. Never throws. */
  fragments(): Promise<FragmentView[]>;
  /** Append caller-visible federated entries onto a served index. */
  composeIndex(index: AssetIndex, callerGroups: string[]): Promise<AssetIndex>;
  /** Combined fragment hash - folded into catalogVersion so provider refreshes
   *  invalidate renders like a pack change. */
  version(): Promise<string>;
  /** Imported upstream availability window for a federated asset id, read off
   *  its cached fragment entry - the ext/* blob gate combines it most-
   *  restrictive-wins with the local lifecycle row (plans/27 §2). Undefined for
   *  a pack id, an unknown id, or a provider with no availability API. */
  availabilityWindow(assetId: string): Promise<AvailabilityWindow | undefined>;
  /** The cached fragment entry for a federated asset id (its formats and
   *  version), or undefined. A map lookup, built once per fragment. */
  entry(assetId: string): Promise<AssetIndexEntry | undefined>;
  /** Drop a provider's cached fragment (disable/delete/credential change). */
  invalidate(providerId: string): void;
}

export function createFederation(deps: FederationDeps): Federation {
  const now = deps.now ?? Date.now;
  const cache = new Map<string, { fragment: ProviderFragment; fetchedAt: number; stale: boolean }>();
  const inflight = new Map<string, Promise<void>>();

  const resolveSecret = (rec: ProviderRecord): string | undefined => {
    if (rec.managedBy === 'config') return deps.configSecrets?.get(rec.id);
    if (!rec.credentialCiphertext) return undefined;
    if (!deps.credentialSecret) throw new Error('LW_CREDENTIAL_SECRET is not set but a stored credential exists');
    return openSecret(rec.credentialCiphertext, deps.credentialSecret, credentialContext(rec.id));
  };

  const instantiate = (rec: ProviderRecord): CatalogProvider =>
    createProvider(rec, resolveSecret(rec), { ...(deps.fetchImpl ? { fetchImpl: deps.fetchImpl } : {}) });

  const sync = async (rec: ProviderRecord): Promise<ProviderFragment> => {
    try {
      const fragment = await buildFragment(rec, instantiate(rec), now, deps.maxProviderAssets ? { maxAssets: deps.maxProviderAssets } : {});
      cache.set(rec.id, { fragment, fetchedAt: now(), stale: false });
      await deps.store.putProviderState(rec.id, {
        lastSyncAt: fragment.syncedAt,
        assetCount: fragment.assets.length,
        fragment,
      });
      return fragment;
    } catch (err) {
      const prev = cache.get(rec.id);
      if (prev) cache.set(rec.id, { ...prev, stale: true });
      const state = (await deps.store.getProvider(rec.id))?.state ?? rec.state;
      const lastGood = state.fragment ?? prev?.fragment;
      await deps.store.putProviderState(rec.id, {
        ...(state.lastSyncAt ? { lastSyncAt: state.lastSyncAt } : {}),
        lastError: (err as Error).message,
        assetCount: state.assetCount,
        ...(lastGood ? { fragment: lastGood } : {}),
      });
      throw err;
    }
  };

  const refreshInBackground = (rec: ProviderRecord): void => {
    if (inflight.has(rec.id)) return;
    const p = sync(rec).then(() => undefined, () => undefined).finally(() => inflight.delete(rec.id));
    inflight.set(rec.id, p);
  };

  const fragments: Federation['fragments'] = async () => {
    // Slots keep the store's provider order (the feed's asset order) while the
    // cold ones load concurrently, a few at a time.
    const slots: Array<FragmentView | null> = [];
    const cold: Array<() => Promise<void>> = [];
    for (const listed of await deps.store.listProviders({ includeFragment: false })) {
      if (!listed.enabled) continue;
      const ttlMs = (listed.sync.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
      const cached = cache.get(listed.id);
      if (cached) {
        if (now() - cached.fetchedAt > ttlMs) refreshInBackground(listed);
        slots.push({ rec: listed, fragment: cached.fragment, stale: cached.stale });
        continue;
      }
      const slot = slots.push(null) - 1;
      cold.push(async () => {
        // Only a cold fragment cache needs its persisted index. Recheck the
        // provider after the second read in case it was disabled or removed.
        const rec = await deps.store.getProvider(listed.id);
        if (!rec?.enabled) return;
        // Cold cache: last-good from the store if it has one (serve stale,
        // refresh behind), else a blocking first sync (best-effort).
        if (rec.state.fragment) {
          cache.set(rec.id, { fragment: rec.state.fragment, fetchedAt: 0, stale: true });
          refreshInBackground(rec);
          slots[slot] = { rec, fragment: rec.state.fragment, stale: true };
          return;
        }
        try {
          slots[slot] = { rec, fragment: await sync(rec), stale: false };
        } catch {
          // Never built successfully and upstream is down: nothing to serve yet.
        }
      });
    }
    if (cold.length) await boundedAll(cold, COLD_SYNC_CONCURRENCY);
    return slots.filter((s): s is FragmentView => s !== null);
  };

  // Id lookups into a fragment, built on first use and dropped with the fragment.
  const entryMaps = new WeakMap<ProviderFragment, Map<string, AssetIndexEntry>>();
  const entryIn = (fragment: ProviderFragment, assetId: string): AssetIndexEntry | undefined => {
    let map = entryMaps.get(fragment);
    if (!map) {
      map = new Map(fragment.assets.map((a) => [a.id, a]));
      entryMaps.set(fragment, map);
    }
    return map.get(assetId);
  };
  const entry = async (assetId: string): Promise<AssetIndexEntry | undefined> => {
    if (!assetId.startsWith(EXT_PREFIX)) return undefined;
    for (const { rec, fragment } of await fragments()) {
      if (!assetId.startsWith(`${EXT_PREFIX}${rec.id}/`)) continue;
      return entryIn(fragment, assetId);
    }
    return undefined;
  };

  return {
    resolveSecret,
    instantiate,
    sync,
    fragments,
    async composeIndex(index, callerGroups) {
      return composeFederated(index, await fragments(), callerGroups);
    },
    async version() {
      const frags = await fragments();
      if (!frags.length) return '';
      return sha256Hex(frags.map((f) => `${f.rec.id}:${f.fragment.hash}`).join('|')).slice(0, 16);
    },
    async availabilityWindow(assetId) {
      const found = await entry(assetId);
      return found ? entryWindow(found) : undefined;
    },
    entry,
    invalidate(providerId) {
      cache.delete(providerId);
    },
  };
}
