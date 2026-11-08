// SPDX-License-Identifier: MPL-2.0
/**
 * Capability discovery and effective tool schemas (Work plan 42).
 *
 *   GET /api/v1/discovery         what this deployment can do: the same answer
 *                                 for everyone, public and cacheable
 *   GET /api/v1/discovery/me      what the signed-in caller can do here
 *   GET /api/v1/discovery/tools   the tools the caller can use, a page at a time
 *   GET /api/v1/schema/:toolId    one tool's effective input schema
 *
 * Every answer is built from live configuration and the same probes and policy
 * functions the render and automation routes enforce with, never from a written
 * feature list. Anything unavailable carries a stable code and a reason.
 *
 * The plan names `/.well-known/lolly`; on a shared origin `/.well-known/` is
 * the web shell's (its static `/.well-known/lolly.json` describes the shell),
 * so the deployment record lives under `/api/v1`, which always reaches Work.
 *
 * The public answer names no tool, provider, group or person. The caller
 * answers never include group membership, another principal's access, a
 * hidden tool or a hidden input.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { BRAND_PAGE_INDEX_PATH, BRAND_PAGE_PUBLIC_API } from '../brand-pages/types.ts';
import { cachePolicy } from '@lolly-tools/core/delivery-v1';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { sendError, sendJson, type createRouter } from '../api/router.ts';
import { matchesEtag, sendBytes } from '../api/file-delivery.ts';
import { evaluate, type Grant, type Role } from '../rbac/evaluate.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import { projectRuleOverlay, type ManagedRuleContext } from '../brand/rules.ts';
import { BrandError } from '../brand/service.ts';
import { TOKEN_SCOPES_VERSION, scopesCoverAction } from '../iam/token-scopes.ts';
import { loadEngine, type Profile } from '../render/contract.ts';
import { RENDER_TIER, WORKER_RASTER_FORMATS, type RenderCapabilities, type UnavailableFormat } from '../render/capabilities.ts';
import { workerEndpoint, type WorkerConfig } from '../render/worker-client.ts';
import { describeTool, type ToolDescription } from './verbs.ts';
import { effectiveInputSchema, mayRenderTool, mayUseTool, policyFormats, type PolicyEffect, type ToolCaller } from './effective-contract.ts';
import { ToolLoadRefusal, withoutServerPaths } from '../render/tool-load.ts';

/** The discovery documents' own version. A field is only ever added within it. */
export const DISCOVERY_VERSION = 1;
/** Batch request limits, shared with the batch route and its durable runner. */
export const BATCH_LIMITS = { rows: 200, concurrency: 4, retries: 3 } as const;
const PAGE = { default: 25, max: 100 } as const;
const VERBS = ['compile', 'validate', 'inspect', 'diff', 'measure', 'optimize', 'package', 'render', 'batch'] as const;
const LINKS = { caller: '/api/v1/discovery/me', tools: '/api/v1/discovery/tools', schema: '/api/v1/schema/{toolId}', intents: '/api/v1/intents/resolve', files: '/api/v1/files', mcp: '/api/v1/mcp' } as const;
const TOOL_ID = /^[a-z0-9][a-z0-9._-]*$/i;

export type WorkerState = 'ready' | 'busy' | 'unreachable';

/** Something a caller cannot do, with a stable code and a reason. Exactly one
 *  of `format`, `action` or `feature` names what is unavailable. */
export type Unavailable = UnavailableFormat | { action: string; code: string; reason: string } | { feature: string; code: string; reason: string };

export interface DiscoveryCaller { user: ToolCaller | null; principal: string; groups: string[]; profile: Profile }

