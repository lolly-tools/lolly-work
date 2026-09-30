import { sha256Hex } from '../lib/crypto.ts';

export const OUTPUT_PROFILE = 'work/output-v1' as const;
const MAX_BYTES = 32 * 1024 * 1024;
const MAX_SVG_BYTES = 2 * 1024 * 1024;
const MAX_PIXELS = 16_000_000;
const MIME: Record<string, string> = { svg: 'image/svg+xml', png: 'image/png', jpg: 'image/jpeg', pdf: 'application/pdf' };
const IDS = ['format', 'mime', 'readability', 'width', 'height'] as const;
type CheckId = typeof IDS[number];
type State = 'pass' | 'fail' | 'undetermined' | 'not-applicable';

export interface OutputTarget { format: string; widthPx: number | null; heightPx: number | null }
export interface OutputVerification { profile: 'output-v1'; widthPx?: number; heightPx?: number }

export function parseOutputVerification(value: unknown): OutputVerification | undefined {
  if (value === undefined) return undefined;
  if (value === 'output-v1') return { profile: 'output-v1' };
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('verification must name output-v1');
  const spec = value as Record<string, unknown>;
  if (spec.profile !== 'output-v1' || Object.keys(spec).some(key => !['profile', 'widthPx', 'heightPx'].includes(key))) throw new Error('unsupported verification profile or field');
  const out: OutputVerification = { profile: 'output-v1' };
  for (const key of ['widthPx', 'heightPx'] as const) {
    if (spec[key] === undefined) continue;
    if (typeof spec[key] !== 'number' || !Number.isFinite(spec[key]) || spec[key] <= 0 || spec[key] > 100_000) throw new Error(`${key} must be a positive number no greater than 100000`);
    out[key] = spec[key];
  }
  return out;
}

export function verificationTarget(target: OutputTarget, verification?: OutputVerification): OutputTarget {
  return { ...target, widthPx: verification?.widthPx ?? target.widthPx, heightPx: verification?.heightPx ?? target.heightPx };
}
export interface OutputInspection {
  profile: typeof OUTPUT_PROFILE;
  detector: 'work-output-inspector/1';
  outputSha256: string;
  target: OutputTarget;
  mime: string;
  measured: { format: string | null; widthPx: number | null; heightPx: number | null };
  method: 'xml-parser' | 'pixel-decoder' | 'signature-only' | 'none';
  checks: { id: CheckId; state: State; required: boolean; reason: string }[];
  limitations: string[];
}

interface PixelFacts { format: string; width: number; height: number; pages: number }
export interface InspectionCollectors {
  pixels(bytes: Uint8Array): Promise<PixelFacts>;
  svg(text: string): Promise<{ width: string | null; height: string | null }>;
}
export class InspectionGap extends Error {}

const defaults: InspectionCollectors = {
  async svg(text) {
    const specifier: string = 'jsdom';
    type XmlDom = { window: { document: { documentElement: {
      localName: string; namespaceURI: string | null; getAttribute(name: string): string | null;
    } }; close(): void } };
    let JSDOM: new (text: string, opts: { contentType: string }) => XmlDom;
    try { ({ JSDOM } = await import(specifier)); }
    catch { throw new InspectionGap('xml-parser-unavailable'); }
    const dom = new JSDOM(text, { contentType: 'image/svg+xml' });
    try {
      const root = dom.window.document.documentElement;
      if (root.localName !== 'svg' || root.namespaceURI !== 'http://www.w3.org/2000/svg') throw new Error('invalid-svg-root');
      return { width: root.getAttribute('width'), height: root.getAttribute('height') };
    } finally { dom.window.close(); }
  },
  async pixels(bytes) {
    let sharp: typeof import('sharp').default;
    try { sharp = (await import('sharp')).default; }
    catch { throw new InspectionGap('pixel-decoder-unavailable'); }
    const input = Buffer.from(bytes);
    const meta = await sharp(input, { limitInputPixels: false, failOn: 'warning' }).metadata();
    const width = meta.width, height = meta.height;
    if (!width || !height) throw new Error('missing-dimensions');
    if (width * height > MAX_PIXELS) throw new InspectionGap('pixel-budget-exceeded');
    if ((meta.pages ?? 1) > 1) throw new InspectionGap('multiple-frames-unsupported');
    // Metadata alone cannot establish that compressed pixel data is readable.
    try {
      await sharp(input, { limitInputPixels: MAX_PIXELS, failOn: 'warning' }).timeout({ seconds: 10 }).stats();
    } catch (error) {
      if (error instanceof Error && /timeout|timed out/i.test(error.message)) throw new InspectionGap('pixel-decode-time-budget-exceeded');
      throw error;
    }
    return { format: meta.format === 'jpeg' ? 'jpg' : meta.format ?? '', width, height, pages: meta.pages ?? 1 };
  },
};

