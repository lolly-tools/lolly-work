// SPDX-License-Identifier: MPL-2.0
import { readFile, stat, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { requireCondition } from './protocol.mjs';
import { connectRedis } from './redis.mjs';
import { SNAPSHOT_LUA, IMPORT_LUA, sha256, validateSnapshot, parseSnapshotReply, importArguments, sourceSnapshot } from './snapshot.mjs';

async function protectedRead(path) {
  const info = await stat(path);
  requireCondition(info.isFile() && !(info.mode & 0o077) && info.size <= 4 * 1024 * 1024);
  return readFile(path);
}
async function save(path, value) {
  const bytes = Buffer.from(JSON.stringify(value, null, 2) + '\n');
  await writeFile(path, bytes, { mode: 0o600, flag: 'wx' });
  return sha256(bytes);
}

async function sourceCommand(urlFile, tokenFile) {
  const url = new URL((await protectedRead(urlFile)).toString().trim());
  requireCondition(url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash);
  const token = (await protectedRead(tokenFile)).toString().trim();
  requireCondition(token.length >= 16);
  return { host: url.hostname, command: async body => {
    const response = await fetch(url, { method: 'POST', headers: {
      authorization: 'Bearer ' + token, 'content-type': 'application/json',
    }, body: JSON.stringify(body), redirect: 'error', signal: AbortSignal.timeout(8000) });
    requireCondition(response.ok);
    const chunks = []; let size = 0;
    const reader = response.body.getReader();
    while (true) {
      const part = await reader.read(); if (part.done) break;
      size += part.value.length;
      if (size > 4 * 1024 * 1024) { await reader.cancel(); requireCondition(false); }
      chunks.push(part.value);
    }
    const value = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    requireCondition(!value.error && Object.hasOwn(value, 'result'));
    return value.result;
  } };
}

export async function destinationIdentity(client, url) {
  const parsed = new URL(url);
  const info = await client.info('server');
  const runId = /^run_id:([a-f0-9]{40})\r?$/m.exec(info)?.[1];
  requireCondition(runId && await client.dbSize() === 0);
  const time = await client.sendCommand(['TIME']);
  const now = Number(time[0]) * 1000 + Math.floor(Number(time[1]) / 1000);
  requireCondition(Number.isSafeInteger(now) && Math.abs(now - Date.now()) <= 1000);
  return { host: parsed.hostname, port: parsed.port || '6379', database: parsed.pathname || '/0', runId };
}

export async function run(argv) {
  const mode = argv.shift(); const args = {};
  while (argv.length) {
    const flag = argv.shift();
    requireCondition(flag?.startsWith('--') && !Object.hasOwn(args, flag));
    args[flag] = argv.shift(); requireCondition(args[flag] && !args[flag].startsWith('--'));
  }
  if (mode === 'export') {
    requireCondition(Object.keys(args).sort().join(',') ===
      ['--source-url-file', '--source-token-file', '--quiescence-file', '--out'].sort().join(','));
    const source = await sourceCommand(args['--source-url-file'], args['--source-token-file']);
    const custody = await protectedRead(args['--quiescence-file']); const fence = JSON.parse(custody);
    requireCondition(fence.version === 1 && fence.sourceHost === source.host && fence.admissionWritersQuiesced === true &&
      Number.isSafeInteger(fence.recordedAtMs) && Math.abs(Date.now() - fence.recordedAtMs) <= 300_000 &&
      Array.isArray(fence.consumers) && fence.consumers.sort().join(',') === 'ca,mcp');
    const snapshot = await sourceSnapshot({ ...source, sourceHost: source.host, quiescenceSha256: sha256(custody) });
    const hash = await save(args['--out'], snapshot);
    console.info(JSON.stringify({ operation: 'export', count: snapshot.records.length, snapshotSha256: hash }));
    return;
  }
  requireCondition(mode === 'plan-import' || mode === 'apply-import');
  const allowed = ['--snapshot', '--target-url-file', '--out', '--target-ca-file',
    ...(mode === 'apply-import' ? ['--plan', '--reviewed-plan-sha256'] : [])];
  requireCondition(Object.keys(args).every(k => allowed.includes(k)) && args['--snapshot'] && args['--target-url-file'] && args['--out']);
  if (mode === 'apply-import') requireCondition(args['--plan'] && args['--reviewed-plan-sha256']);
  // Reserve no output over existing custody before connecting or mutating.
  try { await stat(args['--out']); throw new Error('Output already exists'); }
  catch (error) { requireCondition(error.code === 'ENOENT'); }
  const bytes = await protectedRead(args['--snapshot']); const snapshot = validateSnapshot(JSON.parse(bytes));
  await protectedRead(args['--target-url-file']);
  const url = (await protectedRead(args['--target-url-file'])).toString().trim();
  const client = await connectRedis({ urlFile: args['--target-url-file'], caFile: args['--target-ca-file'], operator: true });
  try {
    const target = await destinationIdentity(client, url);
    const plan = { version: 1, operation: 'import-empty-candidate', snapshotSha256: sha256(bytes), target,
      count: snapshot.records.length, quiescenceSha256: snapshot.quiescenceSha256 };
    if (mode === 'plan-import') {
      const hash = await save(args['--out'], plan);
      console.info(JSON.stringify({ operation: 'plan-import', count: plan.count, reviewedPlanSha256: hash }));
      return;
    }
    const reviewed = await protectedRead(args['--plan']);
    requireCondition(/^[a-f0-9]{64}$/.test(args['--reviewed-plan-sha256']) &&
      sha256(reviewed) === args['--reviewed-plan-sha256'] && JSON.stringify(JSON.parse(reviewed)) === JSON.stringify(plan));
    // Recheck the empty DB and server process immediately before the one Lua write.
    requireCondition(JSON.stringify(await destinationIdentity(client, url)) === JSON.stringify(target));
    validateSnapshot(snapshot);
    console.info(JSON.stringify({ operation: 'import-attempt', count: plan.count, targetRunId: target.runId }));
    const result = await client.eval(IMPORT_LUA, importArguments(snapshot));
    requireCondition(Array.isArray(result) && result.length === 2 && result[0] + result[1] === plan.count);
    const keys = snapshot.records.map(r => r.key);
    const verified = parseSnapshotReply(keys, await client.eval(SNAPSHOT_LUA, { keys, arguments: [] }), {
      sourceHost: target.host, exportedAtMs: Date.now(), quiescenceSha256: plan.quiescenceSha256,
    });
    const original = new Map(snapshot.records.map(r => [r.key, r]));
    for (const value of verified.records) {
      const before = original.get(value.key);
      requireCondition(before && value.value === before.value && Math.abs(value.expiresAtMs - before.expiresAtMs) <= 50);
      original.delete(value.key);
    }
    requireCondition([...original.values()].every(v => v.expiresAtMs <= verified.capturedAtMs));
    const receipt = { version: 1, operation: 'import-complete', target, snapshotSha256: plan.snapshotSha256,
      imported: result[0], expired: result[1], countersAndDeadlinesVerified: true, completedAtMs: Date.now() };
    const hash = await save(args['--out'], receipt);
    console.info(JSON.stringify({ ...receipt, receiptSha256: hash }));
  } finally { client.destroy(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  run(process.argv.slice(2)).catch(() => {
    console.error('[admission-transfer] refused or failed; keep writers drained and candidate inactive; an attempted import may have committed');
    process.exitCode = 1;
  });
}
