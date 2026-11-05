// SPDX-License-Identifier: MPL-2.0
/** The durable render commands are a thin view over the API contract. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
let server: Server;
let base = '';
let home = '';
const seen: Array<{ method: string; url: string; headers: IncomingMessage['headers']; body: unknown }> = [];
const ZIP = Buffer.from('PK-this-is-the-archive');

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : undefined;
}
const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-cli-renders-'));
  server = createServer(async (req, res) => {
    const body = await bodyOf(req);
    seen.push({ method: req.method!, url: req.url!, headers: req.headers, body });
    if (req.method === 'POST' && req.url === '/api/v1/renders') return json(res, 202, { id: 'rnd_1', state: 'queued', attempt: 0, request: { toolId: 'card', format: 'svg' } });
    if (req.method === 'POST' && req.url === '/api/v1/render-batches') return json(res, 202, { id: 'rbt_1', state: 'queued', attempt: 0, request: { toolId: 'card', format: 'svg' }, progress: { done: 0, total: 1, succeeded: 0, failed: 0, cancelled: 0 } });
    if (req.method === 'POST' && req.url === '/api/v1/renders/rnd_1/deliveries') return json(res, 201, { id: 'del_1', state: 'delivered', name: 'Launch', format: 'svg', destinationId: 'archive', url: 'https://files.invalid/launch.svg' });
    if (req.method === 'POST' && req.url === '/api/v1/renders/rnd_waits/deliveries') return json(res, 202, { id: 'del_2', state: 'awaiting-approval', name: 'Launch', format: 'svg', destinationId: 'reviewed', url: null });
    if (req.url === '/api/v1/render-batches/rbt_1/archive') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(ZIP.subarray(0, 4));
      res.end(ZIP.subarray(4));
      return;
    }
    if (req.url === '/api/v1/render-batches/rbt_running/archive') return json(res, 409, { error: { code: 'BATCH_NOT_FINISHED', message: 'the archive is available once every row has finished' } });
    if (req.url === '/api/v1/render-batches/rbt_dropped/archive') {
      res.writeHead(200, { 'content-type': 'application/zip' });
      res.write(ZIP.subarray(0, 4));
      setTimeout(() => res.destroy(), 20);
      return;
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'no such route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(() => new Promise<void>((resolve) => server.close(() => resolve())));

interface Run { code: number; stdout: string; stderr: string }
const lw = (args: string[]): Promise<Run> => new Promise((resolve) => {
  const child = spawn(process.execPath, [CLI, ...args], { env: { ...process.env, HOME: home, LW_BASE: base, LW_TOKEN: 'lwt_cli_renders' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = ''; let stderr = '';
  child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
  child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
  child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
});
const last = (url: string) => seen.filter((entry) => entry.url === url).at(-1)!;

test('submit adds a callback URL to the request, for renders and batches', async () => {
  const file = join(home, 'request.json');
  writeFileSync(file, JSON.stringify({ toolId: 'card', format: 'svg', inputs: {} }));
  const single = await lw(['renders', 'submit', file, '--callback-url', 'https://hooks.example/a', '--idempotency-key', 'one']);
  assert.equal(single.code, 0, single.stderr);
  assert.deepEqual(last('/api/v1/renders').body, { toolId: 'card', format: 'svg', inputs: {}, callbackUrl: 'https://hooks.example/a' });
  assert.equal(last('/api/v1/renders').headers['idempotency-key'], 'one');
  const plain = await lw(['renders', 'submit', file]);
  assert.equal(plain.code, 0, plain.stderr);
  assert.equal((last('/api/v1/renders').body as { callbackUrl?: string }).callbackUrl, undefined);

  const rows = join(home, 'batch.json');
  writeFileSync(rows, JSON.stringify({ toolId: 'card', format: 'svg', bind: { source: 'cms://products/current.csv' } }));
  const batch = await lw(['render-batches', 'submit', rows, '--callback-url', 'https://hooks.example/b']);
  assert.equal(batch.code, 0, batch.stderr);
  assert.deepEqual(last('/api/v1/render-batches').body, { toolId: 'card', format: 'svg', bind: { source: 'cms://products/current.csv' }, callbackUrl: 'https://hooks.example/b' });

  writeFileSync(file, '[]');
  const refused = await lw(['renders', 'submit', file, '--callback-url', 'https://hooks.example/a']);
  assert.notEqual(refused.code, 0);
});

test('deliver sends a finished render to a destination', async () => {
  const sent = await lw(['renders', 'deliver', 'rnd_1', '--destination', 'archive', '--name', 'Launch', '--idempotency-key', 'launch-1']);
  assert.equal(sent.code, 0, sent.stderr);
  assert.match(sent.stdout, /del_1\s+delivered\s+Launch\.svg → archive/);
  assert.match(sent.stdout, /files\.invalid/);
  const call = last('/api/v1/renders/rnd_1/deliveries');
  assert.deepEqual(call.body, { destinationId: 'archive', name: 'Launch' });
  assert.equal(call.headers['idempotency-key'], 'launch-1');
  const asJson = await lw(['renders', 'deliver', 'rnd_1', '--destination', 'archive', '--name', 'Launch', '--format', 'svg', '--json']);
  assert.equal((JSON.parse(asJson.stdout) as { id: string }).id, 'del_1');
  assert.deepEqual(last('/api/v1/renders/rnd_1/deliveries').body, { destinationId: 'archive', name: 'Launch', format: 'svg' });
  const waits = await lw(['renders', 'deliver', 'rnd_waits', '--destination', 'reviewed', '--name', 'Launch']);
  assert.match(waits.stdout, /waiting on the destination approval chain/);
  assert.notEqual((await lw(['renders', 'deliver', 'rnd_1', '--name', 'Launch'])).code, 0, '--destination is required');
  assert.notEqual((await lw(['renders', 'deliver', 'rnd_1', '--destination', 'archive'])).code, 0, '--name is required');
});

test('archive streams to the named file, and leaves nothing behind when it fails', async () => {
  const out = join(home, 'outputs.zip');
  const done = await lw(['render-batches', 'archive', 'rbt_1', '--out', out]);
  assert.equal(done.code, 0, done.stderr);
  assert.deepEqual(readFileSync(out), ZIP);
  assert.equal(existsSync(`${out}.part`), false);
  assert.match(done.stdout, new RegExp(`${ZIP.length} bytes`));

  const unfinished = join(home, 'unfinished.zip');
  const refused = await lw(['render-batches', 'archive', 'rbt_running', '--out', unfinished]);
  assert.notEqual(refused.code, 0);
  assert.match(refused.stderr, /BATCH_NOT_FINISHED/);
  assert.equal(existsSync(unfinished), false);

  const dropped = join(home, 'dropped.zip');
  const broken = await lw(['render-batches', 'archive', 'rbt_dropped', '--out', dropped]);
  assert.notEqual(broken.code, 0);
  assert.equal(existsSync(dropped), false, 'a dropped download leaves no file that looks finished');
  assert.equal(existsSync(`${dropped}.part`), false);
  assert.notEqual((await lw(['render-batches', 'archive', 'rbt_1'])).code, 0, '--out is required');
});
