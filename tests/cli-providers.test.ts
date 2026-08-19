/**
 * The `lw providers` verbs the onboarding guides promise (plans/33 §2, §2b),
 * exercised as a real subprocess against a real app: `preview` (the dry-run
 * first contact), `drift` (the staged-exit cadence check), and the `auth`
 * refusal that has to name a remedy rather than dead-end.
 *
 * HOME points at a temp dir so the CLI's session file lands there and never
 * touches the developer's own. The provider is the mock driver, so no vendor
 * host is contacted.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { spawn } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
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

const MOCK_ASSETS = [
  { remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: ['event'], approved: true, updatedAt: '2026-06-01T00:00:00.000Z', formats: [{ format: 'png', remoteRef: 'att1' }] },
  { remoteId: 'a2', name: 'Partner Badge', nativeType: 'file', sections: ['Logos'], tags: [], approved: true, updatedAt: '2026-06-01T00:00:00.000Z', formats: [{ format: 'svg', remoteRef: 'att2' }] },
];

interface Run { code: number; stdout: string; stderr: string }

/** Run the CLI as the operator would, with an empty stdin line standing in for
 *  "this kind needs no credential" at the hidden prompt. */
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
  home = await mkdtemp(join(tmpdir(), 'lw-cli-home-'));
  const pack = await mkdtemp(join(tmpdir(), 'lw-cli-pack-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'CLI Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 'sc', link: 'lc', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const login = await lw(['login', '--email', 'admin@test']);
  assert.equal(login.code, 0, login.stderr);
});

after(() => server.close());

test('(a) providers preview: a dry run with no stored record at all', async () => {
  const add = await lw(['providers', 'preview', '--kind', 'mock', '--options', JSON.stringify({ assets: MOCK_ASSETS })]);
  assert.equal(add.code, 0, add.stderr);
  assert.match(add.stdout, /health ok/);
  assert.match(add.stdout, /mapped sample: 2/);
  assert.match(add.stdout, /ext\/preview\/a1/, 'the mapped id is shown, so a mapping mistake is visible at a glance');
  assert.match(add.stdout, /Summit Logo/);
  assert.match(add.stdout, /provider:preview Logos event/, 'sections and tags land where the mapping puts them');
  assert.match(add.stdout, /png/);

  // Nothing was created: preview is not a back door to an unaudited provider.
  const list = await lw(['--json', 'providers', 'list']);
  assert.equal(list.code, 0, list.stderr);
  assert.deepEqual(JSON.parse(list.stdout), []);
});

test('(b) preview reports an unhealthy tenant as a failure, not an empty sample', async () => {
  const r = await lw(['providers', 'preview', '--kind', 'mock', '--options', JSON.stringify({ failWith: 'tenant refused' })]);
  assert.equal(r.code, 2, 'a failed preview is usable as a check');
  assert.match(r.stdout, /health FAILED: tenant refused/);
});

test('(c) preview without --kind fails with the usage line, and --json dumps the raw response', async () => {
  const bad = await lw(['providers', 'preview']);
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /usage: lw providers preview --kind <kind>/);

  const raw = await lw(['--json', 'providers', 'preview', '--kind', 'mock', '--options', JSON.stringify({ assets: MOCK_ASSETS })]);
  assert.equal(raw.code, 0, raw.stderr);
  const body = JSON.parse(raw.stdout) as { health: { ok: boolean }; sample: Array<{ id: string }> };
  assert.equal(body.health.ok, true);
  assert.equal(body.sample.length, 2);
});

