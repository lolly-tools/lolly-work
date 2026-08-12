/**
 * The instance C2PA signing identity (plans/17 §16). When an org configures a
 * signing certificate + key, server-side exports carry a REAL, cryptographically
 * signed C2PA Content Credential instead of the unsigned provenance island —
 * verifiable and tamper-evident. Absent ⇒ exports keep today's unsigned
 * provenance (nothing breaks; signing is purely additive).
 *
 * Making it easy for IT is the whole point:
 *   - `lw c2pa init` mints a self-contained signing identity in one command
 *     (root + leaf), so signing works with zero corporate PKI; OR
 *   - IT drops in a cert chain + key issued by their own CA for a trusted
 *     signature that chains to a root their verifiers already trust.
 * Either way the wiring is identical: a cert-chain PEM (public, config) + a
 * PKCS#8 private-key PEM (secret, LW_C2PA_SIGNING_KEY).
 *
 * Zero-dep: PEM is parsed here; the key is imported via node's WebCrypto; the
 * actual manifest signing is delegated to the engine's embedC2pa at render time.
 */
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import type { InstanceConfig, Secrets } from '../config/instance.ts';

const { subtle } = webcrypto;
type CryptoKeyType = Awaited<ReturnType<typeof subtle.importKey>>;

/** A resolved signer the render pipeline hands to engine.embedC2pa. Shape matches
 *  the engine's Signer: an ECDSA P-256 private key + the leaf cert DER + chain. */
export interface LoadedSigner {
  privateKey: CryptoKeyType;
  certDer: Uint8Array;
  chain: Uint8Array[];
  claimGenerator?: string;
}

/** Split a PEM bundle into its DER blocks, keyed by label (CERTIFICATE / PRIVATE KEY). */
function pemBlocks(pem: string): Array<{ label: string; der: Uint8Array }> {
  const out: Array<{ label: string; der: Uint8Array }> = [];
  const re = /-----BEGIN ([^-]+)-----([\s\S]*?)-----END \1-----/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(pem))) {
    out.push({ label: m[1]!.trim(), der: new Uint8Array(Buffer.from(m[2]!.replace(/\s+/g, ''), 'base64')) });
  }
  return out;
}

/** Build a signer from a cert-chain PEM (leaf first) + a PKCS#8 private-key PEM. */
export async function buildSigner(certPem: string, keyPem: string, claimGenerator?: string): Promise<LoadedSigner> {
  const certs = pemBlocks(certPem).filter((b) => /CERTIFICATE/.test(b.label)).map((b) => b.der);
  if (!certs.length) throw new Error('c2pa: certificate PEM contains no CERTIFICATE block');
  const keyBlock = pemBlocks(keyPem).find((b) => b.label === 'PRIVATE KEY');
  if (!keyBlock) throw new Error('c2pa: key PEM contains no PKCS#8 "PRIVATE KEY" block (must be PKCS#8, ECDSA P-256)');
  let privateKey: CryptoKeyType;
  try {
    privateKey = await subtle.importKey('pkcs8', keyBlock.der, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  } catch (e) {
    throw new Error(`c2pa: signing key is not an importable ECDSA P-256 PKCS#8 key: ${(e as Error).message}`);
  }
  return { privateKey, certDer: certs[0]!, chain: certs, ...(claimGenerator ? { claimGenerator } : {}) };
}

/**
 * Resolve the configured instance signer, or null when unconfigured. A cert file
 * set WITHOUT a key (or vice-versa) is a misconfiguration and throws (fail-fast at
 * boot) rather than silently shipping unsigned exports the operator expected to be
 * signed. Neither set ⇒ null ⇒ unsigned provenance (the default).
 */
export async function resolveC2paSigner(config: InstanceConfig, secrets: Secrets): Promise<LoadedSigner | null> {
  const certFile = config.render.c2pa.certFile;
  const keyPem = secrets.c2paSigningKey;
  if (!certFile && !keyPem) return null;
  if (!certFile) throw new Error('c2pa: LW_C2PA_SIGNING_KEY is set but render.c2pa.certFile is not — set both or neither');
  if (!keyPem) throw new Error('c2pa: render.c2pa.certFile is set but LW_C2PA_SIGNING_KEY is not — set both or neither (see `lw c2pa init`)');
  let certPem: string;
  try {
    certPem = await readFile(certFile, 'utf8');
  } catch (e) {
    throw new Error(`c2pa: cannot read render.c2pa.certFile (${certFile}): ${(e as Error).message}`);
  }
  return buildSigner(certPem, keyPem, config.render.c2pa.claimGenerator || undefined);
}
