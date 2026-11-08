// SPDX-License-Identifier: MPL-2.0
/**
 * What a manager's edit may change in a design system's token document, and how
 * those changes land on a document.
 *
 * The first slice is colours, colour roles and their bindings, and the brand page
 * address. The document arrives whole, so the only way to know what it changes is
 * to compare it with the mounted one: anything else that differs is refused by name,
 * and nothing is saved.
 *
 * A document from a person is untrusted. These values become CSS custom properties
 * on every member's screen and reach exports, so a colour must read as a colour:
 * a closed list of forms, with no `url()` and no way out of a declaration.
 *
 * The result is a list of changes as well as a document, because a new image can
 * replace the base an edit was made on. The same list applies to the new base whole
 * or not at all, so an edit is never partly applied.
 *
 * This does not read colour roles through the engine. The pinned engine has no such
 * reader yet, so roles are checked by their shape here and the caller asks the engine
 * only whether the whole record still reads. Pure: no I/O, no clock.
 */
import { canonicalJson } from '../lib/crypto.ts';

type Rec = Record<string, unknown>;
const isRec = (value: unknown): value is Rec => !!value && typeof value === 'object' && !Array.isArray(value);
const same = (a: unknown, b: unknown): boolean => canonicalJson(a ?? null) === canonicalJson(b ?? null);

/** The namespace token documents keep their own settings in. */
export const TOKEN_EXT = 'com.suse.lolly';
/** The most a sent document may hold, and the most a device writes into a head. */
export const BRAND_EDIT_MAX_BYTES = 8 * 1024 * 1024;
export const MAX_DEPTH = 48;
export const MAX_NODES = 400_000;
export const MAX_CHANGES = 5000;
export const MAX_TEXT = 2000;
export const MAX_ROLES = 32;
export const MAX_ROLE_LABEL = 80;
export const MAX_ROLE_DESCRIPTION = 600;
const COLOUR_ROLE_GROUP = 'colourway';

export type BrandEditChange =
  | { kind: 'token'; set: string | null; path: string[]; before: unknown; after: unknown }
  | { kind: 'set'; name: string; before: unknown; after: unknown }
  | { kind: 'theme'; id: string; before: unknown; after: unknown }
  | { kind: 'role'; id: string; before: unknown; after: unknown }
  | { kind: 'binding'; id: string; before: unknown; after: unknown }
  | { kind: 'system'; after: { schemaVersion: 1; id: string; label: string } }
  | { kind: 'brand-page'; before: string | null; after: string | null }
  | { kind: 'order'; target: 'themes' | 'roles'; after: string[] }
  /** A light or dark theme gains the note that says it is one, which gaining a first colourway writes. */
  | { kind: 'mode-note'; id: string };

export interface BrandDocumentComparison {
  changes: BrandEditChange[];
  /** What changed outside the slice, by name. Any entry refuses the document. */
  outOfScope: string[];
  /** Changed values that cannot be accepted, in a sentence each. Any entry refuses the document. */
  invalid: string[];
}

export class BrandEditRefusal extends Error {
  readonly status: number;
  readonly code: string;
  constructor(code: string, message: string, status = 422) { super(message); this.code = code; this.status = status; }
}

// ── The address ───────────────────────────────────────────────────────────────

/**
 * A brand page address in its recorded form, or null. The same rule as Lolly's
 * engine (`brandPageAddress` in engine/src/brand-page-address.ts), restated because
 * this server pins an engine older than that function; tests pin the two by their
 * cases. A plain https address on a named host, with no query, fragment or credentials.
 */
