/**
 * Search-and-import (plans/30 §3.1): the /import route snapshots ONE provider asset
 * into an instance-owned inst/* copy - the curation gate. Over real HTTP with a
 * db-managed mock provider (no getAsset → the listAssets-scan fallback), plus a unit
 * test of the `materializeAsset` seam that the getAsset path uses (a search-only ref
 * straight into the snapshot machinery). Memory store + memory BlobStore, no network.
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
import { materializeAsset } from '../server/src/catalog/materialize.ts';
import type { Federation } from '../server/src/catalog/federation.ts';
import type { BlobStore } from '../server/src/blobs/types.ts';
import type { ProviderRecord } from '../server/src/catalog/providers/types.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const MOCK_ASSETS = [
  { remoteId: 'a1', name: 'Summit Logo', nativeType: 'file', sections: ['Logos'], tags: [], approved: true, formats: [{ format: 'png', remoteRef: 'att1', size: 17 }] },
];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-import-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Import Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'designer@test', groups: ['design'] },
    ] },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 's', link: 'l', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const owner = await login('owner@test');
  await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'src1', kind: 'mock', label: 'Source', options: { assets: MOCK_ASSETS } }),
  });
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/src1/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

test('import is admin-gated', async () => {
  const designer = await login('designer@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/src1/import`, {
    method: 'POST', headers: { cookie: designer, 'content-type': 'application/json' }, body: JSON.stringify({ remoteId: 'a1' }),
  });
  assert.equal(res.status, 403);
});

test('import snapshots one asset into inst/* and serves its bytes', async () => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/src1/import`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ remoteId: 'a1' }),
  });
  assert.equal(res.status, 200);
  const body = await res.json() as { ok: boolean; imported: { id: string; extId: string } };
  assert.match(body.imported.id, /^inst\//);
  assert.equal(body.imported.extId, 'ext/src1/a1');

  // The materialized copy serves the local bytes and is audited under its own action.
  const blob = await fetch(`${base}/catalog/${body.imported.id}/png`, { headers: { cookie: admin } });
  assert.equal(blob.status, 200);
  assert.equal(await blob.text(), 'mock:src1:a1:att1');
  assert.ok((await store.listAudit()).some((e) => e.action === 'catalog.provider.import'));
});

test('import of an unknown remoteId is a 404', async () => {
  const admin = await login('admin@test');
  const res = await fetch(`${base}/api/v1/catalog/providers/src1/import`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ remoteId: 'nope' }),
  });
  assert.equal(res.status, 404);
});

test('materializeAsset snapshots a search-only ref (no listAssets scan) via the shared machinery', async () => {
  const fakeProvider = { resolveBlob: async () => ({ kind: 'stream' as const, body: new Response('BOARDPNG').body as ReadableStream<Uint8Array>, contentType: 'image/png' }) };
  const deps = {
    store: createMemoryStore(),
    blobs: { put: async (id: string, buf: Uint8Array) => ({ size: buf.length, checksum: `sum:${id}` }) } as unknown as BlobStore,
    federation: { instantiate: () => fakeProvider } as unknown as Federation,
  };
  const rec = {
    id: 'pp', kind: 'penpot', label: 'P', managedBy: 'db', enabled: true,
    options: {}, mapping: { typeMap: { board: 'image' }, defaultType: 'image' }, exposure: {}, sync: {},
    createdAt: 'now', updatedAt: 'now', state: { assetCount: 0 },
  } as unknown as ProviderRecord;
  const asset = { remoteId: 'f_p_b', name: 'Hero', nativeType: 'board', sections: [], tags: [], formats: [{ format: 'png', remoteRef: 'render' }] };

  const result = await materializeAsset(deps, rec, asset);
  assert.match(result.id, /^inst\//);
  assert.equal(result.extId, 'ext/pp/f_p_b');
  const insts = await deps.store.listInstanceAssets();
  assert.equal(insts.length, 1);
  assert.equal(insts[0]!.entry.type, 'image', 'board → image via typeMap');
  assert.equal(insts[0]!.origin?.remoteId, 'f_p_b');
});
