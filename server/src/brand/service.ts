import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join } from 'node:path';
import type { Store, UserRecord } from '../store/types.ts';
import type { InstanceConfig } from '../config/instance.ts';
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import { evaluate, type Role } from '../rbac/evaluate.ts';
import { canonicalJson } from '../lib/crypto.ts';
import { inspectInstancePack, instancePackTokensChecksum, PACK_BLOB_ID, PACK_META_BLOB_ID, type InstancePackMeta } from '../catalog/instance-pack.ts';
import { createBrandSources, describeSource, type BrandSource } from './sources.ts';
import type { BrandState } from './state.ts';

export type BrandAction = 'select' | 'retire' | 'restore' | 'stop-download' | 'enable-download';
export interface BrandChange { action: BrandAction; sourceId: string; replacementId?: string }
export interface BrandSnapshot { state: BrandState; source: BrandSource; revision: string }
export class BrandError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status = 409, code = 'BRAND_CHANGE_REFUSED') { super(message); this.status = status; this.code = code; }
}
const digest = (value: unknown) => createHash('sha256').update(canonicalJson(value)).digest('hex');
const actions: BrandAction[] = ['select', 'retire', 'restore', 'stop-download', 'enable-download'];
export function parseBrandChange(value: unknown): BrandChange {
  const input = value as Partial<BrandChange> | null;
  if (!input || !actions.includes(input.action!) || typeof input.sourceId !== 'string' || input.sourceId.length > 200
    || (input.replacementId !== undefined && typeof input.replacementId !== 'string')) {
    throw new BrandError('An action and sourceId are required', 400, 'INVALID_INPUT');
  }
  return { action: input.action!, sourceId: input.sourceId, ...(input.replacementId ? { replacementId: input.replacementId } : {}) };
}

