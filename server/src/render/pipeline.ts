import { parseProductionRequest, inspectWorkProduction, verifyProductionReport, ProductionError, productionApi, type ProductionRequest } from './production.ts';
/**
 * The render pipeline - the fourth HostV1 shell's core (plans/07).
 *
 * renderTool(): tool id + format + URL-mode query → bytes. It loads the tool via
 * the real engine, enforces policy (overlays) BEFORE rendering, renders the
 * hook-less fast path in jsdom, optionally composites a preview watermark, and
 * rasterises to PNG via resvg. An in-process LRU caches finished bytes, keyed by
 * the render cache-key contract (render/cache-key.ts) so a policy edit or pack
 * publish invalidates exactly the affected renders.
 *
 * The engine, jsdom, and resvg are HEAVY and imported LAZILY (dynamic import)
 * inside the functions that need them, so importing this module - which app.ts
 * does at boot - pulls in only zero-dep code (cache-key, overlay, org-config,
 * watermark, host). A boot that never renders stays instant.
 */
import { readFile, stat } from 'node:fs/promises';
import { workerQuery } from './worker-inputs.ts';
import type { RenderFileScope } from './read-ticket.ts';
import { governedInputs, requireGovernedInputs, requireRuleValues, projectRuleOverlay, finishRuleReport, markBrandDraft, type ManagedRuleContext } from '../brand/rules.ts';
import { join } from 'node:path';

