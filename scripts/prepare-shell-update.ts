#!/usr/bin/env node
// SPDX-License-Identifier: MPL-2.0
/** Build a small private web delta against a reviewed immutable shell; never deploy. */
import { spawnSync } from 'node:child_process';
import { copyFileSync, constants, existsSync, lstatSync, mkdirSync, symlinkSync, unlinkSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyApplicationRelease } from './classify-application-release.ts';
import { retainShellAssets } from './retain-shell-assets.ts';
import { canonicalDirectory, cloneShellFiles, readShellJson, requireDisk, requireShell, sha256,
  shellFileHash, shellId, shellManifest, writeShellJson } from './shell-update-files.ts';
import type { ShellManifest } from './shell-update-files.ts';

const COMMIT = /^[a-f0-9]{40}$/, HASH = /^[a-f0-9]{64}$/;
type Ref = { path: string; sha256: string };
export type ShellUpdateOptions = { source: string; base: string; candidate: string; previousShell: string; publicKey: string; out: string; custody: string; custodySha256: string };
type Custody = { version: 1; engineSource: string; workSource: string; brandCommit: string; enginePinSha256: string; profile: string;
  settings: { catalogTrustMode: 'verified'; requireAiPolicy: true; liveRelay: string; siteUrl: string };
  previousManifest: Ref; previousAcceptance: Ref; ci: Ref; publicKeySha256: string };
