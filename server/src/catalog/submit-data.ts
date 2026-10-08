/**
 * Data submissions (plan 299, track B): a member's saved TEMPLATE or USER TOOL
 * entering the catalog through the same submit pipeline as a picture.
 *
 * Both are data, never code. A template is a `values` seed for one tool (the
 * shape the shell's "Export as file" writes, plus the tool id); a user tool is
 * the same seed under its own name and icon. Neither carries hooks, markup or
 * a manifest, which is why they may go through submission while a code-bearing
 * tool may not (plan 65 keeps those behind signature verification).
 *
 * What this module decides, before anything is scanned or stored:
 *  - the bytes are one JSON object of the expected shape, under a size cap;
 *  - the tool it seeds exists in this instance's pack, so an approved template
 *    can always be opened by the people it is published to;
 *  - `values` is a plain object;
 *  - a user tool's icon is a short glyph, never markup: an SVG submitted by one
 *    member would otherwise render inside every other member's shell.
 *
 * The bytes stored are the normalized JSON this returns, not the bytes sent,
 * so what a reviewer approves is exactly what the feed serves.
 */

/** The two kinds, as the `type` query param and the served entry name them. */
export const DATA_SUBMISSION_TYPES = ['template', 'user-tool'] as const;
export type DataSubmissionType = (typeof DATA_SUBMISSION_TYPES)[number];

export const isDataSubmissionType = (type: unknown): type is DataSubmissionType =>
  typeof type === 'string' && (DATA_SUBMISSION_TYPES as readonly string[]).includes(type);

/** A design document runs to a few MiB; the session routes accept 4 MiB, so
 *  a template made from one fits here too. */
export const MAX_DATA_SUBMISSION_BYTES = 4 * 1024 * 1024;

const TOOL_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** What a reviewer reads instead of a thumbnail, kept on the submission. */
export interface DataSubmissionSummary {
  kind: DataSubmissionType;
  /** The tool the seed opens in (`toolId` for a template, `baseToolId` for a user tool). */
  toolId: string;
  /** The tool's display name from the pack, when it has one. */
  toolName?: string;
  /** How many values the seed sets. */
  valueCount: number;
  /** Values the tool does not declare as inputs (internal `__` keys aside).
   *  Not an error: a newer shell may know inputs this pack does not. */
  undeclared: number;
}

export interface ToolLookup {
  /** The tool's declared input ids and display name, or null when the pack has no such tool. */
  (toolId: string): Promise<{ inputs: string[]; name?: string } | null>;
}

export type DataSubmissionOutcome =
  | { ok: true; bytes: Buffer; name: string; description?: string; summary: DataSubmissionSummary; formats?: string[]; icon?: string }
  | { ok: false; detail: string };

const cleanText = (v: unknown, max: number): string =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : '';

/** A user tool's icon survives only as a short glyph (an emoji or a letter). */
const safeIcon = (v: unknown): string | undefined => {
  const s = typeof v === 'string' ? v.trim() : '';
  return s && [...s].length <= 4 && !/[<>&"'\x00-\x1f]/.test(s) ? s : undefined;
};

/**
 * Validate and normalize one data submission. `declared` is what the submit
 * route was told (the `name` and `description` query params); the document's
 * own name fills in when the route was told none.
 */
export async function parseDataSubmission(
  kind: DataSubmissionType,
  bytes: Buffer,
  lookup: ToolLookup,
  declared: { name?: string; description?: string; toolId?: string } = {},
): Promise<DataSubmissionOutcome> {
  if (bytes.length > MAX_DATA_SUBMISSION_BYTES) {
    return { ok: false, detail: `a ${kind} is at most ${MAX_DATA_SUBMISSION_BYTES} bytes` };
  }
  let doc: unknown;
  try {
    doc = JSON.parse(bytes.toString('utf8'));
  } catch {
    return { ok: false, detail: `a ${kind} submission is a JSON document` };
  }
  if (!isObj(doc)) return { ok: false, detail: `a ${kind} submission is one JSON object` };
  const toolKey = kind === 'template' ? 'toolId' : 'baseToolId';
  const toolId = cleanText(doc[toolKey] ?? declared.toolId, 64);
  if (!TOOL_ID_RE.test(toolId)) return { ok: false, detail: `${toolKey} must name a tool` };
  if (!isObj(doc.values)) return { ok: false, detail: 'values must be an object of input values' };
  const tool = await lookup(toolId);
  if (!tool) return { ok: false, detail: `this catalog has no tool "${toolId}"` };
  const name = cleanText(declared.name, 200) || cleanText(kind === 'template' ? doc.name : doc.title, 200);
  if (!name) return { ok: false, detail: `a ${kind} needs a name` };
  const description = cleanText(declared.description, 500) || cleanText(doc.description, 500) || undefined;
  const values = doc.values;
  const keys = Object.keys(values);
  const known = new Set(tool.inputs);
  const undeclared = keys.filter((k) => !k.startsWith('__') && !known.has(k)).length;
  const formats = kind === 'user-tool' && Array.isArray(doc.formats)
    ? [...new Set(doc.formats.filter((f): f is string => typeof f === 'string' && /^[a-z0-9]{1,12}$/i.test(f)).map((f) => f.toLowerCase()))].slice(0, 32)
    : undefined;
  const icon = kind === 'user-tool' ? safeIcon(doc.icon) : undefined;
  const normalized = kind === 'template'
    ? { toolId, name, ...(description ? { description } : {}), values }
    : { baseToolId: toolId, title: name, ...(description ? { description } : {}), ...(icon ? { icon } : {}), ...(formats?.length ? { formats } : {}), values };
  return {
    ok: true,
    bytes: Buffer.from(`${JSON.stringify(normalized, null, 2)}\n`, 'utf8'),
    name,
    ...(description ? { description } : {}),
    summary: { kind, toolId, ...(tool.name ? { toolName: tool.name } : {}), valueCount: keys.length, undeclared },
    ...(formats?.length ? { formats } : {}),
    ...(icon ? { icon } : {}),
  };
}
