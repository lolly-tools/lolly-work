// SPDX-License-Identifier: MPL-2.0
/**
 * Per-caller catalog signing.
 *
 * A Lolly shell built with a pinned catalog key fetches `/catalog/tools/index.json`
 * and `/catalog/tools/index.sig.json` separately, checks that the envelope's
 * `indexHash` is the sha256 of the exact index bytes it received, and then checks
 * every tool file it loads against the envelope's `files` map. It fails closed on
 * any mismatch. This server filters and re-serialises the index per caller
 * (tool visibility follows groups), so a signature made at build time can never
 * match what a given caller receives. This module signs at request time instead.
 *
 * The rule that keeps the two responses consistent: both routes call
 * `servedToolIndexBytes()` for the same caller, and the envelope hashes the bytes
 * that function returned. There is no second serialisation to drift.
 *
 * The `files` digests follow the OSS signer (lolly `scripts/sign-catalog.ts`, its
 * plain `--tools <dir>` layout, which is the layout a materialised pack has): for
 * every directory under `<pack>/tools` holding a `tool.json`, the fixed signed
 * filenames that exist, then the `i18n/<lang>.json` sidecars and the
 * `templates/<tid>.json` starter templates, sha256 over the raw bytes. They are
 * computed once per pack root and memoised; a pack mounted on a serverless
 * function or a container is read-only for the life of the process.
 *
 * Each envelope carries only the digests of tools the caller may fetch (the same
 * predicate the `/tools/*` route applies), so a hidden tool's id never reaches a
 * caller through the signature either.
 *
 * The engine is reached through a non-literal dynamic import, as in
 * `render/contract.ts`, so the type checker never walks the vendored engine
 * source. The key material is never logged or echoed in an error message.
 */
import { createHash, createPrivateKey, webcrypto } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { filterToolIndex, toolVisibleTo, type ToolOverlay } from '../policy/overlay.ts';

/** Where the envelope is served, relative to the catalog root. */
export const CATALOG_SIG_REL = 'tools/index.sig.json';
/** The index the envelope binds, relative to the catalog root. */
export const CATALOG_INDEX_REL = 'tools/index.json';

/** Mirrors of the engine's per-tool sidecar patterns. The vendored engine keeps
 *  them out of its public barrel, so they are restated here; a test compares
 *  these literals with the vendored source so the two cannot drift silently. */
export const SIGNED_I18N_SIDECAR = /^i18n\/[a-z0-9-]+\.json$/;
export const SIGNED_TEMPLATE_FILE = /^templates\/[A-Za-z0-9._-]+\.json$/;

/** Who is asking: the overlays in force, the caller's groups, and the one tool a
 *  guest link opens (a guest may fetch that tool's files whatever its visibility). */
export interface CatalogCaller {
  overlays: Map<string, ToolOverlay>;
  groups: string[];
  guestToolId?: string;
}

/** The `/tools/*` visibility predicate: overlay visibility for the caller's
 *  groups, plus the one tool a guest link opens. */
export function callerCanSeeTool(caller: CatalogCaller, toolId: string): boolean {
  return toolId === caller.guestToolId || toolVisibleTo(caller.overlays.get(toolId), caller.groups);
}

export interface ServedToolIndex {
  /** The exact bytes the caller receives for tools/index.json. */
  bytes: Buffer;
  /** True when the index parsed and was re-serialised as JSON; false when the
   *  file was not the expected shape and is served as it is on disk. */
  json: boolean;
  /** The `/tools/*` visibility predicate for this caller. */
  visible: (toolId: string) => boolean;
}

/**
 * The ONE producer of a caller's tool index bytes. The index route serves these
 * bytes and the signature route hashes them, so the two always agree for the
 * same caller. Behaviour matches the unsigned route it replaced: parse, filter
 * `tools` by overlay visibility, serialise with `JSON.stringify`; anything that
 * does not parse into that shape is served raw. Null when the pack has no index.
 */
export async function servedToolIndexBytes(packDir: string, caller: CatalogCaller): Promise<ServedToolIndex | null> {
  let raw: Buffer;
  try {
    raw = await readFile(join(packDir, 'catalog', 'tools', 'index.json'));
  } catch {
    return null;
  }
  const visible = (toolId: string): boolean => callerCanSeeTool(caller, toolId);
  try {
    const index = JSON.parse(raw.toString('utf8')) as { tools?: Array<{ id: string }> };
    if (Array.isArray(index.tools)) index.tools = filterToolIndex(index.tools, caller.overlays, caller.groups);
    return { bytes: Buffer.from(JSON.stringify(index), 'utf8'), json: true, visible };
  } catch {
    return { bytes: raw, json: false, visible };
  }
}

// -- engine surface (narrow shim; see the header for why it is not imported) ----

interface UnsignedEnvelope {
  alg: string;
  keyId: string;
  signedAt: string;
  indexHash: string;
  files: Record<string, string>;
}
interface EngineIntegrity {
  CATALOG_SIG_ALG: string;
  CATALOG_SIGNED_TOOL_FILES: readonly string[];
  jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
  signCatalogEnvelope(unsigned: UnsignedEnvelope, key: webcrypto.CryptoKey): Promise<UnsignedEnvelope & { signature: string }>;
}
const ENGINE_SPECIFIER: string = '@lolly/engine';
let enginePromise: Promise<EngineIntegrity> | null = null;
function engine(): Promise<EngineIntegrity> {
  enginePromise ??= (import(ENGINE_SPECIFIER) as Promise<EngineIntegrity>).catch((err: unknown) => {
    enginePromise = null;
    throw err;
  });
  return enginePromise;
}

