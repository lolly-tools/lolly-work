/**
 * Publish-out over real HTTP (plans/27 §10): push a lolly-generated export to a
 * destination provider. The route is narrow by construction - owner-grantable
 * (catalog.provider.publish), the provider must declare the publish capability,
 * and the bytes must carry lolly's C2PA export assertion, so a federated or pack
 * asset can never be published out. The export's provenance chain is audited.
 *
 * A signed lolly export is minted through the engine (claim generator names
 * Lolly + the default c2pa.created action ⇒ verifyC2pa.madeWithLolly); a plain
 * PNG stands in for "not a lolly export".
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
import { addPngProvenance, provenanceDoc } from '../server/src/render/provenance.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let signedExport: Uint8Array;
let plainPng: Uint8Array;

const engineSpec: string = '@lolly/engine';

before(async () => {
  // Mint a signed lolly export: provenance island first (so the C2PA hard
  // binding covers it), then a Lolly-generator manifest with a created action.
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Pub Root', organization: 'Pub', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'pub@test.invalid', organization: 'Pub', days: 365 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'SUSE Lolly');
  const { Resvg } = await import('@resvg/resvg-js');
  plainPng = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 40 40"><rect width="40" height="40" fill="#30ba78"/></svg>').render().asPng());
  const withProv = addPngProvenance(plainPng, provenanceDoc([
    { title: 'Summit Logo', assetId: 'suse/logos/primary', relationship: 'componentOf', source: { kind: 'pack', label: 'SUSE' }, c2pa: null },
  ]));
  signedExport = await eng.embedC2pa(withProv, 'png', { signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain }, title: 'badge', claimGenerator: 'SUSE Lolly 2.0' });

  const pack = await mkdtemp(join(tmpdir(), 'lw-publish-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Publish Hub', baseUrl: 'http://localhost', pack },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'admin@test', groups: ['admin'] },
    ] },
    catalogProviders: [
      { id: 'cmp', kind: 'mock', label: 'Web DAM', enabled: true, options: { publish: true, assets: [] } },
      { id: 'readonly', kind: 'mock', label: 'Read-only DAM', enabled: true, options: { assets: [] } },
    ],
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'sP', link: 'lP' } });
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
const publish = (cookie: string, provider: string, name: string, format: string, body: Uint8Array) =>
  fetch(`${base}/api/v1/catalog/providers/${provider}/publish?name=${name}&format=${format}`, {
    method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body,
  });

test('(a) publish is owner-grantable: an admin without the action is refused', async () => {
  const admin = await login('admin@test');
  assert.equal((await publish(admin, 'cmp', 'badge', 'png', signedExport)).status, 403);
});

test('(b) a signed lolly export publishes, and the audit records its provenance chain', async () => {
  const owner = await login('owner@test');
  const res = await publish(owner, 'cmp', 'summit-badge', 'png', signedExport);
  assert.equal(res.status, 200);
  const body = await res.json() as { remoteId: string; url?: string };
  assert.equal(body.remoteId, 'cmp-summit-badge.png');

  const evt = (await store.listAudit()).find((e) => e.action === 'catalog.provider.publish');
  assert.ok(evt, 'publish audited');
  assert.deepEqual((evt!.payload as { provenance?: string[] }).provenance, ['suse/logos/primary'], 'the export provenance chain is recorded');
});

test('(c) a plain (unsigned) asset is refused — only lolly exports may be published out', async () => {
  const owner = await login('owner@test');
  const res = await publish(owner, 'cmp', 'random', 'png', plainPng);
  assert.equal(res.status, 422);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'NOT_LOLLY_EXPORT');
});

test('(d) a provider that does not declare the publish capability is refused', async () => {
  const owner = await login('owner@test');
  const res = await publish(owner, 'readonly', 'badge', 'png', signedExport);
  assert.equal(res.status, 409);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'PUBLISH_UNSUPPORTED');
});
