// SPDX-License-Identifier: MPL-2.0
/** End-to-end organization delivery: safe discovery, C2PA gate, durable receipt,
 * principal isolation, idempotency, retry, grants, and audit. */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { webcrypto } from 'node:crypto';
import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildApp } from '../server/src/api/app.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { hashServiceSecret } from '../server/src/iam/service-tokens.ts';
import { sha256Hex } from '../server/src/lib/crypto.ts';
import { buildSigner } from '../server/src/render/c2pa-signer.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let blobs: ReturnType<typeof createMemoryBlobStore>;
let signedExport: Uint8Array;
let plainPng: Uint8Array;
let failNextPut = false;
let putCount = 0;
let deliveredId = '';
const objects = new Map<string, Uint8Array>();
const engineSpec: string = '@lolly/engine';

before(async () => {
  const eng = await import(engineSpec) as {
    generateCaRoot: (o: object) => Promise<{ certDer: Uint8Array; pkcs8Der: Uint8Array }>;
    issueLeafCert: (o: object) => Promise<Uint8Array>;
    derToPem: (der: Uint8Array, label: string) => string;
    embedC2pa: (b: Uint8Array, f: string, o: object) => Promise<Uint8Array>;
  };
  const root = await eng.generateCaRoot({ commonName: 'Delivery Root', organization: 'Delivery Test', days: 3650 });
  const pair = await webcrypto.subtle.generateKey(
    { name: 'ECDSA', namedCurve: 'P-256' }, true, ['sign', 'verify'],
  ) as { publicKey: Parameters<typeof webcrypto.subtle.exportKey>[1]; privateKey: Parameters<typeof webcrypto.subtle.exportKey>[1] };
  const spkiDer = new Uint8Array(await webcrypto.subtle.exportKey('spki', pair.publicKey));
  const keyDer = new Uint8Array(await webcrypto.subtle.exportKey('pkcs8', pair.privateKey));
  const leaf = await eng.issueLeafCert({
    caCertDer: root.certDer, caPrivateKey: root.pkcs8Der, spkiDer,
    email: 'delivery@test.invalid', organization: 'Delivery Test', days: 365,
  });
  const signer = await buildSigner(
    eng.derToPem(leaf, 'CERTIFICATE') + eng.derToPem(root.certDer, 'CERTIFICATE'),
    eng.derToPem(keyDer, 'PRIVATE KEY'),
    'Lolly Delivery Test',
  );
  const { Resvg } = await import('@resvg/resvg-js');
  plainPng = new Uint8Array(new Resvg(
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 16 16"><rect width="16" height="16" fill="#30ba78"/></svg>',
  ).render().asPng());
  signedExport = await eng.embedC2pa(plainPng, 'png', {
    signer: { privateKey: signer.privateKey, certDer: signer.certDer, chain: signer.chain },
    title: 'delivery-test', claimGenerator: 'Lolly Delivery Test',
  });

  const pack = await mkdtemp(join(tmpdir(), 'lw-delivery-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Delivery Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'maker@test', groups: ['marketing'] },
      { email: 'outsider@test', groups: ['sales'] },
      { email: 'reviewer@test', groups: ['delivery-reviewers'] },
    ] },
    delivery: {
      maxBytes: 2 * 1024 * 1024,
      destinations: [{
        id: 'archive', kind: 's3', label: 'Campaign archive', credentialRef: 'PRIVATE_ARCHIVE_KEY',
        enabled: true, groups: ['marketing'], formats: ['png'], maxBytes: 1024 * 1024,
        options: {
          bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1',
          prefix: 'archive/approved', publicBaseUrl: 'https://files.invalid',
        },
      }, {
        id: 'reviewed', kind: 's3', label: 'Reviewed release', credentialRef: 'PRIVATE_REVIEWED_KEY',
        enabled: true, groups: ['marketing'], formats: ['png'], maxBytes: 1024 * 1024,
        approvalChain: 'delivery-review',
        options: {
          bucket: 'private-bucket', endpoint: 'https://objects.invalid', region: 'test-1',
          prefix: 'reviewed',
        },
      }],
    },
  }));

  const fakeFetch: typeof fetch = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? 'GET';
    if (method === 'PUT') {
      putCount++;
      if (failNextPut) {
        failNextPut = false;
        return new Response(null, { status: 503 });
      }
      const bytes = new Uint8Array(await new Response(init?.body).arrayBuffer());
      objects.set(url, bytes);
      return new Response(null, { status: 200 });
    }
    if (method === 'HEAD') {
      const object = objects.get(url);
      return object
        ? new Response(null, { status: 200, headers: { 'content-length': String(object.byteLength) } })
        : new Response(null, { status: 404 });
    }
    return new Response(null, { status: 500 });
  };
  store = createMemoryStore();
  await store.putChain({
    id: 'delivery-review', name: 'Delivery review', onReject: 'return-to-submitter',
    steps: [{ name: 'Brand sign-off', approvers: { groups: ['delivery-reviewers'] }, rule: 'any' }],
  });
  blobs = createMemoryBlobStore();
  const app = buildApp({
    config,
    store,
    blobs,
    secrets: { session: 'delivery-session', link: 'delivery-link' },
    destinationSecrets: new Map([['archive', 'access:secret'], ['reviewed', 'access:reviewed-secret']]),
    fetchImpl: fakeFetch,
  });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const address = server.address();
  base = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const response = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(response.status, 302);
  return response.headers.getSetCookie().find((cookie) => cookie.startsWith('lw_session='))!.split(';')[0]!;
}

