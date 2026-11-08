import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'cli', 'lw.ts');
const SENT = { id: 'msg_test', kind: 'announcement', severity: 'info', audience: { groups: ['partner-team'] }, title: 'Start here', dismissible: true };

interface Exchange { method: string; path: string; body?: unknown; answer: unknown; status?: number }

let home = '';
let preload = '';
let runNumber = 0;
before(() => {
  home = mkdtempSync(join(ROOT, '.cli-messages-'));
  preload = join(home, 'fake-api.mjs');
  writeFileSync(preload, `
    import { readFileSync, writeFileSync } from 'node:fs';
    const replies = JSON.parse(readFileSync(process.env.LW_CLI_REPLIES, 'utf8'));
    const requests = [];
    globalThis.fetch = async (url, options) => {
      const request = new Request(url, options);
      const address = new URL(request.url);
      const reply = replies[requests.length];
      requests.push({ method: request.method, path: address.pathname + address.search, body: await request.text() });
      writeFileSync(process.env.LW_CLI_REQUESTS, JSON.stringify(requests));
      return Response.json(reply?.answer ?? { error: { code: 'UNEXPECTED_REQUEST', message: 'no reply prepared' } },
        { status: reply?.status ?? (reply ? 200 : 500) });
    };
  `);
});
after(() => { rmSync(home, { recursive: true, force: true }); });

/** Run the real CLI against a fake API and check every request it made. */
async function lw(args: string[], exchanges: Exchange[] = []): Promise<{ code: number; stdout: string; stderr: string }> {
  const run = ++runNumber;
  const repliesFile = join(home, `replies-${run}.json`);
  const requestsFile = join(home, `requests-${run}.json`);
  writeFileSync(repliesFile, JSON.stringify(exchanges));
  writeFileSync(requestsFile, '[]');
  const result = await new Promise<{ code: number; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, ['--import', preload, CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: 'http://cli.test', LW_TOKEN: 'messages-test-token',
        LW_CLI_REPLIES: repliesFile, LW_CLI_REQUESTS: requestsFile },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (bytes: Buffer) => { stdout += bytes.toString(); });
    child.stderr.on('data', (bytes: Buffer) => { stderr += bytes.toString(); });
    child.stdin.end();
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
  });
  const requests = JSON.parse(readFileSync(requestsFile, 'utf8')) as Array<{ method: string; path: string; body: string }>;
  assert.equal(requests.length, exchanges.length, result.stderr);
  for (const [index, expected] of exchanges.entries()) {
    assert.equal(requests[index]!.method, expected.method);
    assert.equal(requests[index]!.path, expected.path);
    assert.deepEqual(JSON.parse(requests[index]!.body), expected.body);
  }
  return result;
}

test('msg send keeps a multi-line body and sends no start or end unless asked', async () => {
  const body = 'First line.\n\nSecond paragraph.';
  const result = await lw(['msg', 'send', '--title', 'Start here', '--body', body, '--groups', 'partner-team'], [
    { method: 'POST', path: '/api/v1/messages', status: 201, answer: SENT,
      body: { title: 'Start here', body, kind: 'announcement', severity: 'info', audience: { groups: ['partner-team'] } } },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.trim(), 'sent msg_test');
});

test('msg send --starts and --ends send the UTC instants the server stores', async () => {
  const result = await lw(['msg', 'send', '--title', 'Start here', '--groups', 'partner-team',
    '--starts', '2099-01-01T09:00:00+01:00', '--ends', '2099-02-01T00:00:00Z'], [
    { method: 'POST', path: '/api/v1/messages', status: 201, answer: SENT,
      body: { title: 'Start here', kind: 'announcement', severity: 'info', audience: { groups: ['partner-team'] },
        startsAt: '2099-01-01T08:00:00.000Z', endsAt: '2099-02-01T00:00:00.000Z' } },
  ]);
  assert.equal(result.code, 0, result.stderr);
  assert.match(result.stdout, /sent msg_test \(shows from 2099-01-01T08:00:00\.000Z until 2099-02-01T00:00:00\.000Z\)/);
});

test('msg send refuses a time without a zone, an end in the past and an end before the start, before any request', async () => {
  for (const [args, message] of [
    [['--ends', '2099-02-01'], /--ends wants a real date and time with its zone/],
    [['--starts', '2099-02-01T09:00:00'], /--starts wants a real date and time with its zone/],
    [['--ends', 'next week'], /--ends wants a real date and time with its zone/],
    [['--ends', '2099-02-31T09:00:00Z'], /--ends wants a real date and time with its zone/],
    [['--ends', '2099-02-01T24:00:00Z'], /--ends wants a real date and time with its zone/],
    [['--starts', '2099-02-01T09:00:00+25:00'], /--starts wants a real date and time with its zone/],
    [['--ends', '2000-01-01T00:00:00Z'], /--ends is in the past/],
    [['--starts', '2099-02-01T00:00:00Z', '--ends', '2099-01-01T00:00:00Z'], /--ends must be later than --starts/],
  ] as const) {
    const result = await lw(['msg', 'send', '--title', 'Start here', ...args]);
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, message);
  }
});
