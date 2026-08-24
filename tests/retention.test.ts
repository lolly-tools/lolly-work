/**
 * Retention + erasure (plans/35 wave 3). The two invariants under test:
 * a trim never breaks the chain's verifiability (anchor before delete, head
 * never trimmed) and never passes the SIEM cursor (delivery before
 * deletion); erasure deletes the id-to-identity mapping while the audit
 * chain keeps its opaque actors and shared work is never silently destroyed.
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
import { runRetention } from '../server/src/audit/retention.ts';
import { auditHead } from '../server/src/audit/head.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const cfg = (over: Record<string, unknown> = {}) => parseConfig(JSON.stringify({
  instance: { name: 'Retain Hub', baseUrl: 'http://localhost', pack: '/tmp' },
  dev: { enabled: true },
  ...over,
}));

const daysAgo = (n: number): string => new Date(Date.now() - n * 24 * 60 * 60 * 1000).toISOString();

async function seedAudit(store: ReturnType<typeof createMemoryStore>, ages: number[]): Promise<void> {
  for (const [i, age] of ages.entries()) {
    await store.appendAudit({ at: daysAgo(age), actor: 'user:u1', action: `a.${i}`, subject: 's' });
  }
}

test('an audit trim anchors first, keeps the head, and the chain still verifies', async () => {
  const store = createMemoryStore();
  await seedAudit(store, [400, 300, 200, 10, 5]); // seq 1..5
  const config = cfg({ policy: { retention: { auditDays: 90 } } });

  const r = await runRetention({ config, store });
  assert.equal(r.auditTrimmed, 3, 'the three dated-out rows went');
  assert.deepEqual((await store.listAudit()).map((e) => e.seq), [4, 5]);
  assert.deepEqual(await store.getAuditAnchor(), { seq: 3, hash: (await store.getAuditAnchor())?.hash }, 'anchored at the boundary');

  const head = await auditHead(store);
  assert.equal(head.chainIntact, true, 'the anchored chain verifies end to end');
  assert.equal(head.seq, 5);

  // Idempotent: nothing else is old enough.
  assert.deepEqual(await runRetention({ config, store }), { telemetryTrimmed: 0, auditTrimmed: 0 });
});

test('the head row survives even when everything is dated out', async () => {
  const store = createMemoryStore();
  await seedAudit(store, [400, 300, 200]);
  const r = await runRetention({ config: cfg({ policy: { retention: { auditDays: 90 } } }), store });
  assert.equal(r.auditTrimmed, 2, 'all but the head');
  const rows = await store.listAudit();
  assert.deepEqual(rows.map((e) => e.seq), [3], 'the head stays');
  const next = await store.appendAudit({ at: new Date().toISOString(), actor: 'user:u1', action: 'a.next', subject: 's' });
  assert.equal(next.seq, 4, 'appends continue from the surviving tail');
  assert.equal((await auditHead(store)).chainIntact, true);
});

test('with SIEM configured, a trim never passes the delivery cursor', async () => {
  const store = createMemoryStore();
  await seedAudit(store, [400, 300, 200, 100]); // all dated out at 90 days
  await store.setSiemCursor(2); // the receiver confirmed only seq 1-2
  const config = cfg({ policy: { retention: { auditDays: 90 } }, siem: { url: 'https://siem.example/x' } });

  const r = await runRetention({ config, store });
  assert.equal(r.auditTrimmed, 2, 'only what was delivered');
  assert.deepEqual((await store.listAudit()).map((e) => e.seq), [3, 4], 'undelivered rows are untouchable');
  assert.equal((await store.getAuditAnchor())?.seq, 2);

  // The receiver catches up; the next run may trim further (head still kept).
  await store.setSiemCursor(4);
  assert.equal((await runRetention({ config, store })).auditTrimmed, 1);
  assert.deepEqual((await store.listAudit()).map((e) => e.seq), [4]);
});

test('telemetry retention is a dated delete; 0 keeps everything', async () => {
  const store = createMemoryStore();
  await store.putEvents([
    { event: 'app.boot', at: daysAgo(100), attrs: {} },
    { event: 'app.boot', at: daysAgo(1), attrs: {} },
  ]);
  assert.deepEqual(await runRetention({ config: cfg(), store }), { telemetryTrimmed: 0, auditTrimmed: 0 }, 'the default keeps everything');
  const r = await runRetention({ config: cfg({ policy: { retention: { telemetryDays: 30 } } }), store });
  assert.equal(r.telemetryTrimmed, 1);
  assert.equal((await store.listEvents()).length, 1);

  assert.throws(() => cfg({ policy: { retention: { telemetryDays: -1 } } }), /retention/);
});

// ── erasure over HTTP ────────────────────────────────────────────────────────

async function boot(): Promise<{ base: string; store: ReturnType<typeof createMemoryStore> }> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-erase-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Erase Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'departed@test', groups: ['member'] },
    ] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sR', link: 'lR' } });
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

test('erasure deletes the mapping, scrubs attribution, and refuses to destroy shared work', async () => {
  const { base, store } = await boot();
  const owner = await login(base, 'owner@test');
  await login(base, 'departed@test');
  const departed = (await store.listUsers()).find((u) => u.email === 'departed@test') as { id: string };
  await store.putEvents([{ event: 'tool.open', at: new Date().toISOString(), attrs: {}, userId: departed.id }]);
  await store.putProject({ id: 'p1', name: 'Campaign', visibility: 'private', ownerId: departed.id, createdAt: new Date().toISOString() });

  const self = (await store.listUsers()).find((u) => u.email === 'owner@test') as { id: string };
  assert.equal((await fetch(`${base}/api/v1/users/${self.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 409, 'self-erasure is refused');

  const blocked = await fetch(`${base}/api/v1/users/${departed.id}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(blocked.status, 409, 'an unarchived project blocks erasure');

  await store.putProject({ id: 'p1', name: 'Campaign', visibility: 'private', ownerId: departed.id, createdAt: new Date().toISOString(), archivedAt: new Date().toISOString() });
  const erased = await fetch(`${base}/api/v1/users/${departed.id}`, { method: 'DELETE', headers: { cookie: owner } });
  assert.equal(erased.status, 200);
  assert.equal(((await erased.json()) as { scrubbed: number }).scrubbed, 1);
  assert.equal((await store.listUsers()).some((u) => u.email === 'departed@test'), false, 'the mapping is gone');
  assert.equal((await store.listEvents()).some((e) => e.userId === departed.id), false, 'attribution is gone');
  // The audit chain keeps its opaque actor - erasure is a mapping delete, not history rewriting.
  assert.ok((await store.listAudit()).some((e) => e.subject === `user:${departed.id}` && e.action === 'user.erase'));
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0025 follows 0024, is the ceiling, and is one row by construction', async () => {
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await readdir(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0025_audit_anchor.sql');
  assert.ok(at > 0, '0025 is on disk');
  assert.equal(files[at - 1], '0024_siem_cursor.sql', '0025 follows 0024 with nothing between');
  assert.equal(files.at(-1), '0025_audit_anchor.sql', 'the audit anchor holds the migration ceiling');
  const sql = await readFile(join(dir, '0025_audit_anchor.sql'), 'utf8');
  assert.match(sql, /create table audit_anchor/);
  assert.match(sql, /check \(id = 1\)/);
});
