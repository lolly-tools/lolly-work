// SPDX-License-Identifier: MPL-2.0
/**
 * Sending a finished render from the organisation MCP endpoint. The tool runs the same
 * route as HTTP, so this pins what an agent sees: the tools only with the `delivery`
 * scope, the route's own refusal by name without it, a real send, and plain words when
 * a person has to decide.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { createRouter, sendJson } from '../server/src/api/router.ts';
import { ORG_TOOLS, registerOrgMcp } from '../server/src/automation/org-mcp.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { routeScopes } from '../server/src/iam/token-scopes.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import { newRender, parseRenderSpec } from '../server/src/renders/request.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { ApiTokenRecord } from '../server/src/store/types.ts';

const engineSpec: string = '@lolly/engine';
const PROTOCOL = '2025-11-25';
let signedExport: Uint8Array;
let pack: string;
let base: string;
let server: Server;
let owner: string;
const store = createMemoryStore();
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
  const leaf = await eng.issueLeafCert({ caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer, email: 'delivery@test.invalid', organization: 'Delivery Test', days: 90 });
  const signer = await buildSigner(eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'), eng.derToPem(keyDer, 'PRIVATE KEY'), 'Lolly Delivery Test');
  const { Resvg } = await import('@resvg/resvg-js');
  const png = new Uint8Array(new Resvg('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#30ba78"/></svg>').render().asPng());
  signedExport = await eng.embedC2pa(png, 'png', { signer, title: 'delivery-test', claimGenerator: 'Lolly Delivery Test' });

  pack = await mkdtemp(join(tmpdir(), 'lw-org-mcp-delivery-'));
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
    instance: { name: 'MCP delivery', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }] },
    delivery: { maxBytes: 2 * 1024 * 1024, destinations: [
      { id: 'archive', kind: 's3', label: 'Campaign archive', credentialRef: 'PRIVATE_ARCHIVE_KEY', enabled: true, groups: ['marketing'], formats: ['png'],
        options: { bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1', prefix: 'archive' } },
      { id: 'reviewed', kind: 's3', label: 'Reviewed release', credentialRef: 'PRIVATE_REVIEWED_KEY', enabled: true, groups: ['marketing'], formats: ['png'], approvalChain: 'delivery-review',
        options: { bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1', prefix: 'reviewed' } },
    ] },
  }));
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
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
    steps: [{ name: 'Review', approvers: { groups: ['owner'] }, rule: 'any' }] });
  const app = buildApp({ config, store, blobs, fetchImpl,
    secrets: { session: 'test-session', link: 'test-link' },
    destinationSecrets: new Map([['archive', 'access:secret'], ['reviewed', 'access:secret']]),
    onRenderRunner: (runner) => { runner.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  base = `http://127.0.0.1:${address.port}`;
  const login = await fetch(`${base}/api/auth/dev?email=owner@test`, { redirect: 'manual' });
  owner = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
});
after(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(pack, { recursive: true, force: true });
});

/** A token, with a grant for both destinations: tokens hold no groups of their own. */
async function mint(scopes: string[]) {
  const res = await fetch(`${base}/api/v1/tokens`, { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'agent', scopes }) });
  assert.equal(res.status, 201, await res.clone().text());
  const token = await res.json() as { id: string; token: string };
  await store.putGrant({ principal: `user:svc_${token.id}`, action: 'delivery.create', resource: '*', effect: 'allow' });
  return token;
}

/** A finished, signed durable render owned by this token, as the runner would leave it. */
async function finishedRender(tokenId: string): Promise<string> {
  const saved = (await store.insertRender(newRender(`service:svc_${tokenId}`, parseRenderSpec({ toolId: 'card', format: 'png', inputs: {} })))).record;
  const claim = (await store.claimRender(10_000))!;
  assert.equal(claim.id, saved.id);
  const ref = `renders/${saved.id}/attempt-1-${claim.leaseToken}`;
  await blobs.put(ref, signedExport, 'image/png');
  await store.settleRender(saved.id, claim.leaseToken!, { state: 'succeeded', output: {
    name: 'default', ref, mime: 'image/png', size: signedExport.byteLength, sha256: sha256Hex(signedExport), cacheKey: 'key',
  } });
  return saved.id;
}

const rpc = async (token: string, method: string, params?: unknown) => {
  const res = await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'mcp-protocol-version': PROTOCOL },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, ...(params === undefined ? {} : { params }) }) });
  return await res.json() as { result?: Record<string, any>; error?: { code: number; message: string } };
};
const toolNames = async (token: string) => ((await rpc(token, 'tools/list')).result!.tools as Array<{ name: string }>).map((tool) => tool.name);
const call = async (token: string, name: string, args: unknown = {}) => {
  const { result } = await rpc(token, 'tools/call', { name, arguments: args });
  assert.ok(result);
  return { isError: result.isError === true, value: JSON.parse((result.content as Array<{ text: string }>)[0]!.text) as Record<string, any> };
};

test('both tools mirror a route the scope table gives to the delivery scope', () => {
  for (const name of ['deliver_render', 'list_destinations']) {
    const tool = ORG_TOOLS.find((candidate) => candidate.name === name);
    assert.ok(tool, name);
    assert.deepEqual(routeScopes(tool.route.method, tool.route.path), ['delivery']);
    assert.equal(tool.needs, 'delivery.create');
  }
});

