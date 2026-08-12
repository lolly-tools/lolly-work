#!/usr/bin/env node
// SPDX-License-Identifier: UNLICENSED
/**
 * repin-engine — the re-pin cadence tool for the vendored OSS engine
 * (plans/current-state.md: "Engine pin drift" — the vendored engine drifts
 * behind OSS HEAD with no automated re-pin).
 *
 * Default (no flags) is a cheap REPORT: how far engine-pin.json has drifted
 * from the sibling OSS checkout — commits behind HEAD and pinned engine/core
 * versions vs the OSS tree. Safe for CI and humans; touches nothing.
 *
 *   node scripts/repin-engine.ts            # report drift, exit 0
 *   node scripts/repin-engine.ts --apply    # actually re-pin (see below)
 *
 * --apply re-vendors the same way the pin was originally produced (the OSS
 * repo's scripts/pack-engine.ts is the publish half; engine-pin.json is its
 * manifest.json verbatim — see verify-engine-pin.ts):
 *
 *   1. back up vendor/ + engine-pin.json + package-lock.json to a temp dir
 *   2. run `node scripts/pack-engine.ts` in the OSS repo → dist/engine-pack/
 *   3. extract the core + engine tarballs into vendor/@lolly-tools/core and
 *      vendor/@lolly/engine, copy schemas/ to vendor/@lolly/schemas, and adopt
 *      manifest.json as the new engine-pin.json
 *   4. `npm install` to sync the lockfile's vendored-package versions
 *   5. prove coherence: `npm run verify:engine-pin` then `npm test`
 *
 * Any failure after step 1 restores the previous vendor/ + pin + lockfile, so
 * a broken re-pin can never leave the working tree half-vendored.
 *
 * The OSS checkout is found via LOLLY_OSS_DIR, else a sibling `lolly` checkout
 * (same idiom as scripts/demo.ts).
 */
import { execFileSync } from 'node:child_process';
import { cpSync, existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

// ── OSS repo discovery ───────────────────────────────────────────────────────
// The Hybrid model: `vendor/lolly` is a committed git submodule tracking lolly
// main, and the pin is packed from THAT (reproducible, in-tree, and it captures
// the committed engine — never a sibling checkout's uncommitted WIP). Updating
// the engine is a submodule pointer bump (`git submodule update --remote
// vendor/lolly`) followed by `--apply`. LOLLY_OSS_DIR still overrides for CI /
// one-off packs; the sibling + hard-coded paths remain as dev fallbacks. First
// one that looks like the engine repo wins.
function resolveOssDir(): string {
  const candidates = [
    process.env.LOLLY_OSS_DIR,
    resolve(ROOT, 'vendor', 'lolly'), // committed submodule — the Hybrid pack source
    resolve(ROOT, '..', 'lolly'),     // sibling checkout fallback: ../lolly
    '/Users/andy/Build/lolly',        // original dev default
  ].filter((p): p is string => typeof p === 'string' && p.length > 0);
  for (const c of candidates) {
    if (existsSync(join(c, 'engine', 'src', 'version.ts')) && existsSync(join(c, 'scripts', 'pack-engine.ts'))) {
      return resolve(c);
    }
  }
  throw new Error(
    `OSS engine repo not found — looked at: ${candidates.join(', ')}. ` +
      'Set LOLLY_OSS_DIR to your lolly checkout.',
  );
}

function git(ossDir: string, ...args: string[]): string {
  return execFileSync('git', ['-C', ossDir, ...args], { encoding: 'utf8' }).trim();
}

interface Pin {
  generatedFrom: string;
  core: { version: string };
  engine: { version: string };
  schemas: Record<string, string>;
}

function readPin(): Pin {
  return JSON.parse(readFileSync(join(ROOT, 'engine-pin.json'), 'utf8')) as Pin;
}

function ossEngineVersion(ossDir: string): string {
  const src = readFileSync(join(ossDir, 'engine', 'src', 'version.ts'), 'utf8');
  const m = src.match(/ENGINE_VERSION\s*=\s*'([^']+)'/);
  if (!m) throw new Error(`could not read ENGINE_VERSION from ${join(ossDir, 'engine/src/version.ts')}`);
  return m[1] as string;
}

function ossCoreVersion(ossDir: string): string {
  return JSON.parse(readFileSync(join(ossDir, 'packages', 'core', 'package.json'), 'utf8')).version as string;
}

// ── report ───────────────────────────────────────────────────────────────────
interface Drift {
  ossDir: string;
  pinnedCommit: string;
  ossHead: string;
  commitsBehind: number;
  pinnedEngine: string;
  ossEngine: string;
  pinnedCore: string;
  ossCore: string;
  inSync: boolean;
}

function measureDrift(ossDir: string): Drift {
  const pin = readPin();
  const ossHead = git(ossDir, 'rev-parse', 'HEAD');
  let commitsBehind: number;
  try {
    commitsBehind = Number(git(ossDir, 'rev-list', '--count', `${pin.generatedFrom}..HEAD`));
  } catch {
    // Pinned commit unknown to the checkout (shallow clone / different remote) —
    // report version drift only.
    commitsBehind = -1;
  }
  const ossEngine = ossEngineVersion(ossDir);
  const ossCore = ossCoreVersion(ossDir);
  return {
    ossDir,
    pinnedCommit: pin.generatedFrom,
    ossHead,
    commitsBehind,
    pinnedEngine: pin.engine.version,
    ossEngine,
    pinnedCore: pin.core.version,
    ossCore,
    inSync: commitsBehind === 0 && pin.engine.version === ossEngine && pin.core.version === ossCore,
  };
}

