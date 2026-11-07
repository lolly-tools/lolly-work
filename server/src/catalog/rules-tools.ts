// SPDX-License-Identifier: MPL-2.0
/**
 * Rules tools (plans/82 M2): a Share with rules file published through Work.
 *
 * Lolly's Share with rules turns a Design document into a tool of its own: the
 * designer picks the objects people may change, and everything else is fixed.
 * The file it downloads (`.lolly`, kind `tool`) carries compiled code: a
 * `hooks.js` made of Design's renderer, the locked definition, and the engine's
 * consumer hooks.
 *
 * Work never stores, serves or runs that code. It takes the DATA out of the
 * file (the locked definition and the files it depends on), checks it, and
 * builds the tool again with its own pinned engine compiler and its own pack's
 * Design renderer. What partners load and what server renders run is therefore
 * code this workspace produced itself, from data. A file made with another
 * Lolly version is rebuilt with this workspace's Design, and the record says so
 * (`rebuilt`), because its output can differ slightly from what the author saw
 * (decision D5, 2026-11-07).
 *
 * The stored bytes of a `rules-tool` asset are that data as JSON, so versions,
 * lifecycle, groups and audit are the instance asset's own. The tool is built
 * from them when it is served, memoised per data and renderer, the way a pack
 * tool follows the mounted pack.
 *
 * Only files made from Design are taken for now. A file made from another
 * tool's session embeds that tool's own code, which Work would have to check
 * against its pack at the same version; it is refused with a sentence saying so.
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { centralEntries, entryBytes } from './instance-pack.ts';

export const RULES_TOOL_TYPE = 'rules-tool';
/** A file with fonts and photographs embedded runs to a few MiB. */
export const MAX_RULES_FILE_BYTES = 32 * 1024 * 1024;
const MAX_ENTRIES = 512;
const TOOL_ID = /^[a-z0-9][a-z0-9-]{2,95}$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const ASSET_PATH = /^assets\/[\w./-]+$/;
const DEFINITION_MARKER = '\nvar lockedDefinition = ';

/** What a rules tool is rebuilt from. Never code. */
export interface RulesToolData {
  kind: 'design';
  /** The locked definition (DesignToolDefinitionV1), exactly as the file carried it. */
  definition: Record<string, unknown>;
  /** The files it depends on, by path, base64. */
  assets: Record<string, string>;
}

/** What the console and the feed say about a rules tool. */
export interface RulesToolFacts {
  toolId: string;
  version: string;
  name: string;
  description?: string;
  formats: string[];
  /** The inputs people may change: the designer's own choice, in their words. */
  inputs: Array<{ id: string; label: string }>;
}

export type RulesFileOutcome = { ok: true; data: RulesToolData; facts: RulesToolFacts } | { ok: false; detail: string };

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const sha256 = (bytes: Uint8Array | string): string => createHash('sha256').update(bytes).digest('hex');

/** The facts a definition states about itself. */
export function rulesToolFacts(definition: Record<string, unknown>): RulesToolFacts {
  const inputs = Array.isArray(definition.inputs) ? definition.inputs as Array<{ input?: { id?: unknown; label?: unknown } }> : [];
  return {
    toolId: String(definition.id),
    version: String(definition.version),
    name: String(definition.name ?? definition.id).slice(0, 200),
    ...(typeof definition.description === 'string' && definition.description.trim() ? { description: definition.description.trim().slice(0, 500) } : {}),
    formats: Array.isArray(definition.formats) ? definition.formats.filter((f): f is string => typeof f === 'string') : [],
    inputs: inputs.flatMap((f) => typeof f.input?.id === 'string'
      ? [{ id: f.input.id, label: typeof f.input.label === 'string' && f.input.label ? f.input.label : f.input.id }] : []),
  };
}

/**
 * Where a definition would load something from outside the file: an image or
 * font named by URL rather than embedded, or a style rule that reaches out.
 * Share with rules embeds every image and font as data, so a file that does
 * not is either from an older Lolly or edited by hand; either way it is
 * refused rather than allowed to fetch from partners' browsers.
 */
