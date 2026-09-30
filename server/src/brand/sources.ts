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
}
export interface SourceInventory { defaultId: string; profilesAvailable: boolean; sources: BrandSource[] }
const temporaryRoots = new Set<string>();
process.once('exit', () => { for (const root of temporaryRoots) rmSync(root, { recursive: true, force: true }); });
const hash = (value: string) => createHash('sha256').update(value).digest('hex');

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
  const discover = async (): Promise<SourceInventory> => {
    const versionModule: string = '../../../vendor/@lolly/engine/src/design-version.ts';
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
      await linkChildren(join(roots.catalogRoot, 'assets'), join(root, 'catalog', 'assets'), ['index.json']);
      await linkChildren(join(roots.catalogRoot, 'packs'), join(root, 'catalog', 'packs'), roots.assetRoots.map(a => a.name));
      for (const shared of roots.assetRoots) await symlink(shared.dir, join(root, 'catalog', 'packs', shared.name));
      const effective = { ...index, brandTokens: head?.id ?? null, assets: assets.map(asset => asset.type === 'tokens' ? { ...asset, defaultTokens: asset.id === head?.id } : asset) };
      await writeFile(join(root, 'catalog', 'assets', 'index.json'), JSON.stringify(effective));
      await mkdir(join(root, 'tools'), { recursive: true });
      for (const [id, tool] of toolDirs(roots)) {
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
      sources.push({ id: spec.id, name: spec.name,
        label: spec.id === 'mounted' && head?.name ? head.name.replace(/\s+tokens$/i, '') : spec.label,
        assetRevisions, kind: spec.id === 'mounted' ? 'mounted' : 'profile', root, assets, toolIds,
        tokensHead: head?.id ?? null, tokensChecksum, diagnostics,
        revision: hash(JSON.stringify(effective) + JSON.stringify(toolIndex) + tokenBytes),
        namespaces: [...new Set(assets.map(a => a.id.includes('/') ? a.id.split('/')[0]! + '/' : '(unclassified)'))].sort(),
      });
    }
    return { defaultId, profilesAvailable: !!modern || !!legacy?.available, sources };
  };
  let emptyRoot: Promise<string> | undefined;
  return {
    inventory: () => inventory ??= discover().catch(error => { inventory = undefined; throw error; }),
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
        assets: [], assetRevisions: {}, toolIds: [], tokensHead: null, tokensChecksum: null, revision: 'unavailable', namespaces: [],
        diagnostics: ['The selected source is unavailable. Restore its mounted files or select an installed replacement.'] };
    },
  };
}

/** Only public catalogue facts leave the source adapter. */
export function describeSource(source: BrandSource) {
  const { root: _root, assets: _assets, toolIds: _tools, assetRevisions: _revisions, ...descriptor } = source;
  return descriptor;
}
