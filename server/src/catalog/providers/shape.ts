/**
 * Live-verify machinery shared by the DAM drivers whose field names are still
 * guesses (plans/33 §3, §4, §5): the structure report behind `--shape`, the
 * self-diagnosing error text, and the key-alternative reader.
 *
 * Three jobs, one file, so the four drivers stay a few lines each and cannot
 * drift apart:
 *
 *  1. STRUCTURE REPORTING. `describeEnvelope` / `describeRecords` turn one
 *     upstream page into key names and value TYPES. Never a value: the report
 *     is built by inspecting keys and `typeof`, and no branch copies datum into
 *     it, so there is no path by which asset content or a credential can ride
 *     out. Nested objects are described one level in (so a custom-field bag
 *     shows its key names), arrays as their element types. The one honest
 *     caveat, printed with every report: custom-field KEY NAMES are
 *     upstream-authored, so a report can carry an org's field naming.
 *  2. THE DIFF that makes it useful. A driver declares what it reads as
 *     `ShapeExpectation` groups - the alternative key names for one logical
 *     field, plus the exported constant holding them. `diffShape` then reports
 *     mapped / in-the-response-not-mapped / expected-but-absent. The last group
 *     is the wrong guesses, each naming the constant to edit.
 *  3. TOLERANCE + DIAGNOSIS. `firstKey` and friends read a record through those
 *     same constant arrays, so widening a guess after tenant day is a one-line
 *     edit in one obvious place; `liveVerifyError` writes the failure message
 *     that names the broken assumption, the constant, and the runbook page.
 *
 * Nothing here calls anything: pure functions over an already-fetched page.
 */

/** One key of an inspected object: its name and its value's TYPE, never its value. */
export interface ShapeField {
  key: string;
  /** e.g. 'string', 'number', 'string[]', '{ Expiry Date: string }', 'string or number'. */
  type: string;
  /** Element count, for an array value (envelope level only). */
  count?: number;
}

/** The alternative key names a driver reads for ONE logical field, plus the
 *  exported constant that holds them - what an operator edits when the guess
 *  turns out wrong. */
export interface ShapeExpectation {
  keys: readonly string[];
  constant: string;
}

/** The structure of one upstream page, plus how it compares with what the
 *  driver reads. Key names and types only (see the module header). */
export interface ProviderShapeReport {
  kind: string;
  /** Which call this describes: the LIST page (`sampleShape`) or the per-asset
   *  DETAIL call the byte path makes (`detailShape`). */
  scope: 'list' | 'detail';
  /** The call this report came from, e.g. 'GET /api/v1/image?limit=100&start=0'. */
  endpoint: string;
  envelope: ShapeField[];
  /** Which envelope key held the record array, or null when none did. */
  recordsKey: string | null;
  recordCount: number;
  /** Union of the record keys on this page, with each value's type. */
  record: ShapeField[];
  /** Keys the driver reads that ARE present. */
  mapped: string[];
  /** Keys upstream sent that the driver ignores. */
  unmapped: string[];
  /** Keys the driver reads that are NOT present - the wrong guesses, each
   *  rendered as 'a|b (CONSTANT_NAME)'. */
  absent: string[];
  notes: string[];
}

const MAX_INLINE_KEYS = 12;
const MAX_TYPE_VARIANTS = 3;
const WIDTH = 92;

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);

/** The type name of one array element. Objects collapse to 'object': a record
 *  array is described by the record block, not inline. */
function elementType(v: unknown): string {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  return typeof v;
}

/**
 * A value's TYPE as printable text. `maxDepth` 1 (the default) descends one
 * level into a nested object (so `additional: { Expiry Date: string }` is
 * visible, which is the whole point for custom-field bags); deeper objects
 * collapse to 'object'. A detail report raises it, because the byte path it
 * describes is itself nested (`embeds: { original: { url: string } }`).
 * Only key names and typeof results are ever returned.
 */
export function describeValue(value: unknown, depth = 0, maxDepth = 1): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    const kinds = [...new Set(value.map(elementType))].sort();
    return kinds.length === 0 ? 'empty[]' : `${kinds.join('|')}[]`;
  }
  if (typeof value === 'object') {
    if (depth >= maxDepth) return 'object';
    const keys = Object.keys(value as Record<string, unknown>);
    if (keys.length === 0) return '{}';
    const shown = keys.slice(0, MAX_INLINE_KEYS)
      .map((k) => `${k}: ${describeValue((value as Record<string, unknown>)[k], depth + 1, maxDepth)}`);
    const more = keys.length > shown.length ? `, +${keys.length - shown.length} more` : '';
    return `{ ${shown.join(', ')}${more} }`;
  }
  return typeof value;
}

/** The envelope's own keys, with a count on each array (the record array's size
 *  is the first thing an operator wants). */
