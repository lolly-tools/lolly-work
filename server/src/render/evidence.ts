import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import type { AssetRef } from './contract.ts';

export interface ObservedAsset {
  source: 'catalog' | 'provider';
  id: string;
  format: string;
  version?: string;
  sha256: string;
  size: number;
}

/** Work's execution receipt. This is not the engine's future dependency graph or lockfile. */
export interface RenderEvidence {
  apiVersion: '1.0.0';
  id: string;
  coverage: 'partial';
  engine: { version: string; documentApiVersion: string; scope: 'control-plane' };
  tool: {
    id: string; version: string; sourceHash: string;
    scope: 'local-runtime' | 'control-plane-validation';
    files: { path: string; sha256: string; size: number }[];
  };
  context: {
    paramsHash: string; profileHash: string; groupsHash: string;
    policyVersion: string; catalogVersion: string;
    format: string; widthPx: number | null; heightPx: number | null; watermark: boolean;
    renderer: 'work-jsdom' | 'chromium-worker';
    rasterizer: 'none' | 'resvg' | 'chromium-worker';
    signerCertificateHash: string | null;
  };
  runtime?: { initialValuesHash: string; hydratedHash: string; hookErrors: number; droppedAssets: number };
  assets: ObservedAsset[];
  limitations: string[];
  outputSha256: string;
}

export const evidenceHash = (value: unknown): string => sha256Hex(canonicalJson(value));

/** Observe actual host reads, never infer dependencies by inspecting a template. */
export function createAssetObserver() {
  const assets = new Map<string, ObservedAsset>();
  const limitations = new Set<string>();
  let retained = 0;
  let sealed = false;
  return {
    observe(source: ObservedAsset['source'], asset: AssetRef, bytes?: Uint8Array): void {
      if (sealed) return;
      if (!bytes) {
        const match = /^data:[^,]*;base64,([A-Za-z0-9+/=\s]*)$/s.exec(asset.url);
        if (match) bytes = new Uint8Array(Buffer.from(match[1]!, 'base64'));
      }
      if (!bytes) { limitations.add('asset-bytes-unobserved'); return; }
      const observed: ObservedAsset = {
        source, id: asset.id, format: asset.format,
        ...(asset.version ? { version: asset.version } : {}), sha256: sha256Hex(bytes), size: bytes.byteLength,
      };
      const key = canonicalJson(observed);
      if (assets.has(key)) return;
      const size = Buffer.byteLength(key);
      if (assets.size >= 256 || retained + size > 128 * 1024) {
        limitations.add('asset-observation-limit'); return;
      }
      retained += size; assets.set(key, observed);
    },
    finish(): { assets: ObservedAsset[]; limitations: string[] } {
      sealed = true;
      return {
        assets: [...assets.entries()].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([, asset]) => asset),
        limitations: [...limitations].sort(),
      };
    },
  };
}

export function finishRenderEvidence(value: Omit<RenderEvidence, 'id' | 'apiVersion' | 'coverage' | 'outputSha256'>, bytes: Uint8Array): RenderEvidence {
  const body = { apiVersion: '1.0.0' as const, coverage: 'partial' as const, ...value, outputSha256: sha256Hex(bytes) };
  return { ...body, id: evidenceHash(body) };
}
