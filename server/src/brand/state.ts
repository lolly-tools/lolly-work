import type { InstancePackMeta } from '../catalog/instance-pack.ts';

/** A manager's edit that is live on one source: a pointer, so going live and
 *  rolling back commit with their audit event. Rollback drops it. */
export interface BrandEditPointer {
  revision: number;
  digest: string;
  blobId: string;
  /** The mounted tokens checksum the edit was made on. */
  baseChecksum: string;
  /** The mounted tokens checksum a person last looked at this edit against. */
  lookedAtBase?: string;
  /** A connect pack derived from the kept one. Absent when none could be derived. */
  pack?: { blobId: string; sourceRevision: string; meta: InstancePackMeta };
}

/** What an administrator has chosen. Both are off until someone turns them on. */
export interface BrandEditPolicy {
  /** A chain id. Set, an edit goes live only when the chain approves it. */
  approvalChain: string | null;
  /** After a new image, ask people who can edit to look at a live edit. It stays live meanwhile. */
  lookAfterImage: boolean;
}

/** Operator decisions are separate from the deployment's boot defaults. */
export interface BrandState {
  rulePolicies?: Record<string, import('./rules.ts').ManagedRulePolicy>;
  /** The live edit per source. Absent on a source that runs its mounted tokens. */
  edits?: Record<string, BrandEditPointer>;
  editPolicy?: BrandEditPolicy;
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

export const brandEditPolicy = (state: BrandState): BrandEditPolicy => ({ approvalChain: state.editPolicy?.approvalChain ?? null, lookAfterImage: state.editPolicy?.lookAfterImage === true });

export function initialBrandState(): BrandState {
  return { revision: 0, activeSource: null, retired: [], download: {
    suppressed: false, sourceId: null, sourceRevision: null, blobId: null, meta: null,
  } };
}