export function describeEnvelope(doc: unknown, maxDepth = 1): ShapeField[] {
  if (!isRecord(doc)) return [];
  return Object.entries(doc).map(([key, v]) => ({
    key,
    type: describeValue(v, 0, maxDepth),
    ...(Array.isArray(v) ? { count: v.length } : {}),
  }));
}

/**
 * The UNION of the record keys on this page, so a key one record happens to
 * omit does not read as an absent guess. Where records disagree about a key's
 * type the variants are joined ('string or null'), capped so one odd record
 * cannot make the line unreadable.
 */
export function describeRecords(records: readonly unknown[], maxDepth = 1): ShapeField[] {
  const types = new Map<string, Set<string>>();
  for (const r of records) {
    if (!isRecord(r)) continue;
    for (const [key, v] of Object.entries(r)) {
      const set = types.get(key) ?? new Set<string>();
      set.add(describeValue(v, 0, maxDepth));
      types.set(key, set);
    }
  }
  return [...types].map(([key, set]) => {
    const variants = [...set].filter((t) => t !== 'null');
    const shown = (variants.length ? variants : [...set]).slice(0, MAX_TYPE_VARIANTS);
    return { key, type: shown.join(' or ') };
  });
}

/** The three-way diff: what the driver reads, what upstream sent, and the gap. */
export function diffShape(input: {
  envelope: readonly ShapeField[];
  record: readonly ShapeField[];
  envelopeExpected: readonly ShapeExpectation[];
  recordExpected: readonly ShapeExpectation[];
}): Pick<ProviderShapeReport, 'mapped' | 'unmapped' | 'absent'> {
  const mapped: string[] = [];
  const absent: string[] = [];
  const read = new Set<string>();

  const walk = (expected: readonly ShapeExpectation[], fields: readonly ShapeField[]): void => {
    const present = new Set(fields.map((f) => f.key));
    for (const exp of expected) {
      for (const k of exp.keys) read.add(k);
      const hit = exp.keys.filter((k) => present.has(k));
      if (hit.length) mapped.push(...hit);
      else absent.push(`${exp.keys.join('|')} (${exp.constant})`);
    }
  };
  walk(input.envelopeExpected, input.envelope);
  walk(input.recordExpected, input.record);

  const unmapped = [...input.envelope, ...input.record]
    .map((f) => f.key)
    .filter((k, i, all) => !read.has(k) && all.indexOf(k) === i);
  return { mapped, unmapped, absent };
}

/** The record array out of a list envelope, or null when no expected key held
 *  one. A bare top-level array is accepted too: some tenants return one, and
 *  refusing it would be a wrong guess of our own. */
export function findRecordArray(doc: unknown, keys: readonly string[]): { records: unknown[]; key: string } | null {
  if (Array.isArray(doc)) return { records: doc, key: '(top-level array)' };
  if (isRecord(doc)) {
    for (const k of keys) {
      const v = doc[k];
      if (Array.isArray(v)) return { records: v, key: k };
    }
  }
  return null;
}

/** The single record a DETAIL call returns - the list arm's `findRecordArray`,
 *  for the byte path. A driver's detail call either wraps its record under one
 *  of `keys` or returns it bare, and which of those a tenant does is itself a
 *  live-verify guess, so the answer is reported rather than assumed. */
export function findDetailRecord(
  doc: unknown,
  keys: readonly string[],
): { record: Record<string, unknown>; key: string } | null {
  if (!isRecord(doc)) return null;
  for (const k of keys) {
    const v = doc[k];
    if (isRecord(v)) return { record: v, key: k };
  }
  return { record: doc, key: '(unwrapped)' };
}

/** Same, but the miss is the self-diagnosing failure of plans/33 §4: the
 *  envelope-key guess is the single most likely thing to be wrong on tenant
 *  day, and it is the one an empty federation never explains by itself. */
export function recordArray(doc: unknown, kind: string, keys: readonly string[], constant: string): { records: unknown[]; key: string } {
  const found = findRecordArray(doc, keys);
  if (found) return found;
  throw liveVerifyError({
    kind, constant, tried: keys,
    problem: 'list response carried no record array',
    assumption: 'the list envelope key',
  });
}

/** The caveat that rides every report (plans/33 §3). Key names come from the
 *  tenant, so an operator reads before pasting into a public ticket. */
export const SHAPE_CAVEAT =
  'custom-field key names are upstream-authored, so this report can carry your org\'s field naming. '
  + 'It carries no asset content, no field values and no credential, but read it before pasting it into a public ticket.';

