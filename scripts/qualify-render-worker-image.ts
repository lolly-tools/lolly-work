// SPDX-License-Identifier: MPL-2.0
/** Local/CI image acceptance. Uses a fresh test key, never an instance credential. */
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
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

export function main(args = process.argv.slice(2)): void {
  const { lollyRoot, image } = imageArguments(args);
  assert.equal(process.platform, 'linux', 'Install frozen Work dependencies on the Linux qualification host');
  assert.equal(process.arch, 'x64', 'This image acceptance currently covers Linux amd64');
  assert.equal(process.versions.node, '24.21.0', 'Use the worker Node version for this image acceptance');
  const source = matchedShell(JSON.parse(readFileSync(join(ROOT, 'engine-pin.json'), 'utf8')),
    output('git', ['rev-parse', 'HEAD'], lollyRoot), JSON.parse(readFileSync(join(lollyRoot, 'engine/package.json'), 'utf8')).version);
  assert.equal(output('git', ['status', '--porcelain', '--untracked-files=no'], lollyRoot), '', 'Use a clean isolated Lolly checkout');
  assert.ok(lollyRoot !== ROOT && !lollyRoot.startsWith(`${ROOT}/vendor/`));
  assert.ok(!process.env.DOCKER_HOST, 'Do not use an external Docker endpoint');
  const context = JSON.parse(output('docker', ['context', 'inspect']));
  assert.equal(context.length, 1);
  assert.match(context[0]?.Endpoints?.docker?.Host ?? '', /^unix:\/\//, 'Only a local Docker socket is allowed');
  const imageId = output('docker', ['image', 'inspect', image, '--format', '{{.Id}}']);
  assert.match(imageId, /^sha256:[a-f0-9]{64}$/);
  const key = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const privateMaterial = key.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
  const publicMaterial = JSON.stringify(key.publicKey.export({ format: 'jwk' }));
  const buildEnv: NodeJS.ProcessEnv = {};
  for (const name of ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR', 'PNPM_HOME']) if (process.env[name]) buildEnv[name] = process.env[name];
  Object.assign(buildEnv, { CI: 'true', LOLLY_PROFILE: 'lolly-start', VITE_REQUIRE_AI_POLICY: 'true',
    LOLLY_CATALOG_SIGNING_KEY: privateMaterial, VITE_CATALOG_PUBLIC_KEY_JWK: publicMaterial });
  const build = spawnSync('pnpm', ['run', 'build:web:release'], { cwd: lollyRoot, env: buildEnv, stdio: 'inherit', timeout: 20 * 60_000 });
  assert.ok(!build.error && build.status === 0, 'Matched signed shell build must succeed through the normal release gate');
  assert.equal(output('git', ['rev-parse', 'HEAD'], lollyRoot), source);
  assert.equal(output('git', ['status', '--porcelain', '--untracked-files=no'], lollyRoot), '', 'The build must preserve tracked source inputs');
  const owned = mkdtempSync(join(tmpdir(), 'lolly-worker-image-'));
  const cid = join(owned, 'container.cid'), label = randomUUID();
  const name = `lolly-worker-image-${label}`;
  writeFileSync(join(owned, 'custody.json'), JSON.stringify({ name, imageId, source, label }), { flag: 'wx', mode: 0o600 });
  let cleanupFailed = false;
  try {
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
  }
  console.log(JSON.stringify({ status: 'RENDER_WORKER_IMAGE_ACCEPTED', source, imageId,
    fixtureProfile: 'lolly-start', fixtureKey: 'ephemeral-test-only', browserSandboxQualified: false,
    productionAcceptance: false, physicalGpuQualification: false }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { main(); } catch { console.error('Worker image acceptance refused; inspect the bounded test assertions and owned container custody.'); process.exitCode = 1; }
}
