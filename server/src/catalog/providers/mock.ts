/**
 * Mock provider driver - tests and `npm run demo` only. Assets, faults, and
 * search all come from `options`, so a test can stand up any federation
 * scenario (including outage → last-good fallback) without network.
 */
import type { CatalogProvider, ProviderAssetRef } from './types.ts';

export interface MockProviderOptions {
  assets?: ProviderAssetRef[];
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
    capabilities: { search: true, thumbnails: true, expiringUrls: false, publish: options.publish === true },
    ...(options.publish
      ? { async publishAsset(input: { name: string; format: string; bytes: Uint8Array }) { return { remoteId: `cmp-${input.name}.${input.format}`, url: `https://mock.dam/${input.name}` }; } }
      : {}),
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
      if (options.failBlobFor?.includes(remoteId)) throw new Error(`mock blob refused for ${remoteId}`);
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
