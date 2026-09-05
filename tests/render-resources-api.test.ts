import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { createPostgresBlobStore } from '../server/src/blobs/postgres.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';
import type { RenderRecord } from '../server/src/renders/types.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import { withFreshPostgres } from './pg-test-schema.ts';
import { newRenderBatch, parseRenderBatchSpec } from '../server/src/renders/batch.ts';
import { evidenceHash, type RenderEvidence } from '../server/src/render/evidence.ts';

let pack: string;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-durable-render-'));
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

async function harness(options: { attached?: boolean; store?: ReturnType<typeof createMemoryStore>; blobs?: ReturnType<typeof createMemoryBlobStore> } = {}) {
  const store = options.store ?? createMemoryStore(); const blobs = options.blobs ?? createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Renders', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'one@test', name: 'One', groups: ['admin'] },
      { email: 'two@test', name: 'Two', groups: ['admin'] },
    ] },
  }));
  let runner: RenderRunner | undefined;
  const app = buildApp({ config, store, blobs, secrets: { session: 'test-session', link: 'test-link' },
    ...(options.attached === false ? {} : { onRenderRunner: (r: RenderRunner) => {
      runner = r;
      r.kick = () => {}; // deterministic tests explicitly tick, simulating a queued server
    } }),
  });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const one = await login('one@test'); const two = await login('two@test');
  const request = (path: string, method = 'GET', body?: unknown, cookie = one, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const settle = async (id: string) => {
    for (let i = 0; i < 200; i++) {
      await runner!.tick();
      const res = await request(`/api/v1/renders/${id}`);
      assert.equal(res.status, 200, await res.clone().text());
      const r = await res.json() as RenderRecord;
      if (['succeeded', 'failed', 'cancelled'].includes(r.state)) return r;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail('render did not complete');
  };
  return { base, store, blobs, runner, request, settle, one, two,
    close: async () => { await runner?.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); },
  };
}
const render = { toolId: 'card', format: 'svg', inputs: { bg: '#334455' } };
const batchRequest = { ...render, rows: [
  { key: 'uk', inputs: { bg: '#112233' } }, { key: 'fr', inputs: { bg: '#445566' } }, { key: 'de', inputs: { bg: '#778899' } },
] };
interface BatchResponse {
  id: string; state: string; retryOf?: string;
  progress: { total: number; done: number; succeeded: number; failed: number; cancelled: number };
  rows: (RenderRecord & { key: string })[];
}

test('durable batch HTTP keeps ordered child renders, recovers in a new app and serves a verified manifest', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.request('/api/v1/render-batches', 'POST', batchRequest, h.one, { 'idempotency-key': 'batch-one' });
  assert.equal(created.status, 202, await created.clone().text());
  const queued = await created.json() as BatchResponse;
  assert.equal(queued.state, 'queued'); assert.equal(queued.progress.total, 3);
  assert.deepEqual(queued.rows.map((r) => r.key), ['uk', 'fr', 'de']);
  const replay = await h.request('/api/v1/render-batches', 'POST', batchRequest, h.one, { 'idempotency-key': 'batch-one' });
  assert.equal(replay.status, 200); assert.equal((await replay.json() as BatchResponse).id, queued.id);
  assert.equal((await h.request('/api/v1/render-batches', 'POST', { ...batchRequest, rows: batchRequest.rows.slice(1) }, h.one, { 'idempotency-key': 'batch-one' })).status, 409);
  const owner = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  assert.equal((await h.store.listRenders(`user:${owner.id}`, 100, 0)).length, 3);
  for (const suffix of ['', '/manifest', '/retry']) {
    assert.equal((await h.request(`/api/v1/render-batches/${queued.id}${suffix}`, suffix === '/retry' ? 'POST' : 'GET', undefined, h.two)).status, 404);
  }
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}`, 'DELETE', undefined, h.two)).status, 404);
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}/retry`, 'POST')).status, 409);
  const replacement = await harness({ store: h.store, blobs: h.blobs }); t.after(() => replacement.close());
  for (const row of queued.rows) assert.equal((await replacement.settle(row.id)).state, 'succeeded');
  const manifest = await replacement.request(`/api/v1/render-batches/${queued.id}/manifest`);
  assert.equal(manifest.status, 200); assert.match(manifest.headers.get('content-disposition')!, /attachment/);
  const raw = await manifest.text();
  assert.equal(raw.includes('leaseToken'), false); assert.equal(raw.includes('"ref"'), false); assert.equal(raw.includes('"principal"'), false);
  const done = JSON.parse(raw) as BatchResponse & { manifestVersion: number };
  assert.equal(done.manifestVersion, 1); assert.equal(done.state, 'succeeded'); assert.equal(done.progress.done, 3);
  for (const row of done.rows) {
    const response = await replacement.request(`/api/v1/renders/${row.id}/output/default`);
    assert.equal(response.status, 200);
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(sha256Hex(bytes), row.output!.sha256);
    assert.ok(bytes.toString().includes(String(row.request.inputs.bg)));
    assert.equal(row.attempt, 1);
  }
  const list = await (await replacement.request('/api/v1/render-batches?limit=1')).json() as { batches: BatchResponse[]; nextOffset: number };
  assert.equal(list.batches[0]!.id, queued.id); assert.equal('rows' in list.batches[0]!, false); assert.equal(list.nextOffset, 1);
  assert.deepEqual((await (await replacement.request('/api/v1/render-batches', 'GET', undefined, h.two)).json() as { batches: unknown[] }).batches, []);
  assert.equal((await replacement.request(`/api/v1/render-batches/${queued.id}`, 'DELETE')).status, 409);
  assert.equal((await replacement.request(`/api/v1/render-batches/${queued.id}/retry`, 'POST')).status, 409);
});

