// SPDX-License-Identifier: MPL-2.0
/**
 * /compat/ end to end: a real app, real durable renders, and vendor-shaped requests
 * sent with a service token. Built from public documentation and fixtures, never run
 * against a live account.
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';
import { prepareRenderApi } from '../server/src/render-api/routes.ts';
import { checkRenderApiConfig } from '../server/src/render-api/mapping.ts';
import { sweepRenderOutputs } from '../server/src/renders/retention.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const WEBHOOK_SECRET = 'render-api-webhook-secret';
const PRIVATE_TOKEN = 'placid-private-token';
let pack: string;
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-render-api-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'heading', type: 'text', label: 'Heading', default: 'Default' }, { id: 'bg', type: 'color', label: 'Background', default: '#112233' }],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><rect width="100" height="100" fill="{{bg}}"/><text id="heading" y="20">{{heading}}</text></svg>');
});
after(() => rm(pack, { recursive: true, force: true }));

const TEMPLATES = [
  { source: 'bannerbear-v5', template: 'bbfive', toolId: 'card', format: 'svg', layers: { title: { text: 'heading' }, background: { 'background-color': 'bg' } } },
  { source: 'bannerbear-v2', template: 'bbtwo', toolId: 'card', format: 'svg', layers: { title: { text: 'heading' } } },
  { source: 'placid', template: 'plc', toolId: 'card', format: 'svg', layers: { title: { text: 'heading' } }, url: { credentialRef: 'PLACID_OLD_TOKEN' } },
  { source: 'placid', template: 'open', toolId: 'card', format: 'svg', layers: { title: { text: 'heading' } }, url: { allowUnsigned: true } },
];

interface Sent { url: string; body: Record<string, unknown>; headers: Record<string, string> }

async function harness(options: { enabled?: boolean; signedDays?: number; allowedOrigins?: string[]; actAs?: string; autoRun?: boolean; retentionDays?: number } = {}) {
  const store = createMemoryStore(); const blobs = createMemoryBlobStore();
  const sent: Sent[] = [];
  process.env.PLACID_OLD_TOKEN = PRIVATE_TOKEN;
  const fetchImpl = (async (url: string | URL | Request, init?: RequestInit) => {
    sent.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown>, headers: init?.headers as Record<string, string> });
    return new Response(null, { status: 200 });
  }) as typeof fetch;
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Move', baseUrl: 'https://work.test', pack },
    policy: { defaultAccessMode: 'gated', ...(options.retentionDays ? { retention: { renderOutputDays: options.retentionDays } } : {}) }, rateLimit: { enabled: false },
    automation: { callbacks: { allowedOrigins: options.allowedOrigins ?? ['https://hook.example'] } },
    renderApi: { enabled: options.enabled ?? true, templates: TEMPLATES, resultUrls: { signedDays: options.signedDays ?? 30 }, urlApi: options.actAs ? { actAs: options.actAs } : {} },
    dev: { enabled: true, users: [{ email: 'owner@test', name: 'Owner', groups: ['owner'] }] },
  }));
  let runner!: RenderRunner;
  const app = buildApp({ config, store, blobs, fetchImpl,
    secrets: { session: 'test-session', link: 'test-link', webhook: WEBHOOK_SECRET, renderApiUrls: 'url-secret' },
    onRenderRunner: (r: RenderRunner) => { runner = r; if (options.autoRun === false) r.kick = () => {}; },
  });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const token = mintServiceSecret();
  await store.putApiToken({ id: 'ci', label: 'CI', role: 'admin', tokenHash: token.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  const other = mintServiceSecret();
  await store.putApiToken({ id: 'other', label: 'Other', role: 'admin', tokenHash: other.tokenHash, createdBy: 'system', createdAt: new Date().toISOString() });
  const call = (path: string, method = 'GET', body?: unknown, headers: Record<string, string> = { authorization: `Bearer ${token.secret}` }) =>
    fetch(`${base}${path}`, { method, headers: { 'content-type': 'application/json', ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const local = (url: string): string => url.replace('https://work.test', base);
  const poll = async (path: string, done: (body: Record<string, unknown>) => boolean): Promise<Record<string, unknown>> => {
    for (let i = 0; i < 400; i++) {
      await runner.tick();
      const res = await call(path);
      assert.equal(res.status, 200, await res.clone().text());
      const body = await res.json() as Record<string, unknown>;
      if (done(body)) return body;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    assert.fail(`${path} did not finish`);
  };
  return { base, store, blobs, sent, call, local, poll, secret: token.secret, otherSecret: other.secret, tick: () => runner.tick(),
    close: async () => { await runner.stop(); await new Promise<void>((resolve) => server.close(() => resolve())); } };
}
const finished = (body: Record<string, unknown>): boolean => body.status !== 'pending' && body.status !== 'queued';
const localPath = (url: unknown): string => new URL(String(url)).pathname;

test('disabled means 404 on every route, and enabling needs its own secret', async (t) => {
  const h = await harness({ enabled: false }); t.after(() => h.close());
  for (const [method, path] of [
    ['POST', '/compat/bannerbear/v5/images'], ['GET', '/compat/bannerbear/v5/images'], ['GET', '/compat/bannerbear/v5/images/x'], ['POST', '/compat/bannerbear/sync/v5/images'],
    ['POST', '/compat/bannerbear/v2/images'], ['GET', '/compat/bannerbear/v2/images/x'], ['POST', '/compat/bannerbear/sync/v2/images'], ['GET', '/compat/bannerbear/v2/auth'],
    ['POST', '/compat/placid/api/rest/images'], ['GET', '/compat/placid/api/rest/images/1'], ['DELETE', '/compat/placid/api/rest/images/1'], ['GET', '/compat/placid/u/plc?title[text]=x'],
    ['GET', '/compat/files/a/b/c/image.png'], ['GET', '/compat/files/a/image.png'], ['DELETE', '/compat/requests/a'], ['POST', '/compat/bannerbear/v5/webhooks'], ['GET', '/compat/placid/api/rest/templates'],
  ] as const) {
    const res = await h.call(path, method, method === 'POST' ? {} : undefined);
    assert.equal(res.status, 404, `${method} ${path}`);
  }
  const store = createMemoryStore();
  const on = checkRenderApiConfig({ enabled: true, templates: [], resultUrls: { signedDays: 30 }, urlApi: {} });
  assert.throws(() => prepareRenderApi(on, {}, store, 'https://work.test'), /LW_RENDER_API_URL_SECRET/);
  assert.doesNotThrow(() => prepareRenderApi({ ...on, resultUrls: { signedDays: 0 } }, {}, store, 'https://work.test'));
  const missing = checkRenderApiConfig({ enabled: true, templates: [{ ...TEMPLATES[2], url: { credentialRef: 'NOT_SET_ANYWHERE' } }], resultUrls: { signedDays: 0 }, urlApi: {} });
  assert.throws(() => prepareRenderApi(missing, {}, store, 'https://work.test', {}), /NOT_SET_ANYWHERE/);
  assert.throws(() => prepareRenderApi({ ...on, mappingsFile: '/does/not/exist.json' }, { renderApiUrls: 's' }, store, 'https://work.test'), /ENOENT/);
});

test('a service token is required, and a person\'s session is refused', async (t) => {
  const h = await harness(); t.after(() => h.close());
  assert.equal((await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive' }, {})).status, 401);
  assert.equal((await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive' }, { authorization: 'Bearer lwt_wrong' })).status, 401);
  const login = await fetch(`${h.base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  assert.equal((await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive' }, { cookie })).status, 401);
  assert.equal((await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc' }, { cookie })).status, 401);
  const auth = await h.call('/compat/bannerbear/v2/auth');
  assert.equal(auth.status, 200);
  assert.deepEqual(await auth.json(), { message: 'Authorized', project: 'work.test' });
});

test('Bannerbear V5: create, poll and fetch through a signed result URL', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await h.call('/compat/bannerbear/v5/images', 'POST', {
    template: 'bbfive', metadata: 'campaign_id:12345',
    modifications: { objects: [{ name: 'title', text: 'Hello World' }, { name: 'background', 'background-color': '#445566' }] },
  });
  assert.equal(created.status, 202, await created.clone().text());
  const body = await created.json() as Record<string, unknown>;
  assert.equal(body.status, 'pending');
  assert.equal(body.template, 'bbfive');
  assert.deepEqual(body.files, { svg: null });
  assert.equal(body.metadata, 'campaign_id:12345');
  assert.equal(body.self, `https://work.test/compat/bannerbear/v5/images/${body.uid}`);
  const done = await h.poll(localPath(body.self), finished);
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.match(String(done.completed_at), /^\d{4}-/);
  const url = (done.files as { svg: string }).svg;
  assert.match(url, /^https:\/\/work\.test\/compat\/files\/.+\/\d+\/.+\/image\.svg$/);
  const file = await fetch(h.local(url));
  assert.equal(file.status, 200, 'no bearer token needed');
  assert.equal(file.headers.get('content-type'), 'image/svg+xml');
  assert.match(file.headers.get('content-security-policy') ?? '', /sandbox/, 'inert headers');
  assert.match(file.headers.get('content-disposition') ?? '', /^inline/);
  const svg = await file.text();
  assert.match(svg, /Hello World/); assert.match(svg, /#445566/);
  const head = await fetch(h.local(url), { method: 'HEAD' });
  assert.equal(head.status, 200, 'an image proxy may ask first');
  assert.equal(head.headers.get('content-type'), 'image/svg+xml');
  const list = await (await h.call('/compat/bannerbear/v5/images?limit=5')).json() as Array<{ uid: string }>;
  assert.deepEqual(list.map((item) => item.uid), [body.uid]);
  const stranger = await h.call(localPath(body.self), 'GET', undefined, { authorization: `Bearer ${h.otherSecret}` });
  assert.equal(stranger.status, 404, 'another token cannot read it');
});

test('formats become one durable render each, and a format Work cannot make is refused by name', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const refused = await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive', formats: ['png', 'webp', 'avif'] });
  assert.equal(refused.status, 422);
  assert.deepEqual(((await refused.json()) as { error: { formats: string[] } }).error.formats, ['webp', 'avif']);
  const created = await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive', formats: ['svg', 'png'] });
  assert.equal(created.status, 202, await created.clone().text());
  const body = await created.json() as { uid: string; lolly: { renders: Record<string, string> } };
  assert.deepEqual(Object.keys(body.lolly.renders).sort(), ['png', 'svg']);
  const done = await h.poll(`/compat/bannerbear/v5/images/${body.uid}`, finished);
  const files = done.files as Record<string, string>;
  assert.equal(done.status, 'completed', JSON.stringify(done));
  assert.equal((await fetch(h.local(files.png!))).headers.get('content-type'), 'image/png');
  assert.equal((await fetch(h.local(files.svg!))).headers.get('content-type'), 'image/svg+xml');
});

test('an unmapped property is refused by name before anything is created', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const res = await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive', modifications: { objects: [{ name: 'title', text: 'x', 'font-size': 40 }] } });
  assert.equal(res.status, 422);
  const { error } = await res.json() as { error: { code: string; properties: string[] } };
  assert.equal(error.code, 'PROPERTY_NOT_MAPPED');
  assert.deepEqual(error.properties, ['title.font-size']);
  assert.equal((await h.store.listRenderApiRecords('service:svc_ci', 'bannerbear-v5', 10, 0)).length, 0);
  assert.equal((await h.store.listRenders('service:svc_ci', 10, 0)).length, 0);
  assert.equal((await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'unknown' })).status, 404);
});

test('a policy lock applies through the migration route, at submission and at each attempt', async (t) => {
  const h = await harness({ autoRun: false }); t.after(() => h.close());
  const held = await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Before the lock' } } });
  assert.equal(held.status, 200, await held.clone().text());
  const queued = await held.json() as { id: number };
  await h.store.putOverlay({ toolId: 'card', version: 1, inputAccess: { heading: [{ groups: ['*'], level: 'locked', value: 'Locked words' }] } });
  const refused = await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'After the lock' } } });
  assert.equal(refused.status, 422);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'INPUT_LOCKED');
  const failed = await h.poll(`/compat/placid/api/rest/images/${queued.id}`, finished);
  assert.equal(failed.status, 'error', 'the durable attempt reads the current policy');
  assert.equal(failed.error_code, 'INVALID_INPUT');
  assert.equal((failed.lolly as { error: { code: string } }).error.code, 'INPUT_LOCKED');
});

test('Bannerbear V2: webhook_url sends the vendor-shaped object, signed, with one delivery id', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const refused = await h.call('/compat/bannerbear/v2/images', 'POST', { template: 'bbtwo', modifications: [], webhook_url: 'https://elsewhere.example/hook' });
  assert.equal(refused.status, 403);
  assert.equal(((await refused.json()) as { error: { code: string } }).error.code, 'CALLBACK_URL_NOT_ALLOWED');
  const created = await h.call('/compat/bannerbear/v2/images', 'POST', {
    template: 'bbtwo', modifications: [{ name: 'title', text: 'Hook' }], webhook_url: 'https://hook.example/bb', metadata: 'm1',
  });
  assert.equal(created.status, 202, await created.clone().text());
  const body = await created.json() as Record<string, unknown>;
  assert.equal(body.status, 'pending'); assert.equal(body.webhook_url, 'https://hook.example/bb'); assert.equal(body.image_url, null); assert.equal(body.webhook_response_code, null);
  assert.deepEqual(body.modifications, [{ name: 'title', text: 'Hook' }]);
  const self = localPath(body.self);
  await h.poll(self, finished);
  for (let i = 0; i < 200 && !h.sent.length; i++) { await h.tick(); await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(h.sent.length, 1);
  const [hook] = h.sent;
  assert.equal(hook!.url, 'https://hook.example/bb');
  assert.equal(hook!.body.uid, body.uid); assert.equal(hook!.body.status, 'completed'); assert.equal(hook!.body.metadata, 'm1');
  assert.match(String(hook!.body.image_url), /\/compat\/files\//);
  assert.equal(hook!.body.webhook_url, 'https://hook.example/bb');
  assert.equal((hook!.body.lolly as { deliveryId: string }).deliveryId, hook!.headers['x-lolly-delivery-id']);
  const signature = createHmac('sha256', WEBHOOK_SECRET).update(`${hook!.headers['x-lolly-timestamp']}.${JSON.stringify(hook!.body)}`).digest('hex');
  assert.equal(hook!.headers['x-lolly-signature'], `sha256=${signature}`);
  for (let i = 0; i < 100; i++) { const now = await (await h.call(self)).json() as Record<string, unknown>; if (now.webhook_response_code === 200) return; await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.fail('the receiver\'s status never reached webhook_response_code');
});

test('Placid: webhook_success carries passthrough, status words follow the docs, and create_now waits', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const refused = await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', webhook_success: 'https://elsewhere.example/x' });
  assert.equal(refused.status, 403);
  const created = await h.call('/compat/placid/api/rest/images', 'POST', {
    template_uuid: 'plc', layers: { title: { text: 'Meet Singh' } }, webhook_success: 'https://hook.example/placid', passthrough: 'batch-7', errors: [],
  });
  assert.equal(created.status, 200, await created.clone().text());
  const body = await created.json() as { id: number; status: string; polling_url: string; passthrough: string };
  assert.equal(typeof body.id, 'number'); assert.equal(body.status, 'queued'); assert.equal(body.passthrough, 'batch-7');
  assert.equal(body.polling_url, `https://work.test/compat/placid/api/rest/images/${body.id}`);
  const done = await h.poll(localPath(body.polling_url), finished);
  assert.equal(done.status, 'finished', JSON.stringify(done));
  for (let i = 0; i < 200 && !h.sent.length; i++) { await h.tick(); await new Promise((resolve) => setTimeout(resolve, 10)); }
  assert.equal(h.sent[0]!.url, 'https://hook.example/placid');
  assert.equal(h.sent[0]!.body.id, body.id); assert.equal(h.sent[0]!.body.status, 'finished'); assert.equal(h.sent[0]!.body.passthrough, 'batch-7');
  const now = await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Now' } }, create_now: true });
  assert.equal(now.status, 200);
  const immediate = await now.json() as { status: string; image_url: string };
  assert.equal(immediate.status, 'finished', 'create_now answers with the finished object');
  assert.match(await (await fetch(h.local(immediate.image_url))).text(), /Now/);
  const missing = await h.call('/compat/placid/api/rest/images/999999');
  assert.equal(missing.status, 404);
});

test('a sync host answers 408 at its 10 second limit, and the record carries on', async (t) => {
  const h = await harness({ autoRun: false }); t.after(() => h.close());
  const started = Date.now();
  const slow = await h.call('/compat/bannerbear/sync/v5/images', 'POST', { template: 'bbfive', modifications: { objects: [{ name: 'title', text: 'Slow' }] } });
  assert.equal(slow.status, 408, await slow.clone().text());
  assert.ok(Date.now() - started >= 9_500, 'it waited for the documented limit');
  const body = await slow.json() as { uid: string; status: string };
  assert.equal(body.status, 'pending');
  const done = await h.poll(`/compat/bannerbear/v5/images/${body.uid}`, finished);
  assert.equal(done.status, 'completed');
});

test('sync hosts answer with the finished object', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const v5 = await h.call('/compat/bannerbear/sync/v5/images', 'POST', { template: 'bbfive', modifications: { objects: [{ name: 'title', text: 'Sync' }] } });
  assert.equal(v5.status, 200, await v5.clone().text());
  assert.equal((await v5.json() as { status: string }).status, 'completed');
  const v2 = await h.call('/compat/bannerbear/sync/v2/images', 'POST', { template: 'bbtwo', modifications: [{ name: 'title', text: 'Sync' }] });
  assert.equal(v2.status, 200);
  assert.match(String((await v2.json() as { image_url: string }).image_url), /\/compat\/files\//);
});

test('result URLs: an expired or altered one is refused, and deleting the record revokes it', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const created = await (await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Revoke me' } }, create_now: true })).json() as { id: number; image_url: string; lolly: { id: string } };
  const url = h.local(created.image_url);
  assert.equal((await fetch(url)).status, 200);
  const parts = new URL(url).pathname.split('/');
  const tampered = [...parts]; tampered[5] = 'A'.repeat(parts[5]!.length);
  assert.equal((await fetch(`${h.base}${tampered.join('/')}`)).status, 404, 'an altered signature');
  const moved = [...parts]; moved[4] = String(Number(parts[4]) + 1000);
  assert.equal((await fetch(`${h.base}${moved.join('/')}`)).status, 404, 'an altered expiry');
  const wrongFormat = [...parts]; wrongFormat[6] = 'image.png';
  assert.equal((await fetch(`${h.base}${wrongFormat.join('/')}`)).status, 404, 'another format');
  const removed = await h.call(`/compat/placid/api/rest/images/${created.id}`, 'DELETE');
  assert.equal(removed.status, 204);
  assert.equal((await fetch(url)).status, 404, 'deleting the record revokes the URL');
  assert.equal((await h.call(`/compat/placid/api/rest/images/${created.id}`)).status, 404);
  const other = await (await h.call('/compat/bannerbear/sync/v5/images', 'POST', { template: 'bbfive' })).json() as { files: { svg: string }; lolly: { id: string } };
  assert.equal((await h.call(`/compat/requests/${other.lolly.id}`, 'DELETE', undefined, { authorization: `Bearer ${h.otherSecret}` })).status, 404, 'another token may not');
  assert.equal((await h.call(`/compat/requests/${other.lolly.id}`, 'DELETE', undefined, {})).status, 401);
  const login = await fetch(`${h.base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  const cookie = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  assert.equal((await h.call(`/compat/requests/${other.lolly.id}`, 'DELETE', undefined, { cookie })).status, 204, 'an admin may, after a token is gone');
  assert.equal((await fetch(h.local(other.files.svg))).status, 404);
  const signer = prepareRenderApi(checkRenderApiConfig({ enabled: true, templates: [], resultUrls: { signedDays: 30 }, urlApi: {} }), { renderApiUrls: 'url-secret' }, h.store, 'https://work.test').signer!;
  const expiredAt = Date.now() - 1000;
  const fresh = await (await h.call('/compat/bannerbear/sync/v5/images', 'POST', { template: 'bbfive' })).json() as { lolly: { id: string } };
  const expired = signer.verify(fresh.lolly.id, 'svg', String(expiredAt), 'x');
  assert.equal(expired, 'invalid');
  const good = signer.url('https://work.test', fresh.lolly.id, 'svg', new Date(Date.now() - 86_400_000).toISOString(), undefined);
  const [, , , , , , goodExpiry, goodSig] = good.split('/');
  assert.equal(signer.verify(fresh.lolly.id, 'svg', goodExpiry!, goodSig!, Number(goodExpiry) + 1), 'expired');
});

test('signedDays 0 keeps result URLs behind the token that made them', async (t) => {
  const h = await harness({ signedDays: 0 }); t.after(() => h.close());
  const created = await (await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Private' } }, create_now: true })).json() as { image_url: string };
  assert.match(created.image_url, /\/compat\/files\/[^/]+\/image\.svg$/);
  const path = new URL(created.image_url).pathname;
  assert.equal((await h.call(path, 'GET', undefined, {})).status, 401);
  assert.equal((await h.call(path, 'GET', undefined, { authorization: `Bearer ${h.otherSecret}` })).status, 404);
  const mine = await h.call(path);
  assert.equal(mine.status, 200);
  assert.match(await mine.text(), /Private/);
});

test('Placid URL API: old signatures verify, unsigned needs a choice, and the same URL is one render', async (t) => {
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  const query = 'title[text]=Hello%20friend';
  const signed = `${query}&s=${createHmac('sha256', PRIVATE_TOKEN).update(`&${query}`).digest('hex')}`;
  const first = await fetch(`${h.base}/compat/placid/u/plc?${signed}`);
  assert.equal(first.status, 200, await first.clone().text());
  assert.match(await first.text(), /Hello friend/);
  assert.equal((await fetch(`${h.base}/compat/placid/u/plc?${signed}`)).status, 200);
  assert.equal((await h.store.listRenders('service:svc_ci', 10, 0)).length, 1, 'generated on first request');
  assert.equal((await fetch(`${h.base}/compat/placid/u/plc?${query}`)).status, 403, 'unsigned, and this template did not allow it');
  assert.equal((await fetch(`${h.base}/compat/placid/u/plc?${query}&s=${'0'.repeat(64)}`)).status, 403, 'a bad signature');
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?${query}`)).status, 200, 'this template allows unsigned URLs');
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?${query}&s=${'0'.repeat(64)}`)).status, 403, 'a signature that is present must still verify');
  assert.equal((await fetch(`${h.base}/compat/placid/u/none?${query}`)).status, 404);
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?other[text]=x`)).status, 422, 'an unmapped layer');
});

test('Placid URL API needs a token to act as, and stops when that token is revoked', async (t) => {
  const unset = await harness(); t.after(() => unset.close());
  assert.equal((await fetch(`${unset.base}/compat/placid/u/open?title[text]=x`)).status, 503);
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  await h.store.revokeApiToken('ci', new Date().toISOString());
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?title[text]=x`)).status, 403);
});

const DAY_MS = 86_400_000;
const urlRenders = async (h: Awaited<ReturnType<typeof harness>>) => h.store.listRenders('service:svc_ci', 100, 0);

test('Placid URL API: one URL keeps working across repeated retention expiries, one render each time', async (t) => {
  const start = Date.parse('2026-11-02T06:00:00.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: start });
  const h = await harness({ actAs: 'ci', retentionDays: 1 }); t.after(() => h.close());
  const url = `${h.base}/compat/placid/u/open?title[text]=Cycle`;
  const sweep = (at: number) => sweepRenderOutputs({ store: h.store, blobs: h.blobs, days: 1, now: () => new Date(at), graceMs: 0 });

  const first = await fetch(url);
  assert.equal(first.status, 200, await first.clone().text());
  assert.match(await first.text(), /Cycle/);
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await urlRenders(h)).length, 1, 'the same URL is one render');

  for (let cycle = 1; cycle <= 3; cycle++) {
    const at = start + cycle * 2 * DAY_MS;
    t.mock.timers.setTime(at);
    const swept = await sweep(at);
    assert.ok(swept.expired >= 1, `cycle ${cycle}: retention expired the earlier output`);
    const after = await fetch(url);
    assert.equal(after.status, 200, `cycle ${cycle}: ${await after.clone().text()}`);
    assert.match(await after.text(), /Cycle/);
    assert.equal((await fetch(url)).status, 200, `cycle ${cycle}: and again`);
    assert.equal((await urlRenders(h)).length, cycle + 1, `cycle ${cycle}: one new render, not one per request`);
    // A later pass removes the bytes of what the first pass marked, and the URL does not notice.
    await sweep(at + 1000);
    assert.equal((await fetch(url)).status, 200, `cycle ${cycle}: after the bytes went`);
  }
  assert.equal((await urlRenders(h)).filter((render) => !render.output?.expiredAt).length, 1, 'only the newest output is still kept');
});

test('Placid URL API: a lost output costs one fresh render, with or without retention', async (t) => {
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  const url = `${h.base}/compat/placid/u/open?title[text]=Lost`;
  assert.equal((await fetch(url)).status, 200);
  const newest = async () => (await urlRenders(h)).find((render) => !render.output?.expiredAt)!;
  for (let round = 1; round <= 2; round++) {
    await h.store.expireRenderOutputs(new Date(Date.now() + DAY_MS).toISOString(), new Date().toISOString(), 100);
    assert.equal((await fetch(url)).status, 200, `expiry round ${round}`);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await urlRenders(h)).length, 1 + round, 'requests after the first reuse the fresh render');
  }
  const gone = await newest();
  await h.blobs.delete(gone.output!.ref);
  assert.equal((await fetch(url)).status, 200, 'bytes lost with no mark on the record');
  assert.equal((await fetch(url)).status, 200);
  assert.equal((await urlRenders(h)).length, 4);
});

test('Placid URL API: a failure stands for a window, a long outage never ends the URL, and recovery settles', async (t) => {
  let at = Date.parse('2026-11-02T06:00:30.000Z');
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const h = await harness({ actAs: 'ci', autoRun: false }); t.after(() => h.close());
  const claimOne = async () => {
    for (let i = 0; i < 400; i++) {
      const claimed = await h.store.claimRender(10_000);
      if (claimed) return claimed;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
    assert.fail('nothing to claim');
  };
  const fail = async () => { const claimed = await claimOne(); await h.store.settleRender(claimed.id, claimed.leaseToken!, { state: 'failed', error: { code: 'WORKER_DOWN', message: 'the worker is down' } }); };
  const url = `${h.base}/compat/placid/u/open?title[text]=Flaky`;
  const firstTry = fetch(url);
  await fail();
  const refused = await firstTry;
  assert.equal(refused.status, 502, await refused.clone().text());
  assert.equal((await urlRenders(h)).length, 1);
  assert.equal((await fetch(url)).status, 502, 'inside the window a failure answers at once');
  assert.equal((await urlRenders(h)).length, 1, 'and starts no more work');
  // More failed windows than one request may step past, because the pointer moves with them.
  const OUTAGE = 20;
  for (let window = 1; window <= OUTAGE; window++) {
    at += 61_000; t.mock.timers.setTime(at);
    const attempt = fetch(url);
    await fail();
    assert.equal((await attempt).status, 502, `window ${window}`);
    assert.equal((await urlRenders(h)).length, window + 1, `window ${window}: one attempt`);
  }
  at += 61_000; t.mock.timers.setTime(at);
  const later = fetch(url);
  for (let i = 0; i < 400 && (await urlRenders(h)).length < OUTAGE + 2; i++) await new Promise((resolve) => setTimeout(resolve, 5));
  await h.tick();
  const recovered = await later;
  assert.equal(recovered.status, 200, await recovered.clone().text());
  assert.match(await recovered.text(), /Flaky/);
  // Recovered: later windows reuse this render rather than going back through the failures.
  for (const minutes of [2, 30]) {
    at += minutes * 60_000; t.mock.timers.setTime(at);
    assert.equal((await fetch(url)).status, 200);
    assert.equal((await urlRenders(h)).length, OUTAGE + 2, 'no new render once the URL has recovered');
  }
});

test('Placid URL API: its pointer row is not a Placid image', async (t) => {
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?title[text]=Row`)).status, 200);
  const [row] = await h.store.listRenderApiRecords('service:svc_ci', 'placid', 10, 0);
  assert.equal(row!.echo.urlApi, true);
  assert.equal((await h.call(`/compat/placid/api/rest/images/${row!.seq}`)).status, 404);
  assert.equal((await h.call(`/compat/placid/api/rest/images/${row!.seq}`, 'DELETE')).status, 404);
  assert.equal((await h.call(`/compat/requests/${row!.id}`, 'DELETE')).status, 204, 'the owner or an admin can still remove it');
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?title[text]=Row`)).status, 200, 'and the URL recovers its render');
  assert.equal((await urlRenders(h)).length, 1);
});

test('Placid URL API: a client key cannot claim a URL row, so a token cannot put another image behind a public URL', async (t) => {
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  const refused = await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Other' } } }, { authorization: `Bearer ${h.secret}`, 'idempotency-key': 'placid-url:anything' });
  assert.equal(refused.status, 400, await refused.clone().text());
  assert.equal((await h.store.listRenderApiRecords('service:svc_ci', 'placid', 10, 0)).length, 0);
});

test('URL renders run at default priority, and only token holders can ask for an immediate render', async (t) => {
  const h = await harness({ actAs: 'ci' }); t.after(() => h.close());
  assert.equal((await fetch(`${h.base}/compat/placid/u/open?title[text]=Anyone`)).status, 200);
  assert.equal((await urlRenders(h))[0]!.request.priority, 0, 'an unsigned URL cannot jump the queue');
  const made = await (await h.call('/compat/placid/api/rest/images', 'POST', { template_uuid: 'plc', layers: { title: { text: 'Now' } }, create_now: true })).json() as { lolly: { renders: { svg: string } } };
  assert.equal((await h.store.getRender(made.lolly.renders.svg, 'service:svc_ci'))!.request.priority, 9);
});

test('an idempotent replay after expiry returns the stored record, and a new request makes a fresh render', async (t) => {
  const h = await harness({ retentionDays: 1 }); t.after(() => h.close());
  const headers = { authorization: `Bearer ${h.secret}`, 'idempotency-key': 'keep' };
  const body = { template: 'bbfive' };
  const first = await (await h.call('/compat/bannerbear/sync/v5/images', 'POST', body, headers)).json() as { uid: string; files: { svg: string } };
  assert.equal((await fetch(h.local(first.files.svg))).status, 200);
  const expired = await h.store.expireRenderOutputs(new Date(Date.now() + DAY_MS).toISOString(), new Date().toISOString(), 100);
  assert.equal(expired.length, 1);
  assert.equal((await fetch(h.local(first.files.svg))).status, 410, 'a result URL names one output, and retention ended it');
  const polled = await (await h.call(`/compat/bannerbear/v5/images/${first.uid}`)).json() as { status: string; files: { svg: string | null } };
  assert.equal(polled.status, 'completed'); assert.equal(polled.files.svg, null, 'a poll says plainly that no file remains');
  const replay = await (await h.call('/compat/bannerbear/sync/v5/images', 'POST', body, headers)).json() as { uid: string; files: { svg: string | null } };
  assert.equal(replay.uid, first.uid, 'a client-chosen key keeps its meaning: same request, same record');
  assert.equal(replay.files.svg, null);
  const fresh = await (await h.call('/compat/bannerbear/sync/v5/images', 'POST', body)).json() as { uid: string; files: { svg: string } };
  assert.notEqual(fresh.uid, first.uid);
  assert.equal((await fetch(h.local(fresh.files.svg))).status, 200, 'a request with no key is new work');
});

test('other vendor routes answer 501 with the reason', async (t) => {
  const h = await harness(); t.after(() => h.close());
  for (const path of ['/compat/bannerbear/v5/webhooks', '/compat/bannerbear/v5/webhooks/abc', '/compat/bannerbear/v5/animations', '/compat/bannerbear/v5/image_templates', '/compat/bannerbear/v2/collections', '/compat/bannerbear/v2/screenshots', '/compat/placid/api/rest/pdfs', '/compat/placid/api/rest/videos', '/compat/placid/api/rest/templates']) {
    const res = await h.call(path, 'POST', {});
    assert.equal(res.status, 501, path);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'NOT_SUPPORTED_BY_MIGRATION_API');
  }
  const hook = await (await h.call('/compat/bannerbear/v5/webhooks', 'POST', {})).json() as { error: { message: string } };
  assert.match(hook.error.message, /callbackUrl on \/api\/v1\/renders/);
});

test('idempotency returns the original record, and a public request cannot set the migration link', async (t) => {
  const h = await harness(); t.after(() => h.close());
  const headers = { authorization: `Bearer ${h.secret}`, 'idempotency-key': 'one' };
  const first = await (await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive' }, headers)).json() as { uid: string };
  const second = await (await h.call('/compat/bannerbear/v5/images', 'POST', { template: 'bbfive' }, headers)).json() as { uid: string };
  assert.equal(second.uid, first.uid);
  const smuggled = await h.call('/api/v1/renders', 'POST', { toolId: 'card', format: 'svg', inputs: {}, compat: { source: 'placid', requestId: first.uid } });
  assert.equal(smuggled.status, 400, 'compat is only set by this module');
});