function deliver(cookie: string, name: string, bytes: Uint8Array, idempotencyKey?: string, destination = 'archive'): Promise<Response> {
  return fetch(`${base}/api/v1/destinations/${destination}/deliveries?name=${encodeURIComponent(name)}&format=png`, {
    method: 'POST',
    headers: {
      cookie,
      'content-type': 'image/png',
      ...(idempotencyKey ? { 'idempotency-key': idempotencyKey } : {}),
    },
    body: bytes,
  });
}

test('(a) discovery is caller-filtered and reveals no S3 configuration or credential references', async () => {
  const maker = await login('maker@test');
  const response = await fetch(`${base}/api/v1/org-config`, { headers: { cookie: maker } });
  const raw = await response.text();
  const payload = JSON.parse(raw) as { can: Record<string, boolean>; destinations: Array<Record<string, unknown>> };
  assert.equal(payload.can['delivery.create'], true);
  assert.deepEqual(payload.destinations, [{
    id: 'archive', kind: 's3', label: 'Campaign archive', formats: ['png'],
    maxBytes: 1024 * 1024, visibility: 'public',
  }, {
    id: 'reviewed', kind: 's3', label: 'Reviewed release', formats: ['png'],
    maxBytes: 1024 * 1024, visibility: 'private',
  }]);
  for (const secretFact of ['private-bucket', 'objects.invalid', 'archive/approved', 'PRIVATE_ARCHIVE_KEY', 'PRIVATE_REVIEWED_KEY', 'delivery-review']) {
    assert.equal(raw.includes(secretFact), false, `${secretFact} must not cross org-config`);
  }

  const outsider = await login('outsider@test');
  const outsiderConfig = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie: outsider } })).json() as { destinations: unknown[] };
  assert.deepEqual(outsiderConfig.destinations, []);
  const listed = await (await fetch(`${base}/api/v1/destinations`, { headers: { cookie: outsider } })).json() as { destinations: unknown[] };
  assert.deepEqual(listed.destinations, []);
});

test('(b) unsigned bytes and a caller outside destination exposure are refused', async () => {
  const maker = await login('maker@test');
  const unsigned = await deliver(maker, 'plain', plainPng);
  assert.equal(unsigned.status, 422);
  assert.equal((await unsigned.json() as { error: { code: string } }).error.code, 'NOT_LOLLY_EXPORT');
  const makerId = (await store.listUsers()).find((user) => user.email === 'maker@test')!.id;
  assert.equal((await store.listDeliveries(`user:${makerId}`)).length, 0);

  const outsider = await login('outsider@test');
  assert.equal((await deliver(outsider, 'hidden', signedExport)).status, 404);
});

