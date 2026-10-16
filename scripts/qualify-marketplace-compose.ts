// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { checkServerIdentity } from 'node:tls';
import { parse, stringify } from 'yaml';
import { prepareInstance } from './prepare-marketplace-instance.ts';
import { release } from './marketplace-packages.ts';

if (!process.env.LW_MARKETPLACE_RECEIPT) throw new Error('Set LW_MARKETPLACE_RECEIPT to retain the qualification result');
const architecture = execFileSync('docker', ['info', '--format', '{{.Architecture}}'], { encoding: 'utf8' }).trim();
if (!['amd64', 'x86_64'].includes(architecture)) throw new Error('This qualification target requires native amd64');
const directory = mkdtempSync(join(tmpdir(), 'lolly-compose-qualification-'));
const installation = join(directory, 'instance'), project = `lolly-marketplace-${process.pid}`;
prepareInstance(installation, { LOLLY_DOMAIN: 'work.example.test', LOLLY_OIDC_ISSUER: 'https://identity.example.test', LOLLY_OIDC_CLIENT_ID: 'qualification-client', LOLLY_OWNER_EMAIL: 'owner@example.test' });
const compose = parse(readFileSync(join(installation, 'compose.yaml'), 'utf8'));
compose.services.caddy.ports = ['127.0.0.1::443'];
writeFileSync(join(installation, 'compose.yaml'), stringify(compose, { lineWidth: 0 }));
writeFileSync(join(installation, 'Caddyfile'), 'work.example.test {\n  tls internal\n  reverse_proxy server:8787\n}\n');
const docker = (args: string[], input?: string | Buffer) => execFileSync('docker', ['compose', '--project-name', project, ...args], { cwd: installation, encoding: 'utf8', input, timeout: 1200000, maxBuffer: 8 * 1024 * 1024 });
const sql = (query: string, database = 'lollywork') => docker(['exec', '-T', 'db', 'psql', '-X', '-qAt', '-v', 'ON_ERROR_STOP=1', '-U', 'lolly', '-d', database, '-c', query]).trim();
let port = 0, ca = '';
const get = (path: string) => new Promise<{ status: number; body: string }>((resolve, reject) => {
  const req = request({ hostname: '127.0.0.1', port, servername: 'work.example.test', path,
    ca, headers: { Host: 'work.example.test' }, checkServerIdentity: (_, cert) => checkServerIdentity('work.example.test', cert), timeout: 10000 }, response => {
    let body = ''; response.setEncoding('utf8');
    response.on('data', chunk => { body += chunk; }); response.on('end', () => resolve({ status: response.statusCode ?? 0, body }));
  });
  req.on('error', reject); req.on('timeout', () => req.destroy(new Error('HTTPS probe timed out'))); req.end();
});
async function ready() {
  for (let attempt = 0; attempt < 60; attempt++) {
    try { const response = await get('/healthz'); if (response.status === 200) return; } catch { /* bounded startup retry */ }
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
  throw new Error('Work failed to become healthy behind the trusted HTTPS proxy');
}
try {
  docker(['config', '--quiet']);
  docker(['up', '-d', '--wait', '--wait-timeout', '900']);
  const address = docker(['port', 'caddy', '443']).trim();
  port = Number(address.split(':').at(-1)); assert.ok(port > 0);
  ca = docker(['exec', '-T', 'caddy', 'cat', '/data/caddy/pki/authorities/local/root.crt']);
  await ready();
  assert.equal((await get('/')).status, 200, 'the matched web shell is served');
  assert.ok([401, 403].includes((await get('/catalog/tools/index.json')).status), 'private catalogue refuses anonymous access');
  assert.notEqual((await get('/api/auth/dev?email=owner@example.test')).status, 200, 'no development owner bypass');
  sql("INSERT INTO users (id,sub,email,groups,role) VALUES ('qualification-member','qualification-member','fixture@example.test','[]','member')");
  const key = docker(['exec', '-T', 'server', 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync("/app/keys/catalog.jwk"))']);
  docker(['restart', 'server']); await ready();
  assert.equal(sql("SELECT email FROM users WHERE id='qualification-member'"), 'fixture@example.test');
  assert.equal(docker(['exec', '-T', 'server', 'node', '-e', 'process.stdout.write(require("node:fs").readFileSync("/app/keys/catalog.jwk"))']), key);
  // The dump remains binary. Never route it through the UTF-8 command helper.
  const dump = execFileSync('docker', ['compose', '--project-name', project, 'exec', '-T', 'db', 'pg_dump', '-U', 'lolly', '-d', 'lollywork', '-Fc'], { cwd: installation, maxBuffer: 64 * 1024 * 1024 });
  docker(['exec', '-T', 'db', 'createdb', '-U', 'lolly', 'qualification_restore']);
  docker(['exec', '-T', 'db', 'pg_restore', '-U', 'lolly', '-d', 'qualification_restore', '--exit-on-error', '--single-transaction', '--no-owner', '--no-privileges'], dump);
  assert.equal(sql("SELECT email FROM users WHERE id='qualification-member'", 'qualification_restore'), 'fixture@example.test');
  const receipt = { status: 'CONTAINER_INSTALL_HTTPS_PRIVATE_ACCESS_RESTART_AND_DATABASE_RESTORE_VERIFIED', release,
    actualCustomerIdentity: 'NOT_TESTED', crossVersionUpgrade: 'NOT_TESTED', cloudProvider: 'NOT_TESTED', nativeArchitecture: 'amd64' };
  writeFileSync(process.env.LW_MARKETPLACE_RECEIPT, JSON.stringify(receipt, null, 2) + '\n');
  console.log(receipt.status);
} finally {
  // This project name and all its volumes were created above for this one run.
  docker(['down', '--volumes', '--remove-orphans']);
}
