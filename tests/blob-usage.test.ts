/**
 * Blob and origin metrics and the offload trigger (plan 80 section 10): each
 * driver counts the bytes read from it, `/metrics` exposes reads, stored bytes
 * and origin bytes by delivery class, and crossing the provisional thresholds
 * raises a console alert and one administrator email per month.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { createS3BlobStore } from '../server/src/blobs/s3.ts';
import { usageMonth, type BlobStore, type BlobUsage } from '../server/src/blobs/types.ts';
import { blobUsageLines, countResponseBytes, createMetrics } from '../server/src/observability/metrics.ts';
import { OFFLOAD_THRESHOLDS, notifyOffloadAlerts, offloadAlerts } from '../server/src/observability/offload-trigger.ts';
import { administratorAddresses, type Notifier } from '../server/src/notify/notify.ts';
import { createRouter, deliveryClassOf } from '../server/src/api/router.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

const GiB = 1024 ** 3;
const drain = async (body: ReadableStream<Uint8Array>): Promise<string> => new Response(body).text();

test('memory driver: reads, stored bytes and the monthly figure', async () => {
  const blobs = createMemoryBlobStore();
  assert.equal(blobs.driver, 'memory');
  await blobs.put('a', Buffer.from('12345'), 'text/plain');
  await blobs.put('b', Buffer.from('123'), 'text/plain');
  assert.equal(await blobs.get('missing'), null);
  await blobs.head('a');
  await drain((await blobs.get('a'))!.body);
  await drain((await blobs.get('b'))!.body);
  const usage = await blobs.usage!();
  assert.deepEqual(usage, { driver: 'memory', storedBytes: 8, readBytesTotal: 8, month: usageMonth(), monthReadBytes: 8 });
  await blobs.delete('a');
  assert.equal((await blobs.usage!()).storedBytes, 3, 'a delete leaves the stored total');
});

test('notice claims: once per month and kind', async () => {
  const blobs = createMemoryBlobStore();
  assert.equal(await blobs.claimUsageNotice!('2026-10', 'stored'), true);
  assert.equal(await blobs.claimUsageNotice!('2026-10', 'stored'), false);
  assert.equal(await blobs.claimUsageNotice!('2026-10', 'read'), true);
  assert.equal(await blobs.claimUsageNotice!('2026-11', 'stored'), true);
});

test('s3 driver: counts bytes as they stream and reports no stored total', async () => {
  const fetchImpl = (async () => new Response('ten bytes!', { status: 200, headers: { 'content-length': '10' } })) as typeof fetch;
  const blobs = createS3BlobStore({ bucket: 'b', region: 'us-east-1' }, 'AKIAEXAMPLE:secret', fetchImpl);
  assert.equal(blobs.driver, 's3');
  const got = await blobs.get('k');
  assert.equal((await blobs.usage!()).readBytesTotal, 0, 'nothing counted before the body is read');
  assert.equal(await drain(got!.body), 'ten bytes!');
  const usage = await blobs.usage!();
  assert.equal(usage.readBytesTotal, 10);
  assert.equal(usage.monthReadBytes, 10);
  assert.equal(usage.storedBytes, null);
});

const pgUsage = (over: Partial<BlobUsage> = {}): BlobUsage => ({ driver: 'pg', storedBytes: 1, readBytesTotal: 0, month: '2026-10', monthReadBytes: 0, ...over });

test('offload alerts fire at the provisional thresholds, for the pg driver only', () => {
  assert.deepEqual(OFFLOAD_THRESHOLDS, { storedBytes: 10 * GiB, monthReadBytes: 100 * GiB });
  assert.deepEqual(offloadAlerts(pgUsage({ storedBytes: 10 * GiB - 1, monthReadBytes: 100 * GiB - 1 })), []);
  const stored = offloadAlerts(pgUsage({ storedBytes: 10 * GiB }));
  assert.deepEqual(stored.map(a => [a.id, a.value, a.threshold]), [['blob-offload-stored', 10 * GiB, 10 * GiB]]);
  assert.match(stored[0]!.detail, /10\.0 GiB/);
  assert.equal(stored[0]!.href, '#/docs?doc=operations&anchor=blob-offload-trigger');
  const read = offloadAlerts(pgUsage({ monthReadBytes: 150 * GiB }));
  assert.deepEqual(read.map(a => [a.id, a.month]), [['blob-offload-read', '2026-10']]);
  assert.match(read[0]!.detail, /150\.0 GiB .* in 2026-10/);
  assert.deepEqual(offloadAlerts({ ...pgUsage({ storedBytes: 20 * GiB, monthReadBytes: 200 * GiB }), driver: 's3' }), []);
  assert.deepEqual(offloadAlerts({ ...pgUsage({ monthReadBytes: 200 * GiB }), driver: 'memory' }), []);
  assert.deepEqual(offloadAlerts(pgUsage({ storedBytes: 5 }), { storedBytes: 5, monthReadBytes: 10 }).map(a => a.kind), ['stored']);
});

/** A memory store that reports pg-sized usage, so alerts can fire in a test. */
function overThresholdBlobs(): BlobStore {
  const inner = createMemoryBlobStore();
  return { ...inner, driver: 'pg', usage: async () => pgUsage({ storedBytes: 11 * GiB, readBytesTotal: 42, month: usageMonth(), monthReadBytes: 101 * GiB }) };
}