export function brandPageAddress(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const raw = value.trim();
  if (!raw || raw.length > 512) return null;
  if (/[\p{Cc}\p{Cf}\s\\]/u.test(raw) || !/^https:\/\//i.test(raw) || /[?#]/.test(raw)) return null;
  let url: URL;
  try { url = new URL(raw); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) return null;
  const host = url.hostname;
  if (!host.includes('.') || host.endsWith('.') || host.endsWith('.localhost')) return null;
  if (host.startsWith('[') || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return null;
  const address = `${url.origin}${url.pathname}`;
  return address.length <= 512 ? address : null;
}

// ── Reading a document safely ─────────────────────────────────────────────────

const BANNED_KEYS: ReadonlySet<string> = new Set(['__proto__', 'constructor', 'prototype']);

/** Bounds a parsed document before anything walks it. Throws on a hostile shape. */
export function checkDocumentShape(value: unknown): Rec {
  if (!isRec(value)) throw new BrandEditRefusal('BRAND_EDIT_INVALID', 'A design system document is one JSON object.');
  let nodes = 0;
  const visit = (node: unknown, depth: number): void => {
    if (++nodes > MAX_NODES) throw new BrandEditRefusal('BRAND_EDIT_INVALID', 'This document is too large to read.');
    if (depth > MAX_DEPTH) throw new BrandEditRefusal('BRAND_EDIT_INVALID', 'This document nests too deeply to read.');
    if (Array.isArray(node)) { for (const item of node) visit(item, depth + 1); return; }
    if (!isRec(node)) return;
    for (const key of Object.keys(node)) {
      if (BANNED_KEYS.has(key)) throw new BrandEditRefusal('BRAND_EDIT_INVALID', `This document uses a reserved name: ${key}.`);
      if (key.length > 256 || /[\p{Cc}\p{Cf}]/u.test(key)) throw new BrandEditRefusal('BRAND_EDIT_INVALID', 'This document has a name with control characters in it, or one that is too long.');
      visit(node[key], depth + 1);
    }
  };
  visit(value, 0);
  return value;
}

/** The token sets, or null for a document with no sets. The engine's own rule. */
function setNames(doc: Rec): string[] | null {
  const keys = Object.keys(doc).filter(key => !key.startsWith('$'));
  if (!keys.length) return null;
  if (Array.isArray(doc.$themes) && doc.$themes.length) return keys;
  const order = isRec(doc.$metadata) ? doc.$metadata.tokenSetOrder : null;
  return Array.isArray(order) && order.length && order.every(name => typeof name === 'string' && isRec(doc[name])) ? keys : null;
}

const SEP = '\u0000';
interface Leaf { path: string[]; value: unknown }

/** Every value under a colour group: tokens whole, plus any metadata a group carries. */
function leavesOf(group: unknown, path: string[], out: Map<string, Leaf>): void {
  if (!isRec(group)) return;
  for (const [key, child] of Object.entries(group)) {
    const here = [...path, key];
    if (!key.startsWith('$') && isRec(child) && !('$value' in child)) leavesOf(child, here, out);
    else out.set(here.join(SEP), { path: here, value: child });
  }
}

/** Every token path in the document, in any set: what an alias may name. */
function tokenPaths(doc: Rec): Set<string> {
  const paths = new Set<string>();
  const walk = (node: unknown, prefix: string): void => {
    if (!isRec(node)) return;
    for (const [key, child] of Object.entries(node)) {
      if (key.startsWith('$') || !isRec(child)) continue;
      const path = prefix ? `${prefix}.${key}` : key;
      if ('$value' in child) paths.add(path);
      else walk(child, path);
    }
  };
  const sets = setNames(doc);
  if (!sets) walk(doc, '');
  else for (const name of sets) walk(doc[name], '');
  return paths;
}

const vendorOf = (doc: Rec): Rec | null => {
  const ext = doc.$extensions;
  const vendor = isRec(ext) ? ext[TOKEN_EXT] : null;
  return isRec(vendor) ? vendor : null;
};

const isColourwaySet = (name: string): boolean => /^colourway\/[a-z0-9][a-z0-9-]{0,63}$/.test(name);

/** A theme that belongs to a colourway group: its group says so, or it is named for one. */
function colourwayGroups(doc: Rec): Set<string> {
  const groups = new Set<string>([COLOUR_ROLE_GROUP]);
  for (const theme of Array.isArray(doc.$themes) ? doc.$themes : []) {
    if (!isRec(theme) || typeof theme.group !== 'string') continue;
    const vendor = isRec(theme.$extensions) ? theme.$extensions[TOKEN_EXT] : null;
    const axis = isRec(vendor) ? vendor.axis : null;
    if (isRec(axis) && axis.kind === 'colourway') groups.add(theme.group);
  }
  return groups;
}

const themeId = (theme: unknown): string => isRec(theme) ? String(theme.id ?? theme.name ?? '') : '';

// ── What a colour may be ──────────────────────────────────────────────────────

const COLOUR_FUNCTIONS: ReadonlySet<string> = new Set([
  'rgb', 'rgba', 'hsl', 'hsla', 'hwb', 'lab', 'lch', 'oklab', 'oklch', 'color', 'color-mix',
  'linear-gradient', 'radial-gradient', 'conic-gradient', 'repeating-linear-gradient', 'repeating-radial-gradient', 'repeating-conic-gradient',
]);
const ALIAS = /^\{([A-Za-z0-9_][A-Za-z0-9_. -]{0,255})\}$/;

/** A hex, a colour word, an alias, or one of the colour functions with nothing else in it. */
function isColourText(text: string): boolean {
  const value = text.trim();
  if (!value || value.length > 1024) return false;
  if (/^#[0-9a-fA-F]{3,8}$/.test(value) || /^[a-zA-Z]{1,32}$/.test(value) || ALIAS.test(value)) return true;
  if (!/^[0-9a-zA-Z .,%+\-/#()]+$/.test(value)) return false;
  let depth = 0;
  for (const ch of value) { if (ch === '(') depth++; else if (ch === ')' && --depth < 0) return false; }
  if (depth !== 0 || !/^[a-z-]+\(/.test(value)) return false;
  return [...value.matchAll(/([a-zA-Z-]*)\(/g)].every(match => COLOUR_FUNCTIONS.has(match[1]!.toLowerCase()));
}

/** A plain label inside a structured value, such as a colour space or a gradient kind. */
const isPlainWord = (text: string): boolean => /^[A-Za-z0-9 ._%+-]{0,64}$/.test(text);

/** A structured colour value: its strings are colours or plain words, and its numbers are finite. */
function colourValueProblem(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') return !isColourText(value) && !isPlainWord(value);
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'boolean' || value === null) return false;
  if (Array.isArray(value)) return value.length > 256 || value.some(item => colourValueProblem(item, depth + 1));
  if (isRec(value)) return Object.entries(value).some(([key, item]) => !isPlainWord(key) || colourValueProblem(item, depth + 1));
  return true;
}

/** Inert settings on a token (a spot name, a CMYK value): nothing that can leave a declaration. */
function extensionProblem(value: unknown, depth = 0): boolean {
  if (depth > 12) return true;
  if (typeof value === 'string') return value.length > 512 || /[\p{Cc}<>;\\]/u.test(value) || /url\(|expression\(/i.test(value);
  if (typeof value === 'number') return !Number.isFinite(value);
  if (typeof value === 'boolean' || value === null) return false;
  if (Array.isArray(value)) return value.length > 256 || value.some(item => extensionProblem(item, depth + 1));
  return !isRec(value) || Object.values(value).some(item => extensionProblem(item, depth + 1));
}

const isPlainText = (value: unknown, max: number): boolean => typeof value === 'string' && value.length <= max && !/[\p{Cc}\p{Cf}]/u.test(value);

/** Why a changed value under `color` cannot be accepted, or null. `where` names it. */
function colourLeafProblem(leaf: Leaf, where: string): string | null {
  const name = leaf.path[leaf.path.length - 1]!;
  if (leaf.path.some(part => part !== '$type' && part !== '$description' && part !== '$extensions' && !/^[^\s.{}\\"'<>$][^.{}\\"'<>]{0,127}$/.test(part))) return `${where}: this name cannot be used for a colour.`;
  if (name.startsWith('$')) {
    if (name === '$type') return leaf.value === 'color' || leaf.value === 'gradient' ? null : `${where}: a colour group's type has to be color or gradient.`;
    if (name === '$description') return isPlainText(leaf.value, MAX_TEXT) ? null : `${where}: this description cannot be used.`;
    return name === '$extensions' && !extensionProblem(leaf.value) ? null : `${where}: this setting cannot be used.`;
  }
  const token = leaf.value;
  if (!isRec(token) || !('$value' in token)) return `${where}: this is not a colour token.`;
  for (const key of Object.keys(token)) if (!['$value', '$type', '$description', '$extensions'].includes(key)) return `${where}: a colour token cannot hold ${key}.`;
  if (token.$type !== undefined && token.$type !== 'color' && token.$type !== 'gradient') return `${where}: only a colour or a gradient can be changed here.`;
  if (token.$description !== undefined && !isPlainText(token.$description, MAX_TEXT)) return `${where}: this description cannot be used.`;
  if (token.$extensions !== undefined && extensionProblem(token.$extensions)) return `${where}: its settings cannot be used.`;
  if (typeof token.$value === 'string' ? !isColourText(token.$value) : colourValueProblem(token.$value)) return `${where}: this is not a colour value.`;
  return null;
}

/** Whole-value aliases inside a changed token. */
function aliasesIn(value: unknown, out: Set<string>, depth = 0): void {
  if (depth > 12) return;
  if (typeof value === 'string') { const match = ALIAS.exec(value.trim()); if (match) out.add(match[1]!); }
  else if (Array.isArray(value)) for (const item of value) aliasesIn(item, out, depth + 1);
  else if (isRec(value)) for (const item of Object.values(value)) aliasesIn(item, out, depth + 1);
}

/** A token as a person reads it: its path, with the set only when it is not the base one. */
const leafName = (set: string | null, path: readonly string[]): string => `${path.join('.')}${set && set !== 'base' ? ` in ${set}` : ''}`;

// ── Roles, the brand's own words ──────────────────────────────────────────────

const colourRoles = (roles: unknown[]): Rec[] => roles.filter((role): role is Rec => isRec(role) && role.group === COLOUR_ROLE_GROUP);
const otherRoles = (roles: unknown[]): unknown[] => roles.filter(role => !(isRec(role) && role.group === COLOUR_ROLE_GROUP));

/** Why a colour role cannot be accepted, or null. The rule the studio's ids follow. */
function roleProblem(role: Rec): string | null {
  const id = role.id;
  if (typeof id !== 'string' || !/^[a-z][a-z-]{0,31}$/.test(id)) return 'A colour role id uses lowercase letters and hyphens, starts with a letter and has at most 32 characters.';
  if (id.startsWith('on-') || id.startsWith('token-') || ['warn', 'warn-ink', 'lead-count'].includes(id)) return `The colour role id ${id} is reserved.`;
  if (!isPlainText(role.label, MAX_ROLE_LABEL) || !(role.label as string).trim()) return `The colour role ${id} needs a plain label of at most ${MAX_ROLE_LABEL} characters.`;
  if (role.description !== undefined && !isPlainText(role.description, MAX_ROLE_DESCRIPTION)) return `The colour role ${id} has a description this instance cannot accept.`;
  if (!Array.isArray(role.resources) || role.resources.length > 16) return `The colour role ${id} needs a short list of tokens.`;
  for (const resource of role.resources) {
    if (!isRec(resource) || resource.type !== 'token' || typeof resource.path !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,255}$/.test(resource.path)) return `The colour role ${id} can only name colour tokens.`;
  }
  for (const key of Object.keys(role)) if (!['id', 'label', 'description', 'group', 'resources'].includes(key)) return `The colour role ${id} cannot hold ${key}.`;
  return null;
}

function bindingProblem(binding: Rec, roleIds: ReadonlySet<string>): string | null {
  const id = String(binding.id ?? '');
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return 'A binding id uses lowercase letters, digits and hyphens.';
  if (typeof binding.roleId !== 'string' || !roleIds.has(binding.roleId)) return `The binding ${id} names a colour role this document does not have.`;
  const consumer = binding.consumer;
  if (!isRec(consumer) || typeof consumer.slot !== 'string' || !/^[a-z][a-z0-9-]{0,63}$/.test(consumer.slot)) return `The binding ${id} needs a slot.`;
  if (consumer.tool !== undefined && (typeof consumer.tool !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(consumer.tool))) return `The binding ${id} names a tool this instance cannot read.`;
  for (const key of Object.keys(consumer)) if (key !== 'slot' && key !== 'tool') return `The binding ${id} cannot hold ${key}.`;
  if (binding.modes !== undefined && (!Array.isArray(binding.modes) || binding.modes.length > 16 || binding.modes.some(mode => !isPlainText(mode, 64)))) return `The binding ${id} has a list of modes this instance cannot read.`;
  for (const key of Object.keys(binding)) if (!['id', 'roleId', 'consumer', 'modes'].includes(key)) return `The binding ${id} cannot hold ${key}.`;
  return null;
}

// ── Comparing with the base ───────────────────────────────────────────────────

/** Every difference between the mounted document and a sent one, sorted into what may change and what may not. */
export function compareBrandDocument(base: Rec, doc: Rec): BrandDocumentComparison {
  const changes: BrandEditChange[] = [], outOfScope: string[] = [], invalid: string[] = [];
  const outside = (where: string): void => { if (!outOfScope.includes(where)) outOfScope.push(where); };
  const baseSets = setNames(base), docSets = setNames(doc);

  const compareColours = (set: string | null, from: unknown, to: unknown): void => {
    const before = new Map<string, Leaf>(), after = new Map<string, Leaf>();
    leavesOf(from, ['color'], before);
    leavesOf(to, ['color'], after);
    for (const [key, leaf] of after) {
      const was = before.get(key);
      if (was && same(was.value, leaf.value)) continue;
      const problem = colourLeafProblem(leaf, leafName(set, leaf.path));
      if (problem) invalid.push(problem);
      changes.push({ kind: 'token', set, path: leaf.path, before: was ? was.value : null, after: leaf.value });
    }
    for (const [key, leaf] of before) if (!after.has(key)) changes.push({ kind: 'token', set, path: leaf.path, before: leaf.value, after: null });
  };

  // A set's other groups are not this slice's business.
  const compareSet = (name: string | null, from: Rec, to: Rec): void => {
    for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
      if (key === 'color') {
        if (to.color !== undefined && !isRec(to.color)) invalid.push(`${name ? `${name}: ` : ''}color has to be a group of colours.`);
        else compareColours(name, from.color, to.color);
        continue;
      }
      if (name === null && key.startsWith('$')) continue;
      if (!same(from[key], to[key])) outside(name ? `${name}.${key}` : key);
    }
  };

  if (!baseSets !== !docSets) outside('the set layout of the document');
  else if (!baseSets || !docSets) compareSet(null, base, doc);
  else {
    for (const name of new Set([...baseSets, ...docSets])) {
      const from = base[name], to = doc[name];
      if (from !== undefined && to !== undefined) {
        if (isRec(from) && isRec(to)) compareSet(name, from, to);
        else if (!same(from, to)) outside(name);
      } else if (!isColourwaySet(name)) outside(`the set ${name}`);
      else if (to !== undefined) {
        if (!isRec(to) || Object.keys(to).some(key => key !== 'color')) { outside(`the set ${name}`); continue; }
        const leaves = new Map<string, Leaf>();
        leavesOf(to.color, ['color'], leaves);
        for (const leaf of leaves.values()) {
          const problem = colourLeafProblem(leaf, leafName(name, leaf.path));
          if (problem) invalid.push(problem);
        }
        changes.push({ kind: 'set', name, before: null, after: to });
      } else {
        if (!isRec(from) || Object.keys(from).some(key => key !== 'color')) { outside(`the set ${name}`); continue; }
        changes.push({ kind: 'set', name, before: from, after: null });
      }
    }
  }

  // The root's own settings, apart from the three this slice reads below.
  for (const key of new Set([...Object.keys(base), ...Object.keys(doc)])) {
    if (key.startsWith('$') && !['$themes', '$metadata', '$extensions'].includes(key) && !same(base[key], doc[key])) outside(key);
  }

  compareThemes(base, doc, changes, outside, invalid);
  compareMetadata(base, doc, outside);
  compareExtensions(base, doc, changes, outside, invalid);

  if (changes.length > MAX_CHANGES) invalid.push(`This document changes more than ${MAX_CHANGES} things at once.`);
  // A sent document has to mean something once applied.
  invalid.push(...landingProblems(doc, changes));
  return { changes, outOfScope, invalid };
}

function compareThemes(base: Rec, doc: Rec, changes: BrandEditChange[], outside: (where: string) => void, invalid: string[]): void {
  const baseThemes = Array.isArray(base.$themes) ? base.$themes : [], docThemes = Array.isArray(doc.$themes) ? doc.$themes : [];
  if ((base.$themes !== undefined && !Array.isArray(base.$themes)) || (doc.$themes !== undefined && !Array.isArray(doc.$themes))) { if (!same(base.$themes, doc.$themes)) outside('$themes'); return; }
  const groups = new Set([...colourwayGroups(base), ...colourwayGroups(doc)]);
  const isColourway = (theme: unknown): theme is Rec => isRec(theme) && typeof theme.group === 'string' && groups.has(theme.group);
  const others = (themes: unknown[]): unknown[] => themes.filter(theme => !isColourway(theme));
  if (!same(others(baseThemes).map(withoutModeNote), others(docThemes).map(withoutModeNote))) outside('$themes, for a theme that is not a colourway');
  else {
    const before = new Map(others(baseThemes).map(theme => [themeId(theme), theme]));
    for (const theme of others(docThemes)) {
      const was = before.get(themeId(theme));
      if (was !== undefined && !same(was, theme)) {
        if (same(theme, withoutModeNote(theme))) outside('$themes, for a theme that is not a colourway');
        else changes.push({ kind: 'mode-note', id: themeId(theme) });
      }
    }
  }
  const from = new Map(baseThemes.filter(isColourway).map(theme => [themeId(theme), theme]));
  const to = new Map(docThemes.filter(isColourway).map(theme => [themeId(theme), theme]));
  if (to.size !== docThemes.filter(isColourway).length) invalid.push('Two colourways share one id.');
  for (const [id, theme] of to) {
    const was = from.get(id);
    if (was && same(was, theme)) continue;
    const problem = colourwayThemeProblem(id, theme);
    if (problem) invalid.push(problem);
    changes.push({ kind: 'theme', id, before: was ?? null, after: theme });
  }
  for (const [id, theme] of from) if (!to.has(id)) changes.push({ kind: 'theme', id, before: theme, after: null });
  const order = [...to.keys()];
  if (!same([...from.keys()], order)) changes.push({ kind: 'order', target: 'themes', after: order });
}

const MODE_NOTE = { kind: 'mode' };

/** A theme as it reads without the note that says it is a light or dark mode, and nothing else removed. */
function withoutModeNote(theme: unknown): unknown {
  if (!isRec(theme) || !isRec(theme.$extensions)) return theme;
  const vendor = theme.$extensions[TOKEN_EXT];
  if (!isRec(vendor) || !same(vendor.axis, MODE_NOTE)) return theme;
  const { axis: _axis, ...restVendor } = vendor;
  const { [TOKEN_EXT]: _vendor, ...restExtensions } = theme.$extensions;
  const extensions = Object.keys(restVendor).length ? { ...restExtensions, [TOKEN_EXT]: restVendor } : restExtensions;
  const { $extensions: _extensions, ...rest } = theme;
  return Object.keys(extensions).length ? { ...rest, $extensions: extensions } : rest;
}

function colourwayThemeProblem(id: string, theme: Rec): string | null {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) return `The colourway id ${id.slice(0, 64)} cannot be used.`;
  if (!isPlainText(theme.name, 120)) return `The colourway ${id} needs a plain name.`;
  for (const key of Object.keys(theme)) if (!['id', 'name', 'group', 'selectedTokenSets', '$extensions'].includes(key)) return `The colourway ${id} cannot hold ${key}.`;
  const selected = theme.selectedTokenSets;
  if (!isRec(selected) || Object.entries(selected).some(([set, state]) => !isColourwaySet(set) || !['enabled', 'disabled', 'source'].includes(String(state)))) return `The colourway ${id} can only turn on colourway sets.`;
  if (theme.$extensions !== undefined && extensionProblem(theme.$extensions)) return `The colourway ${id} has settings this instance cannot accept.`;
  return null;
}

function compareMetadata(base: Rec, doc: Rec, outside: (where: string) => void): void {
  if (same(base.$metadata, doc.$metadata)) return;
  if (!isRec(base.$metadata) || !isRec(doc.$metadata)) { outside('$metadata'); return; }
  for (const key of new Set([...Object.keys(base.$metadata), ...Object.keys(doc.$metadata)])) {
    if (key !== 'tokenSetOrder' && !same(base.$metadata[key], doc.$metadata[key])) outside(`$metadata.${key}`);
  }
  const from = base.$metadata.tokenSetOrder, to = doc.$metadata.tokenSetOrder;
  if (same(from, to)) return;
  if (!Array.isArray(from) || !Array.isArray(to)) { outside('$metadata.tokenSetOrder'); return; }
  const others = (order: unknown[]) => order.filter(name => typeof name !== 'string' || !isColourwaySet(name));
  if (!same(others(from), others(to))) outside('$metadata.tokenSetOrder, for a set that is not a colourway');
}

function compareExtensions(base: Rec, doc: Rec, changes: BrandEditChange[], outside: (where: string) => void, invalid: string[]): void {
  const baseExt = isRec(base.$extensions) ? base.$extensions : {}, docExt = isRec(doc.$extensions) ? doc.$extensions : {};
  if ((base.$extensions !== undefined && !isRec(base.$extensions)) || (doc.$extensions !== undefined && !isRec(doc.$extensions))) { outside('$extensions'); return; }
  for (const key of new Set([...Object.keys(baseExt), ...Object.keys(docExt)])) {
    if (key !== TOKEN_EXT && !same(baseExt[key], docExt[key])) outside(`$extensions.${key}`);
  }
  const from = vendorOf(base) ?? {}, to = vendorOf(doc) ?? {};
  if (docExt[TOKEN_EXT] !== undefined && !isRec(docExt[TOKEN_EXT])) { outside(`$extensions.${TOKEN_EXT}`); return; }
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (key !== 'brandSystem' && key !== 'exportRecord' && !same(from[key], to[key])) outside(`$extensions.${TOKEN_EXT}.${key}`);
  }
  // The address, and nothing else in the record.
  const recordOf = (vendor: Rec): Rec => isRec(vendor.exportRecord) ? vendor.exportRecord : {};
  const fromRecord = recordOf(from), toRecord = recordOf(to);
  if (to.exportRecord !== undefined && !isRec(to.exportRecord)) outside(`$extensions.${TOKEN_EXT}.exportRecord`);
  for (const key of new Set([...Object.keys(fromRecord), ...Object.keys(toRecord)])) {
    if (key !== 'brandPage' && !same(fromRecord[key], toRecord[key])) outside(`$extensions.${TOKEN_EXT}.exportRecord.${key}`);
  }
  if (!same(fromRecord.brandPage, toRecord.brandPage)) {
    const after = toRecord.brandPage === undefined ? null : brandPageAddress(toRecord.brandPage);
    if (toRecord.brandPage !== undefined && after !== toRecord.brandPage) invalid.push('A brand page address has to be a plain https address on a named host.');
    changes.push({ kind: 'brand-page', before: typeof fromRecord.brandPage === 'string' ? fromRecord.brandPage : null, after: typeof toRecord.brandPage === 'string' ? toRecord.brandPage : null });
  }
  compareSystem(from.brandSystem, to.brandSystem, changes, outside, invalid);
}

function compareSystem(from: unknown, to: unknown, changes: BrandEditChange[], outside: (where: string) => void, invalid: string[]): void {
  if (same(from, to)) return;
  const where = `$extensions.${TOKEN_EXT}.brandSystem`;
  if (!isRec(to) || (from !== undefined && !isRec(from))) { outside(where); return; }
  if (!Array.isArray(to.roles) || !Array.isArray(to.bindings)) { invalid.push('The list of colour roles cannot be read.'); return; }
  const fromRec: Rec = isRec(from) ? from : {};
  if (from === undefined) {
    // A first set of roles for a system that had no record at all, and nothing beyond them.
    if (to.schemaVersion !== 1 || !isPlainText(to.id, 64) || !isPlainText(to.label, 120)) invalid.push('The list of colour roles needs an id and a label.');
    const allowed = ['schemaVersion', 'id', 'label', 'roles', 'bindings', 'rules'];
    for (const key of Object.keys(to)) if (!allowed.includes(key)) outside(`${where}.${key}`);
    if (!Array.isArray(to.rules) || to.rules.length) outside(`${where}.rules`);
    changes.push({ kind: 'system', after: { schemaVersion: 1, id: String(to.id), label: String(to.label) } });
  } else {
    for (const key of new Set([...Object.keys(fromRec), ...Object.keys(to)])) {
      if (key !== 'roles' && key !== 'bindings' && !same(fromRec[key], to[key])) outside(`${where}.${key}`);
    }
  }
  const fromRoles = Array.isArray(fromRec.roles) ? fromRec.roles : [], toRoles = to.roles as unknown[];
  if (!same(otherRoles(fromRoles), otherRoles(toRoles))) outside(`${where}.roles, for a role that is not a colour role`);
  const fromColour = new Map(colourRoles(fromRoles).map(role => [String(role.id), role]));
  const toColour = new Map(colourRoles(toRoles).map(role => [String(role.id), role]));
  if (toColour.size !== colourRoles(toRoles).length) invalid.push('Two colour roles share one id.');
  if (toColour.size > MAX_ROLES) invalid.push(`A design system can hold at most ${MAX_ROLES} colour roles.`);
  for (const [id, role] of toColour) {
    const was = fromColour.get(id);
    if (was && same(was, role)) continue;
    const problem = roleProblem(role);
    if (problem) invalid.push(problem);
    changes.push({ kind: 'role', id, before: was ?? null, after: role });
  }
  for (const [id, role] of fromColour) if (!toColour.has(id)) changes.push({ kind: 'role', id, before: role, after: null });
  const order = [...toColour.keys()];
  if (!same([...fromColour.keys()], order)) changes.push({ kind: 'order', target: 'roles', after: order });

  const fromBindings = Array.isArray(fromRec.bindings) ? fromRec.bindings.filter(isRec) : [];
  const toBindings = (to.bindings as unknown[]).filter(isRec);
  if (toBindings.length !== (to.bindings as unknown[]).length) invalid.push('A binding cannot be read.');
  const bindingsFrom = new Map(fromBindings.map(binding => [String(binding.id), binding]));
  const bindingsTo = new Map(toBindings.map(binding => [String(binding.id), binding]));
  if (bindingsTo.size !== toBindings.length) invalid.push('Two bindings share one id.');
  const colourIds = new Set(toColour.keys());
  for (const [id, binding] of bindingsTo) {
    const was = bindingsFrom.get(id);
    if (was && same(was, binding)) continue;
    const problem = bindingProblem(binding, colourIds);
    if (problem) invalid.push(problem);
    changes.push({ kind: 'binding', id, before: was ?? null, after: binding });
  }
  for (const [id, binding] of bindingsFrom) {
    if (bindingsTo.has(id)) continue;
    if (!fromColour.has(String(binding.roleId))) { outside(`${where}.bindings, for a role that is not a colour role`); continue; }
    changes.push({ kind: 'binding', id, before: binding, after: null });
  }
}

/** What a changed value names has to exist in the document it applies to. */
function landingProblems(doc: Rec, changes: readonly BrandEditChange[]): string[] {
  const known = tokenPaths(doc), problems: string[] = [];
  const named = (value: unknown, where: string): void => {
    const aliases = new Set<string>();
    aliasesIn(isRec(value) && '$value' in value ? value.$value : value, aliases);
    for (const alias of aliases) if (!known.has(alias)) problems.push(`${where} names {${alias}}, which this document does not have.`);
  };
  for (const change of changes) {
    if (change.kind === 'token' && change.after !== null && !change.path[change.path.length - 1]!.startsWith('$')) named(change.after, leafName(change.set, change.path));
    if (change.kind === 'set' && isRec(change.after)) {
      const leaves = new Map<string, Leaf>();
      leavesOf(change.after.color, ['color'], leaves);
      for (const leaf of leaves.values()) if (!leaf.path[leaf.path.length - 1]!.startsWith('$')) named(leaf.value, leafName(change.name, leaf.path));
    }
    if (change.kind === 'role' && isRec(change.after) && Array.isArray(change.after.resources)) {
      for (const resource of change.after.resources) {
        if (isRec(resource) && typeof resource.path === 'string' && !known.has(resource.path)) problems.push(`The colour role ${change.id} names ${resource.path}, which this document does not have.`);
      }
    }
    if (change.kind === 'theme' && isRec(change.after) && isRec(change.after.selectedTokenSets)) {
      for (const set of Object.keys(change.after.selectedTokenSets)) if (!isRec(doc[set])) problems.push(`The colourway ${change.id} turns on ${set}, which this document does not have.`);
    }
  }
  problems.push(...strandedByRemoval(doc, changes, known));
  return problems;
}

/** A removal is only sound when nothing that stayed still points at what went. */
function strandedByRemoval(doc: Rec, changes: readonly BrandEditChange[], known: ReadonlySet<string>): string[] {
  const removed = new Set<string>();
  for (const change of changes) {
    if (change.kind === 'token' && change.after === null) removed.add(change.path.join('.'));
    if (change.kind === 'set' && change.after === null && isRec(change.before)) {
      const leaves = new Map<string, Leaf>();
      leavesOf(change.before.color, ['color'], leaves);
      for (const leaf of leaves.values()) removed.add(leaf.path.join('.'));
    }
  }
  for (const path of [...removed]) if (known.has(path)) removed.delete(path);
  if (!removed.size) return [];
  const problems = new Set<string>();
  const walk = (node: unknown): void => {
    if (!isRec(node)) return;
    if ('$value' in node) {
      const aliases = new Set<string>();
      aliasesIn(node.$value, aliases);
      for (const alias of aliases) if (removed.has(alias)) problems.add(`A colour still points at ${alias}, which this edit removes.`);
      return;
    }
    for (const [key, child] of Object.entries(node)) if (!key.startsWith('$')) walk(child);
  };
  const sets = setNames(doc);
  if (!sets) walk(doc);
  else for (const name of sets) walk(doc[name]);
  const system = vendorOf(doc)?.brandSystem;
  for (const role of isRec(system) && Array.isArray(system.roles) ? system.roles : []) {
    for (const resource of isRec(role) && Array.isArray(role.resources) ? role.resources : []) {
      if (isRec(resource) && typeof resource.path === 'string' && removed.has(resource.path)) problems.add(`The role ${String(role.id)} still names ${resource.path}, which this edit removes.`);
    }
  }
  return [...problems];
}

// ── Landing on a base ─────────────────────────────────────────────────────────

const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

function nodeAt(root: unknown, path: readonly string[]): unknown {
  let node = root;
  for (const part of path) {
    if (!isRec(node) || !Object.hasOwn(node, part)) return undefined;
    node = node[part];
  }
  return node;
}

function setAt(root: Rec, path: readonly string[], value: unknown): void {
  let node = root;
  for (const part of path.slice(0, -1)) {
    if (!isRec(node[part])) node[part] = {};
    node = node[part] as Rec;
  }
  node[path[path.length - 1]!] = clone(value);
}

/** Removes a value and any group that leaves empty. */
function removeAt(root: Rec, path: readonly string[]): void {
  const parents: Rec[] = [];
  let node = root;
  for (const part of path.slice(0, -1)) {
    if (!isRec(node[part])) return;
    parents.push(node);
    node = node[part] as Rec;
  }
  delete node[path[path.length - 1]!];
  for (let at = parents.length - 1; at >= 0 && Object.keys(node).length === 0; at--) {
    const parent = parents[at]!;
    delete parent[path[at]!];
    node = parent;
  }
}

export interface LandedEdit {
  doc: Rec;
  /** What the edit names that this base no longer has. Any entry means it cannot apply. */
  gone: string[];
  /** Where this base and the edit both changed the same thing. The edit stays on top. */
  overlaps: string[];
}

/**
 * The list of changes on another base. Nothing is dropped: if something an edit changes
 * has gone from this base, `gone` says so and the caller serves the base as it stands.
 */
export function applyBrandChanges(base: Rec, changes: readonly BrandEditChange[]): LandedEdit {
  const doc = clone(base), gone: string[] = [], overlaps: string[] = [];
  const vendor = (): Rec => {
    if (!isRec(doc.$extensions)) doc.$extensions = {};
    const ext = doc.$extensions as Rec;
    if (!isRec(ext[TOKEN_EXT])) ext[TOKEN_EXT] = {};
    return ext[TOKEN_EXT] as Rec;
  };
  const prune = (): void => {
    const ext = isRec(doc.$extensions) ? doc.$extensions : null;
    const own = ext && isRec(ext[TOKEN_EXT]) ? ext[TOKEN_EXT] as Rec : null;
    if (own && isRec(own.exportRecord) && !Object.keys(own.exportRecord).length) delete own.exportRecord;
    if (ext && own && !Object.keys(own).length) delete ext[TOKEN_EXT];
    if (ext && !Object.keys(ext).length) delete doc.$extensions;
  };
  const system = (): Rec | null => { const value = vendorOf(doc)?.brandSystem; return isRec(value) ? value : null; };

  for (const change of changes) {
    if (change.kind === 'system') {
      if (!system()) vendor().brandSystem = { ...change.after, roles: [], bindings: [], rules: [] };
    } else if (change.kind === 'set') {
      const exists = isRec(doc[change.name]);
      if (change.after === null) {
        if (exists && !same(doc[change.name], change.before)) overlaps.push(`the colourway set ${change.name}`);
        if (exists) delete doc[change.name];
        if (isRec(doc.$metadata) && Array.isArray(doc.$metadata.tokenSetOrder)) doc.$metadata.tokenSetOrder = doc.$metadata.tokenSetOrder.filter(name => name !== change.name);
      } else {
        if (exists && !same(doc[change.name], change.after)) overlaps.push(`the colourway set ${change.name}`);
        doc[change.name] = clone(change.after);
        if (isRec(doc.$metadata) && Array.isArray(doc.$metadata.tokenSetOrder) && !doc.$metadata.tokenSetOrder.includes(change.name)) doc.$metadata.tokenSetOrder.push(change.name);
      }
    } else if (change.kind === 'token') {
      const root = change.set === null ? doc : doc[change.set];
      const name = leafName(change.set, change.path);
      if (!isRec(root)) {
        if (change.after !== null) gone.push(name);
        continue;
      }
      const current = nodeAt(root, change.path);
      if (change.before !== null && current === undefined) { if (change.after !== null) gone.push(name); continue; }
      if (current !== undefined && !same(current, change.before) && !same(current, change.after)) overlaps.push(name);
      if (change.after === null) removeAt(root, change.path);
      else setAt(root, change.path, change.after);
    } else if (change.kind === 'theme') {
      const themes = Array.isArray(doc.$themes) ? doc.$themes : (doc.$themes = []) as unknown[];
      const at = themes.findIndex(theme => isRec(theme) && themeId(theme) === change.id);
      if (change.before !== null && at < 0) { if (change.after !== null) gone.push(`the colourway ${change.id}`); continue; }
      if (at >= 0 && !same(themes[at], change.before) && !same(themes[at], change.after)) overlaps.push(`the colourway ${change.id}`);
      if (change.after === null) { if (at >= 0) themes.splice(at, 1); }
      else if (at >= 0) themes[at] = clone(change.after);
      else themes.push(clone(change.after));
    } else if (change.kind === 'mode-note') {
      const theme = (Array.isArray(doc.$themes) ? doc.$themes : []).find(item => isRec(item) && themeId(item) === change.id) as Rec | undefined;
      if (!theme) { gone.push(`the theme ${change.id}`); continue; }
      if (!isRec(theme.$extensions)) theme.$extensions = {};
      const ext = theme.$extensions as Rec;
      if (!isRec(ext[TOKEN_EXT])) ext[TOKEN_EXT] = {};
      (ext[TOKEN_EXT] as Rec).axis = { ...MODE_NOTE };
    } else if (change.kind === 'role' || change.kind === 'binding') {
      const record = system();
      const field = change.kind === 'role' ? 'roles' : 'bindings';
      const list = record && Array.isArray(record[field]) ? record[field] as unknown[] : null;
      const noun = change.kind === 'role' ? 'colour role' : 'binding';
      if (!list) { if (change.after !== null) gone.push(`The ${noun} ${change.id} cannot apply, because the new image has no list of roles.`); continue; }
      const at = list.findIndex(item => isRec(item) && item.id === change.id);
      if (change.before !== null && at < 0) { if (change.after !== null) gone.push(`the ${noun} ${change.id}`); continue; }
      if (at >= 0 && !same(list[at], change.before) && !same(list[at], change.after)) overlaps.push(`the ${noun} ${change.id}`);
      if (change.after === null) { if (at >= 0) list.splice(at, 1); }
      else if (at >= 0) list[at] = clone(change.after);
      else list.push(clone(change.after));
    } else if (change.kind === 'brand-page') {
      const own = vendorOf(doc);
      const record = own && isRec(own.exportRecord) ? own.exportRecord : null;
      const current = typeof record?.brandPage === 'string' ? record.brandPage : null;
      if (current !== change.before && current !== change.after) overlaps.push('the brand page address');
      if (change.after === null) { if (record) delete record.brandPage; }
      else {
        const target = vendor();
        target.exportRecord = { ...(isRec(target.exportRecord) ? target.exportRecord : {}), brandPage: change.after };
      }
    }
  }
  for (const change of changes) {
    if (change.kind !== 'order') continue;
    if (change.target === 'themes' && Array.isArray(doc.$themes)) {
      const groups = colourwayGroups(doc);
      const colourway = (theme: unknown): boolean => isRec(theme) && typeof theme.group === 'string' && groups.has(theme.group);
      const rank = (theme: unknown): number => { const at = change.after.indexOf(themeId(theme)); return at < 0 ? change.after.length : at; };
      doc.$themes = [...doc.$themes.filter(theme => !colourway(theme)), ...doc.$themes.filter(colourway).sort((a, b) => rank(a) - rank(b))];
    }
    const record = system();
    if (change.target === 'roles' && record && Array.isArray(record.roles)) {
      const rank = (role: Rec): number => { const at = change.after.indexOf(String(role.id)); return at < 0 ? change.after.length : at; };
      record.roles = [...otherRoles(record.roles), ...colourRoles(record.roles).sort((a, b) => rank(a) - rank(b))];
    }
  }
  prune();
  gone.push(...landingProblems(doc, changes));
  return { doc, gone, overlaps };
}

// ── Saying what changed ───────────────────────────────────────────────────────

export interface BrandEditLine { kind: 'colour' | 'colourway' | 'role' | 'binding' | 'brand-page'; name: string; label?: string; action: 'added' | 'changed' | 'removed'; before: string | null; after: string | null }

const valueText = (leaf: unknown): string | null => {
  if (leaf === null || leaf === undefined) return null;
  const value = isRec(leaf) && '$value' in leaf ? leaf.$value : leaf;
  return typeof value === 'string' ? value : JSON.stringify(value).slice(0, 200);
};
/** The name a person gave this colour, when the document holds one. Plain text, bounded. */
const labelOf = (before: unknown, after: unknown): { label: string } | Record<string, never> => {
  const leaf = isRec(after) ? after : before;
  const text = isRec(leaf) && typeof leaf.$description === 'string' ? leaf.$description.trim() : '';
  return text ? { label: text.slice(0, 80) } : {};
};
const actionOf = (before: unknown, after: unknown): BrandEditLine['action'] => before === null ? 'added' : after === null ? 'removed' : 'changed';
const roleWords = (role: unknown): string | null => isRec(role) && typeof role.label === 'string' ? role.label : null;
const bindingWords = (binding: unknown): string | null => isRec(binding) && isRec(binding.consumer) ? `${String(binding.roleId)} as ${String(binding.consumer.slot)}` : null;

/** The changes as lines a person reads, in a fixed order. */
export function describeBrandChanges(changes: readonly BrandEditChange[]): BrandEditLine[] {
  const lines: BrandEditLine[] = [];
  for (const change of changes) {
    if (change.kind === 'token') {
      // A group's own metadata is not a colour anyone chose.
      if (change.path[change.path.length - 1]!.startsWith('$')) continue;
      lines.push({ kind: 'colour', name: leafName(change.set, change.path), ...labelOf(change.before, change.after), action: actionOf(change.before, change.after), before: valueText(change.before), after: valueText(change.after) });
    } else if (change.kind === 'set') lines.push({ kind: 'colourway', name: change.name.replace(/^colourway\//, ''), action: actionOf(change.before, change.after), before: null, after: null });
    else if (change.kind === 'theme') lines.push({ kind: 'colourway', name: isRec(change.after) && typeof change.after.name === 'string' ? change.after.name : isRec(change.before) && typeof change.before.name === 'string' ? change.before.name : change.id, action: actionOf(change.before, change.after), before: null, after: null });
    else if (change.kind === 'role') lines.push({ kind: 'role', name: change.id, action: actionOf(change.before, change.after), before: roleWords(change.before), after: roleWords(change.after) });
    else if (change.kind === 'binding') lines.push({ kind: 'binding', name: change.id, action: actionOf(change.before, change.after), before: bindingWords(change.before), after: bindingWords(change.after) });
    else if (change.kind === 'brand-page') lines.push({ kind: 'brand-page', name: 'Brand page address', action: actionOf(change.before, change.after), before: change.before, after: change.after });
  }
  // A theme and its set say the same colourway twice; one line each is enough.
  const seen = new Set<string>();
  return lines.filter(line => {
    if (line.kind !== 'colourway') return true;
    const key = `${line.name.toLowerCase()}:${line.action}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What an edit changes that the new image no longer has, in plain words. An entry
 * ending in a full stop is already a sentence; any other entry is the name of a thing.
 */
export function goneMessage(gone: readonly string[], subject = 'This edit'): string {
  const things = gone.filter(entry => !entry.endsWith('.'));
  const shown = things.slice(0, 8);
  const rest = things.length - shown.length;
  const named = rest ? `${shown.join(', ')} and ${rest} more` : shown.length > 1 ? `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}` : shown[0];
  return [named ? `${subject} changes ${named}, which the new image no longer has.` : '', ...gone.filter(entry => entry.endsWith('.'))].filter(Boolean).join(' ');
}

/** One sentence for a refusal: what changed, and what this instance takes. */
export function outOfScopeMessage(outOfScope: readonly string[]): string {
  const shown = outOfScope.slice(0, 8).join('; ');
  const rest = outOfScope.length > 8 ? `; and ${outOfScope.length - 8} more` : '';
  return `This edit also changes ${shown}${rest}. This instance takes colours, colour roles and the brand page address, so nothing was saved.`;
}
