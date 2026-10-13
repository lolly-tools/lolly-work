// SPDX-License-Identifier: MPL-2.0
/** Bounded attempts per link and source address. */
export function createLinkPasswordAttempts(now: () => number = Date.now, maxEntries = 10000) {
  const entries = new Map<string, { misses: number; until: number }>();
  const keyOf = (link: string, client: string) => JSON.stringify([link, client]);
  return {
    retryAfter(link: string, client: string): number {
      const key = keyOf(link, client), value = entries.get(key);
      if (value && value.until <= now()) { entries.delete(key); return 0; }
      return value && value.misses >= 10 ? Math.max(1, Math.ceil((value.until - now()) / 1000)) : 0;
    },
    miss(link: string, client: string): void {
      const key = keyOf(link, client), time = now();
      const prior = entries.get(key);
      const next = prior && prior.until > time ? { ...prior, misses: prior.misses + 1 } : { misses: 1, until: time + 15 * 60 * 1000 };
      entries.delete(key);
      if (entries.size >= maxEntries) {
        for (const [id, entry] of entries) if (entry.until <= time) entries.delete(id);
        if (entries.size >= maxEntries) entries.delete(entries.keys().next().value!);
      }
      entries.set(key, next);
    },
    clear(link: string, client: string): void { entries.delete(keyOf(link, client)); },
    get size(): number { return entries.size; },
  };
}
