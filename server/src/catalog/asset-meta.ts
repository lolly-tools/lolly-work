/**
 * Org-defined asset metadata (plans/31 section 4) - the taxonomy an org names
 * for itself, on top of the flat tag list the closed OSS asset schema carries.
 *
 * Two halves, deliberately split, and the split is the whole design:
 *
 *  - DEFINITIONS are policy. They live in the policy-as-code document beside
 *    grants, overlays, chains and flags, so `lw export` / `lw apply` and the
 *    boot seeder cover them with no new plumbing, and an instance's taxonomy is
 *    reviewable in git like the rest of its governance.
 *  - VALUES are a local overlay keyed by asset id. Keying by id rather than by
 *    a column on a record is what makes them work uniformly for `inst/*` (bytes
 *    we own), `ext/*` (federated, where the upstream DAM owns the record) and
 *    pack ids (a read-only file on disk): none of those three can grow a
 *    column, and all three have an id.
 *
 * Nothing here touches the OSS asset schema. A served entry gains one
 * additive `fields` bag, which a shell that knows nothing about it ignores and
 * a shell that renders unknown keys shows as ordinary rows.
 *
 * Pure functions only - no store, no fs - so the routes, the feed, the search
 * haystack and the submit review queue all fold the same rules.
 */
import type { AssetIndex, AssetIndexEntry } from './lifecycle.ts';

// -- definitions (policy) ----------------------------------------------------

export const FIELD_KINDS = ['text', 'select', 'date', 'url'] as const;
export type FieldKind = (typeof FIELD_KINDS)[number];

/** One org-defined field. `options` belongs to `select` and to nothing else. */
export interface CatalogFieldDef {
  id: string;
  label: string;
  kind: FieldKind;
  /** A save that leaves this empty is refused (see `applyFieldPatch`). */
  required?: boolean;
  /** The allowed values of a `select`; at least one, deduped, order kept. */
  options?: string[];
}

const FIELD_ID_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/**
 * Validate an untrusted definition into a typed one, or null when it is
 * malformed. The same normalizer serves the policy document, the definitions
 * route and the boot seed, so a field that the document accepts is exactly a
 * field the route accepts (the `normalizeChain` / `normalizeOverlay` pattern).
 */
export function normalizeCatalogField(id: string, raw: unknown): CatalogFieldDef | null {
  if (!isObj(raw) || !FIELD_ID_RE.test(id)) return null;
  const label = typeof raw.label === 'string' ? raw.label.trim().slice(0, 80) : '';
  if (!label) return null;
  const kind = raw.kind;
  if (typeof kind !== 'string' || !(FIELD_KINDS as readonly string[]).includes(kind)) return null;
  const rawOptions = raw.options;
  if (rawOptions !== undefined && !Array.isArray(rawOptions)) return null;
  const options = Array.isArray(rawOptions)
    ? [...new Set(rawOptions.map((o) => String(o).trim()).filter(Boolean))].slice(0, 100)
    : [];
  // A select with nothing to select from is a broken control, and options on a
  // free-text field are a definition that means something it cannot do. Both
  // are refused rather than silently normalized away, because either is a
  // governance document saying one thing and the editor doing another.
  if (kind === 'select' && !options.length) return null;
  if (kind !== 'select' && options.length) return null;
  return {
    id,
    label,
    kind: kind as FieldKind,
    ...(raw.required === true ? { required: true } : {}),
    ...(kind === 'select' ? { options } : {}),
  };
}

/** Definition order for every surface: by id, the order the policy document
 *  canonicalizes to, so the console, the CLI and the feed agree. */
export function sortFields(defs: CatalogFieldDef[]): CatalogFieldDef[] {
  return [...defs].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}

// -- values (the local overlay) ----------------------------------------------

/**
 * The local overlay for one asset id. It carries VALUES only: an instance
 * asset's own name, description and tags stay on its record, where the submit
 * pipeline already writes them, so a value has exactly one home and the two
 * editors (this one and the submit review queue) cannot drift.
 */
export interface AssetMetaRecord {
  assetId: string;
  /** Field id to value. A field with no value is absent, never an empty string. */
  fields: Record<string, string>;
  /**
   * ID-level supersession (plans/31 section 6): the catalog asset id that
   * REPLACES this one. It rides the overlay rather than the instance-asset
   * record for the reason the whole overlay exists - a pack asset and a
   * federated asset can be superseded too, and neither owns a record this
   * instance could add a column to.
   *
   * A version says "these bytes changed"; a supersession says "stop using this
   * asset, use that one". The key is already in the OSS asset schema, so the
   * feed carries it additively and a shell that does not read it yet ignores it.
   */
  replacedBy?: string;
  /**
   * On-device OCR text for this asset (plans/31 section 7), produced by the
   * submitting or curating CLIENT - the server never runs a model. It rides the
   * overlay beside `replacedBy` for the same reason the whole overlay exists: a
   * pack asset and a federated asset carry words on them too, and neither owns a
   * record this instance could add a column to.
   *
   * It is folded into the server-side search haystack (`extractedHaystack`) so
   * "find the slide by the words on it" works, but it is deliberately NOT folded
   * onto the served feed entry (`composeAssetMeta` leaves it out): it is a search
   * index, not something every catalog card should carry the weight of, and a
   * page of OCR noise on each entry is bytes no shell asked for.
   */
  extractedText?: string;
  /** 'user:<id>' of the last editor. */
  updatedBy: string;
  updatedAt: string;
}