/** Assemble a report from an already-fetched page. `doc` is inspected, never copied. */
export function buildShapeReport(input: {
  kind: string;
  /** Defaults to the list page; a detail report says so, and reads differently. */
  scope?: 'list' | 'detail';
  endpoint: string;
  doc: unknown;
  records: readonly unknown[];
  recordsKey: string | null;
  envelopeExpected: readonly ShapeExpectation[];
  recordExpected: readonly ShapeExpectation[];
  notes?: readonly string[];
  /** How many levels into a nested object to describe (default 1). A detail
   *  report raises it: its subject, the download link, is nested. */
  depth?: number;
}): ProviderShapeReport {
  const envelope = describeEnvelope(input.doc, input.depth);
  const record = describeRecords(input.records, input.depth);
  return {
    kind: input.kind,
    scope: input.scope ?? 'list',
    endpoint: input.endpoint,
    envelope,
    recordsKey: input.recordsKey,
    recordCount: input.records.length,
    record,
    ...diffShape({ envelope, record, envelopeExpected: input.envelopeExpected, recordExpected: input.recordExpected }),
    notes: [...(input.notes ?? []), SHAPE_CAVEAT],
  };
}

/** The detail arm: one record, with the wrapper REPORTED rather than assumed.
 *  A driver that accepts an unwrapped record must not have its wrapper guess
 *  counted ABSENT for a tenant that legitimately sends one, so the expectation
 *  rides only when a known wrapper actually matched. A tenant that wraps under
 *  a name we do not know still diagnoses itself: the record then reads as the
 *  whole envelope, and the download-link guess lands in ABSENT with the real
 *  wrapper key beside it in NOT MAPPED. */
export function buildDetailShapeReport(input: {
  kind: string;
  endpoint: string;
  doc: unknown;
  /** Wrapper keys this driver tries; empty for a call that never wraps. */
  wrapperKeys: readonly string[];
  wrapperConstant: string;
  recordExpected: readonly ShapeExpectation[];
  notes?: readonly string[];
  depth?: number;
}): ProviderShapeReport {
  const found = findDetailRecord(input.doc, input.wrapperKeys);
  const wrapped = found !== null && found.key !== '(unwrapped)';
  return buildShapeReport({
    kind: input.kind,
    scope: 'detail',
    endpoint: input.endpoint,
    doc: input.doc,
    records: found ? [found.record] : [],
    recordsKey: found?.key ?? null,
    envelopeExpected: wrapped ? [{ keys: input.wrapperKeys, constant: input.wrapperConstant }] : [],
    recordExpected: input.recordExpected,
    ...(input.notes ? { notes: input.notes } : {}),
    ...(input.depth !== undefined ? { depth: input.depth } : {}),
  });
}

const fieldText = (f: ShapeField): string => `${f.key}: ${f.type}${f.count === undefined ? '' : ` (${f.count})`}`;

/** One labelled list, wrapped so a wide page still reads in a terminal. */
function wrapItems(prefix: string, items: readonly string[], indent: string): string[] {
  if (!items.length) return [`${prefix}(none)`];
  const lines: string[] = [];
  let line = prefix;
  let first = true;
  for (const item of items) {
    const piece = first ? item : ` · ${item}`;
    if (!first && line.length + piece.length > WIDTH) {
      lines.push(line);
      line = indent + item;
    } else {
      line += piece;
    }
    first = false;
  }
  lines.push(line);
  return lines;
}

/** The §3 layout, rendered server-side so the CLI and the console print the
 *  same text and the redaction test pins what an operator actually sees. */
export function renderShapeReport(r: ProviderShapeReport): string[] {
  const lines = [`${r.kind}  ${r.endpoint}`];
  lines.push(...wrapItems('  envelope: ', r.envelope.map(fieldText), '            '));
  if (r.scope === 'detail') {
    // One record, not a page: the question here is the wrapper and the byte
    // path inside it, so the header says which of those the tenant did.
    if (r.recordsKey === null) lines.push('  record: (this call returned no object at all - see ABSENT below)');
    else {
      lines.push(r.recordsKey === '(unwrapped)'
        ? '  record: (the one record this call returned, not wrapped)'
        : `  record: (the one record this call returned, wrapped in "${r.recordsKey}")`);
      lines.push(...wrapItems('    ', r.record.map(fieldText), '    '));
    }
  } else if (r.recordsKey === null) {
    lines.push('  record: (no record array found under any expected envelope key - see ABSENT below)');
  } else if (r.recordCount === 0) {
    lines.push(`  record: (the "${r.recordsKey}" array was empty on this page - nothing to describe)`);
  } else {
    lines.push(`  record: (${r.recordCount} under "${r.recordsKey}", keys unioned)`);
    lines.push(...wrapItems('    ', r.record.map(fieldText), '    '));
  }
  lines.push(...wrapItems('  MAPPED BY THIS DRIVER: ', r.mapped, '    '));
  lines.push(...wrapItems('  IN THE RESPONSE, NOT MAPPED: ', r.unmapped, '    '));
  lines.push(...wrapItems('  EXPECTED BY THIS DRIVER, ABSENT: ', r.absent, '    '));
  for (const n of r.notes) lines.push(...wrapItems('  note: ', [n], '    '));
  return lines;
}

