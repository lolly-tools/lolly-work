// SPDX-License-Identifier: MPL-2.0
/** Startup proves the real signed source before readiness or worker dispatch. */
import { test, mock, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { createServer, type Server } from 'node:http';
import { generateKeyPairSync } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { mintSessionCookie } from '../server/src/iam/sessions.ts';
import { createCatalogSigning } from '../server/src/catalog/signing.ts';
import { createCatalogDelivery } from '../server/src/catalog/delivery.ts';
import { catalogPublication } from '../server/src/catalog/publication.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';

const engineSpecifier: string = '@lolly/engine';
const { importSpkiOrJwkPublicKey, verifyCatalogEnvelope } = await import(engineSpecifier) as {
  importSpkiOrJwkPublicKey(material: string): Promise<Parameters<typeof globalThis.crypto.subtle.verify>[1]>;
  verifyCatalogEnvelope(envelope: unknown, bytes: Uint8Array, key: Parameters<typeof globalThis.crypto.subtle.verify>[1]): Promise<{ ok: boolean }>;
};
async function fixture(t: TestContext) {
  const pack = await fs.mkdtemp(join(tmpdir(), 'lw-catalog-startup-'));
  t.after(() => fs.rm(pack, { recursive: true, force: true }));
  await fs.mkdir(join(pack, 'tools/probe'), { recursive: true }); await fs.mkdir(join(pack, 'catalog/tools'), { recursive: true });
  const manifest = { id: 'probe', name: 'Probe', version: '1.0.0', engineVersion: '^1.0.0', status: 'official', inputs: [], hooks: { onInit: true },
    render: { width: 10, height: 10, formats: ['svg'] } };
  await fs.writeFile(join(pack, 'tools/probe/tool.json'), JSON.stringify(manifest));
  await fs.writeFile(join(pack, 'tools/probe/template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>');
  await fs.writeFile(join(pack, 'tools/probe/hooks.js'), '({onInit:()=>{}})');
  const index = Buffer.from(JSON.stringify({ tools: [manifest] })); await fs.writeFile(join(pack, 'catalog/tools/index.json'), index);
  const keys = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const material = JSON.stringify(keys.privateKey.export({ format: 'jwk' }));
  const publicMaterial = JSON.stringify(keys.publicKey.export({ format: 'jwk' }));
  const signer = createCatalogSigning(material);
  const envelope = await signer.envelopeFor(pack, { bytes: index, json: true, visible: () => true }, { seq: 7, catalogScope: 'a'.repeat(64) });
  const signaturePath = join(pack, 'catalog/tools/index.sig.json'); await fs.writeFile(signaturePath, envelope);
  return { pack, material, publicMaterial, signaturePath, envelope };
}
async function listen(t: TestContext, server: Server): Promise<string> {
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address === 'object'); return `http://127.0.0.1:${address.port}`;
}
async function eventuallyReady(base: string): Promise<void> {
  for (let i = 0; i < 100; i++) {
    if ((await fetch(base + '/readyz')).status === 200) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail('The exact source proof did not become ready');
}

test('slow signed startup holds readiness, first catalog reads and worker dispatch behind one source proof', { timeout: 10_000 }, async t => {
  const f = await fixture(t); let workerRequests = 0;
  const worker = await listen(t, createServer((req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      workerRequests++; const job = JSON.parse(body) as { brandRevision: string };
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ svg: '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10"/></svg>', brandRevision: job.brandRevision }));
    });
  }));
  let release!: () => void, entered!: () => void, sourceReads = 0, sourceToolReads = 0;
  const held = new Promise<void>(resolve => { release = resolve; }), started = new Promise<void>(resolve => { entered = resolve; });
  const signaturePath = await fs.realpath(f.signaturePath);
  const original = fs.readFile;
  const patched = mock.method(fs, 'readFile', (function (...args: Parameters<typeof fs.readFile>) {
    if (String(args[0]) === signaturePath) { sourceReads++; entered(); return held.then(() => Reflect.apply(original, fs, args)); }
    if (String(args[0]) === join(f.pack, 'tools/probe/template.html')) sourceToolReads++;
    return Reflect.apply(original, fs, args);
  }) as typeof fs.readFile);
  syncBuiltinESMExports();
  t.after(() => { release(); patched.mock.restore(); syncBuiltinESMExports(); });
  const store = createMemoryStore();
  const owner = await store.upsertUserBySub({ sub: 'startup-owner', email: 'owner@startup.invalid', groups: ['owner'], role: 'owner' });
  const cookie = mintSessionCookie({ sub: owner.sub, email: owner.email, name: 'Startup owner', groups: owner.groups, role: owner.role, epoch: owner.sessionEpoch }, 'startup-session', false).split(';')[0]!;
  const config = parseConfig(JSON.stringify({ instance: { name: 'Startup', pack: f.pack }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] },
    render: { allowHooksInFastPath: false, worker: { url: worker, timeoutMs: 20000 } }, policy: { defaultAccessMode: 'gated' } }));
  const base = await listen(t, createServer(buildApp({ config, store, secrets: { session: 'startup-session', link: 'startup-link', renderWorker: 'startup-worker', catalogSigningKey: f.material }, backgroundPollMs: 0 })));
  await started;
  assert.equal((await fetch(base + '/readyz')).status, 503);
  assert.equal((await fetch(base + '/healthz')).status, 200, 'Liveness remains independent of source verification');
  let catalogFinished = false, renderFinished = false;
  const catalog = fetch(base + '/catalog/tools/index.sig.json', { headers: { cookie } }).then(response => { catalogFinished = true; return response; });
  const render = fetch(base + '/api/v1/render', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'probe', format: 'svg', inputs: {} }) }).then(response => { renderFinished = true; return response; });
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.equal(catalogFinished, false); assert.equal(renderFinished, false); assert.equal(workerRequests, 0);
  assert.equal(sourceReads, 1, 'Concurrent first reads must share the startup publication verification');
  release(); await eventuallyReady(base);
  const response = await catalog; assert.equal(response.status, 200);
  const envelope = await response.json() as { indexHash: string };
  const index = Buffer.from(await (await fetch(base + '/catalog/tools/index.json', { headers: { cookie } })).arrayBuffer());
  assert.equal(sha256Hex(index), envelope.indexHash);
  assert.equal((await verifyCatalogEnvelope(envelope, index, await importSpkiOrJwkPublicKey(f.publicMaterial))).ok, true);
  const output = await render; assert.equal(output.status, 200, await output.clone().text()); assert.equal(workerRequests, 1);
  assert.equal(sourceReads, 1);
  assert.equal(sourceToolReads, 1, 'Startup and signature verification must share the complete immutable tool digest map');
});

