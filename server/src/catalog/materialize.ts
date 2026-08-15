/**
 * The exit (plans/27 §5) — materialize a federated asset into the instance's
 * own BlobStore, and cut its identity over from ext/* to inst/*. Two consumers,
 * one machinery: *pin* keeps the ext identity (bytes go local so they survive
 * upstream deletion — hold-implies-pin), *exit* moves the identity to inst/* and
 * migrates every row/alias keyed on the old id. Deleting the provider afterwards
 * still deletes nothing — materialized copies are instance-owned.
 *
 * Idempotent per (provider, remoteId): the inst id is deterministic and blobs
 * overwrite, so a re-run resumes rather than duplicates.
 */
import { detectCredential } from './credentials.ts';
import { instanceAssetEntry, materializedIdFor, type InstanceAssetOrigin, type InstanceAssetRecord } from './instance-assets.ts';
import { mapProviderAsset, passesExposure, type Federation } from './federation.ts';
import { extAssetId, type ProviderAssetRef, type ProviderRecord } from './providers/types.ts';
import { readBlobBody, type BlobStore } from '../blobs/types.ts';
import type { Store } from '../store/types.ts';
import type { AssetIndexEntry } from './lifecycle.ts';

export interface MaterializeDeps {
  store: Store;
  blobs: BlobStore;
  federation: Federation;
  now?: () => number;
}

export interface MaterializeResult {
  id: string; // inst id
  extId: string;
  formats: number;
  bytes: number;
  credential: 'embedded' | 'none';
}

/** Descriptive entry fields that carry onto a materialized copy; the federated-
 *  identity fields (provider, thumbnail, upstream window) are dropped — the
 *  bytes are local now and the local lifecycle governs. */
function descriptiveBase(entry: AssetIndexEntry): Omit<AssetIndexEntry, 'id' | 'formats'> {
  const { id: _id, formats: _f, provider: _p, thumbnail: _t, availableFrom: _af, availableUntil: _au, ...base } = entry as Record<string, unknown>;
  return base as Omit<AssetIndexEntry, 'id' | 'formats'>;
}

async function materializeOne(deps: MaterializeDeps, rec: ProviderRecord, asset: ProviderAssetRef): Promise<MaterializeResult> {
  const nowIso = new Date(deps.now?.() ?? Date.now()).toISOString();
  const extId = extAssetId(rec.id, asset.remoteId);
  const instId = materializedIdFor(rec.id, asset.remoteId);
  const provider = deps.federation.instantiate(rec);
  const entry = mapProviderAsset(rec, asset);

  const blobs: Record<string, string> = {};
  const refMap: Record<string, string> = {};
  const formatStats: Array<{ format: string; size: number; checksum: string }> = [];
  const usedKeys = new Set<string>();
  let credential: 'embedded' | 'none' = 'none';
  let container: string | undefined;
  let totalBytes = 0;

  for (const f of asset.formats) {
    // Blobs, the served URL segment, and the refMap all key off the format name;
    // two formats sharing a name (e.g. a hi- and lo-res PNG) would collide, so
    // the second gets a suffixed key — no blob is ever overwritten.
    let key = f.format;
    for (let n = 2; usedKeys.has(key); n++) key = `${f.format}-${n}`;
    usedKeys.add(key);
    const resolved = await provider.resolveBlob(asset.remoteId, f.remoteRef);
    if (resolved.kind !== 'stream') throw new Error(`provider ${rec.id} serves ${f.format} by redirect; cannot materialize its bytes`);
    const buf = await readBlobBody(resolved.body);
    const blobId = `${instId}/${key}`;
    const stat = await deps.blobs.put(blobId, buf, resolved.contentType);
    const det = await detectCredential(buf);
    if (det.status === 'embedded' && credential !== 'embedded') { credential = 'embedded'; container = det.container; }
    blobs[key] = blobId;
    refMap[f.remoteRef] = key;
    formatStats.push({ format: key, size: stat.size, checksum: stat.checksum });
    totalBytes += stat.size;
  }

  const origin: InstanceAssetOrigin = {
    provider: rec.id, providerKind: rec.kind, remoteId: asset.remoteId,
    ...(asset.formats[0]?.filename ? { filename: asset.formats[0].filename } : {}),
    ...(asset.updatedAt ? { sourceUpdatedAt: asset.updatedAt } : {}),
    materializedAt: nowIso,
  };
  const record: InstanceAssetRecord = {
    id: instId,
    entry: instanceAssetEntry(instId, descriptiveBase(entry), formatStats),
    blobs,
    refMap,
    ...(rec.exposure.groups ? { groups: rec.exposure.groups } : {}),
    origin,
    createdAt: nowIso,
  };
  await deps.store.putInstanceAsset(record);
  // Credential detection is keyed by the ext id (the identity while pinned);
  // cutover re-keys it to the inst id along with lifecycle/holds.
  await deps.store.putCredential({
    assetId: extId, status: credential, ...(container ? { container } : {}),
    sniffedAt: nowIso, ...(asset.updatedAt ? { sourceUpdatedAt: asset.updatedAt } : {}),
  });
  return { id: instId, extId, formats: formatStats.length, bytes: totalBytes, credential };
}

