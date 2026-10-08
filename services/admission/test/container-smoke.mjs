// SPDX-License-Identifier: MPL-2.0
// CI-only synthetic fixture. Never reads a production credential or endpoint.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { mkdtemp, readFile, writeFile, chmod, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { request } from 'node:https';
import { RATE_LUA, BUDGET_LUA } from '../src/protocol.mjs';

const image = process.argv[2];
assert.match(image || '', /^[a-z0-9][a-z0-9._:/@-]*$/);
const fixture = await mkdtemp(join(tmpdir(), 'lolly-admission-ci-'));
const name = 'lolly-admission-ci-' + randomBytes(4).toString('hex');
const password = randomBytes(32).toString('hex');
const mcp = randomBytes(32).toString('hex'), caToken = randomBytes(32).toString('hex');
let redis;
const run = (command, args) => execFileSync(command, args, { stdio: ['ignore', 'pipe', 'pipe'], timeout: 120_000 });
const pause = () => new Promise(r => setTimeout(r, 100));
try {
  await chmod(fixture, 0o755);
  run('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1', '-subj', '/CN=localhost',
    '-addext', 'subjectAltName=DNS:localhost,IP:127.0.0.1', '-keyout', join(fixture, 'tls.key'), '-out', join(fixture, 'tls.crt')]);
  for (const [file, value] of [['redis-url.txt', `rediss://:${password}@localhost:16379`],
    ['mcp-token.txt', mcp], ['ca-token.txt', caToken]]) await writeFile(join(fixture, file), value, { mode: 0o444 });
  await chmod(join(fixture, 'tls.key'), 0o444); await chmod(join(fixture, 'tls.crt'), 0o444);
  await writeFile(join(fixture, 'redis.conf'), [
    'bind 127.0.0.1', 'port 0', 'tls-port 16379', 'tls-auth-clients no',
    `tls-cert-file ${join(fixture, 'tls.crt')}`, `tls-key-file ${join(fixture, 'tls.key')}`,
    `tls-ca-cert-file ${join(fixture, 'tls.crt')}`, `requirepass ${password}`,
    `dir ${fixture}`, 'appendonly yes', 'appendfsync always', 'maxmemory 64mb', 'maxmemory-policy noeviction',
  ].join('\n') + '\n', { mode: 0o600 });
  const startRedis = () => { redis = spawn('redis-server', [join(fixture, 'redis.conf')], { stdio: 'ignore' }); };
  startRedis();
  run('docker', ['run', '--detach', '--name', name, '--network', 'host', '--read-only', '--user', '1000:1000',
    '--cap-drop', 'ALL', '--security-opt', 'no-new-privileges', '--memory', '128m', '--cpus', '0.3',
    '--mount', `type=bind,src=${fixture},dst=/fixture,readonly`, '--env', 'ADMISSION_PORT=18443',
    '--env', 'ADMISSION_TLS_KEY_FILE=/fixture/tls.key', '--env', 'ADMISSION_TLS_CERT_FILE=/fixture/tls.crt',
    '--env', 'ADMISSION_MCP_TOKEN_FILE=/fixture/mcp-token.txt', '--env', 'ADMISSION_CA_TOKEN_FILE=/fixture/ca-token.txt',
    '--env', 'ADMISSION_REDIS_URL_FILE=/fixture/redis-url.txt', '--env', 'ADMISSION_REDIS_CA_FILE=/fixture/tls.crt', image]);
  const cert = await readFile(join(fixture, 'tls.crt'));
  function call(path, body, token) {
    return new Promise((resolve, reject) => {
      const req = request({ hostname: 'localhost', port: 18443, path, ca: cert, method: body ? 'POST' : 'GET',
        headers: body ? { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) } : {}, timeout: 2500 }, res => {
        let text = ''; res.on('data', b => text += b); res.on('end', () => resolve({ status: res.statusCode, value: JSON.parse(text) }));
      });
      req.on('error', reject); req.on('timeout', () => req.destroy(new Error('CI fixture timeout')));
      req.end(body ? JSON.stringify(body) : undefined);
    });
  }
  async function waitReady(status) {
    let result;
    for (let i = 0; i < 150; i++) { try { result = await call('/readyz'); if (result.status === status) return; } catch {} await pause(); }
    assert.equal(result?.status, status, 'bounded CI readiness wait');
  }
  await waitReady(200);
  const key = 'lolly:rl:' + 'c'.repeat(64), rate = ['EVAL', RATE_LUA, '1', key, '60000'];
  assert.equal((await call('/', rate)).status, 401);
  const first = await call('/', rate, mcp); assert.equal(first.status, 200); assert.equal(first.value.result[0], 1);
  assert.ok(first.value.result[1] > 0 && first.value.result[1] <= 60000);
  const cpu = 'lolly:budget:mcp:' + new Date().toISOString().slice(0, 10) + ':cpu-ms', bytes = cpu.slice(0, -6) + 'egress-bytes';
  assert.equal((await call('/', ['EVAL', BUDGET_LUA, '2', cpu, bytes, '123', '456', '172800'], mcp)).status, 200);
  assert.deepEqual((await call('/', ['MGET', cpu, bytes], mcp)).value.result, ['123', '456']);
  assert.equal((await call('/', ['MGET', cpu, bytes], caToken)).status, 400);
  assert.equal((await call('/', ['CONFIG', 'SET', 'maxmemory', '0'], mcp)).status, 400);
  redis.kill('SIGTERM'); await new Promise(r => redis.once('exit', r)); redis = null;
  await waitReady(503);
  assert.deepEqual(await call('/', rate, mcp), { status: 503, value: { error: 'store-unavailable' } });
  startRedis(); await waitReady(200);
  assert.deepEqual((await call('/', ['MGET', cpu, bytes], mcp)).value.result, ['123', '456']);
  assert.equal((await call('/', rate, mcp)).value.result[0], 2);
  run('docker', ['exec', name, 'node', '--input-type=module', '-e',
    'import assert from "node:assert/strict"; assert.equal(process.getuid(),1000); assert.equal(process.arch,"x64"); assert.ok(process.report.getReport().header.glibcVersionRuntime);']);
  console.log('PASS: amd64 non-root read-only image; verified TLS; bounded wire roles; fail-closed outage; AOF restart counters');
} finally {
  try { run('docker', ['rm', '--force', name]); } catch {}
  if (redis) { redis.kill('SIGTERM'); await new Promise(r => redis.once('exit', r)); }
  await rm(fixture, { recursive: true, force: true });
}
