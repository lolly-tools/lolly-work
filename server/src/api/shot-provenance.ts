// SPDX-License-Identifier: MPL-2.0
/**
 * Read a documentation screenshot's OWN Content Credential, server-side, so the
 * credential line the console draws under each shot STATES what the file says
 * rather than what the deployment would like to claim. Mirrors the OSS docs'
 * shot-provenance.ts + shot-anatomy.ts, but here the console is a runtime
 * (air-gap, no-build) renderer with no way to decode C2PA itself — so the server
 * decodes and hands over the handful of descriptive facts worth one line.
 *
 * It reports only DESCRIPTIVE claims (who signed, when, what it is, how much
 * geometry) — never a pass/fail verdict. Verification is the reader's to do,
 * against the bytes they received, in the console's own #/verify view: the
 * deployment does not mark its own homework. A file whose credential will not
 * decode returns null and gets no line, rather than a line that says less than it
 * appears to.
 *
 * Cached by path+size+mtime: the docs view asks for the same handful of files
 * repeatedly, and the decode (a full C2PA parse) is not free.
 */
import { readFile, stat } from 'node:fs/promises';

export interface ShotCred {
  /** Who signed it: the leaf certificate's organisation, else its common name. */
  signer: string | null;
  /** When the credential was made, YYYY-MM-DD, from the capture recipe / created action. */
  day: string | null;
  /** The claim generator, e.g. "Lolly 1.61.0", when the manifest carries one. */
  generator: string | null;
  /** File kind for the pill, e.g. "vector SVG" | "PNG". */
  kind: string;
  /** Capture dimensions as the credential records them, e.g. "1060 × 1026 px". */
  dimensions: string | null;
  /** Set when the credential declares AI-generated or AI-composited content. */
  ai: 'generated' | 'composite' | null;
  /** What the file is made of — the "134 paths, 484 KB" claim, checkable against the bytes. */
  anatomy: { kind: 'vector' | 'raster'; paths: number; groups: number; elements: number; bytes: number };
}

// Non-literal specifier: keeps tsc from resolving the engine's browser-lib .ts
// source into this project's program (the render plane does the same). Runtime
// resolves the vendored engine normally.
const ENGINE_SPEC: string = '@lolly/engine';
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function loadEngine(): Promise<any> { return import(ENGINE_SPEC); }

const cache = new Map<string, ShotCred | null>();

const str = (v: unknown): string | null => (typeof v === 'string' && v.trim() ? v.trim() : null);

const EL_RE = /<[a-z][a-z0-9:-]*[\s/>]/gi;
const PATH_RE = /<path[\s/>]/gi;
const GROUP_RE = /<g[\s/>]/gi;
const METADATA_RE = /<metadata\b[\s\S]*?<\/metadata>/gi;

/** Count what the file is made of. C2PA lives in <metadata> (packaging, not
 *  drawing), so it is stripped before counting. */
function anatomy(bytes: Uint8Array, file: string): ShotCred['anatomy'] {
  const size = bytes.length;
  if (!file.toLowerCase().endsWith('.svg')) return { kind: 'raster', paths: 0, groups: 0, elements: 0, bytes: size };
  const art = new TextDecoder().decode(bytes).replace(METADATA_RE, '');
  return {
    kind: 'vector',
    paths: (art.match(PATH_RE) ?? []).length,
    groups: (art.match(GROUP_RE) ?? []).length,
    elements: (art.match(EL_RE) ?? []).length,
    bytes: size,
  };
}

/** The credential summary for one shot file, or null if it cannot be read. Never
 *  throws — a credential must not be the thing that breaks the docs view. */
export async function readShotCred(path: string, file: string): Promise<ShotCred | null> {
  let key: string;
  try {
    const st = await stat(path);
    key = `${path}:${st.size}:${st.mtimeMs}`;
  } catch {
    return null;
  }
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const out = await decode(path, file);
  cache.set(key, out);
  return out;
}

async function decode(path: string, file: string): Promise<ShotCred | null> {
  try {
    const bytes = new Uint8Array(await readFile(path));
    const engine = await loadEngine();
    // A full decode, but we surface only the descriptive claims below — the
    // verdict (valid/trusted) is the reader's to reach in #/verify.
    const report = await engine.verifyC2pa(bytes, { trustAnchors: [] });
    if (!report || report.state === 'none') return null;

    const signer = str(report.signer?.organization) ?? str(report.signer?.commonName);
    const env = report.environment ?? {};
    const claim = report.claim ?? {};
    const gi = claim.generatorInfo;
    const generator = gi?.name ? (gi.version ? `${gi.name} ${gi.version}` : gi.name) : str(claim.claimGenerator);
    const whenIso = str(env.date) ?? str(report.history?.[0]?.when) ?? null;
    const ext = (file.split('.').pop() ?? '').toUpperCase();
    const kind = ext === 'SVG' ? 'vector SVG' : ext;
    const ai = report.aiGenerated?.kind === 'generated' ? 'generated'
      : report.aiGenerated?.kind === 'composite' ? 'composite' : null;

    const cred: ShotCred = {
      signer,
      day: whenIso ? whenIso.slice(0, 10) : null,
      generator,
      kind,
      dimensions: str(env.dimensions),
      ai,
      anatomy: anatomy(bytes, file),
    };
    // Nothing worth a line — no signer, no date, no generator.
    if (!cred.signer && !cred.day && !cred.generator) return null;
    return cred;
  } catch {
    return null;
  }
}
