import { readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { type createRouter, sendError, sendJson } from '../api/router.ts';
import type { BrandService } from './service.ts';
import type { InstancePackMeta } from '../catalog/instance-pack.ts';
import { pickBrandLogoUrl } from './logo.ts';
import { authThemeCss, pickAuthFont } from './auth-theme.ts';

/** Caches belong to a source snapshot, so overlapping requests cannot mix brands. */
export function createBrandChrome(name: string, brand: BrandService) {
  const cache = new Map<string, Promise<Awaited<ReturnType<typeof load>>>>();
  const load = async () => {
    const snap = brand.current() ?? await brand.snapshot();
    const source = snap.source;
    const asset = source.assets.find(a => a.id === source.tokensHead);
    const format = asset?.formats?.find(f => f.format === 'json') ?? asset?.formats?.[0];
    const local = (url: string | undefined) => url && !url.split(/[\\/]/).includes('..') && !/^[a-z]+:/i.test(url)
      ? join(source.root, 'catalog', url.replace(/^\/?catalog\//, '')) : null;
    const path = local(format?.url);
    const tokens = path && !source.diagnostics.length ? await readFile(path, 'utf8').then(JSON.parse).catch(() => null) : null;
    const light = local(pickBrandLogoUrl(source.assets, 'light'));
    const dark = local(pickBrandLogoUrl(source.assets, 'dark'));
    const names = (await readdir(join(source.root, 'catalog', 'fonts', 'webfonts')).catch(() => [] as string[]))
      .filter(file => file.toLowerCase().endsWith('.woff2') && !/mono/i.test(file)).sort();
    return { source, tokens, light, dark, label: asset?.name ?? source.label,
      checksum: asset?.checksum ?? format?.checksum ?? (asset ? source.revision : null), locked: asset?.brandLock === true,
      font: pickAuthFont(tokens, names) };
  };
  const get = async () => {
    const snap = brand.current() ?? await brand.snapshot();
    let entry = cache.get(snap.revision);
    if (!entry) {
      entry = brand.runSnapshot(snap, load);
      if (cache.size > 32) cache.delete(cache.keys().next().value!);
      cache.set(snap.revision, entry);
    }
    return entry;
  };
  return {
    font: async () => (await get()).font,
    public: async () => { const data = await get(); return data.tokens ? { tokens: data.tokens, logos: { light: data.light ? '/api/brand/logo/light' : null, dark: data.dark ? '/api/brand/logo/dark' : null } } : null; },
    card: async (packUrl: string | null, meta: InstancePackMeta | null) => {
      const data = await get();
      if (!data.tokens) return null;
      const snap = brand.current() ?? await brand.snapshot();
      return { profile: data.source.kind === 'profile' ? data.source.name : null, label: data.label,
        version: packUrl ? meta?.version ?? null : null, checksum: data.checksum, locked: data.locked, packUrl,
        sourceId: data.source.id, revision: snap.revision };
    },
    register(router: ReturnType<typeof createRouter>) {
      router.add('GET', '/api/brand/auth.css', async (_req, res) => {
        const data = await get();
        res.writeHead(200, { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'public, no-cache', 'x-content-type-options': 'nosniff' });
        res.end(authThemeCss(data.tokens, data.font));
      });
      router.add('GET', '/api/brand', async (_req, res) => {
        const data = await get();
        if (!data.tokens) return sendError(res, 404, 'NO_BRAND', 'No unambiguous design tokens are configured for this source.');
        sendJson(res, 200, { name, tokens: data.tokens, fontsBase: '/api/brand/font/',
          logos: { light: data.light ? '/api/brand/logo/light' : null, dark: data.dark ? '/api/brand/logo/dark' : null },
          revision: brand.current()!.revision }, { 'cache-control': 'public, no-cache', etag: `"${brand.current()!.revision}"` });
      });
      router.add('GET', '/api/brand/logo/:variant', async (_req, res, ctx) => {
        const data = await get();
        const file = ctx.params.variant === 'light' ? data.light : ctx.params.variant === 'dark' ? data.dark : null;
        if (!file) return sendError(res, 404, 'NOT_FOUND', 'No logo for this theme.');
        try { const bytes = await readFile(file); res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, no-cache' }); res.end(bytes); }
        catch { if (!res.headersSent) sendError(res, 404, 'NOT_FOUND', 'Logo is unavailable.'); else res.end(); }
      });
      router.add('GET', '/api/brand/font/:file', async (_req, res, ctx) => {
        const file = ctx.params.file ?? '';
        if (!/^[A-Za-z0-9._[\]-]+\.woff2$/.test(file)) return sendError(res, 400, 'INVALID_INPUT', 'Bad font name.');
        try {
          const bytes = await readFile(join((await get()).source.root, 'catalog', 'fonts', 'webfonts', file));
          res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, no-cache' }); res.end(bytes);
        } catch { sendError(res, 404, 'NOT_FOUND', 'Font is unavailable.'); }
      });
    },
  };
}
