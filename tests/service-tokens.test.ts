/**
 * Service tokens (plans/35 wave 2) over real HTTP. What matters and is
 * pinned: minting is an owner act and the secret appears exactly once; a
 * bearer drives the ACTION-GATED surface as its role and no further; the
 * member-workflow routes refuse tokens (a token deciding an approval would
 * launder authorship); revocation kills the very next use.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { SERVICE_TOKEN_PREFIX } from '../server/src/iam/service-tokens.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(): Promise<string> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-tokens-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Token Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sT', link: 'lT' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const mint = (base: string, cookie: string, label: string, role: string) =>
  fetch(`${base}/api/v1/tokens`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ label, role }),
  });

test('minting is owner-only, the secret is shown once, and the bearer acts as its role', async () => {
  const base = await boot();
  const owner = await login(base, 'owner@test');
  const admin = await login(base, 'admin@test');

  assert.equal((await mint(base, admin, 'ci', 'admin')).status, 403, 'token.manage is owner-tier');
  assert.equal((await mint(base, owner, '', 'admin')).status, 400, 'a token names its automation');
  assert.equal((await mint(base, owner, 'g', 'guest')).status, 400, 'guest is not a mintable role');

  const created = await mint(base, owner, 'ci', 'admin');
  assert.equal(created.status, 201);
  const t = (await created.json()) as { id: string; token: string };
  assert.ok(t.token.startsWith(SERVICE_TOKEN_PREFIX), 'recognizable prefix');

  // The list never carries the secret again.
  const listed = await (await fetch(`${base}/api/v1/tokens`, { headers: { cookie: owner } })).json() as { tokens: Array<Record<string, unknown>> };
  assert.equal(listed.tokens.length, 1);
  assert.ok(!JSON.stringify(listed).includes(t.token), 'the secret appears exactly once, at mint');

  // The bearer drives an action-gated route as its role...
  const auth = { authorization: `Bearer ${t.token}` };
  const fleet = await fetch(`${base}/api/v1/fleet`, { headers: auth });
  assert.equal(fleet.status, 200, 'an admin token reads the fleet');
  // ...and its use stamps lastUsedAt for the operator's review.
  const after1 = await (await fetch(`${base}/api/v1/tokens`, { headers: { cookie: owner } })).json() as { tokens: Array<{ lastUsedAt: string | null }> };
  assert.ok(after1.tokens[0]?.lastUsedAt, 'use is visible');

  // A viewer token is refused where its role is - RBAC, one model.
  const small = await (await mint(base, owner, 'reader', 'viewer')).json() as { token: string };
  assert.equal((await fetch(`${base}/api/v1/fleet`, { headers: { authorization: `Bearer ${small.token}` } })).status, 403);

  // The member-workflow surface refuses tokens outright.
  const approvals = await fetch(`${base}/api/v1/approvals`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectType: 'asset', subjectRef: 'x', title: 'T', chainId: 'nope' }),
  });
  assert.equal(approvals.status, 401, 'deciding-shaped routes stay human');

  // Revocation kills the next use; a second revoke reports the truth.
  assert.equal((await fetch(`${base}/api/v1/tokens/${t.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/fleet`, { headers: auth })).status, 401);
  assert.equal((await fetch(`${base}/api/v1/tokens/${t.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 404);
});

test('an owner token can run the governance round trip CI needs', async () => {
  const base = await boot();
  const owner = await login(base, 'owner@test');
  const t = (await (await mint(base, owner, 'governance-ci', 'owner')).json()) as { token: string };
  const auth = { authorization: `Bearer ${t.token}` };
  const exported = await fetch(`${base}/api/v1/config/export`, { headers: auth });
  assert.equal(exported.status, 200, 'lw export works on a token');
  const doc = await exported.json();
  const applied = await fetch(`${base}/api/v1/config/apply?dryRun=1`, {
    method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(doc),
  });
  assert.equal(applied.status, 200, 'lw apply --dry-run works on a token');
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0023 follows 0022 and stores hashes, never secrets', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0023_api_tokens.sql');
  assert.ok(at > 0, '0023 is on disk');
  assert.equal(files[at - 1], '0022_fleet_installs.sql', '0023 follows 0022 with nothing between');
  const sql = await readFile(join(dir, '0023_api_tokens.sql'), 'utf8');
  assert.match(sql, /create table api_tokens/);
  assert.match(sql, /token_hash\s+text not null unique/);
  assert.equal(/references\s+users/i.test(sql), false, 'created_by is a label, not a foreign key');
  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into api_tokens/);
});
