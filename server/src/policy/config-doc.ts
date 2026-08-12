/**
 * Policy-as-code (plan Rec 2) — the canonical governance document.
 *
 * Makes an instance's governance reproducible from git and seedable in one
 * command: grants, tool overlays, approval chains, DB-managed catalog-provider
 * CONFIG + EXPOSURE, and feature-flag governance — serialized deterministically
 * so logically-equal states hash identically. Credentials, provider runtime
 * state, and the enable kill-switch are NEVER in the document.
 *
 * Pure functions (canonicalize/build/validate/diff/requiredActions) are HTTP-free
 * and unit-testable; commitConfigApply takes a Store so it runs against memory in
 * tests and the same orchestrator backs both the apply route and the boot seeder.
 */
import { createHash } from 'node:crypto';
import type { Store } from '../store/types.ts';
import { ownerOnlyAction, type Grant, type Effect } from '../rbac/evaluate.ts';
import { normalizeOverlay, type ToolOverlay } from './overlay.ts';
import { normalizeChain, type Chain } from '../approvals/engine.ts';
import { normalizeFlagGovernance, isGovernableFlag, type FlagDefault, type FlagVisibility } from './feature-flags.ts';
import { PROVIDER_KINDS, type ProviderKind, type ProviderMapping, type ProviderExposure, type ProviderSyncConfig } from '../catalog/providers/types.ts';

export const CONFIG_DOC_KIND = 'lolly-work/config';
export const CONFIG_DOC_VERSION = 1 as const;

/** An overlay minus its runtime `version` (which churns and isn't policy). */
export interface OverlayExport {
  toolId: string;
  inputAccess?: ToolOverlay['inputAccess'];
  visibility?: ToolOverlay['visibility'];
  enforce?: ToolOverlay['enforce'];
  defaults?: ToolOverlay['defaults'];
}
/** Feature-flag governance minus `updatedAt`; no-opinion fields omitted. */
export interface FlagExport { id: string; default?: FlagDefault; visibility?: FlagVisibility }
/** A DB-managed provider's config + exposure only — never credential/state/enabled/timestamps. */
export interface ProviderExport {
  id: string;
  kind: ProviderKind;
  label: string;
  options: Record<string, unknown>;
  mapping: ProviderMapping;
  exposure: ProviderExposure;
  sync: ProviderSyncConfig;
}
export interface ConfigDocument {
  kind: typeof CONFIG_DOC_KIND;
  version: typeof CONFIG_DOC_VERSION;
  exportedAt?: string;
  grants: Grant[];
  overlays: OverlayExport[];
  chains: Chain[];
  providers: ProviderExport[];
  featureFlags: FlagExport[];
}

// ── canonical serialization ───────────────────────────────────────────────────

/** Deep key-sort so logically-equal documents serialize identically (arrays keep
 *  order — callers sort arrays deterministically before hashing). */
export function canonicalize(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === 'object') {
    const o: Record<string, unknown> = {};
    for (const k of Object.keys(v as object).sort()) o[k] = canonicalize((v as Record<string, unknown>)[k]);
    return o;
  }
  return v;
}
function stripVolatile(d: ConfigDocument): Omit<ConfigDocument, 'exportedAt'> {
  const { exportedAt: _exportedAt, ...rest } = d;
  return rest;
}
export function canonicalJson(d: ConfigDocument): string {
  return JSON.stringify(canonicalize(stripVolatile(d)));
}
export function canonicalHash(d: ConfigDocument): string {
  return createHash('sha256').update(canonicalJson(d)).digest('hex');
}
const entityJson = (v: unknown): string => JSON.stringify(canonicalize(v));

// ── build (export) ────────────────────────────────────────────────────────────

const grantKey = (g: Grant): string => `${g.principal} ${g.action} ${g.resource} ${g.effect}`;

