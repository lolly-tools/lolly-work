// SPDX-License-Identifier: MPL-2.0
/** Mounted release identity is immutable; user grants have a separate revision. */
import { createHash, webcrypto } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { readFile, readdir, lstat, realpath } from 'node:fs/promises';
import { join, resolve, relative } from 'node:path';
import { safeDirectory, safeFile } from '../api/file-delivery.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import type { CatalogPublication } from '../store/types.ts';
import { completeToolFileDigests, type CatalogSigning } from './signing.ts';
import enginePin from '../../../engine-pin.json' with { type: 'json' };

interface SourceEnvelope {
  seq?: number; indexHash: string; files: Record<string, string>;
  assetIndexHash?: string; slimHash?: string; [key: string]: unknown;
}
interface Verifier {
  verifyCatalogEnvelope(envelope: SourceEnvelope, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean }>;
}
const fail = () => Object.assign(new Error('Mounted catalog publication could not be verified'), { status: 503 });

/** Called once for an immutable mounted release, never for a mutable brand projection. */
export async function catalogPublication(options: {
  pack: string; generation?: number; publicKey?: Record<string, unknown>; signing: CatalogSigning | null;
  /** The delivery service's verified, immutable source map, shared with startup. */
  fileDigests?: () => Promise<Record<string, string>>;
}): Promise<CatalogPublication> {
  const root = await realpath(resolve(options.pack)), manifest: Record<string, string> = {};
  let count = 0;
  const visit = async (rel: string, depth = 0): Promise<void> => {
    if (depth > 32) throw fail();
    if (!await safeDirectory(root, rel)) return;
    for (const entry of (await readdir(join(root, rel), { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (/[\\\x00-\x1f]/.test(entry.name)) continue;
      if (++count > 100000) throw fail();
      const path = `${rel}/${entry.name}`;
      if (entry.isDirectory() || (entry.isSymbolicLink() && await safeDirectory(root, path))) await visit(path, depth + 1);
      else {
        const file = await safeFile(root, path);
        if (!file) continue;
        const hash = createHash('sha256');
        for await (const bytes of createReadStream(file.path)) hash.update(bytes);
        manifest[path] = hash.digest('hex');
      }
    }
  };
  for (const rel of ['catalog', 'tools', 'packs', 'brands']) {
    const entry = await lstat(join(root, rel)).catch(() => null);
    if (entry?.isSymbolicLink()) {
      const target = relative(root, await realpath(join(root, rel)));
      if (target.startsWith('..') || !await safeDirectory(root, rel)) throw fail();
      // Profile-selection aliases are mutable; their complete sources are covered below.
      if (/^(brands|packs)[/\\]/.test(target)) continue;
    }
    await visit(rel);
  }
  for (const rel of ['profiles.json', 'brands.json']) {
    const file = await safeFile(root, rel); if (file) manifest[rel] = sha256Hex(await readFile(file.path));
  }
  // Source and bundled hosts bind the same committed JSON value, without a path fallback.
  const digest = sha256Hex(canonicalJson({ files: manifest, enginePin: sha256Hex(canonicalJson(enginePin)) }));
  let generation = options.generation ?? 0;
  const envelopeFile = await safeFile(root, 'catalog/tools/index.sig.json');
  if (envelopeFile) {
    let envelope: SourceEnvelope;
    try { envelope = JSON.parse(await readFile(envelopeFile.path, 'utf8')) as SourceEnvelope; }
    catch { throw fail(); }
    if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw fail();
    if (Object.hasOwn(envelope, 'seq')) {
      if (!Number.isSafeInteger(envelope.seq) || envelope.seq! <= 0) throw fail();
      const jwk = options.publicKey ?? await options.signing?.publicKey();
      if (!jwk) throw fail();
      try {
        const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
        const module: string = '@lolly/engine', verifier = await import(module) as Verifier;
        const index = await readFile(join(root, 'catalog/tools/index.json'));
        if (!(await verifier.verifyCatalogEnvelope(envelope, index, key)).ok) throw fail();
        const files = await (options.fileDigests?.() ?? completeToolFileDigests(root));
        if (canonicalJson(envelope.files) !== canonicalJson(files)) throw fail();
        for (const [field, path] of [['assetIndexHash', 'catalog/assets/index.json'], ['slimHash', 'catalog/tools/index.slim.json']] as const) {
          if (envelope[field] !== undefined && envelope[field] !== sha256Hex(await readFile(join(root, path)))) throw fail();
        }
      } catch { throw fail(); }
      generation = Math.max(generation, envelope.seq!);
    }
  }
  return { generation, digest };
}
