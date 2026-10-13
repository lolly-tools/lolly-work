// SPDX-License-Identifier: MPL-2.0
import { spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { transformSync } from 'esbuild';
import { tmpdir } from 'node:os';
import { join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const rules = join(root, '.github/opengrep/work-rules.yml');
const executable = process.env.OPENGREP_BIN || 'opengrep';
const run = (args: string[]) => spawnSync(executable, args, { cwd: root, encoding: 'utf8', timeout: 240000, maxBuffer: 8 * 1024 * 1024 });
const compile = (source: string, loader: 'ts' | 'js') => transformSync(source, {
  loader, target: 'es2018', supported: { 'top-level-await': true, 'template-literal': false }, format: 'esm', logLevel: 'silent',
}).code;

export function main(): void {
  const version = run(['--version']);
  if (version.status !== 0 || version.stdout.trim() !== '1.26.0') throw new Error('Opengrep 1.26.0 is required');
  const dir = mkdtempSync(join(tmpdir(), 'work-code-canary-'));
  try {
    const sample = join(dir, 'sample.ts');
    writeFileSync(sample, compile("const tls={rejectUnauthorized:false}; const command={shell:true}; fetch('https://example.invalid',{headers:{authorization:'example'},redirect:'follow'});\n", 'ts'), { mode: 0o600 });
    const canary = run(['scan', '--error', '--no-git-ignore', '--config', rules, '--json', sample]);
    const results = JSON.parse(canary.stdout) as { results?: Array<{ check_id: string }>; errors?: unknown[] };
    const ids = results.results?.map(result => result.check_id.split('.').at(-1)).sort();
    if (canary.status !== 1 || results.errors?.length || JSON.stringify(ids) !== JSON.stringify([
      'work-credential-redirects', 'work-direct-process-arguments', 'work-verified-tls',
    ])) throw new Error('Code scanner failed its detection canaries');
  } finally { rmSync(dir, { recursive: true, force: true }); }
  const projection = mkdtempSync(join(tmpdir(), 'work-code-source-'));
  try {
    let count = 0;
    const copy = (directory: string) => {
      for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
          if (!['node_modules', 'dist', 'vendor', '.git'].includes(entry.name)) copy(path);
        } else if (entry.isFile() && /\.(ts|js|mjs)$/.test(path) && !/\.test\.(ts|js)$/.test(path)) {
          const source = readFileSync(join(root, path), 'utf8');
          // Compile modern syntax without minifying property names or values.
          // Every emitted file must parse completely before accepting a scan.
          const bytes = compile(source, path.endsWith('.ts') ? 'ts' : 'js');
          const destination = join(projection, path.replace(/\.ts$/, '.js'));
          mkdirSync(join(destination, '..'), { recursive: true });
          writeFileSync(destination, bytes, { flag: 'wx' }); count++;
        }
      }
    };
    for (const directory of ['server', 'workers', 'cli', 'scripts']) copy(directory);
    const result = run(['scan', '--error', '--no-git-ignore', '--jobs', '2', '--max-memory', '2048', '--timeout', '60', '--config', rules, '--json', projection]);
    if (result.error || ![0, 1].includes(result.status ?? -1)) throw new Error('Code scanner did not complete');
    const report = JSON.parse(result.stdout) as { results: Array<{ check_id: string; path: string; start: { line: number } }>; errors: unknown[]; paths: { scanned: string[] } };
    if (report.errors.length || report.paths.scanned.length !== count) {
      console.error(JSON.stringify({ expected: count, scanned: report.paths.scanned.length, parserErrors: report.errors.map(value => {
        const error = value as { type?: string | [string]; path?: string; spans?: Array<{ start?: { line?: number } }> };
        return { type: typeof error.type === 'string' ? error.type : error.type?.[0], source: error.path ? relative(projection, error.path) : undefined, line: error.spans?.[0]?.start?.line };
      }) }));
      throw new Error('Code scanner did not fully parse the source inventory');
    }
    for (const finding of report.results) console.error(JSON.stringify({ rule: finding.check_id, source: relative(projection, finding.path), generatedLine: finding.start.line }));
    if (result.status !== 0 || report.results.length) throw new Error('Code scan did not pass');
    console.log(`Code scan passed: ${count} source files, three rules, complete parser coverage.`);
  } finally { rmSync(projection, { recursive: true, force: true }); }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { main(); } catch (error) { console.error((error as Error).message); process.exitCode = 1; }
}
