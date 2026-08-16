/**
 * Catalog content lifecycle over real HTTP (plans/06 §3): the served
 * assets/index.json feed folds in expiry/scheduling/revocation, an
 * individual blob 410s the same way (a guessed or cached URL doesn't bypass
 * the feed), and the admin lifecycle API is grant-gated and audited.
 *
 * Kept in its own file (own server + pack) so it doesn't couple to app.test.ts.
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

// Two assets, one with a real blob on disk (acme/logo/primary) so the blob
// gating path (not just the feed) gets exercised; the other (acme/palette/core)
// only needs to exist in the feed for the 'scheduled' case.
const RAW_INDEX = {
  version: 1,
  generatedAt: '2026-07-01T00:00:00.000Z',
  assets: [
    {
      id: 'acme/logo/primary', name: 'Acme Primary Logo', type: 'vector', tags: ['logo', 'official'],
      formats: [{ format: 'svg', url: '/catalog/assets/acme/logo/primary.svg', checksum: 'sha256-test-a', size: 128 }],
    },
    {
      id: 'acme/palette/core', name: 'Acme Core Palette', type: 'palette', tags: ['palette'],
      formats: [{ format: 'json', url: '/catalog/assets/acme/palette/core.json', checksum: 'sha256-test-b', size: 64 }],
    },
  ],
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-catalog-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme', 'logo'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets', 'acme', 'palette'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify(RAW_INDEX, null, 2));
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo', 'primary.svg'), '<svg><!-- primary logo --></svg>');
  // acme/palette/core deliberately has no blob file on disk - only its feed
  // presence and its lifecycle rows (scheduled) are exercised below.

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Catalog Hub', baseUrl: 'http://localhost', pack },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'marketer@test', name: 'Mia Marketer', groups: ['marketing'] },
      ],
    },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0] as string;
}

test('(a) no lifecycle rows: feed is byte-equivalent to the raw index; blob 200', async () => {
  const cookie = await login('admin@test');
  const res = await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), RAW_INDEX);

  const blob = await fetch(`${base}/catalog/assets/acme/logo/primary.svg`, { headers: { cookie } });
  assert.equal(blob.status, 200);
  assert.match(await blob.text(), /primary logo/);
});

test('(b) validUntil past + onExpiry hide: entry dropped from the feed; blob 410 ASSET_EXPIRED', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/acme/logo/primary`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ validUntil: '2020-01-01T00:00:00.000Z' }),
  });
  assert.equal(put.status, 200);
  const putBody = await put.json() as { state: string; onExpiry: string };
  assert.equal(putBody.state, 'expired');
  assert.equal(putBody.onExpiry, 'hide'); // default when unspecified

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as { assets: Array<{ id: string }> };
  assert.deepEqual(feed.assets.map((a) => a.id), ['acme/palette/core']);

  const blob = await fetch(`${base}/catalog/assets/acme/logo/primary.svg`, { headers: { cookie: admin } });
  assert.equal(blob.status, 410);
  assert.equal((await blob.json() as { error: { code: string } }).error.code, 'ASSET_EXPIRED');
});

test('(c) softened to onExpiry warn: entry kept with expired:true; blob stays usable', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/acme/logo/primary`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ onExpiry: 'warn' }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json() as { state: string }).state, 'expired');

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as {
    assets: Array<{ id: string; expired?: boolean }>;
  };
  const entry = feed.assets.find((a) => a.id === 'acme/logo/primary');
  assert.ok(entry, 'kept in the feed under warn, unlike hide');
  assert.equal(entry?.expired, true);

  const blob = await fetch(`${base}/catalog/assets/acme/logo/primary.svg`, { headers: { cookie: admin } });
  assert.equal(blob.status, 200, 'warn does not block the blob — the asset stays usable');
});

test('(d) revoke: immediate 410 regardless of onExpiry, dropped from the feed, audit event recorded', async () => {
  const admin = await login('admin@test');
  const before = await store.listAudit();
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/acme/logo/primary`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ revoke: true }),
  });
  assert.equal(put.status, 200);
  const body = await put.json() as { state: string; revokedAt?: string };
  assert.equal(body.state, 'revoked');
  assert.ok(body.revokedAt);

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as { assets: Array<{ id: string }> };
  assert.deepEqual(feed.assets.map((a) => a.id), ['acme/palette/core']); // warn no longer saves it from revocation

  const blob = await fetch(`${base}/catalog/assets/acme/logo/primary.svg`, { headers: { cookie: admin } });
  assert.equal(blob.status, 410);
  assert.equal((await blob.json() as { error: { code: string } }).error.code, 'ASSET_EXPIRED');

  const after = await store.listAudit();
  assert.ok(after.length > before.length);
  assert.ok(after.some((e) => e.action === 'catalog.revoke' && e.subject === 'asset:acme/logo/primary'));
});

test('(e) scheduled: validFrom in the future drops the entry from the feed', async () => {
  const admin = await login('admin@test');
  const future = new Date(Date.now() + 30 * 24 * 3600 * 1000).toISOString();
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/acme/palette/core`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ validFrom: future }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json() as { state: string }).state, 'scheduled');

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as { assets: Array<{ id: string }> };
  assert.equal(feed.assets.length, 0, 'primary stays revoked, core is now scheduled — both gone');

  // GET /api/v1/catalog/lifecycle reports both rows with their computed state,
  // even though neither survives in the served feed.
  const rows = await (await fetch(`${base}/api/v1/catalog/lifecycle`, { headers: { cookie: admin } })).json() as {
    rows: Array<{ assetId: string; state: string }>;
  };
  assert.equal(rows.rows.find((r) => r.assetId === 'acme/logo/primary')?.state, 'revoked');
  assert.equal(rows.rows.find((r) => r.assetId === 'acme/palette/core')?.state, 'scheduled');
});

test('(f) a non-admin is refused on both the read and write lifecycle routes', async () => {
  const marketer = await login('marketer@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/acme/palette/core`, {
    method: 'PUT', headers: { cookie: marketer, 'content-type': 'application/json' },
    body: JSON.stringify({ onExpiry: 'warn' }),
  });
  assert.equal(put.status, 403);
  const get = await fetch(`${base}/api/v1/catalog/lifecycle`, { headers: { cookie: marketer } });
  assert.equal(get.status, 403);
});
