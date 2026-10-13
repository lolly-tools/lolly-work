// SPDX-License-Identifier: MPL-2.0
import type { EngineApi } from './contract.ts';
import type { RenderFileScope } from './read-ticket.ts';

/** Translate only references already admitted into this render's read ticket. */
function projectAsset(value: unknown, baseUrl: string, files?: RenderFileScope, assetSlot = false): unknown {
  const address = (id: unknown): string | undefined => {
    if (typeof id !== 'string' || !files) return;
    const match = /^user\/team\/([A-Za-z0-9_-]+)$/.exec(id);
    if (!match || !files.ids.includes(match[1]!)) return;
    return new URL(`/api/v1/projects/${encodeURIComponent(files.projectId)}/files/${encodeURIComponent(match[1]!)}`, baseUrl).href;
  };
  if (typeof value === 'string') return assetSlot ? address(value) ?? value : value;
  if (Array.isArray(value)) return value.map(item => projectAsset(item, baseUrl, files));
  if (value && typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const url = ['user', 'library', 'remote'].includes(String(record.source)) ? address(record.id) : undefined;
    if (url) return { ...record, source: 'remote', id: url, url };
    return Object.fromEntries(Object.entries(record).map(([key, item]) => [key, projectAsset(item, baseUrl, files)]));
  }
  return value;
}

/** Preserve the engine's asset wire grammar when passing parsed inputs to a browser. */
export function workerQuery(engine: EngineApi, model: ReturnType<EngineApi['buildInputModel']>, values: Record<string, unknown>, baseUrl: string, files?: RenderFileScope): string {
  const assetIds = new Set(model.filter(input => input.type === 'asset').map(input => input.id));
  const query = new URLSearchParams();
  for (const [key, original] of Object.entries(values)) {
    if (original === undefined || original === null) continue;
    const value = projectAsset(original, baseUrl, files, assetIds.has(key));
    if (assetIds.has(key)) {
      const serialized = engine.serializeUrlState([{ id: key, type: 'asset', value }], { keepUserIds: true, inlineBakedAssets: true });
      for (const [name, data] of new URLSearchParams(serialized)) query.set(name, data);
    } else query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return query.toString();
}
