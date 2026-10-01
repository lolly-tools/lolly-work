// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createHash } from 'node:crypto';
import { WEBDAV_SETUP, validateGuidedProvider } from '../server/src/catalog/providers/setup.ts';
import { previewGuidedProvider, SETUP_PREVIEW_LIMITS } from '../server/src/catalog/providers/setup-preview.ts';
import { createProvider } from '../server/src/catalog/providers/registry.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';

const secret = 'reader:fixture-app-password';
const bytes = '<svg/>';
const entry = (href: string, directory = false, extra = '', size = bytes.length) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype>${directory ? '<d:collection/>' : ''}</d:resourcetype><d:getcontentlength>${size}</d:getcontentlength><d:getcontenttype>image/svg+xml</d:getcontenttype>${extra}</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const xml = (...entries: string[]) => `<d:multistatus xmlns:d="DAV:">${entries.join('')}</d:multistatus>`;
const record = (changes: Partial<ProviderRecord> = {}): ProviderRecord => ({ id: 'preview', kind: 'webdav', label: 'Brand', managedBy: 'db', enabled: false,
  options: { baseUrl: 'https://dav.test', root: 'Brand', minGapMs: 0 }, mapping: {}, exposure: {}, sync: {}, state: { assetCount: 0 }, createdAt: '', updatedAt: '', ...changes });
const fixture = (listing = xml(entry('/Brand/', true), entry('/Brand/logo.svg')), getStatus = 200) => {
  const calls: Array<{ method: string; url: string; init: RequestInit }> = [];
  const fetchImpl = (async (input: any, init: RequestInit) => {
    calls.push({ method: init.method!, url: String(input), init });
    if (init.method === 'GET') return new Response(bytes, { status: getStatus, headers: { 'content-type': 'image/svg+xml' } });
    return new Response(listing, { status: 207 });
  }) as typeof fetch;
  return { calls, fetchImpl };
};

test('guided descriptor covers the WebDAV driver options and declares the same auth contract', () => {
  const names = WEBDAV_SETUP.fields.filter(field => field.path.startsWith('options.')).map(field => field.path.slice(8));
  assert.deepEqual(names.sort(), ['baseUrl', 'flavor', 'username', 'root', 'recursive', 'minGapMs'].sort());
  assert.equal(WEBDAV_SETUP.authKind, createProvider(record(), undefined).capabilities.authKind);
  assert.equal(validateGuidedProvider(record()), null);
  for (const change of [{ baseUrl: 'https://user:password@dav.test' }, { baseUrl: 'http://remote.test' }, { baseUrl: 'https://dav.test/?token=secret' }, { baseUrl: 'https://dav.test/#password' }, { flavor: 'invented' }, { recursive: 'yes' }, { root: '../private' }, { minGapMs: -1 }, { password: 'oops' }]) {
    assert.ok(validateGuidedProvider(record({ options: { ...record().options, ...change } })), JSON.stringify(change));
  }
  assert.equal(validateGuidedProvider(record({ options: { baseUrl: 'http://127.0.0.1:1234' }, exposure: { groups: ['Legal, EMEA'] } })), null);
  assert.ok(validateGuidedProvider(record({ exposure: { requireApproved: true } })), 'plain WebDAV has no approval flag in guided setup');
});

test('preview reads and hashes a representative original using only pinned read operations', async () => {
  const f = fixture(), result = await previewGuidedProvider(record(), secret, f.fetchImpl);
  assert.equal(result.health.ok, true); assert.equal(result.sampleTotal, 1); assert.equal(result.original.ok, true);
  assert.equal(result.original.bytes, bytes.length); assert.equal(result.original.sha256, createHash('sha256').update(bytes).digest('hex'));
  assert.deepEqual(f.calls.map(call => call.method), ['PROPFIND', 'PROPFIND', 'GET']);
  assert.ok(f.calls.every(call => new URL(call.url).hostname === 'dav.test' && call.init.redirect === 'manual' && call.init.signal));
  assert.ok(!JSON.stringify(result).includes(secret)); assert.ok(!JSON.stringify(result).includes(bytes));
});

test('excluded and expired files do not supply the representative original', async () => {
  const f = fixture(xml(entry('/Brand/', true), entry('/Brand/excluded.svg'), entry('/Brand/Logos/expired.svg', false, '<expiry>2000-01-01T00:00:00Z</expiry>'), entry('/Brand/Logos/live.svg')));
  const cfg = record({ mapping: { availabilityFields: { until: 'expiry' } }, exposure: { includeSections: ['Logos'] } });
  const result = await previewGuidedProvider(cfg, secret, f.fetchImpl);
  assert.equal(result.unavailable, 1); assert.equal(result.sampleTotal, 1); assert.equal(result.excludedByExposure, 1);
  assert.equal(f.calls.find(call => call.method === 'GET')?.url, 'https://dav.test/Brand/Logos/live.svg');
  assert.ok(result.sample?.every(asset => !String(asset.name).includes('expired')));
  const empty = await previewGuidedProvider(record({ exposure: { includeSections: ['Other folder'] } }), secret, fixture().fetchImpl);
  assert.equal(empty.excludedByExposure, 1); assert.equal(empty.sampleTotal, 0); assert.equal(empty.original.ok, false);
});

