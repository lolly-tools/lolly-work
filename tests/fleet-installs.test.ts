/**
 * The fleet install registry (plans/34 wave 3) over real HTTP.
 *
 * The covenant is the thing under test: an install row exists ONLY because a
 * device spoke `install/<id>` on a request that carried a live member session.
 * Anonymous and guest traffic with the same tag feeds the histogram and
 * nothing else; forgetting a row is a delete the next signed-in request
 * undoes; rename/forget are admin bookkeeping behind `fleet.manage`.
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

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Booted { base: string; store: ReturnType<typeof createMemoryStore> }

async function boot(): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-installs-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Fleet Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'maker@test', groups: ['member'] },
    ] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sI', link: 'lI' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** One tagged request; the wrapper's install upsert is fire-and-forget, so give
 *  the microtask queue a beat before asserting. */
async function tagged(base: string, cookie: string | null, tag: string): Promise<void> {
  await fetch(`${base}/healthz`, { headers: { 'x-lolly-client': tag, ...(cookie ? { cookie } : {}) } });
  await new Promise((r) => setTimeout(r, 25));
}

test('a member request with an install tag registers the install; anonymous never does', async () => {
  const { base, store } = await boot();
  const cookie = await login(base, 'maker@test');

  await tagged(base, null, 'tauri engine/1.146.0 platform/macos install/ins-anon');
  assert.equal((await store.listInstalls()).length, 0, 'anonymous tagged traffic mints nothing');

  await tagged(base, cookie, 'tauri engine/1.146.0 platform/macos install/ins-a');
  const rows = await store.listInstalls();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.installId, 'ins-a');
  assert.equal(rows[0]?.info.engine, '1.146.0');
  assert.ok(rows[0]?.userIdLastSeen, 'the member who spoke is recorded');

  // The same device on a newer engine refreshes in place - one row per install.
  await tagged(base, cookie, 'tauri engine/1.147.0 platform/macos install/ins-a');
  const after1 = await store.listInstalls();
  assert.equal(after1.length, 1);
  assert.equal(after1[0]?.info.engine, '1.147.0');

  // The histogram still counts every tagged request, registered or not.
  assert.ok((await store.fleetSummary()).length >= 1);
});

test('list, rename and forget are admin surfaces; a member is refused', async () => {
  const { base } = await boot();
  const admin = await login(base, 'admin@test');
  const member = await login(base, 'maker@test');
  await tagged(base, member, 'tauri engine/1.146.0 install/ins-b');

  const forMember = await fetch(`${base}/api/v1/fleet/installs`, { headers: { cookie: member } });
  assert.equal(forMember.status, 403, 'fleet.view is admin-tier');

  const list = await fetch(`${base}/api/v1/fleet/installs`, { headers: { cookie: admin } });
  assert.equal(list.status, 200);
  const { installs } = (await list.json()) as { installs: Array<{ installId: string; userName?: string }> };
  assert.equal(installs[0]?.installId, 'ins-b');
  assert.equal(installs[0]?.userName, 'maker@test', 'the last-seen member is named for the table');

  const deny = await fetch(`${base}/api/v1/fleet/installs/ins-b`, {
    method: 'PATCH', headers: { cookie: member, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'mine' }),
  });
  assert.equal(deny.status, 403, 'fleet.manage is admin-tier');

  const rename = await fetch(`${base}/api/v1/fleet/installs/ins-b`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Studio laptop' }),
  });
  assert.equal(rename.status, 200);
  assert.equal(((await rename.json()) as { name?: string }).name, 'Studio laptop');

  const missing = await fetch(`${base}/api/v1/fleet/installs/ins-nope`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'x' }),
  });
  assert.equal(missing.status, 404);

  const badBody = await fetch(`${base}/api/v1/fleet/installs/ins-b`, {
    method: 'PATCH', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ name: 7 }),
  });
  assert.equal(badBody.status, 400);

  const forget = await fetch(`${base}/api/v1/fleet/installs/ins-b`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(forget.status, 200);
  const emptied = await fetch(`${base}/api/v1/fleet/installs`, { headers: { cookie: admin } });
  assert.equal(((await emptied.json()) as { installs: unknown[] }).installs.length, 0);

  // Forget is bookkeeping, not banishment: the device's next signed-in request
  // re-registers it. That is the covenant, not a bug.
  await tagged(base, member, 'tauri engine/1.146.0 install/ins-b');
  const back = await fetch(`${base}/api/v1/fleet/installs`, { headers: { cookie: admin } });
  assert.equal(((await back.json()) as { installs: unknown[] }).installs.length, 1);
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0022 follows 0021, is the ceiling, and keeps the covenant in schema', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0022_fleet_installs.sql');
  assert.ok(at > 0, '0022 is on disk');
  assert.equal(files[at - 1], '0021_scim.sql', '0022 follows 0021 with nothing between');
  assert.equal(files.at(-1), '0022_fleet_installs.sql', 'the install registry holds the migration ceiling');
  const sql = await readFile(join(dir, '0022_fleet_installs.sql'), 'utf8');
  assert.match(sql, /create table fleet_installs/);
  assert.match(sql, /install_id\s+text primary key/);
  assert.equal(/references\s+users/i.test(sql), false, 'user_id_last_seen is a pointer, not a foreign key');
  assert.equal(/^\s*(begin|commit|rollback)\b/im.test(sql), false, 'the runner wraps each file in its own transaction');
  const driver = await readFile(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /insert into fleet_installs/);
});