test('(d) providers drift names the drifted asset, the never-materialized id, and the remedy', async () => {
  const add = await lw(['providers', 'add', 'dam1', '--kind', 'mock', '--label', 'CLI DAM', '--options', JSON.stringify({ assets: MOCK_ASSETS })]);
  assert.equal(add.code, 0, add.stderr);
  // Enabling is owner-gated; the fixture's admin is not one, so seed through the
  // API as the owner - the CLI verb under test here is drift, not enable.
  const owner = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const ownerCookie = (owner.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/enable`, { method: 'POST', headers: { cookie: ownerCookie } })).status, 200);

  const mat = await lw(['providers', 'materialize', 'dam1', '--remote-id', 'a1']);
  assert.equal(mat.code, 0, mat.stderr);

  const clean = await lw(['providers', 'drift', 'dam1']);
  assert.equal(clean.code, 0, clean.stderr);
  assert.match(clean.stdout, /0 drifted of 1 compared/);
  assert.match(clean.stdout, /never materialized \(1\): a2/);

  // Move a1 forward upstream (the mock's options ARE the tenant).
  const moved = MOCK_ASSETS.map((a) => (a.remoteId === 'a1' ? { ...a, updatedAt: '2026-08-01T12:00:00.000Z' } : a));
  await fetch(`${base}/api/v1/catalog/providers/dam1`, {
    method: 'PUT', headers: { cookie: ownerCookie, 'content-type': 'application/json' }, body: JSON.stringify({ options: { assets: moved } }),
  });

  const r = await lw(['providers', 'drift', 'dam1']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /1 drifted of 1 compared/);
  assert.match(r.stdout, /a1\s+was 2026-06-01T00:00:00.000Z\s+now 2026-08-01T12:00:00.000Z/);
  assert.match(r.stdout, /lw providers materialize dam1 --remote-id <remoteId>/, 'the remedy is printed, not implied');
});

test('(e1) preview applies the exposure slice a real sync applies, and says what it removed', async () => {
  // The dry run an operator enables on the strength of: an asset the slice
  // would refuse must not appear in it, or the federation that follows maps
  // nothing and the preview said otherwise.
  const mixed = [
    { remoteId: 'ok1', name: 'Approved Art', nativeType: 'file', sections: ['Logos'], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'r1' }] },
    { remoteId: 'no1', name: 'Draft Art', nativeType: 'file', sections: ['Logos'], tags: [], approved: false, formats: [{ format: 'png', remoteRef: 'r2' }] },
  ];
  const r = await lw(['providers', 'preview', '--kind', 'mock',
    '--options', JSON.stringify({ assets: mixed }),
    '--exposure', JSON.stringify({ requireApproved: true })]);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /mapped sample: 1 of 1 on the first page, 1 EXCLUDED by the exposure slice/);
  assert.match(r.stdout, /ext\/preview\/ok1/);
  assert.ok(!/ext\/preview\/no1/.test(r.stdout), 'an asset the slice refuses never appears in the sample');

  // And when the slice takes everything, the empty sample names its own cause.
  const all = await lw(['providers', 'preview', '--kind', 'mock',
    '--options', JSON.stringify({ assets: [mixed[1]] }),
    '--exposure', JSON.stringify({ requireApproved: true })]);
  assert.equal(all.code, 0, all.stderr);
  assert.match(all.stdout, /the exposure slice excluded every asset on this page \(1\)/);
});

test('(e2) materialize prints per-asset failures rather than hiding them behind --json', async () => {
  // Step 3 of every live-verify runbook is this command, and each per-asset
  // error carries the driver's own diagnosis - unreadable if only --json has it.
  const assets = [
    { remoteId: 'b1', name: 'Good', nativeType: 'file', sections: [], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'r1' }] },
    { remoteId: 'b2', name: 'Bad', nativeType: 'file', sections: [], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'r2' }] },
  ];
  const add = await lw(['providers', 'add', 'dam2', '--kind', 'mock', '--label', 'Fault DAM',
    '--options', JSON.stringify({ assets, failBlobFor: ['b2'] })]);
  assert.equal(add.code, 0, add.stderr);
  const r = await lw(['providers', 'materialize', 'dam2']);
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /materialized 1 asset\(s\) from dam2/);
  assert.match(r.stdout, /1 asset\(s\) FAILED:/);
  assert.match(r.stdout, /b2: mock blob refused for b2/, 'the remote id and the driver message both print');
});

test('(e) providers auth on a kind with no registered flow names the remedy instead of dead-ending', async () => {
  const add = await lw(['providers', 'add', 'ir1', '--kind', 'imagerelay', '--label', 'Legacy DAM']);
  assert.equal(add.code, 0, add.stderr);
  const r = await lw(['providers', 'auth', 'ir1']);
  assert.equal(r.code, 1);
  assert.match(r.stderr, /no loopback consent flow is registered for kind imagerelay/);
  assert.match(r.stderr, /lw providers credential ir1/, 'the refusal names the flow that does work');
  assert.match(r.stderr, /confirmed\s+against a real tenant first/, 'and says why there is no flow yet');
  assert.ok(!/https:\/\//.test(r.stderr), 'no invented authorize URL is offered');
});