/** Materialize a provider's assets — all of them, or one `remoteId`, or a
 *  `section`. Iterates `listAssets` directly (not the MAX_PAGES-capped fragment),
 *  applying the same exposure slice federation does. */
export async function materializeProvider(
  deps: MaterializeDeps,
  rec: ProviderRecord,
  filter: { remoteId?: string; section?: string } = {},
): Promise<{ results: MaterializeResult[]; skipped: number; errors: Array<{ remoteId: string; error: string }> }> {
  const provider = deps.federation.instantiate(rec);
  const results: MaterializeResult[] = [];
  const errors: Array<{ remoteId: string; error: string }> = [];
  const seen = new Set<string>();
  let skipped = 0;
  let cursor: string | undefined;
  do {
    const batch = await provider.listAssets(cursor);
    for (const a of batch.assets) {
      if (seen.has(a.remoteId)) continue;
      seen.add(a.remoteId);
      if (filter.remoteId && a.remoteId !== filter.remoteId) continue;
      if (filter.section && !a.sections.includes(filter.section)) continue;
      if (!passesExposure(rec, a)) { skipped++; continue; }
      // One asset's failure (a redirect-served format, an upstream hiccup) must
      // not abort the batch or lose the audit for what already succeeded — it is
      // idempotent, so a re-run resumes. Collect the error and keep going.
      try {
        results.push(await materializeOne(deps, rec, a));
      } catch (err) {
        errors.push({ remoteId: a.remoteId, error: (err as Error).message });
      }
    }
    cursor = batch.next;
  } while (cursor);
  return { results, skipped, errors };
}

/** Best-effort pin of ONE federated asset (hold-implies-pin, plans/27 §3): keep
 *  the ext identity, put the bytes local. Returns whether a copy now exists. */
export async function pinAsset(deps: MaterializeDeps, rec: ProviderRecord, remoteId: string): Promise<boolean> {
  const { results } = await materializeProvider(deps, rec, { remoteId });
  return results.length > 0;
}

/** Materialize ONE already-resolved asset ref (plans/30 §3.1 — search-and-import):
 *  apply the exposure slice, then snapshot its bytes into inst/* exactly as
 *  materializeProvider does per asset. Unlike materializeProvider it does NOT scan
 *  listAssets — the caller supplies the ref (from getAsset or a search result), so a
 *  search-only asset can be pinned. Idempotent via the deterministic inst id. */
export async function materializeAsset(deps: MaterializeDeps, rec: ProviderRecord, asset: ProviderAssetRef): Promise<MaterializeResult> {
  if (!passesExposure(rec, asset)) throw new Error(`asset ${asset.remoteId} is excluded by this provider's exposure slice`);
  return materializeOne(deps, rec, asset);
}

/** Cut a provider over: migrate lifecycle (incl. hold), credential rows, and
 *  asset-specific grants keyed on each old ext id to the new inst id, and alias
 *  the old blob URLs so already-rendered SVGs keep resolving. The caller
 *  (owner-gated route) disables the provider afterwards. */
export async function cutoverProvider(deps: MaterializeDeps, rec: ProviderRecord): Promise<{ migrated: number }> {
  const insts = (await deps.store.listInstanceAssets()).filter((r) => r.origin?.provider === rec.id);
  const grants = await deps.store.listGrants();
  for (const inst of insts) {
    const remoteId = inst.origin?.remoteId;
    if (!remoteId) continue;
    const extId = extAssetId(rec.id, remoteId);

    // Commit the identity change: from here the inst entry substitutes for the
    // ext one in the feed and carries its own lifecycle row (plans/27 §5). The
    // rows MOVE to the inst id — copy then delete the source — so a stale ext-
    // keyed row can't linger and shadow the retired identity.
    if (!inst.exited) await deps.store.putInstanceAsset({ ...inst, exited: true });
    const lc = await deps.store.getLifecycle(extId);
    if (lc) { await deps.store.putLifecycle({ ...lc, assetId: inst.id }); await deps.store.deleteLifecycle(extId); }
    const cr = await deps.store.getCredential(extId);
    if (cr) { await deps.store.putCredential({ ...cr, assetId: inst.id }); await deps.store.deleteCredential(extId); }
    for (const g of grants) {
      if (g.resource === `catalog:${extId}`) {
        await deps.store.putGrant({ ...g, resource: `catalog:${inst.id}` });
        await deps.store.deleteGrant(g);
      }
    }

    // Aliases keep old /catalog/ext/... URLs resolving: the asset id itself and
    // every format's blob path map to the new inst identity.
    await deps.store.putAlias(extId, inst.id);
    for (const [remoteRef, fmt] of Object.entries(inst.refMap ?? {})) {
      await deps.store.putAlias(`${extId}/${remoteRef}`, `${inst.id}/${fmt}`);
    }
  }
  return { migrated: insts.length };
}
