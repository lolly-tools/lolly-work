/**
 * A bounded in-memory cache of federated bytes (`/catalog/ext/*` originals
 * and thumbnails), so a grid of DAM thumbnails does not ask the upstream for
 * the same few kilobytes on every view.
 *
 * Keys carry the fragment entry's version, so a change in the DAM is a
 * different key and the old bytes simply age out. The cache never decides who
 * may see bytes: the route runs every visibility and lifecycle gate before it
 * looks here, on every request.
 *
 * Least recently used goes first once the total passes `maxBytes`; an item
 * larger than `maxItemBytes` is never kept.
 */
import { Transform, type TransformCallback } from 'node:stream';

export interface ExtCacheItem {
  bytes: Buffer;
  contentType: string;
}

export interface ExtCache {
  get(key: string): ExtCacheItem | undefined;
  put(key: string, item: ExtCacheItem): void;
  /** A pass-through stream that keeps a copy of what flows through and
   *  stores it under `key` once the stream ends, unless it grew past the item
   *  limit. A stream that errors stores nothing. */
  tee(key: string, contentType: string): Transform;
  stats(): { items: number; bytes: number; hits: number; misses: number };
}

export function extCacheKey(parts: { provider: string; remoteId: string; formatRef: string; preview: boolean; version: string }): string {
  return [parts.provider, parts.remoteId, parts.formatRef, parts.preview ? 'preview' : 'file', parts.version].join('\n');
}

export function createExtCache(opts: { maxBytes: number; maxItemBytes: number }): ExtCache {
  const items = new Map<string, ExtCacheItem>();
  let total = 0;
  let hits = 0;
  let misses = 0;
  const enabled = opts.maxBytes > 0 && opts.maxItemBytes > 0;

  const put = (key: string, item: ExtCacheItem): void => {
    if (!enabled || item.bytes.length > opts.maxItemBytes || item.bytes.length > opts.maxBytes) return;
    const prior = items.get(key);
    if (prior) {
      total -= prior.bytes.length;
      items.delete(key);
    }
    items.set(key, item);
    total += item.bytes.length;
    while (total > opts.maxBytes) {
      const oldest = items.keys().next().value as string;
      total -= (items.get(oldest) as ExtCacheItem).bytes.length;
      items.delete(oldest);
    }
  };

  return {
    get(key) {
      const hit = enabled ? items.get(key) : undefined;
      if (!hit) {
        misses += 1;
        return undefined;
      }
      hits += 1;
      items.delete(key);
      items.set(key, hit);
      return hit;
    },
    put,
    tee(key, contentType) {
      const chunks: Buffer[] = [];
      let size = 0;
      let keep = enabled;
      return new Transform({
        transform(chunk: Buffer, _enc: BufferEncoding, cb: TransformCallback) {
          if (keep) {
            size += chunk.length;
            if (size > opts.maxItemBytes) {
              keep = false;
              chunks.length = 0;
            } else {
              chunks.push(Buffer.from(chunk));
            }
          }
          cb(null, chunk);
        },
        flush(cb: TransformCallback) {
          if (keep) put(key, { bytes: Buffer.concat(chunks), contentType });
          cb();
        },
      });
    },
    stats: () => ({ items: items.size, bytes: total, hits, misses }),
  };
}
