// SPDX-License-Identifier: MPL-2.0
/**
 * Materialise an instance pack (tools/ + catalog/) from a Lolly checkout at a
 * recorded commit, for bundling into a deployment (deploy/vercel/README.md,
 * "Private instance with the Lolly app").
 *
 *   node scripts/build-instance-pack.ts --lolly <checkout> --profile <name> --out <dir>
 *     [--exclude <catalog subdir>]... [--allow-dirty] [--node <path>]
 *
 * The copy is made by the checkout's own resolver
 * (packages/node-shell/src/content-roots.ts `materializeInto`), run as a child
 * process from inside that checkout, so its workspace resolution, profiles and
 * overlay rules apply exactly as they do for that commit's own builds. The
 * result is real files with no symbolic links.
 *
 * `.lolly-pack-source.json` records where the pack came from: the checkout's
 * commit, the profile, any initialised submodule commits and what was excluded.
 * A checkout with uncommitted changes is refused unless --allow-dirty, because
 * the recorded commit would then not describe the bytes.
 *
 * `--exclude og` drops catalog/og (social preview images the control plane never
 * serves). Each value is a path under catalog/. Asset index formats whose URL
 * points into an excluded path are removed with it, and an asset left with no
 * format is removed too; both are listed in the provenance as `prunedAssets`.
 * Without this the boot check (server/src/setup/pack.ts), which stats every
 * /catalog/ format URL, would refuse the pack in production. Excluding a path
 * the index references therefore removes those assets from the instance.
 *
 * The pack's build-time catalog signature (catalog/tools/index.sig.json) is not
 * carried: the server re-serialises the tool index per caller, so that envelope
 * can never match what a caller receives, and its `files` map names every tool.
 * With LW_CATALOG_SIGNING_KEY the server signs per caller instead.
 *
 * While the script runs, `.lolly-pack-source.json` says `incomplete: true`, so a
 * rebuild that fails partway never leaves the previous build's record describing
 * new or partial bytes. The full record replaces it only after the copy, the
 * exclusions and the link check have all succeeded.
 *
 * Finally the pack is checked with scripts/inspect-pack.ts against the vendored
 * engine; the exit code is non-zero when that check fails.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const SOURCE_FILE = '.lolly-pack-source.json';

export interface PackArgs {
  lolly: string;
  profile: string;
  out: string;
  exclude: string[];
  allowDirty: boolean;
  node: string;
}

export function parseArgs(argv: string[]): PackArgs {
  const args: Partial<PackArgs> & { exclude: string[] } = { exclude: [], allowDirty: false, node: process.execPath };
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i]!;
    const value = (): string => {
      const v = argv[++i];
      if (!v || v.startsWith('--')) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--lolly') args.lolly = resolve(value());
    else if (flag === '--profile') args.profile = value();
    else if (flag === '--out') args.out = resolve(value());
    else if (flag === '--exclude') args.exclude.push(value());
    else if (flag === '--allow-dirty') args.allowDirty = true;
    else if (flag === '--node') args.node = value();
    else throw new Error(`unknown flag ${flag}`);
  }
  if (!args.lolly || !args.profile || !args.out) {
    throw new Error('usage: build-instance-pack.ts --lolly <checkout> --profile <name> --out <dir> [--exclude <catalog subdir>]... [--allow-dirty] [--node <path>]');
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(args.profile)) throw new Error('--profile must be a profile name from the checkout\'s profiles.json');
  for (const ex of args.exclude) {
    if (!/^[a-z0-9][a-z0-9._-]*(\/[a-z0-9][a-z0-9._-]*)*$/i.test(ex)) throw new Error(`--exclude ${ex}: give a path under catalog/, such as og`);
  }
  const rel = relative(args.lolly, args.out);
  if (!rel || !rel.startsWith('..')) throw new Error('--out must be outside the Lolly checkout');
  return args as PackArgs;
}

function git(cwd: string, ...args: string[]): string {
  const r = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${(r.stderr || '').trim()}`);
  return r.stdout.trim();
}

/** Every symbolic link under `dir`, relative to it. */
export function symlinksUnder(dir: string): string[] {
  const found: string[] = [];
  const walk = (d: string): void => {
    for (const entry of readdirSync(d, { withFileTypes: true })) {
      const path = join(d, entry.name);
      if (lstatSync(path).isSymbolicLink()) found.push(relative(dir, path));
      else if (entry.isDirectory()) walk(path);
    }
  };
  walk(dir);
  return found;
}

const SIGNATURE_REL = 'catalog/tools/index.sig.json';

/** Why a pack directory must not be deployed, or null. A pack this script is
 *  still building, or whose build failed partway, says so in its record. */
