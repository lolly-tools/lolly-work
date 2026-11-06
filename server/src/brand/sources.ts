import { registerProjectionRoots } from '../api/file-delivery.ts';
import { existsSync, rmSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import {
  contentRoots, readAssetIndex, toolDirs, listToolFiles, toolFile, readToolManifestText,
  type ContentRoots,
} from '../../../vendor/@lolly/content-resolver/content-roots.ts';
import { canonicalJson } from '../lib/crypto.ts';
import { listBrandProfiles } from './profiles.ts';

export interface SourceAsset {
  id: string; type?: string; name?: string; checksum?: string; brandLock?: boolean;
  formats?: Array<{ format?: string; url?: string; checksum?: string }>;
  [key: string]: unknown;
}
export interface BrandSource {
  id: string; name: string; label: string; kind: 'profile' | 'mounted';
  tokensHead: string | null; tokensChecksum: string | null; revision: string; namespaces: string[];
  diagnostics: string[]; assetRevisions: Record<string, string>; root: string; assets: SourceAsset[]; toolIds: string[];
  /** The mounted source's own revision. With an edit applied, `revision` moves and this stays. */
  baseRevision: string;
  /** The mounted tokens document's checksum, whatever is served on top of it. */
  baseTokensChecksum: string | null;
  /** How a manager's edit stands on this source. Absent when there is none. */
  edit?: BrandEditView;
}
/** How a live edit stands against the mounted image. */
export interface BrandEditView {
  /** `current` is on the base it was made on; `on-new-image` applies to a newer one;
   *  `cannot-apply` and `unavailable` serve the mounted tokens instead. */
  state: 'current' | 'on-new-image' | 'cannot-apply' | 'unavailable';
  revision: number;
  digest: string;
  /** Where the image and the edit both changed the same thing. */
  overlaps: string[];
  /** What the edit names that the image no longer has. */
  gone: string[];
}
export interface SourceInventory { defaultId: string; profilesAvailable: boolean; sources: BrandSource[] }
const temporaryRoots = new Set<string>();
process.once('exit', () => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
/** Where an edited tokens file sits in a view. A name no pack is likely to hold, and hidden if one does. */
const EDIT_DIR = 'lw-brand-edits';
/** Views of edited tokens one process keeps. An older one is removed after a grace period, for requests still reading it. */
const MAX_EDIT_VIEWS = 8;
const EDIT_VIEW_GRACE_MS = 10 * 60 * 1000;

async function json(path: string): Promise<Record<string, unknown> | null> {
  try { return JSON.parse(await readFile(path, 'utf8')); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
async function linkChildren(from: string, to: string, except: string[] = []): Promise<void> {
  await mkdir(to, { recursive: true });
  for (const name of await readdir(from).catch(() => [] as string[])) {
    if (!except.includes(name)) await symlink(join(from, name), join(to, name));
  }
}

/** Reuse the pinned Lolly resolver, then expose an immutable root to existing readers. */
export function createBrandSources(pack: string, tokensHeads: Record<string, string> = {}) {
  const mounted = resolve(pack);
  let inventory: Promise<SourceInventory> | undefined;
  const projectedFrom = new Map<string, string[]>();
  const discover = async (): Promise<SourceInventory> => {
    const versionModule: string = '@lolly/engine';
    const { isVersionAssetId } = await import(versionModule) as { isVersionAssetId(id: string, head: string): boolean };
    const modern = await json(join(mounted, 'profiles.json'));
    const legacy = modern ? null : await listBrandProfiles(mounted);
    const specs: Array<{ id: string; name: string; label: string; roots: ContentRoots }> = [];
    let defaultId = 'mounted';
    if (modern) {
      const profiles = modern.profiles as Record<string, { label?: string }>;
      for (const [name, declaration] of Object.entries(profiles ?? {})) {
        if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) throw new Error('Invalid content profile name');
        try { specs.push({ id: `profile:${name}`, name, label: declaration.label || name, roots: contentRoots({ root: mounted, profile: name }) }); }
        catch { /* Profiles whose packs are absent cannot be selected on this deployment. */ }
      }
      const resolved = contentRoots({ root: mounted });
      defaultId = `profile:${resolved.profile}`;
    } else if (legacy?.available) {
      for (const profile of legacy.profiles) {
        const catalogRoot = await realpath(join(mounted, 'brands', profile.name, 'catalog'));
        const localTools = join(mounted, 'brands', profile.name, 'tools');
        specs.push({ id: `profile:${profile.name}`, name: profile.name, label: profile.name,
          roots: { profile: profile.name, catalogRoot, toolRoots: [join(mounted, 'tools'), ...(existsSync(localTools) ? [localTools] : [])], assetRoots: [], exclude: new Set() } });
      }
      defaultId = `profile:${legacy.active ?? legacy.profiles[0]!.name}`;
    } else {
      const catalogRoot = await realpath(join(mounted, 'catalog')).catch(() => join(mounted, 'catalog'));
      specs.push({ id: 'mounted', name: 'mounted', label: 'Mounted catalogue', roots: {
        profile: 'materialized', catalogRoot, toolRoots: [join(mounted, 'tools')], assetRoots: [], exclude: new Set(),
      } });
    }
    const temporary = await mkdtemp(join(tmpdir(), 'lw-brand-sources-'));
    temporaryRoots.add(temporary);
    const sources: BrandSource[] = [];
    for (const spec of specs) {
      const roots = { ...spec.roots, toolRoots: spec.roots.toolRoots.filter(path => existsSync(path)) };
      const index = (existsSync(join(roots.catalogRoot, 'assets', 'index.json')) ? readAssetIndex(roots) : { assets: [] }) as unknown as { assets?: SourceAsset[]; [key: string]: unknown };
      const assets = index.assets ?? [];
      const assetRevisions: Record<string, string> = {};
      for (const asset of assets) {
        for (const format of asset.formats ?? []) {
          if (!format.checksum && format.url?.startsWith('/catalog/') && !format.url.split('/').includes('..')) {
            const rel = format.url.slice('/catalog/'.length);
            const shared = roots.assetRoots.find(root => rel.startsWith(`packs/${root.name}/`));
            const file = shared ? join(shared.dir, rel.slice(`packs/${shared.name}/`.length)) : join(roots.catalogRoot, rel);
            const bytes = await readFile(file).catch(() => null);
            if (bytes) format.checksum = `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
          }
        }
        assetRevisions[asset.id] = hash(canonicalJson(asset));
      }
      const allTokens = assets.filter(a => a.type === 'tokens');
      const tokens = allTokens.filter(a => !allTokens.some(b => b.id !== a.id && isVersionAssetId(a.id, b.id)));
      const selected = tokensHeads[spec.id] ?? (index.brandTokens === null || typeof index.brandTokens === 'string' ? index.brandTokens : undefined);
      const head = typeof selected === 'string' ? tokens.find(a => a.id === selected) : selected === undefined && tokens.length === 1 ? tokens[0] : undefined;
      const diagnostics: string[] = [];
      if (selected && !head) diagnostics.push('The configured tokens asset is absent. Correct instance.brandTokens and restart.');
      else if (selected === undefined && tokens.length > 1 && !head) diagnostics.push('Multiple tokens assets are present. Set instance.brandTokens for this source.');
      const root = join(temporary, spec.name);
      await linkChildren(roots.catalogRoot, join(root, 'catalog'), ['assets', 'packs']);
      await linkChildren(join(roots.catalogRoot, 'assets'), join(root, 'catalog', 'assets'), ['index.json', EDIT_DIR]);
      await linkChildren(join(roots.catalogRoot, 'packs'), join(root, 'catalog', 'packs'), roots.assetRoots.map(a => a.name));
      for (const shared of roots.assetRoots) await symlink(shared.dir, join(root, 'catalog', 'packs', shared.name));
      const effective = { ...index, brandTokens: head?.id ?? null, assets: assets.map(asset => asset.type === 'tokens' ? { ...asset, defaultTokens: asset.id === head?.id } : asset) };
      await writeFile(join(root, 'catalog', 'assets', 'index.json'), JSON.stringify(effective));
      await mkdir(join(root, 'tools'), { recursive: true });
      const projected = [roots.catalogRoot, ...roots.toolRoots, ...roots.assetRoots.map(source => source.dir)];
      projectedFrom.set(spec.id, projected);
      await registerProjectionRoots(root, projected);
      // Content-addressed releases live beside logical tool directories.
      for (const source of roots.toolRoots) for (const id of await readdir(source).catch(() => [] as string[])) {
        if (/^[a-z0-9-]+@[0-9a-f]{16}$/i.test(id) && !existsSync(join(root, 'tools', id))) await symlink(join(source, id), join(root, 'tools', id));
      }
      for (const [id, tool] of toolDirs(roots)) {
        if (/^[a-z0-9-]+@[0-9a-f]{16}$/i.test(id)) continue;
        if (!tool.base) { await symlink(tool.dir, join(root, 'tools', id)); continue; }
        for (const rel of listToolFiles(id, roots)) {
          const dest = join(root, 'tools', id, rel);
          await mkdir(dirname(dest), { recursive: true });
          if (rel === 'tool.json') await writeFile(dest, readToolManifestText(id, roots));
          else { const source = toolFile(id, rel, roots); if (source) await symlink(source, dest); }
        }
      }
      const toolIndex = await json(join(root, 'catalog', 'tools', 'index.json'));
      const toolIds = ((toolIndex?.tools ?? []) as Array<{ id: string }>).map(tool => tool.id).sort();
      const format = head?.formats?.find(f => f.format === 'json') ?? head?.formats?.[0];
      let tokenBytes = '';
      let tokensChecksum: string | null = null;
      if (head && !format?.url) diagnostics.push('The tokens asset has no local JSON file.');
      if (format?.url) {
        const rel = format.url.replace(/^\/?catalog\//, '');
        if (rel.split(/[\\/]/).includes('..') || /^[a-z]+:/i.test(rel)) diagnostics.push('The tokens asset must name a local catalogue file.');
        else {
          try { tokenBytes = await readFile(join(root, 'catalog', rel), 'utf8'); tokensChecksum = hash(canonicalJson(JSON.parse(tokenBytes))); }
          catch { diagnostics.push('The tokens asset is unreadable or invalid JSON.'); }
        }
      }
      const revision = hash(JSON.stringify(effective) + JSON.stringify(toolIndex) + tokenBytes);
      sources.push({ id: spec.id, name: spec.name,
        label: spec.id === 'mounted' && head?.name ? head.name.replace(/\s+tokens$/i, '') : spec.label,
        assetRevisions, kind: spec.id === 'mounted' ? 'mounted' : 'profile', root, assets, toolIds,
        tokensHead: head?.id ?? null, tokensChecksum, diagnostics,
        revision, baseRevision: revision, baseTokensChecksum: tokensChecksum,
        namespaces: [...new Set(assets.map(a => a.id.includes('/') ? a.id.split('/')[0]! + '/' : '(unclassified)'))].sort(),
      });
    }
    return { defaultId, profilesAvailable: !!modern || !!legacy?.available, sources };
  };
  let emptyRoot: Promise<string> | undefined;
  const views = new Map<string, Promise<BrandSource>>();
  /**
   * The mounted source with one tokens document in place of its own. A view of its
   * own with a new index, so the catalogue, the signature, renders and rules all read
   * the edit through the paths they already use, and the mounted files stay untouched.
   * Everything else links back to the mounted view. The revision comes from the same
   * inputs on every replica, so they all agree on it.
   */
  const buildEditView = async (base: BrandSource, bytes: Buffer, edit: BrandEditView): Promise<BrandSource> => {
    const root = await mkdtemp(join(tmpdir(), 'lw-brand-edit-'));
    temporaryRoots.add(root);
    const baseCatalog = join(base.root, 'catalog');
    await mkdir(join(root, 'catalog', 'assets', EDIT_DIR), { recursive: true });
    for (const name of await readdir(baseCatalog)) if (name !== 'assets') await symlink(join(baseCatalog, name), join(root, 'catalog', name));
    for (const name of await readdir(join(baseCatalog, 'assets'))) if (name !== 'index.json') await symlink(join(baseCatalog, 'assets', name), join(root, 'catalog', 'assets', name));
    await symlink(join(base.root, 'tools'), join(root, 'tools'));
    await registerProjectionRoots(root, [...(projectedFrom.get(base.id) ?? []), base.root]);
    const digest = createHash('sha256').update(bytes).digest();
    // Named by its content, so no cache can hold other bytes under this address.
    const url = `/catalog/assets/${EDIT_DIR}/${digest.toString('hex').slice(0, 16)}/tokens.json`;
    await mkdir(dirname(join(root, url.slice(1))), { recursive: true });
    await writeFile(join(root, url.slice(1)), bytes);
    const index = JSON.parse(await readFile(join(baseCatalog, 'assets', 'index.json'), 'utf8')) as { assets?: SourceAsset[]; [key: string]: unknown };
    const sri = `sha256-${digest.toString('base64')}`;
    const head = (index.assets ?? []).find(asset => asset.id === base.tokensHead);
    const before = (head?.formats?.find(format => format.format === 'json') ?? head?.formats?.[0])?.url;
    const assetRevisions = { ...base.assetRevisions };
    // A former id reads the same file as its replacement, so it reads the edit too.
    for (const asset of index.assets ?? []) {
      if (asset.type !== 'tokens' || !asset.formats?.some(format => format.url === before)) continue;
      asset.formats = asset.formats.map(format => format.url === before ? { ...format, url, checksum: sri, size: bytes.length } : format);
      if (asset.checksum !== undefined) asset.checksum = sri;
      assetRevisions[asset.id] = hash(canonicalJson(asset));
    }
    await writeFile(join(root, 'catalog', 'assets', 'index.json'), JSON.stringify(index));
    const toolIndex = await json(join(root, 'catalog', 'tools', 'index.json'));
    return { ...base, root, assets: index.assets ?? [], assetRevisions, edit,
      tokensChecksum: hash(canonicalJson(JSON.parse(bytes.toString('utf8')))),
      revision: hash(JSON.stringify(index) + JSON.stringify(toolIndex) + bytes.toString('utf8')) };
  };
  return {
    inventory: () => inventory ??= discover().catch(error => { inventory = undefined; throw error; }),
    /** The view for one document, built once. A failed build is not remembered. */
    editView: (base: BrandSource, bytes: Buffer, edit: BrandEditView): Promise<BrandSource> => {
      const key = `${base.id}\u0000${base.revision}\u0000${createHash('sha256').update(bytes).digest('hex')}\u0000${edit.state}\u0000${edit.revision}`;
      const hit = views.get(key);
      if (hit) { views.delete(key); views.set(key, hit); return hit; }
      const view = buildEditView(base, bytes, edit);
      views.set(key, view);
      view.catch(() => { if (views.get(key) === view) views.delete(key); });
      while (views.size > MAX_EDIT_VIEWS) {
        const oldest = views.keys().next().value as string, old = views.get(oldest)!;
        views.delete(oldest);
        void old.then(source => {
          setTimeout(() => { rmSync(source.root, { recursive: true, force: true }); temporaryRoots.delete(source.root); }, EDIT_VIEW_GRACE_MS).unref();
        }).catch(() => {});
      }
      return view;
    },
    unavailable: async (id: string): Promise<BrandSource> => {
      emptyRoot ??= (async () => {
        const root = await mkdtemp(join(tmpdir(), 'lw-brand-unavailable-'));
        temporaryRoots.add(root);
        for (const part of ['assets', 'tools']) {
          await mkdir(join(root, 'catalog', part), { recursive: true });
          await writeFile(join(root, 'catalog', part, 'index.json'), JSON.stringify({ [part]: [], brandTokens: null }));
        }
        await mkdir(join(root, 'tools'));
        return root;
      })();
      return { id, name: id, label: 'Unavailable design system', kind: 'mounted', root: await emptyRoot,
        assets: [], assetRevisions: {}, toolIds: [], tokensHead: null, tokensChecksum: null, revision: 'unavailable', baseRevision: 'unavailable', baseTokensChecksum: null, namespaces: [],
        diagnostics: ['The selected source is unavailable. Restore its mounted files or select an installed replacement.'] };
    },
  };
}

/** Only public catalogue facts leave the source adapter. */
export function describeSource(source: BrandSource) {
  const { root: _root, assets: _assets, toolIds: _tools, assetRevisions: _revisions, edit: _edit, baseRevision: _base, baseTokensChecksum: _baseTokens, ...descriptor } = source;
  return descriptor;
}