/** One service owns compatibility routes, previews, mutations and request snapshots. */
export function createBrandService(config: InstanceConfig, store: Store, blobs: BlobStore) {
  const adapter = createBrandSources(config.instance.pack, config.instance.brandTokens);
  const context = new AsyncLocalStorage<BrandSnapshot>();
  const mutable = store.brandPersistence === 'durable' || config.dev.enabled;
  const snapshot = async (): Promise<BrandSnapshot> => {
    const [state, inventory] = await Promise.all([store.getBrandState(), adapter.inventory()]);
    const id = state.activeSource ?? inventory.defaultId;
    const source = (!state.retired.includes(id) && inventory.sources.find(s => s.id === id)) || await adapter.unavailable(id);
    return { state, source, revision: `${state.revision}:${source.revision}` };
  };
  const current = () => context.getStore();
  const allowed = async (actor: UserRecord, action: string): Promise<boolean> => evaluate(
    { userId: actor.id, role: actor.role as Role, groups: actor.groups }, action, ['*'], await store.listGrants(),
  );
  const requirePermissions = async (actor: UserRecord, change: BrandChange, snap: BrandSnapshot) => {
    const required = change.action === 'select' ? ['brand.switch'] : ['instance.config'];
    if (change.action === 'retire' && change.sourceId === snap.source.id) required.push('brand.switch');
    for (const action of required) if (!await allowed(actor, action)) throw new BrandError(`${action} required`, 403, 'FORBIDDEN');
    return required;
  };
  const downloadVisible = (snap: BrandSnapshot) => {
    const d = snap.state.download;
    return !d.suppressed && !!d.blobId && d.sourceId === snap.source.id && d.sourceRevision === snap.source.revision;
  };
  const inventory = async (actor: UserRecord) => {
    const snap = await snapshot(), found = await adapter.inventory();
    const canSwitch = mutable && await allowed(actor, 'brand.switch');
    const canManage = mutable && await allowed(actor, 'instance.config');
    const installed = found.sources.some(s => s.id === snap.source.id) ? found.sources : [...found.sources, snap.source];
    const sources: Array<Record<string, unknown>> = installed.map(source => ({ ...describeSource(source),
      active: source.id === snap.source.id, retired: snap.state.retired.includes(source.id),
      operations: { select: canSwitch && source.id !== snap.source.id && !snap.state.retired.includes(source.id) && !source.diagnostics.length,
        retire: canManage && (source.id !== snap.source.id || canSwitch) && !snap.state.retired.includes(source.id), restore: canManage && snap.state.retired.includes(source.id) },
    }));
    sources.push({ id: 'download', kind: 'download', label: 'Connect download', active: downloadVisible(snap),
      suppressed: snap.state.download.suppressed, sourceId: snap.state.download.sourceId,
      version: snap.state.download.meta?.version ?? null, revision: snap.state.download.meta?.checksum ?? null,
      operations: { 'stop-download': canManage && !snap.state.download.suppressed,
        'enable-download': canManage && snap.state.download.suppressed && !!snap.state.download.blobId
          && snap.state.download.sourceId === snap.source.id && snap.state.download.sourceRevision === snap.source.revision },
    });
    for (const provider of await store.listProviders()) {
      if (Array.isArray(provider.exposure.groups) && provider.exposure.groups.length && !provider.exposure.groups.some(g => actor.groups.includes(g)) && !await allowed(actor, 'instance.config')) continue;
      sources.push({ id: `provider:${provider.id}`, kind: 'provider', label: provider.label, active: provider.enabled,
        operations: {}, diagnostics: ['Provider assets are governed through Sources. They do not select the mounted design system.'] });
    }
    return { available: found.profilesAvailable, active: found.profilesAvailable ? snap.source.name : null,
      profiles: found.sources.filter(s => s.kind === 'profile' && !snap.state.retired.includes(s.id)).map(s => ({ name: s.name, active: s.id === snap.source.id })),
      activeSource: snap.source.id, revision: snap.state.revision, contentRevision: snap.revision,
      persistence: store.brandPersistence, mutable, sources,
      limitation: mutable ? (store.brandPersistence === 'ephemeral' ? 'Development changes last only while this process runs.' : null)
        : 'This deployment cannot persist administrator changes. Configure Postgres or update the mounted source and redeploy.',
    };
  };
  const preview = async (actor: UserRecord, change: BrandChange) => {
    const snap = await snapshot(), found = await adapter.inventory();
    const requiredPermissions = await requirePermissions(actor, change, snap);
    const blockers: string[] = [];
    if (!mutable) blockers.push('Durable storage is required outside development mode. Update the deployment source and redeploy.');
    const source = found.sources.find(s => s.id === change.sourceId) ?? (snap.source.id === change.sourceId ? snap.source : undefined);
    const downloadAction = change.action === 'stop-download' || change.action === 'enable-download';
    if (downloadAction ? change.sourceId !== 'download' : !source) throw new BrandError('Unknown source', 404, 'NOT_FOUND');
    let replacement = change.action === 'select' ? source : snap.source;
    if (change.action === 'retire' && source?.id === snap.source.id) {
      replacement = found.sources.find(s => s.id === change.replacementId);
      if (!replacement || replacement.id === source.id) blockers.push('Select a different installed design system before retiring the active source.');
    }
    if (replacement && replacement.id !== snap.source.id) {
      if (snap.state.retired.includes(replacement.id)) blockers.push('The replacement is retired. Restore it before selecting it.');
      blockers.push(...replacement.diagnostics);
    }
    if (change.action === 'select' && source && snap.state.retired.includes(source.id)) blockers.push('Restore this source before selecting it.');
    if (change.action === 'enable-download') {
      const d = snap.state.download;
      if (!d.blobId || d.sourceId !== snap.source.id || d.sourceRevision !== snap.source.revision) blockers.push('Upload a pack for the active source before enabling the download.');
    }
    const incoming = replacement ?? snap.source;
    const removedAssets = snap.source.assets.filter(a => !incoming.assets.some(b => b.id === a.id)).map(a => a.id);
    const removedTools = snap.source.toolIds.filter(id => !incoming.toolIds.includes(id));
    const sharedAssets = snap.source.assets.filter(a => incoming.assets.some(b => b.id === a.id)).map(a => a.id);
    const changedAssets = sharedAssets.filter(id => snap.source.assetRevisions[id] !== incoming.assetRevisions[id]);
    const references = (value: unknown) => { const json = JSON.stringify(value); return [...removedAssets, ...changedAssets].some(id => json.includes(id)) || removedTools.some(id => json.includes(id)); };
    const [sessions, links, published] = await Promise.all([store.listSessionsFiltered({}), store.listAllLinks(), store.listInstanceAssets()]);
    const versions = (await Promise.all(published.map(asset => store.listAssetVersions(asset.id)))).flat();
    const impact = {
      from: { id: snap.source.id, label: snap.source.label }, to: { id: incoming.id, label: incoming.label },
      removedAssets, removedTools, sharedAssets, changedAssets,
      tokens: { from: snap.source.tokensHead, to: incoming.tokensHead },
      removedLogos: snap.source.assets.filter(a => removedAssets.includes(a.id) && Array.isArray(a.tags) && a.tags.includes('logo')).map(a => a.id),
      affectedSessions: sessions.filter(s => references([s.inputs, s.meta, s.toolId])).length,
      affectedLinks: links.filter(l => references(l.target)).length,
      publishedAssets: published.filter(p => references(p)).length,
      publishedVersions: versions.filter(v => references(v)).length,
      downloadWithdrawn: downloadVisible(snap) && (incoming.id !== snap.source.id || change.action === 'stop-download'),
      sourceFilesDeleted: false, personalWorkDeleted: false,
      limits: ['Offline copies and private device documents cannot be enumerated.', 'References are counted from server metadata, including published versions. Embedded binary content is not inspected; source files and saved work are retained.'],
    };
    const result = { change, revision: snap.state.revision, sourceRevision: snap.revision, requiredPermissions, blockers, impact };
    return { ...result, reviewToken: digest(result) };
  };
  const apply = async (actor: UserRecord, change: BrandChange, revision: number, reviewToken: string) => {
    const reviewed = await preview(actor, change);
    if (reviewed.revision !== revision || reviewed.reviewToken !== reviewToken) throw new BrandError('The preview is stale. Review the change again.', 409, 'STALE_PREVIEW');
    if (reviewed.blockers.length) throw new BrandError(reviewed.blockers.join(' '));
    const before = await store.getBrandState();
    if (before.revision !== revision) throw new BrandError('The preview is stale. Review the change again.', 409, 'STALE_PREVIEW');
    if (change.action === 'select' && reviewed.impact.from.id === change.sourceId) return { ok: true, unchanged: true, revision, impact: reviewed.impact };
    const next = structuredClone(before);
    next.activeSource ??= reviewed.impact.from.id;
    if (change.action === 'select') next.activeSource = change.sourceId;
    if (change.action === 'retire') {
      next.retired = [...new Set([...next.retired, change.sourceId])];
      if (reviewed.impact.from.id === change.sourceId) next.activeSource = change.replacementId!;
    }
    if (change.action === 'restore') next.retired = next.retired.filter(id => id !== change.sourceId);
    if (change.action === 'stop-download') next.download.suppressed = true;
    if (change.action === 'enable-download') next.download.suppressed = false;
    const audit = { at: new Date().toISOString(), actor: `user:${actor.id}`, action: `brand.${change.action}`,
      subject: change.sourceId, payload: { before, after: { ...next, revision: revision + 1 }, replacement: reviewed.impact.to.id } };
    const result = await store.casBrandState(revision, next, audit);
    if (!result) throw new BrandError('The preview is stale. Review the change again.', 409, 'STALE_PREVIEW');
    return { ok: true, revision: result.revision, impact: reviewed.impact };
  };
  const publishDownload = async (bytes: Buffer, actor: string, expected: BrandSnapshot, seed = false) => {
    const inspected = inspectInstancePack(bytes, config.instance.baseUrl);
    if (!inspected.signed && !config.dev.enabled) throw new BrandError('Unsigned packs are accepted only in development mode', 400, 'UNSIGNED_PACK');
    if (expected.source.diagnostics.length || instancePackTokensChecksum(bytes) !== expected.source.tokensChecksum) {
      throw new BrandError('The pack tokens do not match the active source. Build a pack from the selected catalogue before uploading.', 400, 'PACK_SOURCE_MISMATCH');
    }
    const checksum = createHash('sha256').update(bytes).digest('hex');
    const blobId = `brand-download/${checksum}.lolly`;
    const stat = await blobs.put(blobId, bytes, 'application/octet-stream');
    const meta: InstancePackMeta = { ...inspected, size: stat.size, checksum: stat.checksum, uploadedAt: new Date().toISOString(), uploadedBy: actor };
    const next = { ...expected.state, download: { suppressed: false, sourceId: expected.source.id,
      sourceRevision: expected.source.revision, blobId, meta } };
    const result = await store.casBrandState(expected.state.revision, next, { at: meta.uploadedAt, actor,
      action: seed ? 'instance.pack.seed' : 'instance.pack.update', subject: 'instance', payload: { sourceId: expected.source.id, checksum: meta.checksum } });
    if (!result && !seed) throw new BrandError('The design system changed during upload. Review the active source and upload again.', 409, 'STALE_PREVIEW');
    return result ? meta : null;
  };
  let seeding: Promise<void> | undefined;
  const ensureDownload = async () => {
    seeding ??= (async () => {
      const snap = await snapshot();
      if (snap.state.download.suppressed || snap.state.download.blobId || snap.state.revision > 0) return;
      const old = await blobs.get(PACK_BLOB_ID);
      if (old) {
        const metaBlob = await blobs.get(PACK_META_BLOB_ID);
        if (metaBlob) JSON.parse((await readBlobBody(metaBlob.body)).toString());
        await publishDownload(await readBlobBody(old.body), 'system', snap, true);
      } else if (config.instance.connectPack) {
        const name = config.instance.connectPack;
        const bytes = await readFile(isAbsolute(name) ? name : join(config.instance.pack, name));
        await publishDownload(bytes, 'system', snap, true);
      }
    })().catch(error => { seeding = undefined; throw error; });
    await seeding;
  };
  return { snapshot, current, inventory, preview, apply, allowed, requirePermissions, ensureDownload, publishDownload, downloadVisible,
    root: () => current()?.source.root ?? config.instance.pack,
    run: async <T>(fn: () => Promise<T>) => context.run(await snapshot(), fn),
    runSnapshot: <T>(snap: BrandSnapshot, fn: () => Promise<T>) => context.run(snap, fn),
  };
}
export type BrandService = ReturnType<typeof createBrandService>;
