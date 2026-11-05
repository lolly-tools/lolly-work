// SPDX-License-Identifier: MPL-2.0
/**
 * Render batches fill their rows from a governed data source and download as one
 * ZIP with a manifest, with the same grants as the rest of the batch.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { archivePlan, RENDER_ARCHIVE_MAX_BYTES, writeBatchArchive } from '../server/src/renders/archive.ts';
import { batchRequestHash, newRenderBatch, parseBatchBinding, parseRenderBatchSpec, rowsFromBinding } from '../server/src/renders/batch.ts';
import { RenderResourceError, type RenderResult } from '../server/src/renders/types.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

let pack: string;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-render-bind-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'bg', type: 'color', label: 'Background', default: '#112233' }],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="{{bg}}"/></svg>');
});
after(() => rm(pack, { recursive: true, force: true }));

/** A central-directory read, so the test sees what an extractor sees. */
function readZip(buf: Buffer): Array<{ name: string; bytes: Buffer }> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  assert.ok(end >= 0, 'an end-of-central-directory record');
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: Array<{ name: string; bytes: Buffer }> = [];
  for (let i = 0; i < count; i++) {
    const method = buf.readUInt16LE(at + 10);
    const compressed = buf.readUInt32LE(at + 20);
    const nameLength = buf.readUInt16LE(at + 28);
    const extra = buf.readUInt16LE(at + 30);
    const comment = buf.readUInt16LE(at + 32);
    const offset = buf.readUInt32LE(at + 42);
    const name = buf.toString('utf8', at + 46, at + 46 + nameLength);
    const dataStart = offset + 30 + buf.readUInt16LE(offset + 26) + buf.readUInt16LE(offset + 28);
    const data = buf.subarray(dataStart, dataStart + compressed);
    out.push({ name, bytes: method === 8 ? inflateRawSync(data) : Buffer.from(data) });
    at += 46 + nameLength + extra + comment;
  }
  return out;
}

const ROWS_JSON = JSON.stringify([
  { sku: 'mug', bg: '#111111' }, { sku: 'poster', bg: '#222222' }, { sku: 'cap', bg: '#333333' },
]);

