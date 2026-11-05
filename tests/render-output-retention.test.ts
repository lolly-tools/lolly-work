// SPDX-License-Identifier: MPL-2.0
/**
 * Optional retention for durable render outputs: off by default, keeps the record,
 * and never removes bytes a delivery names.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { inflateRawSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { runRetention } from '../server/src/audit/retention.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { newRender, parseRenderSpec, renderWire } from '../server/src/renders/request.ts';
import { batchWire, newRenderBatch, parseRenderBatchSpec } from '../server/src/renders/batch.ts';
import { scheduleRenderOutputSweep, sweepRenderOutputs } from '../server/src/renders/retention.ts';
import type { RenderRecord } from '../server/src/renders/types.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import type { Store } from '../server/src/store/types.ts';

const OWNER = 'user:retention';
const DAY = 24 * 60 * 60 * 1000;
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"/>';
const spec = parseRenderSpec({ toolId: 'card', format: 'svg', inputs: {} });

async function finished(store: Store, blobs: ReturnType<typeof createMemoryBlobStore>, owner = OWNER): Promise<RenderRecord> {
  const saved = (await store.insertRender(newRender(owner, spec))).record;
  const claim = (await store.claimRender(10_000))!;
  assert.equal(claim.id, saved.id);
  const ref = `renders/${saved.id}/attempt-1`;
  await blobs.put(ref, Buffer.from(SVG), 'image/svg+xml');
  await store.settleRender(saved.id, claim.leaseToken!, { state: 'succeeded', output: {
    name: 'default', ref, mime: 'image/svg+xml', size: SVG.length, sha256: sha256Hex(SVG), cacheKey: 'k',
  } });
  return (await store.getRender(saved.id, owner))!;
}

const afterDays = (days: number) => () => new Date(Date.now() + days * DAY);

async function sweepConformance(store: Store): Promise<void> {
  const blobs = createMemoryBlobStore();
  const render = await finished(store, blobs);
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 0, now: afterDays(100) }), { expired: 0, purged: 0 }, 'zero keeps everything');
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 30, now: afterDays(29) }), { expired: 0, purged: 0 }, 'not due yet');
  assert.ok(await blobs.head(render.output!.ref));

  // First pass marks; the bytes stay until a later pass.
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 30, now: afterDays(31) }), { expired: 1, purged: 0 });
  assert.ok(await blobs.head(render.output!.ref), 'the mark comes a pass before the removal');
  assert.ok((await store.getRender(render.id, OWNER))!.output!.expiredAt);
  const audit = await store.listAudit();
  const entry = audit.find((e) => e.action === 'render.output.expire' && e.subject === `render:${render.id}`);
  assert.ok(entry, 'each expiry is audited');
  assert.equal(entry!.actor, 'system');

  // A delivery that read the output just before the mark keeps its bytes.
  const raced = await finished(store, blobs);
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 30, now: afterDays(31) }), { expired: 1, purged: 0 });
  await store.putDelivery({ id: 'del_raced', principal: OWNER, destinationId: 'archive', destinationVersion: 'v1', name: 'raced', format: 'svg',
    contentType: 'image/svg+xml', size: SVG.length, sha256: raced.output!.sha256, requestHash: 'h'.repeat(64), sourceRef: raced.output!.ref, sourceRenderId: raced.id,
    state: 'queued', attempt: 0, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() });

  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 30, now: afterDays(32) }), { expired: 0, purged: 1 });
  assert.equal(await blobs.head(render.output!.ref), null, 'the bytes are gone');
  assert.ok((await store.getRender(render.id, OWNER))!.output!.purgedAt);
  assert.ok(await blobs.head(raced.output!.ref), 'a delivery that raced the mark keeps its bytes');
  assert.equal((await store.getRender(raced.id, OWNER))!.output!.expiredAt, undefined, 'and clears the mark');

  // An output a delivery already names is never marked.
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(400) }), { expired: 0, purged: 0 });
  assert.equal((await store.getRender(raced.id, OWNER))!.output!.expiredAt, undefined);
}

test('retention marks, then removes, and leaves delivered outputs alone (memory)', () => sweepConformance(createMemoryStore()));
test('retention marks, then removes, and leaves delivered outputs alone (Postgres)', {
  skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run',
}, () => withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, sweepConformance));

test('a pass that stops between removing bytes and recording that repeats harmlessly', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const render = await finished(store, blobs);
  await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(2) });
  const broken = { ...store, expireRenderOutputs: store.expireRenderOutputs, renderOutputsToPurge: store.renderOutputsToPurge, appendAudit: store.appendAudit,
    markRenderOutputPurged: async () => { throw new Error('the database went away'); } };
  await assert.rejects(sweepRenderOutputs({ store: broken, blobs, days: 1, now: afterDays(3) }), /went away/);
  assert.equal(await blobs.head(render.output!.ref), null);
  assert.deepEqual(await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(3) }), { expired: 0, purged: 1 });
  assert.ok((await store.getRender(render.id, OWNER))!.output!.purgedAt);
});

test('an expired render keeps its record, and says so on the wire', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const render = await finished(store, blobs);
  const before = renderWire(render) as { output: Record<string, unknown> };
  assert.ok(before.output.url);
  assert.equal(before.output.expiredAt, undefined);
  await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(2) });
  const wire = renderWire((await store.getRender(render.id, OWNER))!) as { state: string; output: Record<string, unknown> };
  assert.equal(wire.state, 'succeeded');
  assert.equal(wire.output.url, undefined, 'no URL for bytes that are not served');
  assert.ok(wire.output.expiredAt);
  assert.equal(wire.output.sha256, sha256Hex(SVG));
  assert.equal(JSON.stringify(wire).includes(render.output!.ref), false, 'the blob reference stays private');
});

test('a batch retry renders an expired row again instead of reusing it', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const request = parseRenderBatchSpec({ toolId: 'card', format: 'svg', rows: [{ key: 'kept' }, { key: 'broken' }] });
  const batch = (await store.insertRenderBatch(newRenderBatch(OWNER, request))).record;
  const claims = [(await store.claimRender(10_000))!, (await store.claimRender(10_000))!];
  const first = claims.find((claim) => claim.id === batch.rows[0]!.render.id)!;
  const second = claims.find((claim) => claim.id === batch.rows[1]!.render.id)!;
  await blobs.put('x/kept', Buffer.from(SVG), 'image/svg+xml');
  await store.settleRender(first.id, first.leaseToken!, { state: 'succeeded', output: { name: 'default', ref: 'x/kept', mime: 'image/svg+xml', size: SVG.length, sha256: sha256Hex(SVG), cacheKey: 'k' } });
  await store.settleRender(second.id, second.leaseToken!, { state: 'failed', error: { code: 'BROKEN', message: 'no' } });
  await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(2) });
  const expired = (await store.getRenderBatch(batch.id, OWNER))!;
  const retried = (await store.insertRenderBatch(newRenderBatch(OWNER, request, undefined, expired))).record;
  assert.equal(retried.rows[0]!.render.state, 'queued');
  assert.notEqual(retried.rows[0]!.render.id, first.id);
  assert.equal(retried.rows[0]!.render.retryOf, first.id);
  assert.ok(JSON.stringify(batchWire(expired)).includes('expiredAt'));
});

test('the schedule does nothing while retention is off, and runs at boot once it is on', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const lines: string[] = [];
  const log = { log: (line: string) => lines.push(line), error: (line: string) => lines.push(line) };
  const off = scheduleRenderOutputSweep(store, blobs, 0, { log });
  await off.first; off.stop();
  assert.deepEqual(lines, []);
  const old = await finished(store, blobs);
  const on = scheduleRenderOutputSweep(store, blobs, 1, { log, intervalMs: 3_600_000 });
  await on.first; on.stop();
  assert.equal((await store.getRender(old.id, OWNER))!.output!.expiredAt, undefined, 'a day has not passed');
});

test('runRetention sweeps outputs only when the policy says so and it has the blobs', async () => {
  const cfg = (days: number) => parseConfig(JSON.stringify({
    instance: { name: 'x', baseUrl: 'http://localhost', pack: '/tmp' }, policy: { defaultAccessMode: 'open', retention: { renderOutputDays: days } },
  }));
  assert.equal(cfg(0).policy.retention.renderOutputDays, 0);
  assert.throws(() => cfg(-1), /renderOutputDays/);
  assert.throws(() => cfg(1.5), /renderOutputDays/);
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  await finished(store, blobs);
  assert.deepEqual(await runRetention({ config: cfg(1), store, now: afterDays(2) }), { telemetryTrimmed: 0, auditTrimmed: 0 }, 'no blobs, no sweep');
  const off = await runRetention({ config: cfg(0), store, blobs, now: afterDays(2) });
  assert.equal(off.renderOutputsExpired, undefined);
  const on = await runRetention({ config: cfg(1), store, blobs, now: afterDays(2) });
  assert.equal(on.renderOutputsExpired, 1);
  assert.equal(on.renderOutputsRemoved, 0);
});

let pack: string;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-render-retention-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] }, inputs: [{ id: 'bg', type: 'color', label: 'Background', default: '#112233' }],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="{{bg}}"/></svg>');
});
after(() => rm(pack, { recursive: true, force: true }));

function memberOf(buf: Buffer, wanted: string): Buffer | null {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  let at = buf.readUInt32LE(end + 16);
  for (let i = 0; i < buf.readUInt16LE(end + 10); i++) {
    const nameLength = buf.readUInt16LE(at + 28);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    if (name === wanted) {
      const offset = buf.readUInt32LE(at + 42);
      const start = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
      const data = buf.subarray(start, start + buf.readUInt32LE(at + 20));
      return buf.readUInt16LE(at + 10) === 8 ? inflateRawSync(data) : Buffer.from(data);
    }
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return null;
}

test('through the API an expired output answers 410, and its evidence and archive stay honest', async (t) => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Retention', baseUrl: 'http://localhost', pack }, policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'one@test', name: 'One', groups: ['admin'] }] },
  }));
  let runner!: RenderRunner;
  const app = buildApp({ config, store, blobs, secrets: { session: 'test-session', link: 'test-link' }, onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await runner.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const cookie = (await fetch(`${base}/api/auth/dev?email=one@test`, { redirect: 'manual' })).headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const request = (path: string, method = 'GET', body?: unknown) =>
    fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  const batch = await (await request('/api/v1/render-batches', 'POST', { toolId: 'card', format: 'svg', rows: [{ key: 'one' }, { key: 'two' }] })).json() as { id: string; rows: Array<{ id: string }> };
  for (let i = 0; i < 300; i++) {
    await runner.tick();
    const view = await (await request(`/api/v1/render-batches/${batch.id}`)).json() as { progress: { done: number; total: number } };
    if (view.progress.done === view.progress.total) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const renderId = batch.rows[0]!.id;
  assert.equal((await request(`/api/v1/renders/${renderId}/output/default`)).status, 200);
  const evidenceBefore = await (await request(`/api/v1/renders/${renderId}/evidence`)).json();

  await sweepRenderOutputs({ store, blobs, days: 1, now: afterDays(2) });
  const gone = await request(`/api/v1/renders/${renderId}/output/default`);
  assert.equal(gone.status, 410);
  assert.equal((await gone.json() as { error: { code: string } }).error.code, 'OUTPUT_EXPIRED');
  const record = await (await request(`/api/v1/renders/${renderId}`)).json() as { state: string; output: { url?: string; expiredAt?: string; sha256: string } };
  assert.equal(record.state, 'succeeded');
  assert.equal(record.output.url, undefined);
  assert.ok(record.output.expiredAt);
  assert.deepEqual(await (await request(`/api/v1/renders/${renderId}/evidence`)).json(), evidenceBefore, 'the receipt outlives the bytes');
  const empty = await request(`/api/v1/render-batches/${batch.id}/archive`);
  assert.equal(empty.status, 409);
  assert.equal((await empty.json() as { error: { code: string } }).error.code, 'BATCH_HAS_NO_OUTPUT');

  // Only one row expires: the archive lists the other as expired by name.
  const second = await (await request('/api/v1/render-batches', 'POST', { toolId: 'card', format: 'svg', rows: [{ key: 'old' }, { key: 'new' }] })).json() as { id: string; rows: Array<{ id: string; key: string }> };
  for (let i = 0; i < 300; i++) {
    await runner.tick();
    const view = await (await request(`/api/v1/render-batches/${second.id}`)).json() as { progress: { done: number; total: number } };
    if (view.progress.done === view.progress.total) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const [expiredRow] = await store.expireRenderOutputs(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), 1);
  const expiredKey = second.rows.find((row) => row.id === expiredRow!.id)!.key;
  const archive = await request(`/api/v1/render-batches/${second.id}/archive`);
  assert.equal(archive.status, 200, await archive.clone().text());
  const manifest = JSON.parse(memberOf(Buffer.from(await archive.arrayBuffer()), 'manifest.json')!.toString('utf8')) as { rows: Array<{ key: string; archived: boolean; reason?: string }> };
  assert.deepEqual(manifest.rows.map((row) => [row.key, row.archived, row.reason ?? null]),
    second.rows.map((row) => row.key === expiredKey ? [row.key, false, 'OUTPUT_EXPIRED'] : [row.key, true, null]));
});
