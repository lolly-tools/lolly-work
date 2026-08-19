/**
 * Catalog providers - federated third-party asset sources (plans/17).
 *
 * A provider is an admin-configured, READ-ONLY connector to an external
 * system (Brandfolder, S3, git, Dropbox, …) that stays the source of truth.
 * Its assets federate into the served assets/index.json feed namespaced
 * `ext/<providerId>/<remoteId>`, so lifecycle rows, grants, and render cache
 * invalidation work on them unchanged. Lolly stores only references plus its
 * own governance overlays - deleting a provider never touches remote content.
 *
 * Types only in this module; drivers live beside it, one file per kind, all
 * behind `CatalogProvider` with an injectable fetch (no SDKs - plans/17 §13
 * also requires publicly documented endpoints only).
 */
import type { AssetIndexEntry } from '../lifecycle.ts';
import type { ProviderShapeReport } from './shape.ts';

export type { ProviderShapeReport };

export const PROVIDER_KINDS = ['webdav', 'brandfolder', 's3', 'git', 'dropbox', 'gdrive', 'o365', 'optimizely-cmp', 'imagerelay', 'canto', 'acquia-dam', 'intelligencebank', 'penpot', 'mock'] as const;
export type ProviderKind = (typeof PROVIDER_KINDS)[number];

/** Prefix every federated asset id carries; also the blob route mount. */
export const EXT_PREFIX = 'ext/';

export function extAssetId(providerId: string, remoteId: string): string {
  return `${EXT_PREFIX}${providerId}/${remoteId}`;
}

/** Lowercased extension from a filename/path (no dot), or `fallback` when there is none.
 *  Shared across drivers that derive a native type / MIME lookup from a name. */
export function extOf(name: string, fallback = 'bin'): string {
  return name.includes('.') ? (name.split('.').pop() as string).toLowerCase() : fallback;
}

/** Drop a trailing "<dot><ext>" from a filename - the display name a driver stamps
 *  onto ProviderAssetRef.name when the upstream has no separate title field. */
export function stripExt(name: string): string {
  return name.replace(/\.[^.]+$/, '');
}

export interface ProviderCapabilities {
  /** Provider supports server-side search (live fan-out from /api/v1/catalog/search). */
  search: boolean;
  thumbnails: boolean;
  /** Blob URLs are signed + short-lived - never persist them; resolve per request. */
  expiringUrls: boolean;
  /** Provider accepts lolly-generated exports pushed OUT to it (plans/27 §10 - 
   *  Optimizely CMP two-way). Off for every read-only source; the publish route
   *  refuses a provider that does not declare it. */
  publish?: boolean;
}

/** One lolly-rendered export being published out to a destination provider
 *  (plans/27 §10). Only ever a signed lolly export - never a federated or pack
 *  asset (the route verifies the C2PA export assertion before calling here). */
export interface PublishInput {
  bytes: Uint8Array;
  name: string;
  format: string;
  contentType: string;
}

/** How provider-native metadata maps into catalog entries. */
export interface ProviderMapping {
  /** Provider-native type → catalog type (e.g. Brandfolder 'Color' → 'palette'). */
  typeMap?: Record<string, string>;
  /** Catalog type when typeMap has no match. */
  defaultType?: string;
  /** Fold provider sections/folders into entry tags (default true). */
  sectionTags?: boolean;
  /**
   * For DAMs that model availability as custom metadata rather than native
   * fields (Image Relay terms, IntelligenceBank custom fields - plans/27 §9):
   * the upstream field names a driver reads the availability window from.
   * DAMs with native availability fields (Brandfolder, Acquia/Widen) ignore
   * this and map their own fields directly.
   */
  availabilityFields?: { from?: string; until?: string };
}

/** Governance: which slice of the provider federates, and to whom (plans/17 §6). */
export interface ProviderExposure {
  /** Member groups that see these assets; '*' or absent = all members. */
  groups?: string[] | '*';
  /** Only assets the provider itself marks approved (e.g. Brandfolder `approved`). */
  requireApproved?: boolean;
  /** Provider-native scoping (section/folder names); absent = everything. */
  includeSections?: string[];
  excludeTags?: string[];
  /** Catalog tier stamped on entries. */
  tier?: string;
}

export interface ProviderSyncConfig {
  /** Fragment cache TTL before a background refresh (default 300). */
  ttlSeconds?: number;
}

/** One provider's mapped slice of the feed - cached in-process and persisted
 *  as last-good fallback so a cold boot or outage still serves something. */
export interface ProviderFragment {
  assets: AssetIndexEntry[];
  syncedAt: string;
  /** Content hash, folded into catalogVersion so refreshes ripple render invalidation. */
  hash: string;
  /** Records the driver could not map, summed over the walk (plans/33 §5).
   *  Absent when nothing was skipped; never silent when something was. */
  skipped?: number;
  /** Driver diagnostics from the walk: a guessed key that never matched, each
   *  naming the constant to edit and its runbook page. */
  notes?: string[];
}

