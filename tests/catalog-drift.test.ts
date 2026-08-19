/**
 * The drift report over real HTTP (plans/33 §2b) - the cadence check during a
 * staged exit: which materialized copies has upstream changed since we took
 * them, and which upstream assets have no copy at all. Read-only, gated like
 * the other provider reads (catalog.provider.read).
 *
 * Config-free mock provider whose `options.assets` ARE the upstream, so moving
 * an upstream `updatedAt` forward is a PUT away - no network, no fixtures on
 * disk, and no vendor host is contacted.
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
import { providerDrift } from '../server/src/catalog/drift.ts';

let server: Server;
let base = '';

interface DriftReportWire {
  provider: string;
  materialized: number;
  compared: number;
  drifted: Array<{ id: string; remoteId: string; sourceUpdatedAt: string | null; materializedAt: string; upstreamUpdatedAt: string }>;
  neverMaterialized: string[];
}

const asset = (remoteId: string, updatedAt?: string) => ({
  remoteId, name: `Asset ${remoteId}`, nativeType: 'file', sections: ['Logos'], tags: [], approved: true,
  ...(updatedAt ? { updatedAt } : {}),
  formats: [{ format: 'png', remoteRef: `${remoteId}-ref` }],
});

/** The upstream as it stood when the copies were taken. */
const AT_COPY_TIME = [asset('a1', '2026-06-01T00:00:00.000Z'), asset('a2', '2026-06-01T00:00:00.000Z'), asset('a3', '2026-06-01T00:00:00.000Z'), asset('a4')];

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-drift-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Drift Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
      { email: 'designer@test', groups: ['design'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's9', link: 'l9', credential: 'a-32-byte-or-longer-master-secret!' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;

  const admin = await login('admin@test');
  const owner = await login('owner@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ id: 'dam9', kind: 'mock', label: 'Drift DAM', options: { assets: AT_COPY_TIME } }),
  })).status, 201);
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam9/enable`, { method: 'POST', headers: { cookie: owner } })).status, 200);
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

/** Replace the mock provider's upstream - this is what "changed at the source"
 *  means for a driver whose options ARE the tenant. */
async function setUpstream(assets: unknown[]): Promise<void> {
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam9`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ options: { assets } }),
  })).status, 200);
}

async function drift(cookie: string): Promise<DriftReportWire> {
  const res = await fetch(`${base}/api/v1/catalog/providers/dam9/drift`, { headers: { cookie } });
  assert.equal(res.status, 200);
  return await res.json() as DriftReportWire;
}

test('(a) three of four upstream assets are materialized; the fourth is left alone', async () => {
  const admin = await login('admin@test');
  for (const remoteId of ['a1', 'a2', 'a4']) {
    const res = await fetch(`${base}/api/v1/catalog/providers/dam9/materialize`, {
      method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ remoteId }),
    });
    assert.equal(res.status, 200);
    assert.equal((await res.json() as { materialized: number }).materialized, 1);
  }
});

test('(b) nothing has moved upstream: no drift, and the uncopied asset is reported separately', async () => {
  const report = await drift(await login('admin@test'));
  assert.equal(report.provider, 'dam9');
  assert.equal(report.materialized, 3);
  assert.equal(report.drifted.length, 0, 'an unchanged upstream is not drift');
  assert.deepEqual(report.neverMaterialized, ['a3'], 'the upstream asset with no copy is named');
  assert.equal(report.compared, 2, 'a4 carried no upstream updatedAt, so there is nothing to compare it against');
});