test('(c) a signed export produces a durable receipt; replay is idempotent and principal-isolated', async () => {
  const maker = await login('maker@test');
  const first = await deliver(maker, 'Launch poster', signedExport, 'idem-delivery-1');
  assert.equal(first.status, 201);
  const body = await first.json() as Record<string, unknown>;
  deliveredId = String(body.id);
  assert.equal(body.state, 'delivered');
  assert.equal(body.attempt, 1);
  assert.match(String(body.remoteId), /^archive\/approved\/del_[^/]+\/[a-f0-9]{16}-Launch poster\.png$/);
  assert.match(String(body.url), /^https:\/\/files\.invalid\/archive\/approved\//);
  assert.equal(body.transformation, 'none');
  assert.equal(body.deliveredSha256, body.sha256);
  for (const privateField of ['principal', 'requestHash', 'sourceRef', 'idempotencyKey']) {
    assert.equal(Object.hasOwn(body, privateField), false, `${privateField} stays server-side`);
  }
  const count = putCount;
  const replay = await deliver(maker, 'Launch poster', signedExport, 'idem-delivery-1');
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, body.id);
  assert.equal(putCount, count, 'idempotent replay performs no second PUT');

  const mine = await (await fetch(`${base}/api/v1/deliveries`, { headers: { cookie: maker } })).json() as { deliveries: Array<{ id: string }> };
  assert.deepEqual(mine.deliveries.map((delivery) => delivery.id), [body.id]);
  const outsider = await login('outsider@test');
  assert.equal((await fetch(`${base}/api/v1/deliveries/${body.id}`, { headers: { cookie: outsider } })).status, 404);
  assert.equal((await deliver(maker, 'Changed name', signedExport, 'idem-delivery-1')).status, 409);

  const audit = await store.listAudit();
  assert.ok(audit.some((event) => event.action === 'delivery.created' && event.subject === `delivery:${body.id}`));
  assert.ok(audit.some((event) => event.action === 'delivery.delivered' && event.subject === `delivery:${body.id}`));
});

test('(d) failed delivery retains immutable source bytes and retries the same delivery/key', async () => {
  const maker = await login('maker@test');
  failNextPut = true;
  const failedResponse = await deliver(maker, 'Retry poster', signedExport, 'idem-delivery-retry');
  assert.equal(failedResponse.status, 502);
  const failed = (await failedResponse.json() as { error: { delivery: { id: string; state: string; attempt: number } } }).error.delivery;
  assert.equal(failed.state, 'failed');
  assert.equal(failed.attempt, 1);

  const retry = await fetch(`${base}/api/v1/deliveries/${failed.id}/retry`, { method: 'POST', headers: { cookie: maker } });
  assert.equal(retry.status, 200);
  const delivered = await retry.json() as { id: string; state: string; attempt: number };
  assert.equal(delivered.id, failed.id);
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.attempt, 2);

  failNextPut = true;
  const lostResponse = await deliver(maker, 'Lost source', signedExport, 'idem-delivery-lost-source');
  assert.equal(lostResponse.status, 502);
  const lost = (await lostResponse.json() as { error: { delivery: { id: string } } }).error.delivery;
  const makerId = (await store.listUsers()).find((user) => user.email === 'maker@test')!.id;
  const record = await store.getDelivery(lost.id, `user:${makerId}`);
  assert.ok(record);
  await blobs.delete(record.sourceRef);
  const unavailable = await fetch(`${base}/api/v1/deliveries/${lost.id}/retry`, { method: 'POST', headers: { cookie: maker } });
  assert.equal(unavailable.status, 502);
  const unavailableDelivery = (await unavailable.json() as { error: { delivery: { state: string; attempt: number; error: string } } }).error.delivery;
  assert.equal(unavailableDelivery.state, 'failed');
  assert.equal(unavailableDelivery.attempt, 2);
  assert.match(unavailableDelivery.error, /source bytes are unavailable/);
});

