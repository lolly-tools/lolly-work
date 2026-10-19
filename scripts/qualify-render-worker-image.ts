// SPDX-License-Identifier: MPL-2.0
/** Local/CI image acceptance. Uses a fresh test key, never an instance credential. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, type webcrypto } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, existsSync, linkSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs';
import { brotliDecompressSync, gunzipSync } from 'node:zlib';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SIGNING_OUTPUT = 'brands/lolly-start/catalog/tools/index.sig.json';
const DOCS_OUTPUT = /^shells\/web\/public\/info\/docs\.[A-Za-z0-9_-]{16}\.(css|js)$/;
const PHASES = ['ARGUMENTS', 'PLATFORM', 'MATCHED_SOURCE', 'CLEAN_INPUT', 'LOCAL_DOCKER', 'CATALOG_INPUT',
  'SIGNED_BUILD', 'SOURCE_HEAD', 'TRACKED_SOURCE', 'GENERATED_DOCS', 'GENERATED_SIGNATURE', 'CONTAINER_CUSTODY',
  'IMAGE_TEST', 'CONTAINER_CLEANUP'] as const;
type Phase = typeof PHASES[number];
let phase: Phase = 'ARGUMENTS', trackedChangeCount = 0;
const sha256 = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');

/** Fixed metadata only: never format a caught build/tool error or its output. */
export function imageRefusal(value: string, count: number): { status: string; phase: string; trackedChangeCount: number } {
  return { status: 'WORKER_IMAGE_ACCEPTANCE_REFUSED', phase: PHASES.includes(value as Phase) ? value : 'UNKNOWN',
    trackedChangeCount: Number.isInteger(count) && count >= 0 && count <= 128 ? count : 0 };
}

function boundedFile(root: string, path: string, allowEmpty = false): Buffer {
  const absolute = resolve(root, path), canonicalRoot = realpathSync(root);
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size >= (allowEmpty ? 0 : 1) && stat.size <= 16 * 1024 * 1024);
  assert.ok(realpathSync(absolute).startsWith(`${canonicalRoot}/`));
  const bytes = readFileSync(absolute); assert.equal(bytes.length, stat.size);
  return bytes;
}

export function generatedChanges(raw: string): { status: 'M' | 'D'; path: string }[] {
  assert.ok(raw.length <= 65536);
  const parts = raw.split('\0'); assert.equal(parts.pop(), '');
  assert.equal(parts.length % 2, 0); assert.ok(parts.length <= 256);
  const result: { status: 'M' | 'D'; path: string }[] = [], seen = new Set<string>();
  for (let i = 0; i < parts.length; i += 2) {
    const status = parts[i], path = parts[i + 1];
    assert.ok(path && !seen.has(path)); seen.add(path);
    assert.ok((status === 'M' && path === SIGNING_OUTPUT) ||
      ((status === 'M' || status === 'D') && DOCS_OUTPUT.test(path)), 'Authored source mutation is not a build output');
    result.push({ status: status as 'M' | 'D', path });
  }
  return result;
}

/** docs/build.ts deletes stale hashed chrome and writes one CSS plus two JS files. */
export function verifyGeneratedDocs(root: string, changes: { status: 'M' | 'D'; path: string }[]): number {
  const prefix = 'shells/web/public/info/';
  const files = readdirSync(join(root, prefix)).filter(name => DOCS_OUTPUT.test(prefix + name)).sort();
  assert.equal(files.filter(name => name.endsWith('.css')).length, 1);
  assert.equal(files.filter(name => name.endsWith('.js')).length, 2);
  for (const name of files) {
    const bytes = boundedFile(root, prefix + name);
    const fingerprint = createHash('sha256').update(bytes).digest('base64url').slice(0, 16);
    assert.equal(name, `docs.${fingerprint}.${name.endsWith('.css') ? 'css' : 'js'}`);
    assert.deepEqual(boundedFile(root, `shells/web/dist/info/${name}`), bytes);
  }
  for (const change of changes) if (DOCS_OUTPUT.test(change.path)) {
    if (change.status === 'D') {
      assert.ok(!existsSync(join(root, change.path)));
      assert.ok(!existsSync(join(root, 'shells/web/dist/info', change.path.slice(prefix.length))));
    } else assert.ok(files.includes(change.path.slice(prefix.length)));
  }
  return files.length;
}

interface CatalogInput { index: Buffer; files: Record<string, string>; resources?: Record<string, string>; documentationResources?: Record<string, string>; assetIndex?: Buffer; slimIndex?: Buffer }
interface CatalogEnvelope { alg: string; keyId: string; indexHash: string; files: Record<string, string>; signature: string; signedAt: string;
  seq?: number; expiresAt?: string; assetIndexHash?: string; slimHash?: string; catalogScope?: string; toolDirs?: Record<string, string>; resources?: Record<string, string> }