async function harness(data: () => { status?: number; body: string; type?: string } = () => ({ body: ROWS_JSON, type: 'application/json' })) {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const reads: string[] = [];
  const fetchImpl = (async (url: string | URL | Request) => {
    reads.push(String(url));
    const { status = 200, body, type = 'application/json' } = data();
    return new Response(body, { status, headers: { 'content-type': type } });
  }) as typeof fetch;
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Bind', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false },
    catalogProviders: [{ id: 'data', kind: 'mock', label: 'Data', enabled: true, options: { assets: [], origin: 'https://data.example' } }],
    dev: { enabled: true, users: [
      { email: 'one@test', name: 'One', groups: ['admin'] },
      { email: 'two@test', name: 'Two', groups: ['admin'] },
      { email: 'plain@test', name: 'Plain', groups: [] },
    ] },
  }));
  let runner!: RenderRunner;
  const app = buildApp({ config, store, blobs, fetchImpl, secrets: { session: 'test-session', link: 'test-link' },
    onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const one = await login('one@test'); const two = await login('two@test'); const plain = await login('plain@test');
  const request = (path: string, method = 'GET', body?: unknown, cookie = one, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const finish = async (id: string) => {
    for (let i = 0; i < 300; i++) {
      await runner.tick();
      const batch = await (await request(`/api/v1/render-batches/${id}`)).json() as BatchView;
      if (batch.progress.done === batch.progress.total) return batch;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('batch did not finish');
  };
  return { base, store, blobs, reads, request, finish, one, two, plain,
    close: async () => { await runner.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
interface BatchView {
  id: string; state: string; archiveUrl: string; request: { bind?: unknown };
  progress: { total: number; done: number; succeeded: number; failed: number; cancelled: number };
  rows: Array<{ key: string; id: string; state: string; request: { inputs: Record<string, unknown>; bind?: unknown }; output?: { sha256: string } }>;
}
const card = { toolId: 'card', format: 'svg' };
const SOURCE = 'net://data.example/rows.json';
const errorCode = async (res: Response): Promise<string> => (await res.json() as { error: { code: string } }).error.code;

test('bind fills batch rows from a governed source, once, and names them from a column', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.request('/api/v1/render-batches', 'POST', { ...card, inputs: { bg: '#ffffff' }, bind: { source: SOURCE, keyField: 'sku' } }, h.one, { 'idempotency-key': 'bound' });
  assert.equal(created.status, 202, await created.clone().text());
  const batch = await created.json() as BatchView;
  assert.deepEqual(batch.rows.map((row) => row.key), ['mug', 'poster', 'cap']);
  assert.equal(batch.rows[1]!.request.inputs.bg, '#222222', 'a row overrides the shared inputs');
  assert.equal('sku' in batch.rows[1]!.request.inputs, false, 'the key column is not an input');
  assert.equal(batch.rows[1]!.request.bind, undefined);
  assert.deepEqual(batch.request.bind, { source: SOURCE, keyField: 'sku' });
  assert.equal(h.reads.length, 1);

  // A replay matches on the source, needs no read, and survives the data moving on.
  const replay = await h.request('/api/v1/render-batches', 'POST', { ...card, inputs: { bg: '#ffffff' }, bind: { source: SOURCE, keyField: 'sku' } }, h.one, { 'idempotency-key': 'bound' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as BatchView).id, batch.id);
  assert.equal(h.reads.length, 1, 'a replay does not read the source again');
  const other = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: 'net://data.example/other.json' } }, h.one, { 'idempotency-key': 'bound' });
  assert.equal(other.status, 409);
  assert.equal(await errorCode(other), 'IDEMPOTENCY_KEY_REUSED');

  const finished = await h.finish(batch.id);
  assert.equal(finished.state, 'succeeded');
  assert.equal(finished.progress.succeeded, 3);
});

test('bind numbers rows with no key column, and a retry keeps the rows it was given', async (t) => {
  let body = JSON.stringify([{ bg: '#111111' }, { bg: '#222222' }, { bg: '#333333' }]);
  const h = await harness(() => ({ body })); t.after(() => h.close());
  const created = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE } });
  assert.equal(created.status, 202, await created.clone().text());
  const batch = await created.json() as BatchView;
  assert.deepEqual(batch.rows.map((row) => row.key), ['row-1', 'row-2', 'row-3']);
  assert.equal((await h.request(`/api/v1/render-batches/${batch.id}`, 'DELETE')).status, 200);
  await h.finish(batch.id);
  body = JSON.stringify([{ sku: 'changed', bg: '#999999' }]);
  const retried = await h.request(`/api/v1/render-batches/${batch.id}/retry`, 'POST');
  assert.equal(retried.status, 202, await retried.clone().text());
  assert.deepEqual((await retried.json() as BatchView).rows.map((row) => row.key), ['row-1', 'row-2', 'row-3']);
  assert.equal(h.reads.length, 1, 'a retry reruns the rows it has and reads nothing');
});

test('a bound submission reads nothing without the grants, and reports source problems plainly', async (t) => {
  const responses: Array<{ status?: number; body: string; type?: string }> = [];
  const h = await harness(() => responses.shift() ?? { body: ROWS_JSON }); t.after(() => h.close());
  const denied = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE } }, h.plain);
  assert.equal(denied.status, 403);
  assert.equal(h.reads.length, 0, 'no provider traffic before the grants are checked');

  responses.push({ status: 500, body: 'no' });
  const down = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE } });
  assert.equal(down.status, 400);
  assert.equal(await errorCode(down), 'DATA_BINDING_ERROR');

  const elsewhere = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: 'net://not-configured.example/rows.json' } });
  assert.equal(elsewhere.status, 400);
  assert.equal(await errorCode(elsewhere), 'DATA_BINDING_ERROR');

  responses.push({ body: JSON.stringify(Array.from({ length: 201 }, (_, n) => ({ bg: `#${String(n).padStart(6, '0')}` }))) });
  const tooMany = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE } });
  assert.equal(tooMany.status, 400);
  assert.equal(await errorCode(tooMany), 'DATA_BINDING_ERROR');

  responses.push({ body: JSON.stringify([{ sku: 'a b', bg: '#111111' }]) });
  const badKey = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE, keyField: 'sku' } });
  assert.equal(await errorCode(badKey), 'DATA_BINDING_ERROR');
  responses.push({ body: JSON.stringify([{ sku: 'a', bg: '#111111' }, { sku: 'a', bg: '#222222' }]) });
  const repeated = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE, keyField: 'sku' } });
  assert.equal(await errorCode(repeated), 'DATA_BINDING_ERROR');

  responses.push({ body: JSON.stringify([{ bg: 'not a colour', unknown: { deep: true } }]) });
  assert.ok((await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE, as: { type: 'object', required: ['missing'] } } })).status === 400, 'bind.as is applied to the rows');

  const both = await h.request('/api/v1/render-batches', 'POST', { ...card, bind: { source: SOURCE }, rows: [{ key: 'a' }] });
  assert.equal(both.status, 400);
  assert.equal(await errorCode(both), 'INVALID_INPUT');
});