function absolutePixels(value: string | null): number | null {
  if (!value) return null;
  const m = /^\s*(\d+(?:\.\d*)?|\.\d+)(?:e([+-]?\d+))?(px|in|cm|mm|pt|pc|q)?\s*$/i.exec(value);
  if (!m) return null;
  const scale: Record<string, number> = { px: 1, in: 96, cm: 96 / 2.54, mm: 96 / 25.4, pt: 96 / 72, pc: 16, q: 96 / 101.6 };
  const n = Number(m[1]) * 10 ** Number(m[2] ?? 0) * scale[(m[3] ?? 'px').toLowerCase()]!;
  return Number.isFinite(n) && n > 0 ? n : null;
}

function sameDimension(wanted: number, actual: number): boolean {
  return Number.isFinite(actual) && actual > 0
    && Math.abs(wanted - actual) <= Number.EPSILON * 8 * Math.max(wanted, actual);
}

function signature(bytes: Uint8Array): string | null {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (b.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'png';
  if (b[0] === 255 && b[1] === 216 && b[2] === 255) return 'jpg';
  if (b.subarray(0, 5).toString('ascii') === '%PDF-') return 'pdf';
  return null;
}

function animatedPng(bytes: Uint8Array): boolean {
  const b = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let offset = 8; offset + 12 <= b.length;) {
    const length = b.readUInt32BE(offset);
    if (b.toString('ascii', offset + 4, offset + 8) === 'acTL') return true;
    offset += length + 12;
  }
  return false;
}

/** Passive readback of final bytes. No document code or linked resource is executed. */
export async function inspectOutput(bytes: Uint8Array, mime: string, target: OutputTarget,
  collectors: InspectionCollectors = defaults): Promise<OutputInspection> {
  const requested = target.format.toLowerCase() === 'jpeg' ? 'jpg' : target.format.toLowerCase();
  const report: OutputInspection = {
    profile: OUTPUT_PROFILE, detector: 'work-output-inspector/1', outputSha256: sha256Hex(bytes),
    target: { ...target, format: requested }, mime,
    measured: { format: signature(bytes), widthPx: null, heightPx: null }, method: 'signature-only', checks: [],
    limitations: ['appearance-not-compared', 'protected-content-not-checked', 'resource-identity-not-checked', 'design-acceptance-not-evaluated'],
  };
  let readable: State = 'undetermined';
  let reason = 'unsupported-format';
  if (bytes.length > MAX_BYTES) reason = 'byte-budget-exceeded';
  else if (report.measured.format === 'pdf') reason = 'pdf-decoder-unavailable';
  else if (report.measured.format === 'png' || report.measured.format === 'jpg') {
    report.method = 'pixel-decoder';
    try {
      if (report.measured.format === 'png' && animatedPng(bytes)) throw new InspectionGap('multiple-frames-unsupported');
      const decoded = await collectors.pixels(bytes);
      if (!['png', 'jpg'].includes(decoded.format) || decoded.format !== report.measured.format
        || !Number.isSafeInteger(decoded.width) || decoded.width <= 0 || !Number.isSafeInteger(decoded.height) || decoded.height <= 0) throw new Error('invalid-decoder-facts');
      if (decoded.width * decoded.height > MAX_PIXELS) throw new InspectionGap('pixel-budget-exceeded');
      if (decoded.pages !== 1) throw new InspectionGap('multiple-frames-unsupported');
      report.measured.widthPx = decoded.width; report.measured.heightPx = decoded.height;
      readable = 'pass'; reason = 'pixels-decoded';
    } catch (error) {
      readable = error instanceof InspectionGap ? 'undetermined' : 'fail';
      reason = error instanceof InspectionGap ? error.message : 'pixel-decode-failed';
    }
  } else if (bytes.length <= MAX_SVG_BYTES) {
    report.method = 'xml-parser';
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (/<!DOCTYPE|<!ENTITY/i.test(text)) throw new InspectionGap('xml-declarations-unsupported');
      const svg = await collectors.svg(text);
      report.measured.format = 'svg';
      report.measured.widthPx = absolutePixels(svg.width); report.measured.heightPx = absolutePixels(svg.height);
      readable = 'pass'; reason = 'xml-parsed';
    } catch (error) {
      readable = error instanceof InspectionGap ? 'undetermined' : 'fail';
      reason = error instanceof InspectionGap ? error.message : 'svg-parse-failed';
    }
  } else { report.method = 'none'; reason = 'svg-byte-budget-exceeded'; }
  const add = (id: CheckId, state: State, required: boolean, explanation: string): void => {
    report.checks.push({ id, state, required, reason: explanation });
  };
  add('format', report.measured.format === null ? 'undetermined' : report.measured.format === requested ? 'pass' : 'fail', true, 'container-format');
  add('mime', MIME[requested] && mime.toLowerCase().split(';')[0]!.trim() === MIME[requested] ? 'pass' : 'fail', true, 'declared-content-type');
  add('readability', readable, true, reason);
  for (const [id, wanted, actual] of [['width', target.widthPx, report.measured.widthPx], ['height', target.heightPx, report.measured.heightPx]] as const) {
    const valid = wanted !== null && Number.isFinite(wanted) && wanted > 0;
    add(id, wanted === null ? 'not-applicable' : !valid ? 'fail' : actual === null ? 'undetermined'
      : sameDimension(wanted, actual) ? 'pass' : 'fail', wanted !== null,
    wanted === null ? 'dimension-not-requested' : actual === null ? 'dimension-unavailable' : 'absolute-output-dimension');
  }
  if (readable !== 'pass') report.limitations.push(reason);
  if (report.measured.format === 'svg') report.limitations.push('svg-visibility-and-linked-resources-not-checked');
  return report;
}