export function outsideReference(value: unknown, depth = 0): string | null {
  if (depth > 64) return 'the definition is nested too deeply';
  if (typeof value === 'string') {
    if (/url\(\s*["']?\s*(?!data:|#)[^)\s"']/i.test(value)) return 'a style refers to a file outside this one';
    if (/\bsrc\s*=\s*["']?\s*(?:https?:|\/\/)/i.test(value)) return 'a picture is linked rather than embedded';
    if (/<\/?(?:script|iframe|object|embed)\b/i.test(value)) return 'the definition carries markup that is not allowed';
    return null;
  }
  if (Array.isArray(value)) {
    for (const item of value) { const found = outsideReference(item, depth + 1); if (found) return found; }
    return null;
  }
  if (isObj(value)) {
    for (const [key, item] of Object.entries(value)) {
      if ((key === 'url' || key === 'src') && typeof item === 'string' && item && !/^(?:data:(?:image|font)\/|#)/i.test(item)) return 'a picture is linked rather than embedded';
      const found = outsideReference(item, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Read a Share with rules file and keep only its data. The file's own code is
 * read only to find the definition inside it and is then dropped.
 */
export function readRulesToolFile(bytes: Buffer): RulesFileOutcome {
  if (bytes.length > MAX_RULES_FILE_BYTES) return { ok: false, detail: `a Share with rules file is at most ${MAX_RULES_FILE_BYTES} bytes` };
  let files: Map<string, Buffer>;
  try {
    const entries = centralEntries(bytes);
    if (entries.length > MAX_ENTRIES) return { ok: false, detail: 'this file has too many parts' };
    let total = 0;
    files = new Map();
    for (const entry of entries) {
      if (entry.name.endsWith('/')) continue;
      total += entry.size;
      if (total > 2 * MAX_RULES_FILE_BYTES) return { ok: false, detail: 'this file unpacks to more than a Share with rules file holds' };
      files.set(entry.name, entryBytes(bytes, entry));
    }
  } catch {
    return { ok: false, detail: 'this is not a .lolly file' };
  }
  const json = (path: string): Record<string, unknown> | null => {
    const raw = files.get(path);
    if (!raw) return null;
    try { const value = JSON.parse(raw.toString('utf8')); return isObj(value) ? value : null; } catch { return null; }
  };
  const manifest = json('manifest.json');
  if (manifest?.format !== 'lolly-share') return { ok: false, detail: 'this is not a .lolly file' };
  const bundled = manifest.bundledTool as { id?: unknown } | undefined;
  if (manifest.kind !== 'tool' || !isObj(bundled)) return { ok: false, detail: 'this .lolly file is not a Share with rules tool. Use Share with rules in Lolly, then Download.' };
  // The integrity map, when present, must hold: a damaged file is refused here
  // rather than rebuilt from whatever survived.
  if (isObj(manifest.integrity)) {
    for (const [path, expected] of Object.entries(manifest.integrity)) {
      const part = files.get(path);
      if (!part || sha256(part) !== expected) return { ok: false, detail: 'this file is damaged: a part does not match its checksum' };
    }
  }
  const toolJson = json('tool/tool.json');
  const designTool = toolJson?.designTool;
  if (!toolJson || !isObj(designTool)) return { ok: false, detail: 'this .lolly file is not a Share with rules tool. Use Share with rules in Lolly, then Download.' };
  if (designTool.sourceTool) return { ok: false, detail: 'This file was made from another tool\'s session. For now, Work takes Share with rules files made in Design.' };
  const hooks = files.get('tool/hooks.js')?.toString('utf8') ?? '';
  const at = hooks.lastIndexOf(DEFINITION_MARKER);
  const end = at < 0 ? -1 : hooks.indexOf('\n', at + DEFINITION_MARKER.length);
  const line = at < 0 || end < 0 ? '' : hooks.slice(at + DEFINITION_MARKER.length, end);
  let definition: unknown;
  try { definition = JSON.parse(line.replace(/;\s*$/, '')); } catch { definition = null; }
  if (!isObj(definition)) return { ok: false, detail: 'this file does not carry a Design rules definition' };
  if (definition.schemaVersion !== 1 || definition.compilerVersion !== 1) return { ok: false, detail: 'this file was made with a rules version this workspace does not read' };
  if (typeof definition.id !== 'string' || !TOOL_ID.test(definition.id)) return { ok: false, detail: 'the tool id in this file is not valid' };
  if (definition.id !== bundled.id || definition.id !== toolJson.id) return { ok: false, detail: 'this file names two different tools' };
  if (typeof definition.version !== 'string' || !VERSION.test(definition.version) || definition.version !== toolJson.version) return { ok: false, detail: 'this file does not carry one clear version' };
  if (definition.sourceTool) return { ok: false, detail: 'This file was made from another tool\'s session. For now, Work takes Share with rules files made in Design.' };
  // The definition's own style rules: fonts as data, no imports, nothing that
  // closes the style element they are written into.
  if (typeof definition.css === 'string' && /@import\b|expression\s*\(|<\//i.test(definition.css)) {
    return { ok: false, detail: 'Work cannot publish this file: its style rules reach outside it. Open the document in Lolly and share again.' };
  }
  const outside = outsideReference(definition);
  if (outside) return { ok: false, detail: `Work cannot publish this file: ${outside}. Open the document in Lolly, embed it, and share again.` };
  // The files the definition depends on, checked against its own digests.
  const assets: Record<string, string> = {};
  const deps = Array.isArray(definition.dependencies) ? definition.dependencies as Array<{ path?: unknown; digest?: unknown }> : [];
  for (const dep of deps) {
    const path = typeof dep.path === 'string' ? dep.path : '';
    if (!ASSET_PATH.test(path) || path.split('/').includes('..')) return { ok: false, detail: 'a file this tool depends on has an unsafe name' };
    const part = files.get(`tool/${path}`);
    if (!part) return { ok: false, detail: `this file is missing ${path}` };
    if (sha256(part) !== dep.digest) return { ok: false, detail: `${path} does not match the definition` };
    assets[path] = part.toString('base64');
  }
  return { ok: true, data: { kind: 'design', definition, assets }, facts: rulesToolFacts(definition) };
}

/** The stored data, read back. Null when the bytes are not rules-tool data. */
export function readRulesToolData(bytes: Uint8Array): RulesToolData | null {
  try {
    const value = JSON.parse(Buffer.from(bytes).toString('utf8')) as Partial<RulesToolData>;
    return value?.kind === 'design' && isObj(value.definition) && isObj(value.assets) ? value as RulesToolData : null;
  } catch {
    return null;
  }
}

/** The stored form of the data: one JSON document, keys in a fixed order. */
export function rulesToolBytes(data: RulesToolData): Buffer {
  const assets = Object.fromEntries(Object.entries(data.assets).sort(([a], [b]) => a.localeCompare(b)));
  return Buffer.from(`${JSON.stringify({ kind: data.kind, definition: data.definition, assets })}\n`, 'utf8');
}

/** This workspace's Design renderer: the pack's own, never the file's. */
export interface DesignRenderer { source: string; styles: string; digest: string }

export async function loadDesignRenderer(pack: string): Promise<DesignRenderer | null> {
  try {
    const [source, styles] = await Promise.all([
      readFile(join(pack, 'tools', 'design', 'assets', 'rules-renderer.js'), 'utf8'),
      readFile(join(pack, 'tools', 'design', 'styles.css'), 'utf8'),
    ]);
    return { source, styles, digest: sha256(source) };
  } catch {
    return null;
  }
}

interface Compiler {
  compileDesignTool(definition: Record<string, unknown>, renderer: { source: string; styles: string }, assets: Record<string, Uint8Array>): {
    manifest: Record<string, unknown>; files: Record<string, string | Uint8Array>;
  };
}
const ENGINE: string = '@lolly/engine';
let compiler: Promise<Compiler> | null = null;
const loadCompiler = (): Promise<Compiler> => compiler ??= (import(ENGINE) as Promise<Compiler>).catch((error: unknown) => { compiler = null; throw error; });

export interface BuiltRulesTool {
  toolId: string;
  manifest: Record<string, unknown>;
  /** Tool-relative path to bytes: tool.json, hooks.js, template.html, styles.css, compilation.json, assets/*. */
  files: Map<string, Buffer>;
  /** True when the file was made with a Design renderer other than this workspace's. */
  rebuilt: boolean;
}

/**
 * Build the tool from its data with this workspace's engine compiler and
 * Design renderer. Throws a plain sentence when the definition does not pass
 * the compiler's own checks.
 */
export async function buildRulesTool(data: RulesToolData, renderer: DesignRenderer): Promise<BuiltRulesTool> {
  const assets: Record<string, Uint8Array> = {};
  for (const [path, base64] of Object.entries(data.assets)) assets[path] = Buffer.from(base64, 'base64');
  const definition: Record<string, unknown> = { ...data.definition, rendererDigest: renderer.digest };
  const { compileDesignTool } = await loadCompiler();
  const compiled = compileDesignTool(definition, { source: renderer.source, styles: renderer.styles }, assets);
  const files = new Map<string, Buffer>();
  for (const [path, value] of Object.entries(compiled.files)) files.set(path, typeof value === 'string' ? Buffer.from(value, 'utf8') : Buffer.from(value));
  return { toolId: String(definition.id), manifest: compiled.manifest, files, rebuilt: data.definition.rendererDigest !== renderer.digest };
}

/** Rebuilt tools, memoised per data and renderer: a build is pure, so the same
 *  inputs always give the same files, and a new renderer builds afresh. */
export function createRulesToolBuilder(max = 64) {
  const memo = new Map<string, Promise<BuiltRulesTool>>();
  return (data: RulesToolData, checksum: string, renderer: DesignRenderer): Promise<BuiltRulesTool> => {
    const key = `${checksum}\n${renderer.digest}\n${sha256(renderer.styles)}`;
    let hit = memo.get(key);
    if (hit) { memo.delete(key); memo.set(key, hit); return hit; }
    hit = buildRulesTool(data, renderer).catch((error: unknown) => { memo.delete(key); throw error; });
    memo.set(key, hit);
    while (memo.size > max) memo.delete(memo.keys().next().value as string);
    return hit;
  };
}

/** Compare two three-part versions. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) - (pb[i] ?? 0);
  return 0;
}

/** The served `meta` of a rules tool: the tool it is, its own version, and what
 *  people may change. `rebuilt` tells the console it was built with this
 *  workspace's Design rather than the one it was made with. */
export function rulesToolMeta(facts: RulesToolFacts, rebuilt: boolean): Record<string, unknown> {
  return {
    toolId: facts.toolId,
    baseToolId: 'design',
    toolVersion: facts.version,
    valueCount: facts.inputs.length,
    editable: facts.inputs.map((input) => input.id),
    inputs: facts.inputs,
    toolFormats: facts.formats,
    ...(rebuilt ? { rebuilt: true } : {}),
  };
}

/**
 * The submit pipeline's reader for Share with rules files: read the data,
 * refuse an id the pack or another published rules tool already uses, require
 * a newer version for a version, and rebuild the tool once so a file that the
 * compiler refuses is refused here, at upload, and never reaches a partner.
 */
export function createRulesToolSubmitter(deps: {
  store: { listInstanceAssets(): Promise<import('./instance-assets.ts').InstanceAssetRecord[]> };
  pack: () => string;
  toolExists: (toolId: string) => Promise<boolean>;
}): import('./submit.ts').RulesToolSubmitter {
  return {
    async prepare(bytes, target) {
      const read = readRulesToolFile(bytes);
      if (!read.ok) return read;
      const { facts } = read;
      if (await deps.toolExists(facts.toolId)) return { ok: false, detail: `this workspace already has a tool with the id "${facts.toolId}". Give the rules tool its own id in Share with rules.` };
      const published = (meta: unknown) => (meta as { toolId?: unknown } | undefined)?.toolId;
      if (target) {
        const was = target.entry.meta as { toolId?: unknown; toolVersion?: unknown } | undefined;
        if (was?.toolId !== facts.toolId) return { ok: false, detail: `this file is the tool "${facts.toolId}", not "${String(was?.toolId)}"` };
        if (typeof was.toolVersion === 'string' && compareVersions(facts.version, was.toolVersion) <= 0) {
          return { ok: false, detail: `this file is version ${facts.version}, and ${was.toolVersion} is already published. Share it again in Lolly to make a newer version.` };
        }
      } else {
        const taken = (await deps.store.listInstanceAssets()).find((rec) => rec.entry.type === RULES_TOOL_TYPE && published(rec.entry.meta) === facts.toolId
          && rec.submission?.state !== 'returned');
        if (taken) return { ok: false, detail: `"${facts.toolId}" is already published as ${String(taken.entry.name ?? taken.id)}. Publish this file as its new version.` };
      }
      const renderer = await loadDesignRenderer(deps.pack());
      if (!renderer) return { ok: false, detail: 'this workspace\'s tools do not include Design, which rules tools are built with' };
      let built: BuiltRulesTool;
      try { built = await buildRulesTool(read.data, renderer); }
      catch (error) { return { ok: false, detail: `Work could not build this tool: ${String((error as Error).message ?? error).slice(0, 300)}` }; }
      return {
        ok: true,
        bytes: rulesToolBytes(read.data),
        name: facts.name,
        ...(facts.description ? { description: facts.description } : {}),
        summary: { kind: 'rules-tool', toolId: facts.toolId, toolName: facts.name, valueCount: facts.inputs.length, undeclared: 0 },
        meta: rulesToolMeta(facts, built.rebuilt),
      };
    },
  };
}
