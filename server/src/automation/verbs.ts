// SPDX-License-Identifier: MPL-2.0
/** Thin hosted adapters over @lolly/engine's document API. */
import { isPublishedTemplateRef } from '../catalog/templates.ts';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEngine, type LoadedTool, type Profile } from '../render/contract.ts';
import { loadToolOrRefuse } from '../render/tool-load.ts';
import { withRenderHost } from '../render/host.ts';
import { designRuleIssues, vectorFieldParams } from '../render/pipeline.ts';
import { parseHostedProviderRef, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';
import { isSvgTemplate, toolServerFormats, type RenderCapabilities, type ToolServerFormats } from '../render/capabilities.ts';
import type { ToolOverlay } from '../policy/overlay.ts';
import { applyInputPolicy, effectiveValidation } from './effective-contract.ts';

/** `policy` is the caller's tool policy, with the design-system choice rules for
 *  the request's tool and format already in its overlay (brand/rules.ts). With
 *  it, compile and validate check inputs against the same effective contract the
 *  schema route describes for that format and the render route enforces; without
 *  it they see the raw tool contract. */
export interface AutomationContext {
  pack: string; profile: Profile; hostedResolver?: (ref: HostedProviderRef) => Promise<HostedAssetResult | null>;
  /** The bytes of a finished automation-input upload the caller owns, named
   *  `{ id, checksum }` (uploads/scoped.ts `readUploadReference`). */
  readUpload?: (ref: unknown) => Promise<Uint8Array>;
  /** The bytes of a file reference the caller owns, named `{ id, checksum }`
   *  (uploads/files.ts), with what it declares about them. */
  readFile?: (ref: unknown) => Promise<{ bytes: Uint8Array; file: VerbFile }>;
  /** Keep an optimize output as a file reference of the caller, made from
   *  `source` when the input was one, and answer what the files routes show. */
  saveFile?: (output: Uint8Array, made: { source?: VerbFile; input: Uint8Array; opts?: Record<string, unknown>; stages: string[] }) => Promise<unknown>;
  policy?: { overlays: Map<string, ToolOverlay>; groups: string[] };
  /** A published rules tool's own files, from the caller's served feed (plans/82
   *  M2), or null for a tool the pack holds. Tool-relative path to bytes. */
  toolFiles?: (toolId: string) => Promise<ReadonlyMap<string, Buffer> | null>;
}
/** What a verb knows of a file reference it read. */
export interface VerbFile { id: string; checksum: string; name: string; contentType: string }
/** `format` names the output the document is for, so that format's design-system
 *  rules apply. It must be one the tool declares. */
export interface ToolRequest { toolId: string; inputs?: Record<string, unknown>; designVersion?: string; format?: string }

const formatKey = (format: string) => format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase();
function requireDeclaredFormat(tool: LoadedTool, format: unknown): void {
  if (format === undefined) return;
  if (typeof format !== 'string' || !tool.manifest.render.formats.map(formatKey).includes(formatKey(format))) throw new Error('format is not one this tool declares');
}

async function load(ctx: Pick<AutomationContext, 'pack' | 'toolFiles'>, toolId: string): Promise<{ engine: Awaited<ReturnType<typeof loadEngine>>; tool: LoadedTool }> {
  const engine = await loadEngine();
  // A published rules tool reads its own files, built for this caller, and nothing from the pack.
  const own = await ctx.toolFiles?.(toolId) ?? null;
  const read = async (path: string): Promise<string> => {
    if (!own) return readFile(join(ctx.pack, 'tools', path), 'utf8');
    const file = own.get(path.slice(path.indexOf('/') + 1));
    if (!file) throw Object.assign(new Error(`no such file: ${path}`), { code: 'ENOENT' });
    return file.toString('utf8');
  };
  const tool = await loadToolOrRefuse(toolId, (id) => engine.loadTool(id, read));
  return { engine, tool };
}

export async function schemaVerb(ctx: AutomationContext, toolId: string): Promise<unknown> {
  const { engine, tool } = await load(ctx, toolId);
  return { apiVersion: engine.DOCUMENT_API_VERSION, schema: engine.documentSchema(tool) };
}

/** A tool's raw contract and where it can render on this deployment, read from
 *  the loaded tool. The caller's policy is applied on top by the discovery
 *  routes (automation/discovery.ts). */
export interface ToolDescription {
  toolId: string; name: string; version: string; apiVersion: string; engineVersion: string;
  raw: Record<string, unknown>; server: ToolServerFormats; manifest: LoadedTool['manifest'];
}
export async function describeTool(ctx: AutomationContext, toolId: string, deployment: { caps: RenderCapabilities; allowHooksInFastPath: boolean; tokens: boolean }): Promise<ToolDescription> {
  const { engine, tool } = await load(ctx, toolId);
  const template = tool.template;
  return {
    toolId, name: typeof tool.manifest.name === 'string' ? tool.manifest.name : toolId, version: tool.manifest.version,
    apiVersion: engine.DOCUMENT_API_VERSION, engineVersion: engine.ENGINE_VERSION, raw: engine.documentSchema(tool), manifest: tool.manifest,
    server: toolServerFormats({ formats: tool.manifest.render.formats, hooks: !!tool.hooksSource,
      svgTemplate: isSvgTemplate(template), requires: tool.manifest.requires ?? [] }, deployment),
  };
}

export async function compileVerb(ctx: AutomationContext, req: ToolRequest): Promise<unknown> {
  const { engine, tool } = await load(ctx, req.toolId);
  requireDeclaredFormat(tool, req.format);
  const inputs = ctx.policy ? applyInputPolicy(req.inputs ?? {}, ctx.policy.overlays.get(req.toolId), ctx.policy.groups) : req.inputs ?? {};
  return withRenderHost(ctx, async (_dom, host) => engine.compileDocument(tool, inputs, { host, ...(req.designVersion ? { designVersion: req.designVersion } : {}) }));
}

export async function validateVerb(ctx: AutomationContext, body: Record<string, unknown>): Promise<unknown> {
  if (typeof body.toolId === 'string') {
    const { engine, tool } = await load(ctx, body.toolId);
    requireDeclaredFormat(tool, body.format);
    const format = typeof body.format === 'string' ? body.format : undefined;
    // A rules tool's own rules (plans/82 M2) refuse here what the render refuses:
    // a param the designer fixed, a format not enabled and a value outside the
    // designer's choices, each with the code the render answers.
    const designed = async <T extends { ok: boolean; errors: unknown[] }>(result: T, query: string): Promise<T> => {
      if (!(tool.manifest as { designTool?: unknown }).designTool) return result;
      const expanded = vectorFieldParams(await engine.expandQuery(query), tool.manifest);
      const issues = designRuleIssues(engine, tool.manifest, expanded, engine.parseUrlState(expanded, tool.manifest).values as Record<string, unknown>, format);
      if (!issues.length) return result;
      const errors = [...result.errors, ...issues.map((issue) => ({ path: issue.param ? `/${issue.param}` : '/format', message: issue.message, code: issue.code }))];
      return { ...result, ok: false, errors };
    };
    const governed = (result: { ok: boolean; errors: unknown[]; warnings: unknown[] }, values: () => Record<string, unknown>) =>
      ctx.policy ? effectiveValidation(result, values(), ctx.policy.overlays.get(body.toolId as string), ctx.policy.groups) : result;
    if (typeof body.recipe === 'string') {
      const recipe = body.recipe;
      const result = engine.validateDocument({ kind: 'recipe', manifest: tool.manifest, value: recipe });
      return result.ok ? designed(governed(result, () => engine.parseUrlState(recipe, tool.manifest).values), recipe) : result;
    }
    const raw = (body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) as Record<string, unknown>;
    // A published template the render starts from (plans/82 M2) rides in the inputs
    // as `template`, a reserved URL-mode name rather than an input. The render
    // checks it and applies its rules; the schema check here is for the inputs.
    const { template, ...rest } = raw;
    const value = isPublishedTemplateRef(template) ? rest : raw;
    return designed(governed(engine.validateDocument({ kind: 'inputs', manifest: tool.manifest, value }), () => value), queryFromInputs(value));
  }
  const engine = await loadEngine();
  if (body.document !== undefined) return engine.validateDocument({ kind: 'document', value: body.document });
  if (body.manifest !== undefined) return engine.validateDocument({ kind: 'manifest', value: body.manifest });
  return { ok: false, errors: [{ path: '/', message: 'toolId, document, or manifest is required' }], warnings: [] };
}

export async function documentVerb(ctx: AutomationContext, verb: 'inspect' | 'measure' | 'optimize', req: ToolRequest & { document?: unknown; bytesBase64?: string; source?: string; upload?: unknown; file?: unknown; output?: unknown; opts?: Record<string, unknown> }): Promise<unknown> {
  const engine = await loadEngine();
  let bytes: Uint8Array | undefined;
  let source: VerbFile | undefined;
  if (req.output !== undefined && req.output !== 'inline' && req.output !== 'file') throw new Error('output is inline or file');
  if (req.output === 'file' && verb !== 'optimize') throw new Error('only optimize keeps its output as a file reference');
  if (req.file !== undefined) {
    // A file reference stands in for inline bytes, never beside them.
    if (req.bytesBase64 !== undefined || req.source !== undefined || req.upload !== undefined) throw new Error('give one of bytesBase64, source, upload or file');
    if (!ctx.readFile) throw new Error('file references are not available here');
    ({ bytes, file: source } = await ctx.readFile(req.file));
  } else if (req.upload !== undefined) {
    // An upload stands in for inline bytes, never beside them.
    if (req.bytesBase64 !== undefined || req.source !== undefined) throw new Error('give one of bytesBase64, source or upload');
    if (!ctx.readUpload) throw new Error('upload references are not available here');
    bytes = await ctx.readUpload(req.upload);
  } else if (typeof req.bytesBase64 === 'string') bytes = new Uint8Array(Buffer.from(req.bytesBase64, 'base64'));
  else if (typeof req.source === 'string') {
    const ref = parseHostedProviderRef(req.source);
    if (!ref || !ctx.hostedResolver) throw new Error('source must be a configured provider ref');
    const resolved = await ctx.hostedResolver(ref);
    const match = resolved && /^data:[^;,]+;base64,(.+)$/s.exec(resolved.asset.url);
    if (!match) throw new Error(`source is not available: ${req.source}`);
    bytes = new Uint8Array(Buffer.from(match[1]!, 'base64'));
  }
  if (bytes) {
    if (verb === 'measure') throw new Error('measure requires a compiled document');
    if (verb === 'inspect') return engine.inspectDocument(bytes);
    const optimized = await engine.optimizeDocument(bytes, req.opts);
    const value = optimized.value as Uint8Array;
    if (req.output === 'file') {
      // The output stays on this instance as a reference; no bytes come back.
      if (!ctx.saveFile) throw new Error('file references are not available here');
      const file = await ctx.saveFile(value, { ...(source ? { source } : {}), input: bytes, ...(req.opts ? { opts: req.opts } : {}), stages: optimized.stages });
      return { file, bytes: value.byteLength, savedBytes: optimized.savedBytes, stages: optimized.stages };
    }
    return { bytesBase64: Buffer.from(value).toString('base64'), bytes: value.byteLength, savedBytes: optimized.savedBytes, stages: optimized.stages };
  }
  if (req.output === 'file') throw new Error('only an optimize of file bytes keeps its output as a file reference');
  let document = req.document;
  if (!document) document = (await compileVerb(ctx, req) as { document: unknown }).document;
  if (verb === 'inspect') return engine.inspectDocument(document);
  if (verb === 'measure') return engine.measureDocument(document, req.opts);
  return engine.optimizeDocument(document, req.opts);
}

export async function packageVerb(document: unknown): Promise<{ bytes: Uint8Array; manifest: Record<string, unknown> }> {
  const engine = await loadEngine();
  return engine.packageDocument(document);
}

export async function diffVerb(a: unknown, b: unknown): Promise<unknown> {
  const engine = await loadEngine();
  return engine.diffDocuments(a, b);
}

export function queryFromInputs(inputs: Record<string, unknown>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(inputs)) {
    if (value === undefined || value === null) continue;
    query.set(key, typeof value === 'object' ? JSON.stringify(value) : String(value));
  }
  return query.toString();
}
