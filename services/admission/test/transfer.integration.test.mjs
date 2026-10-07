import assert from 'node:assert/strict';
import { createServer } from 'node:https';
import { readFile, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { join } from 'node:path';
import test from 'node:test';
import { connectRedis } from '../src/redis.mjs';
import { SNAPSHOT_LUA, sha256 } from '../src/snapshot.mjs';

const fixture = process.env.ADMISSION_TEST_FIXTURE;
test('protected export, hash-reviewed CLI import and rejection before writes', { skip: !fixture }, async t => {
  const sourceUrl = new URL((await readFile(join(fixture, 'redis-url.txt'), 'utf8')).trim());
  assert.equal(sourceUrl.hostname, 'localhost'); sourceUrl.pathname = '/3';
  const sourceFile = join(fixture, 'transfer-source-url.txt');
  await writeFile(sourceFile, sourceUrl.toString(), { mode: 0o600, flag: 'wx' });
  const client = await connectRedis({ urlFile: sourceFile, caFile: join(fixture, 'tls.crt') });
  t.after(() => client.destroy()); assert.equal(await client.dbSize(), 0);
  const cpu = 'lolly:budget:mcp:' + new Date().toISOString().slice(0, 10) + ':cpu-ms', bytes = cpu.slice(0, -6) + 'egress-bytes';
  await client.set(cpu, '123', { PX: 60000 }); await client.set(bytes, '456', { PX: 60000 });
  const token = 'operator-fixture-' + 'o'.repeat(32);
  const server = createServer({ key: await readFile(join(fixture, 'tls.key')), cert: await readFile(join(fixture, 'tls.crt')) }, async (req, res) => {
    let text = ''; for await (const b of req) text += b;
    const body = JSON.parse(text);
    assert.equal(req.headers.authorization, 'Bearer ' + token);
    assert.ok(body[0] === 'SCAN' || body[0] === 'EVAL' && body[1] === SNAPSHOT_LUA);
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ result: await client.sendCommand(body) }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  t.after(() => new Promise(r => { server.closeAllConnections(); server.close(r); }));
  const rest = join(fixture, 'source-rest-url.txt'), tokenFile = join(fixture, 'source-rest-token.txt'), fence = join(fixture, 'quiescence.json');
  for (const [path, value] of [[rest, `https://localhost:${server.address().port}/`], [tokenFile, token],
    [fence, JSON.stringify({ version: 1, sourceHost: 'localhost', admissionWritersQuiesced: true, recordedAtMs: Date.now(), consumers: ['mcp', 'ca'] })]]) {
    await writeFile(path, value, { mode: 0o600, flag: 'wx' });
  }
  const target = new URL(sourceUrl); target.pathname = '/4'; const targetFile = join(fixture, 'transfer-target-url.txt');
  await writeFile(targetFile, target.toString(), { mode: 0o600, flag: 'wx' });
  const dest = await connectRedis({ urlFile: targetFile, caFile: join(fixture, 'tls.crt') }); t.after(() => dest.destroy());
  assert.equal(await dest.dbSize(), 0);
  const invoke = argv => promisify(execFile)(process.execPath, ['src/transfer.mjs', ...argv], {
    cwd: new URL('../', import.meta.url), env: { ...process.env, NODE_EXTRA_CA_CERTS: join(fixture, 'tls.crt') }, timeout: 15000,
  });
  const snapshot = join(fixture, 'snapshot.json'), plan = join(fixture, 'import-plan.json'), receipt = join(fixture, 'import-receipt.json');
  await invoke(['export', '--source-url-file', rest, '--source-token-file', tokenFile, '--quiescence-file', fence, '--out', snapshot]);
  const common = ['--snapshot', snapshot, '--target-url-file', targetFile, '--target-ca-file', join(fixture, 'tls.crt')];
  await invoke(['plan-import', ...common, '--out', plan]);
  const hash = sha256(await readFile(plan));
  await assert.rejects(invoke(['apply-import', ...common, '--plan', plan, '--reviewed-plan-sha256', '0'.repeat(64), '--out', receipt]));
  assert.equal(await dest.dbSize(), 0);
  await invoke(['apply-import', ...common, '--plan', plan, '--reviewed-plan-sha256', hash, '--out', receipt]);
  assert.deepEqual(await dest.mGet([cpu, bytes]), ['123', '456']);
  const evidence = JSON.parse(await readFile(receipt)); assert.equal(evidence.countersAndDeadlinesVerified, true);
  assert.ok(await dest.pTTL(cpu) <= await client.pTTL(cpu) + 50);
  await assert.rejects(invoke(['apply-import', ...common, '--plan', plan, '--reviewed-plan-sha256', hash, '--out', receipt]));
});
