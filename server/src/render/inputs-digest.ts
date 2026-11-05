// SPDX-License-Identifier: MPL-2.0
/**
 * The digest of a tool's input values as the render path uses them. It answers
 * "would a server render with these inputs read the same values?", so a request
 * for approval and a later render can be matched without either side keeping the
 * values. The steps are the pipeline's own (render/pipeline.ts): values parsed
 * from URL mode, a supplied locked or hidden input set aside (the pipeline refuses
 * those, so no matching render can carry one), the overlay's locked values placed
 * over the rest, then the engine's input model filling defaults and profile
 * bindings. Provider references are hashed as written, before any hosted fetch.
 *
 * Values never leave this function. Callers store the digest alone.
 */
import { checkParams, lockedValues, type ToolOverlay } from '../policy/overlay.ts';
import type { Profile } from './contract.ts';
import { evidenceHash } from './evidence.ts';

/** What the hash covers. A change to these steps takes a new version, and an old
 *  digest then simply matches nothing. */
export const INPUTS_DIGEST_VERSION = 'work/inputs-v1';

interface InputModelEngine {
  buildInputModel(manifest: never, opts: { profile: Profile; initial: Record<string, unknown> }): Array<{ id: string; value: unknown }>;
}

export function renderInputsDigest(
  engine: InputModelEngine, manifest: object, values: Record<string, unknown>,
  overlay: ToolOverlay | undefined, groups: string[], profile: Profile,
): string {
  const setAside = new Set(checkParams(values, overlay, groups).filter(v => v.code !== 'INPUT_NOT_ALLOWED').map(v => v.param));
  const kept = Object.fromEntries(Object.entries(values).filter(([id]) => !setAside.has(id)));
  const declared = new Set((((manifest as { inputs?: unknown }).inputs ?? []) as Array<{ id: string }>).map(input => input.id));
  const model = engine.buildInputModel(manifest as never, { profile: { ...profile }, initial: { ...kept, ...lockedValues(overlay, groups) } });
  return evidenceHash({ version: INPUTS_DIGEST_VERSION, values: Object.fromEntries(model.filter(input => declared.has(input.id)).map(input => [input.id, input.value])) });
}
