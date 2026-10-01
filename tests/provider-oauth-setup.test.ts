// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { openSecret } from '../server/src/lib/crypto.ts';
import { credentialContext } from '../server/src/catalog/federation.ts';
import { GDRIVE_SETUP, validateGuidedProvider } from '../server/src/catalog/providers/setup.ts';
import { providerOAuthInfo, PROVIDER_OAUTH_LIMITS } from '../server/src/catalog/providers/setup-oauth.ts';
import { SETUP_PREVIEW_LIMITS } from '../server/src/catalog/providers/setup-preview.ts';

const CLIENT = { clientId: '123-fixture.apps.googleusercontent.com', clientSecret: 'client-secret-fixture' };
const SCOPE = 'https://www.googleapis.com/auth/drive.readonly';
const MASTER = 'credential-master-fixture'.repeat(2);
const SVG = '<svg xmlns="http://www.w3.org/2000/svg"></svg>';
const settings = { id: 'brand-drive', kind: 'gdrive', label: 'Brand Drive', setupVersion: 1, options: { folderId: 'FOLDER1' }, exposure: { groups: ['Legal, EMEA', 'design'] }, mapping: { defaultType: 'image' } };
const json = (doc: unknown, status = 200) => new Response(JSON.stringify(doc), { status, headers: { 'content-type': 'application/json' } });

async function fixture(options: { sealing?: boolean; baseUrl?: string } = {}) {
  const store = createMemoryStore(), calls: { url: string; init?: RequestInit }[] = [], codes = new Set<string>();
  let override: ((url: string, init?: RequestInit) => Promise<Response | undefined>) | undefined;
  const fetchImpl = (async (input, init) => {
    const url = String(input); calls.push({ url, init });
    const overridden = await override?.(url, init); if (overridden) return overridden;
    if (url === 'https://oauth2.googleapis.com/token') {
      const body = new URLSearchParams(String(init?.body));
      if (body.get('grant_type') === 'refresh_token') return json({ access_token: 'access-fixture', expires_in: 3600 });
      const code = body.get('code')!;
      if (codes.has(code)) return json({ error: 'invalid_grant' }, 400);
      codes.add(code);
      return json({ access_token: 'access-fixture', refresh_token: `refresh-fixture-${code}`, scope: SCOPE });
    }
    const target = new URL(url);
    assert.equal(target.origin, 'https://www.googleapis.com');
    if (target.pathname.endsWith('/about')) return json({ user: {} });
    if (target.pathname.endsWith('/files/FOLDER1')) return json({ id: 'FOLDER1', mimeType: 'application/vnd.google-apps.folder' });
    if (target.searchParams.get('alt') === 'media') return new Response(SVG, { headers: { 'content-type': 'image/svg+xml', 'content-length': String(Buffer.byteLength(SVG)) } });
    assert.equal(target.pathname, '/drive/v3/files');
    assert.equal(target.searchParams.get('supportsAllDrives'), 'true'); assert.equal(target.searchParams.get('includeItemsFromAllDrives'), 'true');
    return json({ files: [{ id: 'LOGO1', name: 'logo.svg', mimeType: 'image/svg+xml', size: String(Buffer.byteLength(SVG)) }, { id: 'DOC1', name: 'Notes', mimeType: 'application/vnd.google-apps.document' }, { id: 'SUB1', name: 'Sub', mimeType: 'application/vnd.google-apps.folder' }] });
  }) as typeof fetch;
  let app: ReturnType<typeof buildApp>;
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  const config = parseConfig(JSON.stringify({ instance: { baseUrl: options.baseUrl ?? base }, dev: { enabled: true, users: [
    { email: 'owner@test', groups: ['owner'] }, { email: 'other@test', groups: ['owner'] }, { email: 'admin@test', groups: ['admin'] }, { email: 'member@test', groups: ['member'] },
  ] } }));
  app = buildApp({ config, store, secrets: { session: 'session-fixture', link: 'link-fixture', ...(options.sealing === false ? {} : { credential: MASTER }) }, fetchImpl });
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!;
  const owner = await login('owner@test'), other = await login('other@test'), admin = await login('admin@test'), member = await login('member@test');
  const request = (path: string, body?: unknown, cookie = owner, method = body === undefined ? 'GET' : 'POST') => fetch(`${base}${path}`, { method, redirect: 'manual', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  const create = async () => { const response = await request('/api/v1/catalog/providers', settings); assert.equal(response.status, 201); };
  const start = async () => {
    const response = await request('/api/v1/catalog/providers/brand-drive/oauth/start', CLIENT); assert.equal(response.status, 200);
    const url = new URL((await response.json() as any).authorizeUrl), cookie = response.headers.getSetCookie()[0]!;
    return { url, cookie: cookie.split(';')[0]!, rawCookie: cookie };
  };
  const callback = (flow: Awaited<ReturnType<typeof start>>, query = 'code=ok', user = owner) => request(`/api/auth/provider-oauth/callback?state=${flow.url.searchParams.get('state')}&${query}`, undefined, `${user}; ${flow.cookie}`);
  const close = async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); };
  return { store, base, calls, request, create, start, callback, close, owner, other, admin, member, override(fn: typeof override) { override = fn; } };
}

