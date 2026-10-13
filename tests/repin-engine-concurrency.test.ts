// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const SCRIPT = fileURLToPath(new URL('../scripts/repin-engine.ts', import.meta.url));
function fixture(concurrency?: string, failTests = false) {
  const root = mkdtempSync(join(tmpdir(), 'lolly-repin-command-'));
  const write = (name: string, data: string) => {
    const target = join(root, name); mkdirSync(dirname(target), { recursive: true }); writeFileSync(target, data); return target;
  };
  const old = { generatedFrom: 'a'.repeat(40), engine: { version: '1.0.0' }, core: { version: '1.0.0' } };
  write('package.json', '{"type":"module"}');
  write('engine-pin.json', JSON.stringify(old)); write('pnpm-lock.yaml', 'original lock\n');
  for (const dir of ['vendor/@lolly/engine', 'vendor/@lolly-tools/core', 'vendor/@lolly/schemas']) write(`${dir}/original`, 'original bytes');
  mkdirSync(join(root, 'scripts')); cpSync(SCRIPT, join(root, 'scripts/repin-engine.ts'));
  const oss = join(root, 'oss');
  write('oss/engine/src/version.ts', "export const ENGINE_VERSION = '2.0.0';\n");
  write('oss/packages/core/package.json', '{"version":"2.0.0"}');
  write('oss/scripts/pack-engine.ts', '// replaced by fixture command\n');
  execFileSync('git', ['init', '-q', oss]);
  execFileSync('git', ['-C', oss, 'add', '.']);
  execFileSync('git', ['-C', oss, '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.test', '-c', 'core.hooksPath=/dev/null', 'commit', '-qm', 'fixture']);
  const revision = execFileSync('git', ['-C', oss, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  const manifest = { generatedFrom: revision, engine: { version: '2.0.0', tarball: 'engine.tgz' }, core: { version: '2.0.0', tarball: 'core.tgz' } };
  write('oss/dist/engine-pack/manifest.json', JSON.stringify(manifest));
  write('oss/dist/engine-pack/schemas/schema.json', '{}');
  write('archive/package/new', 'new bytes');
  for (const name of ['engine.tgz', 'core.tgz']) execFileSync('tar', ['czf', join(oss, 'dist/engine-pack', name), '-C', join(root, 'archive'), 'package']);
  const log = join(root, 'commands.jsonl');
  for (const command of ['node', 'pnpm']) {
    const source = write(`bin/${command}`, `#!${process.execPath}\nimport {appendFileSync} from 'node:fs';\nconst args=process.argv.slice(2);appendFileSync(${JSON.stringify(log)},JSON.stringify({command:${JSON.stringify(command)},args})+'\\n');\nif(${JSON.stringify(failTests)}&&${JSON.stringify(command)}==='node'&&args[0]==='--test')process.exit(1);\n`);
    chmodSync(source, 0o755);
  }
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: join(root, 'bin') + ':' + process.env.PATH, LOLLY_OSS_DIR: oss };
  delete env.LOLLY_REPIN_TEST_FAIL;
  delete env.LOLLY_REPIN_TEST_CONCURRENCY;
  if (concurrency !== undefined) env.LOLLY_REPIN_TEST_CONCURRENCY = concurrency;
  try {
    const result = spawnSync(process.execPath, [join(root, 'scripts/repin-engine.ts'), '--apply'], { cwd: root, env, encoding: 'utf8', timeout: 15_000 });
    const calls = readFileSync(log, 'utf8').trim().split('\n').map((line: string) => JSON.parse(line) as { command: string; args: string[] });
    return { result, calls, pin: JSON.parse(readFileSync(join(root, 'engine-pin.json'), 'utf8')), old, manifest };
  } finally { rmSync(root, { recursive: true, force: true }); }
}

test('bounded repin runs pretest then places concurrency before the complete Node test pattern', () => {
  const f = fixture('2'); assert.equal(f.result.status, 0, f.result.stderr);
  const tail = f.calls.slice(-2);
  assert.deepEqual(tail, [{ command: 'pnpm', args: ['run', 'pretest'] }, { command: 'node', args: ['--test', '--test-concurrency=2', 'tests/**/*.test.ts'] }]);
  assert.deepEqual(f.pin, f.manifest);
});
test('default repin retains the package test lifecycle', () => {
  const f = fixture(); assert.equal(f.result.status, 0, f.result.stderr);
  assert.deepEqual(f.calls.at(-1), { command: 'pnpm', args: ['test'] });
});
test('bounded test failure still restores the original pin', () => {
  const f = fixture('2', true); assert.notEqual(f.result.status, 0); assert.deepEqual(f.pin, f.old);
});
test('invalid concurrency refuses before invoking tests and restores the original pin', () => {
  for (const value of ['0', '100', '2 --test-only']) {
    const f = fixture(value); assert.notEqual(f.result.status, 0); assert.deepEqual(f.pin, f.old);
    assert.ok(!f.calls.some(({ args }) => args.includes('--test') || args[0] === 'test'));
  }
});
