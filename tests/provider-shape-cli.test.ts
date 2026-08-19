/**
 * `--shape` end to end (plans/33 §3): the flag on `lw providers preview`, the
 * preview route that carries it, and the rendered report an operator reads.
 *
 * The app's outbound fetch is injected, so the "tenant" here is a fixture: no
 * vendor host is contacted and no credential exists. The CLI runs as a real
 * subprocess with HOME pointed at a temp dir, the way cli-providers.test.ts
 * does, because the point is what an operator sees in a terminal.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const CLI = join(dirname(fileURLToPath(import.meta.url)), '..', 'cli', 'lw.ts');

let server: Server;
let base = '';
let home = '';

/** Values a leak test would catch; key names are what the report may carry. */
const CANTO_PAGE = {
  results: [{
    id: 'LEAK-AB12', scheme: 'image', name: 'LEAK-banner.png', size: 2048,
    lastModified: 'LEAK-2026-06-01', approvalStatus: 'LEAK-approved',
    tag: ['LEAK-event'], album: 'LEAK-Campaigns',
    additional: { 'Expiry Date': 'LEAK-2027' },
  }],
  found: 1, limit: 100, start: 0,
};

/** The other tenant: an Image Relay one, because it is a kind whose bytes come
 *  from a per-asset DETAIL call - the arm `--remote-id` reports on. */
const IR_PAGE = { files: [{ id: 55, filename: 'LEAK-summit.png', updated_at: 'LEAK-2026-06-01' }], meta: { next_page: null } };
const IR_DETAIL = { file: { id: 55, size: 2048, download_url: 'LEAK-https://example.invalid/d', quick_link: 'LEAK-https://example.invalid/q' } };

/** Swappable so one test can serve a tenant that names its envelope key
 *  differently - the case where the listing fails and the report explains it. */
let page: unknown = CANTO_PAGE;

/** The tenant, as a fixture. Anything else 404s. */
const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  if ((init?.method ?? 'GET') === 'POST' && (url.includes('/oauth2/token') || url.includes('/oauth/token'))) {
    return new Response(JSON.stringify({ access_token: 'tok', expires_in: 3600 }), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/api/v1/image?')) {
    return new Response(JSON.stringify(page), { headers: { 'content-type': 'application/json' } });
  }
  if (/\/api\/v2\/files\/55$/.test(url)) {
    return new Response(JSON.stringify(IR_DETAIL), { headers: { 'content-type': 'application/json' } });
  }
  if (url.includes('/api/v2/files?')) {
    return new Response(JSON.stringify(IR_PAGE), { headers: { 'content-type': 'application/json' } });
  }
  return new Response('not found', { status: 404 });
}) as typeof fetch;

interface Run { code: number; stdout: string; stderr: string }

function lw(args: string[], stdin = '\n'): Promise<Run> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CLI, ...args], {
      env: { ...process.env, HOME: home, LW_BASE: base },
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (b: Buffer) => { stdout += b.toString(); });
    child.stderr.on('data', (b: Buffer) => { stderr += b.toString(); });
    child.stdin.end(stdin);
    child.on('close', (code) => resolve({ code: code ?? 0, stdout, stderr }));
  });
}

before(async () => {
  home = await mkdtemp(join(tmpdir(), 'lw-shape-home-'));
  const pack = await mkdtemp(join(tmpdir(), 'lw-shape-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Shape Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'sc', link: 'lc', credential: 'a-32-byte-or-longer-master-secret!' }, fetchImpl });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const login = await lw(['login', '--email', 'admin@test']);
  assert.equal(login.code, 0, login.stderr);
});

after(() => server.close());

const CRED = JSON.stringify({ clientId: 'cid', clientSecret: 'sec', refreshToken: 'rt' });

test('lw providers preview --shape prints the report and nothing else', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'canto', '--shape', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /health ok - canto/);
  assert.match(r.stdout, /^canto {2}GET \/api\/v1\/image\?limit=100&start=0$/m);
  assert.match(r.stdout, /envelope: results: object\[\] \(1\)/);
  assert.match(r.stdout, /MAPPED BY THIS DRIVER: /);
  assert.match(r.stdout, /IN THE RESPONSE, NOT MAPPED: .*found/);
  assert.match(r.stdout, /EXPECTED BY THIS DRIVER, ABSENT: /);
  assert.match(r.stdout, /note: custom-field key names are upstream-authored/);
  // The whole point of the mode: the output is sendable as it stands, so a
  // plain redirect produces the artefact a driver author asked for.
  assert.doesNotMatch(r.stdout, /mapped sample/, 'no sample in shape mode');
  assert.doesNotMatch(r.stdout, /LEAK-/, 'no upstream VALUE anywhere in the output');
  assert.match(r.stdout, /Expiry Date/, 'an upstream-authored KEY name does appear, which is the stated caveat');
});

test('without --shape the preview is the mapped sample, and only that', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'canto', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.doesNotMatch(r.stdout, /MAPPED BY THIS DRIVER/);
  assert.match(r.stdout, /mapped sample: 1/);
  assert.match(r.stdout, /note: canto treated all 1 asset\(s\) on this page as not approved/, 'a guess that matched nothing is said out loud');
});

test('--shape on a kind with no live-verify debt says so instead of reporting nothing', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'mock', '--shape', '--options', JSON.stringify({ assets: [] })]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mock: this driver carries no live-verify debt/);
});

