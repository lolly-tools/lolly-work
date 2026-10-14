// SPDX-License-Identifier: MPL-2.0
/** Signed filtered catalog snapshots, retained without retaining access grants. */
import { readFile } from 'node:fs/promises';
import { safeFile } from '../api/file-delivery.ts';
import { join } from 'node:path';
import type { Store, CatalogPublication } from '../store/types.ts';
import { catalogPublication } from './publication.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { createToolDigestCache, servedToolIndexBytes, toolDirectoryDigests, type CatalogCaller, type CatalogSigning, type ServedToolIndex } from './signing.ts';
import { servedToolSidecar } from './tool-sidecars.ts';
import type { ServedIndexer, ServedIndex } from './served-index.ts';
import { publisherResourceDigests, scopedResourceDigests } from './resource-proofs.ts';

export type CatalogSnapshotKind = 'tools' | 'assets' | 'slim';
export interface CatalogDeliveryView {
  tools: ServedToolIndex;
  assets: ServedIndex;
  slim: Buffer | null;
  scope: string;
  seq: number;
  files: Record<string, string>;
  toolDirs: Record<string, string>;
  envelope: Buffer | null;
}
const RETAIN_MS = 60 * 60 * 1000;
const MAX_SNAPSHOT_BYTES = 256 * 1024 * 1024;

/** Scope comes exclusively from the server's current resolved grants. */
export function catalogVisibilityScope(caller: CatalogCaller): string {
  return sha256Hex(canonicalJson({ groups: [...new Set(caller.groups)].sort(), guestTool: caller.guestToolId ?? null }));
}

function ids(bytes: Buffer, field: 'tools' | 'assets'): string[] {
  try { const rows = JSON.parse(bytes.toString())[field]; return Array.isArray(rows) ? rows.map(row => row.id).filter((id): id is string => typeof id === 'string') : []; }
  catch { return []; }
}