interface CatalogIntegrity {
  CATALOG_SIGNED_TOOL_FILES: readonly string[];
  CATALOG_SIGNED_I18N_SIDECAR: RegExp;
  CATALOG_SIGNED_TEMPLATE_FILE: RegExp;
  importSpkiOrJwkPublicKey(value: string): Promise<webcrypto.CryptoKey>;
  verifyCatalogEnvelope(envelope: CatalogEnvelope, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean }>;
  jwkThumbprint(jwk: webcrypto.JsonWebKey): Promise<string>;
  toolDirectoryHash(files: Record<string, string>, id: string): Promise<string>;
}
async function catalogIntegrity(): Promise<CatalogIntegrity> {
  const module: string = pathToFileURL(join(ROOT, 'vendor/@lolly/engine/src/catalog-integrity.ts')).href;
  return await import(module) as CatalogIntegrity;
}
interface ContentResolver {
  contentRoots(opts: { root: string; profile: string }): unknown;
  toolDirs(roots: unknown): Map<string, unknown>;
  toolFile(id: string, file: string, roots: unknown): string | null;
  readToolManifestText(id: string, roots: unknown): string;
  listToolFiles(id: string, roots: unknown): string[];
  catalogFile(file: string, roots: unknown): string;
}

/** Derive public resource proofs from bounded physical bytes, independently of the signer. */
export function publicResourceDigests(root: string): Record<string, string> {
  const canonicalRoot = realpathSync(root), resources: Record<string, string> = Object.create(null);
  let entries = 0, files = 0;
  const walk = (directory: string, depth: number): void => {
    assert.ok(depth <= 32);
    if (!existsSync(directory)) return;
    const meta = lstatSync(directory);
    assert.ok(meta.isDirectory() && !meta.isSymbolicLink() && realpathSync(directory).startsWith(canonicalRoot + sep));
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 100000 && !entry.isSymbolicLink());
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      assert.ok(entry.isFile());
      if (!/\.(svg|png|webp|avif|jpe?g|gif|webm|mp4|json)$/i.test(entry.name)) continue;
      const logical = relative(canonicalRoot, path).split(sep).join('/');
      assert.ok(logical.length < 1024 && !/[\\%?#\p{White_Space}\p{Cc}]/u.test(logical) &&
        logical.split('/').every(part => part && part !== '.' && part !== '..') && ++files <= 20000);
      resources[`/${logical}`] = sha256(boundedFile(canonicalRoot, path, true));
    }
  };
  for (const prefix of ['catalog/previews', 'catalog/og', 'info/shots']) {
    let directory = canonicalRoot;
    for (const part of prefix.split('/')) {
      directory = join(directory, part);
      if (!existsSync(directory)) break;
      assert.ok(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink());
    }
    walk(join(canonicalRoot, prefix), 0);
  }
  return resources;
}

/** Capture the exact documentation-shot mirror inputs before any build runs. */
export function documentationResourceDigests(root: string): Record<string, string> {
  const resources: Record<string, string> = Object.create(null);
  let entries = 0, files = 0;
  // A Lolly source that carries the Work guides also mirrors their shots to /info/shots/work/.
  for (const suffix of ['', 'covers', 'work']) {
    const directory = join(root, 'docs/shots', suffix);
    if (!existsSync(directory)) continue;
    for (const parent of ['docs', 'docs/shots', ...(suffix ? [`docs/shots/${suffix}`] : [])]) {
      const meta = lstatSync(join(root, parent)); assert.ok(meta.isDirectory() && !meta.isSymbolicLink());
    }
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 100000 && !entry.isSymbolicLink());
      if (entry.isDirectory()) continue;
      assert.ok(entry.isFile());
      if (!(suffix ? /\.(png|svg|jpg|webp|webm|mp4)$/ : /\.(png|svg|jpg)$/).test(entry.name)) continue;
      const path = `/info/shots/${suffix ? `${suffix}/` : ''}${entry.name}`;
      assert.ok(path.length <= 1024 && !/[\\%?#\p{White_Space}\p{Cc}]/u.test(path) && ++files <= 20000);
      resources[path] = sha256(boundedFile(root, join(directory, entry.name), true));
    }
  }
  return resources;
}