const STATUS = 'LOCAL_PRIVATE_SHELL_UPDATE_PREPARED_UNQUALIFIED';
function exact(value: unknown, keys: string[]): asserts value is Record<string, unknown> {
  requireShell(value !== null && typeof value === 'object' && !Array.isArray(value)
    && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort()), 'Unknown or missing custody field.');
}
function reference(value: unknown): Ref {
  exact(value, ['path', 'sha256']); requireShell(typeof value.path === 'string' && typeof value.sha256 === 'string' && HASH.test(value.sha256), 'Invalid custody reference.');
  readShellJson(value.path, value.sha256); return value as Ref;
}
function https(value: unknown, origin = false): string {
  requireShell(typeof value === 'string', 'Explicit HTTPS build setting required.'); const url = new URL(value);
  requireShell(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash && (!origin || url.origin === value), 'Build setting must be a safe HTTPS URL.'); return value;
}
function custody(options: ShellUpdateOptions): Custody {
  const value = readShellJson(options.custody, options.custodySha256);
  exact(value, ['version', 'engineSource', 'workSource', 'brandCommit', 'enginePinSha256', 'profile', 'settings', 'previousManifest', 'previousAcceptance', 'ci', 'publicKeySha256']);
  requireShell(value.version === 1 && typeof value.engineSource === 'string' && COMMIT.test(value.engineSource)
    && typeof value.workSource === 'string' && COMMIT.test(value.workSource) && typeof value.brandCommit === 'string' && COMMIT.test(value.brandCommit)
    && typeof value.enginePinSha256 === 'string' && HASH.test(value.enginePinSha256) && typeof value.publicKeySha256 === 'string' && HASH.test(value.publicKeySha256)
    && typeof value.profile === 'string' && /^[a-z][a-z0-9-]{0,63}$/.test(value.profile), 'Invalid immutable custody identity.');
  exact(value.settings, ['catalogTrustMode', 'requireAiPolicy', 'liveRelay', 'siteUrl']);
  requireShell(value.settings.catalogTrustMode === 'verified' && value.settings.requireAiPolicy === true, 'Verified catalog and AI policy must remain enabled.');
  https(value.settings.liveRelay); https(value.settings.siteUrl, true);
  for (const key of ['previousManifest', 'previousAcceptance', 'ci']) reference(value[key]);
  return value as unknown as Custody;
}
function previousManifest(options: ShellUpdateOptions, input: Custody): ShellManifest {
  const value = readShellJson(input.previousManifest.path, input.previousManifest.sha256);
  exact(value, ['version', 'files', 'totalBytes']);
  requireShell(value.version === 1 && Array.isArray(value.files) && Number.isSafeInteger(value.totalBytes) && (value.totalBytes as number) >= 0, 'Complete v1 previous manifest required.');
  for (const file of value.files) {
    exact(file, ['path', 'size', 'sha256']);
    requireShell(typeof file.path === 'string' && Number.isSafeInteger(file.size) && (file.size as number) >= 0
      && typeof file.sha256 === 'string' && HASH.test(file.sha256), 'Complete exact previous file entry required.');
  }
  const actual = shellManifest(options.previousShell);
  requireShell(same(actual, value as unknown as ShellManifest), 'Previous full tree differs from reviewed manifest.');
  requireShell(actual.files.some(file => file.path === 'index.html') && actual.files.some(file => file.path.startsWith('_app/')), 'Previous shell entry and lazy assets required.');
  return actual;
}
function same(left: ShellManifest, right: ShellManifest): boolean {
  return left.version === right.version && left.totalBytes === right.totalBytes && left.files.length === right.files.length
    && left.files.every((file, index) => { const other = right.files[index]; return other?.path === file.path && other.size === file.size && other.sha256 === file.sha256; });
}
function changedAllowed(path: string): boolean { return path.startsWith('_app/') || ['index.html', 'precache.json', 'portable/player.js', 'sw.js'].includes(path); }
export function shellUpdateDelta(candidate: ShellManifest, previous: ShellManifest) {
  const old = new Map(previous.files.map(file => [file.path, file]));
  const files = candidate.files.filter(file => { const prior = old.get(file.path); return prior?.size !== file.size || prior.sha256 !== file.sha256; });
  requireShell(files.every(file => changedAllowed(file.path)), 'A non-shell generated resource changed; use a broader release.');
  for (const file of previous.files) if (!changedAllowed(file.path)) {
    requireShell(candidate.files.some(row => row.path === file.path && row.sha256 === file.sha256 && row.size === file.size), 'A protected static resource was removed.');
  }
  return { version: 1 as const, files, totalBytes: files.reduce((n, file) => n + file.size, 0) };
}
function command(args: string[], options: ShellUpdateOptions, env: NodeJS.ProcessEnv, name: string) {
  const started = performance.now();
  const result = spawnSync(process.execPath, args, { cwd: options.source, env, encoding: 'utf8', timeout: 300_000, maxBuffer: 16 * 1024 ** 2 });
  const report = writeShellJson(join(options.out, `${name}.original.json`), { command: [process.execPath, ...args], exitCode: result.status, signal: result.signal,
    seconds: (performance.now() - started) / 1000, stdout: result.stdout ?? '', stderr: result.stderr ?? '', error: result.error?.name ?? null });
  requireShell(!result.error && result.status === 0 && result.signal === null, `Maintained ${name} refused; preserve its original report.`);
  return report;
}
export function shellUpdateArguments(argv: string[]): ShellUpdateOptions {
  const names = new Map([['--source', 'source'], ['--base', 'base'], ['--candidate', 'candidate'], ['--previous-shell', 'previousShell'],
    ['--public-key', 'publicKey'], ['--out', 'out'], ['--custody', 'custody'], ['--custody-sha256', 'custodySha256']] as const);
  requireShell(argv.length === names.size * 2, 'Supply every documented shell update input.'); const options: Record<string, string> = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = names.get(argv[i] as Parameters<typeof names.get>[0]), value = argv[i + 1];
    requireShell(key && value && !value.startsWith('--') && options[key] === undefined, 'Unknown, missing or duplicate shell update option.'); options[key] = value;
  }
  return options as ShellUpdateOptions;
}
export function prepareShellUpdate(options: ShellUpdateOptions) {
  requireShell(Number(process.versions.node.split('.')[0]) >= 24, 'Use Node 24 or later.');
  canonicalDirectory(options.source); canonicalDirectory(options.previousShell); canonicalDirectory(dirname(options.out));
  requireShell(isAbsolute(options.out) && resolve(options.out) === options.out && !existsSync(options.out), 'Output must be a new absolute exclusive directory.');
  for (const root of [options.source, options.previousShell]) requireShell(!options.out.startsWith(root + sep) && !root.startsWith(options.out + sep) && root !== options.out, 'Source, previous and output must not overlap.');
  requireShell(HASH.test(options.custodySha256), 'Reviewed custody hash required.');
  const input = custody(options), previous = previousManifest(options, input);
  const classification = classifyApplicationRelease({ repo: options.source, base: options.base, candidate: options.candidate });
  requireShell(classification.classification === 'web-shell-only', 'Only committed web-shell changes qualify for this artifact path.');
  const engineClassification = classifyApplicationRelease({ repo: options.source, base: input.engineSource, candidate: options.candidate });
  requireShell(['web-shell-only', 'no-change'].includes(engineClassification.classification), 'Engine, core, schema, dependencies, profile, tool or brand source changed.');
  const pin = readShellJson(options.publicKey, input.publicKeySha256);
  requireShell(pin && typeof pin === 'object' && 'kty' in pin && pin.kty === 'EC' && 'crv' in pin && pin.crv === 'P-256'
    && 'x' in pin && typeof pin.x === 'string' && 'y' in pin && typeof pin.y === 'string' && !('d' in pin), 'Only an existing public P-256 pin is accepted.');
  // Existing source caches are optional. The accepted external snapshot supplies
  // these unchanged generated resources; nothing is generated into the checkout.
  for (const prefix of ['ort/', 'ort-hf/', 'viz-presets/']) {
    const expected = previous.files.filter(file => file.path.startsWith(prefix)).map(file => ({ ...file, path: file.path.slice(prefix.length) }));
    const cached = resolve(options.source, 'shells/web/public', prefix);
    if (expected.length && existsSync(cached)) requireShell(JSON.stringify(shellManifest(cached).files) === JSON.stringify(expected), 'Cached generated prerequisite differs from accepted shell.');
  }
  requireDisk(dirname(options.out), 128 * 1024 ** 2); mkdirSync(options.out, { mode: 0o700 });
  try {
    const classificationRef = writeShellJson(join(options.out, 'classification.json'), classification);
    const engineClassificationRef = writeShellJson(join(options.out, 'engine-classification.json'), engineClassification);
    const previousRef = writeShellJson(join(options.out, 'previous-shell.manifest.json'), previous);
    const content = join(options.out, 'content'), prerequisites = join(options.out, 'public-prerequisites'), candidate = join(options.out, 'candidate-shell');
    for (const path of [content, prerequisites, candidate]) mkdirSync(path, { mode: 0o700 });
    writeShellJson(join(content, 'profiles.json'), { default: input.profile, profiles: { [input.profile]: { label: input.profile, tools: ['tools'], catalog: 'catalog' } } });
    // Content roots may refer to the previous immutable signed catalog. Output files
    // have separate inodes, so maintained materialization cannot write its baseline.
    for (const name of ['catalog', 'tools']) symlinkSync(join(options.previousShell, name), join(content, name), 'dir');
    const staticFiles = previous.files.filter(file => !file.path.startsWith('_app/') && !['index.html', 'precache.json', 'portable/player.js'].includes(file.path));
    cloneShellFiles(options.previousShell, candidate, staticFiles, join(options.out, 'candidate-static-clone.json'));
    cloneShellFiles(options.previousShell, prerequisites, previous.files.filter(file => file.path.startsWith('ort/') || file.path.startsWith('ort-hf/') || file.path.startsWith('viz-presets/')), join(options.out, 'prerequisites-clone.json'));
    // sw.js is a maintained unbundled shell resource and has an explicit source.
    if (classification.changedPaths.some(change => change.path === 'shells/web/public/sw.js')) {
      const target = join(candidate, 'sw.js');
      requireShell(existsSync(target) && lstatSync(target).isFile(), 'Previous service worker required.'); unlinkSync(target);
      copyFileSync(join(options.source, 'shells/web/public/sw.js'), target, constants.COPYFILE_EXCL);
    }
    const env: NodeJS.ProcessEnv = { PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`, LANG: 'C.UTF-8', TZ: 'UTC',
      LOLLY_ROOT: content, LOLLY_PROFILE: input.profile, LOLLY_RELEASE_BUILD: '1', VITE_CATALOG_TRUST_MODE: 'verified', VITE_CATALOG_PUBLIC_KEY_JWK: JSON.stringify(pin),
      VITE_REQUIRE_AI_POLICY: 'true', VITE_LIVE_RELAY: input.settings.liveRelay, LOLLY_SITE_URL: input.settings.siteUrl };
    const webGate = command(['scripts/webgpu-release-gate.ts', '--scope', 'web'], options, env, 'web-gate');
    const previousCatalog = command(['scripts/verify-release-catalog.ts', '--root', options.previousShell, '--public-key', options.publicKey], options, env, 'previous-catalog');
    const modulesPath = join(options.out, 'workspace-modules.json');
    const runnerInput = writeShellJson(join(options.out, 'vite-input.json'), { source: options.source, sourceCommit: options.candidate, output: candidate, prerequisites, moduleReceipt: modulesPath });
    const buildReport = command([fileURLToPath(new URL('./shell-update-vite.mjs', import.meta.url)), runnerInput.path, runnerInput.sha256], options, env, 'vite-build');
    const catalog = command(['scripts/verify-release-catalog.ts', '--root', candidate, '--public-key', options.publicKey], options, env, 'candidate-catalog');
    const candidateManifest = shellManifest(candidate), delta = shellUpdateDelta(candidateManifest, previous);
    requireShell(delta.files.length > 0, 'No generated shell changes; no update needed.');
    const candidateRef = writeShellJson(join(options.out, 'candidate-shell.manifest.json'), candidateManifest);
    const prepared = join(options.out, 'prepared-shell'), retentionPath = join(options.out, 'retention.json');
    const retention = retainShellAssets({ candidate, previous: options.previousShell, expectedCandidateId: shellId(candidateManifest), expectedPreviousId: shellId(previous), out: prepared,
      receiptOut: retentionPath, copyMode: 'clone' });
    const preparedManifest = shellManifest(prepared), preparedRef = writeShellJson(join(options.out, 'prepared-shell.manifest.json'), preparedManifest);
    const deltaRoot = join(options.out, 'frontend-delta'); mkdirSync(deltaRoot, { mode: 0o700 });
    cloneShellFiles(candidate, deltaRoot, delta.files, join(options.out, 'delta-clone.json'));
    const deltaRef = writeShellJson(join(options.out, 'frontend-delta.manifest.json'), delta);
    requireShell(same(shellManifest(options.previousShell), previous), 'Previous baseline changed during build.');
    requireShell(JSON.stringify(classifyApplicationRelease({ repo: options.source, base: options.base, candidate: options.candidate })) === JSON.stringify(classification), 'Source changed during build.');
    custody(options); readShellJson(options.publicKey, input.publicKeySha256); requireDisk(options.out);
    const modules = readShellJson(modulesPath); requireShell(modules && typeof modules === 'object' && 'source' in modules && modules.source === options.source, 'Workspace receipt source differs.');
    const result = { version: 1, status: STATUS, lollySource: options.candidate, engineSource: input.engineSource, previousShellSource: options.base,
      workSource: input.workSource, brandCommit: input.brandCommit, profile: input.profile, enginePinSha256: input.enginePinSha256,
      shellManifestSha256: preparedRef.sha256, settings: input.settings, workspaceModules: { path: modulesPath, ...shellFileHash(modulesPath) }, originalReport: buildReport,
      classification: classificationRef, engineClassification: engineClassificationRef, custody: { path: options.custody, sha256: options.custodySha256 },
      previousAcceptance: input.previousAcceptance, ci: input.ci, publicKey: { path: options.publicKey, sha256: input.publicKeySha256 },
      previous: { root: options.previousShell, manifest: previousRef, shellId: shellId(previous), files: previous.files.length },
      candidate: { root: candidate, manifest: candidateRef, shellId: shellId(candidateManifest), files: candidateManifest.files.length },
      shell: { root: prepared, manifest: preparedRef, shellId: shellId(preparedManifest), files: preparedManifest.files.length },
      delta: { root: deltaRoot, manifest: deltaRef, files: delta.files.length, totalBytes: delta.totalBytes },
      retention: { path: retentionPath, ...shellFileHash(retentionPath), retainedFiles: retention.retained.length },
      webGate, catalog: { previous: previousCatalog, candidate: catalog, signatureReused: true, newSigning: false },
      producer: { path: fileURLToPath(import.meta.url), ...shellFileHash(fileURLToPath(import.meta.url)) },
      originAuthenticatedByThisCommand: false, normalCIQualified: false, runtimeQualified: false, promotionAttempted: false,
      outstanding: ['Review source CI and accepted previous custody', 'Read-only staged runtime and browser qualification', 'Fresh exact live guards, narrow promotion and post-promotion acceptance'] };
    writeShellJson(join(options.out, 'shell-update.prepared.json'), result); return result;
  } catch (error) {
    writeShellJson(join(options.out, 'shell-update.refused.json'), { version: 1, status: 'REFUSED', reason: error instanceof Error ? error.message : 'Local preparation failed.',
      incompleteOutputPreserved: true, runtimeQualified: false, promotionAttempted: false }); throw error;
  }
}
export function main(argv = process.argv.slice(2)): number {
  if (argv.length === 1 && argv[0] === '--help') {
    console.log('Usage: node scripts/prepare-shell-update.ts --source CLEAN_LOLLY_ROOT --base ACCEPTED_SHELL_COMMIT --candidate CANDIDATE_COMMIT --previous-shell ACCEPTED_SHELL_ROOT --public-key PUBLIC_JWK --custody REVIEWED_CUSTODY_JSON --custody-sha256 SHA256 --out NEW_DIRECTORY\nCustody v1 binds accepted engine/Work/brand/pin, settings, complete previous manifest, previous acceptance, source CI and public pin hashes. Produces candidate/prepared/delta complete manifests and original local reports; it never installs dependencies, signs a catalog, builds an image or deploys.'); return 0;
  }
  try { const result = prepareShellUpdate(shellUpdateArguments(argv)); console.log(JSON.stringify({ status: result.status, source: result.lollySource, deltaFiles: result.delta.files, deltaBytes: result.delta.totalBytes, promotionAttempted: false })); return 0; }
  catch { console.error(JSON.stringify({ status: 'REFUSED', reason: 'Local source, custody, capacity or build checks failed; preserve outputs and inspect original reports.', promotionAttempted: false })); return 1; }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main();