export function createCatalogDelivery(deps: { store: Store; servedIndex: ServedIndexer; signing: CatalogSigning | null; source: { pack: string; generation?: number; publicKey?: Record<string, unknown> }; shellDir?: string; shellDirectories?: () => string[]; activePack?: () => Promise<string>; requireGeneration?: boolean; now?: () => number; maxBytes?: number }) {
  const now = deps.now ?? Date.now, maxBytes = deps.maxBytes ?? MAX_SNAPSHOT_BYTES;
  let publication: Promise<CatalogPublication> | undefined;
  let preparation: Promise<void> | undefined;
  let resourceProof: Promise<Record<string, string>> | undefined;
  const toolFiles = deps.signing?.fileDigests ?? createToolDigestCache();
  const sourcePublication = (): Promise<CatalogPublication> => publication ??= catalogPublication({ ...deps.source, signing: deps.signing,
    fileDigests: () => toolFiles(deps.source.pack),
  }).catch(error => { publication = undefined; throw error; });
  /** Startup and first reads share the same complete source proof, never a render timeout. */
  const prepare = (): Promise<void> => preparation ??= Promise.all([
    sourcePublication(), toolFiles(deps.source.pack),
    ...(deps.activePack ? [deps.activePack().then(toolFiles)] : []),
  ]).then(([source]) => {
    if (deps.requireGeneration && source.generation <= 0) throw Object.assign(new Error('Production catalog publication requires a positive generation'), { status: 503 });
  });
  const remember = async (scope: string, kind: CatalogSnapshotKind, bytes: Buffer): Promise<void> => {
    const at = now();
    const stored = await deps.store.putCatalogDeliverySnapshot({ scope, kind, hash: sha256Hex(bytes), bytes,
      until: at + RETAIN_MS, toolIds: ids(bytes, 'tools'), assetIds: ids(bytes, 'assets') }, at, maxBytes);
    if (!stored) throw Object.assign(new Error('catalog snapshot retention is full'), { status: 503 });
  };
  const current = async (pack: string, caller: CatalogCaller): Promise<CatalogDeliveryView | null> => {
    const shellDirectories = deps.shellDirectories?.() ?? (deps.shellDir ? [deps.shellDir] : []);
    await prepare();
    const [tools, assets, slimResult, rawTools, rawSlim, allFiles] = await Promise.all([
      servedToolIndexBytes(pack, caller), deps.servedIndex.forCaller({ groups: caller.groups }),
      servedToolSidecar(pack, 'tools/index.slim.json', caller),
      readFile(join(pack, 'catalog/tools/index.json')).catch(() => Buffer.alloc(0)),
      readFile(join(pack, 'catalog/tools/index.slim.json')).catch(() => Buffer.alloc(0)), toolFiles(pack),
    ]);
    if (!tools) return null;
    const slim = slimResult.kind === 'json' ? slimResult.bytes : null;
    const parsed = (bytes: Buffer | null): unknown => { try { return bytes ? JSON.parse(bytes.toString()) : null; } catch { return null; } };
    const entries = (bytes: Buffer | null): Array<{ id: string }> => {
      const index = parsed(bytes) as { tools?: Array<{ id: string }> } | null;
      return Array.isArray(index?.tools) ? index.tools.filter(tool => tool && typeof tool.id === 'string') : [];
    };
    const visibleTools = entries(tools.bytes);
    const publisher = await (resourceProof ??= publisherResourceDigests({ ...deps.source, signing: deps.signing }));
    const resources = await scopedResourceDigests({ pack, shellDirectories, publisher, caller,
      visibleToolIds: new Set(visibleTools.map(tool => tool.id.toLowerCase())), visibleValues: [visibleTools, entries(slim), assets.index.assets ?? []] });
    const scope = catalogVisibilityScope(caller);
    const fingerprint = sha256Hex(canonicalJson({ assets: assets.sourceFingerprint,
      tools: sha256Hex(rawTools), slim: sha256Hex(rawSlim), files: allFiles,
      overlays: [...caller.overlays].sort(([a], [b]) => a.localeCompare(b)),
    }));
    const seq = await deps.store.catalogDeliverySequence(fingerprint, await sourcePublication());
    const files = Object.fromEntries(Object.entries(allFiles).filter(([path]) => tools.visible(path.slice(0, path.indexOf('/')))));
    const toolDirs = toolDirectoryDigests(files);
    await remember(scope, 'tools', tools.bytes);
    if (assets.status !== 'missing') await remember(scope, 'assets', assets.bytes);
    if (slim) await remember(scope, 'slim', slim);
    const envelope = deps.signing ? await deps.signing.envelopeFor(pack, tools, { seq, catalogScope: scope,
      ...(assets.status !== 'missing' ? { assetIndexHash: sha256Hex(assets.bytes) } : {}), ...(slim ? { slimHash: sha256Hex(slim) } : {}),
      resources,
    }).catch(() => null) : null;
    return { tools, assets, slim, scope, seq, files, toolDirs, envelope };
  };
  return {
    prepare,
    current,
    /** Recompose current permissions first, then permit only historical subsets. */
    async snapshot(pack: string, caller: CatalogCaller, kind: CatalogSnapshotKind, hash16: string): Promise<Buffer | null> {
      const view = await current(pack, caller); if (!view) return null;
      const entry = await deps.store.getCatalogDeliverySnapshot(view.scope, kind, hash16, now());
      if (!entry || entry.until <= now()) return null;
      const tools = new Set(ids(view.tools.bytes, 'tools')), assets = new Set(ids(view.assets.bytes, 'assets'));
      if (entry.toolIds.some(id => !tools.has(id)) || entry.assetIds.some(id => !assets.has(id))) return null;
      if (kind === 'assets') {
        const currentById = new Map((view.assets.index.assets ?? []).map(asset => [asset.id, asset]));
        try {
          const historical = JSON.parse(entry.bytes.toString()).assets as Array<Record<string, unknown>>;
          if (!Array.isArray(historical)) return null;
          for (const asset of historical) {
            const live = currentById.get(String(asset.id));
            if (!live) return null;
            // Old licensing claims never override the current source of truth.
            for (const field of ['rights', 'license', 'licence', 'availableFrom', 'availableUntil']) {
              if (canonicalJson(asset[field] ?? null) !== canonicalJson(live[field] ?? null)) return null;
            }
          }
        } catch { return null; }
      }
      return entry.bytes;
    },
  };
}

/** Retained files are inventory-checked; the router checks current grants first. */
export async function retainedToolBytes(pack: string, rel: string): Promise<{ bytes: Buffer; modified: Date } | null> {
  const addressed = /^([a-z0-9-]+)@([0-9a-f]{16})\/(.+)$/i.exec(rel);
  if (!addressed) return null;
  const manifest = await safeFile(pack, 'catalog/delivery-manifest.json');
  if (!manifest || manifest.size > 16 * 1024 * 1024) return null;
  try {
    const inventory = JSON.parse(await readFile(manifest.path, 'utf8')) as { version?: number; files?: Array<{ path: string; sha256: string; size: number }> };
    if (inventory.version !== 1 || !Array.isArray(inventory.files) || inventory.files.length > 100000) return null;
    const prefix = `tools/${addressed[1]}@${addressed[2]}/`, files: Record<string, string> = {};
    for (const item of inventory.files) if (typeof item.path === 'string' && item.path.startsWith(prefix)) {
      if (!/^[0-9a-f]{64}$/.test(item.sha256)) return null;
      files[`${addressed[1]}/${item.path.slice(prefix.length)}`] = item.sha256;
    }
    if (toolDirectoryDigests(files)[addressed[1]!]?.slice(0, 16) !== addressed[2]) return null;
    const expected = inventory.files.find(item => item.path === `tools/${rel}`), file = await safeFile(pack, `tools/${rel}`);
    if (!expected || !file || expected.size !== file.size) return null;
    const bytes = await readFile(file.path);
    return sha256Hex(bytes) === expected.sha256 ? { bytes, modified: file.modified } : null;
  } catch { return null; }
}
