import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { request } from 'node:https';
import { spawn } from 'node:child_process';
import { join } from 'node:path';
import test from 'node:test';
import { connectRedis } from '../src/redis.mjs';
import { RATE_LUA, BUDGET_LUA, parseCommand, executeCommand } from '../src/protocol.mjs';
import { SNAPSHOT_LUA, IMPORT_LUA, parseSnapshotReply, importArguments } from '../src/snapshot.mjs';

const fixture = process.env.ADMISSION_TEST_FIXTURE;
test('real Redis TLS/auth, atomic increments, budget pair and deadline-preserving empty import', { skip: !fixture }, async t => {
  const urlFile = join(fixture, 'redis-url.txt'), caFile = join(fixture, 'tls.crt');
  assert.equal(new URL((await readFile(urlFile, 'utf8')).trim()).hostname, 'localhost');
  const client = await connectRedis({ urlFile, caFile }); t.after(() => client.destroy());
  assert.equal(await client.dbSize(), 0, 'integration tests require a fresh isolated local Redis fixture');
  const key = 'lolly:rl:' + 'a'.repeat(64);
  const cpu = 'lolly:budget:mcp:' + new Date().toISOString().slice(0, 10) + ':cpu-ms', egress = cpu.slice(0, -6) + 'egress-bytes';
  const rate = parseCommand(['EVAL', RATE_LUA, '1', key, '60000'], 'mcp');
  const values = await Promise.all(Array.from({ length: 16 }, () => executeCommand(client, rate)));
  assert.deepEqual(values.map(v => v[0]).sort((a, b) => a - b), Array.from({ length: 16 }, (_, i) => i + 1));
  const ttl = await client.pTTL(key); assert.ok(ttl > 0 && ttl <= 60000);
  await new Promise(r => setTimeout(r, 30)); await executeCommand(client, rate); assert.ok(await client.pTTL(key) < ttl);
  await executeCommand(client, parseCommand(['EVAL', BUDGET_LUA, '2', cpu, egress, '123', '456', '172800'], 'mcp'));
  assert.deepEqual(await executeCommand(client, parseCommand(['MGET', cpu, egress], 'mcp')), ['123', '456']);
  const keys = [key, cpu, egress];
  const reply = await client.eval(SNAPSHOT_LUA, { keys, arguments: [] });
  const snapshot = parseSnapshotReply(keys, reply, { sourceHost: 'localhost', exportedAtMs: Date.now(), quiescenceSha256: 'a'.repeat(64) });
  const targetUrl = new URL((await readFile(urlFile, 'utf8')).trim()); targetUrl.pathname = '/1';
  const targetFile = join(fixture, 'redis-target-url.txt'); await writeFile(targetFile, targetUrl.toString(), { mode: 0o600, flag: 'wx' });
  const target = await connectRedis({ urlFile: targetFile, caFile }); t.after(() => target.destroy());
  assert.equal(await target.dbSize(), 0);
  assert.deepEqual(await target.eval(IMPORT_LUA, importArguments(snapshot)), [3, 0]);
  assert.deepEqual(await target.mGet(keys), ['17', '123', '456']);
  const sourceTtl = await client.pTTL(key), importedTtl = await target.pTTL(key);
  assert.ok(Math.abs(importedTtl - sourceTtl) < 1000);
  await assert.rejects(target.eval(IMPORT_LUA, importArguments(snapshot)), /destination not empty/);
  assert.deepEqual(await target.mGet(keys), ['17', '123', '456']);
});

test('actual HTTPS server uses official Redis client and existing MCP/CA wire contract', { skip: !fixture }, async t => {
  const port = Number(process.env.ADMISSION_TEST_HTTPS_PORT); assert.ok(port >= 1024);
  const child = spawn(process.execPath, ['src/main.mjs'], { cwd: new URL('../', import.meta.url), env: {
    ...process.env, ADMISSION_PORT: String(port), ADMISSION_TLS_KEY_FILE: join(fixture, 'tls.key'),
    ADMISSION_TLS_CERT_FILE: join(fixture, 'tls.crt'), ADMISSION_MCP_TOKEN_FILE: join(fixture, 'mcp-token.txt'),
    ADMISSION_CA_TOKEN_FILE: join(fixture, 'ca-token.txt'), ADMISSION_REDIS_URL_FILE: join(fixture, 'redis-url.txt'),
    ADMISSION_REDIS_CA_FILE: join(fixture, 'tls.crt'),
  }, stdio: ['ignore', 'pipe', 'pipe'] });
  t.after(() => { child.kill('SIGTERM'); });
  const ca = await readFile(join(fixture, 'tls.crt')), token = (await readFile(join(fixture, 'ca-token.txt'), 'utf8')).trim();
  function call(path, body) {
    return new Promise((resolve, reject) => {
      const r = request({ hostname: 'localhost', port, path, ca, method: body ? 'POST' : 'GET', headers: body ? {
        authorization: 'Bearer ' + token, 'content-type': 'application/json',
      } : {}, timeout: 1500 }, response => {
        let data = ''; response.on('data', b => data += b); response.on('end', () => resolve({ status: response.statusCode, body: JSON.parse(data) }));
      });
      r.on('error', reject); r.on('timeout', () => r.destroy()); r.end(body ? JSON.stringify(body) : undefined);
    });
  }
  let ready;
  for (let i = 0; i < 50; i++) {
    try { ready = await call('/readyz'); if (ready.status === 200) break; } catch {}
    await new Promise(r => setTimeout(r, 50));
  }
  assert.equal(ready?.status, 200);
  const result = await call('/', ['EVAL', RATE_LUA, '1', 'lolly:rl:' + 'b'.repeat(64), '60000']);
  assert.equal(result.status, 200); assert.equal(result.body.result[0], 1); assert.ok(result.body.result[1] > 0);
  const refused = await call('/', ['CONFIG', 'SET', 'maxmemory', '0']); assert.equal(refused.status, 400);
});
