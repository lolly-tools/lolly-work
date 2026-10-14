// SPDX-License-Identifier: MPL-2.0
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { safeFile } from '../api/file-delivery.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { publicStaticDeliveryClass } from '@lolly-tools/core/delivery-v1';
import { filteredToolManifestBytes, servedToolSidecar } from './tool-sidecars.ts';
import type { CatalogCaller, CatalogSigning } from './signing.ts';

const MAX_FILE_BYTES = 64 * 1024 * 1024, MAX_TOTAL_BYTES = 256 * 1024 * 1024;
export function catalogResourcePath(path: string): boolean {
  return path.length <= 1024 && /^\/(?:catalog\/(?:previews|og)|info\/shots)\//.test(path) && !/[%\\?#\p{White_Space}\p{Cc}]/u.test(path)
    && path.split('/').slice(1).every(segment => segment && segment !== '.' && segment !== '..');
}

/** Optional media proofs originate in a verified publisher envelope. */
export async function publisherResourceDigests(options: { pack: string; publicKey?: Record<string, unknown>; signing: CatalogSigning | null }): Promise<Record<string, string>> {
  try {
    const file = await safeFile(options.pack, 'catalog/tools/index.sig.json');
    const index = await safeFile(options.pack, 'catalog/tools/index.json');
    if (!file || file.size > 16 * 1024 * 1024 || !index || index.size > 32 * 1024 * 1024) return {};
    const envelope = JSON.parse((await readFile(file.path)).toString()) as { resources?: unknown; [key: string]: unknown };
    if (!envelope.resources || typeof envelope.resources !== 'object' || Array.isArray(envelope.resources)) return {};
    const entries = Object.entries(envelope.resources);
    if (entries.length > 100000 || entries.some(([path, hash]) => !catalogResourcePath(path) || typeof hash !== 'string' || !/^[0-9a-f]{64}$/.test(hash))) return {};
    const jwk = options.publicKey ?? await options.signing?.publicKey();
    if (!jwk) return {};
    const key = await webcrypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
    const module: string = '@lolly/engine';
    const engine = await import(module) as { verifyCatalogEnvelope(envelope: unknown, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean }> };
    if (!(await engine.verifyCatalogEnvelope(envelope, await readFile(index.path), key)).ok) return {};
    return Object.fromEntries(entries) as Record<string, string>;
  } catch { return {}; }
}

function resourceReferences(values: unknown[]): Set<string> {
  const paths = new Set<string>();
  let nodes = 0;
  const visit = (value: unknown, depth: number): void => {
    if (++nodes > 100000 || depth > 20 || paths.size >= 4096) return;
    if (typeof value === 'string' && catalogResourcePath(value)) paths.add(value);
    else if (Array.isArray(value)) for (const entry of value) { if (nodes >= 100000 || paths.size >= 4096) break; visit(entry, depth + 1); }
    else if (value && typeof value === 'object') for (const entry of Object.values(value)) { if (nodes >= 100000 || paths.size >= 4096) break; visit(entry, depth + 1); }
  };
  for (const value of values) visit(value, 0);
  return paths;
}

/** Filter only after the original bundle bytes verify; missing media stays optional. */
export async function scopedResourceDigests(options: {
  pack: string; shellDir?: string; shellDirectories?: readonly string[]; publisher: Record<string, string>; caller: CatalogCaller; visibleValues: unknown[]; visibleToolIds: ReadonlySet<string>;
}): Promise<Record<string, string>> {
  if (!Object.keys(options.publisher).length) return {};
  let total = 0;
  const approved = async (path: string): Promise<Buffer | null> => {
    const expected = options.publisher[path];
    if (!expected || !catalogResourcePath(path)) return null;
    const configured = options.shellDirectories ?? (options.shellDir ? [options.shellDir] : []);
    const shells = publicStaticDeliveryClass(path) === 'public-immutable' ? configured : configured.slice(0, 1);
    const roots = path.startsWith('/info/') ? shells : [options.pack, ...(path.startsWith('/catalog/og/') ? shells : [])];
    for (const root of roots) {
      if (!root) continue;
      const file = await safeFile(root, path.slice(1));
      if (!file || file.size > MAX_FILE_BYTES || total + file.size > MAX_TOTAL_BYTES) continue;
      const bytes = await readFile(file.path);
      total += bytes.length;
      if (bytes.length === file.size && sha256Hex(bytes) === expected) return bytes;
    }
    return null;
  };
  const resources: Record<string, string> = {};
  const bundlePath = '/catalog/previews/bundle.json';
  const originalBundle = await approved(bundlePath);
  let filteredBundle: unknown;
  if (originalBundle) {
    const bytes = filteredToolManifestBytes(originalBundle, options.caller, options.visibleToolIds);
    if (bytes) {
      filteredBundle = JSON.parse(bytes.toString());
      resources[bundlePath] = sha256Hex(bytes);
    }
  }
  const references = resourceReferences([...options.visibleValues, filteredBundle]);
  for (const path of references) {
    if (path === bundlePath) continue;
    if (path.startsWith('/catalog/')) {
      const decided = await servedToolSidecar(options.pack, path.slice('/catalog/'.length), options.caller);
      if (decided.kind !== 'pass') continue;
    }
    const bytes = await approved(path);
    if (bytes) resources[path] = options.publisher[path]!;
  }
  return resources;
}
