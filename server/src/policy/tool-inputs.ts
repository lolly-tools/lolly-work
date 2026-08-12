/**
 * Declared-input reader — the org-config assembler needs each policied tool's
 * input ids (to annotate locked ones and name hidden ones for the shell's
 * sidebar). Reads `<pack>/tools/<id>/tool.json` directly (ids only — no
 * validation, no engine load), mtime-cached.
 *
 * Note on "hidden means the caller never learns it exists": the pack feed
 * serves tool.json whole today, so input ids are not secret to a connected
 * client — naming hidden ids here loses nothing while letting the shell
 * suppress the controls. True per-caller manifest filtering is a marked
 * follow-up (plans/03 §3); render-time 422 enforcement is already hard.
 */
import { readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';

/** One declared input, as far as anything outside the engine needs it: its id and
 *  its declared `InputType`. The TYPE is what tells a collab room which LANE an
 *  input lives in — a `blocks` input is a collection, everything else is a scalar
 *  param — so it must travel with the id. Absent when the manifest omits it. */
export interface DeclaredInput {
  id: string;
  type?: string;
}

const cache = new Map<string, { mtimeMs: number; inputs: DeclaredInput[] | null }>();

/**
 * Declared inputs for a tool in this pack, or null when the manifest cannot be
 * read at all. The two nulls are NOT the same thing and callers must not conflate
 * them: `null` means "this tool is not in this instance's pack" (no whitelist is
 * available), while `[]` means "the manifest parsed and declares no inputs" (the
 * whitelist is empty, and nothing is addressable).
 */
export async function readToolInputs(packDir: string, toolId: string): Promise<DeclaredInput[] | null> {
  if (!/^[a-z0-9-]+$/i.test(toolId)) return null; // tool ids are flat directory names
  const path = join(packDir, 'tools', toolId, 'tool.json');
  let mtimeMs: number;
  try {
    mtimeMs = (await stat(path)).mtimeMs;
  } catch {
    return null;
  }
  const hit = cache.get(path);
  if (hit && hit.mtimeMs === mtimeMs) return hit.inputs;
  let inputs: DeclaredInput[] | null = null;
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { inputs?: Array<{ id?: unknown; type?: unknown }> };
    inputs = Array.isArray(manifest.inputs)
      ? manifest.inputs
          .filter((i): i is { id: string; type?: unknown } => typeof i?.id === 'string')
          .map((i) => (typeof i.type === 'string' ? { id: i.id, type: i.type } : { id: i.id }))
      : [];
  } catch {
    inputs = null;
  }
  cache.set(path, { mtimeMs, inputs });
  return inputs;
}