test('batch cancellation preserves successes; retry replaces only cancelled rows and retains the original manifest', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const queued = await (await h.request('/api/v1/render-batches', 'POST', batchRequest)).json() as BatchResponse;
  const held = (await h.store.claimRender(10_000))!;
  for (const row of queued.rows.filter((r) => r.id !== held.id)) await h.settle(row.id);
  const cancelled = await h.request(`/api/v1/render-batches/${queued.id}`, 'DELETE');
  assert.equal(cancelled.status, 200);
  const before = await cancelled.json() as BatchResponse;
  assert.equal(before.progress.cancelled, 1); assert.equal(before.progress.succeeded, 2);
  assert.equal(await h.store.settleRender(held.id, held.leaseToken!, { state: 'failed', error: { code: 'LATE', message: 'late worker' } }), false);
  // A policy change blocks the new attempt while preserving completed rows.
  await h.store.putOverlay({ toolId: 'card', version: 1, inputAccess: { bg: [{ groups: ['*'], level: 'locked', value: held.request.inputs.bg }] } });
  const retried = await h.request(`/api/v1/render-batches/${queued.id}/retry`, 'POST', undefined, h.one, { 'idempotency-key': 'batch-retry' });
  assert.equal(retried.status, 202, await retried.clone().text());
  const next = await retried.json() as BatchResponse;
  assert.equal(next.retryOf, before.id); assert.equal(next.progress.succeeded, 2);
  for (const row of before.rows) {
    const replacement = next.rows.find((r) => r.key === row.key)!;
    if (row.state === 'succeeded') assert.deepEqual(replacement, row);
    else { assert.notEqual(replacement.id, row.id); assert.equal(replacement.retryOf, row.id); await h.settle(replacement.id); }
  }
  const done = await (await h.request(`/api/v1/render-batches/${next.id}`)).json() as BatchResponse;
  assert.equal(done.state, 'failed');
  assert.equal(done.progress.succeeded, 2);
  assert.equal(done.rows.find((row) => row.state === 'failed')!.error!.code, 'INPUT_LOCKED');
  await h.store.deleteOverlay('card');
  const resumed = await (await h.request(`/api/v1/render-batches/${next.id}/retry`, 'POST')).json() as BatchResponse;
  for (const row of resumed.rows) assert.equal((await h.settle(row.id)).state, 'succeeded');
  assert.equal((await (await h.request(`/api/v1/render-batches/${resumed.id}`)).json() as BatchResponse).state, 'succeeded');
  assert.deepEqual(await (await h.request(`/api/v1/render-batches/${before.id}`)).json(), before);
  const replay = await h.request(`/api/v1/render-batches/${before.id}/retry`, 'POST', undefined, h.one, { 'idempotency-key': 'batch-retry' });
  assert.equal(replay.status, 200); assert.equal((await replay.json() as BatchResponse).id, next.id);
  assert.equal((await h.store.listRenders(held.principal, 100, 0)).length, 5);
});

