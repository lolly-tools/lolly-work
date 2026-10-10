#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/** Public static UI preparation only. Existing public content is never replaced by a private pack. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyApplicationRelease } from './classify-application-release.ts';
import { shellUpdateDelta } from './prepare-shell-update.ts';
import { retainShellAssets } from './retain-shell-assets.ts';
import { canonicalDirectory, cloneShellFiles, readShellJson, requireDisk, requireShell, sha256,
  shellFileHash, shellId, shellManifest, writeShellJson } from './shell-update-files.ts';
import type { ShellManifest } from './shell-update-files.ts';

type Ref = { path: string; sha256: string };
export type PublicShellOptions = { source: string; base: string; candidate: string; previousShell: string; publicKey: string; out: string; custody: string; custodySha256: string };
const HASH = /^[a-f0-9]{64}$/, COMMIT = /^[a-f0-9]{40}$/;
export const PUBLIC_SETTINGS = { catalogTrustMode: 'verified', requireAiPolicy: false, liveRelay: 'https://lolly.tools/live', siteUrl: 'https://lolly.tools' } as const;
export const PUBLIC_OVERLAY_FILES = ['index.html', 'precache.json', 'sw.js', 'portable/player.js'] as const;
export const PUBLIC_STATUS = 'LOCAL_PUBLIC_SHELL_UPDATE_PREPARED_UNQUALIFIED';
const SOURCE_FILES = ['prepare-public-shell-update.ts', 'prepare-shell-update.ts', 'classify-application-release.ts', 'retain-shell-assets.ts', 'shell-update-files.ts', 'shell-update-clone.py', 'shell-update-vite.mjs'];
type Catalog = { indexSha256: string; envelopeSha256: string; pinCanonicalSha256: string; keyId: string; signedFiles: number };
type Custody = { version: 1; artifactClass: 'public-shell-overlay'; imageSource: string; previousShellSource: string; image: string; profile: 'lolly-start';
  settings: typeof PUBLIC_SETTINGS; previousManifest: Ref; previousAcceptance: Ref; ci: Ref; publicKeySha256: string; publicCatalog: Catalog };
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireShell(value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), 'Unknown or missing public custody field.');
}
function reference(value: unknown): Ref {
  exact(value, ['path', 'sha256']); requireShell(typeof value.path === 'string' && typeof value.sha256 === 'string' && HASH.test(value.sha256), 'Invalid public custody reference.');
  readShellJson(value.path, value.sha256); return value as Ref;
}
function same(left: ShellManifest, right: ShellManifest): boolean {
  return left.version === right.version && left.totalBytes === right.totalBytes && left.files.length === right.files.length
    && left.files.every((file, index) => { const other = right.files[index]; return other?.path === file.path && other.size === file.size && other.sha256 === file.sha256; });
}
function custody(options: PublicShellOptions): Custody {
  const value = readShellJson(options.custody, options.custodySha256);
  exact(value, ['version', 'artifactClass', 'imageSource', 'previousShellSource', 'image', 'profile', 'settings', 'previousManifest', 'previousAcceptance', 'ci', 'publicKeySha256', 'publicCatalog']);
  requireShell(value.version === 1 && value.artifactClass === 'public-shell-overlay' && value.profile === 'lolly-start'
    && typeof value.imageSource === 'string' && COMMIT.test(value.imageSource) && value.previousShellSource === options.base && COMMIT.test(options.base)
    && typeof value.image === 'string' && /^[a-z0-9][a-z0-9./:_-]+@sha256:[a-f0-9]{64}$/.test(value.image)
    && typeof value.publicKeySha256 === 'string' && HASH.test(value.publicKeySha256), 'Explicit accepted public image/profile/source custody required.');
  exact(value.settings, Object.keys(PUBLIC_SETTINGS));
  for (const [key, expected] of Object.entries(PUBLIC_SETTINGS)) requireShell(value.settings[key] === expected, 'Accepted public signature, AI, relay or site policy changed.');
  exact(value.publicCatalog, ['indexSha256', 'envelopeSha256', 'pinCanonicalSha256', 'keyId', 'signedFiles']);
  const publicCatalog = value.publicCatalog;
  requireShell(['indexSha256', 'envelopeSha256', 'pinCanonicalSha256'].every(key => typeof publicCatalog[key] === 'string' && HASH.test(publicCatalog[key] as string))
    && typeof value.publicCatalog.keyId === 'string' && /^[A-Za-z0-9_-]{43}$/.test(value.publicCatalog.keyId)
    && Number.isSafeInteger(value.publicCatalog.signedFiles) && (value.publicCatalog.signedFiles as number) > 0, 'Complete accepted public catalog custody required.');
  for (const key of ['previousManifest', 'previousAcceptance', 'ci']) reference(value[key]);
  const accepted = readShellJson((value.previousAcceptance as Ref).path, (value.previousAcceptance as Ref).sha256);
  requireShell(accepted && typeof accepted === 'object' && 'status' in accepted
    && ['READ_ONLY_PUBLIC647_PROMOTION_ACCEPTANCE_PASSED', 'PUBLIC_SHELL_RUNTIME_AND_HTTPS_ACCEPTED'].includes(accepted.status as string), 'Only an original public acceptance can supply the public baseline.');
  return value as unknown as Custody;
}
function previousManifest(options: PublicShellOptions, input: Custody): ShellManifest {
  const value = readShellJson(input.previousManifest.path, input.previousManifest.sha256);
  exact(value, ['version', 'files', 'totalBytes']);
  requireShell(value.version === 1 && Array.isArray(value.files) && Number.isSafeInteger(value.totalBytes) && (value.totalBytes as number) >= 0, 'Complete public static manifest required.');
  for (const row of value.files) {
    exact(row, ['path', 'size', 'sha256']); requireShell(typeof row.path === 'string' && Number.isSafeInteger(row.size) && (row.size as number) >= 0
      && typeof row.sha256 === 'string' && HASH.test(row.sha256), 'Exact public static entry required.');
  }
  const actual = shellManifest(options.previousShell);
  requireShell(same(actual, value as unknown as ShellManifest), 'Previous public static bytes differ from reviewed manifest.');
  requireShell(actual.files.every(row => !row.path.startsWith('models/') && row.path !== 'models'), 'Model storage must not enter the public shell snapshot.');
  requireShell(actual.files.some(row => row.path.startsWith('_app/')) && PUBLIC_OVERLAY_FILES.every(path => actual.files.some(row => row.path === path)), 'All five public overlay paths must already exist.');
  return actual;
}
function catalog(root: string, input: Custody, pin: unknown): void {
  exact(pin, ['kty', 'crv', 'x', 'y']);
  requireShell(pin.kty === 'EC' && pin.crv === 'P-256' && ['x', 'y'].every(key => typeof pin[key] === 'string' && /^[A-Za-z0-9_-]{43}$/.test(pin[key] as string)), 'Only the existing public P-256 verification pin is accepted.');
  const canonicalPin = JSON.stringify({ crv: pin.crv, kty: pin.kty, x: pin.x, y: pin.y });
  requireShell(sha256(canonicalPin) === input.publicCatalog.pinCanonicalSha256, 'Accepted public verification pin changed.');
  requireShell(shellFileHash(join(root, 'catalog/tools/index.json')).sha256 === input.publicCatalog.indexSha256
    && shellFileHash(join(root, 'catalog/tools/index.sig.json')).sha256 === input.publicCatalog.envelopeSha256, 'Accepted public catalog or signature bytes changed.');
  const envelope = readShellJson(join(root, 'catalog/tools/index.sig.json'));
  exact(envelope, ['alg', 'keyId', 'signedAt', 'indexHash', 'files', 'signature']);
  requireShell(envelope.alg === 'ECDSA-P256-SHA256' && envelope.indexHash === input.publicCatalog.indexSha256 && envelope.keyId === input.publicCatalog.keyId
    && envelope.files && typeof envelope.files === 'object' && !Array.isArray(envelope.files) && Object.keys(envelope.files).length === input.publicCatalog.signedFiles, 'Accepted public signed file map differs.');
}
function command(args: string[], options: PublicShellOptions, env: NodeJS.ProcessEnv, name: string): Ref {
  const started = performance.now(), result = spawnSync(process.execPath, args, { cwd: options.source, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 ** 2 });
  const report = writeShellJson(join(options.out, `${name}.original.json`), { command: [process.execPath, ...args], exitCode: result.status, signal: result.signal,
    seconds: (performance.now() - started) / 1000, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.name ?? null });
  requireShell(!result.error && result.status === 0 && result.signal === null, `Maintained public ${name} refused; preserve original reports.`); return report;
}
export function publicShellArguments(argv: string[]): PublicShellOptions {
  const names = new Map([['--source', 'source'], ['--base', 'base'], ['--candidate', 'candidate'], ['--previous-shell', 'previousShell'],
    ['--public-key', 'publicKey'], ['--out', 'out'], ['--custody', 'custody'], ['--custody-sha256', 'custodySha256']] as const);
  requireShell(argv.length === names.size * 2, 'Supply every documented public shell input.'); const values: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names.get(argv[i] as Parameters<typeof names.get>[0]), value = argv[i + 1];
    requireShell(key && value && !value.startsWith('--') && values[key] === undefined, 'Unknown, duplicate or missing public option.'); values[key] = value;
  }
  return values as PublicShellOptions;
}
export function preparePublicShellUpdate(options: PublicShellOptions) {
  requireShell(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later.');
  canonicalDirectory(options.source); canonicalDirectory(options.previousShell); canonicalDirectory(dirname(options.out));
  requireShell(isAbsolute(options.out) && resolve(options.out) === options.out && !existsSync(options.out), 'Output must be a new exclusive absolute directory.');
  for (const root of [options.source, options.previousShell]) requireShell(!options.out.startsWith(root + sep) && !root.startsWith(options.out + sep) && root !== options.out, 'Public source, baseline and output must not overlap.');
  requireShell(HASH.test(options.custodySha256), 'Reviewed public custody hash required.');
  const input = custody(options), previous = previousManifest(options, input), pin = readShellJson(options.publicKey, input.publicKeySha256);
  const producerSourceFiles = SOURCE_FILES.map(name => { const path = fileURLToPath(new URL(name, import.meta.url)); return { path, sha256: shellFileHash(path).sha256 }; });
  catalog(options.previousShell, input, pin);
  const classification = classifyApplicationRelease({ repo: options.source, base: options.base, candidate: options.candidate });
  requireShell(classification.classification === 'web-shell-only', 'Only committed web-shell changes qualify for public overlay preparation.');
  const imageClassification = classifyApplicationRelease({ repo: options.source, base: input.imageSource, candidate: options.candidate });
  requireShell(['web-shell-only', 'no-change'].includes(imageClassification.classification), 'Public image source dependencies, engine, profile, tools, config or brand changed.');
  for (const prefix of ['ort/', 'ort-hf/', 'viz-presets/']) {
    const cached = resolve(options.source, 'shells/web/public', prefix), expected = previous.files.filter(row => row.path.startsWith(prefix)).map(row => ({ ...row, path: row.path.slice(prefix.length) }));
    if (expected.length && existsSync(cached)) requireShell(JSON.stringify(shellManifest(cached).files) === JSON.stringify(expected), 'Source prerequisite cache differs from accepted public bytes.');
  }
  requireDisk(dirname(options.out), 128 * 1024 ** 2); mkdirSync(options.out, { mode: 0o700 });
  try {
    const classificationRef = writeShellJson(join(options.out, 'classification.json'), classification), imageClassificationRef = writeShellJson(join(options.out, 'image-classification.json'), imageClassification), imageManifestRef = writeShellJson(join(options.out, 'previous-static.manifest.json'), previous);
    const content = join(options.out, 'public-content'), prerequisites = join(options.out, 'public-prerequisites'), candidate = join(options.out, 'candidate-static');
    for (const path of [content, prerequisites, candidate]) mkdirSync(path, { mode: 0o700 });
    writeShellJson(join(content, 'profiles.json'), { default: input.profile, profiles: { [input.profile]: { label: input.profile, tools: ['tools'], catalog: 'catalog' } } });
    for (const name of ['catalog', 'tools']) symlinkSync(join(options.previousShell, name), join(content, name), 'dir');
    cloneShellFiles(options.previousShell, candidate, previous.files.filter(row => !row.path.startsWith('_app/') && !['index.html', 'precache.json', 'portable/player.js'].includes(row.path)), join(options.out, 'static-clone.json'));
    cloneShellFiles(options.previousShell, prerequisites, previous.files.filter(row => row.path.startsWith('ort/') || row.path.startsWith('ort-hf/') || row.path.startsWith('viz-presets/')), join(options.out, 'prerequisites-clone.json'));
    if (classification.changedPaths.some(row => row.path === 'shells/web/public/sw.js')) {
      const target = join(candidate, 'sw.js'); requireShell(lstatSync(target).isFile(), 'Existing public service worker required.'); unlinkSync(target);
      copyFileSync(join(options.source, 'shells/web/public/sw.js'), target, constants.COPYFILE_EXCL);
    }
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C.UTF-8', TZ: 'UTC', LOLLY_ROOT: content,
      LOLLY_PROFILE: input.profile, LOLLY_RELEASE_BUILD: '1', VITE_CATALOG_TRUST_MODE: 'verified', VITE_CATALOG_PUBLIC_KEY_JWK: JSON.stringify(pin),
      VITE_REQUIRE_AI_POLICY: 'false', VITE_LIVE_RELAY: input.settings.liveRelay, LOLLY_SITE_URL: input.settings.siteUrl };
    const webGate = command(['scripts/webgpu-release-gate.ts', '--scope', 'web'], options, env, 'web-gate'), previousCatalog = command(['scripts/verify-release-catalog.ts', '--root', options.previousShell, '--public-key', options.publicKey], options, env, 'previous-catalog');
    const modulesPath = join(options.out, 'workspace-modules.json');
    const runner = writeShellJson(join(options.out, 'vite-input.json'), { source: options.source, sourceCommit: options.candidate, output: candidate, prerequisites, moduleReceipt: modulesPath });
    const buildReport = command([fileURLToPath(new URL('./shell-update-vite.mjs', import.meta.url)), runner.path, runner.sha256], options, env, 'vite-build');
    const candidateCatalog = command(['scripts/verify-release-catalog.ts', '--root', candidate, '--public-key', options.publicKey], options, env, 'candidate-catalog');
    catalog(candidate, input, pin);
    const candidateManifest = shellManifest(candidate), delta = shellUpdateDelta(candidateManifest, previous);
    requireShell(delta.files.length > 0 && PUBLIC_OVERLAY_FILES.every(path => candidateManifest.files.some(row => row.path === path)), 'Public build must produce every fixed overlay file and a changed UI.');
    const candidateRef = writeShellJson(join(options.out, 'candidate-static.manifest.json'), candidateManifest), prepared = join(options.out, 'prepared-static'), retentionPath = join(options.out, 'retention.json');
    const retention = retainShellAssets({ candidate, previous: options.previousShell, expectedCandidateId: shellId(candidateManifest), expectedPreviousId: shellId(previous), out: prepared, receiptOut: retentionPath, copyMode: 'clone' });
    const preparedManifest = shellManifest(prepared), preparedRef = writeShellJson(join(options.out, 'prepared-static.manifest.json'), preparedManifest);
    const overlay = join(options.out, 'public-shell-overlay'), deltaRoot = join(options.out, 'frontend-delta');
    mkdirSync(overlay, { mode: 0o700 }); mkdirSync(deltaRoot, { mode: 0o700 });
    const overlayFiles = preparedManifest.files.filter(row => row.path.startsWith('_app/') || (PUBLIC_OVERLAY_FILES as readonly string[]).includes(row.path));
    cloneShellFiles(prepared, overlay, overlayFiles, join(options.out, 'overlay-clone.json')); cloneShellFiles(candidate, deltaRoot, delta.files, join(options.out, 'delta-clone.json'));
    const overlayManifest = shellManifest(overlay), overlayRef = writeShellJson(join(options.out, 'public-shell-overlay.manifest.json'), overlayManifest), deltaRef = writeShellJson(join(options.out, 'frontend-delta.manifest.json'), delta);
    requireShell(same(shellManifest(options.previousShell), previous), 'Accepted public baseline changed during preparation.');
    requireShell(JSON.stringify(classifyApplicationRelease({ repo: options.source, base: options.base, candidate: options.candidate })) === JSON.stringify(classification), 'Public source changed during preparation.');
    custody(options); readShellJson(options.publicKey, input.publicKeySha256); requireDisk(options.out);
    for (const ref of producerSourceFiles) requireShell(shellFileHash(ref.path).sha256 === ref.sha256, 'Public producer helper source changed during preparation.');
    const modules = readShellJson(modulesPath); requireShell(modules && typeof modules === 'object' && 'source' in modules && modules.source === options.source, 'Source-bound public workspace receipt differs.');
    const result = { version: 1, status: PUBLIC_STATUS, artifactClass: 'public-shell-overlay', lollySource: options.candidate, imageSource: input.imageSource, previousShellSource: options.base,
      image: input.image, profile: input.profile, settings: input.settings, publicCatalog: input.publicCatalog, shellManifestSha256: preparedRef.sha256,
      workspaceModules: { path: modulesPath, sha256: shellFileHash(modulesPath).sha256 }, originalReport: buildReport, classification: classificationRef, imageClassification: imageClassificationRef,
      custody: { path: options.custody, sha256: options.custodySha256 }, previousAcceptance: input.previousAcceptance, ci: input.ci, publicKey: { path: options.publicKey, sha256: input.publicKeySha256 },
      previous: { root: options.previousShell, manifest: imageManifestRef }, candidate: { root: candidate, manifest: candidateRef }, shell: { root: prepared, manifest: preparedRef },
      overlay: { root: overlay, manifest: overlayRef }, delta: { root: deltaRoot, manifest: deltaRef }, retention: { path: retentionPath, sha256: shellFileHash(retentionPath).sha256 },
      retainedFiles: retention.retained.length, webGate, catalog: { previous: previousCatalog, candidate: candidateCatalog, signatureReused: true, newSigning: false },
      producer: { path: fileURLToPath(import.meta.url), sha256: shellFileHash(fileURLToPath(import.meta.url)).sha256 }, producerSourceFiles,
      originAuthenticatedByThisCommand: false, normalCIQualified: false, runtimeQualified: false, promotionAttempted: false };
    writeShellJson(join(options.out, 'public-shell-update.prepared.json'), result); return result;
  } catch (error) {
    writeShellJson(join(options.out, 'public-shell-update.refused.json'), { version: 1, status: 'REFUSED', reason: error instanceof Error ? error.message : 'Public preparation failed.', incompleteOutputPreserved: true, runtimeQualified: false, promotionAttempted: false }); throw error;
  }
}
export function main(argv = process.argv.slice(2)): number {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node scripts/prepare-public-shell-update.ts --source CLEAN_LOLLY_ROOT --base ACCEPTED_SHELL_COMMIT --candidate CANDIDATE_COMMIT --previous-shell ACCEPTED_PUBLIC_STATIC_ROOT --public-key EXISTING_PUBLIC_JWK --custody REVIEWED_PUBLIC_CUSTODY_JSON --custody-sha256 SHA256 --out NEW_DIRECTORY\nPublic-only artifact: neutral lolly-start, existing signed catalog and verification pin, unchanged accepted public image/models/config. Emits complete static, retained five-path overlay and delta manifests. Never installs dependencies, signs, builds an image, authenticates CI/report origins, contacts a cluster or deploys.'); return 0;
  }
  try { const result = preparePublicShellUpdate(publicShellArguments(argv)); console.log(JSON.stringify({ status: result.status, source: result.lollySource, overlay: result.overlay.manifest, promotionAttempted: false })); return 0; }
  catch { console.error(JSON.stringify({ status: 'REFUSED', reason: 'Public source, custody, capacity or maintained build checks failed; inspect original reports.', promotionAttempted: false })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