test('a forged source signature never advertises readiness or dispatches a render', async t => {
  const f = await fixture(t), forged = JSON.parse(f.envelope.toString()); forged.seq = 900;
  await fs.writeFile(f.signaturePath, JSON.stringify(forged)); let workerRequests = 0;
  const worker = await listen(t, createServer((_req, res) => { workerRequests++; res.end('{}'); }));
  const store = createMemoryStore(), owner = await store.upsertUserBySub({ sub: 'refused-owner', email: 'owner@refused.invalid', groups: ['owner'], role: 'owner' });
  const cookie = mintSessionCookie({ sub: owner.sub, email: owner.email, name: 'Refused owner', groups: owner.groups, role: owner.role, epoch: owner.sessionEpoch }, 'refused-session', false).split(';')[0]!;
  const config = parseConfig(JSON.stringify({ instance: { name: 'Refused', pack: f.pack }, rateLimit: { enabled: false }, idp: { additional: [{ id: 'email', kind: 'password' }] },
    render: { worker: { url: worker, timeoutMs: 20000 } }, policy: { defaultAccessMode: 'gated' } }));
  const base = await listen(t, createServer(buildApp({ config, store, secrets: { session: 'refused-session', link: 'refused-link', renderWorker: 'refused-worker', catalogSigningKey: f.material }, backgroundPollMs: 0 })));
  const render = await fetch(base + '/api/v1/render', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: 'probe', format: 'svg', inputs: {} }) });
  assert.equal(render.status, 503); assert.match(await render.text(), /publication could not be verified/);
  for (let i = 0; i < 3; i++) assert.equal((await fetch(base + '/readyz')).status, 503);
  assert.equal((await fetch(base + '/catalog/tools/index.sig.json', { headers: { cookie } })).status, 503);
  assert.equal((await fetch(base + '/healthz')).status, 200); assert.equal(workerRequests, 0);
});

test('startup shares one promise and production refuses generation zero while preserving explicit unsigned development', async t => {
  const f = await fixture(t); await fs.rm(f.signaturePath);
  const servedIndex = { compositions: () => 0, forCaller: async () => { throw new Error('Startup must not compose a member feed'); } };
  const development = createCatalogDelivery({ store: createMemoryStore(), servedIndex, signing: null, source: { pack: f.pack } });
  const first = development.prepare(); assert.equal(development.prepare(), first); await first;
  const production = createCatalogDelivery({ store: createMemoryStore(), servedIndex, signing: null, source: { pack: f.pack }, requireGeneration: true });
  await assert.rejects(production.prepare(), /positive generation/);
  await assert.rejects(production.current(f.pack, { overlays: new Map(), groups: [] }), /positive generation/);
  const provisioned = createCatalogDelivery({ store: createMemoryStore(), servedIndex, signing: createCatalogSigning(f.material), source: { pack: f.pack, generation: 3000 }, requireGeneration: true });
  const ready = provisioned.prepare(); assert.equal(provisioned.prepare(), ready); await ready;
});

