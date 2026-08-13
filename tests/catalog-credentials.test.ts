/**
 * Content-credential DETECTION (plans/27 §4), unit level. `detectCredential` is
 * a thin wrapper over the vendored engine's `extractC2paStore` — so the fixtures
 * come from the engine too: mint a signing identity, embed a real C2PA manifest
 * into PNG bytes, and assert detection reports {embedded, png}; plain bytes and
 * garbage report {none} and never throw. `applyCredentialsToIndex` annotates the
 * feed additively.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { detectCredential, applyCredentialsToIndex, type CredentialRow } from '../server/src/catalog/credentials.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';

const engineSpec: string = '@lolly/engine';

/** A signed C2PA-carrying PNG, minted end-to-end through the engine. */
async function signedPng(): Promise<{ signed: Uint8Array; plain: Uint8Array }> {
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Cred Root', organization: 'Cred', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'cred@test.invalid', organization: 'Cred', days: 365 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'Cred Lolly');
  const { Resvg } = await import('@resvg/resvg-js');
  const plain = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#30ba78"/></svg>').render().asPng());
  const signed = await eng.embedC2pa(plain, 'png', { signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain }, title: 'x', claimGenerator: 'Cred Lolly' });
  return { signed, plain };
}

test('detectCredential finds an embedded manifest and names its container; never verifies', async () => {
  const { signed, plain } = await signedPng();
  const hit = await detectCredential(signed);
  assert.equal(hit.status, 'embedded');
  assert.equal(hit.container, 'png', 'container is the sniffed format, not a verdict');
  // The wrapper reports presence only — no valid/trusted/claim fields leak through.
  assert.deepEqual(Object.keys(hit).sort(), ['container', 'status']);

  assert.deepEqual(await detectCredential(plain), { status: 'none' }, 'a plain PNG carries nothing');
});

test('detectCredential never throws — unparseable bytes are honestly "none", not an error', async () => {
  assert.deepEqual(await detectCredential(new Uint8Array([1, 2, 3, 4, 5])), { status: 'none' });
  assert.deepEqual(await detectCredential(new Uint8Array(0)), { status: 'none' });
});

test('applyCredentialsToIndex annotates only embedded matches, additively, dropping nothing', () => {
  const index: AssetIndex = { assets: [{ id: 'a' }, { id: 'b' }, { id: 'c' }] };
  const rows: CredentialRow[] = [
    { assetId: 'a', status: 'embedded', container: 'png', sniffedAt: '2026-08-13T00:00:00.000Z' },
    { assetId: 'b', status: 'none', sniffedAt: '2026-08-13T00:00:00.000Z' },
  ];
  const out = applyCredentialsToIndex(index, rows);
  assert.equal((out.assets ?? []).length, 3, 'nothing dropped');
  assert.equal((out.assets ?? []).find((e) => e.id === 'a')?.credential, 'embedded');
  assert.equal((out.assets ?? []).find((e) => e.id === 'b')?.credential, undefined, "status:'none' adds no annotation");
  assert.equal((out.assets ?? []).find((e) => e.id === 'c')?.credential, undefined);

  // No embedded rows → same reference back (fast path).
  assert.equal(applyCredentialsToIndex(index, [{ assetId: 'z', status: 'none', sniffedAt: '2026-08-13T00:00:00.000Z' }]), index);
});