export async function buildConfigDocument(store: Store): Promise<ConfigDocument> {
  const grants = [...await store.listGrants()].sort((a, b) => (grantKey(a) < grantKey(b) ? -1 : 1));
  const overlays: OverlayExport[] = [...(await store.listOverlays()).values()]
    .map(({ version: _version, toolId, ...o }) => ({ toolId, ...o }))
    .sort((a, b) => (a.toolId < b.toolId ? -1 : 1));
  const chains = [...await store.listChains()].sort((a, b) => (a.id < b.id ? -1 : 1));
  const gov = await store.listFlagGovernance();
  const featureFlags: FlagExport[] = [...gov.values()]
    .filter((g) => g.default !== undefined || g.visibility !== undefined)
    .map((g) => ({ id: g.id, ...(g.default ? { default: g.default } : {}), ...(g.visibility ? { visibility: g.visibility } : {}) }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  const providers: ProviderExport[] = (await store.listProviders())
    .filter((p) => p.managedBy === 'db')
    .map((p) => ({ id: p.id, kind: p.kind, label: p.label, options: p.options, mapping: p.mapping, exposure: p.exposure, sync: p.sync }))
    .sort((a, b) => (a.id < b.id ? -1 : 1));
  return { kind: CONFIG_DOC_KIND, version: CONFIG_DOC_VERSION, exportedAt: new Date().toISOString(), grants, overlays, chains, providers, featureFlags };
}

// ── validation ──────────────────────────────────────────────────────────────

const PRINCIPAL_RE = /^(?:group:[^\s]+|user:[^\s]+|\*)$/;
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Validate an untrusted document into a typed ConfigDocument, reusing the SAME
 *  normalizers the live routes use. Errors are path-tagged and collected. */
export function validateConfigDocument(raw: unknown): { doc: ConfigDocument } | { errors: string[] } {
  const errors: string[] = [];
  if (!isObj(raw)) return { errors: ['document must be an object'] };
  if (raw.kind !== CONFIG_DOC_KIND) errors.push(`kind must be "${CONFIG_DOC_KIND}"`);
  if (raw.version !== CONFIG_DOC_VERSION) errors.push(`version must be ${CONFIG_DOC_VERSION}`);

  const grants: Grant[] = [];
  const rawGrants = Array.isArray(raw.grants) ? raw.grants : [];
  if (raw.grants !== undefined && !Array.isArray(raw.grants)) errors.push('grants must be an array');
  rawGrants.forEach((g, i) => {
    if (!isObj(g)) return void errors.push(`grants[${i}]: must be an object`);
    const { principal, action, resource, effect } = g as Record<string, unknown>;
    if (typeof principal !== 'string' || !PRINCIPAL_RE.test(principal)) errors.push(`grants[${i}]: principal must be group:<n> | user:<id> | *`);
    if (typeof action !== 'string' || !action) errors.push(`grants[${i}]: action required`);
    if (typeof resource !== 'string' || !resource) errors.push(`grants[${i}]: resource required`);
    if (effect !== 'allow' && effect !== 'deny') errors.push(`grants[${i}]: effect must be allow|deny`);
    if (typeof principal === 'string' && typeof action === 'string' && typeof resource === 'string' && (effect === 'allow' || effect === 'deny')) {
      grants.push({ principal, action, resource, effect: effect as Effect });
    }
  });

  const overlays: OverlayExport[] = [];
  const rawOverlays = Array.isArray(raw.overlays) ? raw.overlays : [];
  if (raw.overlays !== undefined && !Array.isArray(raw.overlays)) errors.push('overlays must be an array');
  rawOverlays.forEach((o, i) => {
    if (!isObj(o) || typeof o.toolId !== 'string') return void errors.push(`overlays[${i}]: toolId required`);
    const norm = normalizeOverlay(o.toolId, o, 0);
    if (!norm) return void errors.push(`overlays[${i}] (${o.toolId}): malformed overlay`);
    const { version: _v, toolId, ...rest } = norm;
    overlays.push({ toolId, ...rest });
  });

  const chains: Chain[] = [];
  const rawChains = Array.isArray(raw.chains) ? raw.chains : [];
  if (raw.chains !== undefined && !Array.isArray(raw.chains)) errors.push('chains must be an array');
  rawChains.forEach((c, i) => {
    if (!isObj(c) || typeof c.id !== 'string') return void errors.push(`chains[${i}]: id required`);
    const norm = normalizeChain(c.id, c);
    if (!norm) return void errors.push(`chains[${i}] (${c.id}): malformed chain`);
    chains.push(norm);
  });

  const featureFlags: FlagExport[] = [];
  const rawFlags = Array.isArray(raw.featureFlags) ? raw.featureFlags : [];
  if (raw.featureFlags !== undefined && !Array.isArray(raw.featureFlags)) errors.push('featureFlags must be an array');
  rawFlags.forEach((f, i) => {
    if (!isObj(f) || typeof f.id !== 'string') return void errors.push(`featureFlags[${i}]: id required`);
    if (!isGovernableFlag(f.id)) return void errors.push(`featureFlags[${i}]: unknown flag id "${f.id}"`);
    const norm = normalizeFlagGovernance(f.id, f, '');
    if (!norm) return void errors.push(`featureFlags[${i}] (${f.id}): malformed governance`);
    featureFlags.push({ id: norm.id, ...(norm.default ? { default: norm.default } : {}), ...(norm.visibility ? { visibility: norm.visibility } : {}) });
  });

  const providers: ProviderExport[] = [];
  const rawProviders = Array.isArray(raw.providers) ? raw.providers : [];
  if (raw.providers !== undefined && !Array.isArray(raw.providers)) errors.push('providers must be an array');
  rawProviders.forEach((p, i) => {
    if (!isObj(p)) return void errors.push(`providers[${i}]: must be an object`);
    const { id, kind, label, options, mapping, exposure, sync } = p as Record<string, unknown>;
    if (typeof id !== 'string' || !SLUG_RE.test(id)) errors.push(`providers[${i}]: id must be a slug`);
    if (typeof kind !== 'string' || !PROVIDER_KINDS.includes(kind as ProviderKind)) errors.push(`providers[${i}]: unknown kind "${String(kind)}"`);
    if (typeof label !== 'string' || !label) errors.push(`providers[${i}]: label required`);
    for (const [name, val] of [['options', options], ['mapping', mapping], ['exposure', exposure], ['sync', sync]] as const) {
      if (val !== undefined && !isObj(val)) errors.push(`providers[${i}]: ${name} must be an object`);
    }
    if (typeof id === 'string' && SLUG_RE.test(id) && typeof kind === 'string' && PROVIDER_KINDS.includes(kind as ProviderKind) && typeof label === 'string' && label) {
      providers.push({
        id, kind: kind as ProviderKind, label,
        options: isObj(options) ? options : {},
        mapping: (isObj(mapping) ? mapping : {}) as ProviderMapping,
        exposure: (isObj(exposure) ? exposure : {}) as ProviderExposure,
        sync: (isObj(sync) ? sync : {}) as ProviderSyncConfig,
      });
    }
  });

  if (errors.length) return { errors };
  return { doc: { kind: CONFIG_DOC_KIND, version: CONFIG_DOC_VERSION, grants, overlays, chains, providers, featureFlags } };
}

// ── diff ───────────────────────────────────────────────────────────────────

export interface CategoryDiff<T> { create: T[]; update: T[]; unchanged: T[]; delete: T[] }
export interface ConfigDiff {
  grants: CategoryDiff<Grant>;
  overlays: CategoryDiff<OverlayExport>;
  chains: CategoryDiff<Chain>;
  providers: CategoryDiff<ProviderExport>;
  featureFlags: CategoryDiff<FlagExport>;
  conflicts: string[];
}

// Keyed diff: identity-only categories (grants) never "update" (create/delete only);
// keyed categories compare canonical content. delete[] is populated only with prune.
function keyedDiff<T>(current: T[], incoming: T[], key: (t: T) => string, identityOnly: boolean, prune: boolean): CategoryDiff<T> {
  const cur = new Map(current.map((t) => [key(t), t]));
  const inc = new Map(incoming.map((t) => [key(t), t]));
  const out: CategoryDiff<T> = { create: [], update: [], unchanged: [], delete: [] };
  for (const [k, t] of inc) {
    const existing = cur.get(k);
    if (!existing) out.create.push(t);
    else if (identityOnly || entityJson(existing) === entityJson(t)) out.unchanged.push(t);
    else out.update.push(t);
  }
  if (prune) for (const [k, t] of cur) if (!inc.has(k)) out.delete.push(t);
  return out;
}

export function diffConfigDocument(current: ConfigDocument, incoming: ConfigDocument, opts: { prune: boolean }, configProviderIds: Set<string>): ConfigDiff {
  const conflicts: string[] = [];
  for (const p of incoming.providers) if (configProviderIds.has(p.id)) conflicts.push(`providers/${p.id}: config-managed`);
  return {
    grants: keyedDiff(current.grants, incoming.grants, grantKey, true, opts.prune),
    overlays: keyedDiff(current.overlays, incoming.overlays, (o) => o.toolId, false, opts.prune),
    chains: keyedDiff(current.chains, incoming.chains, (c) => c.id, false, opts.prune),
    providers: keyedDiff(current.providers, incoming.providers, (p) => p.id, false, opts.prune),
    featureFlags: keyedDiff(current.featureFlags, incoming.featureFlags, (f) => f.id, false, opts.prune),
    conflicts,
  };
}

const changed = <T>(c: CategoryDiff<T>): T[] => [...c.create, ...c.update, ...c.delete];

export function requiredActions(diff: ConfigDiff): { actions: string[]; ownerOnly: boolean } {
  const a = new Set<string>();
  let ownerOnly = false;
  if (changed(diff.grants).length) a.add('grant.edit');
  // Only a NEW or PRUNED owner-only grant escalates the requirement — re-applying
  // a doc that already contains such a grant (unchanged) is not owner-gated.
  for (const g of [...diff.grants.create, ...diff.grants.delete]) if (ownerOnlyAction(g.action)) ownerOnly = true;
  if (changed(diff.overlays).length || changed(diff.chains).length || changed(diff.featureFlags).length) a.add('policy.edit');
  if (changed(diff.providers).length) a.add('catalog.provider.manage');
  return { actions: [...a], ownerOnly };
}

// ── commit ────────────────────────────────────────────────────────────────

/** Apply ONLY the changed entities, sequentially. Validation + authorization are
 *  the caller's responsibility; this writes what the diff says and nothing else,
 *  so re-applying an unchanged doc is a genuine no-op (overlay versions don't churn). */
export async function commitConfigApply(store: Store, diff: ConfigDiff, actorId: string): Promise<void> {
  const now = new Date().toISOString();

  for (const g of diff.grants.create) await store.putGrant(g);
  for (const g of diff.grants.delete) await store.deleteGrant(g);

  const overlayVersion = new Map([...(await store.listOverlays()).values()].map((o) => [o.toolId, o.version]));
  for (const o of [...diff.overlays.create, ...diff.overlays.update]) {
    const norm = normalizeOverlay(o.toolId, o, overlayVersion.get(o.toolId) ?? 0);
    if (norm) await store.putOverlay(norm);
  }
  for (const o of diff.overlays.delete) await store.deleteOverlay(o.toolId);

  for (const c of [...diff.chains.create, ...diff.chains.update]) {
    const norm = normalizeChain(c.id, c);
    if (norm) await store.putChain(norm);
  }
  for (const c of diff.chains.delete) await store.deleteChain(c.id);

  for (const f of [...diff.featureFlags.create, ...diff.featureFlags.update]) {
    const norm = normalizeFlagGovernance(f.id, f, now);
    if (norm) await store.putFlagGovernance(norm);
  }
  for (const f of diff.featureFlags.delete) await store.putFlagGovernance({ id: f.id, updatedAt: now }); // clears the row

  if (changed(diff.providers).length) {
    const existing = new Map((await store.listProviders()).map((p) => [p.id, p]));
    for (const p of diff.providers.create) {
      await store.putProvider({
        id: p.id, kind: p.kind, label: p.label, managedBy: 'db', enabled: false,
        options: p.options, mapping: p.mapping, exposure: p.exposure, sync: p.sync,
        createdBy: actorId, createdAt: now, updatedAt: now, state: { assetCount: 0 },
      });
    }
    for (const p of diff.providers.update) {
      const cur = existing.get(p.id);
      if (!cur) continue;
      // Spread config over the existing record, PRESERVING enabled/credential/state.
      await store.putProvider({ ...cur, label: p.label, kind: p.kind, options: p.options, mapping: p.mapping, exposure: p.exposure, sync: p.sync, updatedAt: now });
    }
    for (const p of diff.providers.delete) {
      const cur = existing.get(p.id);
      // Prune only a disabled db provider — never silently delete a live one.
      if (cur && cur.managedBy === 'db' && !cur.enabled) await store.deleteProvider(p.id);
    }
  }
}

// ── summary (for the CLI + audit payload) ──────────────────────────────────

export function diffSummary(diff: ConfigDiff): Record<string, unknown> {
  const count = <T>(c: CategoryDiff<T>) => ({ create: c.create.length, update: c.update.length, delete: c.delete.length, unchanged: c.unchanged.length });
  return {
    grants: count(diff.grants),
    overlays: count(diff.overlays),
    chains: count(diff.chains),
    providers: count(diff.providers),
    featureFlags: count(diff.featureFlags),
    conflicts: diff.conflicts,
  };
}
