import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { runInNewContext } from 'node:vm';
import { parseConfig } from '../server/src/config/instance.ts';

const source = readFileSync(new URL('../scripts/shell-stage-memory-boot.mjs', import.meta.url), 'utf8');
const imports = "import fs from 'node:fs';import crypto from 'node:crypto';import {spawn} from 'node:child_process';import path from 'node:path';";
const parserImport = "await import('/app/server/src/config/instance.ts')";
assert.ok(source.includes(imports) && source.includes(parserImport));
// Execute the actual probe with only its IO boundaries replaced.
const executable = source.replace(imports, '').replace(parserImport, '({parseConfig:fixtureParseConfig})');
const publicKey = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' }).publicKey.export({ format: 'jwk' });
const pin = Buffer.from('reviewed engine pin');
const index = Buffer.from('<html>reviewed shell</html>');
const hash = (bytes: Uint8Array) => crypto.createHash('sha256').update(bytes).digest('hex');

type Options = {
  ready?: (attempt: number) => Response | Promise<Response>;
  key?: Record<string, unknown>;
  parser?: typeof parseConfig;
};

async function probe(options: Options = {}) {
  let elapsed = 0, attempts = 0, writes = 0, removals = 0;
  let config: ReturnType<typeof parseConfig> | undefined;
  let environment: Record<string, string> | undefined;
  const logs: string[] = [], errors: string[] = [], signals: string[] = [], requests: string[] = [];
  const child = Object.assign(new EventEmitter(), {
    stdout: new EventEmitter(), stderr: new EventEmitter(),
    exitCode: null as number | null, signalCode: null as string | null,
    kill(signal: string) {
      signals.push(signal);
      child.stdout.emit('data', Buffer.from('[lolly-work] drained\n'));
      child.exitCode = signal === 'SIGTERM' ? 0 : 1;
      child.emit('exit', child.exitCode, null);
      return true;
    },
  });
  const input = { pinSha256: hash(pin), indexSha256: hash(index), publicKey: options.key ?? publicKey };
  const context = {
    Buffer, crypto, path, AbortSignal, Date: { now: () => elapsed },
    fixtureParseConfig: options.parser ?? parseConfig,
    process: { getuid: () => 1000, getgid: () => 1000, versions: { node: '26.7.0' }, env: {}, execPath: '/node',
      stdin: (async function* () { yield Buffer.from(JSON.stringify(input)); })() },
    fs: {
      readFileSync(file: string) {
        assert.ok(['/app/engine-pin.json', '/stage/engine-pin.json'].includes(file));
        return pin;
      },
      mkdtempSync: () => '/tmp/isolated-fixture',
      writeFileSync(_file: string, value: string, flags: { flag: string; mode: number }) {
        assert.deepEqual(JSON.parse(JSON.stringify(flags)), { flag: 'wx', mode: 0o600 });
        config = parseConfig(value); writes++;
      },
      rmSync: () => { removals++; }, rmdirSync: () => { removals++; },
    },
    spawn(_file: string, args: string[], opts: { cwd: string; env: Record<string, string> }) {
      assert.equal(args.join(' '), 'server/src/main.ts'); assert.equal(opts.cwd, '/app');
      environment = opts.env;
      queueMicrotask(() => child.stdout.emit('data', Buffer.from('[lolly-work] deployment mode=evaluation; storage=memory\n')));
      return child;
    },
    async fetch(url: string) {
      requests.push(url);
      if (url.endsWith('/healthz')) return Response.json({ ok: true, name: 'Isolated private cohort smoke', accessMode: 'gated' });
      if (url.endsWith('/readyz')) return options.ready?.(++attempts) ?? Response.json({ ok: true, store: 'memory' });
      assert.equal(url, 'http://127.0.0.1:18987/');
      return new Response(index, { headers: { 'content-type': 'text/html' } });
    },
    setTimeout(fn: () => void, ms: number) {
      if (ms !== 10000) elapsed += ms;
      queueMicrotask(fn); return 1;
    },
    clearTimeout() {},
    console: { log: (value: string) => logs.push(value), error: (value: string) => errors.push(value) },
  };
  let failure: unknown;
  try { await runInNewContext(`(async()=>{${executable}\n})()`, context); }
  catch (error) { failure = error; }
  return { failure, config, environment, writes, removals, signals, requests, elapsed,
    result: logs[0] ? JSON.parse(logs[0]) : undefined,
    diagnostic: errors[0] ? JSON.parse(errors[0]) : undefined };
}