import type { InstanceConfig } from '../config/instance.ts';
import type { EngineApi, LoadedTool, Profile } from './contract.ts';
import { loadEngine } from './contract.ts';
import type { ToolOverlay, ParamViolation } from '../policy/overlay.ts';
import { checkParams, lockedValues } from '../policy/overlay.ts';
import { policyVersionOf } from '../policy/org-config.ts';
import { renderViaWorker, rasteriseViaWorker, WorkerError, type WorkerConfig } from './worker-client.ts';
import type { LoadedSigner } from './c2pa-signer.ts';
import { renderCacheKey } from './cache-key.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { createAssetObserver, effectivePolicySha256, evidenceHash, finishRenderEvidence, type RenderEvidence } from './evidence.ts';
import { inspectOutput, outputVerificationProblems, OutputVerificationError, parseOutputVerification, verificationTarget, type OutputVerification } from './output-inspection.ts';
import { applyPreviewWatermark, shouldWatermark, untilApprovedNote } from './watermark.ts';
import { renderInputsDigest } from './inputs-digest.ts';
import type { ExportReviewKey } from '../approvals/export-review-match.ts';
import { AssetHeldError, withRenderHost, type RenderAssetGate } from './host.ts';
import { referencedAssetIds } from '../catalog/rights.ts';
import { createVmHookExecutor } from './vm-hooks.ts';
import { parseHostedProviderRef, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';
import {
  addPngProvenance, collectCatalogRefs, embedSvgProvenance, provenanceDoc,
  type ProvenanceDoc, type ProvenanceIngredient,
} from './provenance.ts';

// The format ceiling lives in capabilities.ts (shared with org-config's
// advertisement - plans/23 §3.A); re-exported so render callers keep one import.
export { RENDER_TIER, WORKER_RASTER_FORMATS, renderCapabilities, type RenderFormat, type RenderCapabilities } from './capabilities.ts';
import { isSvgTemplate, renderCapabilities } from './capabilities.ts';
import { loadToolOrRefuse, ToolLoadRefusal } from './tool-load.ts';
import { isPublishedTemplateRef, templateOverlay, templateSeed, type RenderTemplate } from '../catalog/templates.ts';
import { bindOverlay, defaultsFor, LOGO_FIELDS, themeOf, type BindingPlan, type Theme } from '../programmes/company-values.ts';
import { recordEnvironment, recordedThemes, type RenderPartner } from './record.ts';

/** Longest raster edge the resvg path will produce (an unbounded content-sized
 *  SVG must never dictate the allocation - mirrors the MCP service's cap). */
const MAX_RASTER_EDGE_PX = 10_000;

/** Upper bound on the resvg scale factor itself - guards against a degenerate
 *  targetWidthPx producing an absurd scale before the aspect-ratio check below. */
const MAX_SCALE = 1e9;

/** Escape hatch during the Tier-B consolidation (plans/22): force the in-process
 *  resvg raster path even when a Chromium worker is configured. Lets a deploy fall
 *  back for one release if the worker raster path misbehaves. Removed with resvg. */
const LEGACY_RESVG = process.env.LW_RENDER_LEGACY_RESVG === '1';

/** A caller-facing render problem carrying an HTTP status + envelope code. */
/** A render that would draw files the caller's licence gate holds back (plans/82 M4). */
function assetHeld(ids: string[]): RenderError {
  const list = [...new Set(ids)].sort();
  return new RenderError('ASSET_HELD', 422,
    `This render uses ${list.length === 1 ? 'a file that is' : 'files that are'} not available to you: ${list.join(', ')}.`, undefined, { assets: list });
}

export class RenderError extends Error {
  readonly code: string;
  readonly status: number;
  readonly violations?: ParamViolation[];
  /** Seconds the caller should back off - set when a saturated worker answered
   *  503 RENDER_BUSY (plans/23 §3.C); app.ts surfaces it as `Retry-After`. */
  retryAfter?: number;
  /** Extra fields for the error body, such as a retired template's `replacedBy`. */
  details?: Record<string, unknown>;
  constructor(code: string, status: number, message: string, violations?: ParamViolation[], details?: Record<string, unknown>) {
    super(message);
    this.name = 'RenderError';
    this.code = code;
    this.status = status;
    if (violations) this.violations = violations;
    if (details) this.details = details;
  }
}

/** A saturated worker (503 RENDER_BUSY + Retry-After) is a retryable capacity
 *  answer, not a worker fault - keep its code and back-off so app.ts can pass
 *  both to the client (plans/23 §3.C). Anything else stays the generic wrap. */
function renderErrorFromWorker(e: WorkerError): RenderError {
  const err = new RenderError(e.code ?? 'RENDER_WORKER_FAILED', e.status, e.message);
  if (e.retryAfter !== undefined) err.retryAfter = e.retryAfter;
  return err;
}

export interface RenderDeps {
  /** The approved export review matching a render, for `enforce.watermark:
   *  until-approved`. Absent (unit tests, older callers) nothing matches, so the mark stays. */
  approvedExportReview?: (key: ExportReviewKey & { toolVersion: string }) => Promise<{ id: string } | null>;
  workerReadToken?: string;
  workerFiles?: RenderFileScope;
  managedRules?: ManagedRuleContext;
  brandRevision?: string;
  config: InstanceConfig;
  /** Durable attempts collect fresh observations; cached bytes cannot attest a new attempt. */
  captureEvidence?: boolean;
  /** The Chromium render worker, when configured (config.render.worker.url set +
   *  LW_RENDER_WORKER_SECRET present). Absent ⇒ hooked and HTML-layout tools 501. */
  worker?: WorkerConfig;
  /** The instance C2PA signing identity, when configured. Present ⇒ every export
   *  carries a signed Content Credential; absent ⇒ unsigned provenance. */
  signer?: LoadedSigner | null;
  /** Resolve catalog refs the render consumed into provenance ingredients
   *  (plans/17: "«filename» from «provider»" travels with every export).
   *  Provided by app.ts, which can see the store + federation; absent (older
   *  callers, unit tests) → exports carry no provenance block. */
  resolveProvenance?: (refs: string[]) => Promise<ProvenanceIngredient[]>;
  /**
   * The instance-owned half of `catalogVersion` (plans/31 §6). The pack's own
   * catalog index is a file, so its mtime sees pack changes; instance assets
   * live in the store and their bytes can move under a stable id when a new
   * version lands or a rollback points the head at an older one. Without this
   * component a render that consumed `inst/<id>` would keep serving the old
   * bytes from cache under a key that never changed. Supplied by app.ts (which
   * can see the store) and memoized there; absent - older callers, unit tests -
   * leaves the key exactly as it was.
   */
  instanceCatalogVersion?: () => Promise<string> | string;
  /** Hosted rungs of the engine asset-provider grammar. Resolved before the
   * cache key and before worker dispatch so both render tiers see identical,
   * content-addressed values. */
  hostedResolver?: (ref: HostedProviderRef) => Promise<HostedAssetResult | null>;
  /** A published template the caller may use (plans/82 M2), looked up in the
   *  caller's own served feed: null when they cannot see it. Absent means this
   *  render path takes no published templates, and a render that names one is
   *  refused rather than run without its rules. */
  templateFor?: (id: string) => Promise<RenderTemplate | null>;
  /** A rules tool's files (plans/82 M2): this workspace's own build of a
   *  published Share with rules file, for this caller. Null for a pack tool. */
  toolFiles?: (toolId: string) => Promise<ReadonlyMap<string, Buffer> | null>;
  /** The templates this caller may start the tool from, when a programme they are in
   *  set it to templates only (plans/82 M2 W5); null when the tool is open to them. */
  templatesRequired?: (toolId: string) => Promise<Array<{ id: string; name: string }> | null>;
  /** The partner company values this caller's render takes (plans/82 M3,
   *  programmes/company-values.ts): null when nothing binds the tool or the
   *  caller is in no company. Absent means this render path binds nothing. */
  companyFor?: (args: { toolId: string; template: RenderTemplate | null; theme: Theme; toolOverlay: ToolOverlay | undefined; groups: string[] }) => Promise<RenderCompany | null>;
  /** The partner company and programme a render is for (plans/82 M3, section 6):
   *  recorded in its Content Credential. Null for anyone outside a programme. */
  partnerFor?: (args: { toolId: string; template: RenderTemplate | null; groups: string[]; role?: string }) => Promise<RenderPartner | null>;
  /** The design system that drew the render and its tokens, for the record. */
  designSystem?: () => Promise<{ id: string; label: string; tokens: unknown } | null>;
  /** The licence gate on this render (plans/82 M4): for a programme-scoped
   *  caller with the gate on, the catalog files their own gated feed holds,
   *  and every catalog id, so a value is read as a file only when it names
   *  one. Null when nothing is gated, which leaves the render as it was. */
  assetGate?: (groups: string[], role?: string) => Promise<{ allows(id: string): boolean; catalogIds: ReadonlySet<string> } | null>;
}

/** What a render takes from the caller's partner company (plans/82 M3). */
export interface RenderCompany {
  plan: BindingPlan;
  company?: { id: string; name: string; revision: number };
  programme?: { id: string; name: string };
  /** The resolved asset a logo id renders as, or null when it cannot be read. */
  logo(id: string): Promise<unknown | null>;
}

export interface RenderRequest {
  production?: ProductionRequest;
  verification?: 'output-v1' | OutputVerification;
  signal?: AbortSignal;
  toolId: string;
  format: string;
  /** URL-mode query string (no leading '?'), the shared param contract. */
  query: string;
  /** The caller's group set for policy resolution (never trusted for identity). */
  /** Who the render is for. `role` lets an admin or owner stay unscoped by a partner
   *  programme here, as in the gallery (programmes/types.ts isProgrammeScoped). */
  principal: { groups: string[]; role?: string } | null;
  /** Server-built profile for `bindToProfile` resolution - from the auth'd user, never params. */
  profile: Profile;
  /** All tool overlays (the policy version hashes the full set; the tool's own is derived). */
  overlays: Map<string, ToolOverlay>;
  /** Ask for the preview watermark (link/preview contexts). A tool overlay with
   *  `enforce.watermark: 'never'` still turns it off, and under `until-approved` an
   *  approved match does too. */
  watermarkPreview?: boolean;
}

export interface RenderOutput {
  bytes: Uint8Array;
  mime: string;
  cacheKey: string;
  /** Present when the render consumed catalog assets and a resolver was wired. */
  provenance?: ProvenanceDoc;
  evidence?: RenderEvidence;
  /** Present under `until-approved`: plain words for how this render came out. */
  watermarkNote?: string;
  /** The partner the render was made for, as its credential records it (plans/82 M3). */
  partner?: RenderPartner;
}

async function resolveHostedValues(value: unknown, resolve?: RenderDeps['hostedResolver']): Promise<unknown> {
  if (!resolve) return value;
  // URL mode wraps asset inputs as {source,id,_unresolved}; resolve the whole
  // reference. Recursing into its id would replace that string with an object
  // and leave the engine with an asset it can no longer identify.
  const asset = value && typeof value === 'object' && !Array.isArray(value) ? value as { source?: unknown; id?: unknown } : null;
  const ref = parseHostedProviderRef(value) ?? (asset && ['library', 'remote', 'user'].includes(String(asset.source)) ? parseHostedProviderRef(asset.id) : null);
  if (ref && (ref.provider === 'cms' || ref.provider === 'net')) {
    const result = await resolve(ref);
    if (!result) throw new RenderError('ASSET_PROVIDER_UNAVAILABLE', 422, `No hosted resolver could resolve ${ref.raw}`);
    return result.asset;
  }
  if (Array.isArray(value)) return Promise.all(value.map((item) => resolveHostedValues(item, resolve)));
  if (value && typeof value === 'object') {
    const entries = await Promise.all(Object.entries(value).map(async ([key, item]) => [key, await resolveHostedValues(item, resolve)] as const));
    return Object.fromEntries(entries);
  }
  return value;
}

/**
 * The published template a render names (`template=inst/<id>`, plans/82 M2),
 * checked before anything is rendered: the caller must see it in their own
 * feed, it must start this tool, and a retired one answers 410 with what
 * replaced it. A bare `template=<id>` is a tool's own shipped template and is
 * left as it always was.
 */
async function renderTemplateFor(deps: RenderDeps, query: string, toolId: string): Promise<RenderTemplate | null> {
  const ref = new URLSearchParams(query).get('template');
  if (!ref || !ref.startsWith('inst/')) return null;
  if (!isPublishedTemplateRef(ref)) throw new RenderError('TEMPLATE_NOT_FOUND', 404, 'No such template.');
  if (!deps.templateFor) throw new RenderError('TEMPLATE_UNAVAILABLE', 422, 'This render cannot start from a published template.');
  const template = await deps.templateFor(ref);
  if (!template) throw new RenderError('TEMPLATE_NOT_FOUND', 404, 'No such template.');
  if (template.retired) {
    throw new RenderError('TEMPLATE_RETIRED', 410, template.retired.replacedBy
      ? `This template was retired. Use ${template.retired.replacedBy} instead.` : 'This template was retired.',
    undefined, template.retired.replacedBy ? { replacedBy: template.retired.replacedBy } : undefined);
  }
  if (template.toolId !== toolId) throw new RenderError('TEMPLATE_TOOL_MISMATCH', 422, `This template starts ${template.toolId}, not ${toolId}.`);
  // A template that keeps its colourway and mode refuses a request to change
  // them, the same way it refuses a fixed input.
  const params = new URLSearchParams(query);
  const theme = template.fixedTheme ? ['ds', '_themes'].filter((key) => params.has(key)) : [];
  if (theme.length) {
    throw new RenderError('INPUT_LOCKED', 422, `The template fixes the colourway and mode: ${theme.join(', ')}`,
      theme.map((param) => ({ param, code: 'INPUT_LOCKED' as const })));
  }
  return template;
}

/**
 * A rules tool's own rules (plans/82 M2): a tool whose manifest carries a
 * `designTool` policy was made with Share with rules, and the designer fixed
 * everything it does not declare. A param that names anything else answers
 * 422 INPUT_LOCKED instead of being dropped, so an agent knows it was refused;
 * a value outside the designer's choices (an option, a range, an approved
 * image) answers 422 INPUT_NOT_ALLOWED; and only the designer's formats render.
 */
function requireDesignRules(engine: EngineApi, manifest: LoadedTool['manifest'], query: string, values: Record<string, unknown>, declared: string[], format: string): void {
  const policy = (manifest as { designTool?: { formats?: string[] } }).designTool;
  if (!policy) return;
  const known = new Set(declared);
  const fixed = [...new Set([...new URLSearchParams(query).keys()])].filter((key) => !engine.RESERVED.has(key) && !known.has(key));
  if (fixed.length) {
    throw new RenderError('INPUT_LOCKED', 422, `The designer fixed these: ${fixed.join(', ')}`,
      fixed.map((param) => ({ param, code: 'INPUT_LOCKED' as const })));
  }
  if (Array.isArray(policy.formats) && !policy.formats.includes(format)) {
    throw new RenderError('FORMAT_NOT_ALLOWED', 403, `The designer allows only ${policy.formats.join(', ')} for this tool`);
  }
  try { engine.assertDesignValues(policy, values); }
  catch (error) {
    const message = String((error as Error).message ?? error);
    const param = declared.find((id) => Object.hasOwn(values, id) && message.includes(id)) ?? declared.find((id) => Object.hasOwn(values, id)) ?? '';
    throw new RenderError('INPUT_NOT_ALLOWED', 422, message, param ? [{ param, code: 'INPUT_NOT_ALLOWED' }] : undefined);
  }
}

/** A failed tool load, as the render error the routes already answer. */
async function loadForRender<T>(toolId: string, load: (toolId: string) => Promise<T>): Promise<T> {
  try { return await loadToolOrRefuse(toolId, load); }
  catch (e) {
    if (e instanceof ToolLoadRefusal) throw new RenderError(e.code, e.status, e.message);
    throw e;
  }
}

export async function renderTool(deps: RenderDeps, req: RenderRequest): Promise<RenderOutput> {
  const production = parseProductionRequest(req.production);
  if (!production?.repair) {
    const out = await renderCandidate(deps, req);
    if (production) await verifyProductionReport(out.evidence?.production, out.bytes, production);
    return out;
  }
  const engine = await loadEngine(), plan = production.repair;
  const tool = await loadForRender(req.toolId, id => engine.loadTool(id, path => readFile(join(deps.config.instance.pack, 'tools', path), 'utf8')));
  const expanded = await engine.expandQuery(req.query), state = engine.parseUrlState(expanded, tool.manifest);
  const declared = new Set((tool.manifest.inputs as { id: string }[]).map(input => input.id));
  if (Object.keys(plan.permitted).some(key => !declared.has(key))) throw new ProductionError(['repair-input-not-declared']);
  const inputs = Object.fromEntries(engine.buildInputModel(tool.manifest, { profile: { ...req.profile }, initial: state.values }).filter(i => declared.has(i.id)).map(i => [i.id, i.value]));
  const run = await productionApi.runProductionRepairs(inputs, plan, {
    render: async values => {
      const query = new URLSearchParams(expanded);
      for (const key of Object.keys(plan.permitted)) query.set(key, typeof values[key] === 'string' ? values[key] as string : JSON.stringify(values[key]));
      const out = await renderCandidate(deps, { ...req, query: query.toString() });
      if (!out.evidence?.production) throw new ProductionError(['production-report-missing']);
      return { ...out, report: out.evidence.production, contract: production.contract };
    },
    propose: (values, report) => productionApi.proposeProductionPatch(values, report, plan),
  }, req.signal);
  const last = run.attempts.at(-1)!;
  try { await verifyProductionReport(last.report, last.bytes, production); }
  catch (error) { if (error instanceof ProductionError) error.attempts = run.attempts.map(a => a.report); throw error; }
  const { id: _id, apiVersion: _api, coverage: _coverage, outputSha256: _sha, ...body } = last.evidence!;
  const evidence = finishRenderEvidence({ ...body, productionAttempts: run.attempts.map(a => a.report) }, last.bytes);
  return { bytes: last.bytes, mime: last.mime, cacheKey: last.cacheKey, ...(last.provenance ? { provenance: last.provenance } : {}), evidence,
    ...(last.watermarkNote ? { watermarkNote: last.watermarkNote } : {}) };
}

async function renderCandidate(deps: RenderDeps, req: RenderRequest): Promise<RenderOutput> {
  req.signal?.throwIfAborted();
  // 'jpeg' is the same format as 'jpg' everywhere downstream (the worker
  // normalises too) - fold it before the gate so both spellings behave alike.
  const format = req.format.toLowerCase() === 'jpeg' ? 'jpg' : req.format.toLowerCase();
  // Capability gate: the SAME function that fills org_config's render block
  // (plans/23 §3.A), so what shells are offered and what this gate accepts can
  // never drift. A worker widens the set (plans/22 §6.3); the legacy-resvg
  // escape hatch narrows it back to the workerless tier, honestly.
  const caps = renderCapabilities(!!deps.worker && !LEGACY_RESVG);
  if (!caps.formats.includes(format)) {
    throw new RenderError('UNSUPPORTED_FORMAT', 400,
      `Format "${req.format}" is not rendered here — supported: ${caps.formats.join(', ')}`);
  }

  const engine = await loadEngine();
  req.signal?.throwIfAborted();
  const pack = deps.config.instance.pack;
  let verification: OutputVerification | undefined;
  try { verification = parseOutputVerification(req.verification); }
  catch { throw new RenderError('INVALID_VERIFICATION', 400, 'Unsupported output verification profile or dimensions.'); }
  const production = parseProductionRequest(req.production);
  if (production && production.contract.format !== format) throw new RenderError('INVALID_PRODUCTION', 400, 'Production format differs from the render request.');
  const observer = deps.captureEvidence || verification || production || deps.managedRules ? createAssetObserver() : undefined;
  const inputIds = [...new Set([...(production?.contract.requirements.filter(r => r.kind === 'input').map(r => r.location) ?? []), ...Object.values(deps.managedRules?.mapping?.fields ?? {})])];
  const resolvedProviders = new Map<string, Promise<HostedAssetResult | null>>();
  const hostedResolver: RenderDeps['hostedResolver'] = deps.hostedResolver ? async (ref) => {
    let pending = resolvedProviders.get(ref.raw);
    if (!pending) {
      pending = deps.hostedResolver!(ref);
      // Preflight and the engine's re-resolution must see the same returned
      // asset. This cache lasts for one attempt and holds at most 256 refs.
      if (resolvedProviders.size < 256) resolvedProviders.set(ref.raw, pending);
    }
    const result = await pending;
    if (result) observer?.observe('provider', result.asset);
    return result;
  } : undefined;

  // Load the tool through the real engine (validates the manifest + enforces its
  // engineVersion range). fetchFile resolves against <pack>/tools/.
  const files: RenderEvidence['tool']['files'] = [];
  const built = await deps.toolFiles?.(req.toolId) ?? null;
  const fetchFile = async (p: string): Promise<string> => {
    const own = built?.get(p.slice(p.indexOf('/') + 1));
    if (built && !own) throw Object.assign(new Error(`no such file: ${p}`), { code: 'ENOENT' });
    const text = own ? own.toString('utf8') : await readFile(join(pack, 'tools', p), 'utf8');
    files.push({ path: p, sha256: sha256Hex(text), size: Buffer.byteLength(text) });
    return text;
  };
  const tool: LoadedTool = await loadForRender(req.toolId, id => engine.loadTool(id, fetchFile));

  // A hooked tool can't run in the in-process jsdom fast path (its hooks.js may
  // use real browser APIs). It renders in-process only when the pack is curated
  // to allow it; otherwise it goes to the isolated Chromium worker, and 501s only
  // when no worker is configured. A hook-less template with no <svg> lays out
  // HTML, which needs a browser's layout too, so it also goes to the worker when
  // there is one, and otherwise 501s like toolServerFormats says. A hooked tool's
  // hooks may write the SVG themselves (qr-code's {{{svgContent}}}), so its
  // template text says nothing. Decision applied AFTER policy/baking below.
  const hooked = !!tool.hooksSource && !deps.config.render.allowHooksInFastPath;
  const htmlLayout = !tool.hooksSource && !isSvgTemplate(tool.template);
  const inWorker = hooked || (htmlLayout && !!deps.worker);

  // Parse the shared URL-mode query (unpacking a packed z= first).
  const expanded = await engine.expandQuery(req.query);
  const st = engine.parseUrlState(expanded, tool.manifest);
  const template = await renderTemplateFor(deps, expanded, req.toolId);
  // Templates only (programmes/templates-only.ts): the render must start from one of
  // the caller's published templates, and the refusal lists them.
  const required = template ? null : await deps.templatesRequired?.(req.toolId) ?? null;
  if (required) {
    throw new RenderError('TEMPLATE_REQUIRED', 422,
      `${req.toolId} is used here only through its published templates. Name one with template=inst/<id>.`,
      undefined, { templates: required });
  }
  const declaredIds = (tool.manifest.inputs as { id: string }[]).map((input) => input.id);
  requireDesignRules(engine, tool.manifest, expanded, st.values as Record<string, unknown>, declaredIds, format);

  // Policy BEFORE render. A caller that supplies a locked/hidden/not-allowed
  // param is refused (422); then the overlay's locked values are baked over the
  // caller's - so a locked input renders its policy value regardless of input.
  const groups = req.principal?.groups ?? [];
  const toolOverlay = deps.managedRules ? projectRuleOverlay(req.overlays.get(req.toolId), deps.managedRules, groups) : req.overlays.get(req.toolId);
  // The partner company's values (plans/82 M3, programmes/company-values.ts).
  // A logo field renders as the company's own asset, read here so both render
  // tiers see the same bytes; a logo that cannot be read is left unbound.
  const company = await deps.companyFor?.({ toolId: req.toolId, template, theme: themeOf(st.tokenSelection), toolOverlay, groups }) ?? null;
  const inputTypes = new Map((tool.manifest.inputs as Array<{ id: string; type?: string }>).map((i) => [i.id, i.type]));
  const companyValues: Record<string, unknown> = {};
  for (const [id, raw] of Object.entries(company?.plan.values ?? {})) {
    if (!declaredIds.includes(id)) continue;
    if (LOGO_FIELDS.has(company!.plan.bound[id]!) && inputTypes.get(id) === 'asset') {
      const ref = await company!.logo(raw);
      if (ref) companyValues[id] = ref;
    } else companyValues[id] = raw;
  }
  const plan = company ? { ...company.plan, locked: company.plan.locked.filter((id) => Object.hasOwn(companyValues, id)) } : null;
  // Who the piece is for, as its credential records it (plans/82 M3, section 6).
  const partner = await deps.partnerFor?.({ toolId: req.toolId, template, groups, ...(req.principal?.role ? { role: req.principal.role } : {}) }) ?? null;
  // A template's rules join the tool's own, stricter wins (catalog/templates.ts),
  // and a bound input they fix is fixed to the company's value.
  const templated = template ? templateOverlay(toolOverlay, template, groups, declaredIds) : toolOverlay;
  const overlay = plan ? bindOverlay(templated, toolOverlay, plan, groups, req.toolId, company!.company?.name, (id) => companyValues[id]) : templated;
  // Where the render starts, least specific first: the overlay's defaults for
  // these groups, the template's values, then the company's. The caller's own
  // values land on top, and the fixed ones are baked over everything below.
  // Someone in two companies gets the tool's own default for a bound input.
  const templateStart = template ? templateSeed(template.values, declaredIds) : {};
  if (plan?.ambiguous) for (const id of Object.keys(plan.bound)) delete templateStart[id];
  const overlayDefaults = templateSeed(defaultsFor(req.overlays.get(req.toolId), groups), declaredIds);
  const seed = { ...overlayDefaults, ...templateStart, ...companyValues };
  // Per-tool format policy (overlay enforce.formats - plans/23 §3.A): a format
  // the deployment CAN produce may still be disallowed for this tool. A policy
  // 403, deliberately distinct from the capability 400 at the top: absent (400)
  // vs forbidden-for-this-tool (403), so shells and operators can tell which.
  if (overlay?.enforce?.formats
      && !overlay.enforce.formats.some((f) => (f === 'jpeg' ? 'jpg' : f) === format)) {
    throw new RenderError('FORMAT_NOT_ALLOWED', 403,
      `Policy allows only ${overlay.enforce.formats.join(', ')} for "${req.toolId}"`);
  }
  const violations = checkParams(st.values as Record<string, unknown>, overlay, groups);
  if (violations.length) {
    const params = violations.map((v) => v.param).join(', ');
    throw new RenderError(violations[0]!.code, 422,
      `Policy forbids these params for your access: ${params}`, violations);
  }
  const bakedValues = await resolveHostedValues(
    { ...seed, ...st.values, ...lockedValues(overlay, groups) }, hostedResolver,
  ) as Record<string, unknown>;
  // The licence gate (plans/82 M4): a file the caller's own feed leaves out is
  // never drawn. Every file the values or the tool's defaults name is checked
  // here, before either render tier runs; the in-process host refuses any
  // other read of one, and the worker reads the catalog as this caller.
  const gate = await deps.assetGate?.(groups, req.principal?.role) ?? null;
  const hostGate: RenderAssetGate | undefined = gate ? { allows: (id) => gate.allows(id), held: new Set() } : undefined;
  if (gate) {
    const defaults = Object.fromEntries((tool.manifest.inputs as Array<{ id: string; default?: unknown }>).map((i) => [i.id, i.default]));
    const named = referencedAssetIds({ ...defaults, ...bakedValues }, gate.catalogIds).filter((id) => !gate.allows(id));
    if (named.length) throw assetHeld(named);
  }
  const initialValues = deps.managedRules ? Object.fromEntries(engine.buildInputModel(tool.manifest, { profile: { ...req.profile }, initial: bakedValues }).map(i => [i.id, i.value])) : {};
  requireRuleValues(deps.managedRules, { ...initialValues, ...bakedValues });
  const governed = deps.managedRules ? governedInputs(req.overlays.get(req.toolId), groups, Object.keys(initialValues)) : [];
  requireGovernedInputs(governed, Object.fromEntries(governed.flatMap(({ id }) => initialValues[id] === undefined ? [] : [[id, evidenceHash(initialValues[id])]])));
  inputIds.push(...governed.map(c => c.id).filter(id => !inputIds.includes(id)));
  if (inputIds.length > 128) throw new RenderError('INPUT_OBSERVATION_LIMIT', 422, 'Too many input checks for one render.');

  // Cache key: tool + version + engine + catalog + policy + format + baked params.
  // The catalog half is the pack's index version AND the instance-owned assets'
  // fingerprint, so a head move on an inst/* asset invalidates every render
  // that could have consumed it (plans/31 §6).
  const catalogVersion = await catalogVersionOf(deps, pack);
  const policyVersion = policyVersionOf(req.overlays, {});
  files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
  const sourceHash = evidenceHash(files);
  // `until-approved` reads the approval record on every render, so a decision takes
  // effect on the next one. A lookup that fails leaves the mark on.
  const watermarkRule = overlay?.enforce?.watermark;
  const inputsDigest = watermarkRule === 'until-approved'
    ? renderInputsDigest(engine, tool.manifest, { ...seed, ...st.values } as Record<string, unknown>, overlay, groups, req.profile) : null;
  const approval = inputsDigest
    ? await deps.approvedExportReview?.({ toolId: req.toolId, toolVersion: String(tool.manifest.version), format, inputsDigest }).catch(() => null) ?? null
    : null;
  const watermark = shouldWatermark(watermarkRule, req.watermarkPreview === true, !!approval);
  const untilApproved = inputsDigest
    ? { marked: watermark, note: untilApprovedNote(watermark), approvalId: approval?.id ?? null, inputsDigest } : undefined;
  const pxW = toPx(engine, st.width, st.unit, st.dpi);
  const pxH = toPx(engine, st.height, st.unit, st.dpi);
  const context: RenderEvidence['context'] = {
    paramsHash: evidenceHash(bakedValues), profileHash: evidenceHash(req.profile), groupsHash: evidenceHash([...new Set(groups)].sort()),
    policyVersion, catalogVersion, format, widthPx: pxW, heightPx: pxH, watermark,
    renderer: inWorker ? 'chromium-worker' : 'work-jsdom',
    rasterizer: format === 'svg' ? 'none' : deps.worker && !LEGACY_RESVG ? 'chromium-worker' : 'resvg',
    signerCertificateHash: deps.signer ? sha256Hex(deps.signer.certDer) : null,
  };
  const resolved: RenderEvidence['resolved'] = { designRevision: deps.brandRevision ?? null,
    effectivePolicySha256: effectivePolicySha256(overlay, groups, [...(tool.manifest.inputs as { id: string }[]).map(i => i.id), ...Object.keys(st.values)], deps.managedRules) };
  const cacheKey = renderCacheKey({
    toolId: req.toolId,
    toolVersion: tool.manifest.version,
    engineVersion: engine.ENGINE_VERSION,
    catalogVersion,
    policyVersion,
    format,
    params: bakedValues,
    context: { ...context, sourceHash, ...(untilApproved ? { untilApproved: untilApproved.approvalId } : {}),
      ...(template ? { template: { id: template.id, version: template.version, editable: template.editable ?? null } } : {}), brand: deps.managedRules ?? null, pack: evidenceHash(pack), instance: evidenceHash(deps.config.instance.baseUrl),
      // A signed file records the partner, so a profile revision moves the bytes.
      ...(partner && deps.signer ? { partner } : {}),
      worker: deps.worker ? evidenceHash(deps.worker.url) : null,
      signer: deps.signer ? evidenceHash({ chain: deps.signer.chain.map((cert) => sha256Hex(cert)), claimGenerator: deps.signer.claimGenerator }) : null },
  });

  // Hooks can read mutable state outside this host. Durable receipts always
  // observe a fresh attempt, even when a previous output has the same request key.
  const cacheable = !observer && !tool.manifest.hooks;
  const cached = cacheable ? cacheGet(cacheKey) : undefined;
  if (cached) return { bytes: cached.bytes, mime: cached.mime, cacheKey, ...(cached.provenance ? { provenance: cached.provenance } : {}),
    ...(untilApproved ? { watermarkNote: untilApproved.note } : {}), ...(partner ? { partner } : {}) };

  // Render path: hooked or HTML-layout tool → Chromium worker (or 501 when none);
  // otherwise the in-process jsdom fast path. Both converge on an SVG string post-processed
  // identically below (watermark → provenance → raster).
  let workerEvidence: import('./worker-client.ts').WorkerEvidence | undefined;
  let svgStr: string;
  let runtimeEvidence: RenderEvidence['runtime'];
  let productionInputs: Record<string, string> | undefined;
  if (inWorker) {
    if (!deps.worker) {
      throw new RenderError('HOOKED_TOOL_NEEDS_CHROMIUM', 501,
        `Tool "${req.toolId}" ships hooks; the in-process render path runs hook-less tools only ` +
        `(set render.allowHooksInFastPath for a curated pack, or configure render.worker.url + ` +
        `LW_RENDER_WORKER_SECRET for the Chromium worker - see docs/configuration.md)`);
    }
    try {
      const model = engine.buildInputModel(tool.manifest, { profile: { ...req.profile }, initial: bakedValues });
      const boundValues = Object.fromEntries(model
        .filter(input => input.bindToProfile).map(input => [input.id, input.value]));
      const readable = workerQuery(engine, model, { ...boundValues, ...bakedValues,
        ...(pxW ? { width: st.width } : {}), ...(pxH ? { height: st.height } : {}),
        ...(st.unit ? { unit: st.unit } : {}), ...(st.dpi ? { dpi: st.dpi } : {}),
      }, deps.config.instance.baseUrl, deps.workerFiles);
      const packed = readable.length > 4096 ? await engine.packQuery(readable) : null;
      const query = packed && packed.length + 2 < readable.length ? `z=${packed}` : readable;
      // The worker navigates through ordinary HTTP servers/proxies. Bound the
      // navigation before handing it off, including an incompressible document.
      if (Buffer.byteLength(query) > 8 * 1024) {
        throw new RenderError('RENDER_INPUT_TOO_LARGE', 413, 'document exceeds the browser navigation budget after packing');
      }
      req.signal?.throwIfAborted();
      svgStr = await renderViaWorker(deps.worker, {
        ...(deps.workerReadToken ? { readToken: deps.workerReadToken } : {}),
        ...(deps.brandRevision ? { brandRevision: deps.brandRevision } : {}),
        ...(production || deps.managedRules ? { evidence: true, inputIds } : {}),
        toolId: req.toolId,
        query,
        overrides: {},
        format: 'svg',
        profile: req.profile,
      }, { signal: req.signal, onEvidence: value => { workerEvidence = value; productionInputs = value.inputs; } });
    } catch (e) {
      if (e instanceof WorkerError) throw renderErrorFromWorker(e);
      throw e;
    }
  } else {
    try {
      svgStr = await withRenderHost({ pack, profile: req.profile, hostedResolver,
        ...(observer ? { observeCatalogAsset: (asset, bytes) => observer.observe('catalog', asset, bytes) } : {}),
        ...(hostGate ? { assetGate: hostGate } : {}),
      }, async (dom, host) => {
        req.signal?.throwIfAborted();
        // Manifest `requires` (engine 1.183): the optional host.* APIs the hooks
        // call unguarded. The engine refuses the mount when one is absent; say so
        // as a 501 with the API named, like the hooked-tool refusal, instead of a
        // bare 500. The work host carries tokens (when the pack has them) and
        // color; text, compose, audio and the device APIs live in the Chromium
        // worker's shell, so the fix is the worker, not a config flag.
        // (Mirrors core's `missingRequires`; the root `@lolly-tools/core` entry
        // pulls DOM-typed modules this Node-only program cannot check, and the
        // engine applies the real predicate at createRuntime regardless.)
        const unmet = (tool.manifest.requires ?? []).filter((name) => (host as unknown as Record<string, unknown>)[name] == null);
        if (unmet.length) {
          throw new RenderError('TOOL_REQUIRES_UNMET', 501,
            `Tool "${req.toolId}" requires host.${unmet.join(', host.')} and the in-process render host does not provide ` +
            `${unmet.length === 1 ? 'it' : 'them'} (configure render.worker.url + LW_RENDER_WORKER_SECRET for the Chromium worker - see docs/configuration.md)`);
        }
        if (htmlLayout) {
          throw new RenderError('SVG_TEMPLATE_REQUIRED', 501,
            `Tool "${req.toolId}" lays out HTML; the in-process render path exports SVG templates only ` +
            `(configure render.worker.url + LW_RENDER_WORKER_SECRET for the Chromium worker - see docs/configuration.md)`);
        }
        // A curated pack's hooks run in a node:vm context (vm-hooks.ts), not the
        // server's realm - no process.env, no ambient fetch, no require.
        const runtime = await engine.createRuntime(tool, host, bakedValues,
          tool.hooksSource ? { hookExecutor: createVmHookExecutor(dom) } : undefined);
        if (inputIds.length) {
          const render = host.export.render.bind(host.export);
          host.export.render = async (...args) => {
            const inputs = productionApi.productionInputFacts(runtime.getModel(), { requirements: inputIds.map(id => ({ id, kind: 'input', location: id, expected: '' })) });
            const result = await render(...args); productionInputs = await inputs; return result;
          };
        }
        try {
          const canvas = dom.window.document.getElementById('canvas');
          if (!canvas) throw new RenderError('RENDER_FAILED', 500, 'render canvas missing');
          canvas.innerHTML = runtime.getHydrated();
          if (observer) runtimeEvidence = {
            initialValuesHash: evidenceHash(Object.fromEntries(runtime.getModel().map((input) => [input.id, input.value]))),
            hydratedHash: sha256Hex(runtime.getHydrated()), hookErrors: runtime.hookErrors.length, droppedAssets: runtime.droppedAssets.length,
          };
          const opts: Record<string, unknown> = { embedMeta: false, watermark };
          if (pxW) opts.width = pxW;
          if (pxH) opts.height = pxH;
          const blob = await runtime.export(canvas, 'svg', opts);
          const text = new TextDecoder().decode(new Uint8Array(await blob.arrayBuffer()));
          if (runtimeEvidence) { runtimeEvidence.hookErrors = runtime.hookErrors.length; runtimeEvidence.droppedAssets = runtime.droppedAssets.length; runtimeEvidence.hydratedHash = sha256Hex(runtime.getHydrated()); }
          // Honest failure: a lifecycle hook threw AND the output is blank ⇒ the bytes
          // aren't a real render. (A hookless tool has no hookErrors; a trivial {} hook
          // doesn't error.)
          if (runtime.hookErrors.length && (!text.trim() || !/<svg[\s>]/i.test(text))) {
            const detail = runtime.hookErrors.map((h) => `${h.hook}: ${h.message}`).join('; ');
            throw new RenderError('RENDER_FAILED', 400, `Render produced no output — ${detail}`);
          }
          return text;
        } finally { runtime.destroy(); }
      });
    } catch (e) {
      // A held file the engine reached for, past the check above (plans/82 M4).
      if (e instanceof AssetHeldError) throw assetHeld([e.assetId, ...(hostGate?.held ?? [])]);
      throw e;
    }
    if (hostGate?.held.size) throw assetHeld([...hostGate.held]);
  }

  const sourceObserved = !inWorker || files.every(file => workerEvidence?.resources.some(r => {
    try { return new URL(r.url).pathname.endsWith(`/tools/${file.path}`) && r.sha256 === file.sha256; } catch { return false; }
  }));
  requireGovernedInputs(governed, sourceObserved ? productionInputs ?? {} : {});
  const brandReport = await finishRuleReport(deps.managedRules, initialValues, sourceObserved ? productionInputs ?? {} : {});
  if (watermark) svgStr = applyPreviewWatermark(svgStr);
  if (brandReport?.disposition === 'draft') svgStr = markBrandDraft(svgStr);

  // Provenance: whatever catalog assets this render referenced (baked params or
  // the SVG itself) become ingredients, embedded in the bytes so attribution
  // survives the file leaving lolly. Resolver failures never fail a render.
  let provenance: ProvenanceDoc | undefined;
  if (deps.resolveProvenance) {
    const refs = collectCatalogRefs(svgStr, bakedValues);
    if (refs.length) {
      try {
        const ingredients = await deps.resolveProvenance(refs);
        if (ingredients.length) provenance = provenanceDoc(ingredients);
      } catch { /* attribution is best-effort; the render itself is not */ }
    }
  }
  if (provenance) svgStr = embedSvgProvenance(svgStr, provenance);

  let out: CacheEntry;
  if (format === 'svg') {
    out = { bytes: new TextEncoder().encode(svgStr), mime: 'image/svg+xml' };
  } else {
    // Rasterise the finished (watermarked + provenance-islanded) SVG. The Chromium
    // worker is the single rasteriser when configured - one engine so what the shell
    // shows is what exports; in-process resvg is the fallback for a worker-less deploy
    // (the hosted demo today). Provenance + C2PA stay plane-side either way. Once a
    // worker is always present, resvg (and its native binary) is removed - see
    // plans/22.
    let raster: { bytes: Uint8Array; mime: string };
    if (deps.worker && !LEGACY_RESVG) {
      try {
        raster = await rasteriseViaWorker(deps.worker, { svg: svgStr, format, ...(pxW ? { width: pxW } : {}) }, { signal: req.signal });
      } catch (e) {
        if (e instanceof WorkerError) throw renderErrorFromWorker(e);
        throw e;
      }
    } else {
      raster = { bytes: await svgToPng(svgStr, pxW), mime: 'image/png' };
    }
    let bytes = raster.bytes;
    // PNG carries provenance in an iTXt chunk; other raster/vector-print formats get
    // it from the plane-side C2PA sign below (the worker never signs).
    if (provenance && raster.mime === 'image/png') bytes = addPngProvenance(bytes, provenance);
    out = { bytes, mime: raster.mime };
  }
  if (provenance) out.provenance = provenance;

  // Real C2PA signing (plans/17 §16): with an instance signer configured, sign
  // the finished bytes - including the provenance island above - so the export
  // carries a verifiable, tamper-evident Content Credential. Best-effort: a
  // signing failure must never fail an otherwise-good render (the unsigned bytes
  // still ship), matching how provenance degrades. Cache the signed bytes.
  if (deps.signer) {
    try {
      // The Lolly record (plans/82 M3, section 6): the design system and its theme
      // choices, as the app writes them, and the partner. Nothing else.
      const system = await deps.designSystem?.().catch(() => null) ?? null;
      const tokenEngine = engine as unknown as Parameters<typeof recordedThemes>[0] & { designRecordEnvironment(meta: unknown): Record<string, string> };
      const environment = recordEnvironment({
        designSystem: system ? { id: system.id, label: system.label } : null,
        themes: system ? recordedThemes(tokenEngine, system.tokens, st.tokenSelection as Record<string, string> | null) : [],
        partner, designRecordEnvironment: (meta) => tokenEngine.designRecordEnvironment(meta),
      });
      out.bytes = await engine.embedC2pa(out.bytes, format, {
        signer: { privateKey: deps.signer.privateKey, certDer: deps.signer.certDer, chain: deps.signer.chain },
        title: req.toolId,
        ...(deps.signer.claimGenerator ? { claimGenerator: deps.signer.claimGenerator } : {}),
        ...(Object.keys(environment).length ? { environment } : {}),
      });
    } catch (e) {
      // Log to stderr (container stream); ship the unsigned bytes rather than 500.
      process.stderr.write(`[render:c2pa] signing ${req.toolId}.${format} failed: ${(e as Error).message}\n`);
    }
  }

  req.signal?.throwIfAborted();
  const target = verificationTarget({ format, widthPx: pxW, heightPx: pxH }, verification);
  const inspection = observer ? await inspectOutput(out.bytes, out.mime, target) : undefined;
  req.signal?.throwIfAborted();
  if (req.verification) {
    const problems = outputVerificationProblems(inspection, out.bytes, out.mime, target);
    if (problems.length) throw new OutputVerificationError(problems, inspection);
  }
  if (cacheable) cachePut(cacheKey, out, req.toolId);
  const observation = observer?.finish();
  const resourceDigests = new Map<string, Set<string>>();
  for (const item of [...(observation?.assets ?? []).map(a => ({ key: a.id, sha256: a.sha256 })), ...(workerEvidence?.resources ?? []).map(r => ({ key: r.url, sha256: r.sha256 }))]) {
    const hashes = resourceDigests.get(item.key) ?? new Set<string>(); hashes.add(item.sha256); resourceDigests.set(item.key, hashes);
  }
  if (production && inspection?.checks.find(c => c.id === 'mime')?.state !== 'pass') throw new ProductionError(['output-mime-mismatch']);
  const productionReport = production ? await inspectWorkProduction(out.bytes, production, {
    ...(sourceObserved ? { sourceSha256: sourceHash } : {}),
    ...(inWorker ? {} : { contextSha256: evidenceHash(context) }),
    ...(productionInputs ? { inputs: productionInputs } : {}),
    resources: Object.fromEntries([...resourceDigests].filter(([, hashes]) => hashes.size === 1).map(([key, hashes]) => [key, [...hashes][0]!])),
  }, req.signal) : undefined;
  const evidence = observation ? finishRenderEvidence({
    engine: { version: engine.ENGINE_VERSION, documentApiVersion: engine.DOCUMENT_API_VERSION, scope: 'control-plane' },
    tool: { id: req.toolId, version: tool.manifest.version, sourceHash, files, scope: inWorker ? 'control-plane-validation' : 'local-runtime' },
    context, resolved, ...(runtimeEvidence ? { runtime: runtimeEvidence } : {}), assets: observation.assets,
    ...(inspection ? { inspection } : {}),
    ...(productionReport ? { production: productionReport } : {}),
    ...(brandReport ? { brandRules: brandReport } : {}),
    ...(untilApproved ? { untilApproved } : {}),
    ...(workerEvidence ? { worker: workerEvidence } : {}),
    limitations: ['engine-dependency-graph-unavailable', 'dependencies-not-locked', 'unobserved-template-and-global-resources',
      ...(inWorker ? workerEvidence ? ['worker-runtime-profile-api-unattested', ...workerEvidence.limitations] : ['worker-tool-and-assets-unattested', 'worker-profile-and-inputs-unattested'] : []),
      ...(tool.manifest.hooks ? ['hooks-not-isolated'] : []),
      ...(format !== 'svg' ? ['rasterizer-fonts-unattested'] : []),
      ...observation.limitations].sort(),
  }, out.bytes) : undefined;
  return { ...out, cacheKey, ...(evidence ? { evidence } : {}), ...(untilApproved ? { watermarkNote: untilApproved.note } : {}), ...(partner ? { partner } : {}) };
}

/** Rasterise an SVG string to PNG via resvg, longest edge bounded by the cap. */
async function svgToPng(svg: string, targetWidthPx: number | null): Promise<Uint8Array> {
  const { Resvg } = await import('@resvg/resvg-js');
  const probe = new Resvg(svg, { font: { loadSystemFonts: false } });
  const iw = probe.width, ih = probe.height;
  if (!(iw > 0) || !(ih > 0)) throw new RenderError('RENDER_FAILED', 400, 'SVG has no rasterisable size');
  const capScale = Math.min(MAX_RASTER_EDGE_PX / iw, MAX_RASTER_EDGE_PX / ih);
  const wantScale = targetWidthPx && targetWidthPx > 0 ? targetWidthPx / iw : 1;
  const scale = Math.min(wantScale, capScale, MAX_SCALE);
  if (iw * scale < 1 || ih * scale < 1) {
    throw new RenderError('RENDER_FAILED', 400, 'SVG aspect ratio is too extreme to rasterise within the size cap — request svg instead');
  }
  const fitTo = targetWidthPx && targetWidthPx > 0 && scale === wantScale
    ? { mode: 'width' as const, value: Math.round(targetWidthPx) }
    : { mode: 'zoom' as const, value: scale };
  const r = new Resvg(svg, { fitTo, font: { loadSystemFonts: true } });
  return r.render().asPng();
}

/** Convert a parsed dimension to CSS pixels (px/absent pass through; physical → px at dpi). */
function toPx(
  engine: Pick<EngineApi, 'parseDimension' | 'toPixels'>,
  value: number | null,
  unit: string | null,
  dpi: number | null,
): number | null {
  if (!value || value <= 0) return null;
  if (!unit || unit === 'px') return Math.round(value);
  const dim = engine.parseDimension(`${value}${unit}`);
  return dim ? Math.round(engine.toPixels(dim, dpi ?? 300)) : Math.round(value);
}

// ── catalog version (read once per pack, mtime-checked) ───────────────────────

/** The pack's own catalog version, plus the instance-owned assets' fingerprint
 *  when a caller wired one. Joined rather than hashed together so an operator
 *  reading a cache key's inputs can still see which half moved. */
async function catalogVersionOf(deps: RenderDeps, pack: string): Promise<string> {
  const packVersion = await readCatalogVersion(pack);
  if (!deps.instanceCatalogVersion) return packVersion;
  return `${packVersion}/${await deps.instanceCatalogVersion()}`;
}

const catalogVersionCache = new Map<string, { mtimeMs: number; version: string }>();

async function readCatalogVersion(pack: string): Promise<string> {
  const file = join(pack, 'catalog', 'tools', 'index.json');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(file)).mtimeMs;
  } catch {
    return '0'; // no catalog index in this pack
  }
  const hit = catalogVersionCache.get(pack);
  if (hit && hit.mtimeMs === mtimeMs) return hit.version;
  let version = '0';
  try {
    const doc = JSON.parse(await readFile(file, 'utf8')) as { version?: unknown };
    if (doc.version != null) version = String(doc.version);
  } catch {
    /* unreadable/malformed index — treat as version 0 */
  }
  catalogVersionCache.set(pack, { mtimeMs, version });
  return version;
}