test('(e) automation publishes its retained render by reference under the token\'s destination grant', async () => {
  const rawToken = 'lwt_delivery_viewer_test';
  const now = new Date().toISOString();
  await store.putApiToken({
    id: 'tok_delivery_viewer', label: 'delivery viewer', role: 'viewer',
    tokenHash: hashServiceSecret(rawToken), createdBy: 'user:test-owner', createdAt: now,
  });
  await store.putGrant({
    principal: 'user:svc_tok_delivery_viewer', action: 'delivery.create',
    resource: 'destination:archive', effect: 'allow',
  });
  const headers = { authorization: `Bearer ${rawToken}` };
  const listed = await (await fetch(`${base}/api/v1/destinations`, { headers })).json() as { destinations: Array<{ id: string }> };
  assert.deepEqual(listed.destinations.map((destination) => destination.id), ['archive']);
  const sent = await fetch(`${base}/api/v1/destinations/archive/deliveries?name=Automation&format=png`, {
    method: 'POST', headers: { ...headers, 'content-type': 'image/png' }, body: signedExport,
  });
  assert.equal(sent.status, 201);
  const history = await (await fetch(`${base}/api/v1/deliveries`, { headers })).json() as { deliveries: Array<{ id: string }> };
  assert.equal(history.deliveries.length, 1);

  const jobId = 'job_delivery_output';
  const resultRef = `automation/${jobId}/result`;
  await blobs.put(resultRef, signedExport, 'image/png');
  await store.putAutomationJob({
    id: jobId,
    principal: 'service:svc_tok_delivery_viewer',
    verb: 'render',
    request: { toolId: 'poster', format: 'png' },
    state: 'done',
    resultRef,
    resultMime: 'image/png',
    resultSha256: sha256Hex(signedExport),
    priority: 0,
    attempt: 1,
    createdAt: now,
    updatedAt: now,
    finishedAt: now,
  });
  const beforePublish = putCount;
  const publish = await fetch(`${base}/api/v1/jobs/${jobId}/deliveries`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'job-publish-once' },
    body: JSON.stringify({ destinationId: 'archive', name: 'Automation output' }),
  });
  assert.equal(publish.status, 201);
  const published = await publish.json() as { id: string; sourceJobId: string; state: string };
  assert.equal(published.sourceJobId, jobId);
  assert.equal(published.state, 'delivered');
  assert.equal(putCount, beforePublish + 1);
  assert.equal(await blobs.head(`delivery/${published.id}/source`), null,
    'job publishing references its immutable result instead of copying it');
  assert.ok(await blobs.head(resultRef));

  const replay = await fetch(`${base}/api/v1/jobs/${jobId}/deliveries`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'job-publish-once' },
    body: JSON.stringify({ destinationId: 'archive', name: 'Automation output' }),
  });
  assert.equal(replay.status, 200);
  assert.equal((await replay.json() as { id: string }).id, published.id);
  assert.equal(putCount, beforePublish + 1, 'job publish replay performs no second provider write');

  await blobs.put(resultRef, plainPng, 'image/png');
  const corrupted = await fetch(`${base}/api/v1/jobs/${jobId}/deliveries`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json', 'idempotency-key': 'job-publish-corrupt' },
    body: JSON.stringify({ destinationId: 'archive', name: 'Corrupt output' }),
  });
  assert.equal(corrupted.status, 409);
  assert.equal((await corrupted.json() as { error: { code: string } }).error.code, 'JOB_OUTPUT_CORRUPT');
  assert.equal(putCount, beforePublish + 1, 'corrupt retained bytes never reach the provider');
  await blobs.put(resultRef, signedExport, 'image/png');

  const maker = await login('maker@test');
  const crossPrincipal = await fetch(`${base}/api/v1/jobs/${jobId}/deliveries`, {
    method: 'POST', headers: { cookie: maker, 'content-type': 'application/json' },
    body: JSON.stringify({ destinationId: 'archive', name: 'Someone else\'s output' }),
  });
  assert.equal(crossPrincipal.status, 404, 'a member cannot infer or publish another principal\'s job');

  const remove = await fetch(`${base}/api/v1/jobs/${jobId}`, { method: 'DELETE', headers });
  assert.equal(remove.status, 409);
  assert.equal((await remove.json() as { error: { code: string } }).error.code, 'JOB_OUTPUT_IN_USE');
  assert.ok(await blobs.head(resultRef), 'the referenced bytes survive a refused job delete');

  await store.putGrant({
    principal: 'user:svc_tok_delivery_viewer', action: 'delivery.create',
    resource: 'destination:reviewed', effect: 'allow',
  });
  const reviewed = await fetch(`${base}/api/v1/jobs/${jobId}/deliveries`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ destinationId: 'reviewed', name: 'Automation needs a person' }),
  });
  assert.equal(reviewed.status, 403);
  assert.equal((await reviewed.json() as { error: { code: string } }).error.code, 'HUMAN_APPROVAL_REQUIRED');
});