export function incompletePackReason(dir: string): string | null {
  let record: { incomplete?: unknown };
  try {
    record = JSON.parse(readFileSync(join(dir, SOURCE_FILE), 'utf8')) as { incomplete?: unknown };
  } catch {
    return null; // no record: not built by this script (packs/demo, an extracted .lolly)
  }
  return record.incomplete === true
    ? `${SOURCE_FILE} says the pack build did not finish; rebuild it with scripts/build-instance-pack.ts`
    : null;
}

interface AssetIndexLike { assets?: unknown; [key: string]: unknown }
export interface PrunedAsset { id: string; removed: boolean }

/** Drop asset formats whose `/catalog/` URL points into an excluded path (each a
 *  path under catalog/), and assets left with no format. Pure. */
export function pruneAssetIndex(index: AssetIndexLike, excluded: readonly string[]): { index: AssetIndexLike; pruned: PrunedAsset[] } {
  const inExcluded = (url: unknown): boolean => typeof url === 'string'
    && excluded.some((ex) => url === `/catalog/${ex}` || url.startsWith(`/catalog/${ex}/`));
  if (!Array.isArray(index.assets) || !excluded.length) return { index, pruned: [] };
  const pruned: PrunedAsset[] = [];
  const assets: unknown[] = [];
  for (const asset of index.assets as Array<{ id?: unknown; formats?: unknown }>) {
    const formats = Array.isArray(asset?.formats) ? asset.formats as Array<{ url?: unknown }> : null;
    const kept = formats?.filter((f) => !inExcluded(f?.url));
    if (!formats || !kept || kept.length === formats.length) {
      assets.push(asset);
      continue;
    }
    const id = String(asset.id);
    if (kept.length) {
      assets.push({ ...asset, formats: kept });
      pruned.push({ id, removed: false });
    } else {
      pruned.push({ id, removed: true });
    }
  }
  return { index: { ...index, assets }, pruned };
}

// Runs inside the checkout. argv: content-roots module URL, out dir, profile, checkout root.
const CHILD = `
const [url, out, profile, root] = process.argv.slice(1);
const m = await import(url);
const roots = m.contentRoots({ profile, root });
m.materializeInto(out, roots);
process.stdout.write(JSON.stringify({ profile: roots.profile }) + '\\n');
`;

