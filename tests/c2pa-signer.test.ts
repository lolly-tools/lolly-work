/**
 * Instance C2PA signing (plans/17 §16). Proves the "easy for IT" chain works
 * end to end: mint an identity (root + leaf, as `lw c2pa init` does) → load it
 * with buildSigner → sign real bytes via the engine → the signature VERIFIES.
 * Plus resolveC2paSigner's fallback + fail-fast-on-misconfig behaviour.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { buildSigner, resolveC2paSigner } from '../server/src/render/c2pa-signer.ts';
import type { InstanceConfig, Secrets } from '../server/src/config/instance.ts';

const engineSpec: string = '@lolly/engine';

/** Mint a signing identity exactly like `lw c2pa init`: a root CA + an issued leaf. */
async function mintIdentity(org = 'Test Org'): Promise<{ certPem: string; keyPem: string }> {
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
  };
  const root = await eng.generateCaRoot({ commonName: `${org} Root`, organization: org, days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'lolly@test.invalid', organization: org, days: 365 });
  return {
    certPem: eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'),
    keyPem: eng.derToPem(keyDer, 'PRIVATE KEY'),
  };
}

test('buildSigner loads a minted identity and the engine signs a verifiable Content Credential', async () => {
  const { certPem, keyPem } = await mintIdentity('Acme');
  const signer = await buildSigner(certPem, keyPem, 'Acme Lolly');
  assert.equal(signer.chain.length, 2, 'leaf + root in the chain');
  assert.ok(signer.certDer.length > 0);

  const eng = await import(engineSpec) as {
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
    verifyC2pa: (b: Uint8Array, f: string) => Promise<{ found: boolean; state: string; madeWithLolly: boolean }>;
  };
  const { Resvg } = await import('@resvg/resvg-js');
  const png = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 60 60"><rect width="60" height="60" fill="#30ba78"/></svg>').render().asPng());
  const signed = await eng.embedC2pa(png, 'png', { signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain }, title: 'card', claimGenerator: 'Acme Lolly' });
  assert.ok(signed.length > png.length, 'a manifest was embedded');

  const report = await eng.verifyC2pa(signed, 'png');
  assert.equal(report.found, true);
  assert.equal(report.state, 'valid', 'the signature cryptographically verifies');
  assert.equal(report.madeWithLolly, true);
});

test('buildSigner rejects a non-PKCS#8 or certless PEM', async () => {
  const { certPem } = await mintIdentity();
  await assert.rejects(buildSigner(certPem, '-----BEGIN EC PRIVATE KEY-----\nAAAA\n-----END EC PRIVATE KEY-----'), /PKCS#8/);
  await assert.rejects(buildSigner('not a cert', '-----BEGIN PRIVATE KEY-----\nAA\n-----END PRIVATE KEY-----'), /no CERTIFICATE/);
});

const cfg = (certFile: string): InstanceConfig => ({ render: { c2pa: { certFile, claimGenerator: '' } } } as unknown as InstanceConfig);

test('resolveC2paSigner: neither set ⇒ null (unsigned default); one-of ⇒ fail-fast', async () => {
  assert.equal(await resolveC2paSigner(cfg(''), {} as Secrets), null);
  await assert.rejects(resolveC2paSigner(cfg(''), { c2paSigningKey: 'k' } as Secrets), /certFile is not/);
  await assert.rejects(resolveC2paSigner(cfg('/nope.pem'), {} as Secrets), /LW_C2PA_SIGNING_KEY is set|is not/);
  await assert.rejects(resolveC2paSigner(cfg('/does-not-exist.pem'), { c2paSigningKey: 'k' } as Secrets), /cannot read/);
});