/** Reconstruct required coverage; never trust an aggregate success flag. */
export function outputVerificationProblems(report: OutputInspection | undefined, bytes: Uint8Array, mime: string, target: OutputTarget): string[] {
  if (!report || report.profile !== OUTPUT_PROFILE || report.detector !== 'work-output-inspector/1') return ['inspection-missing-or-unsupported'];
  const problems: string[] = [];
  if (report.outputSha256 !== sha256Hex(bytes)) problems.push('output-digest-mismatch');
  if (report.mime !== mime || report.target.format !== target.format || report.target.widthPx !== target.widthPx || report.target.heightPx !== target.heightPx) problems.push('inspection-target-mismatch');
  if (report.measured.format !== target.format || mime.toLowerCase().split(';')[0]!.trim() !== MIME[target.format]) problems.push('output-format-mismatch');
  if (report.method !== (target.format === 'svg' ? 'xml-parser' : 'pixel-decoder') || !['svg', 'png', 'jpg'].includes(target.format)) problems.push('decoder-not-supported');
  for (const key of ['widthPx', 'heightPx'] as const) {
    const wanted = target[key], actual = report.measured[key];
    if (wanted !== null && (!Number.isFinite(wanted) || wanted <= 0 || actual === null || !sameDimension(wanted, actual))) problems.push(`${key}-mismatch`);
  }
  if (!Array.isArray(report.checks) || report.checks.length !== IDS.length) return [...problems, 'check-coverage-incomplete'];
  for (const id of IDS) {
    const rows = report.checks.filter((check) => check.id === id);
    const required = id === 'width' ? target.widthPx !== null : id === 'height' ? target.heightPx !== null : true;
    if (rows.length !== 1 || rows[0]!.required !== required || rows[0]!.state !== (required ? 'pass' : 'not-applicable')) problems.push(`${id}-not-verified`);
  }
  return problems;
}

export class OutputVerificationError extends Error {
  readonly code = 'OUTPUT_VERIFICATION_FAILED';
  readonly status = 422;
  readonly inspection?: OutputInspection;
  constructor(problems: string[], inspection?: OutputInspection) {
    super(`Output verification did not complete: ${problems.join(', ')}.`);
    this.inspection = inspection;
  }
}