/** Runtime state - written by sync, never by admins. */
export interface ProviderState {
  lastSyncAt?: string;
  lastError?: string;
  assetCount: number;
  fragment?: ProviderFragment;
}

export interface ProviderRecord {
  id: string;
  kind: ProviderKind;
  label: string;
  /** 'config' rows come from instance.json at boot and are read-only in the API. */
  managedBy: 'db' | 'config';
  /** Kill switch - false on creation; enabling is a separately-audited action. */
  enabled: boolean;
  options: Record<string, unknown>;
  mapping: ProviderMapping;
  exposure: ProviderExposure;
  sync: ProviderSyncConfig;
  /** Sealed credential (lib/crypto sealSecret) - never serialized to any API. */
  credentialCiphertext?: Uint8Array;
  /** Display-safe: sha256 prefix + last-4. The only credential shape APIs return. */
  credentialFingerprint?: string;
  credentialUpdatedAt?: string;
  createdBy?: string;
  createdAt: string;
  updatedAt: string;
  state: ProviderState;
}

// --- driver interface ---

export interface ProviderFormatRef {
  format: string;
  /** Opaque driver-internal ref resolved by resolveBlob - NEVER a caller-supplied URL. */
  remoteRef: string;
  size?: number;
  /** Upstream original filename - carried into export provenance (plans/17):
   *  even when the source has no C2PA manifest, "«filename» from «provider»"
   *  travels with anything a tool makes from this asset. */
  filename?: string;
}

export interface ProviderAssetRef {
  remoteId: string;
  name: string;
  description?: string;
  /** Provider-native type, mapped through ProviderMapping into a catalog type. */
  nativeType: string;
  /** Provider-native section/folder names (exposure scoping + tags). */
  sections: string[];
  tags: string[];
  approved?: boolean;
  updatedAt?: string;
  /**
   * Availability window imported from the upstream DAM (ISO - plans/27 §2).
   * Folded onto the fragment entry and combined most-restrictive-wins with any
   * local lifecycle row at both gate sites. Absent for providers with no such
   * API - the manual `catalog.expire` arm is then the whole story.
   */
  availableFrom?: string;
  availableUntil?: string;
  formats: ProviderFormatRef[];
  hasThumbnail?: boolean;
}

export type ResolvedBlob =
  | { kind: 'redirect'; url: string; expiresAt?: string }
  | { kind: 'stream'; body: ReadableStream<Uint8Array>; contentType: string; size?: number };

/**
 * One page of a provider's listing. `skipped` and `notes` are the visibility
 * plans/33 §5 asks for: a federation that quietly maps 0 of 100 records is the
 * most expensive way to lose an afternoon, so a record the mapper could not
 * turn into an asset is counted, and a mapping that never matched says so in
 * words the operator can act on. Both are optional - a driver with nothing to
 * report omits them and the count reads as zero.
 */
export interface ProviderPage {
  assets: ProviderAssetRef[];
  next?: string;
  /** Records on this page the mapper could not turn into assets. */
  skipped?: number;
  /** Operator-facing diagnostics that are not fatal (a guessed key that never
   *  matched). Each names the constant to edit and its runbook page. */
  notes?: string[];
}

export interface CatalogProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  readonly capabilities: ProviderCapabilities;
  listAssets(cursor?: string): Promise<ProviderPage>;
  /** Live-verify aid (plans/33 §3): the STRUCTURE of one upstream page - key
   *  names and value types, never values - plus the keys this driver reads and
   *  the diff between the two. Optional: a driver whose field names are
   *  confirmed carries no live-verify debt and need not implement it. */
  sampleShape?(): Promise<ProviderShapeReport>;
  /** The same aid for the OTHER call: the per-asset DETAIL response
   *  `resolveBlob` makes, whose wrapper and download-link keys a list page
   *  cannot answer - and those are the guesses that decide whether the exit
   *  works at all. Optional: a driver whose bytes need no detail call (canto
   *  builds its binary path from the list record) implements only the list arm. */
  detailShape?(remoteId: string): Promise<ProviderShapeReport>;
  searchAssets?(query: string, limit: number): Promise<ProviderAssetRef[]>;
  /** Resolve ONE asset's ref by remoteId WITHOUT scanning listAssets - the seam the
   *  /import route uses to snapshot a single search-only result (plans/30 §3.1). A
   *  provider whose assets are all enumerable via listAssets can omit it (the route
   *  falls back to a listAssets scan); returns null when the id is unknown. */
  getAsset?(remoteId: string): Promise<ProviderAssetRef | null>;
  /** `formatRef` is a remoteRef from this driver's own ProviderFormatRef (or 'thumb'). */
  resolveBlob(remoteId: string, formatRef: string): Promise<ResolvedBlob>;
  /** Push a lolly-generated export INTO the destination (plans/27 §10). Only
   *  present when `capabilities.publish` - the publish route gates on both. */
  publishAsset?(input: PublishInput): Promise<{ remoteId: string; url?: string }>;
  healthCheck(): Promise<{ ok: boolean; detail?: string }>;
}