// ── in-process LRU (insertion-order eviction; capped by count AND bytes) ──────
const MAX_ENTRIES = 200;
const MAX_BYTES = 100 * 1024 * 1024;
interface CacheEntry { bytes: Uint8Array; mime: string; provenance?: ProvenanceDoc }
const cache = new Map<string, CacheEntry>();
const keyTool = new Map<string, string>(); // cacheKey -> toolId, for by-tool busting
let cacheBytes = 0;

function cacheGet(key: string): CacheEntry | undefined {
  return cache.get(key);
}

function cachePut(key: string, entry: CacheEntry, toolId: string): void {
  const existing = cache.get(key);
  if (existing) cacheBytes -= existing.bytes.byteLength;
  cache.set(key, entry);
  keyTool.set(key, toolId);
  cacheBytes += entry.bytes.byteLength;
  while ((cache.size > MAX_ENTRIES || cacheBytes > MAX_BYTES) && cache.size > 0) {
    const oldest = cache.keys().next().value as string | undefined;
    if (oldest === undefined) break;
    const evicted = cache.get(oldest);
    cache.delete(oldest);
    keyTool.delete(oldest);
    if (evicted) cacheBytes -= evicted.bytes.byteLength;
  }
}

/**
 * Evict every cached render of `toolId`, returning the count dropped. The
 * reachable invalidation entry point plans/08 §6b asks a bulk session edit to
 * call: because the render cache key already folds in the tool's inputs, a
 * changed input structurally misses its old entry - but a bulk edit that sets a
 * value BACK to a previously-rendered one would otherwise hit stale bytes, so
 * this by-tool bust closes the gap. It over-busts (drops the tool's other cached
 * renders too), which is safe - renders are deterministic and simply recompute - 
 * and cheap for a rare admin op.
 */
export function invalidateRenderByTool(toolId: string): number {
  let dropped = 0;
  for (const [key, t] of [...keyTool]) {
    if (t !== toolId) continue;
    const entry = cache.get(key);
    cache.delete(key);
    keyTool.delete(key);
    if (entry) { cacheBytes -= entry.bytes.byteLength; dropped++; }
  }
  return dropped;
}
