// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import type { IncomingHttpHeaders } from 'node:http';
import { checkServerIdentity } from 'node:tls';
import { createHash, randomBytes } from 'node:crypto';
import { parse, stringify } from 'yaml';
import { prepareInstance } from './prepare-marketplace-instance.ts';
import { release } from './marketplace-packages.ts';
import { captureListingScreenshots } from './capture-marketplace-screenshots.ts';

if (!process.env.LW_MARKETPLACE_RECEIPT) throw new Error('Set LW_MARKETPLACE_RECEIPT to retain the qualification result');
// Docker, uname and Node each spell the two release architectures differently.
const nativeNames: Record<string, string> = { amd64: 'amd64', x86_64: 'amd64', x64: 'amd64', arm64: 'arm64', aarch64: 'arm64' };
const dockerArchitecture = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
const architecture = nativeNames[dockerArchitecture];
if (!architecture) throw new Error(`This qualification target requires native amd64 or arm64; Docker reports ${dockerArchitecture}`);
const expectedArchitecture = process.env.LW_MARKETPLACE_ARCHITECTURE;
if (expectedArchitecture && expectedArchitecture !== architecture) throw new Error(`This qualification target requires native ${expectedArchitecture}; Docker reports ${dockerArchitecture}`);
const directory = mkdtempSync(join(tmpdir(), 'lolly-compose-qualification-'));
const installation = join(directory, 'instance'), project = `lolly-marketplace-${process.pid}`;
prepareInstance(installation, { LOLLY_DOMAIN: 'work.example.test', LOLLY_OWNER_EMAIL: 'owner@example.test' });
const compose = parse(readFileSync(join(installation, 'compose.yaml'), 'utf8'));
const packageComposeSha256 = createHash('sha256').update(readFileSync(join(installation, 'compose.yaml'))).digest('hex');
compose.services.caddy.ports = ['127.0.0.1::443'];
writeFileSync(join(installation, 'compose.yaml'), stringify(compose, { lineWidth: 0 }));
writeFileSync(join(installation, 'Caddyfile'), 'work.example.test {\n  tls internal\n  reverse_proxy server:8787\n}\n');
const docker = (args: string[], input?: string | Buffer) => execFileSync('docker', ['compose', '--project-name', project, ...args], { cwd: installation, encoding: 'utf8', input, timeout: 1200000, maxBuffer: 8 * 1024 * 1024 });
const sql = (query: string, database = 'lollywork') => docker(['exec', '-T', 'db', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'lolly', '-d', database, '-c', query]).trim();
let port = 0, ca = '';
const probe = (path: string, method = 'GET', headers: Record<string, string> = {}, body?: string) => new Promise<{ status: number; body: string; headers: IncomingHttpHeaders }>((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, servername: 'work.example.test', path,
    method, ca, headers: { Host: 'work.example.test', ...headers }, checkServerIdentity: (_, cert) => checkServerIdentity('work.example.test', cert), timeout: 10000 }, response => {
    let result = ''; response.setEncoding('utf8');
    response.on('data', chunk => { result += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body: result, headers: response.headers }));
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS probe timed out'))); req.end(body);
});
const cookieOf = (response: Awaited<ReturnType<typeof probe>>, name: string) => response.headers['set-cookie']?.find(value => value.startsWith(name + '='))?.split(';')[0] ?? '';
async function submitForm(path: string, action: string, fields: Record<string, string>) {
  const form = await probe(path);
  assert.equal(form.status, 200, 'the native sign-in form is available');
  const csrf = /name="csrf" value="([^"]+)"/.exec(form.body)?.[1];
  assert.ok(csrf, 'the sign-in form includes CSRF protection');
  return probe(action, 'POST', { cookie: cookieOf(form, 'lw_form'), origin: 'https://work.example.test',
    'sec-fetch-site': 'same-origin', 'content-type': 'application/x-www-form-urlencoded' }, new URLSearchParams({ ...fields, csrf }).toString());
}
async function assertOwner(cookie: string) {
  assert.ok(cookie, 'native sign-in returns a session cookie');
  const response = await probe('/api/auth/session', 'GET', { cookie });
  assert.equal(response.status, 200);
  const { user } = JSON.parse(response.body);
  assert.deepEqual([user.email, user.role], ['owner@example.test', 'owner']);
}
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await probe('/healthz'); if (response.status === 200) return; } catch { /* bounded startup retry */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Work failed to become healthy behind the trusted HTTPS proxy');
}
try {
  docker(['config', '--quiet']);
  // Shared runners can exhaust anonymous registry bursts. Cache sequential pulls
  // and retry only registry throttling, never an application startup failure.
  for (let attempt = 0; ; attempt++) {
    try { docker(['--parallel', '1', 'pull', '--policy', 'missing']); break; }
    catch (error) {
      const stderr = (error as { stderr?: string }).stderr ?? '';
      if (attempt >= 2 || !/toomanyrequests|rate exceeded|429/i.test(stderr)) throw error;
      console.log('Registry throttled an anonymous pull; retrying the missing images.');
      await new Promise(resolve => setTimeout(resolve, 15000 * (attempt + 1)));
    }
  }
  docker(['up', '-d', '--pull', 'never', '--wait', '--wait-timeout', '900']);
  const address = docker(['port', 'caddy', '443']).trim();
  port = Number(address.split(':').at(-1)); assert.ok(port > 0);
  ca = docker(['exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt']);
  // An emulated image reports its own machine, so this refuses a run that only
  // worked through binfmt emulation. Content init uses the server image.
  for (const [service, command] of [['server', ['node', '-p', 'process.arch']], ['db', ['uname', '-m']], ['caddy', ['uname', '-m']]] as const) {
    assert.equal(nativeNames[docker(['exec', '-T', service, ...command]).trim()], architecture, `${service} runs the native ${architecture} image`);
  }
  await ready();
  assert.equal((await probe('/')).status, 200, 'the matched web shell is served');
  assert.ok([401, 403].includes((await probe('/catalog/tools/index.json')).status), 'private catalogue refuses anonymous access');
  assert.notEqual((await probe('/api/auth/dev?email=owner@example.test')).status, 200, 'no development owner bypass');
  const output = docker(['exec', '-T', 'server', 'node', 'scripts/password-link.ts', '--email', 'owner@example.test']);
  const link = output.split('\n').find(line => line.startsWith('https://work.example.test/api/auth/password/set?token='));
  assert.ok(link, 'the host operator can issue the named first owner link');
  const url = new URL(link), password = randomBytes(32).toString('hex');
  const setup = await submitForm(url.pathname + url.search, '/api/auth/password/set', { token: url.searchParams.get('token') ?? '', password, confirm: password });
  assert.equal(setup.status, 303, 'the owner can set a password');
  const ownerCookie = cookieOf(setup, 'lw_session');
  await assertOwner(ownerCookie);
  assert.equal((await probe('/catalog/tools/index.json', 'GET', { cookie: ownerCookie })).status, 200, 'the signed source catalogue verifies for its admitted owner');
  const rendered = await probe('/api/v1/render', 'POST', { cookie: ownerCookie, origin: 'https://work.example.test', 'content-type': 'application/json' },
    JSON.stringify({ toolId: 'asset-export', format: 'svg', inputs: { background: '#205080', width: 240, height: 120 } }));
  assert.equal(rendered.status, 200, 'the neutral no-hook tool exports without a Chromium worker');
  assert.ok(rendered.body.includes('<svg') && rendered.body.includes('#205080'), 'the SVG contains the selected colour');
  assert.equal((await probe(url.pathname + url.search)).status, 410, 'the owner link is single-use');
  // Optional listing captures, taken before the restart renames the instance. A capture
  // failure is reported after the qualification checks finish, never instead of them.
  let captureError: unknown;
  if (process.env.LW_MARKETPLACE_SCREENSHOTS) {
    try {
      const files = await captureListingScreenshots({ port, domain: 'work.example.test', caPem: ca, email: 'owner@example.test', password,
        outDir: process.env.LW_MARKETPLACE_SCREENSHOTS, release, source: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim() });
      console.log(`Captured ${files.length} listing screenshots`);
    } catch (error) { captureError = error; }
  }
  const keyHash = () => createHash('sha256').update(docker(['exec', '-T', 'server', 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync("/app/keys/catalog.jwk"))'])).digest('hex');
  const key = keyHash();
  docker(['exec', '-T', 'server', 'node', '-e', 'const fs=require("node:fs"),path="/app/state/instance.json",config=JSON.parse(fs.readFileSync(path));config.instance.name="Persisted qualification";fs.writeFileSync(path,JSON.stringify(config));']);
  docker(['restart', 'server']); await ready();
  await assertOwner(ownerCookie);
  const login = await submitForm('/api/auth/login?returnTo=%2Fadmin', '/api/auth/password/login', { email: 'owner@example.test', password, returnTo: '/admin' });
  assert.equal(login.status, 303, 'the owner can sign in again after restart');
  await assertOwner(cookieOf(login, 'lw_session'));
  assert.equal(keyHash(), key);
  assert.equal(JSON.parse((await probe('/healthz')).body).name, 'Persisted qualification');
  // The dump remains binary. Never route it through the UTF-8 command helper.
  const dump = execFileSync('docker', ['compose', '--project-name', project, 'exec', '-T', 'db', 'pg_dump', '-U', 'lolly', '-d', 'lollywork', '-Fc'], { cwd: installation, maxBuffer: 64 * 1024 * 1024 });
  docker(['exec', '-T', 'db', 'createdb', '-U', 'lolly', 'qualification_restore']);
  docker(['exec', '-T', 'db', 'pg_restore', '-U', 'lolly', '-d', 'qualification_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'], dump);
  assert.equal(sql("SELECT count(*) FROM users WHERE email='owner@example.test'", 'qualification_restore'), '1');
  assert.equal(sql('SELECT count(*) FROM password_credentials', 'qualification_restore'), '1');
  const receipt = { status: 'CONTAINER_INSTALL_HTTPS_NATIVE_OWNER_PRIVATE_ACCESS_RESTART_AND_DATABASE_RESTORE_VERIFIED', release,
    packageSource: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(), packageComposeSha256,
    qualificationComposeSha256: createHash('sha256').update(readFileSync(join(installation, 'compose.yaml'))).digest('hex'),
    actualCustomerIdentity: 'NOT_TESTED', crossVersionUpgrade: 'NOT_TESTED', cloudProvider: 'NOT_TESTED', nativeArchitecture: architecture };
  writeFileSync(process.env.LW_MARKETPLACE_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  console.log(receipt.status);
  if (captureError) throw captureError;
} finally {
  // This project name and all its volumes were created above for this one run.
  docker(['down', '--volumes', '--remove-orphans']);
}