/** Cap on stored OCR text - this is a search index, not a document store
 *  (plans/31 section 7). Long enough for the words on a dense slide, short
 *  enough that the overlay row stays a row. */
export const MAX_EXTRACTED_TEXT = 8192;

/**
 * Normalize submitted OCR text to what gets stored, or null to clear it.
 * Whitespace is collapsed - OCR is line-noisy and the haystack matches
 * substrings, not layout - and the result is capped. Anything that is not a
 * string, or collapses to empty, clears the value rather than storing a blank.
 */
export function normalizeExtractedText(raw: unknown): string | null {
  if (typeof raw !== 'string') return null;
  const text = raw.replace(/\s+/g, ' ').trim().slice(0, MAX_EXTRACTED_TEXT);
  return text || null;
}

/** One asset's stored OCR text as a search term (plans/31 section 7), or empty
 *  when the overlay carries none - so the search route folds it in beside the
 *  field values with no special-casing. Keyed on the overlay RECORD, not the
 *  served entry, because the text is kept off the feed on purpose. */
export function extractedHaystack(meta: AssetMetaRecord | null | undefined): string[] {
  return meta?.extractedText ? [meta.extractedText] : [];
}

/** How a value must read for its kind. Returns the refusal, or null when it passes. */
export function validateFieldValue(def: CatalogFieldDef, value: string): string | null {
  if (def.kind === 'select') {
    return (def.options ?? []).includes(value) ? null : `${def.id}: "${value}" is not one of ${(def.options ?? []).join(', ')}`;
  }
  if (def.kind === 'date') {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return `${def.id}: a date reads YYYY-MM-DD`;
    const parsed = new Date(`${value}T00:00:00Z`);
    return Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value
      ? `${def.id}: ${value} is not a real date`
      : null;
  }
  if (def.kind === 'url') {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      return `${def.id}: not a URL`;
    }
    return url.protocol === 'http:' || url.protocol === 'https:' ? null : `${def.id}: a URL must be http or https`;
  }
  return value.length > 500 ? `${def.id}: at most 500 characters` : null;
}

/**
 * Merge a patch into an asset's values bag.
 *
 * The patch is sparse: a key that is absent keeps its stored value, and a key
 * set to null or the empty string clears it. Unknown ids are refused rather
 * than kept, because a bag that accepted anything would be a second, ungoverned
 * tag list with none of the definitions' rules.
 *
 * `required` is enforced on the RESULT, not on the patch: whatever a save
 * leaves behind has to satisfy every required definition. It gates the editor,
 * never the feed - an asset that predates a definition keeps serving exactly as
 * it did, and the first edit is where it has to be filled in.
 */
export function applyFieldPatch(
  defs: CatalogFieldDef[],
  current: Record<string, string>,
  patch: Record<string, unknown>,
): { values: Record<string, string> } | { errors: string[] } {
  const byId = new Map(defs.map((d) => [d.id, d]));
  const errors: string[] = [];
  const next: Record<string, string> = { ...current };
  for (const [id, raw] of Object.entries(patch)) {
    const def = byId.get(id);
    if (!def) {
      errors.push(`unknown field "${id}"`);
      continue;
    }
    if (raw === null || raw === undefined || raw === '') {
      delete next[id];
      continue;
    }
    if (typeof raw !== 'string') {
      errors.push(`${id}: a value must be a string`);
      continue;
    }
    const value = raw.trim();
    if (!value) {
      delete next[id];
      continue;
    }
    const bad = validateFieldValue(def, value);
    if (bad) errors.push(bad);
    else next[id] = value;
  }
  for (const def of defs) {
    if (def.required && !next[def.id]) errors.push(`${def.id} (${def.label}) is required`);
  }
  // A value whose definition has been retired is CARRIED THROUGH untouched: it
  // is already hidden from every served surface (`servedFields`), and dropping
  // it here would mean an unrelated edit quietly destroyed the data filed under
  // a field the org may yet bring back. It can never be introduced this way -
  // an unknown id in the patch is refused above - only survive.
  return errors.length ? { errors } : { values: next };
}

/** The values a caller should be shown for one asset: stored values filtered to
 *  the definitions that still exist, in definition order. Retiring a definition
 *  therefore hides its values without destroying them - re-adding the
 *  definition brings them back, which a delete could never do. */
export function servedFields(defs: CatalogFieldDef[], meta: AssetMetaRecord | null | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!meta) return out;
  for (const def of sortFields(defs)) {
    const value = meta.fields[def.id];
    if (value) out[def.id] = value;
  }
  return out;
}

/**
 * Fold the overlay onto a served feed as an additive `fields` bag. Additive is
 * the whole point: the OSS asset schema is closed, the shell's asset record
 * already carries unknown keys, and an entry with no values is returned
 * untouched, so no shell version is ever required in lockstep.
 */
