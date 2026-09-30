import type { InstancePackMeta } from '../catalog/instance-pack.ts';

/** Operator decisions are separate from the deployment's boot defaults. */
export interface BrandState {
  rulePolicies?: Record<string, import('./rules.ts').ManagedRulePolicy>;
  revision: number;
  activeSource: string | null;
  retired: string[];
  download: {
    suppressed: boolean;
    sourceId: string | null;
    sourceRevision: string | null;
    blobId: string | null;
    meta: InstancePackMeta | null;
  };
}

export function initialBrandState(): BrandState {
  return { revision: 0, activeSource: null, retired: [], download: {
    suppressed: false, sourceId: null, sourceRevision: null, blobId: null, meta: null,
  } };
}
