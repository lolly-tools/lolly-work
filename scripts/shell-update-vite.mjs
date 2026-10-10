// SPDX-License-Identifier: MPL-2.0
/** Build with the exact source config and workspace graph; no install or signing. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export const workspaces = {
  '@lolly/engine': 'engine', '@lolly-tools/core': 'packages/core',
  '@lolly-tools/node-shell': 'packages/node-shell', '@lolly-tools/rondo': 'packages/rondo',
  '@lolly-tools/audio-dock': 'packages/audio-dock',
};
export function workspaceModule(id, source) {
  const normalized = id.replaceAll('\\', '/').split('?')[0];
  const hits = Object.values(workspaces).filter(directory => normalized.includes(`/${directory}/`));
  if (!hits.length) return null;
  if (!hits.some(directory => normalized.startsWith(`${source}/${directory}/`))) throw new Error('Workspace source escaped exact checkout');
  const actual = realpathSync(normalized), rel = relative(source, actual);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) throw new Error('Workspace symlink escaped exact checkout');
  return actual;
}
export function exactWorkspacePlugin(source, observed) {
  return { name: 'shell-update-exact-workspace-source', transform(_code, id) {
    const path = workspaceModule(id, source);
    if (path) { const bytes = readFileSync(path); observed.set(path, { path, bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }); }
  } };
}
export function workspaceAliases(source) {
  const aliases = [];
  for (const [name, directory] of Object.entries(workspaces)) {
    const pkg = JSON.parse(readFileSync(`${source}/${directory}/package.json`, 'utf8'));
    if (!pkg.exports || typeof pkg.exports !== 'object') throw new Error('Explicit workspace exports required');
    for (const [key, target] of Object.entries(pkg.exports)) {
      if (typeof target !== 'string' || !target.startsWith('./') || target.includes('..') || key.includes('*')
        || (key !== '.' && !key.startsWith('./'))) throw new Error('Unreviewed workspace export shape');
      const id = key === '.' ? name : `${name}/${key.slice(2)}`;
      aliases.push({ find: new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`), replacement: `${source}/${directory}/${target.slice(2)}` });
    }
  }
  return aliases;
}
export async function buildShell(input) {
  const { build } = await import(pathToFileURL(`${input.source}/node_modules/vite/dist/node/index.js`).href);
  const maintained = (await import(pathToFileURL(`${input.source}/shells/web/vite.config.js`).href)).default;
  if (!Array.isArray(maintained.plugins) || typeof maintained.worker?.plugins !== 'function') throw new Error('Maintained config contract changed');
  const observed = new Map();
  const baseAliases = Array.isArray(maintained.resolve?.alias) ? maintained.resolve.alias
    : Object.entries(maintained.resolve?.alias || {}).map(([find, replacement]) => ({ find, replacement }));
  await build({ ...maintained, root: resolve(input.source, 'shells/web'), configFile: false, configLoader: 'native', publicDir: input.prerequisites,
    resolve: { ...maintained.resolve, alias: [...workspaceAliases(input.source), ...baseAliases] },
    plugins: [...maintained.plugins, exactWorkspacePlugin(input.source, observed)],
    worker: { ...maintained.worker, plugins: () => [...maintained.worker.plugins(), exactWorkspacePlugin(input.source, observed)] },
    build: { ...maintained.build, outDir: input.output, copyPublicDir: false, emptyOutDir: false },
  });
  writeFileSync(input.moduleReceipt, `${JSON.stringify({ version: 1, source: input.source, modules: [...observed.values()].sort((a, b) => a.path.localeCompare(b.path)),
    guardIncludesWorkerGraph: true, normalCIQualified: false, productionAuthority: false }, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
}
if (process.argv[1] && realpathSync(process.argv[1]) === new URL(import.meta.url).pathname) {
  const [path, expected, ...extra] = process.argv.slice(2);
  if (!path || !/^[0-9a-f]{64}$/.test(expected || '') || extra.length) throw new Error('Exact runner input required');
  const bytes = readFileSync(path);
  if (createHash('sha256').update(bytes).digest('hex') !== expected) throw new Error('Runner input custody differs');
  await buildShell(JSON.parse(bytes));
}