export async function main(argv = process.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv);
  const resolver = join(args.lolly, 'packages', 'node-shell', 'src', 'content-roots.ts');
  if (!existsSync(resolver)) throw new Error(`${args.lolly} is not a Lolly checkout (no packages/node-shell/src/content-roots.ts)`);
  if (existsSync(args.out) && readdirSync(args.out).length && !existsSync(join(args.out, SOURCE_FILE))) {
    throw new Error(`--out ${args.out} is not empty and is not a pack this script built; choose an empty directory`);
  }

  const commit = git(args.lolly, 'rev-parse', 'HEAD');
  const dirty = git(args.lolly, 'status', '--porcelain') !== '';
  if (dirty && !args.allowDirty) {
    console.error(`[build-instance-pack] ${args.lolly} has uncommitted changes, so commit ${commit.slice(0, 12)} would not describe the pack.`);
    console.error('[build-instance-pack] Use a clean checkout at the commit you deploy, or pass --allow-dirty for a local trial.');
    return 1;
  }
  const submodules = git(args.lolly, 'submodule', 'status', '--recursive').split('\n')
    .map((line) => /^([ +U])([0-9a-f]{7,64}) (\S+)/.exec(line))
    .filter((m): m is RegExpExecArray => !!m)
    .map((m) => ({ path: m[3]!, commit: m[2]!, ...(m[1] !== ' ' ? { differsFromIndex: true } : {}) }));
  const nvmrc = join(args.lolly, '.nvmrc');
  if (existsSync(nvmrc)) {
    const want = readFileSync(nvmrc, 'utf8').trim().replace(/^v/, '').split('.')[0];
    const have = spawnSync(args.node, ['-p', 'process.versions.node'], { encoding: 'utf8' }).stdout.trim().split('.')[0];
    if (want && have && want !== have) console.warn(`[build-instance-pack] the checkout asks for Node ${want} (.nvmrc); ${args.node} is Node ${have}. Pass --node to use another binary.`);
  }

  // From here until the full record is written, the pack is not what any earlier
  // record described.
  mkdirSync(args.out, { recursive: true });
  writeFileSync(join(args.out, SOURCE_FILE), JSON.stringify({
    version: 1, source: 'lolly', incomplete: true, commit, profile: args.profile, startedAt: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log(`[build-instance-pack] materialising profile ${args.profile} from ${args.lolly} @ ${commit.slice(0, 12)}${dirty ? ' (dirty)' : ''}`);
  const child = spawnSync(args.node, ['--input-type=module', '-e', CHILD, pathToFileURL(resolver).href, args.out, args.profile, args.lolly], {
    cwd: args.lolly, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'],
    env: { ...process.env, LOLLY_PROFILE: args.profile },
  });
  if (child.status !== 0) {
    console.error(`[build-instance-pack] the checkout's resolver failed (exit ${child.status})`);
    return 1;
  }
  const resolved = JSON.parse(child.stdout.trim().split('\n').at(-1) ?? '{}') as { profile?: string };
  if (resolved.profile !== args.profile) throw new Error(`the resolver materialised profile ${resolved.profile ?? '(none)'}, not ${args.profile}`);

  for (const ex of args.exclude) rmSync(join(args.out, 'catalog', ...ex.split('/')), { recursive: true, force: true });
  let prunedAssets: PrunedAsset[] = [];
  const assetIndexPath = join(args.out, 'catalog', 'assets', 'index.json');
  if (args.exclude.length && existsSync(assetIndexPath)) {
    const { index, pruned } = pruneAssetIndex(JSON.parse(readFileSync(assetIndexPath, 'utf8')) as AssetIndexLike, args.exclude);
    if (pruned.length) {
      writeFileSync(assetIndexPath, JSON.stringify(index, null, 2) + '\n');
      prunedAssets = pruned;
      console.warn(`[build-instance-pack] ${pruned.filter((p) => p.removed).length} assets removed and ${pruned.filter((p) => !p.removed).length} trimmed from catalog/assets/index.json because their files were excluded: ${pruned.slice(0, 5).map((p) => p.id).join(', ')}${pruned.length > 5 ? ', ...' : ''}`);
    }
  }
  const removed: string[] = [];
  if (existsSync(join(args.out, ...SIGNATURE_REL.split('/')))) {
    rmSync(join(args.out, ...SIGNATURE_REL.split('/')));
    removed.push(SIGNATURE_REL);
  }
  const links = symlinksUnder(args.out);
  if (links.length) throw new Error(`the materialised pack still holds symbolic links: ${links.slice(0, 5).join(', ')}`);

  writeFileSync(join(args.out, SOURCE_FILE), JSON.stringify({
    version: 1, source: 'lolly', commit, profile: args.profile, dirty,
    ...(submodules.length ? { submodules } : {}),
    ...(args.exclude.length ? { excluded: args.exclude.map((e) => `catalog/${e}`) } : {}),
    ...(prunedAssets.length ? { prunedAssets } : {}),
    ...(removed.length ? { removed } : {}),
    builtAt: new Date().toISOString(),
  }, null, 2) + '\n');

  console.log('[build-instance-pack] checking the pack against the vendored engine (scripts/inspect-pack.ts)');
  const env = { ...process.env };
  delete env.LW_CONFIG;
  const inspect = spawnSync(process.execPath, [join(ROOT, 'scripts', 'inspect-pack.ts'), args.out], {
    cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], env, maxBuffer: 64 * 1024 * 1024,
  });
  let summary = '';
  try {
    // The engine may print a notice line before the report; the report is the
    // pretty-printed object that starts at the first line holding only "{".
    const start = inspect.stdout.startsWith('{\n') ? 0 : inspect.stdout.indexOf('\n{\n') + 1;
    const report = JSON.parse(inspect.stdout.slice(start)) as { compatible: boolean; engine: string; tools: Array<{ id: string; valid: boolean; diagnostics: string[] }>; diagnostics: string[] };
    const invalid = report.tools.filter((t) => !t.valid);
    summary = `${report.tools.length} tools, engine ${report.engine}, ${report.compatible ? 'compatible' : 'NOT compatible'}`;
    for (const t of invalid) console.error(`[build-instance-pack] tool ${t.id}: ${t.diagnostics.join(' ')}`);
    for (const d of report.diagnostics) console.error(`[build-instance-pack] ${d}`);
    if (invalid.length) console.error('[build-instance-pack] A tool that needs a newer engine than vendor/@lolly/engine means the pin is behind this commit: repin the engine from the same Lolly commit (npm run repin-engine) before deploying, or a production boot refuses the pack.');
  } catch {
    summary = 'inspect-pack produced no readable report';
  }
  console.log(`[build-instance-pack] ${args.out}: ${summary}`);
  return inspect.status === 0 ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    process.exitCode = await main();
  } catch (err) {
    console.error(`[build-instance-pack] ${(err as Error).message}`);
    process.exitCode = 1;
  }
}
