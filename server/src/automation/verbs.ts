// SPDX-License-Identifier: MPL-2.0
/** Thin hosted adapters over @lolly/engine's document API. */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { loadEngine, type LoadedTool, type Profile } from '../render/contract.ts';
import { withRenderHost } from '../render/host.ts';
import { parseHostedProviderRef, type HostedAssetResult, type HostedProviderRef } from '../catalog/providers/asset-resolver.ts';

export interface AutomationContext { pack: string; profile: Profile; hostedResolver?: (ref: HostedProviderRef) => Promise<HostedAssetResult | null> }
export interface ToolRequest { toolId: string; inputs?: Record<string, unknown>; designVersion?: string }

async function load(pack: string, toolId: string): Promise<{ engine: Awaited<ReturnType<typeof loadEngine>>; tool: LoadedTool }> {
  const engine = await loadEngine();
  const tool = await engine.loadTool(toolId, (path) => readFile(join(pack, 'tools', path), 'utf8'));
  return { engine, tool };
}

export async function schemaVerb(ctx: AutomationContext, toolId: string): Promise<unknown> {
  const { engine, tool } = await load(ctx.pack, toolId);
  return { apiVersion: engine.DOCUMENT_API_VERSION, schema: engine.documentSchema(tool) };
}

export async function compileVerb(ctx: AutomationContext, req: ToolRequest): Promise<unknown> {
  const { engine, tool } = await load(ctx.pack, req.toolId);
  return withRenderHost(ctx, async (_dom, host) => engine.compileDocument(tool, req.inputs ?? {}, { host, ...(req.designVersion ? { designVersion: req.designVersion } : {}) }));
}

export async function validateVerb(ctx: AutomationContext, body: Record<string, unknown>): Promise<unknown> {
  if (typeof body.toolId === 'string') {
    const { engine, tool } = await load(ctx.pack, body.toolId);
    if (typeof body.recipe === 'string') return engine.validateDocument({ kind: 'recipe', manifest: tool.manifest, value: body.recipe });
    const value = (body.inputs && typeof body.inputs === 'object' ? body.inputs : {}) as Record<string, unknown>;
    return engine.validateDocument({ kind: 'inputs', manifest: tool.manifest, value });
  }
  const engine = await loadEngine();
  if (body.document !== undefined) return engine.validateDocument({ kind: 'document', value: body.document });
  if (body.manifest !== undefined) return engine.validateDocument({ kind: 'manifest', value: body.manifest });
  return { ok: false, errors: [{ path: '/', message: 'toolId, document, or manifest is required' }], warnings: [] };
}

export async function documentVerb(ctx: AutomationContext, verb: 'inspect' | 'measure' | 'optimize', req: ToolRequest & { document?: unknown; bytesBase64?: string; source?: string; opts?: Record<string, unknown> }): Promise<unknown> {
  const engine = await loadEngine();
  let bytes: Uint8Array | undefined;
  if (typeof req.bytesBase64 === 'string') bytes = new Uint8Array(Buffer.from(req.bytesBase64, 'base64'));
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