test('batch admission validates every row before allocation and obeys current grants', async (t) => {
  const h = await harness(); t.after(() => h.close());
  assert.equal((await h.request('/api/v1/render-batches', 'POST', batchRequest, '')).status, 401);
  const rejected = await h.request('/api/v1/render-batches', 'POST', { ...batchRequest, rows: [...batchRequest.rows, { key: 'bad', inputs: { typo: 'x' } }] });
  assert.equal(rejected.status, 422);
  const owner = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  const principal = `user:${owner.id}`;
  assert.deepEqual(await h.store.listRenders(principal, 100, 0), []);
  assert.deepEqual(await h.store.listRenderBatches(principal, 10, 0), []);
  for (const query of ['limit=21', 'limit=0', 'offset=-1']) assert.equal((await h.request(`/api/v1/render-batches?${query}`)).status, 400);
  const absent = await harness({ attached: false }); t.after(() => absent.close());
  assert.equal((await absent.request('/api/v1/render-batches', 'POST', batchRequest)).status, 503);
  const queued = await (await h.request('/api/v1/render-batches', 'POST', batchRequest)).json() as BatchResponse;
  await h.store.putGrant({ principal, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}`)).status, 403);
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}/manifest`)).status, 403);
  assert.equal((await h.request('/api/v1/render-batches', 'POST', batchRequest)).status, 403);
  assert.deepEqual((await (await h.request('/api/v1/render-batches')).json() as { batches: unknown[] }).batches, []);
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}`, 'DELETE')).status, 200);
  assert.equal((await h.request(`/api/v1/render-batches/${queued.id}/retry`, 'POST')).status, 403);
  assert.equal((await h.store.listRenders(principal, 100, 0)).length, 3);
});

test('HTTP creates a real render, survives a new app, retains verified bytes and isolates principals', async (t) => {
  const first = await harness(); t.after(() => first.close());
  const created = await first.request('/api/v1/renders', 'POST', render, first.one, { 'idempotency-key': 'campaign-cell' });
  assert.equal(created.status, 202, await created.clone().text());
  const queued = await created.json() as RenderRecord;
  assert.equal(queued.state, 'queued');
  assert.equal((await first.request(`/api/v1/renders/${queued.id}/evidence`)).status, 409);
  const second = await harness({ store: first.store, blobs: first.blobs }); t.after(() => second.close());
  const completed = await second.settle(queued.id);
  assert.equal(completed.state, 'succeeded', JSON.stringify(completed));
  assert.equal('leaseToken' in completed, false);
  const response = await second.request(`/api/v1/renders/${queued.id}/output/default`);
  assert.equal(response.status, 200);
  const bytes = Buffer.from(await response.arrayBuffer());
  assert.match(bytes.toString(), /#334455/);
  assert.equal(sha256Hex(bytes), completed.output!.sha256);
  assert.equal(response.headers.get('etag'), `"${completed.output!.sha256}"`);
  const evidenceResponse = await second.request(`/api/v1/renders/${queued.id}/evidence`);
  assert.equal(evidenceResponse.status, 200);
  const receipt = await evidenceResponse.json() as { renderId: string; evidence: RenderEvidence };
  assert.equal(receipt.renderId, queued.id); assert.equal(receipt.evidence.outputSha256, completed.output!.sha256);
  assert.equal(receipt.evidence.coverage, 'partial'); assert.equal(receipt.evidence.id, completed.output!.evidence!.id);
  const { id: evidenceId, ...body } = receipt.evidence; assert.equal(evidenceId, evidenceHash(body));
  assert.equal((await second.request(`/api/v1/renders/${queued.id}/evidence`, 'GET', undefined, second.two)).status, 404);
  assert.equal((await second.request(`/api/v1/renders/${queued.id}/evidence`, 'GET', undefined, '')).status, 401);
  assert.equal((await second.request(`/api/v1/renders/${queued.id}`, 'GET', undefined, second.two)).status, 404);
  assert.equal((await second.request(`/api/v1/renders/${queued.id}/output/default`, 'GET', undefined, second.two)).status, 404);
  assert.deepEqual((await (await second.request('/api/v1/renders', 'GET', undefined, second.two)).json() as { renders: unknown[] }).renders, []);
  const reused = await second.request('/api/v1/renders', 'POST', render, second.one, { 'idempotency-key': 'campaign-cell' });
  assert.equal(reused.status, 200); assert.equal((await reused.json() as RenderRecord).id, queued.id);
  const changed = await second.request('/api/v1/renders', 'POST', { ...render, inputs: { bg: '#000000' } }, second.one, { 'idempotency-key': 'campaign-cell' });
  assert.equal(changed.status, 409);
  assert.equal((await second.request(`/api/v1/renders/${queued.id}`, 'DELETE')).status, 409);
});

test('admission refuses anonymous work, missing runners and invalid input without allocating a resource', async (t) => {
  const h = await harness(); t.after(() => h.close());
  assert.equal((await h.request('/api/v1/renders', 'POST', render, '')).status, 401);
  for (const body of [{ ...render, inputs: { misspelt: true } }, { ...render, priority: 100 }, { ...render, format: 'pdf' }, { ...render, extra: true }]) {
    assert.ok([400, 422].includes((await h.request('/api/v1/renders', 'POST', body)).status));
  }
  assert.deepEqual((await (await h.request('/api/v1/renders')).json() as { renders: unknown[] }).renders, []);
  const absent = await harness({ attached: false }); t.after(() => absent.close());
  const rejected = await absent.request('/api/v1/renders', 'POST', render);
  assert.equal(rejected.status, 503);
  assert.equal((await rejected.json() as { error: { code: string } }).error.code, 'RENDER_RUNNER_UNAVAILABLE');
});

test('current policy is enforced at execution, and retry is a new resource retaining the original failure', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const r = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  await h.store.putOverlay({ toolId: 'card', version: 1, inputAccess: { bg: [{ groups: ['*'], level: 'locked', value: '#000000' }] } });
  const failed = await h.settle(r.id);
  assert.equal(failed.state, 'failed'); assert.equal(failed.attempt, 1); assert.equal(failed.error?.code, 'INPUT_LOCKED');
  await h.store.deleteOverlay('card');
  const response = await h.request(`/api/v1/renders/${r.id}/retry`, 'POST', undefined, h.one, { 'idempotency-key': 'retry-card' });
  assert.equal(response.status, 202);
  const retried = await response.json() as RenderRecord;
  assert.notEqual(retried.id, r.id); assert.equal(retried.retryOf, r.id);
  assert.equal((await h.settle(retried.id)).state, 'succeeded');
  assert.equal((await (await h.request(`/api/v1/renders/${r.id}`)).json() as RenderRecord).state, 'failed');
});

test('disabled users and revoked service tokens cannot execute persisted work', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const r = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  const user = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  await h.store.setUserDisabled(user.id, new Date().toISOString());
  await h.runner!.tick();
  for (let n = 0; n < 100 && (await h.store.getRender(r.id, `user:${user.id}`))?.state === 'running'; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await h.store.getRender(r.id, `user:${user.id}`))?.error?.code, 'PRINCIPAL_UNAVAILABLE');

  const token = mintServiceSecret();
  await h.store.putApiToken({ id: 'render-ci', label: 'CI', role: 'admin', tokenHash: token.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  const response = await h.request('/api/v1/renders', 'POST', render, '', { authorization: `Bearer ${token.secret}` });
  assert.equal(response.status, 202, await response.clone().text());
  const serviceRender = await response.json() as RenderRecord;
  await h.store.revokeApiToken('render-ci', new Date().toISOString());
  await h.runner!.tick();
  for (let n = 0; n < 100 && (await h.store.getRender(serviceRender.id, 'service:svc_render-ci'))?.state === 'running'; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal((await h.store.getRender(serviceRender.id, 'service:svc_render-ci'))?.error?.code, 'PRINCIPAL_UNAVAILABLE');
});

test('output retrieval reports missing and corrupted retained bytes distinctly', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const r = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  await h.settle(r.id);
  const user = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  const stored = (await h.store.getRender(r.id, `user:${user.id}`))!;
  await h.blobs.put(stored.output!.ref, Buffer.from('changed'), 'image/svg+xml');
  assert.equal((await h.request(`/api/v1/renders/${r.id}/output/default`)).status, 409);
  await h.blobs.delete(stored.output!.ref);
  assert.equal((await h.request(`/api/v1/renders/${r.id}/output/default`)).status, 410);
});

test('evidence retrieval preserves historical absence and detects a corrupted receipt', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const r = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  await h.settle(r.id);
  const user = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  const principal = `user:${user.id}`;
  const stored = (await h.store.getRender(r.id, principal))!;
  const legacy = (await h.store.insertRender(newRender(principal, parseRenderSpec(render)))).record;
  const claim = (await h.store.claimRender(10_000))!;
  const { evidence: _evidence, ...oldOutput } = stored.output!;
  await h.store.settleRender(claim.id, claim.leaseToken!, { state: 'succeeded', output: oldOutput });
  const missing = await h.request(`/api/v1/renders/${legacy.id}/evidence`);
  assert.equal(missing.status, 404);
  assert.equal((await missing.json() as { error: { code: string } }).error.code, 'EVIDENCE_UNAVAILABLE');
  const get = h.store.getRender.bind(h.store);
  h.store.getRender = async (id, owner) => {
    const record = await get(id, owner);
    if (record?.output?.evidence) record.output.evidence.context.profileHash = 'corrupted';
    return record;
  };
  const corrupt = await h.request(`/api/v1/renders/${r.id}/evidence`);
  assert.equal(corrupt.status, 409);
  assert.equal((await corrupt.json() as { error: { code: string } }).error.code, 'EVIDENCE_INTEGRITY');
});

test('revoking a tool grant hides retained renders and stops queued work without preventing cancellation', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const r = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  await h.settle(r.id);
  const pending = await (await h.request('/api/v1/renders', 'POST', render)).json() as RenderRecord;
  const user = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  await h.store.putGrant({ principal: `user:${user.id}`, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
  assert.equal((await h.request(`/api/v1/renders/${r.id}`)).status, 403);
  assert.equal((await h.request(`/api/v1/renders/${r.id}/output/default`)).status, 403);
  assert.equal((await h.request(`/api/v1/renders/${r.id}/evidence`)).status, 403);
  assert.deepEqual((await (await h.request('/api/v1/renders')).json() as { renders: unknown[] }).renders, []);
  assert.equal((await h.request('/api/v1/renders', 'POST', render)).status, 403);
  assert.equal((await h.request(`/api/v1/renders/${pending.id}`, 'DELETE')).status, 200);
});

test('CLI submits, inspects, downloads, cancels and retries over the real API', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const token = mintServiceSecret();
  await h.store.putApiToken({ id: 'cli-ci', label: 'CLI', role: 'admin', tokenHash: token.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  const dir = await mkdtemp(join(tmpdir(), 'lw-render-cli-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const requestFile = join(dir, 'request.json'); await writeFile(requestFile, JSON.stringify(render));
  const cliCommand = (command: string, ...args: string[]) => new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('../cli/lw.ts', import.meta.url)), command, ...args, '--base', h.base, '--token', token.secret, '--json'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (b) => { stdout += b; }); child.stderr.on('data', (b) => { stderr += b; });
    child.once('error', reject); child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
  const cli = (...args: string[]) => cliCommand('renders', ...args);
  const submitted = await cli('submit', requestFile, '--idempotency-key', 'cli');
  assert.equal(submitted.code, 0, submitted.stderr);
  const r = JSON.parse(submitted.stdout) as RenderRecord;
  assert.equal(JSON.parse((await cli('show', r.id)).stdout).state, 'queued');
  assert.equal((await cli('output', r.id)).code, 1, 'output requires an explicit file');
  await h.runner!.tick();
  for (let n = 0; n < 100 && (await h.store.getRender(r.id, 'service:svc_cli-ci'))?.state !== 'succeeded'; n++) await new Promise((resolve) => setTimeout(resolve, 10));
  const out = join(dir, 'card.svg'); const downloaded = await cli('output', r.id, '--out', out);
  assert.equal(downloaded.code, 0, downloaded.stderr); assert.match(await readFile(out, 'utf8'), /#334455/);
  assert.equal((await cli('evidence', r.id)).code, 1);
  const evidenceFile = join(dir, 'evidence.json');
  const evidenceDownload = await cli('evidence', r.id, '--out', evidenceFile);
  assert.equal(evidenceDownload.code, 0, evidenceDownload.stderr);
  const receipt = JSON.parse(await readFile(evidenceFile, 'utf8')) as { renderId: string; evidence: RenderEvidence };
  assert.equal(receipt.renderId, r.id); assert.equal(receipt.evidence.outputSha256, sha256Hex(await readFile(out)));
  const queued = JSON.parse((await cli('submit', requestFile)).stdout) as RenderRecord;
  assert.equal(JSON.parse((await cli('cancel', queued.id)).stdout).state, 'cancelled');
  assert.equal(JSON.parse((await cli('retry', queued.id)).stdout).retryOf, queued.id);
  await writeFile(requestFile, JSON.stringify(batchRequest));
  const submitBatch = await cliCommand('render-batches', 'submit', requestFile, '--idempotency-key', 'cli-batch');
  assert.equal(submitBatch.code, 0, submitBatch.stderr);
  const batch = JSON.parse(submitBatch.stdout) as BatchResponse;
  assert.equal(JSON.parse((await cliCommand('render-batches', 'show', batch.id)).stdout).state, 'queued');
  assert.equal(JSON.parse((await cliCommand('render-batches', 'list')).stdout).batches[0].id, batch.id);
  assert.equal((await cliCommand('render-batches', 'manifest', batch.id)).code, 1);
  assert.equal(JSON.parse((await cliCommand('render-batches', 'cancel', batch.id)).stdout).state, 'cancelled');
  const nextBatch = JSON.parse((await cliCommand('render-batches', 'retry', batch.id)).stdout) as BatchResponse;
  assert.equal(nextBatch.retryOf, batch.id);
  for (let n = 0; n < 200; n++) {
    await h.runner!.tick();
    const current = await h.store.getRenderBatch(nextBatch.id, 'service:svc_cli-ci');
    if (current!.rows.every((row) => row.render.state === 'succeeded')) break;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  const manifestFile = join(dir, 'manifest.json');
  const downloadedBatch = await cliCommand('render-batches', 'manifest', nextBatch.id, '--out', manifestFile);
  assert.equal(downloadedBatch.code, 0, downloadedBatch.stderr);
  const manifest = JSON.parse(await readFile(manifestFile, 'utf8'));
  assert.equal(manifest.manifestVersion, 1); assert.equal(manifest.state, 'succeeded');
  assert.equal(manifest.progress.succeeded, 3);
});

test('standalone process recovers Postgres renders and unfinished batch rows; a second boot serves retained outputs', {
  skip: !process.env.LW_TEST_DATABASE_URL && 'set LW_TEST_DATABASE_URL to run',
}, async () => {
  await withFreshPostgres(process.env.LW_TEST_DATABASE_URL!, async (store) => {
    const token = mintServiceSecret();
    await store.putApiToken({ id: 'boot-ci', label: 'Boot', role: 'admin', tokenHash: token.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
    const resource = (await store.insertRender(newRender('service:svc_boot-ci', parseRenderSpec(render)))).record;
    const singleClaim = (await store.claimRender(10_000))!;
    const batch = (await store.insertRenderBatch(newRenderBatch('service:svc_boot-ci', parseRenderBatchSpec(batchRequest)))).record;
    const completedRow = (await store.claimRender(10_000))!;
    const abandonedRow = (await store.claimRender(10_000))!;
    const retained = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><text>Already completed</text></svg>');
    const blobs = await createPostgresBlobStore(process.env.LW_TEST_DATABASE_URL!);
    try {
      await blobs.put('restart/batch-completed', retained, 'image/svg+xml');
      assert.equal(await store.settleRender(completedRow.id, completedRow.leaseToken!, { state: 'succeeded', output: {
        name: 'default', ref: 'restart/batch-completed', mime: 'image/svg+xml', size: retained.length, sha256: sha256Hex(retained), cacheKey: 'prior-success',
      } }), true);
    } finally { await blobs.close(); }
    // The previous process has one completed row, one abandoned row and one still queued.
    await store.heartbeatRender(singleClaim.id, singleClaim.leaseToken!, 50);
    await store.heartbeatRender(abandonedRow.id, abandonedRow.leaseToken!, 50);
    const probe = createServer();
    await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
    const address = probe.address(); assert.ok(address && typeof address === 'object');
    const port = address.port;
    await new Promise<void>((resolve) => probe.close(() => resolve()));
    const base = `http://127.0.0.1:${port}`;
    const configFile = join(pack, 'instance.json');
    await writeFile(configFile, JSON.stringify({ instance: { name: 'Restart proof', baseUrl: base, pack },
      dev: { enabled: true }, audit: { headLog: { onBoot: false, intervalMinutes: 0 } }, rateLimit: { enabled: false } }));
    const main = fileURLToPath(new URL('../server/src/main.ts', import.meta.url));
    const request = (path: string) => fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token.secret}` } });
    let expectedDigest = '';
    let expectedEvidenceId = '';
    let batchDigests: string[] = [];
    for (let boot = 0; boot < 2; boot++) {
      const child = spawn(process.execPath, [main], { env: { ...process.env,
        LW_CONFIG: configFile, PORT: String(port), DATABASE_URL: process.env.LW_TEST_DATABASE_URL,
        LW_SESSION_SECRET: 'restart-test-session', LW_LINK_SECRET: 'restart-test-link',
      }, stdio: ['ignore', 'pipe', 'pipe'] });
      let log = '';
      child.stdout.on('data', (bytes) => { log += bytes; }); child.stderr.on('data', (bytes) => { log += bytes; });
      const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
      try {
        let ready = false;
        for (let i = 0; i < 200; i++) {
          try { ready = (await request('/healthz')).ok; } catch { /* startup */ }
          if (ready || child.exitCode !== null) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.ok(ready, log);
        let done: RenderRecord | undefined;
        for (let i = 0; i < 200; i++) {
          const response = await request(`/api/v1/renders/${resource.id}`);
          assert.equal(response.status, 200, await response.clone().text());
          done = await response.json() as RenderRecord;
          if (done.state === 'succeeded' || done.state === 'failed') break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(done?.state, 'succeeded', `${JSON.stringify(done)}\n${log}`);
        assert.equal(done.attempt, 2, 'completed renders are not executed again on boot');
        const response = await request(`/api/v1/renders/${resource.id}/output/default`);
        assert.equal(response.status, 200);
        const bytes = new Uint8Array(await response.arrayBuffer());
        assert.equal(sha256Hex(bytes), done.output!.sha256);
        if (boot === 0) expectedDigest = done.output!.sha256;
        else assert.equal(done.output!.sha256, expectedDigest, 'the second process serves retained bytes');
        const evidenceResponse = await request(`/api/v1/renders/${resource.id}/evidence`);
        assert.equal(evidenceResponse.status, 200);
        const receipt = await evidenceResponse.json() as { evidence: RenderEvidence };
        assert.equal(receipt.evidence.outputSha256, expectedDigest);
        assert.equal(receipt.evidence.id, done.output!.evidence!.id);
        if (boot === 0) expectedEvidenceId = receipt.evidence.id;
        else assert.equal(receipt.evidence.id, expectedEvidenceId, 'evidence survives process replacement with its output');
        let batchDone: BatchResponse | undefined;
        for (let i = 0; i < 200; i++) {
          const response = await request(`/api/v1/render-batches/${batch.id}/manifest`);
          assert.equal(response.status, 200, await response.clone().text());
          batchDone = await response.json() as BatchResponse;
          if (batchDone.progress.done === 3) break;
          await new Promise((resolve) => setTimeout(resolve, 25));
        }
        assert.equal(batchDone?.state, 'succeeded', `${JSON.stringify(batchDone)}\n${log}`);
        assert.equal(batchDone.rows.find((r) => r.id === completedRow.id)!.attempt, 1);
        assert.equal(batchDone.rows.find((r) => r.id === completedRow.id)!.output!.sha256, sha256Hex(retained));
        assert.equal(batchDone.rows.find((r) => r.id === abandonedRow.id)!.attempt, 2);
        for (const row of batchDone.rows) {
          const response = await request(`/api/v1/renders/${row.id}/output/default`);
          assert.equal(response.status, 200);
          assert.equal(sha256Hex(new Uint8Array(await response.arrayBuffer())), row.output!.sha256);
        }
        const digests = batchDone.rows.map((r) => r.output!.sha256);
        if (boot === 0) batchDigests = digests;
        else assert.deepEqual(digests, batchDigests, 'all row receipts survive the second process');
      } finally {
        if (child.exitCode === null) child.kill('SIGTERM');
        const force = setTimeout(() => child.kill('SIGKILL'), 5_000);
        await exited; clearTimeout(force);
      }
    }
  });
});
