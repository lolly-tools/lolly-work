/**
 * Mock provider driver - tests and `pnpm run demo` only. Assets, faults, and
 * search all come from `options`, so a test can stand up any federation
 * scenario (including outage → last-good fallback) without network.
 */
import type { CatalogProvider, ProviderAssetRef } from './types.ts';
import { generatedAsset, generatedBlob, generatedIndex, type MockGenerateOptions } from './mock-generate.ts';

export interface MockProviderOptions {
  assets?: ProviderAssetRef[];
  /** Optional deterministic blob bodies keyed by remote id. Tests use this to
   * exercise JSON/CSV live bindings through the real provider path. */
  blobText?: Record<string, string>;
  blobBase64?: Record<string, string>;
  blobContentType?: Record<string, string>;
  /** When set, listAssets/searchAssets/healthCheck all fail with this message. */
  failWith?: string;
  /** Remote ids whose blob refuses to stream - the per-asset materialize
   *  failure (one bad asset in an otherwise good walk) without a network. */
  failBlobFor?: string[];
  /** Require the resolved credential to equal this value (exercises seal/open). */
  expectSecret?: string;
  /** Declare the publish-out capability (plans/27 §10) so the publish route can
   *  be exercised without a live destination DAM. */
  publish?: boolean;
  /** Synthesise this many assets after the literal `assets` (mock-generate.ts),
   *  so a test or the demo can stand up a large DAM without a large options blob. */
  generate?: MockGenerateOptions;
  /** Page the listing this many assets at a time, the way a real DAM does.
   *  Absent: one page for literal assets, 100 per page once `generate` is set. */
  pageSize?: number;
}

/** How often each mock provider was asked for a page or a blob, by provider
 *  id. Tests read it to prove a cache spared the driver a call. */
export const mockCalls = new Map<string, { list: number; blob: number }>();
const counted = (id: string): { list: number; blob: number } => {
  let c = mockCalls.get(id);
  if (!c) mockCalls.set(id, (c = { list: 0, blob: 0 }));
  return c;
};

export function createMockProvider(id: string, options: MockProviderOptions, secret?: string): CatalogProvider {
  const assets = options.assets ?? [];
  const gen = options.generate && Number.isInteger(options.generate.count) && options.generate.count > 0 ? options.generate : undefined;
  const total = assets.length + (gen?.count ?? 0);
  const at = (k: number): ProviderAssetRef => (k < assets.length ? assets[k] as ProviderAssetRef : generatedAsset(k - assets.length, gen!));
  const pageSize = options.pageSize && options.pageSize > 0 ? Math.floor(options.pageSize) : gen ? 100 : 0;
  const check = (): void => {
    if (options.failWith) throw new Error(options.failWith);
    if (options.expectSecret !== undefined && secret !== options.expectSecret) throw new Error('bad credential');
  };
  return {
    id,
    kind: 'mock',
    capabilities: { authKind: 'none', search: true, thumbnails: true, expiringUrls: false, publish: options.publish === true },
    ...(options.publish
      ? { async publishAsset(input: { name: string; format: string; bytes: Uint8Array }) { return { remoteId: `cmp-${input.name}.${input.format}`, url: `https://mock.dam/${input.name}` }; } }
      : {}),
    async listAssets(cursor) {
      check();
      counted(id).list += 1;
      if (!pageSize) return { assets };
      const start = cursor ? Math.max(0, Number(cursor) || 0) : 0;
      const end = Math.min(total, start + pageSize);
      const page: ProviderAssetRef[] = [];
      for (let k = start; k < end; k++) page.push(at(k));
      return { assets: page, ...(end < total ? { next: String(end) } : {}) };
    },
    async searchAssets(query, limit) {
      check();
      const q = query.toLowerCase();
      const found: ProviderAssetRef[] = [];
      for (let k = 0; k < total && found.length < limit; k++) {
        const a = at(k);
        if (a.name.toLowerCase().includes(q)) found.push(a);
      }
      return found;
    },
    async resolveBlob(remoteId, formatRef) {
      check();
      counted(id).blob += 1;
      if (options.failBlobFor?.includes(remoteId)) throw new Error(`mock blob refused for ${remoteId}`);
      const g = gen ? generatedIndex(remoteId, gen) : -1;
      if (g >= 0 && (formatRef === 'thumb' || formatRef === 'f1')) {
        const { bytes, contentType } = generatedBlob(g, gen!, formatRef);
        return {
          kind: 'stream',
          body: new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(bytes); controller.close(); } }),
          contentType,
          size: bytes.length,
        };
      }
      const asset = assets.find((a) => a.remoteId === remoteId);
      const fmt = asset?.formats.find((f) => f.remoteRef === formatRef);
      if (!asset || (!fmt && formatRef !== 'thumb')) throw new Error(`unknown blob ${remoteId}/${formatRef}`);
      const bytes = options.blobBase64?.[remoteId]
        ? new Uint8Array(Buffer.from(options.blobBase64[remoteId], 'base64'))
        : new TextEncoder().encode(options.blobText?.[remoteId] ?? `mock:${id}:${remoteId}:${formatRef}`);
      return {
        kind: 'stream',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: options.blobContentType?.[remoteId] ?? 'application/octet-stream',
        size: bytes.length,
      };
    },
    async healthCheck() {
      try {
        check();
        return { ok: true };
      } catch (err) {
        return { ok: false, detail: (err as Error).message };
      }
    },
  };
}