/** What `--shape` says for every kind that carries no live-verify debt. */
export function noShapeLine(kind: string): string {
  return `${kind}: this driver carries no live-verify debt - its field names are not guesses, so it reports no structure.`;
}

/** What `--shape --remote-id` says for a kind whose bytes need no detail call
 *  (canto streams from a path built out of the list record, so there is no
 *  second response to describe). */
export function noDetailShapeLine(kind: string): string {
  return `${kind}: this driver makes no per-asset detail call, so there is no second response to describe - its byte path is built from the list record and is exercised in step 3.`;
}

// --- self-diagnosing failures (plans/33 §4) ---------------------------------

export interface LiveVerifyDiagnosis {
  kind: string;
  /** What broke, phrased to follow the kind: 'list response carried no record array'. */
  problem: string;
  /** The assumption behind it: 'the list envelope key'. */
  assumption: string;
  /** The key names (or paths) that were tried. */
  tried: readonly string[];
  /** The exported constant an operator edits to widen the guess. */
  constant: string;
}

/**
 * The message a wrong guess prints on the worst day: which assumption broke,
 * the command that shows the real structure, the constant to edit, and the
 * runbook page for this kind. The kind leads without punctuation so the
 * existing `<kind> <what> <status>` error voice of these drivers is unchanged.
 */
export function liveVerifyMessage(d: LiveVerifyDiagnosis): string {
  const tried = d.tried.length ? `; tried ${d.tried.join(', ')}` : '';
  return `${d.kind} ${d.problem} (live-verify: ${d.assumption}${tried}). `
    + `Run \`lw providers preview --kind ${d.kind} --shape\` to see what the tenant actually returned, `
    + `then fix ${d.constant} in server/src/catalog/providers/${d.kind}.ts. `
    + `See docs/providers/${d.kind}-live-verify.md.`;
}

export function liveVerifyError(d: LiveVerifyDiagnosis): Error {
  return new Error(liveVerifyMessage(d));
}

// --- tolerance: read every guessed key through its constant (plans/33 §5) ---

/** The first of `keys` this record carries with a value. Absent and null both
 *  count as missing, so a nulled optional degrades exactly like an absent one. */
export function firstKey(record: Record<string, unknown> | null | undefined, keys: readonly string[]): unknown {
  if (!record) return undefined;
  for (const k of keys) {
    const v = record[k];
    if (v !== undefined && v !== null) return v;
  }
  return undefined;
}

export function firstString(record: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  const v = firstKey(record, keys);
  return typeof v === 'string' && v !== '' ? v : undefined;
}

/** An id, which upstreams number as often as they string. Empty is missing. */
export function firstId(record: Record<string, unknown> | null | undefined, keys: readonly string[]): string | undefined {
  const v = firstKey(record, keys);
  if (typeof v === 'string') return v === '' ? undefined : v;
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  return undefined;
}

export function firstNumber(record: Record<string, unknown> | null | undefined, keys: readonly string[]): number | undefined {
  const v = firstKey(record, keys);
  return typeof v === 'number' && Number.isFinite(v) ? v : undefined;
}

export function firstBoolean(record: Record<string, unknown> | null | undefined, keys: readonly string[]): boolean | undefined {
  const v = firstKey(record, keys);
  return typeof v === 'boolean' ? v : undefined;
}

export function firstRecord(record: Record<string, unknown> | null | undefined, keys: readonly string[]): Record<string, unknown> | undefined {
  const v = firstKey(record, keys);
  return isRecord(v) ? v : undefined;
}

export function firstArray(record: Record<string, unknown> | null | undefined, keys: readonly string[]): unknown[] | undefined {
  const v = firstKey(record, keys);
  return Array.isArray(v) ? v : undefined;
}

/** EVERY key's strings, concatenated - the reader for fields that FOLD rather
 *  than fall back (Canto's tag + keyword, Image Relay's keywords + tags). A
 *  bare string counts as a one-element list, which is how these DAMs model a
 *  single folder. */
export function allStrings(record: Record<string, unknown> | null | undefined, keys: readonly string[]): string[] {
  if (!record) return [];
  const out: string[] = [];
  for (const k of keys) {
    const v = record[k];
    if (typeof v === 'string' && v !== '') out.push(v);
    else if (Array.isArray(v)) for (const e of v) if (typeof e === 'string' && e !== '') out.push(e);
  }
  return out;
}
