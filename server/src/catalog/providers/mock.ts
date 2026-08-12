/**
 * Mock provider driver — tests and `npm run demo` only. Assets, faults, and
 * search all come from `options`, so a test can stand up any federation
 * scenario (including outage → last-good fallback) without network.
 */
import type { CatalogProvider, ProviderAssetRef } from './types.ts';

export interface MockProviderOptions {
  assets?: ProviderAssetRef[];
  /** When set, listAssets/searchAssets/healthCheck all fail with this message. */
  failWith?: string;
  /** Require the resolved credential to equal this value (exercises seal/open). */
  expectSecret?: string;
}

export function createMockProvider(id: string, options: MockProviderOptions, secret?: string): CatalogProvider {
  const assets = options.assets ?? [];
  const check = (): void => {
    if (options.failWith) throw new Error(options.failWith);
    if (options.expectSecret !== undefined && secret !== options.expectSecret) throw new Error('bad credential');
  };
  return {
    id,
    kind: 'mock',
    capabilities: { search: true, thumbnails: true, expiringUrls: false },
    async listAssets() {
      check();
      return { assets };
    },
    async searchAssets(query, limit) {
      check();
      const q = query.toLowerCase();
      return assets.filter((a) => a.name.toLowerCase().includes(q)).slice(0, limit);
    },
    async resolveBlob(remoteId, formatRef) {
      check();
      const asset = assets.find((a) => a.remoteId === remoteId);
      const fmt = asset?.formats.find((f) => f.remoteRef === formatRef);
      if (!asset || (!fmt && formatRef !== 'thumb')) throw new Error(`unknown blob ${remoteId}/${formatRef}`);
      const bytes = new TextEncoder().encode(`mock:${id}:${remoteId}:${formatRef}`);
      return {
        kind: 'stream',
        body: new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(bytes);
            controller.close();
          },
        }),
        contentType: 'application/octet-stream',
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