test('Google guided contract validates the curated subset and public callback URL', () => {
  assert.equal(GDRIVE_SETUP.authKind, 'oauth'); assert.equal(validateGuidedProvider(settings as any), null);
  for (const folderId of ['', 'https://drive.google.com/drive/folders/x', '../x', 'x?alt=media']) assert.match(validateGuidedProvider({ ...settings, options: { folderId } } as any)!, /Folder id/);
  assert.match(validateGuidedProvider({ ...settings, exposure: { requireApproved: true } } as any)!, /unsupported exposure/);
  assert.equal(providerOAuthInfo('http://public.test').available, false);
  assert.equal(providerOAuthInfo('https://user:secret@public.test').available, false);
  assert.equal(providerOAuthInfo('https://work.test').redirectUri, 'https://work.test/api/auth/provider-oauth/callback');
});

test('owner browser consent uses encrypted session-bound state and PKCE; seals only after folder and scope checks', async t => {
  const f = await fixture(); t.after(f.close); await f.create();
  const flow = await f.start();
  assert.equal(flow.url.origin, 'https://accounts.google.com'); assert.equal(flow.url.searchParams.get('redirect_uri'), `${f.base}/api/auth/provider-oauth/callback`);
  assert.equal(flow.url.searchParams.get('scope'), SCOPE); assert.equal(flow.url.searchParams.get('access_type'), 'offline'); assert.equal(flow.url.searchParams.get('prompt'), 'consent');
  assert.match(flow.rawCookie, /HttpOnly; SameSite=Lax; Max-Age=600/);
  assert.ok(!flow.url.href.includes(CLIENT.clientSecret)); assert.ok(!Buffer.from(flow.cookie.split('=')[1]!, 'base64url').toString().includes(CLIENT.clientSecret));
  const response = await f.callback(flow);
  assert.equal(response.status, 303); assert.match(response.headers.get('location')!, /oauth=connected.*setup=brand-drive/);
  assert.equal(response.headers.get('referrer-policy'), 'no-referrer'); assert.match(response.headers.getSetCookie()[0]!, /Max-Age=0/);
  const exchange = f.calls.find(call => call.url === 'https://oauth2.googleapis.com/token')!, body = new URLSearchParams(String(exchange.init?.body));
  assert.equal(body.get('client_secret'), CLIENT.clientSecret); assert.equal(body.get('redirect_uri'), flow.url.searchParams.get('redirect_uri'));
  assert.equal(createHash('sha256').update(body.get('code_verifier')!).digest('base64url'), flow.url.searchParams.get('code_challenge'));
  assert.equal(exchange.init?.redirect, 'error');
  const rec = (await f.store.getProvider('brand-drive'))!;
  assert.equal(rec.enabled, false); assert.ok(rec.credentialCiphertext);
  assert.deepEqual(JSON.parse(openSecret(rec.credentialCiphertext!, MASTER, credentialContext(rec.id))), { ...CLIENT, refreshToken: 'refresh-fixture-ok' });
  const wire = await (await f.request('/api/v1/catalog/providers/brand-drive')).text();
  assert.ok(!wire.includes(CLIENT.clientSecret)); assert.ok(!wire.includes('refresh-fixture')); assert.ok(!JSON.stringify(await f.store.listAudit()).includes(CLIENT.clientSecret));
  const replay = await f.callback(flow); assert.ok(!replay.headers.get('location')!.includes('connected'));
});

test('consent rejects admin/member access, invalid clients, cross-site initiation and unavailable sealing', async t => {
  const f = await fixture(); t.after(f.close); await f.create();
  for (const cookie of [f.admin, f.member]) assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/oauth/start', CLIENT, cookie)).status, 403);
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/oauth/start', { ...CLIENT, clientId: 'other-host' })).status, 400);
  assert.equal((await fetch(`${f.base}/api/v1/catalog/providers/brand-drive/oauth/start`, { method: 'POST', headers: { cookie: f.owner, origin: 'https://evil.test', 'content-type': 'application/json' }, body: JSON.stringify(CLIENT) })).status, 403);
  const missing = await fixture({ sealing: false }); t.after(missing.close); await missing.create();
  assert.equal((await missing.request('/api/v1/catalog/providers/brand-drive/oauth/start', CLIENT)).status, 409);
  assert.equal(f.calls.length, 0);
});