test('a contained legacy profile alias uses the physical mount boundary and an escaping alias is refused', async t => {
  const f = await fixture(t); await fs.rm(f.signaturePath);
  await fs.mkdir(join(f.pack, 'brands/alpha'), { recursive: true });
  await fs.rename(join(f.pack, 'catalog'), join(f.pack, 'brands/alpha/catalog'));
  await fs.symlink('brands/alpha/catalog', join(f.pack, 'catalog'));
  const alias = join(f.pack, 'mount-alias'); await fs.symlink('.', alias);
  const logical = await catalogPublication({ pack: f.pack, signing: null });
  assert.deepEqual(await catalogPublication({ pack: alias, signing: null }), logical,
    'Equivalent lexical and physical mount paths must have the same publication identity');
  const outside = await fs.mkdtemp(join(tmpdir(), 'lw-catalog-outside-'));
  t.after(() => fs.rm(outside, { recursive: true, force: true }));
  await fs.rm(join(f.pack, 'catalog')); await fs.symlink(outside, join(f.pack, 'catalog'));
  await assert.rejects(catalogPublication({ pack: f.pack, signing: null }));
});

test('the real ESM bundle binds the same pin and verified publication before readiness', { timeout: 15_000 }, async t => {
  const f = await fixture(t), directory = await fs.mkdtemp(join(tmpdir(), 'lw-catalog-bundle-'));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  // External packages stay borrowed; the pin itself must be bundled from the source.
  await fs.symlink(fileURLToPath(new URL('../node_modules', import.meta.url)), join(directory, 'node_modules'));
  const output = join(directory, 'app.mjs');
  const appSource = fileURLToPath(new URL('../server/src/api/app.ts', import.meta.url));
  const publicationSource = fileURLToPath(new URL('../server/src/catalog/publication.ts', import.meta.url));
  await build({ stdin: { contents: `export { buildApp } from ${JSON.stringify(appSource)}; export { catalogPublication } from ${JSON.stringify(publicationSource)};`,
    resolveDir: fileURLToPath(new URL('..', import.meta.url)) }, outfile: output, bundle: true, platform: 'node', format: 'esm', target: 'node24', packages: 'external',
    banner: { js: "import { createRequire as __lwCreateRequire } from 'node:module'; const require = __lwCreateRequire(import.meta.url);" } });
  const bundled = await import(pathToFileURL(output).href) as { buildApp: typeof buildApp; catalogPublication: typeof catalogPublication };
  assert.deepEqual(await bundled.catalogPublication({ pack: f.pack, signing: createCatalogSigning(f.material) }),
    await catalogPublication({ pack: f.pack, signing: createCatalogSigning(f.material) }));
  await assert.rejects(fs.access(join(directory, 'engine-pin.json')), { code: 'ENOENT' });
  const previousEnvironment = process.env.NODE_ENV; process.env.NODE_ENV = 'production';
  t.after(() => { if (previousEnvironment === undefined) delete process.env.NODE_ENV; else process.env.NODE_ENV = previousEnvironment; });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Bundled source', pack: f.pack }, deployment: { mode: 'evaluation' },
    idp: { additional: [{ id: 'email', kind: 'password' }] }, rateLimit: { enabled: false }, policy: { defaultAccessMode: 'gated' } }));
  const store = createMemoryStore(), owner = await store.upsertUserBySub({ sub: 'bundle-owner', email: 'owner@bundle.invalid', groups: ['owner'], role: 'owner' });
  const cookie = mintSessionCookie({ sub: owner.sub, email: owner.email, name: 'Bundle owner', groups: owner.groups, role: owner.role, epoch: owner.sessionEpoch }, 'bundle-session', false).split(';')[0]!;
  const options = { config, store, secrets: { session: 'bundle-session', link: 'bundle-link', catalogSigningKey: f.material }, backgroundPollMs: 0 };
  // The same store exercises the publication fence across both serving forms.
  for (const handler of [buildApp(options), bundled.buildApp(options)]) {
    const base = await listen(t, createServer(handler)); await eventuallyReady(base);
    const indexResponse = await fetch(base + '/catalog/tools/index.json', { headers: { cookie } }); assert.equal(indexResponse.status, 200);
    const index = Buffer.from(await indexResponse.arrayBuffer());
    const envelopeResponse = await fetch(base + '/catalog/tools/index.sig.json', { headers: { cookie } }); assert.equal(envelopeResponse.status, 200);
    const envelope = await envelopeResponse.json() as { indexHash: string };
    assert.equal(envelope.indexHash, sha256Hex(index));
    assert.equal((await verifyCatalogEnvelope(envelope, index, await importSpkiOrJwkPublicKey(f.publicMaterial))).ok, true);
  }
});
