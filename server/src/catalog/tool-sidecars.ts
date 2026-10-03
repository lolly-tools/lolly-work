// SPDX-License-Identifier: MPL-2.0
/**
 * Catalog files that are keyed by tool id, filtered per caller.
 *
 * `tools/index.json` is filtered by overlay visibility (catalog/signing.ts), but a
 * pack built from a Lolly checkout carries more files that name every tool in the
 * profile:
 *
 * - `tools/index.slim.json`, the cut-down index an unpinned shell paints its first
 *   gallery from. Filtered here exactly like `index.json`. A shell that pins a
 *   catalog key never reads it, and a shell that gets a 404 falls back to the full
 *   index, so a file that does not parse answers 404 rather than its raw bytes.
 * - `tools/index.sig.json` from the pack's build. It signs the build's index bytes,
 *   which this server never serves (the index is re-serialised per caller), and its
 *   `files` map names every tool. Without a signing key it answers 404; with one,
 *   the per-caller envelope is produced before this module is asked.
 * - Any other file under `tools/` answers 404. Nothing in the shell reads one, and
 *   an unknown listing must not reach a caller by default.
 * - `previews/<toolId>[.lookN].<ext>` and `og/<toolId>.<ext>`: preview art and
 *   social cards for one tool. A tool the caller cannot see answers 404, the same
 *   absence the `/tools/*` route shows.
 * - `previews/bundle.json` (keys `<toolId>:<n>`) and dotfiles in those two
 *   directories such as `og/.og-sigs.json` (keys `<toolId>`): manifests keyed by
 *   tool id. Entries for hidden tools are removed; one that does not parse as a
 *   JSON object answers 404.
 *
 * Paths are classified case-insensitively, so a case-insensitive filesystem cannot
 * be used to reach a file under another spelling.
 */
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { filterToolIndex } from '../policy/overlay.ts';
import { callerCanSeeTool, type CatalogCaller } from './signing.ts';

export const CATALOG_SLIM_INDEX_REL = 'tools/index.slim.json';

/** The directories whose files are named after a tool id. */
const TOOL_KEYED_DIRS = ['previews', 'og'] as const;

/** True when `rel` (a path under the catalog root) is one this module decides. */
export function isToolKeyedCatalogPath(rel: string): boolean {
  const lower = rel.toLowerCase();
  if (lower.startsWith('tools/')) return true;
  return TOOL_KEYED_DIRS.some((dir) => lower.startsWith(`${dir}/`));
}

export type ToolSidecarResult =
  /** Not decided here: serve the pack file through the ordinary path. */
  | { kind: 'pass' }
  /** Answer 404, the same absence an unknown file shows. */
  | { kind: 'not-found' }
  /** Serve these filtered JSON bytes. */
  | { kind: 'json'; bytes: Buffer };

async function readJson(path: string): Promise<unknown> {
  try {
    return JSON.parse((await readFile(path)).toString('utf8')) as unknown;
  } catch {
    return undefined;
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Decide a tool-keyed catalog path for one caller. `tools/index.json`, and
 * `tools/index.sig.json` when a signing key is configured, are answered before
 * this is called; reaching here with either spelling means 404.
 */
export async function servedToolSidecar(packDir: string, rel: string, caller: CatalogCaller): Promise<ToolSidecarResult> {
  const lower = rel.toLowerCase();
  const visible = (toolId: string): boolean => callerCanSeeTool(caller, toolId);

  if (lower.startsWith('tools/')) {
    if (rel !== CATALOG_SLIM_INDEX_REL) return { kind: 'not-found' };
    const index = await readJson(join(packDir, 'catalog', 'tools', 'index.slim.json'));
    if (!isObject(index) || !Array.isArray(index.tools)) return { kind: 'not-found' };
    const tools = (index.tools as unknown[]).filter((t): t is { id: string } => isObject(t) && typeof t.id === 'string');
    index.tools = filterToolIndex(tools, caller.overlays, caller.groups);
    return { kind: 'json', bytes: Buffer.from(JSON.stringify(index), 'utf8') };
  }

  const dir = TOOL_KEYED_DIRS.find((d) => lower.startsWith(`${d}/`));
  if (!dir) return { kind: 'pass' };
  const rest = rel.slice(dir.length + 1);
  const name = rest.split('/', 1)[0] ?? '';
  if (!name) return { kind: 'not-found' };
  const isManifest = !rest.includes('/') && (name.startsWith('.') || (dir === 'previews' && name.toLowerCase() === 'bundle.json'));
  if (isManifest) {
    const manifest = await readJson(join(packDir, 'catalog', dir, name));
    if (!isObject(manifest)) return { kind: 'not-found' };
    const kept: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(manifest)) {
      if (visible(key.split(':', 1)[0]!.toLowerCase())) kept[key] = value;
    }
    return { kind: 'json', bytes: Buffer.from(JSON.stringify(kept), 'utf8') };
  }
  // `<toolId>.svg`, `<toolId>.look2.webp`, or a directory named after a tool.
  // Tool ids hold no dots, so the id is everything before the first one.
  const toolId = name.split('.', 1)[0]!.toLowerCase();
  return visible(toolId) ? { kind: 'pass' } : { kind: 'not-found' };
}
