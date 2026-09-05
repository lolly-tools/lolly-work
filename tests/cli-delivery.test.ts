// SPDX-License-Identifier: MPL-2.0
/** The delivery CLI is a thin, secret-free view over the public API contract. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse, type Server } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');
const TOKEN = 'lwt_cli_delivery';
const delivery = {
  id: 'del_1', destinationId: 'archive', name: 'Campaign', format: 'png', state: 'delivered',
  attempt: 1, size: 1234, sourceJobId: 'job_1', url: 'https://files.invalid/Campaign.png', error: null,
};

let server: Server;
let base = '';
let home = '';
let publishedBody: unknown;
let publishedIdempotency = '';

const json = (res: ServerResponse, status: number, value: unknown): void => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(value));
};

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

interface Run { code: number; stdout: string; stderr: string }
function lw(args: string[]): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: base, LW_TOKEN: TOKEN },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-cli-delivery-'));
  server = createServer((req, res) => {
    if (req.headers.authorization !== `Bearer ${TOKEN}`) return json(res, 401, { error: { code: 'UNAUTHORIZED' } });
    const url = new URL(req.url ?? '/', 'http://local');
    if (req.method === 'GET' && url.pathname === '/api/v1/destinations') {
      return json(res, 200, { destinations: [{
        id: 'archive', kind: 's3', label: 'Campaign archive', formats: ['png', 'pdf'],
        maxBytes: 1048576, visibility: 'private',
      }] });
    }
    if (req.method === 'GET' && url.pathname === '/api/v1/deliveries') return json(res, 200, { deliveries: [delivery] });
    if (req.method === 'GET' && url.pathname === '/api/v1/deliveries/del_1') return json(res, 200, delivery);
    if (req.method === 'POST' && url.pathname === '/api/v1/jobs/job_1/deliveries') {
      publishedIdempotency = String(req.headers['idempotency-key'] ?? '');
      void bodyOf(req).then((body) => {
        publishedBody = body;
        json(res, 201, delivery);
      });
      return;
    }
    if (req.method === 'POST' && url.pathname === '/api/v1/deliveries/del_1/retry') {
      return json(res, 200, { ...delivery, attempt: 2 });
    }
    json(res, 404, { error: { code: 'NOT_FOUND', message: 'no route' } });
  });
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

test('destinations lists only the safe descriptor returned by Work', async () => {
  const result = await lw(['destinations']);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /archive\s+s3\s+private/);
  assert.match(result.stdout, /Campaign archive/);
  assert.equal(result.stdout.includes('credential'), false);
});

test('publish sends a job reference, fixed destination and explicit idempotency key', async () => {
  const result = await lw([
    'deliveries', 'publish', 'job_1', '--destination', 'archive', '--name', 'Campaign',
    '--idempotency-key', 'campaign-once',
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(publishedBody, { destinationId: 'archive', name: 'Campaign' });
  assert.equal(publishedIdempotency, 'campaign-once');
  assert.match(result.stdout, /del_1\s+delivered\s+Campaign\.png → archive/);
});

test('history, receipt and retry remain ordinary principal-scoped API views', async () => {
  const list = await lw(['deliveries']);
  assert.equal(list.code, 0, list.stderr);
  assert.match(list.stdout, /job job_1/);
  const show = await lw(['deliveries', 'show', 'del_1']);
  assert.equal(show.code, 0, show.stderr);
  assert.match(show.stdout, /1234 B · attempt 1 · job job_1/);
  const retry = await lw(['deliveries', 'retry', 'del_1']);
  assert.equal(retry.code, 0, retry.stderr);
  assert.match(retry.stdout, /after attempt 2/);
});