test('isolated boot passes the retained public pin through the real parser and waits for catalog readiness', async () => {
  const run = await probe({ ready: attempt => Response.json({ ok: attempt >= 3, store: 'memory' }, { status: attempt >= 3 ? 200 : 503 }) });
  assert.equal(run.failure, undefined);
  assert.deepEqual(run.config?.instance.catalogPublicKey, publicKey);
  assert.equal(run.config?.instance.catalogPublicationGeneration, undefined);
  assert.deepEqual(run.result.readinessHistory.map((row: { status: number }) => row.status), [503, 503, 200]);
  assert.equal(run.result.indexSha256, hash(index));
  assert.equal(run.result.storage, 'memory'); assert.equal(run.result.gracefulShutdown, true);
  assert.equal(run.environment?.DATABASE_URL, undefined); assert.equal(run.environment?.LW_CATALOG_SIGNING_KEY, undefined);
  assert.deepEqual(run.signals, ['SIGTERM']); assert.equal(run.removals, 2);
});

test('catalog readiness timeout refuses with bounded original diagnostics and drains the child', async () => {
  const run = await probe({ ready: () => Response.json({ ok: false, store: 'memory' }, { status: 503 }) });
  assert.match(String(run.failure), /bounded memory-only catalog readiness proof/);
  assert.equal(run.result, undefined); assert.equal(run.elapsed, 90000);
  assert.equal(run.diagnostic.status, 'ISOLATED_MEMORY_BOOT_REFUSED');
  assert.equal(run.diagnostic.readinessHistory.length, 90);
  assert.equal(run.diagnostic.originalStdoutSha256, hash(Buffer.from(run.diagnostic.originalStdout)));
  assert.equal(run.diagnostic.gracefulShutdown, true); assert.equal(run.removals, 2);
  assert.ok(!run.requests.includes('http://127.0.0.1:18987/'));
});

test('temporary readiness transport failure is recorded before later success', async () => {
  const run = await probe({ ready: attempt => {
    if (attempt === 1) throw new Error('fixture connection reset');
    return Response.json({ ok: true, store: 'memory' });
  } });
  assert.equal(run.failure, undefined);
  assert.equal(run.result.readinessHistory[0].error, 'fixture connection reset');
  assert.equal(run.result.readinessHistory[1].status, 200);
});

test('unexpected readiness status and non-memory response both refuse', async () => {
  for (const ready of [() => new Response('forbidden', { status: 403 }), () => Response.json({ ok: true, store: 'postgres' })]) {
    const run = await probe({ ready });
    assert.ok(run.failure); assert.equal(run.result, undefined);
    assert.equal(run.diagnostic.readinessHistory.length, 1);
    assert.deepEqual(run.signals, ['SIGTERM']); assert.equal(run.removals, 2);
  }
});

test('private keys and parser loss of the public key refuse before starting a child', async () => {
  const privateKey = await probe({ key: { ...publicKey, d: 'forbidden' } });
  const parserLoss = await probe({ parser: text => {
    const parsed = parseConfig(text); delete parsed.instance.catalogPublicKey; return parsed;
  } });
  assert.match(String(privateKey.failure), /public-only existing P256 pin/);
  assert.match(String(parserLoss.failure), /parsed existing catalog public key required/);
  for (const run of [privateKey, parserLoss]) {
    assert.ok(run.failure); assert.equal(run.writes, 0); assert.equal(run.environment, undefined);
  }
});
