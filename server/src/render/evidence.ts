import type { WorkerEvidence } from './worker-client.ts';
import type { ProductionReport } from './production.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import type { AssetRef } from './contract.ts';
import type { OutputInspection } from './output-inspection.ts';
import { resolveInputAccess, type ResolvedAccess, type ToolOverlay } from '../policy/overlay.ts';

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
  brandRules?: import('../brand/rules.ts').ManagedRuleReport;
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
  /** Final-byte measurements; absent on receipts made before output inspection. */
  inspection?: OutputInspection;
  production?: ProductionReport;
  productionAttempts?: ProductionReport[];
  worker?: WorkerEvidence;
  /** Resolved facts that the context does not name; absent on older receipts. */
  resolved?: ResolvedRenderFacts;
}

export interface ResolvedRenderFacts {
  /** The design-system revision the attempt rendered against, or null without one. */
  designRevision: string | null;
  /** The policy this render obeyed, from {@link effectivePolicySha256}. */
  effectivePolicySha256: string;
}

export const evidenceHash = (value: unknown): string => sha256Hex(canonicalJson(value));

/** The policy one caller rendered under: this tool's enforcement settings, the
 *  access each named input resolves to for the caller's groups, and any managed
 *  design-system rules. Editable inputs, rules for other groups, attribution
 *  text and the overlay's version counter are left out, so an overlay edit that
 *  does not change what this caller may do keeps the digest. Pass the overlay
 *  after design-system rules are projected into it. */
export function effectivePolicySha256(overlay: ToolOverlay | undefined, groups: string[], inputIds: Iterable<string>, rules: unknown): string {
  const ids = new Set(inputIds);
  for (const id of Object.keys(overlay?.inputAccess ?? {})) if (id !== '*') ids.add(id);
  const access: Record<string, Pick<ResolvedAccess, 'level' | 'value' | 'allow'>> = {};
  for (const id of [...ids].sort()) {
    const resolved = resolveInputAccess(overlay, id, groups);
    if (resolved.level === 'editable') continue;
    access[id] = { level: resolved.level, ...('value' in resolved ? { value: resolved.value ?? null } : {}), ...(resolved.allow ? { allow: resolved.allow } : {}) };
  }
  return evidenceHash({ enforce: overlay?.enforce ?? null, access, rules: rules ?? null });
}

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

/** The output-affecting half of a durable request. Priority and attempts only schedule it. */
export interface IdentityRequest {
  toolId: string;
  format: string;
  inputs: Record<string, unknown>;
  verification?: unknown;
  production?: unknown;
}

/** What a render resolved to: the typed request, the loaded tool source, the
 *  engine, the sources it read and the effective policy. Output bytes and
 *  runtime measurements are left out, so attempts that resolved the same
 *  facts share one identity. Coverage follows the receipt it comes from. */
export interface RenderIdentity {
  apiVersion: 'work/render-identity-v1';
  id: string;
  coverage: 'partial';
  request: { toolId: string; format: string; sha256: string };
  tool: { id: string; version: string; sourceHash: string };
  engine: { version: string; documentApiVersion: string };
  sources: { catalogVersion: string; designRevision: string | null; assets: ObservedAsset[] };
  policy: { effectiveSha256: string; groupsHash: string; watermark: boolean };
  context: Pick<RenderEvidence['context'], 'paramsHash' | 'profileHash' | 'widthPx' | 'heightPx' | 'renderer' | 'rasterizer' | 'signerCertificateHash'>;
  limitations: string[];
}

/** Bind a request to the facts its receipt resolved. Null when the receipt
 *  predates resolved facts; throws when it describes another tool or format.
 *  The v1 inputs are frozen: the evidence download recomputes stored v1
 *  identities, so hashing a field more or less, or changing which limitations
 *  are kept, needs a new apiVersion. tests/render-identity.test.ts pins one id. */
export function renderIdentity(request: IdentityRequest, evidence: RenderEvidence): RenderIdentity | null {
  if (evidence.tool.id !== request.toolId || evidence.context.format !== request.format) {
    throw new Error('execution evidence describes a different tool or format');
  }
  if (!evidence.resolved) return null;
  const { context, resolved } = evidence;
  // Worker network budgets and timeouts vary between attempts. They describe
  // the worker's observation, which the identity does not bind.
  const limitations = new Set(evidence.limitations.filter(item => !item.startsWith('worker-resource-')));
  if (context.renderer === 'chromium-worker') limitations.add('worker-resources-outside-identity');
  const body: Omit<RenderIdentity, 'id'> = {
    apiVersion: 'work/render-identity-v1',
    coverage: 'partial',
    request: { toolId: request.toolId, format: request.format, sha256: evidenceHash({
      toolId: request.toolId, format: request.format, inputs: request.inputs,
      verification: request.verification ?? null, production: request.production ?? null,
    }) },
    tool: { id: evidence.tool.id, version: evidence.tool.version, sourceHash: evidence.tool.sourceHash },
    engine: { version: evidence.engine.version, documentApiVersion: evidence.engine.documentApiVersion },
    sources: { catalogVersion: context.catalogVersion, designRevision: resolved.designRevision, assets: structuredClone(evidence.assets) },
    policy: { effectiveSha256: resolved.effectivePolicySha256, groupsHash: context.groupsHash, watermark: context.watermark },
    context: {
      paramsHash: context.paramsHash, profileHash: context.profileHash, widthPx: context.widthPx, heightPx: context.heightPx,
      renderer: context.renderer, rasterizer: context.rasterizer, signerCertificateHash: context.signerCertificateHash,
    },
    limitations: [...limitations].sort(),
  };
  return { ...body, id: evidenceHash(body) };
}