test('(c) an upstream updatedAt that moved forward appears; one that did not does not', async () => {
  await setUpstream([asset('a1', '2026-07-15T09:30:00.000Z'), asset('a2', '2026-06-01T00:00:00.000Z'), asset('a3', '2026-06-01T00:00:00.000Z'), asset('a4')]);
  const report = await drift(await login('admin@test'));
  assert.equal(report.drifted.length, 1);
  const d = report.drifted[0]!;
  assert.equal(d.remoteId, 'a1');
  assert.equal(d.sourceUpdatedAt, '2026-06-01T00:00:00.000Z', 'the stamp taken at copy time');
  assert.equal(d.upstreamUpdatedAt, '2026-07-15T09:30:00.000Z', 'and the stamp upstream carries now');
  assert.match(d.id, /^inst\//, 'the drifted copy is named by its instance id');
  assert.ok(d.materializedAt, 'materializedAt rides along for the operator');
  assert.ok(!report.drifted.some((x) => x.remoteId === 'a2'), 'an untouched asset stays out of the report');
});

test('(d) an asset copied before upstream had any stamp drifts against materializedAt', async () => {
  await setUpstream([asset('a1', '2026-07-15T09:30:00.000Z'), asset('a2', '2026-06-01T00:00:00.000Z'), asset('a3', '2026-06-01T00:00:00.000Z'), asset('a4', '2099-01-01T00:00:00.000Z')]);
  const report = await drift(await login('admin@test'));
  const d = report.drifted.find((x) => x.remoteId === 'a4');
  assert.ok(d, 'a stamp appearing upstream after the copy is drift');
  assert.equal(d.sourceUpdatedAt, null, 'there was no source stamp to record at copy time');
  assert.equal(report.compared, 3, 'a4 is comparable now that upstream stamps it');
});

test('(e) drift is read-gated like the other provider reads, and a missing provider 404s', async () => {
  const designer = await login('designer@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/dam9/drift`, { headers: { cookie: designer } })).status, 403);
  const admin = await login('admin@test');
  assert.equal((await fetch(`${base}/api/v1/catalog/providers/nope/drift`, { headers: { cookie: admin } })).status, 404);
});

test('(f) drift changes nothing: the report is repeatable and no copy is re-taken', async () => {
  const admin = await login('admin@test');
  const first = await drift(admin);
  const second = await drift(admin);
  assert.deepEqual(second, first, 'a read-only report is idempotent');
  assert.equal(second.materialized, 3, 'reading the report materializes nothing');
});

test('(g) the comparison itself: an unparsable upstream stamp is "cannot tell", and is never counted as compared', () => {
  const materializedAt = '2026-06-01T00:00:00.000Z';
  const records = [
    { id: 'inst/1', entry: { id: 'inst/1' }, blobs: {}, createdAt: materializedAt, origin: { provider: 'p', providerKind: 'mock', remoteId: 'r1', sourceUpdatedAt: materializedAt, materializedAt } },
    { id: 'inst/2', entry: { id: 'inst/2' }, blobs: {}, createdAt: materializedAt, origin: { provider: 'other', providerKind: 'mock', remoteId: 'r1', sourceUpdatedAt: materializedAt, materializedAt } },
  ];
  const report = providerDrift('p', [{ id: 'ext/p/r1', updatedAt: 'not-a-date' }], records);
  assert.equal(report.drifted.length, 0, 'a stamp that will not parse must not fake a drift');
  assert.equal(report.materialized, 1, 'another provider\'s copies are not counted');
  assert.deepEqual(report.neverMaterialized, []);
  // The half that matters most: it must not read as a clean bill of health.
  assert.equal(report.compared, 0, 'a stamp we cannot read was never compared');
  assert.equal(report.unparsable, 1, 'and it is counted where an operator will see it');
  assert.deepEqual(report.unparsableShapes, ['AAA-A-AAAA'], 'the format is named; the value never travels');
});

test('(g2) a stamp with no timezone is compared, but the near-miss is declared', () => {
  // `01/06/2026 10:00` DOES parse - in the server's own timezone - so refusing
  // it would be over-strict and trusting it silently would be a lie. It counts
  // as compared and says which shape the caveat applies to.
  const materializedAt = '2026-06-01T00:00:00.000Z';
  const records = [
    { id: 'inst/1', entry: { id: 'inst/1' }, blobs: {}, createdAt: materializedAt, origin: { provider: 'p', providerKind: 'mock', remoteId: 'r1', sourceUpdatedAt: materializedAt, materializedAt } },
  ];
  const report = providerDrift('p', [{ id: 'ext/p/r1', updatedAt: '01/06/2026 10:00' }], records);
  assert.equal(report.unparsable, 0);
  assert.equal(report.compared, 1);
  assert.equal(report.timezoneless, 1);
  assert.deepEqual(report.timezonelessShapes, ['NN/NN/NNNN NN:NN'], 'the format, never the value');
  // An ISO stamp with a zone raises no such caveat.
  const clean = providerDrift('p', [{ id: 'ext/p/r1', updatedAt: '2026-07-01T00:00:00+10:00' }], records);
  assert.equal(clean.timezoneless, 0);
  assert.equal(clean.drifted.length, 1);
});

test('(h) the three ways a copy drops out of `compared` are counted apart, never as fresh', () => {
  const materializedAt = '2026-06-01T00:00:00.000Z';
  const copy = (n: string, remoteId: string) => ({
    id: `inst/${n}`, entry: { id: `inst/${n}` }, blobs: {}, createdAt: materializedAt,
    origin: { provider: 'p', providerKind: 'mock', remoteId, sourceUpdatedAt: materializedAt, materializedAt },
  });
  const report = providerDrift('p', [
    { id: 'ext/p/fresh', updatedAt: materializedAt },
    { id: 'ext/p/nostamp' },
    { id: 'ext/p/junk', updatedAt: 'yesterday' },
  ], [copy('1', 'fresh'), copy('2', 'nostamp'), copy('3', 'junk'), copy('4', 'gone')]);
  assert.equal(report.materialized, 4);
  assert.equal(report.compared, 1, 'only the copy with a readable stamp on both sides got an answer');
  assert.equal(report.drifted.length, 0);
  assert.equal(report.unstamped, 1, 'an upstream record with no stamp at all');
  assert.equal(report.unparsable, 1, 'a stamp that will not parse');
  assert.deepEqual(report.unparsableShapes, ['AAAAAAAAA']);
  assert.equal(report.missingUpstream, 1, 'a copy whose remote id has left the listing');
  assert.equal(
    report.compared + report.unstamped + report.unparsable + report.missingUpstream,
    report.materialized,
    'every copy is accounted for, so none can quietly read as unchanged',
  );
});
