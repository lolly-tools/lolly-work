// SPDX-License-Identifier: MPL-2.0
import type { ProviderRecord, ProviderFragment } from './providers/types.ts';
import { callerSeesProvider } from './federation.ts';
export function visibleSourceStatuses(records: ProviderRecord[], fragments: Array<{ rec: ProviderRecord; fragment: ProviderFragment; stale: boolean }>, groups: string[], visibleIds: Set<string>) {
  const byId = new Map(fragments.map(f => [f.rec.id, f]));
  return records.filter(rec => rec.enabled && callerSeesProvider(rec, groups)).map(rec => {
    const cached = byId.get(rec.id);
    return { id: rec.id, label: rec.label, status: rec.state.lastError ? cached ? 'stale' : 'unavailable' : cached ? cached.stale ? 'stale' : 'current' : 'pending',
      ...(cached ? { count: cached.fragment.assets.filter(a => visibleIds.has(a.id)).length, lastSyncedAt: cached.fragment.syncedAt } : {}) };
  });
}