test('without the delivery scope the tools are absent, and refused by name', async () => {
  const { id, token } = await mint(['render']);
  const listed = await toolNames(token);
  assert.equal(listed.includes('deliver_render'), false);
  assert.equal(listed.includes('list_destinations'), false);
  assert.equal(listed.includes('render_tool'), true);
  const renderId = await finishedRender(id);
  const refused = await call(token, 'deliver_render', { renderId, destinationId: 'archive', name: 'card.png' });
  assert.equal(refused.isError, true);
  assert.equal(refused.value.code, 'TOKEN_SCOPE');
  assert.equal((await call(token, 'list_destinations')).value.code, 'TOKEN_SCOPE');
  assert.equal(objects.size, 0, 'nothing was sent');
});

test('with the scope, an agent names a target and sends the file by reference', async () => {
  const { id, token } = await mint(['render', 'delivery']);
  const listed = await toolNames(token);
  assert.ok(listed.includes('deliver_render') && listed.includes('list_destinations'));
  const destinations = await call(token, 'list_destinations');
  assert.deepEqual(destinations.value.destinations.map((d: { id: string }) => d.id).sort(), ['archive', 'reviewed']);
  assert.doesNotMatch(JSON.stringify(destinations.value), /private-bucket|PRIVATE_|objects\.invalid/, 'no credential or endpoint reaches a token');
  const renderId = await finishedRender(id);
  const sent = await call(token, 'deliver_render', { renderId, destinationId: 'archive', name: 'card.png', idempotencyKey: 'once' });
  assert.equal(sent.isError, false, JSON.stringify(sent.value));
  assert.equal(sent.value.state, 'delivered');
  assert.equal(sent.value.sourceRenderId, renderId);
  assert.equal(sent.value.sha256, sha256Hex(signedExport));
  assert.equal(objects.size, 1);
  assert.deepEqual([...objects.values()][0], signedExport);
  const replay = await call(token, 'deliver_render', { renderId, destinationId: 'archive', name: 'card.png', idempotencyKey: 'once' });
  assert.equal(replay.value.id, sent.value.id, 'the same key is the same delivery');
  assert.equal(objects.size, 1);
});

test('the delivery scope alone can list targets, but sending needs the render scope too', async () => {
  // The route checks the token's current right to the render's tool, and a token that
  // cannot render never owns a render, so the tool is not offered.
  const { id, token } = await mint(['delivery']);
  assert.deepEqual(await toolNames(token), ['list_destinations']);
  const before = objects.size;
  const renderId = await finishedRender(id);
  const refused = await call(token, 'deliver_render', { renderId, destinationId: 'archive', name: 'alone.png' });
  assert.equal(refused.isError, true);
  assert.equal(refused.value.code, 'FORBIDDEN');
  assert.equal(objects.size, before);
});

test('a render this token does not own is not found, and the route checks its arguments', async () => {
  const { token } = await mint(['render', 'delivery']);
  const other = await mint(['render', 'delivery']);
  const renderId = await finishedRender(other.id);
  assert.equal((await call(token, 'deliver_render', { renderId, destinationId: 'archive', name: 'card.png' })).value.code, 'NOT_FOUND');
  assert.equal((await call(token, 'deliver_render', { renderId, destinationId: 'nowhere', name: 'card.png' })).value.code, 'NOT_FOUND');
  assert.equal((await call(token, 'deliver_render', { renderId, destinationId: 'archive' })).value.code, 'INVALID_INPUT');
});

test('a destination that needs a person answers in plain words, and sends nothing', async () => {
  const { id, token } = await mint(['render', 'delivery']);
  const before = objects.size;
  const renderId = await finishedRender(id);
  const refused = await call(token, 'deliver_render', { renderId, destinationId: 'reviewed', name: 'card.png' });
  assert.equal(refused.isError, true);
  assert.equal(refused.value.code, 'HUMAN_APPROVAL_REQUIRED');
  assert.equal(refused.value.status, 403);
  assert.match(refused.value.message, /needs a person/);
  assert.match(refused.value.message, /Nothing was sent/);
  assert.equal(objects.size, before);
  assert.equal((await store.listApprovals()).length, 0, 'a token raises no approval');
});

test('a delivery already waiting on a person says so', async () => {
  // The route refuses tokens first today, so this pins the wording if a delivery ever
  // reaches this tool in that state.
  const router = createRouter();
  router.add('POST', '/api/v1/renders/:id/deliveries', (_req, res) => { sendJson(res, 202, { id: 'del_1', state: 'awaiting-approval' }); });
  router.add('GET', '/api/v1/discovery/me', (_req, res) => { sendJson(res, 200, { can: { 'delivery.create': true } }); });
  registerOrgMcp({ router, origin: 'http://localhost', durableRenders: true, audit: async () => undefined,
    tokenOf: async () => ({ record: { id: 't', label: 'agent' } as ApiTokenRecord, user: { id: 'svc_t' } }) });
  const stub = createServer((req: IncomingMessage, res: ServerResponse) => void router.dispatch(req, res));
  await new Promise<void>((resolve) => stub.listen(0, '127.0.0.1', resolve));
  const address = stub.address(); assert.ok(address && typeof address === 'object');
  const res = await fetch(`http://127.0.0.1:${address.port}/api/v1/mcp`, { method: 'POST', headers: { authorization: 'Bearer x', 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name: 'deliver_render', arguments: { renderId: 'rnd_1', destinationId: 'archive', name: 'card.png' } } }) });
  const body = await res.json() as { result: { structuredContent: { state: string; note: string } } };
  await new Promise<void>((resolve) => stub.close(() => resolve()));
  assert.equal(body.result.structuredContent.state, 'awaiting-approval');
  assert.match(body.result.structuredContent.note, /waiting for a person/);
  assert.match(body.result.structuredContent.note, /Nothing has been sent/);
});
