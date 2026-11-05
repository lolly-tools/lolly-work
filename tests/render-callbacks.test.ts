// SPDX-License-Identifier: MPL-2.0
/**
 * Signed callbacks for durable renders and render batches, through the same
 * outbox as automation jobs. Store-level entries are covered by the two store
 * conformance suites; this file covers submission rules, what is sent and what
 * a receiver can do with it.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { callbackUrlAllowed } from '../server/src/automation/callback-policy.ts';
import { CallbackOutbox } from '../server/src/automation/callback-outbox.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const SECRET = 'render-callback-secret';
const HOOK = 'https://hooks.example/lolly';
const NOTIFY = 'http://notify.test/events';
let pack: string;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-render-callbacks-'));
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

interface Sent { url: string; init: RequestInit; body: Record<string, unknown>; raw: string; headers: Record<string, string> }

async function harness(script: Array<number | Error> = [200], allowedOrigins: string[] = ['https://hooks.example']) {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const sent: Sent[] = [];
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    const raw = String(init?.body);
    sent.push({ url: String(url), init: init!, raw, body: JSON.parse(raw) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
    const next = script.length > 1 ? script.shift()! : script[0]!;
    if (next instanceof Error) throw next;
    return new Response(null, { status: next });
  }) as typeof fetch;
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Callbacks', baseUrl: 'https://work.test', pack },
    policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false },
    notify: { webhook: { url: NOTIFY } }, automation: { callbacks: { allowedOrigins } },
    dev: { enabled: true, users: [{ email: 'one@test', name: 'One', groups: ['admin'] }] },
  }));
  let runner!: RenderRunner;
  const app = buildApp({ config, store, blobs, fetchImpl, secrets: { session: 'test-session', link: 'test-link', webhook: SECRET },
    onRenderRunner: (r: RenderRunner) => { runner = r; r.kick = () => {}; } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=one@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  const request = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = {}) =>
    fetch(`${base}${path}`, { method, headers: { cookie, 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const hookedSent = () => sent.filter((s) => s.url !== NOTIFY || s.body.renderId || s.body.batchId);
  const waitForCallback = async (count = 1): Promise<Sent[]> => {
    for (let i = 0; i < 300; i++) {
      await runner.tick();
      if (hookedSent().length >= count) return hookedSent();
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`expected ${count} callback(s), saw ${hookedSent().length}`);
  };
  return { base, store, blobs, sent, request, waitForCallback, hookedSent, tick: () => runner.tick(),
    close: async () => { await runner.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
const card = { toolId: 'card', format: 'svg', inputs: { bg: '#334455' } };
const signed = (s: Sent): boolean =>
  s.headers['x-lolly-signature'] === `sha256=${createHmac('sha256', SECRET).update(`${s.headers['x-lolly-timestamp']}.${s.raw}`).digest('hex')}`;

test('a finished render calls back with a signed body, and its token reads only its output', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: `${HOOK}/renders` });
  assert.equal(created.status, 202, await created.clone().text());
  const { id } = await created.json() as { id: string };
  const [call] = await h.waitForCallback();
  assert.equal(call!.url, `${HOOK}/renders`);
  assert.equal(call!.init.method, 'POST');
  assert.equal(call!.init.redirect, 'error', 'a redirect is refused, as delivery refuses one');
  assert.ok(signed(call!));
  assert.equal(call!.headers['x-lolly-delivery-id'], call!.body.deliveryId);
  assert.equal(call!.body.renderId, id);
  assert.equal(call!.body.state, 'succeeded');
  assert.equal(call!.body.statusUrl, `https://work.test/api/v1/renders/${id}`);
  assert.equal(call!.body.outputUrl, `https://work.test/api/v1/renders/${id}/output/default`);
  assert.match(String(call!.body.outputSha256), /^[0-9a-f]{64}$/);
  assert.equal(call!.body.error, null);

  // The token needs no session of the receiver's own.
  const token = call!.body.outputToken as string;
  const read = await fetch(`${h.base}/api/v1/renders/${id}/output/default`, { headers: { 'x-lw-render-token': token } });
  assert.equal(read.status, 200);
  assert.match(await read.text(), /<svg/);
  const evidence = await fetch(`${h.base}/api/v1/renders/${id}/evidence`, { headers: { 'x-lw-render-token': token } });
  assert.equal(evidence.status, 200);
  assert.equal((await fetch(`${h.base}/api/v1/renders/${id}`, { headers: { 'x-lw-render-token': token } })).status, 401, 'the token reads output, not the record');
  const other = await (await h.request('/api/v1/renders', 'POST', card)).json() as { id: string };
  assert.equal((await fetch(`${h.base}/api/v1/renders/${other.id}/output/default`, { headers: { 'x-lw-render-token': token } })).status, 401);
  assert.equal((await fetch(`${h.base}/api/v1/renders/${id}/output/default`, { headers: { 'x-lw-render-token': `${token}x` } })).status, 401);

  // The record reports the entry, in the job callback's words.
  for (let i = 0; i < 100; i++) {
    const record = await (await h.request(`/api/v1/renders/${id}`)).json() as { callback?: { state: string; attempts: number; lastOutcome?: string; lastStatus?: number; id: string } };
    if (record.callback?.state === 'acknowledged') {
      assert.equal(record.callback.attempts, 1);
      assert.equal(record.callback.lastOutcome, 'acknowledged');
      assert.equal(record.callback.lastStatus, 200);
      assert.equal(record.callback.id, call!.body.deliveryId);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  assert.fail('the callback was not acknowledged');
});

test('a failed or cancelled render calls back without output', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const refused = await (await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: HOOK })).json() as { id: string };
  assert.equal((await h.request(`/api/v1/renders/${refused.id}`, 'DELETE')).status, 200);
  const [call] = await h.waitForCallback();
  assert.equal(call!.body.renderId, refused.id);
  assert.equal(call!.body.state, 'cancelled');
  assert.equal(call!.body.outputUrl, null);
  assert.equal(call!.body.outputToken, null);
});

test('submission refuses a callback URL this instance does not send to, and creates nothing', async (t) => {
  const h = await harness(); t.after(() => h.close());
  for (const url of ['https://elsewhere.example/hook', 'http://hooks.example/lolly', 'https://hooks.example.evil.test/x']) {
    const res = await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: url });
    assert.equal(res.status, 403, url);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'CALLBACK_URL_NOT_ALLOWED');
    const batch = await h.request('/api/v1/render-batches', 'POST', { ...card, callbackUrl: url, rows: [{ key: 'one' }] });
    assert.equal(batch.status, 403, url);
  }
  for (const url of ['not a url', 'ftp://hooks.example/x', 'https://user:pw@hooks.example/x', 42]) {
    assert.equal((await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: url })).status, 400, String(url));
  }
  assert.equal(((await (await h.request('/api/v1/renders')).json()) as { renders: unknown[] }).renders.length, 0);
  assert.equal((await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: NOTIFY })).status, 202, 'the exact notify webhook stays allowed');
});

test('a callback URL is part of request identity for idempotency, and of no render identity', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const key = { 'idempotency-key': 'same' };
  const first = await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: `${HOOK}/a` }, key);
  assert.equal(first.status, 202);
  assert.equal((await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: `${HOOK}/a` }, key)).status, 200);
  const changed = await h.request('/api/v1/renders', 'POST', { ...card, callbackUrl: `${HOOK}/b` }, key);
  assert.equal(changed.status, 409);
  assert.equal((await changed.json() as { error: { code: string } }).error.code, 'IDEMPOTENCY_KEY_REUSED');
  const withUrl = newRender('user:a', parseRenderSpec({ ...card, callbackUrl: HOOK }));
  const without = newRender('user:a', parseRenderSpec(card));
  assert.notEqual(withUrl.requestHash, without.requestHash);
  const batchKey = { 'idempotency-key': 'same-batch' };
  const rows = [{ key: 'one' }];
  assert.equal((await h.request('/api/v1/render-batches', 'POST', { ...card, rows, callbackUrl: `${HOOK}/a` }, batchKey)).status, 202);
  assert.equal((await h.request('/api/v1/render-batches', 'POST', { ...card, rows, callbackUrl: `${HOOK}/b` }, batchKey)).status, 409);
});

test('a batch calls back once, when its last row finishes, and its token reads its manifest', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.request('/api/v1/render-batches', 'POST', { ...card, callbackUrl: `${HOOK}/batches`, rows: [
    { key: 'uk', inputs: { bg: '#112233' } }, { key: 'fr', inputs: { bg: '#445566' } }, { key: 'de', inputs: { bg: '#778899' } },
  ] });
  assert.equal(created.status, 202, await created.clone().text());
  const batch = await created.json() as { id: string; rows: Array<{ id: string; request: { callbackUrl?: string } }> };
  assert.ok(batch.rows.every((row) => row.request.callbackUrl === undefined));
  const [call] = await h.waitForCallback();
  await new Promise((resolve) => setTimeout(resolve, 50));
  await h.tick();
  assert.equal(h.hookedSent().length, 1, 'one callback, not one per row');
  assert.equal(call!.url, `${HOOK}/batches`);
  assert.ok(signed(call!));
  assert.equal(call!.body.batchId, batch.id);
  assert.equal(call!.body.state, 'succeeded');
  assert.deepEqual(call!.body.progress, { total: 3, done: 3, queued: 0, running: 0, succeeded: 3, failed: 0, cancelled: 0 });
  assert.equal(call!.body.manifestUrl, `https://work.test/api/v1/render-batches/${batch.id}/manifest`);
  const manifest = await fetch(`${h.base}/api/v1/render-batches/${batch.id}/manifest`, { headers: { 'x-lw-render-token': call!.body.outputToken as string } });
  assert.equal(manifest.status, 200);
  assert.equal(call!.body.archiveUrl, `https://work.test/api/v1/render-batches/${batch.id}/archive`);
  const archive = await fetch(`${h.base}/api/v1/render-batches/${batch.id}/archive`, { headers: { 'x-lw-render-token': call!.body.outputToken as string } });
  assert.equal(archive.status, 200, 'the token reads the archive too');
  await archive.arrayBuffer();
  assert.equal((await fetch(`${h.base}/api/v1/render-batches/${batch.id}`, { headers: { 'x-lw-render-token': call!.body.outputToken as string } })).status, 401);
  const owner = (await h.store.listUsers()).find((u) => u.email === 'one@test')!;
  await h.store.putGrant({ principal: `user:${owner.id}`, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
  assert.equal((await fetch(`${h.base}/api/v1/render-batches/${batch.id}/manifest`, { headers: { 'x-lw-render-token': call!.body.outputToken as string } })).status, 403, 'the token reads under the owner\'s current grants');
});

test('an unanswered callback retries on the ladder with the same delivery id', async (t) => {
  const store = createMemoryStore();
  const saved = (await store.insertRender(newRender('user:a', parseRenderSpec({ ...card, callbackUrl: HOOK })))).record;
  await store.cancelRender(saved.id, 'user:a');
  const attempts: Array<{ id: string; status: number | Error }> = [];
  const script: Array<number | Error> = [500, new Error('connection dropped'), 200];
  const outbox = new CallbackOutbox(store, {
    secret: SECRET, allowed: () => true, retryDelaysMs: [0, 0], baseUrl: 'https://work.test',
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => {
      const status = script.shift()!;
      attempts.push({ id: (init?.headers as Record<string, string>)['x-lolly-delivery-id']!, status });
      if (status instanceof Error) throw status;
      return new Response(null, { status });
    }) as typeof fetch,
  });
  t.after(() => outbox.stop());
  for (let i = 0; i < 200 && attempts.length < 3; i++) { await outbox.poll(); await new Promise((resolve) => setTimeout(resolve, 5)); }
  assert.equal(attempts.length, 3);
  assert.equal(new Set(attempts.map((attempt) => attempt.id)).size, 1, 'every attempt carries one delivery id');
  for (let i = 0; i < 100; i++) {
    const summary = await store.renderCallbackSummary(saved.id);
    if (summary?.state === 'acknowledged') { assert.equal(summary.attempts, 3); return; }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('the third attempt was not recorded as acknowledged');
});

test('a URL the instance stopped approving is not sent, and says so', async (t) => {
  const store = createMemoryStore();
  const saved = (await store.insertRender(newRender('user:a', parseRenderSpec({ ...card, callbackUrl: HOOK })))).record;
  await store.cancelRender(saved.id, 'user:a');
  let requests = 0;
  const outbox = new CallbackOutbox(store, { secret: SECRET, allowed: () => false, fetchImpl: (async () => { requests++; return new Response(null); }) as typeof fetch });
  t.after(() => outbox.stop());
  await outbox.poll();
  for (let i = 0; i < 100; i++) {
    const summary = await store.renderCallbackSummary(saved.id);
    if (summary?.state === 'failed') {
      assert.equal(summary.lastOutcome, 'not-sent');
      assert.equal(requests, 0);
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  assert.fail('the entry did not settle');
});

test('the outbox renderBody option replaces the words and keeps the sender', async (t) => {
  const store = createMemoryStore();
  const saved = (await store.insertRender(newRender('user:a', parseRenderSpec({ ...card, callbackUrl: HOOK })))).record;
  await store.cancelRender(saved.id, 'user:a');
  const seen: Array<{ raw: string; headers: Record<string, string> }> = [];
  const outbox = new CallbackOutbox(store, {
    secret: SECRET, allowed: () => true,
    renderBody: (subject, context) => ({ uid: subject.kind === 'render' ? subject.render.id : subject.batch.id, delivery: context.deliveryId }),
    fetchImpl: (async (_url: string | URL | Request, init?: RequestInit) => { seen.push({ raw: String(init?.body), headers: init?.headers as Record<string, string> }); return new Response(null); }) as typeof fetch,
  });
  t.after(() => outbox.stop());
  await outbox.poll();
  for (let i = 0; i < 100 && !seen.length; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  const body = JSON.parse(seen[0]!.raw) as Record<string, unknown>;
  assert.equal(body.uid, saved.id);
  assert.equal(body.delivery, seen[0]!.headers['x-lolly-delivery-id']);
  assert.ok(seen[0]!.headers['x-lolly-signature']);
});

test('callback origins are exact HTTPS origins, checked at boot', () => {
  const base = { instance: { name: 'x', baseUrl: 'http://localhost', pack: '/tmp' }, policy: { defaultAccessMode: 'open' } };
  for (const origin of ['http://hooks.example', 'https://hooks.example/', 'https://hooks.example/path', 'hooks.example', 'https://user@hooks.example', 42]) {
    assert.throws(() => parseConfig(JSON.stringify({ ...base, automation: { callbacks: { allowedOrigins: [origin] } } })), /allowedOrigins/, String(origin));
  }
  assert.throws(() => parseConfig(JSON.stringify({ ...base, automation: { callbacks: { allowedOrigins: 'https://hooks.example' } } })), /allowedOrigins/);
  const config = parseConfig(JSON.stringify({ ...base, automation: { callbacks: { allowedOrigins: ['https://hooks.example', 'https://hooks.example:8443'] } }, notify: { webhook: { url: NOTIFY } } }));
  assert.equal(callbackUrlAllowed(config, 'https://hooks.example/any/path?x=1'), true);
  assert.equal(callbackUrlAllowed(config, 'https://hooks.example:8443/x'), true);
  assert.equal(callbackUrlAllowed(config, 'https://hooks.example:9000/x'), false);
  assert.equal(callbackUrlAllowed(config, 'https://user:pw@hooks.example/x'), false);
  assert.equal(callbackUrlAllowed(config, NOTIFY), true);
  assert.equal(callbackUrlAllowed(config, `${NOTIFY}/other`), false);
  assert.throws(() => buildApp({ config: parseConfig(JSON.stringify({ ...base, automation: { callbacks: { allowedOrigins: ['https://hooks.example'] } } })),
    store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 's', link: 'l' } }), /LW_WEBHOOK_SECRET/);
});
