import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { sha256Hex } from '../lib/crypto.ts';
import { cachePolicy, tag } from '@lolly-tools/core/delivery-v1';
import { sendBytes, sendFile, INERT_BYTE_HEADERS } from '../api/file-delivery.ts';
import { type createRouter, sendError } from '../api/router.ts';
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
    return { source, revision: snap.revision, address: sha256Hex(snap.revision), tokens, light, dark, label: asset?.name ?? source.label,
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
    public: async () => { const data = await get(); return data.tokens ? { tokens: data.tokens, logos: { light: data.light ? `/api/brand/r/${data.address}/logo/light` : null, dark: data.dark ? `/api/brand/r/${data.address}/logo/dark` : null } } : null; },
    card: async (packUrl: string | null, meta: InstancePackMeta | null) => {
      const data = await get();
      if (!data.tokens) return null;
      const snap = brand.current() ?? await brand.snapshot();
      return { profile: data.source.kind === 'profile' ? data.source.name : null, label: data.label,
        version: packUrl ? meta?.version ?? null : null, checksum: data.checksum, locked: data.locked, packUrl,
        sourceId: data.source.id, revision: snap.revision };
    },
    register(router: ReturnType<typeof createRouter>) {
      const rules = (data: Awaited<ReturnType<typeof get>>, immutable = false) => ({
        'cache-control': cachePolicy(immutable ? 'public-immutable' : 'public-revalidate').cacheControl,
        'cache-tag': tag('b', data.address.slice(0, 16)), 'surrogate-key': tag('b', data.address.slice(0, 16)),
        'x-content-type-options': 'nosniff',
      });
      const css: import('../api/router.ts').Handler = async (req, res) => {
        const data = await get();
        const text = authThemeCss(data.tokens, data.font).replaceAll('/api/brand/font/', `/api/brand/r/${data.address}/font/`);
        sendBytes(req, res, Buffer.from(text), { contentType: 'text/css; charset=utf-8', headers: rules(data) });
      };
      const json: import('../api/router.ts').Handler = async (req, res) => {
        const data = await get();
        if (!data.tokens) return sendError(res, 404, 'NO_BRAND', 'No unambiguous design tokens are configured for this source.');
        sendBytes(req, res, Buffer.from(JSON.stringify({ name, tokens: data.tokens, fontsBase: `/api/brand/r/${data.address}/font/`,
          logos: { light: data.light ? `/api/brand/r/${data.address}/logo/light` : null, dark: data.dark ? `/api/brand/r/${data.address}/logo/dark` : null },
          revision: data.revision })), { contentType: 'application/json; charset=utf-8', headers: rules(data) });
      };
      const logo: import('../api/router.ts').Handler = async (req, res, ctx) => {
        const data = await get();
        if (ctx.params.revision && ctx.params.revision !== data.address) return sendError(res, 404, 'NOT_FOUND', 'No current brand at this revision.');
        const file = ctx.params.variant === 'light' ? data.light : ctx.params.variant === 'dark' ? data.dark : null;
        if (!file || !await sendFile(req, res, data.source.root, relative(data.source.root, file), { contentType: 'image/svg+xml',
          headers: { ...rules(data, !!ctx.params.revision), ...INERT_BYTE_HEADERS }, ranges: true })) sendError(res, 404, 'NOT_FOUND', 'Logo is unavailable.');
      };
      const font: import('../api/router.ts').Handler = async (req, res, ctx) => {
        const data = await get(), file = ctx.params.file ?? '';
        if (ctx.params.revision && ctx.params.revision !== data.address) return sendError(res, 404, 'NOT_FOUND', 'No current brand at this revision.');
        if (!/^[A-Za-z0-9._[\]-]+\.woff2$/.test(file)) return sendError(res, 400, 'INVALID_INPUT', 'Bad font name.');
        if (!await sendFile(req, res, data.source.root, `catalog/fonts/webfonts/${file}`, { contentType: 'font/woff2', ranges: true,
          headers: rules(data, !!ctx.params.revision) })) sendError(res, 404, 'NOT_FOUND', 'Font is unavailable.');
      };
      for (const method of ['GET', 'HEAD']) {
        router.add(method, '/api/brand/auth.css', css, { delivery: 'public-revalidate' });
        router.add(method, '/api/brand', json, { delivery: 'public-revalidate' });
        router.add(method, '/api/brand/logo/:variant', logo, { delivery: 'public-revalidate' });
        router.add(method, '/api/brand/font/:file', font, { delivery: 'public-revalidate' });
        router.add(method, '/api/brand/r/:revision/logo/:variant', logo, { delivery: 'public-immutable' });
        router.add(method, '/api/brand/r/:revision/font/:file', font, { delivery: 'public-immutable' });
      }
    },
  };
}