export interface DiscoveryDeps {
  /** The automation caller, or null when this deployment needs a sign-in. */
  caller(req: IncomingMessage): Promise<DiscoveryCaller | null>;
  overlays(): Promise<Map<string, ToolOverlay>>;
  grants(): Promise<Grant[]>;
  accessMode: 'open' | 'gated' | 'per-tool';
  /** The mounted pack root, read at each request because the brand source can change. */
  pack(): string;
  /** The current pack's tool ids, sorted. */
  toolIds(): readonly string[];
  /** The current pack has a design tokens head, so the in-process host has `tokens`. */
  tokens(): boolean;
  designRevision(): string;
  catalogVersion(): Promise<string>;
  /** The design-system rules for a format, or with none the rules every format
   *  shares (brand/rules.ts requestRuleContext), as compile and validate apply them. */
  managedRules(toolId: string, format?: string): Promise<ManagedRuleContext | undefined>;
  /** The caller's partner company values for a tool (plans/82 M3): the overlay
   *  with bound inputs locked to the company's value where its rule locks them,
   *  and the values the tool starts from. Absent binds nothing. */
  companyOverlay?(toolId: string, groups: string[], overlay: ToolOverlay | undefined): Promise<{ overlay: ToolOverlay | undefined; defaults: Record<string, unknown> }>;
  caps: RenderCapabilities;
  allowHooksInFastPath: boolean;
  /** A C2PA signer resolves, so server renders carry Content Credentials. */
  contentCredentials(): Promise<boolean>;
  /** Present when a render worker is configured. */
  workerState?: () => Promise<WorkerState>;
  liveCollab: boolean;
  documentAgents: boolean;
  /** Whether this host runs the durable render runner, which the MCP render tools need. */
  durableRenders: boolean;
  /** Whether file references (uploads/files.ts) are on: `policy.uploads.enabled`. */
  fileReferences: boolean;
  /** Whether an approval request can carry its file: `policy.approvalArtifacts.enabled`. */
  exportReview: boolean;
  /** Whether this instance serves brand pages: `brandPages.enabled`. */
  brandPages: boolean;
  /** Which provider reference schemes resolve for these groups. */
  providerRefs(groups: string[]): Promise<{ cms: boolean; net: boolean }>;
  /** The published rules tools this group set's feed carries (plans/82 M2), each
   *  with its own files. They are used, described and rendered like pack tools,
   *  under their own rules. Absent means none. */
  publishedTools?(groups: string[]): Promise<ReadonlyMap<string, { files: ReadonlyMap<string, Buffer> }>>;
  /** A service token's own limits and use (plans/82 M7), or null for anyone else.
   *  The token reads its figures, never where an admin set them. */
  tokenLimits?(req: IncomingMessage): Promise<{ limits: Record<string, number | null>; usage: Record<string, unknown> } | null>;
}

/** A response body as text, or null once it passes `limit` bytes (the rest is
 *  never read). */
async function boundedText(res: Response, limit: number): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > limit) { await reader.cancel().catch(() => {}); return null; }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/** The worker's readiness, read from its unauthenticated `/readyz` and kept for
 *  `ttlMs`, so discovery never sends more than one probe per interval. A worker
 *  reports a full set of slots as `atCapacity` on a 200; an older worker
 *  answered 503 instead. Both read as busy. */
export function createWorkerProbe(cfg: WorkerConfig, fetchImpl: typeof fetch, ttlMs = 15_000): () => Promise<WorkerState> {
  let last: { at: number; state: Promise<WorkerState> } | null = null;
  return () => {
    if (last && Date.now() - last.at < ttlMs) return last.state;
    const state = (async (): Promise<WorkerState> => {
      try {
        const res = await fetchImpl(workerEndpoint(cfg, '/readyz'), { signal: AbortSignal.timeout(2_000) });
        if (res.status !== 200) {
          await res.body?.cancel().catch(() => {});
          return res.status === 503 ? 'busy' : 'unreachable';
        }
        const text = await boundedText(res, 4096);
        let full = false;
        try { full = text !== null && (JSON.parse(text) as { atCapacity?: unknown } | null)?.atCapacity === true; } catch { /* a bare 200 is ready */ }
        return full ? 'busy' : 'ready';
      } catch { return 'unreachable'; }
    })();
    last = { at: Date.now(), state };
    return state;
  };
}

const kindOf = (principal: string): 'member' | 'service' | 'guest' => principal.startsWith('user:') ? 'member' : principal.startsWith('service:') ? 'service' : 'guest';
const etagOf = (body: unknown) => `"s-${sha256Hex(canonicalJson(body)).slice(0, 32)}"`;
const RENDER_FORBIDDEN = { action: 'render', code: 'FORBIDDEN', reason: 'Server rendering needs the export.server permission.' } as const;

