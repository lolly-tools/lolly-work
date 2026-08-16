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
/** Hard page cap per sync - a runaway upstream can't wedge a request cycle.
 *  100/page (driver-side) × 50 pages = 5k assets; log-worthy when hit. */
const MAX_PAGES = 50;

export function mapProviderAsset(rec: ProviderRecord, asset: ProviderAssetRef): AssetIndexEntry {
  const type = rec.mapping.typeMap?.[asset.nativeType] ?? rec.mapping.defaultType ?? 'image';
  const sectionTags = rec.mapping.sectionTags === false ? [] : asset.sections;
  const idPath = extAssetId(rec.id, asset.remoteId);
  return {
    id: idPath,
    name: asset.name,
    ...(asset.description ? { description: asset.description } : {}),
    type,
    ...(rec.exposure.tier ? { tier: rec.exposure.tier } : {}),
    tags: [...new Set([`provider:${rec.id}`, ...sectionTags, ...asset.tags])],
    provider: rec.id,
    ...(asset.updatedAt ? { updatedAt: asset.updatedAt } : {}),
    ...(asset.availableFrom ? { availableFrom: asset.availableFrom } : {}),
    ...(asset.availableUntil ? { availableUntil: asset.availableUntil } : {}),
    ...(asset.hasThumbnail ? { thumbnail: `/catalog/${idPath}/thumb` } : {}),
    formats: asset.formats.map((f) => ({
      format: f.format,
      url: `/catalog/${idPath}/${f.remoteRef}`,
      ...(f.size !== undefined ? { size: f.size } : {}),
      ...(f.filename ? { filename: f.filename } : {}),
    })),
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

export async function buildFragment(rec: ProviderRecord, provider: CatalogProvider, now: () => number): Promise<ProviderFragment> {
  const assets: AssetIndexEntry[] = [];
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const batch = await provider.listAssets(cursor);
    for (const a of batch.assets) {
      if (passesExposure(rec, a)) assets.push(mapProviderAsset(rec, a));
    }
    if (!batch.next) break;
    cursor = batch.next;
  }
  return { assets, syncedAt: new Date(now()).toISOString(), hash: sha256Hex(canonicalJson(assets)).slice(0, 16) };
}

export interface FederationDeps extends ProviderDeps {
  store: Store;
  /** Master key for sealed credentials (secrets.credential) - absent is fine
   *  until a db-managed provider actually stores one. */
  credentialSecret?: string;
  /** Config-managed providers' credentials, resolved from env at boot. */
  configSecrets?: Map<string, string>;
  now?: () => number;
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
  fragments(): Promise<Array<{ rec: ProviderRecord; fragment: ProviderFragment; stale: boolean }>>;
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
      const fragment = await buildFragment(rec, instantiate(rec), now);
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
      await deps.store.putProviderState(rec.id, {
        ...(rec.state.lastSyncAt ? { lastSyncAt: rec.state.lastSyncAt } : {}),
        lastError: (err as Error).message,
        assetCount: rec.state.assetCount,
        ...(rec.state.fragment ? { fragment: rec.state.fragment } : {}),
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
    const out: Array<{ rec: ProviderRecord; fragment: ProviderFragment; stale: boolean }> = [];
    for (const rec of await deps.store.listProviders()) {
      if (!rec.enabled) continue;
      const ttlMs = (rec.sync.ttlSeconds ?? DEFAULT_TTL_SECONDS) * 1000;
      const cached = cache.get(rec.id);
      if (cached) {
        if (now() - cached.fetchedAt > ttlMs) refreshInBackground(rec);
        out.push({ rec, fragment: cached.fragment, stale: cached.stale });
        continue;
      }
      // Cold cache: last-good from the store if it has one (serve stale,
      // refresh behind), else a blocking first sync (best-effort).
      if (rec.state.fragment) {
        cache.set(rec.id, { fragment: rec.state.fragment, fetchedAt: 0, stale: true });
        refreshInBackground(rec);
        out.push({ rec, fragment: rec.state.fragment, stale: true });
        continue;
      }
      try {
        out.push({ rec, fragment: await sync(rec), stale: false });
      } catch {
        // Never built successfully and upstream is down: nothing to serve yet.
      }
    }
    return out;
  };

  return {
    resolveSecret,
    instantiate,
    sync,
    fragments,
    async composeIndex(index, callerGroups) {
      const frags = (await fragments()).filter(({ rec }) => callerSeesProvider(rec, callerGroups));
      if (!frags.length) return index;
      const assets = [...(index.assets ?? []), ...frags.flatMap((f) => f.fragment.assets)];
      const staleProviders = frags.filter((f) => f.stale).map((f) => f.rec.id);
      return { ...index, assets, ...(staleProviders.length ? { staleProviders } : {}) };
    },
    async version() {
      const frags = await fragments();
      if (!frags.length) return '';
      return sha256Hex(frags.map((f) => `${f.rec.id}:${f.fragment.hash}`).join('|')).slice(0, 16);
    },
    async availabilityWindow(assetId) {
      if (!assetId.startsWith(EXT_PREFIX)) return undefined;
      for (const { rec, fragment } of await fragments()) {
        if (!assetId.startsWith(`${EXT_PREFIX}${rec.id}/`)) continue;
        const entry = fragment.assets.find((a) => a.id === assetId);
        return entry ? entryWindow(entry) : undefined;
      }
      return undefined;
    },
    invalidate(providerId) {
      cache.delete(providerId);
    },
  };
}
