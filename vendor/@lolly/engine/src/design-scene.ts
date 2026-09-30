// SPDX-License-Identifier: MPL-2.0
/**
 * The Design scene grammar - what a `kind:'3d'` box's `scene` field holds, and the
 * only place that grammar lives (plan 265 milestone 3, decision Q17).
 *
 * A scene box carries ONE string: the 3D Studio tool's own readable URL query, with
 * every value that equals the studio's manifest default left out and device-local
 * `user/…` upload ids kept. It is the same string a 3D Studio share link carries
 * after the '?', so three things follow for free:
 *
 *   - the editor door is a plain tool-link round trip (open the studio on the query,
 *     take the edited query back);
 *   - a new studio input needs no Design change: the manifest is what decides which
 *     keys exist and what a default is;
 *   - the field stays small. A typical six-edit scene is about a hundred bytes,
 *     against 2.5 KB for the whole `{version:1, values}` recipe as JSON.
 *
 * "Differs from the default" is not decided here. Both sides are run through the
 * engine's own `buildInputModel` + `serializeUrlState`, and a key is kept only when
 * the two strings differ, so this module can never disagree with url-mode about what
 * a default looks like. A value the author CLEARED (empty where the manifest has
 * something) is written as a bare `key=`, because an omitted key means "the default"
 * and would silently put the default back.
 *
 * Pure and DOM-free: no fetch, no storage, no clock. The manifest comes from the
 * caller, which is the shell's ordinary tool loader.
 */

import { buildInputModel } from './inputs.ts';
import type { InputManifest, InputValue } from './inputs.ts';
import { parseUrlState, serializeUrlState } from './url-mode.ts';

/** A 3D Studio value bag, keyed by input id. The shape `buildStudioScene` reads. */
export type DesignSceneValues = Record<string, InputValue>;

/** The readable query for one value bag, user ids kept. Also the all-defaults
 *  baseline when `values` is omitted. */
function sceneQuery(manifest: InputManifest, values?: DesignSceneValues): URLSearchParams {
  const model = buildInputModel(manifest, values ? { initial: values } : {});
  return new URLSearchParams(serializeUrlState(model, { keepUserIds: true }));
}

/**
 * Encode 3D Studio values as a scene field: the readable query of only what differs
 * from the manifest's defaults, user ids kept.
 *
 * Key order is the manifest's input order, then any cleared keys, so the same values
 * always produce the same bytes (a document diff stays readable and a `?z=` pack of
 * the same document is byte-identical).
 */
export function designSceneEncode(values: DesignSceneValues, manifest: InputManifest): string {
  const full = sceneQuery(manifest, values);
  const base = sceneQuery(manifest);
  const out = new URLSearchParams();
  for (const [key, value] of full) {
    if (base.get(key) !== value) out.set(key, value);
  }
  // A key the baseline has and the values do not is a CLEARED field, not an
  // untouched one: serializeUrlState drops an empty value, so without this the
  // round trip would hand the manifest default back (a blanked `words` would
  // read "Hello" again).
  for (const [key] of base) {
    if (!full.has(key)) out.set(key, '');
  }
  return out.toString();
}

/**
 * Expand a scene field back to the full 3D Studio value bag - every input present,
 * defaults filled in - which is what `buildStudioScene({ version: 1, values })` takes.
 *
 * Asset values come back as unresolved refs (`{ source, id, _unresolved }`), exactly
 * as a tool load from a URL produces them; the host resolves them before rendering.
 */
export function designSceneDecode(query: string, manifest: InputManifest): DesignSceneValues {
  const state = parseUrlState(query ?? '', manifest);
  const out: DesignSceneValues = {};
  for (const item of buildInputModel(manifest, { initial: state.values })) out[item.id] = item.value;
  return out;
}

/** The id an asset value carries, whether it arrived as a ref object or a bare string. */
function idOf(value: InputValue | undefined): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const id = (value as { id?: unknown }).id;
    if (typeof id === 'string') return id;
  }
  return '';
}

/**
 * The catalog and user asset ids a scene references, first-seen order, no duplicates.
 *
 * Driven by the manifest rather than a list of names: every `asset` input and every
 * `asset` sub-field of a `blocks` input counts, which today is the studio's artwork,
 * model, backdrop image and environment image plus the `asset` field of a `subjects`
 * or `objects` row, and tomorrow is whatever the studio adds without an edit here.
 *
 * Ids are returned as written (a version pin rides along); callers that key storage
 * by base id run them through `assetDependency` the way they do a ref.
 */
export function designSceneAssetIds(query: string, manifest: InputManifest): string[] {
  const values = designSceneDecode(query, manifest);
  const out: string[] = [];
  const seen = new Set<string>();
  const add = (raw: string): void => {
    if (!raw || seen.has(raw)) return;
    seen.add(raw);
    out.push(raw);
  };
  for (const input of manifest.inputs ?? []) {
    if (input.type === 'asset') {
      add(idOf(values[input.id]));
      continue;
    }
    if (input.type !== 'blocks') continue;
    const assetFields = (input.fields ?? []).filter(f => f.type === 'asset');
    if (!assetFields.length) continue;
    const rows = values[input.id];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) continue;
      const record = row as Record<string, InputValue | undefined>;
      for (const field of assetFields) add(idOf(record[field.id]));
    }
  }
  return out;
}

/**
 * The moment a scene box is at, as a studio renderer takes it (plan 265 milestone 3,
 * decision Q21).
 *
 * The timeline hands every box its SOURCE time in milliseconds - clip-in plus the local
 * position times the clip's speed, the same number a `<video>` is seeked to. A studio
 * renderer takes a normalised position inside the recipe's OWN clip length instead, so a
 * scene plays at the speed it was authored at: a box trimmed to two seconds shows the
 * first two seconds of the scene rather than the whole of it twice as fast. `seconds` is
 * the recipe's `motion.seconds`, which the Design host stamps on the box's marker.
 *
 * Nothing is clamped or wrapped: looping is the recipe's own business (a looping camera
 * path wraps, an open one holds its last key). A clip length of zero, or a value that is
 * not a number, gives 0, which is the scene at rest.
 */
export function designSceneTime(sourceMs: number, seconds: number): number {
  if (!Number.isFinite(sourceMs) || !Number.isFinite(seconds) || seconds <= 0) return 0;
  return sourceMs / 1000 / seconds;
}