test('binding shapes are checked before anything else', () => {
  assert.deepEqual(parseBatchBinding({ source: SOURCE, query: { a: 1 }, as: { type: 'object' }, keyField: 'sku' }), { source: SOURCE, query: { a: 1 }, as: { type: 'object' }, keyField: 'sku' });
  for (const bad of [null, [], 'x', {}, { source: '' }, { source: 1 }, { source: SOURCE, extra: 1 }, { source: SOURCE, query: [] }, { source: SOURCE, as: 'x' }, { source: SOURCE, keyField: '' },
    { source: SOURCE, query: JSON.parse('{"__proto__":{}}') }]) {
    assert.throws(() => parseBatchBinding(bad), RenderResourceError, JSON.stringify(bad));
  }
  assert.deepEqual(rowsFromBinding([{ a: 1 }], undefined), [{ key: 'row-1', inputs: { a: 1 } }]);
  assert.deepEqual(rowsFromBinding([{ id: 7, a: 1 }], 'id'), [{ key: '7', inputs: { a: 1 } }]);
  assert.throws(() => rowsFromBinding([], undefined), /1 to 200/);
  // A plain batch's hash is what it always was, so idempotency keys keep their meaning.
  const plain = parseRenderBatchSpec({ ...card, rows: [{ key: 'a' }] });
  const bound = parseRenderBatchSpec({ ...card, rows: [{ key: 'a' }], bind: { source: SOURCE } });
  assert.notEqual(batchRequestHash(plain), batchRequestHash({ ...plain, rows: [{ key: 'b', inputs: {} }] }));
  assert.equal(batchRequestHash(bound), batchRequestHash({ ...bound, rows: [{ key: 'b', inputs: {} }] }));
  assert.equal(newRenderBatch('user:a', bound).requestHash, batchRequestHash(bound));
});

test('the archive holds each successful row, checked against its receipt, and a manifest of every row', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.request('/api/v1/render-batches', 'POST', { ...card, rows: [
    { key: 'uk', inputs: { bg: '#112233' } }, { key: 'UK', inputs: { bg: '#445566' } }, { key: 'broken', inputs: { bg: '#778899' } }, { key: 'lost', inputs: { bg: '#000000' } },
  ] }, h.one);
  assert.equal(created.status, 202, await created.clone().text());
  const queued = await created.json() as BatchView;
  assert.equal(queued.archiveUrl, `/api/v1/render-batches/${queued.id}/archive`);
  assert.equal((await h.request(queued.archiveUrl)).status, 409, 'an unfinished batch has no archive');
  assert.equal(await errorCode(await h.request(queued.archiveUrl)), 'BATCH_NOT_FINISHED');

  // One row fails for good; one loses its bytes after success.
  const owner = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  const brokenId = queued.rows.find((row) => row.key === 'broken')!.id;
  assert.equal((await h.request(`/api/v1/renders/${brokenId}`, 'DELETE')).status, 200);
  const finished = await h.finish(queued.id);
  assert.equal(finished.state, 'cancelled');
  const lost = await h.store.getRender(queued.rows.find((row) => row.key === 'lost')!.id, `user:${owner.id}`);
  await h.blobs.delete(lost!.output!.ref);

  assert.equal((await h.request(queued.archiveUrl, 'GET', undefined, h.two)).status, 404, 'another caller sees nothing');
  const res = await h.request(queued.archiveUrl);
  assert.equal(res.status, 200, await res.clone().text());
  assert.equal(res.headers.get('content-type'), 'application/zip');
  assert.match(res.headers.get('content-disposition')!, new RegExp(`${queued.id}\\.zip`));
  assert.match(res.headers.get('cache-control')!, /^private, no-store/);
  const members = readZip(Buffer.from(await res.arrayBuffer()));
  assert.deepEqual(members.map((m) => m.name), ['uk.svg', 'UK-2.svg', 'manifest.json']);
  const manifest = JSON.parse(members.at(-1)!.bytes.toString('utf8')) as { manifestVersion: number; batchId: string; archived: number; state: string; rows: Array<Record<string, unknown>> };
  assert.equal(manifest.manifestVersion, 1);
  assert.equal(manifest.batchId, queued.id);
  assert.equal(manifest.state, 'cancelled');
  assert.equal(manifest.archived, 2);
  assert.deepEqual(manifest.rows.map((row) => [row.key, row.archived, row.reason ?? null]), [
    ['uk', true, null], ['UK', true, null], ['broken', false, 'NOT_SUCCEEDED'], ['lost', false, 'OUTPUT_UNAVAILABLE'],
  ]);
  for (const row of manifest.rows.filter((r) => r.archived)) {
    const member = members.find((m) => m.name === row.file)!;
    assert.equal(createHash('sha256').update(member.bytes).digest('hex'), row.sha256, `${String(row.key)} matches its receipt`);
    assert.equal(member.bytes.byteLength, row.size);
  }
  assert.match(members[0]!.bytes.toString('utf8'), /#112233/);
});