test('state mismatch, tampering, foreign owner and revoked authority never reach Google', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); const flow = await f.start();
  const bad = await f.request('/api/auth/provider-oauth/callback?state=wrong&code=ok', undefined, `${f.owner}; ${flow.cookie}`);
  assert.match(bad.headers.get('location')!, /oauth=failed/);
  assert.match((await f.request('/api/auth/provider-oauth/callback?code=ok', undefined, `${f.owner}; lw_provider_oauth=tampered`)).headers.get('location')!, /failed/);
  assert.match((await f.callback(flow, 'code=ok', f.other)).headers.get('location')!, /failed/);
  const user = (await f.request('/api/auth/session').then(response => response.json()) as any).user;
  await f.store.setUserDisabled((await f.store.getUserBySub(user.sub))!.id, new Date().toISOString());
  assert.match((await f.callback(flow)).headers.get('location')!, /failed/); assert.equal(f.calls.length, 0);
});

test('expired consent and changed or enabled configuration retain the previous credential', async t => {
  const f = await fixture(); t.after(f.close); await f.create();
  const ttl = PROVIDER_OAUTH_LIMITS.ttlMs;
  try {
    PROVIDER_OAUTH_LIMITS.ttlMs = -1;
    assert.match((await f.callback(await f.start())).headers.get('location')!, /oauth=expired/);
  } finally { PROVIDER_OAUTH_LIMITS.ttlMs = ttl; }
  const flow = await f.start(), rec = (await f.store.getProvider('brand-drive'))!;
  await f.store.putProvider({ ...rec, options: { folderId: 'CHANGED' } });
  assert.match((await f.callback(flow)).headers.get('location')!, /oauth=changed/);
  await f.store.putProvider({ ...rec, enabled: true });
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/oauth/start', CLIENT)).status, 409); assert.equal(f.calls.length, 0);
});

test('denied, partial-scope, missing-refresh and failed token exchanges do not overwrite an existing grant', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); await f.callback(await f.start(), 'code=original');
  const before = (await f.store.getProvider('brand-drive'))!.credentialFingerprint;
  assert.match((await f.callback(await f.start(), 'error=access_denied&error_description=SECRET')).headers.get('location')!, /oauth=denied/);
  for (const response of [{ access_token: 'access', scope: SCOPE }, { access_token: 'access', refresh_token: 'refresh', scope: 'openid' }, { error: 'invalid_grant', error_description: CLIENT.clientSecret }]) {
    f.override(async url => url === 'https://oauth2.googleapis.com/token' ? json(response) : undefined);
    const result = await f.callback(await f.start());
    assert.match(result.headers.get('location')!, /oauth=failed/); assert.ok(!result.headers.get('location')!.includes(CLIENT.clientSecret));
    assert.equal((await f.store.getProvider('brand-drive'))!.credentialFingerprint, before);
  }
});

test('callback rechecks current permission and settings after the external exchange', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); const flow = await f.start();
  f.override(async url => {
    if (url.includes('/files/FOLDER1')) {
      const rec = (await f.store.getProvider('brand-drive'))!; await f.store.putProvider({ ...rec, exposure: { groups: ['other'] } });
    }
    return undefined;
  });
  assert.match((await f.callback(flow)).headers.get('location')!, /oauth=changed/); assert.equal((await f.store.getProvider('brand-drive'))!.credentialFingerprint, undefined);
});

test('a deny added during Google exchange blocks credential storage', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); const flow = await f.start();
  const member = (await f.request('/api/auth/session').then(response => response.json()) as any).user;
  const owner = (await f.store.getUserBySub(member.sub))!;
  f.override(async url => {
    if (url.includes('/files/FOLDER1')) await f.store.putGrant({ principal: `user:${owner.id}`, action: 'catalog.provider.credential', resource: '*', effect: 'deny' });
    return undefined;
  });
  assert.match((await f.callback(flow)).headers.get('location')!, /oauth=changed/);
  assert.equal((await f.store.getProvider('brand-drive'))!.credentialFingerprint, undefined);
});

test('revoked sessions cannot finish pending consent with either the old or a new login', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); const flow = await f.start();
  const member = (await f.request('/api/auth/session').then(response => response.json()) as any).user;
  await f.store.bumpSessionEpoch((await f.store.getUserBySub(member.sub))!.id);
  assert.match((await f.callback(flow)).headers.get('location')!, /oauth=failed/);
  const fresh = (await fetch(`${f.base}/api/auth/dev?email=owner@test`, { redirect: 'manual' })).headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!;
  assert.match((await f.callback(flow, 'code=ok', fresh)).headers.get('location')!, /oauth=failed/);
  assert.equal(f.calls.length, 0);
});

