/**
 * Publish-out gate (plans/27 §10) - the guard that keeps the outbound arm
 * narrow: ONLY lolly-rendered exports may be pushed to a destination DAM, never
 * a federated or pack asset. The distinguishing property is the C2PA export
 * assertion the render plane signs into every export (docs/c2pa.md): a federated
 * asset may carry *a* credential, but not lolly's export assertion. So the gate
 * VERIFIES (not merely detects) that the bytes carry it, via the engine's
 * verifier - this is an authorization decision about our own content, not a
 * display verdict, so verifying here is legitimate.
 */
import { readPngProvenance, type ProvenanceDoc } from '../render/provenance.ts';

const ENGINE_SPEC: string = '@lolly/engine';
async function loadEngine(): Promise<{ verifyC2pa: (bytes: Uint8Array, format: string) => Promise<{ found: boolean; state: string; madeWithLolly: boolean }> }> {
  return import(ENGINE_SPEC);
}

export interface PublishGate { ok: boolean; detail?: string }

/** Verify the export carries lolly's C2PA export assertion. Fails closed - a
 *  provider/engine hiccup refuses the publish rather than leaking. */
export async function verifyLollyExport(bytes: Uint8Array, format: string): Promise<PublishGate> {
  try {
    const { verifyC2pa } = await loadEngine();
    const rep = await verifyC2pa(bytes, format);
    if (!rep.found) return { ok: false, detail: 'the bytes carry no Content Credential — only signed lolly exports may be published out' };
    if (!rep.madeWithLolly) return { ok: false, detail: 'not a lolly export assertion — federated and third-party content cannot be published out' };
    return { ok: true };
  } catch (err) {
    return { ok: false, detail: `could not verify the export credential: ${(err as Error).message}` };
  }
}

/** Pull the export's embedded provenance doc (the ingredient chain) so the
 *  publish audit records where the exported media came from. */
export function extractProvenance(bytes: Uint8Array, format: string): ProvenanceDoc | null {
  if (format === 'png') return readPngProvenance(bytes);
  if (format === 'svg') {
    const m = /<metadata id="lolly-provenance"><!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/.exec(new TextDecoder().decode(bytes));
    if (m?.[1]) {
      try { return JSON.parse(m[1]) as ProvenanceDoc; } catch { return null; }
    }
  }
  return null;
}
