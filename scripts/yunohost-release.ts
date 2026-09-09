#!/usr/bin/env node
/**
 * Cut the YunoHost release artifact: the server tarball deploy/yunohost/manifest.toml
 * points at, and the manifest fields that pin it (this repo's version and tarball,
 * plus the web shell's pin copied from the open-source repo's own package).
 *
 *   node scripts/yunohost-release.ts                  # archive HEAD, pin the manifest
 *   node scripts/yunohost-release.ts --publish        # also upload to lolli.li (needs the S3 keys)
 *   node scripts/yunohost-release.ts --oss ../lolly   # where to read the shell pin from (default ../lolly or $LOLLY_OSS_DIR)
 *   node scripts/yunohost-release.ts --shell-url URL --shell-sha256 HEX   # or state the shell pin directly
 *   node scripts/yunohost-release.ts --ynh-rev 2      # a repackaging of the same upstream version
 *   node scripts/yunohost-release.ts --out <dir>      # default ~/.cache/lolly-release/artifacts
 *
 * The tarball is `git archive` of HEAD: the server, console, vendored engine, docs,
 * migrations and lockfile, with no node_modules (the install script runs
 * `pnpm install --frozen-lockfile --prod` on the host). Four trees are left out on purpose - `packs/`
 * because the demo pack carries SUSE's proprietary brand assets (packs/demo/brands/
 * suse/NOTICE.md) and the YunoHost instance seeds its pack from the web shell
 * instead; `tests/`, `plans/` and `deploy/` because a running instance never reads
 * them. A dirty working tree is refused: what ships must be a commit.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('..', import.meta.url)));
export const MANIFEST = join(ROOT, 'deploy', 'yunohost', 'manifest.toml');
export const RELEASE_HOST = 'https://lolli.li';
/** Trees `git archive` leaves out; see the header for why each. */
export const EXCLUDED = ['packs', 'tests', 'plans', 'deploy', '.github'];

export interface SourcePin { url: string; sha256: string }
export interface Pins { version: string; ynhRev: number; main: SourcePin; shell: SourcePin }

export function tarballName(version: string): string {
  return `lolly-work-${version}.tar.gz`;
}

export function upstreamVersion(): string {
  const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as { version: string };
  if (!/^\d+\.\d+\.\d+$/.test(pkg.version)) throw new Error(`package.json version is not x.y.z: ${pkg.version}`);
  return pkg.version;
}

/**
 * What YunoHost's ynh_config_add does to a template: every `__NAME__` becomes the
 * value of the lowercased variable `name`. Used by the tests to render conf/ the
 * way an install renders it; unknown placeholders are left in place, as they are
 * on a host, so a test can see them.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/__([A-Z_]+)__/g, (whole, name: string) => vars[name.toLowerCase()] ?? whole);
}

/** Rewrite one `[resources.sources.<id>]` table's url + sha256, leaving the rest byte for byte. */
function pinSource(source: string, id: string, pin: SourcePin): string {
  const head = new RegExp(`^(\\s*\\[resources\\.sources\\.${id}\\]\\s*\\n)`, 'm');
  const m = head.exec(source);
  if (!m) throw new Error(`manifest.toml has no [resources.sources.${id}] table`);
  const start = m.index + m[0].length;
  const rest = source.slice(start);
  const next = rest.search(/^\s*\[/m);
  const table = next === -1 ? rest : rest.slice(0, next);
  let hits = 0;
  const pinned = table
    .replace(/^(\s*)url = "[^"]*"$/m, (_x, ws: string) => { hits++; return `${ws}url = "${pin.url}"`; })
    .replace(/^(\s*)sha256 = "[^"]*"$/m, (_x, ws: string) => { hits++; return `${ws}sha256 = "${pin.sha256}"`; });
  if (hits !== 2) throw new Error(`[resources.sources.${id}]: expected one url and one sha256 line, rewrote ${hits}`);
  return source.slice(0, start) + pinned + (next === -1 ? '' : rest.slice(next));
}

export function pinManifest(source: string, pins: Pins): string {
  let out = source;
  let hits = 0;
  out = out.replace(/^version = "[^"]*"$/m, () => { hits++; return `version = "${pins.version}~ynh${pins.ynhRev}"`; });
  if (hits !== 1) throw new Error('manifest.toml: expected exactly one version line');
  out = pinSource(out, 'main', pins.main);
  out = pinSource(out, 'shell', pins.shell);
  return out;
}

function readSource(source: string, id: string): SourcePin {
  const head = new RegExp(`^\\s*\\[resources\\.sources\\.${id}\\]\\s*\\n`, 'm');
  const m = head.exec(source);
  if (!m) throw new Error(`manifest.toml has no [resources.sources.${id}] table`);
  const rest = source.slice(m.index + m[0].length);
  const next = rest.search(/^\s*\[/m);
  const table = next === -1 ? rest : rest.slice(0, next);
  const url = /^\s*url = "([^"]+)"$/m.exec(table);
  const sha256 = /^\s*sha256 = "([0-9a-f]{64})"$/m.exec(table);
  if (!url || !sha256) throw new Error(`[resources.sources.${id}] is missing url or sha256`);
  return { url: url[1]!, sha256: sha256[1]! };
}

export function readPins(source: string): Pins {
  const version = /^version = "([^~"]+)~ynh(\d+)"$/m.exec(source);
  if (!version) throw new Error('manifest.toml has no pinned version');
  return { version: version[1]!, ynhRev: Number(version[2]), main: readSource(source, 'main'), shell: readSource(source, 'shell') };
}

