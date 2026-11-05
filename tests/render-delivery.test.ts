// SPDX-License-Identifier: MPL-2.0
/**
 * Sending a durable render to an organisation destination by reference. It shares
 * the job route's code, so this file pins what must hold for a render: the same
 * permission, signed-export and approval rules, with the render's own grants on top.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

const engineSpec: string = '@lolly/engine';
let signedExport: Uint8Array;
let plainPng: Uint8Array;
let pack: string;
let base: string;
let server: Server;
let putCount = 0;
const store = createMemoryStore({ grants: [{ principal: 'group:delivery-reviewers', action: 'approval.act', resource: '*', effect: 'allow' }] });
const blobs = createMemoryBlobStore();
const objects = new Map<string, Uint8Array>();

before(async () => {
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Delivery Root', organization: 'Delivery Test', days: 3650 });
  const pair = await webcrypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify']) as {
    publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1];
  };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'delivery@test.invalid', organization: 'Delivery Test', days: 365 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'Lolly Delivery Test');
  const { Resvg } = await import('@resvg/resvg-js');
  plainPng = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#30ba78"/></svg>').render().asPng());
  signedExport = await eng.embedC2pa(plainPng, 'png', { signer, title: 'delivery-test', claimGenerator: 'Lolly Delivery Test' });

  pack = await mkdtemp(join(tmpdir(), 'lw-render-delivery-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(pack, 'tools', 'card'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: 'card' }] }));
  await writeFile(join(pack, 'tools', 'card', 'tool.json'), JSON.stringify({
    id: 'card', name: 'Card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 16, height: 16, formats: ['svg', 'png'] }, inputs: [],
  }));
  await writeFile(join(pack, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="16" height="16"/>');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Render delivery', baseUrl: 'http://localhost', pack },
    policy: { defaultAccessMode: 'open' }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'maker@test', groups: ['admin', 'marketing'] },
      { email: 'other@test', groups: ['admin', 'marketing'] },
      { email: 'reviewer@test', groups: ['delivery-reviewers'] },
    ] },
    delivery: { maxBytes: 2 * 1024 * 1024, destinations: [
      { id: 'archive', kind: 's3', label: 'Campaign archive', credentialRef: 'PRIVATE_ARCHIVE_KEY', enabled: true, groups: ['marketing'], formats: ['png'],
        options: { bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1', prefix: 'archive' } },
      { id: 'reviewed', kind: 's3', label: 'Reviewed release', credentialRef: 'PRIVATE_REVIEWED_KEY', enabled: true, groups: ['marketing'], formats: ['png'], approvalChain: 'delivery-review',
        options: { bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1', prefix: 'reviewed' } },
      { id: 'svg-only', kind: 's3', label: 'Vector shelf', credentialRef: 'PRIVATE_ARCHIVE_KEY', enabled: true, groups: ['marketing'], formats: ['svg'],
        options: { bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1', prefix: 'vector' } },
    ] },
  }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      putCount++;
      objects.set(url, new Uint8Array(await new Response(init?.body).arrayBuffer()));
      return new Response(null, { status: 200 });
    }
    if (method === 'HEAD') {
      const object = objects.get(url);
      return object ? new Response(null, { status: 200, headers: { 'content-length': String(object.byteLength) } }) : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 404 });
  }) as typeof fetch;
  await store.putChain({ id: 'delivery-review', name: 'Delivery review', onReject: 'return-to-submitter',
    steps: [{ name: 'Review', approvers: { groups: ['delivery-reviewers'] }, rule: 'any' }] });
  const app = buildApp({ config, store, blobs, fetchImpl,
    secrets: { session: 'test-session', link: 'test-link' },
    destinationSecrets: new Map([['archive', 'access:secret'], ['reviewed', 'access:secret'], ['svg-only', 'access:secret']]),
    onRenderRunner: (runner) => { runner.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(pack, { recursive: true, force: true });
});

const login = async (email: string): Promise<string> =>
  (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
const userId = async (email: string): Promise<string> => (await store.listUsers()).find((u) => u.email === email)!.id;

/** A finished durable render holding `bytes`, as the runner would leave it. */
async function finishedRender(principal: string, bytes: Uint8Array): Promise<string> {
  const saved = (await store.insertRender(newRender(principal, parseRenderSpec({ toolId: 'card', format: 'png', inputs: {} })))).record;
  const claim = (await store.claimRender(10_000))!;
  assert.equal(claim.id, saved.id);
  const ref = `renders/${saved.id}/attempt-1-${claim.leaseToken}`;
  await blobs.put(ref, bytes, 'image/png');
  await store.settleRender(saved.id, claim.leaseToken!, { state: 'succeeded', output: {
    name: 'default', ref, mime: 'image/png', size: bytes.byteLength, sha256: sha256Hex(bytes), cacheKey: 'key',
  } });
  return saved.id;
}
const deliver = (id: string, cookie: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Promise<Response> =>
  fetch(`${base}/api/v1/renders/${id}/deliveries`, { method: 'POST', headers: { cookie, 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
const code = async (res: Response): Promise<string> => (await res.json() as { error: { code: string } }).error.code;

test('a finished render goes to a destination by reference, once per idempotency key', async () => {
  const cookie = await login('maker@test');
  const id = await finishedRender(`user:${await userId('maker@test')}`, signedExport);
  const before = putCount;
  const sent = await deliver(id, cookie, { destinationId: 'archive', name: 'Render output' }, { 'idempotency-key': 'render-once' });
  assert.equal(sent.status, 201, await sent.clone().text());
  const delivery = await sent.json() as { id: string; state: string; sourceRenderId: string; sourceJobId: string | null; sha256: string };
  assert.equal(delivery.state, 'delivered');
  assert.equal(delivery.sourceRenderId, id);
  assert.equal(delivery.sourceJobId, null);
  assert.equal(delivery.sha256, sha256Hex(signedExport));
  assert.equal(putCount, before + 1);
  assert.equal(await blobs.head(`delivery/${delivery.id}/source`), null, 'the delivery references the render bytes instead of copying them');

  const replay = await deliver(id, cookie, { destinationId: 'archive', name: 'Render output' }, { 'idempotency-key': 'render-once' });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, delivery.id);
  assert.equal(putCount, before + 1, 'a replay writes nothing');
  const changed = await deliver(id, cookie, { destinationId: 'archive', name: 'Another name' }, { 'idempotency-key': 'render-once' });
  assert.equal(changed.status, 409);
  assert.equal(await code(changed), 'IDEMPOTENCY_KEY_REUSED');

  const stored = await store.getDelivery(delivery.id, `user:${await userId('maker@test')}`);
  assert.equal(stored?.sourceRenderId, id);
  assert.equal(stored?.sourceJobId, undefined);
});

test('the rules of a job delivery hold for a render', async () => {
  const cookie = await login('maker@test');
  const principal = `user:${await userId('maker@test')}`;
  const id = await finishedRender(principal, signedExport);

  const other = await deliver(id, await login('other@test'), { destinationId: 'archive', name: 'Not theirs' });
  assert.equal(other.status, 404, 'another caller cannot infer or send this render');

  const wrongFormat = await deliver(id, cookie, { destinationId: 'archive', name: 'Mismatch', format: 'jpg' });
  assert.equal(wrongFormat.status, 409);
  assert.equal(await code(wrongFormat), 'OUTPUT_FORMAT_MISMATCH');
  const refused = await deliver(id, cookie, { destinationId: 'svg-only', name: 'Wrong shelf' });
  assert.equal(refused.status, 415);

  const unsigned = await finishedRender(principal, plainPng);
  const gate = await deliver(unsigned, cookie, { destinationId: 'archive', name: 'Unsigned' });
  assert.equal(gate.status, 422, 'only a signed Lolly export may leave');
  assert.equal(await code(gate), 'NOT_LOLLY_EXPORT');

  const output = (await store.getRender(id, principal))!.output!;
  await blobs.put(output.ref, plainPng, 'image/png');
  const corrupt = await deliver(id, cookie, { destinationId: 'archive', name: 'Corrupt' });
  assert.equal(corrupt.status, 409);
  assert.equal(await code(corrupt), 'OUTPUT_INTEGRITY');
  await blobs.delete(output.ref);
  const gone = await deliver(id, cookie, { destinationId: 'archive', name: 'Gone' });
  assert.equal(gone.status, 410);
  assert.equal(await code(gone), 'OUTPUT_UNAVAILABLE');

  const queued = (await store.insertRender(newRender(principal, parseRenderSpec({ toolId: 'card', format: 'png', inputs: {} })))).record;
  const early = await deliver(queued.id, cookie, { destinationId: 'archive', name: 'Too soon' });
  assert.equal(early.status, 409);
  assert.equal(await code(early), 'RENDER_NOT_SUCCEEDED');
  await store.cancelRender(queued.id, principal);
  assert.equal((await deliver(id, cookie, { destinationId: 'nowhere', name: 'x' })).status, 404);
  assert.equal((await deliver(id, cookie, { name: 'No destination' })).status, 400);
});

test('a destination with a chain waits for a person, and delivers the render after approval', async () => {
  const cookie = await login('maker@test');
  const reviewer = await login('reviewer@test');
  const id = await finishedRender(`user:${await userId('maker@test')}`, signedExport);
  const before = putCount;
  const staged = await deliver(id, cookie, { destinationId: 'reviewed', name: 'Reviewed render' });
  assert.equal(staged.status, 202, await staged.clone().text());
  const delivery = await staged.json() as { id: string; state: string; approvalId: string; sourceRenderId: string };
  assert.equal(delivery.state, 'awaiting-approval');
  assert.equal(delivery.sourceRenderId, id);
  assert.equal(putCount, before, 'nothing leaves before the decision');
  const decided = await fetch(`${base}/api/v1/approvals/${delivery.approvalId}/act`, {
    method: 'POST', headers: { cookie: reviewer, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(decided.status, 200, await decided.clone().text());
  const after = await (await fetch(`${base}/api/v1/deliveries/${delivery.id}`, { headers: { cookie } })).json() as { state: string };
  assert.equal(after.state, 'delivered');
  assert.equal(putCount, before + 1);
});

test('a render owner who lost the tool cannot send its output', async () => {
  const cookie = await login('other@test');
  const owner = await userId('other@test');
  const id = await finishedRender(`user:${owner}`, signedExport);
  await store.putGrant({ principal: `user:${owner}`, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
  const refused = await deliver(id, cookie, { destinationId: 'archive', name: 'After the grant went' });
  assert.equal(refused.status, 403);
  await store.deleteGrant({ principal: `user:${owner}`, action: 'tool.use', resource: 'tool:card', effect: 'deny' });
});