test('empty listings and revoked original access cannot become ready', async () => {
  const empty = await previewGuidedProvider(record(), secret, fixture(xml(entry('/Brand/', true))).fetchImpl);
  assert.equal(empty.health.ok, true); assert.equal(empty.original.ok, false); assert.equal(empty.sampleTotal, 0);
  const denied = await previewGuidedProvider(record(), secret, fixture(undefined, 403).fetchImpl);
  assert.equal(denied.health.ok, true); assert.equal(denied.original.ok, false); assert.match(denied.original.detail!, /rejected the credential/);
  const changed = await previewGuidedProvider(record(), secret, fixture(xml(entry('/Brand/', true), entry('/Brand/logo.svg', false, '', 99))).fetchImpl);
  assert.equal(changed.original.ok, false); assert.match(changed.original.detail!, /byte count differs/);
  const partial = await previewGuidedProvider(record(), secret, fixture(undefined, 206).fetchImpl);
  assert.equal(partial.original.ok, false); assert.match(partial.original.detail!, /partial original/);
});

test('recursive preview follows directory cursors and reports its bounded sample', async () => {
  let reads = 0;
  const fetchImpl = (async (input: any, init: RequestInit) => {
    if (init.method === 'GET') return new Response(bytes);
    const path = new URL(String(input)).pathname;
    if ((init.headers as any).depth === '1') reads++;
    return new Response(xml(entry(path, true), entry(`${path}logo.svg`), entry(`${path}Sub/`, true)), { status: 207 });
  }) as typeof fetch;
  const result = await previewGuidedProvider(record({ options: { ...record().options, recursive: true } }), secret, fetchImpl);
  assert.equal(reads, 5); assert.equal(result.pages, 5); assert.equal(result.sampleTotal, 5); assert.equal(result.truncated, true); assert.equal(result.original.ok, true);
});

test('listing and original byte caps fail visibly and cancel the body', async () => {
  const tooLargeListing = await previewGuidedProvider(record(), secret, fixture('x'.repeat(SETUP_PREVIEW_LIMITS.listingBytes + 1)).fetchImpl);
  assert.equal(tooLargeListing.health.ok, false); assert.match(tooLargeListing.health.detail!, /2 MiB/);
  let canceled = false;
  const f = fixture(xml(entry('/Brand/', true), entry('/Brand/logo.svg', false, '', 0)));
  const fetchImpl = (async (input: any, init: RequestInit) => init.method !== 'GET' ? f.fetchImpl(input, init) : new Response(new ReadableStream({
    start(controller) { controller.enqueue(new Uint8Array(SETUP_PREVIEW_LIMITS.originalBytes + 1)); }, cancel() { canceled = true; },
  }))) as typeof fetch;
  const result = await previewGuidedProvider(record(), secret, fetchImpl);
  assert.equal(result.original.ok, false); assert.match(result.original.detail!, /32 MiB/); assert.equal(canceled, true);
});

test('aggregate deadline cancels a stalled original instead of hanging the setup screen', async () => {
  const originalTimeout = SETUP_PREVIEW_LIMITS.timeoutMs;
  SETUP_PREVIEW_LIMITS.timeoutMs = 100;
  let canceled = false;
  const f = fixture();
  try {
    const fetchImpl = (async (input: any, init: RequestInit) => init.method !== 'GET' ? f.fetchImpl(input, init) : new Response(new ReadableStream({ cancel() { canceled = true; } }))) as typeof fetch;
    const result = await previewGuidedProvider(record(), secret, fetchImpl);
    assert.equal(result.original.ok, false); assert.match(result.original.detail!, /timed out/); assert.equal(canceled, true);
  } finally { SETUP_PREVIEW_LIMITS.timeoutMs = originalTimeout; }
});

test('aggregate deadline also bounds the driver rate gap and prevents late requests', async () => {
  const originalTimeout = SETUP_PREVIEW_LIMITS.timeoutMs;
  SETUP_PREVIEW_LIMITS.timeoutMs = 50;
  const f = fixture();
  try {
    const result = await previewGuidedProvider(record({ id: 'rate-deadline', options: { ...record().options, minGapMs: 150 } }), secret, f.fetchImpl);
    assert.equal(result.health.ok, true); assert.match(result.sampleError!, /timed out/);
    await new Promise(resolve => setTimeout(resolve, 160));
    assert.equal(f.calls.length, 1, 'the aborted listing never made an HTTP call after its rate wait');
  } finally { SETUP_PREVIEW_LIMITS.timeoutMs = originalTimeout; }
});

test('guided API enforces access, validates before any fetch and leaves preview state unpersisted', async () => {
  const store = createMemoryStore(), f = fixture();
  const config = parseConfig(JSON.stringify({ instance: { baseUrl: 'http://localhost' }, dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'member@test', groups: ['member'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 's', link: 'l', credential: 'c'.repeat(32) }, fetchImpl: f.fetchImpl });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!;
    const owner = await login('owner@test'), member = await login('member@test');
    assert.equal((await fetch(`${base}/api/v1/catalog/providers/setup`, { headers: { cookie: member } })).status, 403);
    const descriptor = await (await fetch(`${base}/api/v1/catalog/providers/setup`, { headers: { cookie: owner } })).json() as any;
    assert.equal(descriptor.version, 1); assert.equal(descriptor.providers[0].kind, 'webdav');
    const preview = async (body: unknown) => fetch(`${base}/api/v1/catalog/providers/preview`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await preview({ ...record(), setupVersion: 1, options: { baseUrl: 'https://user:secret@dav.test' }, secret })).status, 400); assert.equal(f.calls.length, 0);
    const response = await preview({ ...record(), setupVersion: 1, secret }); assert.equal(response.status, 200); assert.equal((await response.json() as any).original.ok, true);
    assert.deepEqual(await store.listProviders(), []); assert.ok(!JSON.stringify(await store.listAudit()).includes(secret));
    const create = await fetch(`${base}/api/v1/catalog/providers`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ ...record(), setupVersion: 1, id: 'brand' }) });
    assert.equal(create.status, 201); assert.equal((await create.json() as any).enabled, false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