/** The web shell's pin, as the open-source package's manifest states it. */
export function shellPinFrom(ossDir: string): SourcePin {
  const path = join(ossDir, 'deploy', 'yunohost', 'manifest.toml');
  if (!existsSync(path)) throw new Error(`no Lolly YunoHost manifest at ${path} - pass --oss <dir> or --shell-url/--shell-sha256`);
  const source = readFileSync(path, 'utf8');
  const url = /^\s*url = "([^"]+)"$/m.exec(source);
  const sha256 = /^\s*sha256 = "([0-9a-f]{64})"$/m.exec(source);
  if (!url || !sha256) throw new Error(`${path} carries no url + sha256 pin`);
  if (/^0{64}$/.test(sha256[1]!)) throw new Error(`${path} is not pinned yet (sha256 is the placeholder) - run the Lolly release first`);
  return { url: url[1]!, sha256: sha256[1]! };
}

export async function sha256File(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

function run(cmd: string, args: string[], input?: Buffer): Buffer {
  const r = spawnSync(cmd, args, { cwd: ROOT, input, maxBuffer: 1 << 30 });
  if (r.error) throw r.error;
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} exited ${r.status}: ${r.stderr.toString()}`);
  return r.stdout;
}

/** `git archive` HEAD without the excluded trees, gzipped, into outFile. */
export function archiveHead(version: string, outFile: string): void {
  const dirty = run('git', ['status', '--porcelain']).toString().trim();
  if (dirty) throw new Error(`working tree is dirty - commit first; a release tarball is a commit:\n${dirty}`);
  const tar = run('git', ['archive', '--format=tar', `--prefix=lolly-work-${version}/`, 'HEAD', ...EXCLUDED.map((d) => `:(exclude)${d}`)]);
  // Deterministic gzip (no name, mtime 0) so the same commit gives the same bytes.
  const gz = run('gzip', ['-9', '-n'], tar);
  writeFileSync(outFile, gz);
}

interface Args { publish: boolean; oss: string; shellUrl?: string; shellSha256?: string; ynhRev: number; out: string }

export function parseArgs(argv: string[]): Args {
  const a: Args = {
    publish: false, ynhRev: 1,
    oss: process.env.LOLLY_OSS_DIR ?? join(ROOT, '..', 'lolly'),
    out: process.env.LOLLY_RELEASE_OUT ?? join(homedir(), '.cache/lolly-release/artifacts'),
  };
  for (let i = 0; i < argv.length; i++) {
    const v = argv[i]!;
    if (v === '--publish') a.publish = true;
    else if (v === '--oss') a.oss = argv[++i]!;
    else if (v === '--shell-url') a.shellUrl = argv[++i];
    else if (v === '--shell-sha256') a.shellSha256 = argv[++i];
    else if (v === '--ynh-rev') a.ynhRev = Number(argv[++i]);
    else if (v === '--out') a.out = argv[++i]!;
    else throw new Error(`unknown argument ${v}`);
  }
  if ((a.shellUrl ? 1 : 0) + (a.shellSha256 ? 1 : 0) === 1) throw new Error('--shell-url and --shell-sha256 go together');
  if (a.shellSha256 && !/^[0-9a-f]{64}$/.test(a.shellSha256)) throw new Error('--shell-sha256 must be 64 hex characters');
  if (!Number.isInteger(a.ynhRev) || a.ynhRev < 1) throw new Error('--ynh-rev must be a positive integer');
  return a;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv);
  const version = upstreamVersion();
  const shell = args.shellUrl ? { url: args.shellUrl, sha256: args.shellSha256! } : shellPinFrom(args.oss);

  mkdirSync(args.out, { recursive: true });
  const name = tarballName(version);
  const outFile = join(args.out, name);
  console.log(`[yunohost-release] archiving HEAD -> ${outFile} (without ${EXCLUDED.join(', ')})`);
  archiveHead(version, outFile);
  const sha256 = await sha256File(outFile);
  console.log(`[yunohost-release] ${name}  ${(statSync(outFile).size / 1e6).toFixed(1)} MB  sha256 ${sha256}`);

  const pins: Pins = { version, ynhRev: args.ynhRev, main: { url: `${RELEASE_HOST}/${name}`, sha256 }, shell };
  writeFileSync(MANIFEST, pinManifest(readFileSync(MANIFEST, 'utf8'), pins));
  console.log(`[yunohost-release] pinned deploy/yunohost/manifest.toml -> ${version}~ynh${args.ynhRev}, shell ${shell.url}`);

  if (args.publish) {
    const lolli = join(args.oss, 'shells/tauri-desktop/release/lolli.py');
    if (!existsSync(lolli)) throw new Error(`no ${lolli} to upload with`);
    const r = spawnSync('python3', [lolli, 'put', outFile, name], { stdio: 'inherit' });
    if (r.status !== 0) throw new Error(`upload exited ${r.status}`);
  } else {
    console.log(`[yunohost-release] next: <lolly>/shells/tauri-desktop/release/lolli.py put ${outFile} ${name}`);
  }
  console.log('[yunohost-release] then mirror deploy/yunohost/ to github.com/lolly-tools/lolly-work_ynh (see deploy/yunohost/README.md)');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err: unknown) => { console.error(`[yunohost-release] ${(err as Error).message}`); process.exit(1); });
}
