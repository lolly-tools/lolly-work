/**
 * Content-credential DETECTION for imported/federated assets (plans/27 §4).
 *
 * A DAM asset's BYTES may embed a C2PA manifest the DAM's own API never
 * mentions (Brandfolder's v4 surfaces nothing C2PA-shaped). This module is a
 * thin wrapper over the vendored engine's container handling
 * (`extractC2paStore`, which sniffs the format and locates the JUMBF store
 * across every container the engine covers): it records only WHETHER a manifest
 * is present and in which container, then discards the store bytes.
 *
 * It is a DETECTOR, never a verifier - and never a second C2PA implementation
 * (plans/27 §11). It never parses claims and never says "valid" or "trusted":
 * validation belongs to verifiers (the engine's verify/verdict modules, which
 * stay client-side), and signing to `render/c2pa-signer.ts`. One C2PA
 * implementation across both repos, engine-owned and OSS-tested. Absence of a
 * finding is never proof of absence - a container the engine can't parse is
 * reported as 'none', honestly, not as "we checked and it's clean".
 */
import type { AssetIndex } from './lifecycle.ts';

export type CredentialStatus = 'embedded' | 'none';

export interface CredentialDetection {
  status: CredentialStatus;
  /** Container the manifest was found in (the engine's sniff format), when embedded. */
  container?: string;
}

/** Persisted overlay row - one per scanned asset. */
export interface CredentialRow {
  assetId: string;
  status: CredentialStatus;
  container?: string;
  /** When the sniff ran (ISO). */
  sniffedAt: string;
  /** Upstream `updatedAt` at scan time - lets a re-scan know the source changed. */
  sourceUpdatedAt?: string;
}

// Non-literal specifier keeps tsc from pulling the engine's browser-lib .ts
// source into this project's program (render/shot-provenance do the same);
// runtime resolves the vendored engine normally, and the import is lazy so the
// pure helpers below never load it.
const ENGINE_SPEC: string = '@lolly/engine';
async function loadEngine(): Promise<{
  extractC2paStore: (bytes: Uint8Array) => { store: Uint8Array; format: string } | null;
}> {
  return import(ENGINE_SPEC);
}

/**
 * Sniff whether `bytes` embed a C2PA manifest. Detection only - never throws;
 * a container the engine cannot parse (or an engine that fails to load) yields
 * 'none' rather than an error, and the store bytes are dropped either way.
 */
export async function detectCredential(bytes: Uint8Array): Promise<CredentialDetection> {
  try {
    const { extractC2paStore } = await loadEngine();
    const found = extractC2paStore(bytes);
    return found ? { status: 'embedded', container: found.format } : { status: 'none' };
  } catch {
    return { status: 'none' };
  }
}

/**
 * Annotate a served feed with `credential: 'embedded'` on every entry that has
 * an embedded-credential detection row (plans/27 §4). Additive and non-gating:
 * 'none' rows add nothing, no entry is ever dropped, and a feed with no
 * embedded detections is returned untouched (same reference).
 */
export function applyCredentialsToIndex(index: AssetIndex, rows: CredentialRow[]): AssetIndex {
  if (!Array.isArray(index.assets)) return index;
  const embedded = new Set(rows.filter((r) => r.status === 'embedded').map((r) => r.assetId));
  if (!embedded.size) return index;
  return {
    ...index,
    assets: index.assets.map((e) => (embedded.has(e.id) ? { ...e, credential: 'embedded' } : e)),
  };
}