const sha256 = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}
async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/** '<toolId>/<file>' → sha256 hex for every signed file in a plain tools/ tree. */
export async function computeToolFileDigests(toolsDir: string, signedFiles: readonly string[]): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  let names: string[];
  try {
    names = await readdir(toolsDir);
  } catch {
    return files;
  }
  const ids: string[] = [];
  for (const name of names) {
    if ((await isDir(join(toolsDir, name))) && (await isFile(join(toolsDir, name, 'tool.json')))) ids.push(name);
  }
  ids.sort();
  for (const id of ids) {
    for (const filename of signedFiles) {
      const path = join(toolsDir, id, filename);
      if (await isFile(path)) files[`${id}/${filename}`] = sha256(await readFile(path));
    }
    for (const [sub, pattern] of [['i18n', SIGNED_I18N_SIDECAR], ['templates', SIGNED_TEMPLATE_FILE]] as const) {
      const dir = join(toolsDir, id, sub);
      if (!(await isDir(dir))) continue;
      for (const name of (await readdir(dir)).sort()) {
        if (!pattern.test(`${sub}/${name}`)) continue;
        const path = join(dir, name);
        if (await isFile(path)) files[`${id}/${sub}/${name}`] = sha256(await readFile(path));
      }
    }
  }
  return files;
}

const digestMemo = new Map<string, Promise<Record<string, string>>>();
/** Memoised per pack root: the pack's tool file digests, computed once. */
export function packToolFileDigests(packDir: string): Promise<Record<string, string>> {
  let hit = digestMemo.get(packDir);
  if (!hit) {
    hit = engine()
      .then((e) => computeToolFileDigests(join(packDir, 'tools'), e.CATALOG_SIGNED_TOOL_FILES))
      .catch((err: unknown) => {
        digestMemo.delete(packDir);
        throw err;
      });
    digestMemo.set(packDir, hit);
  }
  return hit;
}

const EC_P256 = { name: 'ECDSA', namedCurve: 'P-256' } as const;
const KEY_SHAPE = 'LW_CATALOG_SIGNING_KEY must be an ECDSA P-256 private key, as a PKCS#8 PEM (BEGIN PRIVATE KEY) or a private JWK JSON object';

/** Parse the signing key the way lolly's sign-catalog.ts accepts it: a private
 *  JWK JSON object or a PKCS#8 PEM. Errors never quote the material. */
export async function importCatalogSigningKey(material: string): Promise<{ privateKey: webcrypto.CryptoKey; publicJwk: webcrypto.JsonWebKey }> {
  const trimmed = material.trim();
  let jwk: webcrypto.JsonWebKey;
  try {
    if (trimmed.startsWith('{')) {
      jwk = JSON.parse(trimmed) as webcrypto.JsonWebKey;
    } else if (/^-----BEGIN PRIVATE KEY-----/.test(trimmed)) {
      jwk = createPrivateKey({ key: trimmed, format: 'pem' }).export({ format: 'jwk' }) as webcrypto.JsonWebKey;
    } else {
      throw new Error('unrecognised');
    }
  } catch {
    throw new Error(KEY_SHAPE);
  }
  if (!jwk || jwk.kty !== 'EC' || jwk.crv !== 'P-256' || !jwk.d || !jwk.x || !jwk.y) throw new Error(KEY_SHAPE);
  let privateKey: webcrypto.CryptoKey;
  try {
    privateKey = await webcrypto.subtle.importKey('jwk', { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y, d: jwk.d }, EC_P256, false, ['sign']);
  } catch {
    throw new Error(KEY_SHAPE);
  }
  return { privateKey, publicJwk: { kty: 'EC', crv: 'P-256', x: jwk.x, y: jwk.y } };
}

export interface CatalogSigning {
  /** Resolves with the RFC 7638 key id once the key is imported; rejects with a
   *  message that names the variable, never its value. */
  ready: Promise<{ keyId: string }>;
  /** The serialised envelope binding exactly `served.bytes` for this caller. */
  envelopeFor(packDir: string, served: ServedToolIndex): Promise<Buffer>;
}

const ENVELOPE_CACHE_MAX = 64;

/** Build the signer from the configured key material. The key is imported once;
 *  envelopes are cached by (index hash, visible file set), because ECDSA
 *  signatures are randomised and need not be recomputed per request. */
export function createCatalogSigning(material: string, now: () => Date = () => new Date()): CatalogSigning {
  const keyed = (async () => {
    const [e, key] = await Promise.all([engine(), importCatalogSigningKey(material)]);
    return { e, privateKey: key.privateKey, keyId: await e.jwkThumbprint(key.publicJwk) };
  })();
  const ready = keyed.then(({ keyId }) => ({ keyId }));
  // A bad key is reported by the route that needs it; never as an unhandled rejection.
  ready.catch(() => {});
  const cache = new Map<string, Buffer>();
  return {
    ready,
    async envelopeFor(packDir, served) {
      const { e, privateKey, keyId } = await keyed;
      const all = await packToolFileDigests(packDir);
      const files: Record<string, string> = {};
      for (const [path, digest] of Object.entries(all)) {
        if (served.visible(path.slice(0, path.indexOf('/')))) files[path] = digest;
      }
      const indexHash = sha256(served.bytes);
      const cacheKey = `${packDir}\u0000${indexHash}\u0000${Object.keys(files).join('\u0000')}`;
      const hit = cache.get(cacheKey);
      if (hit) return hit;
      const envelope = await e.signCatalogEnvelope(
        { alg: e.CATALOG_SIG_ALG, keyId, signedAt: now().toISOString(), indexHash, files }, privateKey,
      );
      const bytes = Buffer.from(JSON.stringify(envelope), 'utf8');
      if (cache.size >= ENVELOPE_CACHE_MAX) cache.delete(cache.keys().next().value as string);
      cache.set(cacheKey, bytes);
      return bytes;
    },
  };
}