test('--json in shape mode is the report alone: no sample, no upstream value on the wire', async () => {
  const r = await lw(['--json', 'providers', 'preview', '--kind', 'canto', '--shape', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
  assert.equal(r.code, 0, r.stderr);
  const body = JSON.parse(r.stdout) as Record<string, unknown> & { shape: { kind: string; recordsKey: string; mapped: string[] }; shapeText: string[] };
  assert.equal(body.shape.kind, 'canto');
  assert.equal(body.shape.recordsKey, 'results');
  assert.ok(body.shape.mapped.includes('scheme'));
  assert.ok(body.shapeText.length > 5);
  // The contract, key by key: what shape mode returns is exactly this set, so
  // redirecting the response to a file cannot pick up asset data.
  assert.deepEqual(Object.keys(body).sort(), ['health', 'shape', 'shapeText']);
  assert.doesNotMatch(r.stdout, /LEAK-/, 'no upstream value anywhere in the response');
});

test('--shape --remote-id adds the report on the call the bytes come from', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'imagerelay', '--shape', '--remote-id', '55'], `${CRED}\n`);
  assert.equal(r.code, 0, r.stderr);
  // Both reports, list first: the list one answers the field names, the detail
  // one answers the wrapper and the download link that decide the exit.
  assert.match(r.stdout, /^imagerelay {2}GET \/api\/v2\/files\?per_page=100&page=1$/m);
  assert.match(r.stdout, /^imagerelay {2}GET \/api\/v2\/files\/55$/m);
  assert.match(r.stdout, /record: \(the one record this call returned, wrapped in "file"\)/);
  assert.match(r.stdout, /IN THE RESPONSE, NOT MAPPED: .*quick_link/);
  assert.doesNotMatch(r.stdout, /LEAK-/, 'the detail report carries no value either');
});

test('--shape --remote-id on a kind with no detail call says so rather than reporting nothing', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'canto', '--shape', '--remote-id', 'image:AB12C',
    '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /canto: this driver makes no per-asset detail call/);
});

test('a tenant whose listing would break still gets the report that diagnoses it', async () => {
  // This tenant calls the record array something else, so `preview` without
  // --shape fails on the envelope-key guess. --shape must not fail with it: the
  // structure report IS the answer to that failure, and a mode that lost it to
  // the very break it explains would be useless on the day it is needed.
  page = { records: [{ id: 'LEAK-X1', scheme: 'image' }], total: 1 };
  try {
    const plain = await lw(['providers', 'preview', '--kind', 'canto', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
    assert.match(plain.stdout, /listing FAILED: canto list response carried no record array/);
    assert.match(plain.stdout, /fix LIST_ENVELOPE_KEYS in server\/src\/catalog\/providers\/canto\.ts/);
    assert.match(plain.stdout, /docs\/providers\/canto-live-verify\.md/);

    const r = await lw(['providers', 'preview', '--kind', 'canto', '--shape', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
    assert.equal(r.code, 0, r.stderr);
    assert.match(r.stdout, /record: \(no record array found/, 'the diagnosis is there');
    assert.match(r.stdout, /IN THE RESPONSE, NOT MAPPED: .*records/, 'and the real key is right there');
    assert.doesNotMatch(r.stdout, /LEAK-/, 'still no upstream value, broken tenant or not');
  } finally {
    page = CANTO_PAGE;
  }
});

test('the preview route reports a listing failure, and the console renders it as a failure', async () => {
  // The route: a tenant whose health check passes and whose listing breaks on a
  // live-verify guess answers 200 with health.ok true - the shape report above
  // is the diagnosis, and losing it to the failure it explains would waste the
  // call. That makes `sampleError` the failure signal for every consumer.
  page = { records: [{ id: 'LEAK-X1', scheme: 'image' }], total: 1 };
  try {
    const r = await lw(['--json', 'providers', 'preview', '--kind', 'canto', '--options', JSON.stringify({ tenant: 'acme', minGapMs: 0 })], `${CRED}\n`);
    assert.equal(r.code, 0, r.stderr);
    const body = JSON.parse(r.stdout) as { health: { ok: boolean }; sample: unknown[]; sampleError?: string };
    assert.equal(body.health.ok, true);
    assert.equal(body.sample.length, 0);
    assert.match(body.sampleError ?? '', /carried no record array/, 'the remedy string is on the wire');
  } finally {
    page = CANTO_PAGE;
  }

  // The console add-wizard is the surface a platform team reaches for first, so
  // it must not read that response as "connection ok, 0 assets". Scanned rather
  // than rendered: there is no DOM here, and the branch is the whole point.
  const src = readFileSync(join(dirname(fileURLToPath(import.meta.url)), '..', 'console', 'app.js'), 'utf8');
  const at = src.indexOf("'/api/v1/catalog/providers/preview'");
  assert.ok(at > 0, 'found the console preview handler');
  const handler = src.slice(at, at + 1600);
  assert.match(handler, /r\.sampleError/, 'the handler reads sampleError');
  assert.match(handler, /!r\.health\.ok \|\| r\.sampleError/, 'and treats it as a failure, not as an empty sample');
  assert.match(handler, /r\.skipped/, 'a source that maps none of what it read says so');
  assert.match(handler, /r\.notes/);
  const okAt = handler.indexOf("'connection ok'");
  assert.ok(okAt > handler.indexOf('r.sampleError'), 'the green line is reached only after the failure check');
});