export async function authoredCatalog(root: string): Promise<CatalogInput> {
  // Reuse the matched source's overlay resolver; do not flatten brand manifests ourselves.
  const resolver = await import(pathToFileURL(join(root, 'packages/node-shell/src/content-roots.ts')).href) as ContentResolver;
  const integrity = await catalogIntegrity();
  const roots = resolver.contentRoots({ root, profile: 'lolly-start' });
  assert.equal(resolver.catalogFile('tools/index.sig.json', roots), join(root, SIGNING_OUTPUT));
  const files: Record<string, string> = Object.create(null);
  for (const id of [...resolver.toolDirs(roots).keys()].sort()) {
    assert.match(id, /^[a-z0-9-]+$/);
    const names = new Set([...integrity.CATALOG_SIGNED_TOOL_FILES, ...resolver.listToolFiles(id, roots)
      .filter(name => !(name.startsWith('i18n/') && !integrity.CATALOG_SIGNED_I18N_SIDECAR.test(name)) &&
        !(name.startsWith('templates/') && !integrity.CATALOG_SIGNED_TEMPLATE_FILE.test(name)))]);
    for (const name of names) {
      assert.ok(name && !/[\\%?#\p{White_Space}\p{Cc}]/u.test(name) && name.split('/').every(part => part && part !== '.' && part !== '..'), 'Signed tool filenames must be safe');
      const path = resolver.toolFile(id, name, roots); if (!path) continue;
      const original = boundedFile(root, path, true);
      const bytes = name === 'tool.json' ? Buffer.from(resolver.readToolManifestText(id, roots)) : original;
      files[`${id}/${name}`] = sha256(bytes);
    }
  }
  assert.ok(Object.keys(files).length > 0 && Object.keys(files).length <= 100000);
  const assetPath = resolver.catalogFile('assets/index.json', roots), slimPath = resolver.catalogFile('tools/index.slim.json', roots);
  return { index: boundedFile(root, resolver.catalogFile('tools/index.json', roots)), files,
    resources: publicResourceDigests(resolve(dirname(resolver.catalogFile('tools/index.json', roots)), '../..')),
    documentationResources: documentationResourceDigests(root),
    ...(existsSync(assetPath) ? { assetIndex: boundedFile(root, assetPath) } : {}),
    ...(existsSync(slimPath) ? { slimIndex: boundedFile(root, slimPath) } : {}) };
}

export async function verifyGeneratedSignature(source: Uint8Array, dist: Uint8Array, expected: CatalogInput, publicMaterial: string): Promise<number> {
  assert.deepEqual(source, dist, 'The served envelope must be the source signing output');
  const envelope = JSON.parse(Buffer.from(source).toString('utf8')) as CatalogEnvelope;
  const allowed = new Set(['alg', 'files', 'resources', 'indexHash', 'keyId', 'signature', 'signedAt', 'seq', 'expiresAt', 'assetIndexHash', 'slimHash', 'catalogScope', 'toolDirs']);
  assert.ok(envelope && !Array.isArray(envelope) && Object.keys(envelope).every(name => allowed.has(name)), 'Unknown signed envelope fields are refused');
  const integrity = await catalogIntegrity();
  const publicKey = await integrity.importSpkiOrJwkPublicKey(publicMaterial);
  assert.equal((await integrity.verifyCatalogEnvelope(envelope, expected.index, publicKey)).ok, true);
  assert.deepEqual(Object.entries(envelope.files).sort(), Object.entries(expected.files).sort());
  if (envelope.resources !== undefined || expected.resources !== undefined) {
    assert.ok(envelope.resources && typeof envelope.resources === 'object' && !Array.isArray(envelope.resources));
    assert.ok(Object.keys(envelope.resources).length <= 20000 && Object.entries(envelope.resources).every(([path, digest]) =>
      /^\/(?:catalog\/(?:previews|og)|info\/shots)\//.test(path) && path.length <= 1024 &&
      !/[\\%?#\p{White_Space}\p{Cc}]/u.test(path) && path.slice(1).split('/').every(part => part && part !== '.' && part !== '..') && /^[a-f0-9]{64}$/.test(digest)));
    assert.deepEqual(Object.entries(envelope.resources).sort(), Object.entries(expected.resources ?? {}).sort());
  }
  assert.equal(envelope.indexHash, sha256(expected.index));
  for (const [field, bytes] of [['assetIndexHash', expected.assetIndex], ['slimHash', expected.slimIndex]] as const) {
    assert.equal(envelope[field], bytes ? sha256(bytes) : undefined, 'Every actual sibling index must be bound, without claiming absent bytes');
  }
  if (envelope.toolDirs !== undefined) {
    const ids = [...new Set(Object.keys(expected.files).map(path => path.split('/')[0]!))].sort();
    assert.deepEqual(Object.keys(envelope.toolDirs).sort(), ids);
    for (const id of ids) assert.equal(envelope.toolDirs[id], await integrity.toolDirectoryHash(expected.files, id));
  }
  return Object.keys(expected.files).length;
}

/** The final release has rewritten hash URLs; verify its actual bytes separately from authored inputs. */
export async function verifyGeneratedRelease(root: string, expected: CatalogInput, publicMaterial: string, sourceEnvelope: Uint8Array): Promise<number> {
  await verifyGeneratedSignature(sourceEnvelope, sourceEnvelope, expected, publicMaterial);
  const source = JSON.parse(Buffer.from(sourceEnvelope).toString('utf8')) as CatalogEnvelope;
  assert.ok(Number.isSafeInteger(source.seq) && source.seq === 1, 'A fresh qualification lineage must begin at sequence one');
  const dist = join(root, 'shells/web/dist');
  const files = await derivedToolFiles(root, dist, expected);
  const input: CatalogInput = { index: boundedFile(dist, 'catalog/tools/index.json'), files, resources: publicResourceDigests(dist),
    ...(existsSync(join(dist, 'catalog/assets/index.json')) ? { assetIndex: boundedFile(dist, 'catalog/assets/index.json') } : {}),
    ...(existsSync(join(dist, 'catalog/tools/index.slim.json')) ? { slimIndex: boundedFile(dist, 'catalog/tools/index.slim.json') } : {}) };
  const bytes = boundedFile(dist, 'catalog/tools/index.sig.json');
  const count = await verifyGeneratedSignature(bytes, bytes, input, publicMaterial);
  const envelope = JSON.parse(bytes.toString('utf8')) as CatalogEnvelope;
  assert.ok(Number.isSafeInteger(envelope.seq) && envelope.seq! > source.seq!, 'The materialized release must advance its verified source sequence');
  assert.ok(envelope.toolDirs, 'A modern materialized release requires the full tool directory map');
  const verifier = await import(pathToFileURL(join(root, 'scripts/verify-release-catalog.ts')).href) as {
    verifyReleaseCatalog(root: string, publicMaterial: string): Promise<{ verified: true; files: number }>;
  };
  const verified = await verifier.verifyReleaseCatalog(dist, publicMaterial);
  assert.equal(verified.verified, true); assert.equal(verified.files, count);
  return count;
}

/** Coding siblings are excluded only after their complete decoded identity is proved. */
function verifyToolCodings(root: string): void {
  let entries = 0;
  const walk = (directory: string, depth: number): void => {
    assert.ok(depth <= 32);
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      assert.ok(++entries <= 100000 && !entry.isSymbolicLink());
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { walk(path, depth + 1); continue; }
      assert.ok(entry.isFile());
      if (!/\.(gz|br)$/.test(entry.name)) continue;
      const identity = boundedFile(root, path.slice(0, -3), true), encoded = boundedFile(root, path);
      const decode = entry.name.endsWith('.gz') ? gunzipSync : brotliDecompressSync;
      const result = decode(encoded, { info: true, maxOutputLength: Math.max(1, identity.length + 1) }) as unknown as { buffer: Buffer; engine: { bytesWritten: number } };
      assert.equal(result.engine.bytesWritten, encoded.length, 'Coding must consume the entire encoded input');
      assert.deepEqual(result.buffer, identity, 'Coding must match the exact identity bytes');
    }
  };
  walk(join(root, 'tools'), 0);
}

/** Replay the committed materializer from the authored tools; arbitrary signed changes still refuse. */
async function derivedToolFiles(root: string, dist: string, expected: CatalogInput): Promise<Record<string, string>> {
  const materializer = await import(pathToFileURL(join(root, 'scripts/materialize-catalog-delivery.ts')).href) as {
    catalogToolFiles(root: string): Record<string, string>;
    materializeCatalogDelivery(root: string): Promise<unknown>;
  };
  verifyToolCodings(dist);
  const actual = materializer.catalogToolFiles(join(dist, 'tools'));
  for (const path of Object.keys(actual)) if (/\.(gz|br)$/.test(path)) delete actual[path];
  assert.deepEqual(Object.keys(actual).sort(), Object.keys(expected.files).sort(), 'The final release must retain the complete authored tool file set');
  const resolver = await import(pathToFileURL(join(root, 'packages/node-shell/src/content-roots.ts')).href) as ContentResolver;
  const roots = resolver.contentRoots({ root, profile: 'lolly-start' });
  const projected = realpathSync(mkdtempSync(join(tmpdir(), 'worker-catalog-derivation-'))); chmodSync(projected, 0o700);
  try {
    for (const [path, digest] of Object.entries(expected.files)) {
      const slash = path.indexOf('/'), id = path.slice(0, slash), name = path.slice(slash + 1);
      const original = resolver.toolFile(id, name, roots); assert.ok(original);
      const bytes = name === 'tool.json' ? Buffer.from(resolver.readToolManifestText(id, roots)) : boundedFile(root, original, true);
      assert.equal(sha256(bytes), digest, 'Authored tool input must remain unchanged through the build');
      const target = join(projected, 'tools', path); mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, bytes, { flag: 'wx' });
    }
    const releaseResources = publicResourceDigests(dist);
    for (const path of Object.keys(releaseResources)) {
      const authoredShot = expected.documentationResources?.[path] !== undefined;
      if (/\.[0-9a-f]{16}\.[a-z0-9]+$/i.test(path) && expected.resources?.[path] === undefined && !authoredShot) continue;
      const original = path.startsWith('/catalog/') ? resolver.catalogFile(path.slice('/catalog/'.length), roots)
        : join(root, 'docs/shots', path.slice('/info/shots/'.length));
      const bytes = boundedFile(root, original, true), digest = sha256(bytes);
      if (path.startsWith('/catalog/')) assert.equal(digest, expected.resources?.[path], 'Every original catalog resource must remain authored');
      else assert.equal(digest, expected.documentationResources?.[path], 'Every original documentation shot must match its pre-build input');
      if (path !== '/catalog/previews/bundle.json') assert.equal(digest, releaseResources[path], 'Original resource bytes must remain exact');
      const to = join(projected, path.slice(1)); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, bytes, { flag: 'wx' });
    }
    for (const path of Object.keys(expected.resources ?? {})) assert.ok(path in releaseResources, 'The release must retain every authored public resource');
    for (const path of Object.keys(expected.documentationResources ?? {})) assert.ok(path in releaseResources, 'The release must retain every captured documentation shot');
    const writeIndex = (path: string, bytes: Buffer): void => {
      const to = join(projected, path); mkdirSync(dirname(to), { recursive: true }); writeFileSync(to, bytes, { flag: 'wx' });
    };
    writeIndex('catalog/tools/index.json', expected.index);
    if (expected.slimIndex) writeIndex('catalog/tools/index.slim.json', expected.slimIndex);
    const assetPath = 'catalog/assets/index.json';
    if (existsSync(join(dist, assetPath))) {
      const bytes = boundedFile(dist, assetPath); writeIndex(assetPath, bytes);
      const index = JSON.parse(bytes.toString('utf8')) as { assets: Array<{ formats?: Array<{ url: string }>; locales?: Record<string, Array<{ url: string }>> }> };
      assert.ok(Array.isArray(index.assets));
      for (const asset of index.assets) for (const format of [...(asset.formats ?? []), ...Object.values(asset.locales ?? {}).flat()]) {
        if (!format.url.startsWith('/catalog/')) continue;
        assert.ok(!/[\\%?#\p{White_Space}\p{Cc}]/u.test(format.url) && format.url.slice(1).split('/').every(part => part && part !== '.' && part !== '..'));
        const from = resolve(dist, format.url.slice(1)), to = resolve(projected, format.url.slice(1));
        assert.ok(realpathSync(from).startsWith(dist + sep) && lstatSync(from).isFile() && !lstatSync(from).isSymbolicLink());
        mkdirSync(dirname(to), { recursive: true }); if (!existsSync(to)) linkSync(from, to);
      }
    }
    await materializer.materializeCatalogDelivery(projected);
    const derived = materializer.catalogToolFiles(join(projected, 'tools'));
    assert.deepEqual(Object.entries(actual).sort(), Object.entries(derived).sort(), 'Final tool bytes must be the exact maintained derivation');
    assert.deepEqual(boundedFile(dist, 'catalog/tools/index.json'), boundedFile(projected, 'catalog/tools/index.json'));
    if (expected.slimIndex) assert.deepEqual(boundedFile(dist, 'catalog/tools/index.slim.json'), boundedFile(projected, 'catalog/tools/index.slim.json'));
    assert.deepEqual(Object.entries(releaseResources).sort(), Object.entries(publicResourceDigests(projected)).sort(), 'Published resources must match the maintained materialization');
    return actual;
  } finally { rmSync(projected, { recursive: true }); }
}
export function imageArguments(args: string[]): { lollyRoot: string; image: string; sandboxProfile: 'runtime-default' | 'chromium' } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? '', value = args[i + 1];
    if (!['--lolly-root', '--image', '--sandbox-profile'].includes(name) || values.has(name) || !value || value.startsWith('--')) throw new Error('Invalid image qualification arguments');
    values.set(name, value);
  }
  const image = values.get('--image') ?? '';
  const lollyRoot = values.get('--lolly-root');
  if (!/^[a-z0-9][a-z0-9./:_@-]{0,255}$/.test(image) || !lollyRoot) throw new Error('A local image and matched Lolly checkout are required');
  const sandboxProfile = values.get('--sandbox-profile') ?? 'runtime-default';
  if (sandboxProfile !== 'runtime-default' && sandboxProfile !== 'chromium') throw new Error('Invalid sandbox qualification profile');
  return { lollyRoot: realpathSync(lollyRoot), image, sandboxProfile };
}

export function matchedShell(pin: unknown, source: string, engineVersion: string): string {
  const value = pin as { generatedFrom?: string; engine?: { version?: string } };
  assert.match(value?.generatedFrom ?? '', /^[a-f0-9]{40}$/);
  assert.equal(source, value.generatedFrom, 'Lolly checkout must match the vendored engine source');
  assert.equal(engineVersion, value.engine?.version, 'Lolly shell and Work engine must match');
  return source;
}

export function ownsContainer(inspect: unknown, id: string, imageId: string, label: string): boolean {
  const value = inspect as { Id?: string; Image?: string; Config?: { Labels?: Record<string, string> } };
  return /^[a-f0-9]{64}$/.test(id) && value?.Id === id && value.Image === imageId &&
    value.Config?.Labels?.['org.lolly.qualification'] === label;
}

function output(command: string, args: string[], cwd = ROOT): string {
  return execFileSync(command, args, { cwd, encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 }).trim();
}

interface QualificationSource { root: string; owned: string; originalRoot: string; source: string;
  originalEnvelopeSha256: string; receiptSha256: string; device: number; inode: number }

/** Borrow external packages, while every workspace package resolves to the owned checkout. */
function borrowDependencies(original: string, clone: string): string[] {
  const workspaces = ['', 'engine', ...['packages', 'shells'].flatMap(parent => existsSync(join(original, parent))
    ? readdirSync(join(original, parent), { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => `${parent}/${entry.name}`) : [])];
  const packages = new Map<string, string>();
  for (const workspace of workspaces) {
    const manifest = join(original, workspace, 'package.json');
    if (!existsSync(manifest)) continue;
    const name = (JSON.parse(readFileSync(manifest, 'utf8')) as { name?: string }).name;
    if (name) { assert.ok(!packages.has(name)); packages.set(name, workspace); }
  }
  const aliases: string[] = [];
  const project = (from: string, to: string, nesting: number): void => {
    const meta = lstatSync(from), name = from.slice(from.lastIndexOf(sep) + 1);
    if (meta.isDirectory() && nesting < 2 && (name.startsWith('@') || name === '.bin')) {
      mkdirSync(to);
      for (const entry of readdirSync(from).sort()) project(join(from, entry), join(to, entry), nesting + 1);
    } else if (meta.isFile()) {
      copyFileSync(from, to); chmodSync(to, meta.mode & 0o777);
    } else {
      assert.ok(meta.isDirectory() || meta.isSymbolicLink(), 'Unsupported dependency entry');
      const target = realpathSync(from), rel = relative(original, target);
      const workspace = rel && !rel.startsWith(`..${sep}`) && rel !== '..' && !rel.split(sep).includes('node_modules');
      const parts = from.split(sep), packageName = parts.at(-2)?.startsWith('@') ? parts.slice(-2).join('/') : name;
      const registered = packages.get(packageName);
      if (registered !== undefined) assert.equal(target, realpathSync(join(original, registered)), 'Workspace aliases must refer to the matched source');
      const selected = workspace ? join(clone, rel) : target;
      assert.ok(existsSync(selected), 'A borrowed workspace target must exist in the exact clone');
      symlinkSync(selected, to, 'dir');
      if (workspace) { assert.equal(realpathSync(to), realpathSync(selected)); aliases.push(relative(clone, to)); }
    }
  };
  for (const workspace of workspaces) {
    const from = join(original, workspace, 'node_modules');
    if (!existsSync(from)) continue;
    const to = join(clone, workspace, 'node_modules');
    assert.ok(!existsSync(to), 'The owned clone must not contain adopted dependencies');
    mkdirSync(to);
    for (const entry of readdirSync(from).sort()) project(join(from, entry), join(to, entry), 0);
  }
  return aliases.sort();
}

/** A new fixture identity starts only in an exclusive clone; the historical lineage is retained untouched. */
export async function prepareQualificationSource(originalRoot: string, source: string, publicMaterial: string): Promise<QualificationSource> {
  const original = realpathSync(originalRoot);
  assert.match(source, /^[a-f0-9]{40}$/);
  assert.equal(output('git', ['rev-parse', 'HEAD'], original), source);
  assert.equal(output('git', ['status', '--porcelain', '--untracked-files=no'], original), '');
  const historical = boundedFile(original, SIGNING_OUTPUT);
  assert.deepEqual(execFileSync('git', ['show', `${source}:${SIGNING_OUTPUT}`], { cwd: original, maxBuffer: 16 * 1024 * 1024 }), historical);
  const jwk = JSON.parse(publicMaterial) as webcrypto.JsonWebKey;
  assert.ok(jwk.kty === 'EC' && jwk.crv === 'P-256' && jwk.d === undefined);
  const integrity = await catalogIntegrity();
  await integrity.importSpkiOrJwkPublicKey(publicMaterial);
  const keyId = await integrity.jwkThumbprint(jwk);
  assert.notEqual((JSON.parse(historical.toString('utf8')) as { keyId?: string }).keyId, keyId, 'The fixture key must be a separate fresh identity');
  const owned = realpathSync(mkdtempSync(join(tmpdir(), 'lolly-worker-source-'))); chmodSync(owned, 0o700);
  const root = join(owned, 'lolly');
  const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([name]) => !name.startsWith('GIT_')));
  Object.assign(gitEnv, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' });
  execFileSync('git', ['-c', 'core.hooksPath=/dev/null', 'clone', '--shared', '--no-checkout', '--', original, root],
    { env: gitEnv, timeout: 60_000, maxBuffer: 1024 * 1024 });
  execFileSync('git', ['-C', root, '-c', 'core.hooksPath=/dev/null', 'checkout', '--detach', source],
    { env: gitEnv, timeout: 60_000, maxBuffer: 1024 * 1024 });
  assert.equal(output('git', ['rev-parse', 'HEAD'], root), source);
  assert.equal(output('git', ['status', '--porcelain', '--untracked-files=no'], root), '');
  assert.ok(lstatSync(join(root, '.git')).isDirectory() && !lstatSync(join(root, '.git')).isSymbolicLink());
  const aliases = borrowDependencies(original, root);
  assert.deepEqual(boundedFile(root, SIGNING_OUTPUT), historical);
  const originalEnvelopeSha256 = sha256(historical);
  writeFileSync(join(owned, 'historical-envelope.json'), historical, { flag: 'wx', mode: 0o600 });
  const receipt = Buffer.from(JSON.stringify({ version: 1, status: 'EXCLUSIVE_TEST_LINEAGE_INITIALIZED', source,
    fixtureProfile: 'lolly-start', fixtureKey: 'ephemeral-test-only', publicKeyId: keyId,
    historicalEnvelope: { path: 'historical-envelope.json', size: historical.length, sha256: originalEnvelopeSha256, trustedForNewLineage: false },
    copiedSignatureRemoved: SIGNING_OUTPUT, workspaceAliases: aliases, productionAcceptance: false }) + '\n');
  writeFileSync(join(owned, 'lineage-custody.json'), receipt, { flag: 'wx', mode: 0o600 });
  unlinkSync(join(root, SIGNING_OUTPUT));
  assert.equal(sha256(boundedFile(original, SIGNING_OUTPUT)), originalEnvelopeSha256);
  const meta = lstatSync(root);
  return { root, owned, originalRoot: original, source, originalEnvelopeSha256, receiptSha256: sha256(receipt), device: meta.dev, inode: meta.ino };
}

/** Drop only the owned working copy, keeping its bounded historical-signature custody. */
export function finishQualificationSource(fixture: QualificationSource): void {
  assert.equal(output('git', ['rev-parse', 'HEAD'], fixture.originalRoot), fixture.source);
  assert.equal(sha256(boundedFile(fixture.originalRoot, SIGNING_OUTPUT)), fixture.originalEnvelopeSha256);
  const meta = lstatSync(fixture.root);
  assert.ok(meta.isDirectory() && !meta.isSymbolicLink() && meta.dev === fixture.device && meta.ino === fixture.inode && realpathSync(fixture.root) === fixture.root);
  assert.equal(fixture.root, join(fixture.owned, 'lolly'));
  rmSync(fixture.root, { recursive: true });
}

export async function main(args = process.argv.slice(2)): Promise<void> {
  phase = 'ARGUMENTS'; trackedChangeCount = 0;
  const { lollyRoot, image, sandboxProfile } = imageArguments(args);
  phase = 'PLATFORM';
  assert.equal(process.platform, 'linux', 'Install frozen Work dependencies on the Linux qualification host');
  assert.ok(process.arch === 'x64' || process.arch === 'arm64', 'Image acceptance requires a supported Linux architecture');
  assert.equal(process.versions.node, '26.12.0', 'Use the worker Node version for this image acceptance');
  phase = 'MATCHED_SOURCE';
  const source = matchedShell(JSON.parse(readFileSync(join(ROOT, 'engine-pin.json'), 'utf8')),
    output('git', ['rev-parse', 'HEAD'], lollyRoot), JSON.parse(readFileSync(join(lollyRoot, 'engine/package.json'), 'utf8')).version);
  phase = 'CLEAN_INPUT';
  assert.equal(output('git', ['status', '--porcelain', '--untracked-files=no'], lollyRoot), '', 'Use a clean isolated Lolly checkout');
  assert.ok(lollyRoot !== ROOT && !lollyRoot.startsWith(`${ROOT}/vendor/`));
  phase = 'LOCAL_DOCKER';
  assert.ok(!process.env.DOCKER_HOST, 'Do not use an external Docker endpoint');
  const context = JSON.parse(output('docker', ['context', 'inspect']));
  assert.equal(context.length, 1);
  assert.match(context[0]?.Endpoints?.docker?.Host ?? '', /^unix:\/\//, 'Only a local Docker socket is allowed');
  const imageId = output('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  assert.equal(output('docker', ['image', 'inspect', imageId, '--format', '{{.Os}}/{{.Architecture}}']),
    `linux/${process.arch === 'x64' ? 'amd64' : 'arm64'}`, 'Qualify the image with the matching Linux architecture');
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateMaterial = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicMaterial = JSON.stringify(key.publicKey.export({ format: 'jwk' }));
  const fixture = await prepareQualificationSource(lollyRoot, source, publicMaterial);
  try { await qualifyOwnedFixture(fixture.root, imageId, source, privateMaterial, publicMaterial, sandboxProfile); }
  finally { finishQualificationSource(fixture); }
  console.log(JSON.stringify({ status: 'WORKER_FIXTURE_LINEAGE_CUSTODY', source,
    historicalEnvelopeSha256: fixture.originalEnvelopeSha256, receiptSha256: fixture.receiptSha256, originalCheckoutPreserved: true, productionAcceptance: false }));
}

async function qualifyOwnedFixture(lollyRoot: string, imageId: string, source: string, privateMaterial: string, publicMaterial: string, sandboxProfile: 'runtime-default' | 'chromium'): Promise<void> {
  phase = 'CATALOG_INPUT';
  const catalogInput = await authoredCatalog(lollyRoot);
  const buildEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PNPM_HOME']) if (process.env[name]) buildEnv[name] = process.env[name];
  Object.assign(buildEnv, { CI: 'true', LOLLY_PROFILE: 'lolly-start', VITE_REQUIRE_AI_POLICY: 'true',
    LOLLY_CATALOG_SIGNING_KEY: privateMaterial, VITE_CATALOG_PUBLIC_KEY_JWK: publicMaterial });
  phase = 'SIGNED_BUILD';
  const build = spawnSync('pnpm', ['run', 'build:web:release'], { cwd: lollyRoot, env: buildEnv, stdio: 'inherit', timeout: 20 * 60_000 });
  assert.ok(!build.error && build.status === 0, 'Matched signed shell build must succeed through the normal release gate');
  phase = 'SOURCE_HEAD';
  assert.equal(output('git', ['rev-parse', 'HEAD'], lollyRoot), source);
  phase = 'TRACKED_SOURCE';
  const changed = execFileSync('git', ['diff', '--name-status', '--no-renames', '-z', 'HEAD'],
    { cwd: lollyRoot, encoding: 'utf8', timeout: 15000, maxBuffer: 65536 });
  trackedChangeCount = changed.split('\0').filter(Boolean).length / 2;
  const generated = generatedChanges(changed);
  phase = 'GENERATED_DOCS';
  const docs = verifyGeneratedDocs(lollyRoot, generated);
  phase = 'GENERATED_SIGNATURE';
  const sourceEnvelope = boundedFile(lollyRoot, SIGNING_OUTPUT);
  await verifyGeneratedSignature(sourceEnvelope, sourceEnvelope, catalogInput, publicMaterial);
  const signedFiles = await verifyGeneratedRelease(lollyRoot, catalogInput, publicMaterial, sourceEnvelope);
  assert.deepEqual(boundedFile(lollyRoot, 'brands/lolly-start/catalog/tools/index.json'), catalogInput.index);
  console.log(JSON.stringify({ status: 'WORKER_FIXTURE_DERIVATIONS_VERIFIED', trackedChangeCount, docs, signedFiles }));
  phase = 'CONTAINER_CUSTODY';
  const owned = mkdtempSync(join(tmpdir(), 'lolly-worker-image-'));
  const cid = join(owned, 'container.cid'), label = randomUUID();
  const name = `lolly-worker-image-${label}`;
  writeFileSync(join(owned, 'custody.json'), JSON.stringify({ name, imageId, source, label }), { flag: 'wx', mode: 0o600 });
  let cleanupFailed = false;
  try {
    phase = 'IMAGE_TEST';
    const seccomp = join(ROOT, 'deploy/seccomp/chromium.json');
    if (sandboxProfile === 'chromium') assert.equal(sha256(boundedFile(ROOT, 'deploy/seccomp/chromium.json')),
      'c236f34373a302813102bb61295036ac1e4a109d8a0bf97f66cdb2b11e17dc98');
    const result = spawnSync('docker', ['run', '--rm', '--name', name,
      '--cidfile', cid, '--label', `org.lolly.qualification=${label}`, '--network', 'none',
      '--read-only', '--tmpfs', '/tmp:rw,size=1g,mode=1777', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
      ...(sandboxProfile === 'chromium' ? ['--security-opt', `seccomp=${seccomp}`] : []),
      '--mount', `type=bind,src=${ROOT},dst=/qualification/work,readonly`,
      '--mount', `type=bind,src=${join(lollyRoot, 'shells/web/dist')},dst=/qualification/shell,readonly`,
      '--env', 'LW_CATALOG_SIGNING_KEY', '--env', 'LOLLY_TEST_CATALOG_PUBLIC_KEY_JWK',
      '--env', 'LOLLY_TEST_SHELL_SOURCE', '--env', 'LOLLY_RENDER_IMAGE_TEST=1', '--env', 'LOLLY_RENDER_TLS_IMAGE_TEST=1', '--entrypoint', 'node', imageId,
      '--test', '--test-concurrency=1', '/qualification/work/tests/render-worker-image.test.ts', '/qualification/work/tests/render-worker-tls.image.test.ts'],
    { env: { ...process.env, LW_CATALOG_SIGNING_KEY: privateMaterial, LOLLY_TEST_CATALOG_PUBLIC_KEY_JWK: publicMaterial,
      LOLLY_TEST_SHELL_SOURCE: source }, stdio: 'inherit', timeout: 150_000 });
    assert.ok(!result.error && result.status === 0, 'Real image acceptance must exit successfully');
  } finally {
    const beforeCleanup = phase; phase = 'CONTAINER_CLEANUP';
    // A timed-out Docker client does not prove its container has stopped.
    let id = '';
    try { id = readFileSync(cid, 'utf8').trim(); } catch { /* no container was created */ }
    {
      const inspect = spawnSync('docker', ['container', 'inspect', name], { encoding: 'utf8', timeout: 15_000, maxBuffer: 1024 * 1024 });
      if (inspect.status === 0) {
        let value: unknown; try {
          value = JSON.parse(inspect.stdout)[0];
          if (!id) id = (value as { Id?: string })?.Id ?? '';
        } catch { /* refuse unknown ownership */ }
        if (ownsContainer(value, id, imageId, label)) {
          const removed = spawnSync('docker', ['container', 'rm', '--force', id], { stdio: 'ignore', timeout: 15_000 });
          cleanupFailed = !!removed.error || removed.status !== 0;
        } else cleanupFailed = true;
      } else if (!/No such (?:container|object)/i.test(inspect.stderr)) cleanupFailed = true;
    }
    if (!cleanupFailed) rmSync(owned, { recursive: true });
    assert.ok(!cleanupFailed, 'Owned container cleanup was not confirmed; retain its custody directory');
    phase = beforeCleanup;
  }
  console.log(JSON.stringify({ status: 'RENDER_WORKER_IMAGE_ACCEPTED', source, imageId,
    fixtureProfile: 'lolly-start', fixtureKey: 'ephemeral-test-only', browserSandboxQualified: true, architecture: process.arch, sandboxProfile,
    productionAcceptance: false, physicalGpuQualification: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch { console.error(JSON.stringify(imageRefusal(phase, trackedChangeCount))); process.exitCode = 1; }
}
