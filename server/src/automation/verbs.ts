// SPDX-License-Identifier: MPL-2.0
/** Thin hosted adapters over @lolly/engine's document API. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEngine, type LoadedTool, type Profile } from '../render/contract.ts';
import { withRenderHost } from '../render/host.ts';
import { parseHostedProviderRef, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';
import { toolServerFormats, type RenderCapabilities, type ToolServerFormats } from '../render/capabilities.ts';
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
  policy?: { overlays: Map<string, ToolOverlay>; groups: string[] };
}
/** `format` names the output the document is for, so that format's design-system
 *  rules apply. It must be one the tool declares. */
export interface ToolRequest { toolId: string; inputs?: Record<string, unknown>; designVersion?: string; format?: string }

const formatKey = (format: string) => format.toLowerCase() === 'jpeg' ? 'jpg' : format.toLowerCase();
function requireDeclaredFormat(tool: LoadedTool, format: unknown): void {
  if (format === undefined) return;
  if (typeof format !== 'string' || !tool.manifest.render.formats.map(formatKey).includes(formatKey(format))) throw new Error('format is not one this tool declares');
}

async function load(pack: string, toolId: string): Promise<{ engine: Awaited<ReturnType<typeof loadEngine>>; tool: LoadedTool }> {
  const engine = await loadEngine();
  const tool = await engine.loadTool(toolId, (path) => readFile(join(pack, 'tools', path), 'utf8'));
  return { engine, tool };
}

export async function schemaVerb(ctx: AutomationContext, toolId: string): Promise<unknown> {
  const { engine, tool } = await load(ctx.pack, toolId);
  return { apiVersion: engine.DOCUMENT_API_VERSION, schema: engine.documentSchema(tool) };
}

/** A tool's raw contract and where it can render on this deployment, read from
 *  the loaded tool. The caller's policy is applied on top by the discovery
 *  routes (automation/discovery.ts). */
export interface ToolDescription {
  toolId: string; name: string; version: string; apiVersion: string; engineVersion: string;
  raw: Record<string, unknown>; server: ToolServerFormats;
}
export async function describeTool(ctx: AutomationContext, toolId: string, deployment: { caps: RenderCapabilities; allowHooksInFastPath: boolean; tokens: boolean }): Promise<ToolDescription> {
  const { engine, tool } = await load(ctx.pack, toolId);
  const template = tool.template;
  return {
    toolId, name: typeof tool.manifest.name === 'string' ? tool.manifest.name : toolId, version: tool.manifest.version,
    apiVersion: engine.DOCUMENT_API_VERSION, engineVersion: engine.ENGINE_VERSION, raw: engine.documentSchema(tool),
    server: toolServerFormats({ formats: tool.manifest.render.formats, hooks: !!tool.hooksSource,
      svgTemplate: typeof template === 'string' && /<svg\b/i.test(template), requires: tool.manifest.requires ?? [] }, deployment),
  };
}

export async function compileVerb(ctx: AutomationContext, req: ToolRequest): Promise<unknown> {
  const { engine, tool } = await load(ctx.pack, req.toolId);
  requireDeclaredFormat(tool, req.format);
  const inputs = ctx.policy ? applyInputPolicy(req.inputs ?? {}, ctx.policy.overlays.get(req.toolId), ctx.policy.groups) : req.inputs ?? {};
  return withRenderHost(ctx, async (_dom, host) => engine.compileDocument(tool, inputs, { host, ...(req.designVersion ? { designVersion: req.designVersion } : {}) }));
}

export async function validateVerb(ctx: AutomationContext, body: Record<string, unknown>): Promise<unknown> {
  if (typeof body.toolId === 'string') {
    const { engine, tool } = await load(ctx.pack, body.toolId);
    requireDeclaredFormat(tool, body.format);
    const governed = (result: { ok: boolean; errors: unknown[]; warnings: unknown[] }, values: () => Record<string, unknown>) =>
      ctx.policy ? effectiveValidation(result, values(), ctx.policy.overlays.get(body.toolId as string), ctx.policy.groups) : result;
    if (typeof body.recipe === 'string') {
      const recipe = body.recipe;
      const result = engine.validateDocument({ kind: 'recipe', manifest: tool.manifest, value: recipe });
      return result.ok ? governed(result, () => engine.parseUrlState(recipe, tool.manifest).values) : result;
    }
    const value = (body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) as Record<string, unknown>;
    return governed(engine.validateDocument({ kind: 'inputs', manifest: tool.manifest, value }), () => value);
  }
  const engine = await loadEngine();
  if (body.document !== undefined) return engine.validateDocument({ kind: 'document', value: body.document });
  if (body.manifest !== undefined) return engine.validateDocument({ kind: 'manifest', value: body.manifest });
  return { ok: false, errors: [{ path: '/', message: 'toolId, document, or manifest is required' }], warnings: [] };
}

export async function documentVerb(ctx: AutomationContext, verb: 'inspect' | 'measure' | 'optimize', req: ToolRequest & { document?: unknown; bytesBase64?: string; source?: string; upload?: unknown; opts?: Record<string, unknown> }): Promise<unknown> {
  const engine = await loadEngine();
  let bytes: Uint8Array | undefined;
  if (req.upload !== undefined) {
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
    return { bytesBase64: Buffer.from(value).toString('base64'), bytes: value.byteLength, savedBytes: optimized.savedBytes, stages: optimized.stages };
  }
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