test('the archive follows current grants, and refuses a batch with no output', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const stopped = await (await h.request('/api/v1/render-batches', 'POST', { ...card, rows: [{ key: 'a' }] })).json() as BatchView;
  assert.equal((await h.request(`/api/v1/render-batches/${stopped.id}`, 'DELETE')).status, 200);
  const empty = await h.request(stopped.archiveUrl);
  assert.equal(empty.status, 409);
  assert.equal(await errorCode(empty), 'BATCH_HAS_NO_OUTPUT');

  const done = await (await h.request('/api/v1/render-batches', 'POST', { ...card, rows: [{ key: 'a' }] })).json() as BatchView;
  await h.finish(done.id);
  assert.equal((await h.request(done.archiveUrl)).status, 200);
  const owner = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  await h.store.putGrant({ principal: `user:${owner.id}`, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
  assert.equal((await h.request(done.archiveUrl)).status, 403, 'losing the grant closes the archive');
});

test('a reader that goes away stops the archive, and the plan sizes what it would hold', async () => {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const output = async (ref: string, body: string): Promise<RenderResult> => {
    await blobs.put(ref, Buffer.from(body), 'image/svg+xml');
    return { name: 'default', ref, mime: 'image/svg+xml', size: Buffer.byteLength(body), sha256: createHash('sha256').update(body).digest('hex'), cacheKey: 'k' };
  };
  const spec = parseRenderBatchSpec({ ...card, rows: [{ key: 'a' }, { key: 'b' }] });
  const batch = (await store.insertRenderBatch(newRenderBatch('user:a', spec))).record;
  for (const body of ['<svg/>', '<svg></svg>']) {
    const claim = (await store.claimRender(10_000))!;
    await store.settleRender(claim.id, claim.leaseToken!, { state: 'succeeded', output: await output(`x/${claim.id}`, body) });
  }
  const finished = (await store.getRenderBatch(batch.id, 'user:a'))!;
  assert.deepEqual(archivePlan(finished), { members: 2, bytes: 17 });
  assert.ok(RENDER_ARCHIVE_MAX_BYTES < 4 * 1024 * 1024 * 1024, 'inside the classic ZIP limit');
  let writes = 0;
  const rows = await writeBatchArchive(finished, blobs, async () => { writes++; return false; });
  assert.equal(writes, 1, 'nothing more is read or written once the reader has gone');
  assert.equal(rows.length, 1);

  // A tampered blob is left out and named, never served.
  const tampered = finished.rows[0]!.render.output!;
  await blobs.put(tampered.ref, Buffer.from('<svg x="1"/>'.slice(0, tampered.size)), 'image/svg+xml');
  const chunks: Buffer[] = [];
  const reported = await writeBatchArchive(finished, blobs, async (chunk) => { chunks.push(chunk); return true; });
  assert.equal(reported[0]!.reason, 'OUTPUT_INTEGRITY');
  assert.equal(reported[1]!.archived, true);
  assert.deepEqual(readZip(Buffer.concat(chunks)).map((m) => m.name), ['b.svg', 'manifest.json']);
});
