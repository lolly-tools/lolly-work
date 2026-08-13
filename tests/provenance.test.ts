/**
 * Export provenance (plans/17): catalog refs collected from rendered SVG +
 * baked params, the SVG metadata island, and the PNG iTXt chunk round-trip —
 * the "«filename» from «provider» was used" trail that ships inside exports,
 * with `c2pa: null` stating the upstream supplied no manifest of its own.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addPngProvenance, collectCatalogRefs, embedSvgProvenance, provenanceDoc, readPngProvenance,
  type ProvenanceIngredient,
} from '../server/src/render/provenance.ts';

const INGREDIENTS: ProvenanceIngredient[] = [
  {
    title: 'Summit Logo', assetId: 'ext/suse-bf/a1', relationship: 'componentOf',
    source: { kind: 'provider', provider: 'suse-bf', providerKind: 'brandfolder', label: 'SUSE Resource Library', remoteId: 'a1', filename: 'SUSE Summit Tokyo_pos-green.svg' },
    c2pa: null,
  },
  {
    title: 'primary', assetId: 'acme/logo/primary', relationship: 'componentOf',
    source: { kind: 'pack', label: 'Acme Hub' }, c2pa: null,
  },
  {
    // A federated asset whose bytes were detected to carry a credential the DAM
    // API never named (plans/27 §4): c2pa upgrades null → { kind: 'embedded' }.
    title: 'Detected Cred', assetId: 'ext/suse-bf/a2', relationship: 'componentOf',
    source: { kind: 'provider', provider: 'suse-bf', providerKind: 'brandfolder', label: 'SUSE Resource Library', remoteId: 'a2' },
    c2pa: { kind: 'embedded' },
  },
];

test('collectCatalogRefs: SVG hrefs + nested baked params, deduped, queries shed, traversal ignored', () => {
  const svg = `<svg><image href="/catalog/ext/suse-bf/a1/att1?x=1"/><image href="/catalog/assets/acme/logo/primary.svg"/></svg>`;
  const params = {
    logo: '/catalog/ext/suse-bf/a1/att1',
    nested: { list: ['/catalog/fonts/webfonts/x.woff2'] },
    evil: '/catalog/../../etc/passwd',
    plain: 'no refs here',
  };
  const refs = collectCatalogRefs(svg, params);
  assert.deepEqual(refs.sort(), [
    'assets/acme/logo/primary.svg', 'ext/suse-bf/a1/att1', 'fonts/webfonts/x.woff2',
  ]);
});

test('embedSvgProvenance: JSON island lands after the opening tag, CDATA-safe, parseable back out', () => {
  const doc = provenanceDoc(INGREDIENTS);
  const out = embedSvgProvenance('<svg xmlns="http://www.w3.org/2000/svg" width="10"><rect/></svg>', doc);
  assert.match(out, /^<svg[^>]*><metadata id="lolly-provenance"><!\[CDATA\[/);
  const m = /<!\[CDATA\[([\s\S]*?)\]\]><\/metadata>/.exec(out);
  const parsed = JSON.parse(m?.[1] ?? '');
  assert.equal(parsed.generator, 'lolly-work');
  assert.equal(parsed.ingredients[0].source.filename, 'SUSE Summit Tokyo_pos-green.svg');
  assert.equal(parsed.ingredients[0].c2pa, null, 'no upstream manifest is stated, not omitted');
  assert.deepEqual(parsed.ingredients[2].c2pa, { kind: 'embedded' }, 'a detected embedded credential travels with the export');
  // A non-SVG string is returned untouched.
  assert.equal(embedSvgProvenance('not svg', doc), 'not svg');
});

/** Minimal structurally-valid PNG: signature + IHDR + IEND. */
function tinyPng(): Uint8Array {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdrData = Buffer.alloc(13);
  ihdrData.writeUInt32BE(1, 0); ihdrData.writeUInt32BE(1, 4); ihdrData[8] = 8; ihdrData[9] = 6;
  const chunk = (type: string, data: Buffer): Buffer => {
    const out = Buffer.alloc(12 + data.length);
    out.writeUInt32BE(data.length, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    return out; // CRC left zero — the chunk walker doesn't verify, real decoders would
  };
  return Buffer.concat([sig, chunk('IHDR', ihdrData), chunk('IEND', Buffer.alloc(0))]);
}

test('PNG provenance: iTXt chunk splices after IHDR and reads back verbatim', () => {
  const doc = provenanceDoc(INGREDIENTS);
  const png = addPngProvenance(tinyPng(), doc);
  assert.ok(png.length > tinyPng().length);
  const back = readPngProvenance(png);
  assert.deepEqual(back, doc);
  // Chunk order: IHDR first, then our iTXt.
  assert.equal(Buffer.from(png).subarray(8 + 4, 8 + 8).toString('latin1'), 'IHDR');
  assert.equal(Buffer.from(png).subarray(33 + 4, 33 + 8).toString('latin1'), 'iTXt');
});

test('non-PNG bytes pass through addPngProvenance untouched', () => {
  const notPng = new TextEncoder().encode('<svg/>');
  assert.deepEqual(addPngProvenance(notPng, provenanceDoc(INGREDIENTS)), notPng);
  assert.equal(readPngProvenance(notPng), null);
});
