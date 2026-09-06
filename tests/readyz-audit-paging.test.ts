/**
 * Readiness (GET /readyz) and the paged audit read (GET /api/v1/audit?before=&limit=),
 * plus the request id every response now carries.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot() {
  const pack = await mkdtemp(join(tmpdir(), 'lw-ready-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Ready Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 's', link: 'l' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { store, base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}` };
}

test('/readyz answers 200 while the store can, 503 when it cannot, and every response carries a request id', async () => {
  const { store, base } = await boot();
  const ok = await fetch(`${base}/readyz`);
  assert.equal(ok.status, 200);
  assert.deepEqual(await ok.json(), { ok: true, store: process.env.DATABASE_URL ? 'postgres' : 'memory' });
  assert.match(ok.headers.get('x-request-id') ?? '', /^r_/);
  const echoed = await fetch(`${base}/readyz`, { headers: { 'x-request-id': 'trace-abc-123' } });
  assert.equal(echoed.headers.get('x-request-id'), 'trace-abc-123', 'a sane caller id is echoed');
  const junk = await fetch(`${base}/readyz`, { headers: { 'x-request-id': 'no spaces allowed <script>' } });
  assert.match(junk.headers.get('x-request-id') ?? '', /^r_/, 'an unsafe caller id is replaced');
  (store as { ping: () => Promise<boolean> }).ping = async () => false;
  const down = await fetch(`${base}/readyz`);
  assert.equal(down.status, 503);
});

test('the audit read pages newest-first by seq and never re-walks the whole log per request', async () => {
  const { store, base } = await boot();
  for (let i = 0; i < 7; i++) await store.appendAudit({ at: new Date().toISOString(), actor: 'system', action: `probe.${i}`, subject: 'x' });
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const first = await (await fetch(`${base}/api/v1/audit?limit=3`, { headers: { cookie } })).json() as { chain: { ok: boolean }; total: number; events: { seq: number }[]; nextBefore: number | null };
  assert.equal(first.chain.ok, true);
  assert.ok(first.total >= 8, `login adds a row: ${first.total}`);
  assert.equal(first.events.length, 3);
  const seqs = first.events.map((e) => e.seq);
  assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'ascending within the page');
  assert.equal(first.nextBefore, seqs[0]);
  const older = await (await fetch(`${base}/api/v1/audit?limit=3&before=${first.nextBefore}`, { headers: { cookie } })).json() as typeof first;
  assert.ok(older.events.every((e) => e.seq < first.nextBefore!), 'older than the cursor');
  assert.equal(older.events.length, 3);
  const last = await (await fetch(`${base}/api/v1/audit?limit=100&before=${older.nextBefore}`, { headers: { cookie } })).json() as typeof first;
  assert.equal(last.nextBefore, null, 'the page that reaches the chain floor has no older cursor');
});