/** Formats this server version can produce that this deployment does not, and
 *  why. Hooked tools are reported the same way when no worker runs. */
function deploymentGaps(caps: RenderCapabilities): Unavailable[] {
  const known = [...RENDER_TIER, ...WORKER_RASTER_FORMATS] as string[];
  return [
    ...known.filter(format => !caps.formats.includes(format)).map(format => ({ format, code: 'WORKER_NOT_CONFIGURED', reason: 'This format needs the Chromium render worker, and this deployment does not run one.' })),
    ...(caps.hookedTools ? [] : [{ feature: 'hooked-tools', code: 'HOOKED_TOOL_NEEDS_CHROMIUM', reason: 'Tools that run scripts need the Chromium render worker, and this deployment does not run one.' }]),
  ];
}

/** Answer with a strong validator, and 304 when the caller already holds it. */
function sendWithEtag(req: IncomingMessage, res: ServerResponse, body: Record<string, unknown>): void {
  const etag = etagOf(body);
  if (matchesEtag(req.headers['if-none-match'], etag)) { res.writeHead(304, { etag }); res.end(); return; }
  sendJson(res, 200, { ...body, etag }, { etag });
}

/** The caller's effective contract for one described tool. Without a requested
 *  format it carries only the design-system rules every format shares, the same
 *  rules a compile, validate or package that names no format is checked against. */
async function contractFor(deps: DiscoveryDeps, described: ToolDescription, overlays: Map<string, ToolOverlay>, groups: string[], format?: string) {
  const original = overlays.get(described.toolId);
  const allowed = policyFormats(described.server.formats, original);
  const rules = await deps.managedRules(described.toolId, format);
  const company = deps.companyOverlay ? await deps.companyOverlay(described.toolId, groups, original) : { overlay: original, defaults: {} };
  const overlay = rules ? projectRuleOverlay(company.overlay, rules, groups) : company.overlay;
  const input = effectiveInputSchema(described.raw, overlay, groups, company.defaults);
  const effects: PolicyEffect[] = [...input.effects, ...allowed.effects];
  return { schema: input.schema, effects, formats: allowed.formats, format, rules, overlay: original,
    unavailable: [...described.server.unavailable, ...allowed.unavailable] as Unavailable[] };
}

