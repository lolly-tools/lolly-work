/**
 * Catalog holds over real HTTP (plans/27 §3): the one governance verb that only
 * ever preserves availability. Setting/releasing rides the lifecycle PUT under
 * its own `catalog.hold` action and audits distinctly; while held, revocation
 * and any edit that would remove the asset now are refused 409 ASSET_HELD
 * (release first), but non-removing edits and serving still work. A held ext/*
 * asset reports pinned:false honestly until wave 4's materialization lands.
 *
 * Own file, own server + pack (the catalog-lifecycle pattern).
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

const RAW_INDEX = {
  version: 1,
  assets: [{
    id: 'acme/logo/primary', name: 'Acme Primary Logo', type: 'vector', tags: ['logo'],
    formats: [{ format: 'svg', url: '/catalog/assets/acme/logo/primary.svg', size: 32 }],
  }],
};

const EXT_ASSET = { remoteId: 'x1', name: 'Federated One', nativeType: 'file', sections: [], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'att1' }] };

const FUTURE = '2030-01-01T00:00:00.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-holds-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme', 'logo'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify(RAW_INDEX));
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'logo', 'primary.svg'), '<svg/>');

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Holds Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'marketer@test', groups: ['marketing'] },
    ] },
    catalogProviders: [{ id: 'damh', kind: 'mock', label: 'Held DAM', enabled: true, options: { assets: [EXT_ASSET] } }],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sH', link: 'lH' } });
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
const putLifecycle = (cookie: string, id: string, body: unknown) =>
  fetch(`${base}/api/v1/catalog/lifecycle/${id}`, { method: 'PUT', headers: jsonHeaders(cookie), body: JSON.stringify(body) });

test('(a) catalog.hold is admin-gated; setting a hold records who/when/note and audits catalog.hold', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await putLifecycle(marketer, 'acme/logo/primary', { hold: { note: 'nope' } })).status, 403);

  const admin = await login('admin@test');
  const put = await putLifecycle(admin, 'acme/logo/primary', { hold: { note: 'legal review' } });
  assert.equal(put.status, 200);
  const body = await put.json() as { hold?: { by: string; at: string; note?: string }; pinned?: boolean };
  assert.equal(body.hold?.note, 'legal review');
  assert.match(body.hold?.by ?? '', /^user:/);
  assert.ok(body.hold?.at, 'hold stamps when it was set');
  assert.equal(body.pinned, true, 'a pack asset is inherently byte-durable, so a hold reads pinned:true');

  assert.ok((await store.listAudit()).some((e) => e.action === 'catalog.hold' && e.subject === 'asset:acme/logo/primary'));
});

test('(b) while held: revoke and expiry-into-the-past 409 ASSET_HELD (note echoed); non-removing edits pass; blob still serves', async () => {
  const admin = await login('admin@test');

  const revoke = await putLifecycle(admin, 'acme/logo/primary', { revoke: true });
  assert.equal(revoke.status, 409);
  const err = await revoke.json() as { error: { code: string; message: string } };
  assert.equal(err.error.code, 'ASSET_HELD');
  assert.match(err.error.message, /legal review/, 'the hold note rides the refusal');

  assert.equal((await putLifecycle(admin, 'acme/logo/primary', { validUntil: PAST })).status, 409, 'expiry into the past is a removal');

  // Scheduling a future expiry does not remove the asset now - allowed while held.
  const extend = await putLifecycle(admin, 'acme/logo/primary', { validUntil: FUTURE });
  assert.equal(extend.status, 200);
  const extBody = await extend.json() as { validUntil?: string; hold?: unknown };
  assert.equal(extBody.validUntil, FUTURE);
  assert.ok(extBody.hold, 'the hold is preserved across an ordinary edit');

  // Serving is never blocked by a hold.
  assert.equal((await fetch(`${base}/catalog/assets/acme/logo/primary.svg`, { headers: { cookie: admin } })).status, 200);
});

test('(c) the lifecycle list surfaces the held row with its pinned flag', async () => {
  const admin = await login('admin@test');
  const rows = await (await fetch(`${base}/api/v1/catalog/lifecycle`, { headers: { cookie: admin } })).json() as {
    rows: Array<{ assetId: string; hold?: unknown; pinned?: boolean }>;
  };
  const held = rows.rows.find((r) => r.assetId === 'acme/logo/primary');
  assert.ok(held?.hold, 'held asset appears with its hold');
  assert.equal(held?.pinned, true);
});

test('(d) release (hold:null) audits catalog.hold.release and unblocks revocation', async () => {
  const admin = await login('admin@test');
  const rel = await putLifecycle(admin, 'acme/logo/primary', { hold: null });
  assert.equal(rel.status, 200);
  assert.equal((await rel.json() as { hold?: unknown }).hold, undefined, 'hold cleared');
  assert.ok((await store.listAudit()).some((e) => e.action === 'catalog.hold.release' && e.subject === 'asset:acme/logo/primary'));

  // With the hold gone, the removal that 409'd before now succeeds.
  const revoke = await putLifecycle(admin, 'acme/logo/primary', { revoke: true });
  assert.equal(revoke.status, 200);
  assert.equal((await revoke.json() as { state: string }).state, 'revoked');
});

test('(e) a hold on a federated ext/* id implies a pin: its bytes are materialized local (plans/27 §3, §5)', async () => {
  const admin = await login('admin@test');
  const put = await putLifecycle(admin, 'ext/damh/x1', { hold: { note: 'legal hold' } });
  assert.equal(put.status, 200);
  assert.equal((await put.json() as { pinned?: boolean }).pinned, true, 'hold implies pin — the bytes are now instance-owned');

  const doc = await (await fetch(`${base}/api/v1/catalog/assets/ext/damh/x1`, { headers: { cookie: admin } })).json() as {
    lifecycle: { hold?: { note?: string }; pinned?: boolean } | null;
  };
  assert.equal(doc.lifecycle?.hold?.note, 'legal hold');
  assert.equal(doc.lifecycle?.pinned, true, 'inspect reports the pin');

  // The ext identity is unchanged, but the blob route now prefers the local copy.
  const blob = await fetch(`${base}/catalog/ext/damh/x1/att1`, { headers: { cookie: admin } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'mock:damh:x1:att1', 'served from the materialized local bytes');
});
