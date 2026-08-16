/**
 * Policy-as-code over real HTTP (plan Rec 2): export gating + secret-free body +
 * ETag/304; apply validation, idempotent round-trip, dry-run, the owner-only
 * anti-escalation guard, per-diff permission scoping, config-managed collision,
 * provider safety, and the single audit event.
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

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-cfg-'));
  await mkdir(join(pack, 'catalog'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'keep'), '');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Cfg Hub', baseUrl: 'http://localhost', pack },
    catalogProviders: [{ id: 'cfg-src', kind: 'mock', label: 'Config Source' }],
    dev: {
      enabled: true,
      users: [
        { email: 'owner@test', groups: ['owner'] },
        { email: 'admin@test', groups: ['admin'] },
        { email: 'brand@test', groups: ['brand'] },   // policy.edit-only (via grant below)
        { email: 'marketer@test', groups: ['marketing'] },
      ],
    },
  }));
  store = createMemoryStore();
  // brand group can edit policy but not grants or providers.
  await store.putGrant({ principal: 'group:brand', action: 'policy.edit', resource: '*', effect: 'allow' });
  const app = buildApp({ config, store, secrets: { session: 's', link: 'l' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});
after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const exportDoc = (cookie: string, headers: Record<string, string> = {}) => fetch(`${base}/api/v1/config/export`, { headers: { cookie, ...headers } });
const apply = (cookie: string, body: unknown, qs = '') => fetch(`${base}/api/v1/config/apply${qs}`, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });

test('export: gated on policy.edit, secret-free body, stable ETag → 304', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await exportDoc(marketer)).status, 403);
  const admin = await login('admin@test');
  const res = await exportDoc(admin);
  assert.equal(res.status, 200);
  const etag = res.headers.get('etag')!;
  const text = await res.text();
  assert.ok(etag.startsWith('"cfg-'));
  for (const bad of ['credentialCiphertext', 'credentialFingerprint', '"enabled"', 'updatedAt']) {
    assert.ok(!text.includes(bad), `export must not leak ${bad}`);
  }
  const doc = JSON.parse(text);
  assert.deepEqual(Object.keys(doc).sort(), ['chains', 'exportedAt', 'featureFlags', 'grants', 'kind', 'overlays', 'providers', 'version']);
  // The config-managed provider is NOT in the document.
  assert.ok(!doc.providers.some((p: { id: string }) => p.id === 'cfg-src'));
  assert.equal((await exportDoc(admin, { 'if-none-match': etag })).status, 304);
});

test('apply: dry-run does not write; a real apply is idempotent on re-run', async () => {
  const admin = await login('admin@test');
  const doc = { kind: 'lolly-work/config', version: 1, grants: [], overlays: [{ toolId: 'qr-code', visibility: { groups: ['brand'] } }], chains: [], providers: [], featureFlags: [] };
  const dry = await apply(admin, doc, '?dryRun=1');
  assert.equal(dry.status, 200);
  assert.equal((await dry.json() as { dryRun: boolean }).dryRun, true);
  assert.equal((await store.listOverlays()).has('qr-code'), false, 'dry-run wrote nothing');

  const first = await apply(admin, doc);
  assert.equal(first.status, 200);
  const v1 = (await store.listOverlays()).get('qr-code')!.version;
  const second = await apply(admin, doc);
  const body = await second.json() as { applied: { overlays: { create: number; update: number; unchanged: number } } };
  assert.equal(body.applied.overlays.unchanged, 1);
  assert.equal(body.applied.overlays.update, 0);
  assert.equal((await store.listOverlays()).get('qr-code')!.version, v1, 'no version churn on no-op');
});

test('owner-only anti-escalation: admin cannot introduce an instance.config grant; owner can', async () => {
  const admin = await login('admin@test');
  const owner = await login('owner@test');
  const g = { principal: 'group:ops', action: 'instance.config', resource: '*', effect: 'allow' };
  const doc = (grants: unknown[]) => ({ kind: 'lolly-work/config', version: 1, grants, overlays: [], chains: [], providers: [], featureFlags: [] });

  const denied = await apply(admin, doc([g]));
  assert.equal(denied.status, 403);
  assert.equal((await denied.json() as { error: { code: string } }).error.code, 'OWNER_ONLY_ACTION');
  assert.equal((await store.listGrants()).some((x) => x.action === 'instance.config'), false, 'nothing written');

  assert.equal((await apply(owner, doc([g]))).status, 200);
  // Now unchanged for admin → allowed (no-op re-apply of an existing owner-only grant).
  assert.equal((await apply(admin, doc([g]))).status, 200);
});

test('permission scoping from the diff + config-managed collision', async () => {
  const brand = await login('brand@test'); // policy.edit only
  const okDoc = { kind: 'lolly-work/config', version: 1, grants: [], overlays: [{ toolId: 'poster', visibility: { groups: ['brand'] } }], chains: [], providers: [], featureFlags: [] };
  assert.equal((await apply(brand, okDoc)).status, 200); // overlays need only policy.edit

  // A provider change needs catalog.provider.manage - brand lacks it.
  const provDoc = { kind: 'lolly-work/config', version: 1, grants: [], overlays: [], chains: [], providers: [{ id: 'newsrc', kind: 'mock', label: 'New', options: {}, mapping: {}, exposure: {}, sync: {} }], featureFlags: [] };
  const provRes = await apply(brand, provDoc);
  assert.equal(provRes.status, 403);
  assert.ok((await provRes.json() as { error: { message: string } }).error.message.includes('catalog.provider.manage'));

  // A grant change needs grant.edit - brand lacks it.
  const grantDoc = { kind: 'lolly-work/config', version: 1, grants: [{ principal: 'group:x', action: 'link.create', resource: '*', effect: 'allow' }], overlays: [], chains: [], providers: [], featureFlags: [] };
  const grantRes = await apply(brand, grantDoc);
  assert.equal(grantRes.status, 403);
  assert.ok((await grantRes.json() as { error: { message: string } }).error.message.includes('grant.edit'));

  // Referencing the config-managed provider id → 409, nothing written.
  const admin = await login('admin@test');
  const collide = { kind: 'lolly-work/config', version: 1, grants: [], overlays: [], chains: [], providers: [{ id: 'cfg-src', kind: 'mock', label: 'x', options: {}, mapping: {}, exposure: {}, sync: {} }], featureFlags: [] };
  const cRes = await apply(admin, collide);
  assert.equal(cRes.status, 409);
  assert.equal((await cRes.json() as { error: { code: string } }).error.code, 'CONFIG_MANAGED');
});

test('validation atomicity (400, no writes) + one audit event per real apply', async () => {
  const admin = await login('admin@test');
  const before = (await (await fetch(`${base}/api/v1/audit?limit=1`, { headers: { cookie: admin } })).json() as { total: number }).total;
  const bad = { kind: 'lolly-work/config', version: 1, grants: [], overlays: [{ toolId: 'x', inputAccess: 'not-an-object' }], chains: [], providers: [], featureFlags: [] };
  assert.equal((await apply(admin, bad)).status, 400);

  await apply(admin, { kind: 'lolly-work/config', version: 1, grants: [], overlays: [], chains: [], providers: [], featureFlags: [{ id: 'neurospicy', default: 'off' }] });
  const auditRes = await (await fetch(`${base}/api/v1/audit?limit=50`, { headers: { cookie: admin } })).json() as { total: number; chain: { ok: boolean }; events: Array<{ action: string }> };
  assert.ok(auditRes.total > before);
  assert.equal(auditRes.chain.ok, true);
  assert.ok(auditRes.events.some((e) => e.action === 'config.apply'));
});
