// SPDX-License-Identifier: MPL-2.0
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { backfillVersionOne, applyVersionToRecord } from '../server/src/catalog/versions.ts';
import { parseSourceReview, freezeSourceReview } from '../server/src/catalog/source-review.ts';

const store = createMemoryStore(), blobs = createMemoryBlobStore();
let base: string, pack: string, author: string, reviewer: string, outsider: string, owner: string, server: Server;
let original: { assetId: string; version: number; format: string; sha256: string; representation: 'original' };
const read = (path: string, cookie = author) => fetch(base + path, { headers: { cookie } });
const post = (path: string, body: unknown, cookie = author) => fetch(base + path, { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body) });
const request = (files = [original], target = 'launch:print') => ({ subjectType: 'source-review', title: 'Print source review', chainId: 'brand',
  sourceReview: { purpose: 'Creative source review', target, files } });
before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-source-review-'));
  await mkdir(join(pack, 'catalog/assets'), { recursive: true }); await writeFile(join(pack, 'catalog/assets/index.json'), '{"assets":[]}');
  const stat = await blobs.put('inst/hero/png', Buffer.from('original'), 'image/png');
  await store.putInstanceAsset({ id: 'inst/hero', groups: ['design'], createdAt: '2026-10-16', blobs: { png: stat.blobId },
    entry: instanceAssetEntry('inst/hero', { name: 'Hero', type: 'raster' }, [{ format: 'png', size: stat.size, checksum: stat.checksum }]) });
  const hidden = await blobs.put('inst/private/png', Buffer.from('hidden'), 'image/png');
  await store.putInstanceAsset({ id: 'inst/private', groups: ['private'], createdAt: '2026-10-16', blobs: { png: hidden.blobId },
    entry: instanceAssetEntry('inst/private', { name: 'Hidden source', type: 'raster' }, [{ format: 'png', size: hidden.size, checksum: hidden.checksum }]) });
  original = { assetId: 'inst/hero', version: 1, format: 'png', sha256: stat.checksum, representation: 'original' };
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Review', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false }, policy: { defaultAccessMode: 'gated' },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner', 'design', 'private'] }, { email: 'author@test', groups: ['author', 'design'] }, { email: 'review@test', groups: ['admin', 'design', 'review'] }, { email: 'outside@test', groups: ['review'] }] } }));
  const app = buildApp({ config, store, blobs, secrets: { session: 'source-review-test', link: 'source-review-link' } });
  server = createServer((req, res) => void app(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_session='))!.split(';')[0]!;
  author = await login('author@test'); reviewer = await login('review@test'); outsider = await login('outside@test');
  owner = await login('owner@test');
});
after(async () => { await new Promise<void>(resolve => server.close(() => resolve())); await rm(pack, { recursive: true, force: true }); });