test('bounded token responses and stalled exchanges fail without writing a credential', async t => {
  const f = await fixture(); t.after(f.close); await f.create();
  let canceled = false;
  f.override(async url => url === 'https://oauth2.googleapis.com/token' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(65537)); }, cancel() { canceled = true; } })) : undefined);
  assert.match((await f.callback(await f.start())).headers.get('location')!, /failed/); assert.equal(canceled, true);
  const timeout = PROVIDER_OAUTH_LIMITS.timeoutMs;
  try {
    PROVIDER_OAUTH_LIMITS.timeoutMs = 30;
    f.override(async url => url === 'https://oauth2.googleapis.com/token' ? new Promise<Response>(() => {}) : undefined);
    assert.match((await f.callback(await f.start())).headers.get('location')!, /failed/);
  } finally { PROVIDER_OAUTH_LIMITS.timeoutMs = timeout; }
  assert.equal((await f.store.getProvider('brand-drive'))!.credentialFingerprint, undefined);
});

test('saved-source preview reads a bounded original, reports skips and guards enable against configuration drift', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); await f.callback(await f.start());
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/setup-preview', {}, f.member)).status, 403);
  const result = await (await f.request('/api/v1/catalog/providers/brand-drive/setup-preview', {})).json() as any;
  assert.equal(result.original.ok, true); assert.equal(result.original.sha256, createHash('sha256').update(SVG).digest('hex')); assert.equal(result.skipped, 2); assert.equal(result.sampleTotal, 1);
  assert.ok(result.notes[0].includes('native Google')); assert.equal((await f.store.getProvider('brand-drive'))!.state.assetCount, 0);
  assert.ok(!JSON.stringify(result).includes('refresh-fixture')); assert.ok(!JSON.stringify(result).includes(CLIENT.clientSecret));
  await f.request('/api/v1/catalog/providers/brand-drive', { setupVersion: 1, options: { folderId: 'FOLDER2' } }, f.owner, 'PUT');
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/enable', { setupRevision: result.revision })).status, 409);
  assert.equal((await f.store.getProvider('brand-drive'))!.enabled, false);
  await f.request('/api/v1/catalog/providers/brand-drive', { setupVersion: 1, options: settings.options }, f.owner, 'PUT');
  await f.request('/api/v1/catalog/providers/brand-drive/sync', {});
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/enable', { setupRevision: result.revision })).status, 200);
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive', { setupVersion: 1, options: settings.options }, f.owner, 'PUT')).status, 409);
});

test('Drive preview caps JSON listings and does not accept partial originals', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); await f.callback(await f.start());
  let canceled = false;
  f.override(async url => new URL(url).pathname === '/drive/v3/files' ? new Response(new ReadableStream({ start(controller) { controller.enqueue(new Uint8Array(SETUP_PREVIEW_LIMITS.listingBytes + 1)); }, cancel() { canceled = true; } }), { headers: { 'content-type': 'application/json' } }) : undefined);
  const over = await (await f.request('/api/v1/catalog/providers/brand-drive/setup-preview', {})).json() as any;
  assert.match(over.sampleError, /2 MiB/); assert.equal(canceled, true);
  f.override(async url => new URL(url).searchParams.get('alt') === 'media' ? new Response(SVG, { status: 206 }) : undefined);
  const partial = await (await f.request('/api/v1/catalog/providers/brand-drive/setup-preview', {})).json() as any;
  assert.equal(partial.original.ok, false); assert.match(partial.original.detail, /partial original/);
});

test('guarded activation rechecks permission after its health request', async t => {
  const f = await fixture(); t.after(f.close); await f.create(); await f.callback(await f.start());
  const result = await (await f.request('/api/v1/catalog/providers/brand-drive/setup-preview', {})).json() as any;
  const member = (await f.request('/api/auth/session').then(response => response.json()) as any).user;
  const owner = (await f.store.getUserBySub(member.sub))!;
  f.override(async url => {
    if (url.includes('/about')) await f.store.putGrant({ principal: `user:${owner.id}`, action: 'catalog.provider.credential', resource: '*', effect: 'deny' });
    return undefined;
  });
  assert.equal((await f.request('/api/v1/catalog/providers/brand-drive/enable', { setupRevision: result.revision })).status, 403);
  assert.equal((await f.store.getProvider('brand-drive'))!.enabled, false);
});