export function composeAssetMeta(
  index: AssetIndex, metas: AssetMetaRecord[], defs: CatalogFieldDef[],
): AssetIndex {
  if (!Array.isArray(index.assets) || !metas.length) return index;
  const byId = new Map(metas.map((m) => [m.assetId, m]));
  let touched = false;
  const assets: AssetIndexEntry[] = index.assets.map((entry) => {
    const meta = byId.get(entry.id);
    const fields = defs.length ? servedFields(defs, meta) : {};
    // Supersession is folded here rather than in its own pass because it lives
    // on the same overlay row and answers the same question - what does THIS
    // instance say about this id - and because an entry that carries neither
    // must come back untouched for the additive promise to hold.
    const replacedBy = meta?.replacedBy;
    if (!Object.keys(fields).length && !replacedBy) return entry;
    touched = true;
    return {
      ...entry,
      ...(Object.keys(fields).length ? { fields } : {}),
      ...(replacedBy ? { replacedBy } : {}),
    };
  });
  return touched ? { ...index, assets } : index;
}

/** The org-defined values of one entry as searchable text, for the server-side
 *  haystack (`GET /api/v1/catalog/search`), which otherwise matches id, name,
 *  description and tags only. A value an org can file an asset under is a value
 *  they will look it up by. */
export function fieldHaystack(entry: { fields?: unknown }): string[] {
  return isObj(entry.fields) ? Object.values(entry.fields).filter((v): v is string => typeof v === 'string') : [];
}

// -- descriptive metadata (shared with the submit review queue) --------------

export const DESCRIPTIVE_KEYS = ['name', 'type', 'description', 'tags'] as const;
export type DescriptiveKey = (typeof DESCRIPTIVE_KEYS)[number];

export interface DescriptiveEntry {
  name?: unknown;
  type?: unknown;
  description?: unknown;
  tags?: unknown;
  [key: string]: unknown;
}

export interface DescriptivePatch {
  /** Fields to set, already trimmed and capped. */
  set: { name?: string; type?: string; description?: string; tags?: string[] };
  /** Fields to REMOVE from the entry - an emptied description, never stored blank. */
  clear: DescriptiveKey[];
  /** Audit payload halves, one key per field the caller actually moved. */
  before: Record<string, unknown>;
  after: Record<string, unknown>;
}

/**
 * Parse the descriptive half of an edit - name, type, tags, description - into
 * a patch plus its own audit before/after.
 *
 * It exists as one function because TWO surfaces edit exactly these four
 * fields: the submit review queue's pre-publication correction (plans/31
 * section 3) and this section's asset editor. They differ in WHEN they apply
 * (a pending submission vs. a live asset) and in which keys they allow, never
 * in what a name is allowed to be, so the rules live here rather than being
 * typed out twice and drifting on the first change to either.
 */
export function parseDescriptivePatch(
  body: Record<string, unknown>, entry: DescriptiveEntry, allowed: readonly DescriptiveKey[],
): DescriptivePatch | { error: string } {
  const patch: DescriptivePatch = { set: {}, clear: [], before: {}, after: {} };
  const may = (key: DescriptiveKey): boolean => allowed.includes(key);
  const str = (v: unknown): string => (typeof v === 'string' ? v : '');

  if (may('name') && body.name !== undefined) {
    const name = str(body.name).trim();
    if (!name) return { error: 'name cannot be emptied' };
    patch.before.name = entry.name;
    patch.set.name = name.slice(0, 200);
    patch.after.name = patch.set.name;
  }
  if (may('type') && body.type !== undefined) {
    const type = str(body.type).trim();
    if (!/^[a-z0-9-]{1,32}$/i.test(type)) return { error: 'type must be a short slug' };
    patch.before.type = entry.type;
    patch.set.type = type;
    patch.after.type = type;
  }
  if (may('description') && body.description !== undefined) {
    if (typeof body.description !== 'string') return { error: 'description must be a string' };
    const description = body.description.trim().slice(0, 500);
    patch.before.description = entry.description ?? '';
    if (description) patch.set.description = description;
    else patch.clear.push('description');
    patch.after.description = description;
  }
  if (may('tags') && body.tags !== undefined) {
    const raw = Array.isArray(body.tags) ? body.tags : typeof body.tags === 'string' ? body.tags.split(',') : null;
    if (!raw) return { error: 'tags must be a list or a comma-separated string' };
    patch.before.tags = Array.isArray(entry.tags) ? entry.tags : [];
    patch.set.tags = [...new Set(raw.map((t) => String(t).trim()).filter(Boolean))].slice(0, 32);
    patch.after.tags = patch.set.tags;
  }
  return patch;
}

/** Apply a parsed descriptive patch to an entry, returning a new entry. */
export function applyDescriptivePatch<T extends DescriptiveEntry>(entry: T, patch: DescriptivePatch): T {
  const next = { ...entry, ...patch.set } as T;
  for (const key of patch.clear) delete next[key];
  return next;
}

/** Whether a parsed patch actually moves anything. */
export function descriptiveTouched(patch: DescriptivePatch): boolean {
  return Object.keys(patch.after).length > 0;
}
