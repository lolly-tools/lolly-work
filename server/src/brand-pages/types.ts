// SPDX-License-Identifier: MPL-2.0
/** What a brand page is on this server: one record per address, and immutable
 *  revisions under it, of which at most one is current. */
import type { BrandPageManifest } from './manifest.ts';

export interface BrandPagesConfig {
  /** Off by default. While off, every brand page route answers as if it were not here. */
  enabled: boolean;
  /** The largest bundle, and the most its files may add up to. */
  maxBundleBytes: number;
  maxFileBytes: number;
  /** What this instance holds across all revisions of all pages. */
  instanceBudgetBytes: number;
  /** Revisions whose bytes are kept for each page, the current one included. Older
   *  ones stay in the history with their digests. */
  keepRevisions: number;
  /** An approval chain id. Set, a new revision goes live only when the chain approves it. */
  approvalChain?: string;
}

export const BRAND_PAGES_DEFAULTS: BrandPagesConfig = {
  enabled: false, maxBundleBytes: 64 * 1024 * 1024, maxFileBytes: 32 * 1024 * 1024, instanceBudgetBytes: 1024 * 1024 * 1024, keepRevisions: 10,
};
/** The configured settings with defaults filled in; tolerates a hand-built config that omits the block. */
export const brandPagesConfig = (config: { brandPages?: BrandPagesConfig }): BrandPagesConfig => ({ ...BRAND_PAGES_DEFAULTS, ...config.brandPages });

export const BRAND_PAGE_ACTION = 'brand.page.publish';
/** The instance's published pages. The first is a Lolly convention and may belong to
 *  a shell on a shared origin, so the second is the address a client can rely on. */
export const BRAND_PAGE_INDEX_PATH = '/.well-known/lolly-brand.json';
export const BRAND_PAGE_PUBLIC_API = '/api/v1/brand-pages/public';

/** `staged` while its bytes are being written. `pending` waits on an approval chain.
 *  `live` is the current one. `superseded` was replaced by a later revision and
 *  `unpublished` was taken down. `rejected` and `withdrawn` never went live.
 *  `failed` never finished storing. */
export const BRAND_PAGE_STATES = ['staged', 'pending', 'live', 'superseded', 'unpublished', 'rejected', 'withdrawn', 'failed'] as const;
export type BrandPageState = typeof BRAND_PAGE_STATES[number];

export interface BrandPageRecord {
  slug: string;
  name: string;
  /** The live revision's number, or null when nothing is served. */
  current: number | null;
  /** Set by unpublish, and cleared when a revision next goes live. It is what makes a page answer 410. */
  unpublishedAt: string | null;
  unpublishedBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface BrandPageRevisionSummary {
  /** `<slug>:<n>`, stable, and the cursor for a person's data export. */
  id: string;
  slug: string;
  n: number;
  name: string;
  digest: string;
  /** What the listed files add up to, in bytes. */
  size: number;
  fileCount: number;
  publishedBy: string;
  state: BrandPageState;
  approvalId: string | null;
  createdAt: string;
  liveAt: string | null;
  /** Set once this revision's files are gone. The history row stays. */
  bytesRemovedAt: string | null;
}

export interface BrandPageRevision extends BrandPageRevisionSummary { manifest: BrandPageManifest }

export interface BrandPageStore {
  getBrandPage(slug: string): Promise<BrandPageRecord | null>;
  listBrandPages(limit: number): Promise<BrandPageRecord[]>;
  /** Newest first. */
  listBrandPageRevisions(slug: string, limit: number): Promise<BrandPageRevisionSummary[]>;
  getBrandPageRevision(slug: string, n: number): Promise<BrandPageRevision | null>;
  /** Assigns the next number for the slug, creating the page's record on first use. */
  stageBrandPageRevision(input: { slug: string; name: string; digest: string; manifest: BrandPageManifest; size: number; fileCount: number; publishedBy: string; at: string }): Promise<BrandPageRevision>;
  /** Moves a revision between states; false when it was not in one of `from`. */
  setBrandPageRevisionState(slug: string, n: number, from: readonly BrandPageState[], to: BrandPageState, patch?: { approvalId?: string }): Promise<boolean>;
  /** Makes a revision the current one in one step: the old one becomes superseded and any unpublish is cleared. */
  promoteBrandPageRevision(slug: string, n: number, from: readonly BrandPageState[], at: string): Promise<boolean>;
  /** Stops serving a page in one step. Null when no such page; a page with nothing live stays as it is. */
  unpublishBrandPage(slug: string, by: string, at: string): Promise<BrandPageRecord | null>;
  markBrandPageBytesRemoved(slug: string, n: number, at: string): Promise<boolean>;
  /** The bytes every revision still holding files adds up to. */
  brandPageBytesHeld(): Promise<number>;
  /** Each page's live revision, by slug. */
  listLiveBrandPageRevisions(limit: number): Promise<BrandPageRevisionSummary[]>;
}

const wholeBytes = (value: unknown, name: string, max: number): number => {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > max) throw new Error(`brandPages.${name} must be a whole number of bytes from 1 to ${max}`);
  return value as number;
};

/** `brandPages` in the instance config. Unknown keys are refused, as a typo in a
 *  public feature's settings should not pass quietly. */
export function checkBrandPagesConfig(value: unknown, transferMaxBytes: number): BrandPagesConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('brandPages must be an object');
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) if (!['enabled', 'maxBundleBytes', 'maxFileBytes', 'instanceBudgetBytes', 'keepRevisions', 'approvalChain'].includes(key)) throw new Error(`brandPages has an unknown key: ${key}`);
  if (typeof raw.enabled !== 'boolean') throw new Error('brandPages.enabled must be true or false');
  const maxBundleBytes = wholeBytes(raw.maxBundleBytes, 'maxBundleBytes', transferMaxBytes);
  const maxFileBytes = wholeBytes(raw.maxFileBytes, 'maxFileBytes', maxBundleBytes);
  const instanceBudgetBytes = wholeBytes(raw.instanceBudgetBytes, 'instanceBudgetBytes', Number.MAX_SAFE_INTEGER);
  if (instanceBudgetBytes < maxBundleBytes) throw new Error('brandPages.instanceBudgetBytes must be at least maxBundleBytes');
  if (!Number.isSafeInteger(raw.keepRevisions) || (raw.keepRevisions as number) < 1 || (raw.keepRevisions as number) > 1000) throw new Error('brandPages.keepRevisions must be a whole number from 1 to 1000');
  if (raw.approvalChain !== undefined && (typeof raw.approvalChain !== 'string' || !raw.approvalChain)) throw new Error('brandPages.approvalChain must be a chain id');
  return { enabled: raw.enabled, maxBundleBytes, maxFileBytes, instanceBudgetBytes, keepRevisions: raw.keepRevisions as number, ...(raw.approvalChain ? { approvalChain: raw.approvalChain as string } : {}) };
}
