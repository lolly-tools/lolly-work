/**
 * Export provenance (plans/17): every server render that consumed catalog
 * assets carries a machine-readable ingredients list — C2PA-shaped so a real
 * C2PA signer can lift it into a signed manifest later, and honest today:
 * each ingredient's `c2pa` field is the upstream manifest IF the source
 * supplied one, and explicitly null when it didn't (Brandfolder ships none) —
 * "«filename» from «provider» was used" still travels with the export.
 *
 * Zero-dep embedding: SVG gets a <metadata> JSON island; PNG gets an iTXt
 * chunk (keyword "lolly:provenance") spliced after IHDR — both survive normal
 * copying and are readable by exiftool/`pngcheck`-class tooling.
 */

export interface ProvenanceIngredient {
  /** Human name of the asset ("Summit Logo"). */
  title: string;
  /** Catalog id — pack ('suse/logos/primary') or federated ('ext/dam1/a1'). */
  assetId: string;
  relationship: 'componentOf';
  source:
    | { kind: 'pack'; label: string }
    | { kind: 'provider'; provider: string; providerKind: string; label: string; remoteId: string; filename?: string };
  /** Upstream C2PA manifest reference when the source has one; null = the
   *  source provided no provenance of its own (we attribute regardless). */
  c2pa: { manifestUrl: string } | null;
}

export interface ProvenanceDoc {
  generator: string;
  ingredients: ProvenanceIngredient[];
}

/** Pull catalog-relative refs out of a rendered SVG + its baked param values.
 *  Anything the render referenced under /catalog/ is an ingredient candidate;
 *  query strings and fragments are shed, duplicates collapse. */
export function collectCatalogRefs(svg: string, params: Record<string, unknown>): string[] {
  const refs = new Set<string>();
  const scan = (text: string): void => {
    for (const m of text.matchAll(/\/catalog\/([A-Za-z0-9][A-Za-z0-9._/-]*)/g)) {
      const rel = (m[1] as string).replace(/[/.]+$/, '');
      if (rel && !rel.includes('..')) refs.add(rel);
    }
  };
  const walk = (v: unknown): void => {
    if (typeof v === 'string') scan(v);
    else if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === 'object') Object.values(v).forEach(walk);
  };
  scan(svg);
  walk(params);
  return [...refs];
}

export function provenanceDoc(ingredients: ProvenanceIngredient[]): ProvenanceDoc {
  return { generator: 'lolly-work', ingredients };
}

/** Insert the provenance JSON island right after the opening <svg …> tag. */
export function embedSvgProvenance(svg: string, doc: ProvenanceDoc): string {
  const open = /<svg\b[^>]*>/i.exec(svg);
  if (!open) return svg;
  const json = JSON.stringify(doc).replace(/]]>/g, ']]]]><![CDATA[>'); // CDATA-safe
  const island = `<metadata id="lolly-provenance"><![CDATA[${json}]]></metadata>`;
  const at = (open.index ?? 0) + open[0].length;
  return svg.slice(0, at) + island + svg.slice(at);
}

// ── PNG iTXt splice ─────────────────────────────────────────────────────────
const PNG_SIG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (const byte of buf) c = (CRC_TABLE[(c ^ byte) & 0xff] as number) ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export const PNG_PROVENANCE_KEYWORD = 'lolly:provenance';

/** Splice an uncompressed iTXt provenance chunk after IHDR. Non-PNG bytes are
 *  returned untouched (never corrupt an export over metadata). */
export function addPngProvenance(png: Uint8Array, doc: ProvenanceDoc): Uint8Array {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 16 || !buf.subarray(0, 8).equals(PNG_SIG)) return png;
  const ihdrLen = buf.readUInt32BE(8);
  const insertAt = 8 + 4 + 4 + ihdrLen + 4; // sig + len + 'IHDR' + data + crc
  if (buf.length < insertAt) return png;
  // iTXt: keyword \0 compressionFlag(0) compressionMethod(0) langTag \0 translatedKeyword \0 text(utf8)
  const data = Buffer.concat([
    Buffer.from(PNG_PROVENANCE_KEYWORD, 'latin1'), Buffer.from([0, 0, 0, 0, 0]),
    Buffer.from(JSON.stringify(doc), 'utf8'),
  ]);
  const chunk = Buffer.alloc(4 + 4 + data.length + 4);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write('iTXt', 4, 'latin1');
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([Buffer.from('iTXt', 'latin1'), data])), 8 + data.length);
  return Buffer.concat([buf.subarray(0, insertAt), chunk, buf.subarray(insertAt)]);
}

/** Read the provenance doc back out of a PNG (tests + tooling). */
export function readPngProvenance(png: Uint8Array): ProvenanceDoc | null {
  const buf = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  if (buf.length < 8 || !buf.subarray(0, 8).equals(PNG_SIG)) return null;
  let at = 8;
  while (at + 12 <= buf.length) {
    const len = buf.readUInt32BE(at);
    const type = buf.subarray(at + 4, at + 8).toString('latin1');
    if (type === 'iTXt') {
      const data = buf.subarray(at + 8, at + 8 + len);
      const nul = data.indexOf(0);
      if (nul >= 0 && data.subarray(0, nul).toString('latin1') === PNG_PROVENANCE_KEYWORD) {
        const text = data.subarray(nul + 5).toString('utf8'); // skip flags + empty lang/translated
        try { return JSON.parse(text.replace(/^\0*/, '')) as ProvenanceDoc; } catch { return null; }
      }
    }
    at += 12 + len;
  }
  return null;
}