export function registerDiscoveryRoutes(router: ReturnType<typeof createRouter>, deps: DiscoveryDeps): void {
  const describe = (toolId: string, files?: ReadonlyMap<string, Buffer>) => describeTool({ pack: deps.pack(), profile: {}, ...(files ? { toolFiles: async () => files } : {}) }, toolId,
    { caps: deps.caps, allowHooksInFastPath: deps.allowHooksInFastPath, tokens: deps.tokens() });
  const published = async (groups: string[]) => (deps.publishedTools ? await deps.publishedTools(groups) : new Map<string, { files: ReadonlyMap<string, Buffer> }>());

  router.add('GET', '/api/v1/discovery', async (req, res) => {
    const engine = await loadEngine();
    const body = {
      version: DISCOVERY_VERSION,
      service: 'lolly-work',
      access: deps.accessMode,
      api: { document: engine.DOCUMENT_API_VERSION, engine: engine.ENGINE_VERSION },
      render: { formats: deps.caps.formats, hookedTools: deps.caps.hookedTools, contentCredentials: await deps.contentCredentials().catch(() => false) },
      automation: { verbs: VERBS, async: true, durableRenders: true, batch: BATCH_LIMITS, renderBatches: { rows: 200, bind: true, archive: true } },
      collaboration: { live: deps.liveCollab },
      agents: { documentMcp: deps.documentAgents, organisationMcp: { endpoint: LINKS.mcp, auth: 'service-token', renderTools: deps.durableRenders } },
      files: { references: deps.fileReferences },
      approvals: { exportReview: deps.exportReview, exportReviewMatch: deps.exportReview },
      brandPages: deps.brandPages ? { enabled: true, index: BRAND_PAGE_PUBLIC_API, convention: BRAND_PAGE_INDEX_PATH } : { enabled: false },
      unavailable: deploymentGaps(deps.caps),
      links: LINKS,
    };
    // The same answer for everyone, so shared caches may hold it and any page may read it.
    res.setHeader('access-control-allow-origin', '*');
    sendBytes(req, res, Buffer.from(JSON.stringify(body)), { contentType: 'application/json; charset=utf-8',
      headers: { 'cache-control': cachePolicy('public-revalidate').cacheControl, 'x-content-type-options': 'nosniff' } });
  }, { delivery: 'public-revalidate' });

  router.add('GET', '/api/v1/discovery/me', async (req, res) => {
    const caller = await deps.caller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const grants = await deps.grants();
    const open = deps.accessMode === 'open';
    const principal = caller.user ? { userId: caller.user.id, groups: caller.user.groups, role: caller.user.role as Role } : null;
    const scopes = caller.user?.tokenScopes;
    const can = Object.fromEntries((['tool.use', 'export.server', 'export.request', 'delivery.create', 'catalog.read'] as const).map(action =>
      [action, principal
        ? evaluate(principal, action, ['*'], grants) && (!scopes || scopesCoverAction(scopes, action))
        : open && (action === 'tool.use' || action === 'export.server')]));
    const worker = deps.workerState ? await deps.workerState() : undefined;
    const unavailable: Unavailable[] = [
      ...deploymentGaps(deps.caps),
      ...(can['export.server'] ? [] : [RENDER_FORBIDDEN]),
      ...(worker && worker !== 'ready' ? [{ feature: 'render-worker', code: worker === 'busy' ? 'RENDER_BUSY' : 'WORKER_UNREACHABLE',
        reason: worker === 'busy' ? 'The render worker is at capacity. Retry shortly.' : 'The render worker did not answer its readiness check.' }] : []),
    ];
    const own = deps.tokenLimits ? await deps.tokenLimits(req) : null;
    sendJson(res, 200, {
      version: DISCOVERY_VERSION,
      principal: kindOf(caller.principal),
      ...(scopes ? { token: { scopes, scopesVersion: TOKEN_SCOPES_VERSION, ...(caller.user?.tokenTools ? { tools: caller.user.tokenTools } : {}) } } : {}),
      can,
      render: { formats: deps.caps.formats, hookedTools: deps.caps.hookedTools, ...(worker ? { worker } : {}) },
      assets: { providerRefs: await deps.providerRefs(caller.groups) },
      limits: { batch: BATCH_LIMITS, toolsPerPage: PAGE.max, ...(own ? { token: own.limits } : {}) },
      ...(own ? { usage: own.usage } : {}),
      unavailable,
      links: LINKS,
    });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/discovery/tools', async (req, res, ctx) => {
    const caller = await deps.caller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const rawLimit = ctx.url.searchParams.get('limit');
    const limit = rawLimit === null ? PAGE.default : Number(rawLimit);
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE.max) return sendError(res, 400, 'INVALID_INPUT', `limit must be an integer from 1 to ${PAGE.max}`);
    const cursor = ctx.url.searchParams.get('cursor');
    const after = cursor === null ? null : Buffer.from(cursor, 'base64url').toString('utf8');
    if (after !== null && !TOOL_ID.test(after)) return sendError(res, 400, 'INVALID_INPUT', 'cursor is not one this route issued');
    const [overlays, grants, own] = await Promise.all([deps.overlays(), deps.grants(), caller.user ? published(caller.groups) : Promise.resolve(new Map<string, { files: ReadonlyMap<string, Buffer> }>())]);
    // Keyset paging over the sorted pack ids and the caller's published rules
    // tools: a cursor only says where to resume, so it reveals nothing about tools
    // the caller cannot see.
    const ids = [...new Set([...deps.toolIds(), ...own.keys()])].sort();
    const usable = ids.filter(id => (after === null || id > after) && mayUseTool(caller.user, id, overlays, grants, deps.accessMode, own.has(id)));
    const page = usable.slice(0, limit);
    const tools = await Promise.all(page.map(async id => {
      const schema = `/api/v1/schema/${encodeURIComponent(id)}`;
      let described: ToolDescription;
      try { described = await describe(id, own.get(id)?.files); }
      catch { return { id, formats: [], can: { render: false }, schema, unavailable: [{ action: 'use', code: 'TOOL_UNAVAILABLE', reason: 'This deployment cannot load this tool.' }] }; }
      // Formats depend on the deployment and the tool policy only; input rules
      // are left to the schema route, which reads the design-system rules too.
      const allowed = policyFormats(described.server.formats, overlays.get(id));
      const render = mayRenderTool(caller.user, id, overlays, grants, deps.accessMode, own.has(id));
      return { id, name: described.name, version: described.version, renderer: described.server.renderer, formats: allowed.formats,
        can: { render }, schema, unavailable: [...described.server.unavailable, ...allowed.unavailable, ...(render ? [] : [RENDER_FORBIDDEN])] };
    }));
    sendJson(res, 200, { version: DISCOVERY_VERSION, tools, next: usable.length > limit ? Buffer.from(page.at(-1)!).toString('base64url') : null });
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/schema/:toolId', async (req, res, ctx) => {
    const caller = await deps.caller(req);
    if (!caller) return sendError(res, 401, 'UNAUTHORIZED', 'this deployment is sign-in gated');
    const toolId = ctx.params.toolId!;
    const [overlays, grants] = await Promise.all([deps.overlays(), deps.grants()]);
    if (!TOOL_ID.test(toolId)) return sendError(res, 400, 'INVALID_INPUT', 'bad tool id');
    // A rules tool the caller's own feed carries is theirs to use, under its own rules.
    const own = caller.user ? (await published(caller.groups)).get(toolId) : undefined;
    if (!mayUseTool(caller.user, toolId, overlays, grants, deps.accessMode, !!own)) return sendError(res, 403, 'FORBIDDEN', 'tool.use required');
    const view = ctx.url.searchParams.get('view') ?? 'effective';
    if (view !== 'effective' && view !== 'raw') return sendError(res, 400, 'INVALID_INPUT', 'view must be effective or raw');
    // The raw contract shows inputs policy hides, so it is for the people who write
    // that policy. No scope covers policy, so a scoped token never sees it.
    if (view === 'raw' && (caller.user?.tokenScopes || !(caller.user && evaluate({ userId: caller.user.id, groups: caller.user.groups, role: caller.user.role as Role }, 'policy.edit', [`tool:${toolId}`, '*'], grants)))) {
      return sendError(res, 403, 'FORBIDDEN', 'policy.edit is required for the raw schema');
    }
    let described: ToolDescription;
    try { described = await describe(toolId, own?.files); }
    catch (e) {
      if (e instanceof ToolLoadRefusal) return sendError(res, e.status, e.code, e.message);
      return sendError(res, 400, 'DOCUMENT_API_ERROR', withoutServerPaths((e as Error).message));
    }
    const tool = { name: described.name, version: described.version };
    if (view === 'raw') {
      return sendWithEtag(req, res, { apiVersion: described.apiVersion, schema: described.raw, view, toolId, tool,
        versions: { engine: described.engineVersion, tool: described.version } });
    }
    const requested = ctx.url.searchParams.get('format')?.toLowerCase();
    const format = requested === 'jpeg' ? 'jpg' : requested;
    if (format !== undefined && ![...described.server.formats, ...described.server.unavailable.map(entry => entry.format)].includes(format)) {
      return sendError(res, 400, 'INVALID_INPUT', 'format is not one this tool declares');
    }
    let contract: Awaited<ReturnType<typeof contractFor>>;
    try { contract = await contractFor(deps, described, overlays, caller.groups, format); }
    catch (e) { if (e instanceof BrandError) return sendError(res, e.status, e.code, e.message); throw e; }
    const render = mayRenderTool(caller.user, toolId, overlays, grants, deps.accessMode, !!own);
    sendWithEtag(req, res, {
      apiVersion: described.apiVersion, schema: contract.schema, view, toolId, tool,
      versions: { engine: described.engineVersion, tool: described.version, policy: contract.overlay?.version ?? 0,
        design: deps.designRevision(), catalog: await deps.catalogVersion(), ...(contract.rules ? { rules: contract.rules.rulesDigest.slice(0, 16) } : {}) },
      policy: contract.effects,
      render: { renderer: described.server.renderer, formats: contract.formats, ...(contract.format ? { format: contract.format } : {}) },
      unavailable: [...contract.unavailable, ...(render ? [] : [RENDER_FORBIDDEN])],
    });
  }, { delivery: 'person-private' });
}
