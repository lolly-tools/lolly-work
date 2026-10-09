// SPDX-License-Identifier: MPL-2.0
/** Local/CI image acceptance. Uses a fresh test key, never an instance credential. */
import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomUUID, type webcrypto } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
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

function boundedFile(root: string, path: string): Buffer {
  const absolute = resolve(root, path), canonicalRoot = realpathSync(root);
  const stat = lstatSync(absolute);
  assert.ok(stat.isFile() && !stat.isSymbolicLink() && stat.size > 0 && stat.size <= 16 * 1024 * 1024);
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

interface CatalogInput { index: Buffer; files: Record<string, string> }
interface CatalogEnvelope { alg: string; keyId: string; indexHash: string; files: Record<string, string>; signature: string; signedAt: string }
interface CatalogIntegrity {
  CATALOG_SIGNED_TOOL_FILES: readonly string[];
  CATALOG_SIGNED_I18N_SIDECAR: RegExp;
  CATALOG_SIGNED_TEMPLATE_FILE: RegExp;
  importSpkiOrJwkPublicKey(value: string): Promise<webcrypto.CryptoKey>;
  verifyCatalogEnvelope(envelope: CatalogEnvelope, bytes: Uint8Array, key: webcrypto.CryptoKey): Promise<{ ok: boolean }>;
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

async function authoredCatalog(root: string): Promise<CatalogInput> {
  // Reuse the matched source's overlay resolver; do not flatten brand manifests ourselves.
  const resolver = await import(pathToFileURL(join(root, 'packages/node-shell/src/content-roots.ts')).href) as ContentResolver;
  const integrity = await catalogIntegrity();
  const roots = resolver.contentRoots({ root, profile: 'lolly-start' });
  assert.equal(resolver.catalogFile('tools/index.sig.json', roots), join(root, SIGNING_OUTPUT));
  const files: Record<string, string> = {};
  for (const id of [...resolver.toolDirs(roots).keys()].sort()) {
    assert.match(id, /^[a-z0-9-]+$/);
    const names = new Set([...integrity.CATALOG_SIGNED_TOOL_FILES, ...resolver.listToolFiles(id, roots)
      .filter(name => integrity.CATALOG_SIGNED_I18N_SIDECAR.test(name) || integrity.CATALOG_SIGNED_TEMPLATE_FILE.test(name))]);
    for (const name of names) {
      const path = resolver.toolFile(id, name, roots); if (!path) continue;
      const original = boundedFile(root, path);
      const bytes = name === 'tool.json' ? Buffer.from(resolver.readToolManifestText(id, roots)) : original;
      files[`${id}/${name}`] = sha256(bytes);
    }
  }
  assert.ok(Object.keys(files).length > 0 && Object.keys(files).length <= 8192);
  return { index: boundedFile(root, resolver.catalogFile('tools/index.json', roots)), files };
}

export async function verifyGeneratedSignature(source: Uint8Array, dist: Uint8Array, expected: CatalogInput, publicMaterial: string): Promise<number> {
  assert.deepEqual(source, dist, 'The served envelope must be the source signing output');
  const envelope = JSON.parse(Buffer.from(source).toString('utf8')) as CatalogEnvelope;
  assert.deepEqual(Object.keys(envelope).sort(), ['alg', 'files', 'indexHash', 'keyId', 'signature', 'signedAt']);
  assert.deepEqual(Object.entries(envelope.files).sort(), Object.entries(expected.files).sort());
  assert.equal(envelope.indexHash, sha256(expected.index));
  const integrity = await catalogIntegrity();
  const publicKey = await integrity.importSpkiOrJwkPublicKey(publicMaterial);
  assert.equal((await integrity.verifyCatalogEnvelope(envelope, expected.index, publicKey)).ok, true);
  return Object.keys(expected.files).length;
}
export function imageArguments(args: string[]): { lollyRoot: string; image: string } {
  const values = new Map<string, string>();
  for (let i = 0; i < args.length; i += 2) {
    const name = args[i] ?? '', value = args[i + 1];
    if (!['--lolly-root', '--image'].includes(name) || values.has(name) || !value || value.startsWith('--')) throw new Error('Invalid image qualification arguments');
    values.set(name, value);
  }
  const image = values.get('--image') ?? '';
  const lollyRoot = values.get('--lolly-root');
  if (!/^[a-z0-9][a-z0-9./:_@-]{0,255}$/.test(image) || !lollyRoot) throw new Error('A local image and matched Lolly checkout are required');
  return { lollyRoot: realpathSync(lollyRoot), image };
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

export async function main(args = process.argv.slice(2)): Promise<void> {
  phase = 'ARGUMENTS'; trackedChangeCount = 0;
  const { lollyRoot, image } = imageArguments(args);
  phase = 'PLATFORM';
  assert.equal(process.platform, 'linux', 'Install frozen Work dependencies on the Linux qualification host');
  assert.equal(process.arch, 'x64', 'This image acceptance currently covers Linux amd64');
  assert.equal(process.versions.node, '24.21.0', 'Use the worker Node version for this image acceptance');
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
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateMaterial = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicMaterial = JSON.stringify(key.publicKey.export({ format: 'jwk' }));
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
  const signedFiles = await verifyGeneratedSignature(boundedFile(lollyRoot, SIGNING_OUTPUT),
    boundedFile(lollyRoot, 'shells/web/dist/catalog/tools/index.sig.json'), catalogInput, publicMaterial);
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
    const result = spawnSync('docker', ['run', '--rm', '--name', name,
      '--cidfile', cid, '--label', `org.lolly.qualification=${label}`, '--network', 'none',
      '--read-only', '--tmpfs', '/tmp:rw,size=1g,mode=1777', '--user', '1000:1000',
      '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '1g', '--cpus', '1', '--pids-limit', '256',
      '--mount', `type=bind,src=${ROOT},dst=/qualification/work,readonly`,
      '--mount', `type=bind,src=${join(lollyRoot, 'shells/web/dist')},dst=/qualification/shell,readonly`,
      '--env', 'LW_CATALOG_SIGNING_KEY', '--env', 'LOLLY_TEST_CATALOG_PUBLIC_KEY_JWK',
      '--env', 'LOLLY_TEST_SHELL_SOURCE', '--env', 'LOLLY_RENDER_IMAGE_TEST=1', '--entrypoint', 'node', imageId,
      '--test', '/qualification/work/tests/render-worker-image.test.ts'],
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
    fixtureProfile: 'lolly-start', fixtureKey: 'ephemeral-test-only', browserSandboxQualified: false,
    productionAcceptance: false, physicalGpuQualification: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { await main(); } catch { console.error(JSON.stringify(imageRefusal(phase, trackedChangeCount))); process.exitCode = 1; }
}