test('purpose, target and exact membership define the frozen subject independently of input ordering', () => {
  const a = parseSourceReview(request().sourceReview)!;
  const first = freezeSourceReview(a, 'now');
  a.files[0]!.sha256 = '0'.repeat(64);
  assert.equal(first.files[0]!.sha256, original.sha256);
  assert.notEqual(freezeSourceReview(parseSourceReview(request([original], 'other-target').sourceReview)!, 'now').fingerprint, first.fingerprint);
  assert.equal(parseSourceReview({ ...request().sourceReview, files: [original, original] }), null);
  assert.equal(parseSourceReview({ ...request().sourceReview, files: [{ ...original, representation: 'preview' }] }), null);
  const other = { ...original, assetId: 'inst/other' };
  const ordered = freezeSourceReview(parseSourceReview(request([original, other]).sourceReview)!, 'now');
  const reversed = freezeSourceReview(parseSourceReview(request([other, original]).sourceReview)!, 'later');
  assert.equal(ordered.fingerprint, reversed.fingerprint);
  assert.notEqual(ordered.fingerprint, first.fingerprint);
});
test('source review verifies selected bytes; changed bytes and hidden members fail before a request is stored', async () => {
  const beforeCount = (await store.listApprovals()).length;
  assert.equal((await post('/api/v1/approvals', request([{ ...original, sha256: '0'.repeat(64) }]))).status, 409);
  assert.equal((await post('/api/v1/approvals', request(), outsider)).status, 409);
  assert.equal((await post('/api/v1/approvals', request([{ ...original, assetId: 'inst/private' }]))).status, 409);
  assert.equal((await store.listApprovals()).length, beforeCount);
});
test('approval remains attached to the old bytes after replacement and does not publish or approve the new version', async () => {
  const response = await post('/api/v1/approvals', request()); assert.equal(response.status, 201, await response.clone().text());
  const approval = await response.json() as any;
  const old = await store.getInstanceAsset('inst/hero'); assert.ok(old);
  await store.putAssetVersion(backfillVersionOne(old));
  const stat = await blobs.put('inst/hero/v2/png', Buffer.from('replacement'), 'image/png');
  const v2 = { assetId: old.id, version: 2, by: 'test', at: '2026-10-17', formats: [{ format: 'png', blobId: stat.blobId, size: stat.size, checksum: stat.checksum }] };
  await store.putAssetVersion(v2); await store.putInstanceAsset(applyVersionToRecord(old, v2));
  assert.equal((await post(`/api/v1/approvals/${approval.id}/act`, { action: 'approve' }, reviewer)).status, 409, 'older clients cannot approve an undisplayed source subject');
  const acted = await post(`/api/v1/approvals/${approval.id}/act`, { action: 'approve', sourceFingerprint: approval.sourceReview.fingerprint, sourceReview: { target: 'forged' } }, reviewer);
  assert.equal(acted.status, 200, await acted.clone().text());
  const decision = await acted.json() as any;
  assert.equal(decision.state, 'approved'); assert.deepEqual(decision.sourceReview, approval.sourceReview);
  assert.equal(decision.sourceReview.origin, 'member-session'); assert.equal(decision.actions[0].origin, 'member-session');
  assert.equal(decision.sourceReview.files[0].version, 1); assert.equal(decision.sourceReview.target, 'launch:print');
  assert.equal((await store.getInstanceAsset(old.id))?.headVersion, 2);
  const history = await (await read(`/api/v1/catalog/assets/${old.id}/versions`)).json() as any;
  assert.equal(history.metadataHistory, 'not-recorded'); assert.equal(history.sourceReviews[0].sourceReview.files[0].sha256, original.sha256);
  assert.equal(history.sourceReviewCapability.kind, 'frozen-instance-originals-v1'); assert.equal(history.sourceReviewCapability.maxFiles, 32);
  const next = await post('/api/v1/approvals', request([{ ...original, version: 2, sha256: stat.checksum }]));
  assert.equal(next.status, 201); assert.notEqual((await next.json() as any).sourceReview.fingerprint, approval.sourceReview.fingerprint);
});
test('a visible file never reveals a hidden proof member, its count or a review outside the caller audience', async () => {
  const hidden = await blobs.head('inst/private/png'); assert.ok(hidden);
  const response = await post('/api/v1/approvals', request([original, { ...original, assetId: 'inst/private', sha256: hidden.checksum }]), owner);
  assert.equal(response.status, 201, await response.clone().text());
  const approval = await response.json() as any;
  const history = await (await read('/api/v1/catalog/assets/inst/hero/versions')).json() as any;
  assert.equal(history.sourceReviews.some((a: any) => a.id === approval.id), false);
  assert.doesNotMatch(JSON.stringify(history), /inst\/private|Hidden source/);
  const inbox = await (await read('/api/v1/approvals?inbox=1', reviewer)).json() as any;
  assert.equal(inbox.approvals.some((a: any) => a.id === approval.id), false);
  assert.equal((await post(`/api/v1/approvals/${approval.id}/act`, { action: 'approve' }, reviewer)).status, 404);
});
test('withdrawal removes inbox and history access and refuses consequential review actions', async () => {
  const response = await post('/api/v1/approvals', request()); assert.equal(response.status, 201);
  const approval = await response.json() as any;
  assert.equal((await (await read('/api/v1/approvals?inbox=1', outsider)).json() as any).approvals.some((a: any) => a.id === approval.id), false);
  const rec = await store.getInstanceAsset('inst/hero'); assert.ok(rec);
  await store.putInstanceAsset({ ...rec, groups: ['private'] });
  const mine = await (await read('/api/v1/approvals?mine=1')).json() as any;
  assert.equal(mine.approvals.some((a: any) => a.id === approval.id), false);
  assert.equal((await post(`/api/v1/approvals/${approval.id}/act`, { action: 'approve' }, reviewer)).status, 404);
  assert.equal((await read('/api/v1/catalog/assets/inst/hero/versions')).status, 404);
  assert.equal((await store.getApproval(approval.id))?.state, 'in_review');
});
