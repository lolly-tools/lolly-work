/**
 * Catalog providers over real HTTP (plans/17): control-plane CRUD + RBAC
 * split (admin manages, owner holds credentials/kill switch), the write-only
 * seal→verify→swap credential flow, feed federation with exposure governance,
 * ext/* blob serving, lifecycle overlays on federated ids, search with live
 * fan-out, and config-managed read-only records.
 *
 * Own file, own server + pack (the catalog-lifecycle pattern) with the mock
 * driver standing in for a real DAM — no network.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const MOCK_SECRET = 'brandfolder-key-123';

// Two remote assets: a1 passes the exposure slice (approved + Logos section),
// a2 fails it twice over (unapproved, wrong section) and must never federate.
const MOCK_ASSETS = [
  {
    remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: ['event'],
    approved: true, updatedAt: '2026-06-01T00:00:00.000Z',
    formats: [{ format: 'png', remoteRef: 'att1', size: 10 }], hasThumbnail: true,
  },
  {
    remoteId: 'a2', name: 'Internal Summit Doc', nativeType: 'file', sections: ['Docs'], tags: [],
    approved: false, formats: [{ format: 'pdf', remoteRef: 'att2' }],
  },
];

const PROVIDER_BODY = {
  id: 'dam1', kind: 'mock', label: 'Acme DAM',
  options: { assets: MOCK_ASSETS, expectSecret: MOCK_SECRET },
  mapping: { defaultType: 'image' },
  exposure: { groups: ['design'], requireApproved: true, includeSections: ['Logos'], tier: 'reference' },
};

const RAW_INDEX = {
  version: 1,
  assets: [{
    id: 'acme/logo/primary', name: 'Acme Primary Logo', type: 'vector', tags: ['logo'],
    formats: [{ format: 'svg', url: '/catalog/assets/acme/logo/primary.svg', size: 32 }],
  }],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-providers-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme', 'logo'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify(RAW_INDEX));
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo', 'primary.svg'), '<svg/>');

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Providers Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'owner@test', groups: ['owner'] },
        { email: 'admin@test', groups: ['admin'] },
        { email: 'designer@test', groups: ['design'] },
        { email: 'seller@test', groups: ['sales'] },
      ],
    },
    catalogProviders: [
      { id: 'gitops-dam', kind: 'mock', label: 'GitOps DAM', options: { assets: [] } },
    ],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's7', link: 'l7', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const jsonHeaders = (cookie: string) => ({ cookie, 'content-type': 'application/json' });

test('(a) RBAC split: member refused everywhere; admin manages but cannot hold credentials or the kill switch', async () => {
  const designer = await login('designer@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers`, { headers: { cookie: designer } })).status, 403);

  const admin = await login('admin@test');
  const created = await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: jsonHeaders(admin), body: JSON.stringify(PROVIDER_BODY),
  });
  assert.equal(created.status, 201);
  const rec = await created.json() as { enabled: boolean; credential: unknown; managedBy: string };
  assert.equal(rec.enabled, false, 'born disabled');
  assert.equal(rec.credential, null);
  assert.equal(rec.managedBy, 'db');

  // Owner-only surfaces refuse the admin.
  const cred = await fetch(`${base}/api/v1/catalog/providers/dam1/credential`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ secret: MOCK_SECRET }),
  });
  assert.equal(cred.status, 403);
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/enable`, { method: 'POST', headers: { cookie: admin } })).status, 403);
});

test('(b) credential flow: bad key refused by health check (nothing stored), good key sealed with only a fingerprint returned', async () => {
  const owner = await login('owner@test');
  const bad = await fetch(`${base}/api/v1/catalog/providers/dam1/credential`, {
    method: 'PUT', headers: jsonHeaders(owner), body: JSON.stringify({ secret: 'wrong-key-entirely' }),
  });
  assert.equal(bad.status, 409);
  assert.equal((await bad.json() as { error: { code: string } }).error.code, 'PROVIDER_UNHEALTHY');
  const afterBad = await fetch(`${base}/api/v1/catalog/providers/dam1`, { headers: { cookie: owner } });
  assert.equal((await afterBad.json() as { credential: unknown }).credential, null, 'rejected key was not stored');

  const good = await fetch(`${base}/api/v1/catalog/providers/dam1/credential`, {
    method: 'PUT', headers: jsonHeaders(owner), body: JSON.stringify({ secret: MOCK_SECRET }),
  });
  assert.equal(good.status, 200);
  const body = await good.json() as { fingerprint: string; health: { ok: boolean } };
  assert.match(body.fingerprint, /^[0-9a-f]{8}…/);
  assert.equal(body.health.ok, true);
  assert.ok(!JSON.stringify(body).includes(MOCK_SECRET), 'response never carries the secret');

  // No credential material in the wire shape — options are excluded from the
  // assertion because THIS test's mock stores its expected key there (a real
  // driver's options carry ids/urls, never secrets).
  const detail = await (await fetch(`${base}/api/v1/catalog/providers/dam1`, { headers: { cookie: owner } })).json() as Record<string, unknown>;
  const { options: _opts, ...wireRest } = detail;
  assert.ok(!JSON.stringify(wireRest).includes(MOCK_SECRET));
  const audit = await store.listAudit();
  assert.ok(!JSON.stringify(audit).includes(MOCK_SECRET), 'audit log never carries the secret');
});

test('(c) enable + federation: entries appear namespaced for exposed groups only, slice filters hold', async () => {
  const owner = await login('owner@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);

  const designer = await login('designer@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: designer } })).json() as {
    assets: Array<{ id: string; tags?: string[]; tier?: string; formats: Array<{ url: string }> }>;
  };
  const ids = feed.assets.map((a) => a.id);
  assert.ok(ids.includes('acme/logo/primary'), 'pack assets still served');
  assert.ok(ids.includes('ext/dam1/a1'), 'approved Logos asset federates');
  assert.ok(!ids.includes('ext/dam1/a2'), 'unapproved/off-section asset never enters the feed');
  const a1 = feed.assets.find((a) => a.id === 'ext/dam1/a1');
  assert.ok(a1?.tags?.includes('provider:dam1'));
  assert.ok(a1?.tags?.includes('Logos'), 'section folded into tags');
  assert.equal(a1?.tier, 'reference');
  assert.equal(a1?.formats[0]?.url, '/catalog/ext/dam1/a1/att1');

  const seller = await login('seller@test');
  const sellerFeed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: seller } })).json() as { assets: Array<{ id: string }> };
  assert.ok(!sellerFeed.assets.some((a) => a.id.startsWith('ext/')), 'group exposure hides the provider entirely');
});

test('(d) ext blob serving: streams for visible callers, 403 outside exposure groups', async () => {
  const designer = await login('designer@test');
  const blob = await fetch(`${base}/catalog/ext/dam1/a1/att1`, { headers: { cookie: designer } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'mock:dam1:a1:att1');
  assert.equal(blob.headers.get('x-content-type-options'), 'nosniff');

  const seller = await login('seller@test');
  assert.equal((await fetch(`${base}/catalog/ext/dam1/a1/att1`, { headers: { cookie: seller } })).status, 403);
  assert.equal((await fetch(`${base}/catalog/ext/nope/a1/att1`, { headers: { cookie: designer } })).status, 404);
});

test('(e) search: pack + federated results merge, live fan-out honours the exposure slice', async () => {
  const designer = await login('designer@test');
  const res = await fetch(`${base}/api/v1/catalog/search?q=summit`, { headers: { cookie: designer } });
  assert.equal(res.status, 200);
  const body = await res.json() as { results: Array<{ id: string }> };
  const ids = body.results.map((r) => r.id);
  assert.ok(ids.includes('ext/dam1/a1'), 'federated match found');
  assert.ok(!ids.includes('ext/dam1/a2'), 'live search cannot leak past the exposure slice');

  const logos = await (await fetch(`${base}/api/v1/catalog/search?q=logo`, { headers: { cookie: designer } })).json() as { results: Array<{ id: string }> };
  assert.ok(logos.results.some((r) => r.id === 'acme/logo/primary'), 'pack assets searchable too');
});

test('(f) lifecycle overlays govern federated ids: revoke in lolly while upstream stays live', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/ext/dam1/a1`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ revoke: true }),
  });
  assert.equal(put.status, 200);

  const designer = await login('designer@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: designer } })).json() as { assets: Array<{ id: string }> };
  assert.ok(!feed.assets.some((a) => a.id === 'ext/dam1/a1'), 'revoked federated entry drops from the feed');
  const blob = await fetch(`${base}/catalog/ext/dam1/a1/att1`, { headers: { cookie: designer } });
  assert.equal(blob.status, 410);
  const search = await (await fetch(`${base}/api/v1/catalog/search?q=summit`, { headers: { cookie: designer } })).json() as { results: Array<{ id: string }> };
  assert.ok(!search.results.some((r) => r.id === 'ext/dam1/a1'), 'live search honours the revocation');
});

test('(g) kill switch: disable drops the fragment and 410s blobs; delete requires disabled first', async () => {
  const owner = await login('owner@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/disable`, { method: 'POST', headers: { cookie: owner } })).status, 200);

  const designer = await login('designer@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: designer } })).json() as { assets: Array<{ id: string }> };
  assert.ok(!feed.assets.some((a) => a.id.startsWith('ext/dam1/')));
  const blob = await fetch(`${base}/catalog/ext/dam1/a1/att1`, { headers: { cookie: designer } });
  assert.equal(blob.status, 410);
  assert.equal((await blob.json() as { error: { code: string } }).error.code, 'PROVIDER_DISABLED');

  // Delete is admin-manage but refuses while enabled (checked via re-enable).
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  const delEnabled = await fetch(`${base}/api/v1/catalog/providers/dam1`, { method: 'DELETE', headers: { cookie: admin } });
  assert.equal(delEnabled.status, 409);
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1/disable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1`, { method: 'DELETE', headers: { cookie: admin } })).status, 200);
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam1`, { headers: { cookie: admin } })).status, 404);
});

test('(h) config-managed records are read-only in the API and say why', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  const list = await (await fetch(`${base}/api/v1/catalog/providers`, { headers: { cookie: admin } })).json() as {
    providers: Array<{ id: string; managedBy: string }>;
  };
  assert.equal(list.providers.find((p) => p.id === 'gitops-dam')?.managedBy, 'config');

  const put = await fetch(`${base}/api/v1/catalog/providers/gitops-dam`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ label: 'Renamed' }),
  });
  assert.equal(put.status, 409);
  assert.equal((await put.json() as { error: { code: string } }).error.code, 'CONFIG_MANAGED');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/gitops-dam/enable`, { method: 'POST', headers: { cookie: owner } })).status, 409);
});

test('(i) preview dry-run: health + mapped sample without persisting anything', async () => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/preview`, {
    method: 'POST', headers: jsonHeaders(admin),
    body: JSON.stringify({ kind: 'mock', options: { assets: MOCK_ASSETS }, mapping: { defaultType: 'image' } }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { health: { ok: boolean }; sample: Array<{ id: string }> };
  assert.equal(body.health.ok, true);
  assert.ok(body.sample.some((s) => s.id === 'ext/preview/a1'));
  const list = await (await fetch(`${base}/api/v1/catalog/providers`, { headers: { cookie: admin } })).json() as { providers: Array<{ id: string }> };
  assert.ok(!list.providers.some((p) => p.id === 'preview'), 'nothing persisted');
});

test('(j) the full lifecycle left an audit trail under provider-specific actions', async () => {
  const actions = new Set((await store.listAudit()).map((e) => e.action));
  for (const expected of [
    'catalog.provider.create', 'catalog.provider.credential', 'catalog.provider.enable',
    'catalog.provider.disable', 'catalog.provider.delete', 'catalog.provider.preview', 'catalog.revoke',
  ]) {
    assert.ok(actions.has(expected), `audit action ${expected} recorded`);
  }
});