function report(d: Drift): void {
  console.log(`engine pin drift — OSS repo: ${d.ossDir}`);
  console.log(`  pinned commit  ${d.pinnedCommit.slice(0, 12)}   OSS HEAD ${d.ossHead.slice(0, 12)}`);
  if (d.commitsBehind < 0) {
    console.log('  commits behind unknown (pinned commit not found in this checkout)');
  } else {
    console.log(`  commits behind ${d.commitsBehind}`);
  }
  console.log(`  @lolly/engine       pinned ${d.pinnedEngine}   OSS ${d.ossEngine}${d.pinnedEngine === d.ossEngine ? '' : '   ← behind'}`);
  console.log(`  @lolly-tools/core   pinned ${d.pinnedCore}   OSS ${d.ossCore}${d.pinnedCore === d.ossCore ? '' : '   ← behind'}`);
  console.log(
    d.inSync
      ? '✓ pin is current with OSS HEAD.'
      : `→ re-pin with: npm run repin-engine -- --apply`,
  );
}

// ── apply ────────────────────────────────────────────────────────────────────
const BACKED_UP = ['vendor', 'engine-pin.json', 'package-lock.json'] as const;

function backup(): string {
  const dir = mkdtempSync(join(tmpdir(), 'repin-engine-backup-'));
  for (const entry of BACKED_UP) cpSync(join(ROOT, entry), join(dir, entry), { recursive: true });
  return dir;
}

function restore(backupDir: string): void {
  for (const entry of BACKED_UP) {
    rmSync(join(ROOT, entry), { recursive: true, force: true });
    cpSync(join(backupDir, entry), join(ROOT, entry), { recursive: true });
  }
}

function run(cmd: string, args: string[], cwd: string): void {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

/** Replace `destDir` with the extracted content of an npm-pack tarball
 *  (strip the top-level `package/` directory — exactly what pack-engine.ts
 *  hashes, so vendor/ matches the pin byte-for-byte). */
function extractTarball(tgz: string, destDir: string): void {
  rmSync(destDir, { recursive: true, force: true });
  execFileSync('mkdir', ['-p', destDir]);
  execFileSync('tar', ['xzf', tgz, '-C', destDir, '--strip-components=1']);
}

function apply(ossDir: string, drift: Drift): void {
  if (drift.inSync) {
    console.log('pin already current — nothing to apply.');
    return;
  }
  const backupDir = backup();
  console.log(`backup → ${backupDir}`);
  try {
    // 1. Produce the bundle exactly the way the original pin was made.
    console.log(`\n▶ node scripts/pack-engine.ts  (in ${ossDir})`);
    run('node', ['scripts/pack-engine.ts'], ossDir);

    const packDir = join(ossDir, 'dist', 'engine-pack');
    const manifest = JSON.parse(readFileSync(join(packDir, 'manifest.json'), 'utf8')) as {
      core: { tarball: string };
      engine: { tarball: string };
    };

    // 2. Re-vendor: tarballs → vendor/@…, schemas alongside, manifest → pin.
    console.log('\n▶ re-vendoring into vendor/');
    extractTarball(join(packDir, manifest.core.tarball), join(ROOT, 'vendor', '@lolly-tools', 'core'));
    extractTarball(join(packDir, manifest.engine.tarball), join(ROOT, 'vendor', '@lolly', 'engine'));
    rmSync(join(ROOT, 'vendor', '@lolly', 'schemas'), { recursive: true, force: true });
    cpSync(join(packDir, 'schemas'), join(ROOT, 'vendor', '@lolly', 'schemas'), { recursive: true });
    cpSync(join(packDir, 'manifest.json'), join(ROOT, 'engine-pin.json'));

    // Test-only hook: prove the restore path without a real re-pin.
    if (process.env.LOLLY_REPIN_TEST_FAIL) throw new Error('LOLLY_REPIN_TEST_FAIL — injected failure to exercise restore');

    // 3. Sync the lockfile's vendored-package versions.
    console.log('\n▶ npm install (lockfile sync)');
    run('npm', ['install', '--no-audit', '--no-fund'], ROOT);

    // 4. Prove the new pin is coherent.
    console.log('\n▶ npm run verify:engine-pin');
    run('npm', ['run', 'verify:engine-pin'], ROOT);
    console.log('\n▶ npm test');
    run('npm', ['test'], ROOT);
  } catch (err) {
    console.error(`\n✗ re-pin failed — restoring previous vendor/ + pin from ${backupDir}`);
    restore(backupDir);
    console.error('  previous pin restored. Fix the failure and retry.');
    throw err;
  }
  rmSync(backupDir, { recursive: true, force: true });
  const pin = readPin();
  console.log(
    `\n✓ re-pinned to @lolly/engine@${pin.engine.version}, @lolly-tools/core@${pin.core.version} ` +
      `(OSS ${pin.generatedFrom.slice(0, 12)}). Review the diff, check the bridge-contract version label, commit.`,
  );
}

// ── main ─────────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
if (args.some((a) => a !== '--apply' && a !== '--check')) {
  console.error('usage: node scripts/repin-engine.ts [--apply | --check]');
  process.exit(2);
}
const ossDir = resolveOssDir();
const drift = measureDrift(ossDir);
report(drift);
if (args.includes('--apply')) apply(ossDir, drift);
// --check: same report, but a drifted pin is a non-zero exit — the CI cadence
// (engine-drift.yml) turns lock-step from a habit into a signal (plans/23 R5:
// the 1.112→1.114 gap sat unnoticed until a fidelity audit went looking).
else if (args.includes('--check') && !drift.inSync) process.exit(1);