test('(f) a destination-scoped deny removes the target and bites the write boundary without erasing history', async () => {
  const maker = (await store.listUsers()).find((user) => user.email === 'maker@test')!;
  const cookie = await login('maker@test');
  const before = await fetch(`${base}/api/v1/org-config`, { headers: { cookie } });
  const priorEtag = before.headers.get('etag')!;
  await store.putGrant({ principal: `user:${maker.id}`, action: 'delivery.create', resource: 'destination:archive', effect: 'deny' });
  const refreshed = await fetch(`${base}/api/v1/org-config`, { headers: { cookie, 'if-none-match': priorEtag } });
  assert.equal(refreshed.status, 200, 'the grant moves policyVersion instead of returning a stale 304');
  const config = await refreshed.json() as { destinations: unknown[] };
  assert.deepEqual(config.destinations, [{
    id: 'reviewed', kind: 's3', label: 'Reviewed release', formats: ['png'],
    maxBytes: 1024 * 1024, visibility: 'private',
  }]);
  assert.equal((await deliver(cookie, 'Denied', signedExport)).status, 403);
  assert.equal((await fetch(`${base}/api/v1/deliveries/${deliveredId}`, { headers: { cookie } })).status, 200);
});

test('(g) a review-bound delivery stages once, delivers only after approval, and cannot retry a rejection', async () => {
  const maker = await login('maker@test');
  const reviewer = await login('reviewer@test');
  const before = putCount;
  const stagedResponse = await deliver(maker, 'Reviewed poster', signedExport, 'idem-reviewed-1', 'reviewed');
  assert.equal(stagedResponse.status, 202);
  const staged = await stagedResponse.json() as { id: string; state: string; approvalId: string };
  assert.equal(staged.state, 'awaiting-approval');
  assert.match(staged.approvalId, /^apr_/);
  assert.equal(putCount, before, 'staging and review cause no provider write');
  assert.equal((await fetch(`${base}/api/v1/deliveries/${staged.id}/retry`, {
    method: 'POST', headers: { cookie: maker },
  })).status, 409, 'approval cannot be bypassed through retry');

  const inbox = await (await fetch(`${base}/api/v1/approvals?inbox=1`, {
    headers: { cookie: reviewer },
  })).json() as { approvals: Array<{ id: string; subjectType: string; subjectRef: string }> };
  assert.ok(inbox.approvals.some((approval) =>
    approval.id === staged.approvalId && approval.subjectType === 'delivery' && approval.subjectRef === staged.id));
  const approved = await fetch(`${base}/api/v1/approvals/${staged.approvalId}/act`, {
    method: 'POST', headers: { cookie: reviewer, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(approved.status, 200);
  assert.equal(putCount, before + 1, 'terminal approval performs the first provider write');
  const delivered = await (await fetch(`${base}/api/v1/deliveries/${staged.id}`, {
    headers: { cookie: maker },
  })).json() as { state: string; approvalId: string; deliveredSha256: string; sha256: string };
  assert.equal(delivered.state, 'delivered');
  assert.equal(delivered.approvalId, staged.approvalId);
  assert.equal(delivered.deliveredSha256, delivered.sha256);

  const rejectedResponse = await deliver(maker, 'Rejected poster', signedExport, 'idem-reviewed-2', 'reviewed');
  const rejectedPending = await rejectedResponse.json() as { id: string; approvalId: string };
  const reject = await fetch(`${base}/api/v1/approvals/${rejectedPending.approvalId}/act`, {
    method: 'POST', headers: { cookie: reviewer, 'content-type': 'application/json' },
    body: JSON.stringify({ action: 'reject', comment: 'Needs correction' }),
  });
  assert.equal(reject.status, 200);
  const rejected = await (await fetch(`${base}/api/v1/deliveries/${rejectedPending.id}`, {
    headers: { cookie: maker },
  })).json() as { state: string };
  assert.equal(rejected.state, 'rejected');
  assert.equal((await fetch(`${base}/api/v1/deliveries/${rejectedPending.id}/retry`, {
    method: 'POST', headers: { cookie: maker },
  })).status, 409);
  assert.equal(putCount, before + 1, 'rejection never contacts the provider');
});
