/**
 * Content-credential scan over real HTTP (plans/27 §4): the on-demand
 * `POST /catalog/scan/<id>` route (admin-gated `catalog.scan`, audited) fetches
 * an asset's primary format once — off disk for a pack id, through the driver
 * for an ext/* id — sniffs whether the bytes embed a C2PA manifest, and records
 * a detection row. The feed then annotates `credential: 'embedded'` and the
 * inspect route returns the detection. Detection only — never a verdict.
 *
 * The embedded fixture is minted through the engine (the one C2PA implementation
 * both repos share), so no external tooling is involved.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { webcrypto } from 'node:crypto';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const engineSpec: string = '@lolly/engine';

async function mintPngs(): Promise<{ signed: Uint8Array; plain: Uint8Array }> {
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Scan Root', organization: 'Scan', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'scan@test.invalid', organization: 'Scan', days: 365 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'Scan Lolly');
  const { Resvg } = await import('@resvg/resvg-js');
  const plain = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#30ba78"/></svg>').render().asPng());
  const signed = await eng.embedC2pa(plain, 'png', { signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain }, title: 'x', claimGenerator: 'Scan Lolly' });
  return { signed, plain };
}

const EXT_ASSET = { remoteId: 'e1', name: 'Federated One', nativeType: 'file', sections: [], tags: [], approved: true, updatedAt: '2026-06-01T00:00:00.000Z', formats: [{ format: 'png', remoteRef: 'att1' }] };

before(async () => {
  const { signed, plain } = await mintPngs();
  const pack = await mkdtemp(join(tmpdir(), 'lw-scan-'));
  await mkdir(join(pack, 'catalog', 'assets', 'acme', 'cred'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'cred', 'embedded.png'), signed);
  await writeFile(join(pack, 'catalog', 'assets', 'acme', 'cred', 'plain.png'), plain);
  const index = {
    version: 1,
    assets: [
      { id: 'acme/cred/embedded', name: 'Embedded', type: 'image', tags: [], formats: [{ format: 'png', url: '/catalog/assets/acme/cred/embedded.png' }] },
      { id: 'acme/cred/plain', name: 'Plain', type: 'image', tags: [], formats: [{ format: 'png', url: '/catalog/assets/acme/cred/plain.png' }] },
    ],
  };
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify(index));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Scan Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'marketer@test', groups: ['marketing'] },
    ] },
    catalogProviders: [{ id: 'damc', kind: 'mock', label: 'Cred DAM', enabled: true, options: { assets: [EXT_ASSET] } }],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sC', link: 'lC' } });
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
const scan = (cookie: string, id: string) => fetch(`${base}/api/v1/catalog/scan/${id}`, { method: 'POST', headers: { cookie } });

test('(a) catalog.scan is admin-gated; scanning an embedded pack asset detects it and audits', async () => {
  const marketer = await login('marketer@test');
  assert.equal((await scan(marketer, 'acme/cred/embedded')).status, 403);

  const admin = await login('admin@test');
  const res = await scan(admin, 'acme/cred/embedded');
  assert.equal(res.status, 200);
  const row = await res.json() as { status: string; container?: string; sniffedAt: string };
  assert.equal(row.status, 'embedded');
  assert.equal(row.container, 'png');
  assert.ok(row.sniffedAt);
  assert.ok((await store.listAudit()).some((e) => e.action === 'catalog.scan' && e.subject === 'asset:acme/cred/embedded'));
});

test('(b) scanning a plain pack asset records status none', async () => {
  const admin = await login('admin@test');
  const row = await (await scan(admin, 'acme/cred/plain')).json() as { status: string; container?: string };
  assert.equal(row.status, 'none');
  assert.equal(row.container, undefined);
});

test('(c) the feed annotates credential:embedded on the detected asset only', async () => {
  const admin = await login('admin@test');
  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: admin } })).json() as {
    assets: Array<{ id: string; credential?: string }>;
  };
  assert.equal(feed.assets.find((a) => a.id === 'acme/cred/embedded')?.credential, 'embedded');
  assert.equal(feed.assets.find((a) => a.id === 'acme/cred/plain')?.credential, undefined);
});

test('(d) inspect returns the detection row (never a verdict)', async () => {
  const admin = await login('admin@test');
  const doc = await (await fetch(`${base}/api/v1/catalog/assets/acme/cred/embedded`, { headers: { cookie: admin } })).json() as {
    credential?: string; credentials: { status: string; container?: string } | null;
  };
  assert.equal(doc.credential, 'embedded');
  assert.equal(doc.credentials?.status, 'embedded');
  assert.equal(doc.credentials?.container, 'png');
  // detection, not verification — no valid/trusted field is present
  assert.ok(!Object.keys(doc.credentials ?? {}).some((k) => /valid|trust|verdict/i.test(k)));
});

test('(e) an ext/* asset is scanned through the driver, capturing the upstream updatedAt', async () => {
  const admin = await login('admin@test');
  const row = await (await scan(admin, 'ext/damc/e1')).json() as { status: string; sourceUpdatedAt?: string };
  // the mock streams non-C2PA bytes, so detection is honestly none — the point
  // is that the driver-fetch path runs and records the source's updatedAt
  assert.equal(row.status, 'none');
  assert.equal(row.sourceUpdatedAt, '2026-06-01T00:00:00.000Z');
});
