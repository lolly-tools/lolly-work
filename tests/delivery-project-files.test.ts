// SPDX-License-Identifier: MPL-2.0
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { parseConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { fileChecksum, filePartBlobId } from '../server/src/projects/files.ts';

const servers: Server[] = [];
after(() => { for (const server of servers) { server.closeAllConnections(); server.close(); } });
const png = Buffer.from('89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c636000000200010005fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

async function boot(review = false, scan?: () => Promise<Response>) {
  const store = Object.assign(createMemoryStore(), { storageKind: 'postgres' as const }), blobs = createMemoryBlobStore();
  const config = parseConfig(JSON.stringify({
    dev: { enabled: true, users: [{ email: 'author@test', groups: ['author'] }, { email: 'other@test', groups: ['author'] }, { email: 'reviewer@test', groups: ['reviewers'] }] },
    rateLimit: { enabled: false },
    delivery: { maxBytes: 1024, destinations: [{ id: 'dam', kind: 'brandfolder', label: 'Brandfolder', enabled: true, credentialRef: 'BF_WRITE', formats: ['png'], projectFiles: true,
      ...(review ? { approvalChain: 'review' } : {}), options: { brandfolderId: 'brand', sectionId: 'section', visibility: 'private', uploadOrigins: ['https://upload.example'], downloadOrigins: ['https://original.example'] } }] },
    ...(scan ? { submit: { scanHook: { kind: 'http', target: 'https://scanner.example', timeoutMs: 1000 } } } : {}),
  }));
  if (review) {
    await store.putChain({ id: 'review', name: 'Human review', onReject: 'return-to-submitter', steps: [{ name: 'Publish', approvers: { groups: ['reviewers'] }, rule: 'any' }] });
    await store.putGrant({ principal: 'group:reviewers', action: 'approval.act', resource: '*', effect: 'allow' });
  }
  let uploads = 0, creates = 0, processing = false, loseCreate = false;
  const fetcher: typeof fetch = async (url, init) => {
    const path = String(url);
    if (path === 'https://scanner.example') return scan!();
    if (path.endsWith('/upload_requests')) return Response.json({ upload_url: 'https://upload.example/put?private', object_url: 'https://upload.example/object' });
    if (init?.method === 'PUT') { uploads++; assert.deepEqual(Buffer.from(await new Response(init.body).arrayBuffer()), png); return new Response(null); }
    if (init?.method === 'POST') { creates++; if (loseCreate) throw new Error('private transport failure'); return Response.json({ data: [{ id: 'remote' }] }); }
    if (path.includes('/assets/remote?')) return Response.json({ data: { id: 'remote', relationships: { brandfolder: { data: { id: 'brand' } }, section: { data: { id: 'section' } } } } });
    if (path.endsWith('/attachments')) return Response.json({ data: processing ? [] : [{ attributes: { url: 'https://original.example/file' } }] });
    if (path === 'https://original.example/file') return new Response(png);
    throw new Error('unexpected fixture request');
  };
  const app = buildApp({ config, store, blobs, secrets: { session: 'dam-session', link: 'dam-link' }, destinationSecrets: new Map([['dam', 'fixture-token']]), fetchImpl: fetcher });
  const server = createServer(app); servers.push(server);
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    return res.headers.getSetCookie().find(c => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const cookie = await login('author@test'), other = await login('other@test'), reviewer = await login('reviewer@test');
  const headers = { cookie, 'content-type': 'application/json' };
  const project = await (await fetch(`${base}/api/v1/projects`, { method: 'POST', headers, body: JSON.stringify({ name: 'Private originals', visibility: 'private' }) })).json() as { id: string };
  const checksum = fileChecksum(png);
  const reserved = await fetch(`${base}/api/v1/projects/${project.id}/files`, { method: 'POST', headers, body: JSON.stringify({ name: 'Stored original.png', size: png.length, checksum, contentType: 'image/png', parts: [{ size: png.length, checksum }], asset: { type: 'raster', format: 'png' } }) });
  assert.equal(reserved.status, 201, await reserved.clone().text());
  const { file } = await reserved.json() as { file: { id: string } };
  const path = `${base}/api/v1/projects/${project.id}/files/${file.id}`;
  assert.equal((await fetch(`${path}/parts/0`, { method: 'PUT', headers: { cookie }, body: png })).status, 204);
  assert.equal((await fetch(`${path}/finalize`, { method: 'POST', headers, body: '{}' })).status, 200);
  const source = { projectId: project.id, fileId: file.id, checksum };
  const send = (extra: Record<string, string> = {}, as = cookie, body?: string) => fetch(`${base}/api/v1/destinations/dam/deliveries?${new URLSearchParams({ ...source, ...extra })}`, {
    method: 'POST', headers: { cookie: as, 'idempotency-key': 'one-original' }, ...(body ? { body } : {}),
  });
  const revoke = async () => { const p = (await store.getProject(project.id))!; const outsider = (await store.findUsersByEmail('other@test'))[0]!; await store.putProject({ ...p, ownerId: outsider.id }); };
  return { store, blobs, config, base, cookie, other, reviewer, file, source, send, revoke,
    get uploads() { return uploads; }, get creates() { return creates; }, processing: (value: boolean) => { processing = value; }, loseCreate: () => { loseCreate = true; } };
}

test('shared originals use the empty-body selector, retain their source and keep the export provenance gate', async () => {
  const b = await boot();
  const unsigned = await fetch(`${b.base}/api/v1/destinations/dam/deliveries?name=Raw&format=png`, { method: 'POST', headers: { cookie: b.cookie }, body: png });
  assert.equal(unsigned.status, 422);
  assert.equal((await b.send({}, b.other)).status, 404);
  assert.equal((await b.send({ checksum: '0'.repeat(64) })).status, 404);
  assert.equal((await b.send({ name: 'forged' })).status, 400);
  assert.equal((await b.send({}, b.cookie, 'not empty')).status, 400);
  assert.equal(b.uploads, 0);
  const response = await b.send(); assert.equal(response.status, 201, await response.clone().text());
  const receipt = await response.json() as { id: string; name: string; sha256: string; deliveredSha256: string; state: string };
  assert.equal(receipt.state, 'delivered'); assert.equal(receipt.name, 'Stored original.png'); assert.equal(receipt.deliveredSha256, receipt.sha256);
  for (const field of ['sourceRef', 'projectSource', 'providerProgress', 'principal']) assert.equal(Object.hasOwn(receipt, field), false);
  assert.ok((await b.store.getProjectFile(b.file.id))?.ready);
  const again = await b.send(); assert.equal((await again.json() as { id: string }).id, receipt.id);
  assert.equal(b.creates, 1); assert.equal(b.uploads, 1);
});

test('Brandfolder processing retries keep durable remote progress and concurrent retries create only once', async () => {
  const b = await boot(); b.processing(true);
  const response = await b.send(); assert.equal(response.status, 502);
  const { error: { delivery } } = await response.json() as { error: { delivery: { id: string } } };
  const user = (await b.store.findUsersByEmail('author@test'))[0]!;
  const saved = await b.store.getDelivery(delivery.id, `user:${user.id}`);
  assert.deepEqual(saved?.providerProgress, { phase: 'created', remoteId: 'remote' }); assert.deepEqual(saved?.projectSource, b.source);
  b.processing(false);
  const retries = await Promise.all(Array.from({ length: 8 }, () => fetch(`${b.base}/api/v1/deliveries/${delivery.id}/retry`, { method: 'POST', headers: { cookie: b.cookie } })));
  assert.ok(retries.some(r => r.ok));
  assert.equal((await b.store.getDelivery(delivery.id, `user:${user.id}`))?.state, 'delivered');
  assert.equal(b.uploads, 1); assert.equal(b.creates, 1);
});

test('project access and destination grants are rechecked after approval', async () => {
  for (const reason of ['source', 'destination'] as const) {
    const b = await boot(true);
    const staged = await b.send(); assert.equal(staged.status, 202);
    const pending = await staged.json() as { id: string; approvalId: string };
    assert.equal(b.uploads, 0);
    if (reason === 'source') await b.revoke();
    else {
      const author = (await b.store.findUsersByEmail('author@test'))[0]!;
      await b.store.putGrant({ principal: `user:${author.id}`, action: 'delivery.create', resource: 'destination:dam', effect: 'deny' });
    }
    const approved = await fetch(`${b.base}/api/v1/approvals/${pending.approvalId}/act`, { method: 'POST', headers: { cookie: b.reviewer, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    assert.equal(approved.status, 200);
    const result = await (await fetch(`${b.base}/api/v1/deliveries/${pending.id}`, { headers: { cookie: b.cookie } })).json() as { state: string };
    assert.equal(result.state, 'failed'); assert.equal(b.uploads, 0);
  }
});

test('scanner rejection, revoked access during scanning and corrupt original parts never egress', async () => {
  const rejected = await boot(false, async () => new Response('blocked', { status: 403 }));
  assert.equal((await rejected.send()).status, 502); assert.equal(rejected.uploads, 0);
  let revoke: (() => Promise<void>) | undefined;
  const revoked = await boot(false, async () => { await revoke!(); return new Response(null); }); revoke = revoked.revoke;
  assert.equal((await revoked.send()).status, 502); assert.equal(revoked.uploads, 0);
  const corrupt = await boot();
  await corrupt.blobs.put(filePartBlobId(corrupt.file, 0), Buffer.from('corrupt'), 'application/octet-stream');
  assert.equal((await corrupt.send()).status, 422); assert.equal(corrupt.uploads, 0);
});
