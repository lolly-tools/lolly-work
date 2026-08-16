/**
 * Imported upstream availability windows over real HTTP (plans/27 §2): a
 * federated asset carrying the DAM's own scheduling/expiry is gated at the feed
 * and at the ext/* blob route exactly like a local lifecycle row, combined
 * most-restrictive-wins. Upstream expiry hides even under onExpiry:'warn'; a
 * local admin can narrow (but not widen) the window; and the inspect route
 * separates where each constraint came from.
 *
 * Own file, own server + pack (the catalog-lifecycle pattern) with a
 * config-managed mock provider born enabled - no network, no CRUD dance.
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

const PAST = '2020-01-01T00:00:00.000Z';
const FUTURE = '2030-01-01T00:00:00.000Z';

// One asset per window state, plus one upstream-live asset reserved for the
// local-narrowing tests so the read-only assertions above stay stable.
const MOCK_ASSETS = [
  { remoteId: 'avlive', name: 'Live Asset', nativeType: 'file', sections: [], tags: [], availableFrom: PAST, availableUntil: FUTURE, formats: [{ format: 'png', remoteRef: 'att-live' }] },
  { remoteId: 'avexp', name: 'Expired Upstream', nativeType: 'file', sections: [], tags: [], availableUntil: PAST, formats: [{ format: 'png', remoteRef: 'att-exp' }] },
  { remoteId: 'avsched', name: 'Not Yet Available', nativeType: 'file', sections: [], tags: [], availableFrom: FUTURE, formats: [{ format: 'png', remoteRef: 'att-sched' }] },
  { remoteId: 'avlocal', name: 'Upstream Live For Narrowing', nativeType: 'file', sections: [], tags: [], availableUntil: FUTURE, formats: [{ format: 'png', remoteRef: 'att-local' }] },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-availability-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Availability Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }] },
    catalogProviders: [
      { id: 'damw', kind: 'mock', label: 'Windowed DAM', enabled: true, options: { assets: MOCK_ASSETS } },
    ],
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's9', link: 'l9' } });
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

test('(a) feed folds the imported window: live served (with keys), expired + scheduled dropped', async () => {
  const admin = await login('admin@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as {
    assets: Array<{ id: string; availableFrom?: string; availableUntil?: string }>;
  };
  const ids = feed.assets.map((a) => a.id);
  assert.ok(ids.includes('ext/damw/avlive'), 'upstream-live asset is served');
  assert.ok(ids.includes('ext/damw/avlocal'), 'other upstream-live asset is served');
  assert.ok(!ids.includes('ext/damw/avexp'), 'upstream-expired asset dropped');
  assert.ok(!ids.includes('ext/damw/avsched'), 'upstream-scheduled asset dropped');
  const live = feed.assets.find((a) => a.id === 'ext/damw/avlive');
  assert.equal(live?.availableFrom, PAST, 'window keys ride on the feed entry');
  assert.equal(live?.availableUntil, FUTURE);
});

test('(b) ext blob gate: live streams; upstream-expired and upstream-scheduled 410', async () => {
  const admin = await login('admin@test');
  const live = await fetch(`${base}/catalog/ext/damw/avlive/att-live`, { headers: { cookie: admin } });
  assert.equal(live.status, 200);
  assert.equal(await live.text(), 'mock:damw:avlive:att-live');

  const exp = await fetch(`${base}/catalog/ext/damw/avexp/att-exp`, { headers: { cookie: admin } });
  assert.equal(exp.status, 410, 'upstream expiry blocks the bytes with no local row at all');
  assert.equal((await exp.json() as { error: { code: string } }).error.code, 'ASSET_EXPIRED');

  const sched = await fetch(`${base}/catalog/ext/damw/avsched/att-sched`, { headers: { cookie: admin } });
  assert.equal(sched.status, 410, 'upstream scheduling blocks the bytes too');
});

test('(c) upstream expiry ignores a local onExpiry:warn — the DAM is the source of truth', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/ext/damw/avexp`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ onExpiry: 'warn' }),
  });
  assert.equal(put.status, 200);

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as { assets: Array<{ id: string }> };
  assert.ok(!feed.assets.some((a) => a.id === 'ext/damw/avexp'), 'warn cannot rescue an upstream-expired asset');
  const blob = await fetch(`${base}/catalog/ext/damw/avexp/att-exp`, { headers: { cookie: admin } });
  assert.equal(blob.status, 410, 'and the bytes stay blocked');
});

test('(d) local narrowing under warn: an upstream-live asset expired locally stays with expired:true', async () => {
  const admin = await login('admin@test');
  const put = await fetch(`${base}/api/v1/catalog/lifecycle/ext/damw/avlocal`, {
    method: 'PUT', headers: jsonHeaders(admin), body: JSON.stringify({ validUntil: PAST, onExpiry: 'warn' }),
  });
  assert.equal(put.status, 200);
  assert.equal((await put.json() as { state: string }).state, 'expired');

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as {
    assets: Array<{ id: string; expired?: boolean }>;
  };
  const local = feed.assets.find((a) => a.id === 'ext/damw/avlocal');
  assert.ok(local, 'a purely-local expiry under warn keeps the entry (upstream still available)');
  assert.equal(local?.expired, true);
  const blob = await fetch(`${base}/catalog/ext/damw/avlocal/att-local`, { headers: { cookie: admin } });
  assert.equal(blob.status, 200, 'local warn softens the bytes because upstream is still live');
});

test('(e) inspect separates where each constraint came from', async () => {
  const admin = await login('admin@test');
  const liveDoc = await (await fetch(`${base}/api/v1/catalog/assets/ext/damw/avlive`, { headers: { cookie: admin } })).json() as {
    state: string; availableFrom?: string; availableUntil?: string;
    lifecycle: { state: string; validUntil: string | null; upstream?: { availableFrom: string | null; availableUntil: string | null } } | null;
  };
  assert.equal(liveDoc.state, 'live');
  assert.equal(liveDoc.availableUntil, FUTURE);
  assert.equal(liveDoc.lifecycle?.validUntil, null, 'no local end date');
  assert.equal(liveDoc.lifecycle?.upstream?.availableUntil, FUTURE, 'upstream end surfaced distinctly');

  const expDoc = await (await fetch(`${base}/api/v1/catalog/assets/ext/damw/avexp`, { headers: { cookie: admin } })).json() as {
    state: string; lifecycle: { upstream?: { availableUntil: string | null } } | null;
  };
  assert.equal(expDoc.state, 'expired');
  assert.equal(expDoc.lifecycle?.upstream?.availableUntil, PAST, 'the constraint is attributed to upstream, not a local row');
});