test('the daily check emails administrators once per alert per month', async () => {
  const mails: Array<{ to: Array<string | undefined>; subject: string; text: string }> = [];
  const events: Array<{ kind: string; data: Record<string, unknown> }> = [];
  const notifier: Notifier = {
    email: (to, subject, text) => { mails.push({ to, subject, text }); },
    event: (kind, data) => { events.push({ kind, data }); },
    idle: async () => {},
  };
  const blobs = overThresholdBlobs();
  const recipients = async () => administratorAddresses([
    { email: 'owner@example.test', role: 'owner' },
    { email: 'admin@example.test', role: 'admin' },
    { email: 'gone@example.test', role: 'admin', disabledAt: '2026-01-01T00:00:00Z' },
    { email: 'member@example.test', role: 'member' },
  ]);
  const first = await notifyOffloadAlerts({ blobs, notifier, recipients, baseUrl: 'https://work.example.test' });
  assert.deepEqual(first.map(a => a.kind), ['stored', 'read']);
  assert.equal(mails.length, 2);
  assert.deepEqual(mails[0]!.to, ['owner@example.test', 'admin@example.test']);
  assert.equal(mails[0]!.subject, 'Blob storage has reached the offload threshold');
  assert.match(mails[0]!.text, /https:\/\/work\.example\.test\/admin#\/docs\?doc=operations&anchor=blob-offload-trigger/);
  assert.deepEqual(events.map(e => [e.kind, e.data.kind]), [['blob.offload.threshold', 'stored'], ['blob.offload.threshold', 'read']]);
  assert.deepEqual(await notifyOffloadAlerts({ blobs, notifier, recipients, baseUrl: 'https://work.example.test' }), [], 'the next day sends nothing');
  assert.equal(mails.length, 2);
  // A store with no usage figures (a test double) raises nothing.
  const { usage: _usage, ...plain } = createMemoryBlobStore();
  assert.deepEqual(await notifyOffloadAlerts({ blobs: plain, notifier, recipients, baseUrl: '' }), []);
});

test('blob usage renders as a read counter and a stored gauge, by driver', () => {
  const m = createMetrics();
  m.originBytes('public-immutable', 100);
  m.originBytes('public-immutable', 23);
  m.originBytes('person-private', 7);
  const text = m.renderText([
    ...blobUsageLines(pgUsage({ storedBytes: 2048, readBytesTotal: 512 })),
    ...blobUsageLines({ ...pgUsage({ readBytesTotal: 9 }), driver: 's3', storedBytes: null }),
  ]);
  assert.match(text, /# TYPE lw_origin_bytes_total counter/);
  assert.match(text, /lw_origin_bytes_total\{class="public-immutable"\} 123\n/);
  assert.match(text, /lw_origin_bytes_total\{class="person-private"\} 7\n/);
  assert.match(text, /# TYPE lw_blob_read_bytes_total counter/);
  assert.match(text, /lw_blob_read_bytes_total\{driver="pg"\} 512\n/);
  assert.match(text, /lw_blob_read_bytes_total\{driver="s3"\} 9\n/);
  assert.match(text, /# TYPE lw_blob_stored_bytes gauge/);
  assert.match(text, /lw_blob_stored_bytes\{driver="pg"\} 2048\n/);
  assert.doesNotMatch(text, /lw_blob_stored_bytes\{driver="s3"\}/);
  assert.equal((text.match(/# TYPE lw_blob_read_bytes_total/g) ?? []).length, 1);
});

test('origin bytes: body bytes once each, by the route delivery class; HEAD and 304 count nothing', async () => {
  const router = createRouter();
  router.add('GET', '/static', (_req, res) => { res.writeHead(200, { 'content-type': 'text/plain' }); res.write('héllo '); res.end(Buffer.from('world')); }, { delivery: 'public-immutable' });
  router.add('HEAD', '/static', (_req, res) => { res.writeHead(200); res.end('ignored'); }, { delivery: 'public-immutable' });
  router.add('GET', '/same', (_req, res) => { res.writeHead(304); res.end(); }, { delivery: 'public-revalidate' });
  router.add('GET', '/json', (_req, res) => { res.writeHead(200); res.end('{"ok":true}'); });
  const seen: Array<[string, number]> = [];
  const server = createServer((req, res) => {
    const bytes = countResponseBytes(req, res);
    res.on('finish', () => seen.push([deliveryClassOf(res), bytes()]));
    void router.dispatch(req, res).then((matched) => { if (!matched) { res.writeHead(404); res.end('nope'); } });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
  try {
    assert.equal(await (await fetch(`${base}/static`)).text(), 'héllo world');
    await (await fetch(`${base}/static`, { method: 'HEAD' })).arrayBuffer();
    await (await fetch(`${base}/same`)).arrayBuffer();
    await (await fetch(`${base}/json`)).arrayBuffer();
    await (await fetch(`${base}/missing`)).arrayBuffer();
  } finally { await new Promise<void>((r) => server.close(() => r())); }
  assert.deepEqual(seen, [
    ['public-immutable', Buffer.byteLength('héllo world')],
    ['public-immutable', 0],
    ['public-revalidate', 0],
    ['person-private', 11],
    ['person-private', 4],
  ]);
});

// ── the app: /metrics lines and the console's alert route ─────────────────────

let server: Server;
let base = '';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-blob-usage-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Usage', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'member@test', groups: [] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's'.repeat(32), link: 'l'.repeat(32) }, blobs: overThresholdBlobs() });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});
after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
}

test('GET /metrics carries blob reads, stored bytes and origin bytes', async () => {
  const health = await fetch(`${base}/healthz`);
  const healthBytes = Buffer.byteLength(await health.text());
  const text = await (await fetch(`${base}/metrics`)).text();
  assert.match(text, /lw_blob_read_bytes_total\{driver="pg"\} 42\n/);
  assert.match(text, new RegExp(`lw_blob_stored_bytes\\{driver="pg"\\} ${11 * GiB}\\n`));
  const origin = /lw_origin_bytes_total\{class="person-private"\} (\d+)\n/.exec(text);
  assert.ok(origin, 'origin bytes by class');
  assert.ok(Number(origin[1]) >= healthBytes, 'the health answer is counted');
});

test('GET /api/v1/alerts: administrators see the offload alerts, others do not', async () => {
  assert.equal((await fetch(`${base}/api/v1/alerts`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/alerts`, { headers: { cookie: await login('member@test') } })).status, 403);
  const res = await fetch(`${base}/api/v1/alerts`, { headers: { cookie: await login('admin@test') } });
  assert.equal(res.status, 200);
  assert.match(res.headers.get('cache-control') ?? '', /private, no-store/);
  const { alerts } = await res.json() as { alerts: Array<{ id: string; level: string; title: string; href: string }> };
  assert.deepEqual(alerts.map(a => [a.id, a.level]), [['blob-offload-stored', 'warning'], ['blob-offload-read', 'warning']]);
});

// ── the pg driver: the monthly tally and the claims live in the database ─────

const pgUrl = process.env.LW_TEST_DATABASE_URL;

test('Postgres: reads and claims survive a restart and are shared by replicas', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl!, async () => {
    const { createPostgresBlobStore } = await import('../server/src/blobs/postgres.ts');
    const one = await createPostgresBlobStore(pgUrl!);
    const two = await createPostgresBlobStore(pgUrl!);
    let oneOpen = true;
    try {
      assert.equal(one.driver, 'pg');
      await one.put('a', Buffer.from('1234567'), 'text/plain');
      await one.put('b', Buffer.from('123'), 'text/plain');
      assert.equal(await one.get('missing'), null);
      await one.get('a');
      await two.get('a');
      await two.get('b');
      const first = await one.usage!();
      assert.equal(first.storedBytes, 10);
      assert.equal(first.readBytesTotal, 7, 'the process total is this replica only');
      assert.equal(first.month, usageMonth());
      assert.equal(first.monthReadBytes, 7, 'the other replica has not written its tally yet');
      await two.flushUsage!();
      assert.equal((await one.usage!()).monthReadBytes, 17, 'both replicas sum in the month row');
      // A restart keeps the month: close writes the tally, a new driver reads it.
      await one.get('b');
      await one.close();
      oneOpen = false;
      const again = await createPostgresBlobStore(pgUrl!);
      try {
        const usage = await again.usage!();
        assert.equal(usage.readBytesTotal, 0);
        assert.equal(usage.monthReadBytes, 20);
        assert.equal(await again.claimUsageNotice!('2026-10', 'stored'), true);
        assert.equal(await two.claimUsageNotice!('2026-10', 'stored'), false, 'another replica cannot claim it again');
        assert.equal(await two.claimUsageNotice!('2026-10', 'read'), true);
        assert.equal(await again.claimUsageNotice!('2026-11', 'stored'), true);
      } finally { await again.close(); }
    } finally {
      if (oneOpen) await one.close();
      await two.close();
    }
  });
});
