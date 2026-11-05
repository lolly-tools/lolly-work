// SPDX-License-Identifier: MPL-2.0
/**
 * `enforce.watermark: until-approved` follows approval state, and the match route a
 * shell's export bar reads. A server render stays marked until an approved export
 * review matches its tool, version, inputs and format. Every render reads the record,
 * so a cached clean file can never outlive the decision behind it.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildApp } from '../server/src/api/app.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { renderTool } from '../server/src/render/pipeline.ts';
import { renderIdentity } from '../server/src/render/evidence.ts';
import { approvedAmong, approvedExportReview, exportReviewMatch, parseMatchRequest } from '../server/src/approvals/export-review-match.ts';
import type { Approval } from '../server/src/approvals/engine.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const MARK = /lw-preview-watermark/;
const marked = (bytes: Uint8Array) => MARK.test(Buffer.from(bytes).toString());
const TOOL = 'plain-card';
const sha = (bytes: Uint8Array | string) => createHash('sha256').update(bytes).digest('hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"/>');

async function writePack(pack: string, version = '1.0.0'): Promise<void> {
  await mkdir(join(pack, 'tools', TOOL), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL, 'tool.json'), JSON.stringify({
    id: TOOL, name: 'Plain card', version, engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] },
    inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' }],
  }));
  await writeFile(join(pack, 'tools', TOOL, 'template.html'),
    '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><text>{{title}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: TOOL }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
}

const overlays = (watermark: 'until-approved' | 'always' | 'never') =>
  new Map<string, ToolOverlay>([[TOOL, { toolId: TOOL, version: 1, enforce: { watermark } }]]);

/** The render path against a memory store: the same lookup the app wires. */
async function pipeline(t: { after(fn: () => Promise<void>): void }) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-until-approved-'));
  t.after(() => rm(pack, { recursive: true, force: true }));
  await writePack(pack);
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ instance: { name: 'Marks', baseUrl: 'http://localhost', pack }, dev: { enabled: true } }));
  const render = (query: string, rule: 'until-approved' | 'always' | 'never' = 'until-approved', extra: Record<string, unknown> = {}) => renderTool(
    { config, approvedExportReview: key => approvedExportReview(store, key), ...(extra.deps as object) },
    { toolId: TOOL, format: 'svg', query, principal: { groups: ['admin'] }, profile: {}, overlays: overlays(rule), ...(extra.req as object) },
  );
  /** Learn the digest a render reads, then file a request for exactly that. */
  const file = async (query: string, state: Approval['state'], over: Record<string, unknown> = {}, id = `apr_${state}`) => {
    const evidence = (await render(query, 'until-approved', { deps: { captureEvidence: true } })).evidence!;
    const inputsDigest = evidence.untilApproved!.inputsDigest;
    await store.putApproval({ id, state, subjectType: 'export-review', subjectRef: 'export-review:fp', title: 'Card', createdBy: 'u1', createdAt: new Date().toISOString(),
      chainId: 'brand', stepIndex: 0, actions: [], nominees: [], chain: { id: 'brand', name: 'Brand', steps: [], onReject: 'return-to-submitter' },
      exportReview: { toolId: TOOL, format: 'svg', toolVersion: '1.0.0', inputsDigest, fingerprint: 'fp', ...over } } as unknown as Approval);
    return inputsDigest;
  };
  return { pack, store, render, file };
}

test('an unmatched render is marked and a matched one is clean, with the reason on record', async t => {
  const f = await pipeline(t);
  const before = await f.render('title=Launch', 'until-approved', { deps: { captureEvidence: true } });
  assert.equal(marked(before.bytes), true);
  assert.equal(before.watermarkNote, 'Marked until approved');
  assert.equal(before.evidence!.context.watermark, true);
  assert.deepEqual({ ...before.evidence!.untilApproved, inputsDigest: 'x' }, { marked: true, note: 'Marked until approved', approvalId: null, inputsDigest: 'x' });

  await f.file('title=Launch', 'approved');
  const after = await f.render('title=Launch', 'until-approved', { deps: { captureEvidence: true } });
  assert.equal(marked(after.bytes), false);
  assert.equal(after.watermarkNote, 'Approved, not marked');
  assert.equal(after.evidence!.context.watermark, false);
  assert.equal(after.evidence!.untilApproved!.approvalId, 'apr_approved');
  assert.doesNotMatch(Buffer.from(after.bytes).toString(), /Approved|until approved/i, 'the words are in the record, never in the artwork');

  const identity = (e: typeof before.evidence) => renderIdentity({ toolId: TOOL, format: 'svg', inputs: { title: 'Launch' } }, e!)!;
  assert.equal(identity(before.evidence).policy.watermark, true);
  assert.equal(identity(after.evidence).policy.watermark, false);
  assert.notEqual(identity(before.evidence).id, identity(after.evidence).id, 'the identity says which applied');
});

test('changed inputs, another format and a new tool version stay marked', async t => {
  const f = await pipeline(t);
  await f.file('title=Launch', 'approved');
  assert.equal(marked((await f.render('title=Launch')).bytes), false);
  assert.equal(marked((await f.render('title=Something%20else')).bytes), true, 'other values');
  const png = await f.render('title=Launch', 'until-approved', { req: { format: 'png' } });
  assert.equal(png.watermarkNote, 'Marked until approved', 'another format');
  await writePack(f.pack, '2.0.0');
  assert.equal(marked((await f.render('title=Launch')).bytes), true, 'a new version needs a new approval');
});

test('in review, rejected and withdrawn requests leave the mark on', async t => {
  for (const state of ['submitted', 'in_review', 'rejected', 'withdrawn'] as const) {
    const f = await pipeline(t);
    await f.file('title=Launch', state);
    assert.equal(marked((await f.render('title=Launch')).bytes), true, state);
  }
  const f = await pipeline(t);
  await f.file('title=Launch', 'approved', { removedAt: '2026-01-01T00:00:00.000Z', removedBecause: 'withdrawn' });
  assert.equal(marked((await f.render('title=Launch')).bytes), true, 'withdrawn bytes do not count');
  const kept = await pipeline(t);
  await kept.file('title=Launch', 'approved', { removedAt: '2026-01-01T00:00:00.000Z', removedBecause: 'retention' });
  assert.equal(marked((await kept.render('title=Launch')).bytes), false, 'retention removes a file, and the decision stands');
});

test('the cache cannot serve a stale clean file across a decision', async t => {
  const f = await pipeline(t);
  const first = await f.render('title=Cached');
  assert.equal(marked(first.bytes), true);
  assert.equal(marked((await f.render('title=Cached')).bytes), true, 'marked twice, from the cache');
  await f.file('title=Cached', 'approved');
  const clean = await f.render('title=Cached');
  assert.equal(marked(clean.bytes), false, 'a decision takes effect on the next render');
  assert.notEqual(clean.cacheKey, first.cacheKey);
  assert.equal((await f.render('title=Cached')).watermarkNote, 'Approved, not marked', 'a cached render still says why');
  const stored = (await f.store.getApproval('apr_approved'))!;
  await f.store.putApproval({ ...stored, state: 'rejected' });
  assert.equal(marked((await f.render('title=Cached')).bytes), true, 'without the approval the clean file is not served');
});

test('always and never keep their meaning, a preview request still marks, and a failed lookup leaves the mark on', async t => {
  const f = await pipeline(t);
  let lookups = 0;
  const counting = { deps: { approvedExportReview: async () => { lookups++; return { id: 'apr_any' }; } } };
  assert.equal(marked((await f.render('title=A', 'always', counting)).bytes), true);
  assert.equal(marked((await f.render('title=A', 'never', counting)).bytes), false);
  assert.equal(lookups, 0, 'a render only looks under until-approved');
  assert.equal((await f.render('title=A', 'always')).watermarkNote, undefined);
  assert.equal(marked((await f.render('title=A', 'until-approved', counting)).bytes), false);
  assert.equal(lookups, 1);
  const preview = await f.render('title=A', 'until-approved', { ...counting, req: { watermarkPreview: true } });
  assert.equal(marked(preview.bytes), true, 'a caller asking for the preview mark still gets it');
  assert.equal(preview.watermarkNote, 'Marked as a preview');
  const broken = await f.render('title=A', 'until-approved', { deps: { approvedExportReview: async () => { throw new Error('store down'); } } });
  assert.equal(marked(broken.bytes), true);
  const unwired = await f.render('title=A', 'until-approved', { deps: { approvedExportReview: undefined } });
  assert.equal(marked(unwired.bytes), true);
});

test('what counts and what a match says, as pure rules', () => {
  const row = (id: string, state: string, over: Record<string, unknown> = {}, createdAt = '2026-01-01T00:00:00.000Z') => ({ id, state, title: id, createdAt, actions: state === 'approved' || state === 'rejected' ? [{ at: '2026-02-02T00:00:00.000Z' }] : [],
    exportReview: { toolId: 'card', format: 'png', toolVersion: '1', fingerprint: `fp-${id}`, ...over } }) as unknown as Approval;
  const key = { toolId: 'card', format: 'png', toolVersion: '1' };
  assert.equal(approvedAmong([row('a', 'approved', { toolVersion: '0' })], '1'), null);
  assert.deepEqual(exportReviewMatch([], [], key), { state: 'none' });
  assert.deepEqual(exportReviewMatch([row('a', 'approved'), row('b', 'in_review')], [], key),
    { state: 'approved', approvalId: 'a', fingerprint: 'fp-a', title: 'a', decidedAt: '2026-02-02T00:00:00.000Z' });
  assert.equal(exportReviewMatch([row('b', 'in_review'), row('c', 'rejected')], [], key).state, 'in_review');
  assert.equal(exportReviewMatch([row('b', 'submitted')], [], key).state, 'in_review');
  assert.equal(exportReviewMatch([row('c', 'rejected')], [], key).state, 'rejected');
  const own = [row('old', 'approved', {}, '2026-01-01T00:00:00.000Z'), row('new', 'rejected', {}, '2026-03-01T00:00:00.000Z')];
  assert.equal(exportReviewMatch([], own, key).approvalId, 'new', 'changed names the newest earlier request');
  assert.equal(exportReviewMatch([], own, key).state, 'changed');
  assert.equal(exportReviewMatch([row('v', 'approved', { toolVersion: '0' })], [row('v', 'approved', { toolVersion: '0' })], key).state, 'changed', 'an older tool version');
  assert.equal(exportReviewMatch([], [row('w', 'withdrawn')], key).state, 'none');
  assert.equal(exportReviewMatch([], [row('o', 'approved', { format: 'svg' })], key).state, 'none');
  assert.deepEqual(parseMatchRequest({ toolId: 'card', format: 'JPEG', query: '' }), { toolId: 'card', format: 'jpg', query: '' });
  for (const bad of [null, [], {}, { toolId: 'card', format: 'png' }, { toolId: 'Card', format: 'png', query: '' }, { toolId: 'card', format: '../x', query: '' }, { toolId: 'card', format: 'png', query: 1 }]) assert.equal(parseMatchRequest(bad), null);
});

// ---- Over the real app.

interface World { base: string; server: Server; store: ReturnType<typeof createMemoryStore>; pack: string; author: string; author2: string; reviewer: string; outsider: string; owner: string }
let world: World;
let runner: RenderRunner | undefined;
before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-until-approved-app-'));
  await writePack(pack);
  const store = createMemoryStore(), blobs = createMemoryBlobStore();
  await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['review'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putOverlay({ toolId: TOOL, version: 1, enforce: { watermark: 'until-approved', escalation: 'brand' } });
  const config = parseConfig(JSON.stringify({ instance: { name: 'Marks', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] }, { email: 'author@test', groups: ['author'] }, { email: 'author2@test', groups: ['author'] },
      { email: 'review@test', groups: ['approver', 'review'] }, { email: 'outside@test', groups: ['approver', 'elsewhere'] },
    ] } }));
  const app = buildApp({ config, store, blobs, secrets: { session: 'until-approved-test', link: 'until-approved-link' }, onRenderRunner: (r) => { runner = r; r.start(); } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object');
  const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie().find(value => value.startsWith('lw_'))!.split(';')[0]!;
  world = { base, server, store, pack, author: await login('author@test'), author2: await login('author2@test'), reviewer: await login('review@test'), outsider: await login('outside@test'), owner: await login('owner@test') };
});
after(async () => { await runner?.stop(); world.server.close(); await rm(world.pack, { recursive: true, force: true }); });

const post = (path: string, body: unknown, cookie?: string) => fetch(world.base + path, { method: 'POST', headers: { ...(cookie ? { cookie } : {}), 'content-type': 'application/json' }, body: JSON.stringify(body) });
const match = async (title: string, cookie: string, over: Record<string, unknown> = {}) => {
  const res = await post('/api/v1/approvals/match', { toolId: TOOL, format: 'svg', query: `title=${encodeURIComponent(title)}`, ...over }, cookie);
  assert.equal(res.status, 200, await res.clone().text());
  return await res.json() as { state: string; approvalId?: string; fingerprint?: string; title?: string; decidedAt?: string };
};
/** A real request: a file sent by the parts protocol, under these inputs. */
async function raise(title: string, cookie = world.author) {
  const begun = await post('/api/v1/uploads', { scope: 'approval-artifact', name: 'card.svg', contentType: 'image/svg+xml', size: SVG.length, checksum: sha(SVG), parts: [{ size: SVG.length, checksum: sha(SVG) }] }, cookie);
  assert.equal(begun.status, 201, await begun.clone().text());
  const { upload } = await begun.json() as { upload: { id: string } };
  assert.equal((await fetch(`${world.base}/api/v1/uploads/${upload.id}/parts/0`, { method: 'PUT', headers: { cookie, 'content-type': 'application/octet-stream' }, body: SVG })).status, 204);
  assert.equal((await post(`/api/v1/uploads/${upload.id}/finalize`, {}, cookie)).status, 200);
  const created = await post('/api/v1/approvals', { subjectType: 'export-review', title: `Card ${title}`, chainId: 'brand',
    exportReview: { uploadId: upload.id, checksum: sha(SVG), toolId: TOOL, format: 'svg', query: `title=${encodeURIComponent(title)}` } }, cookie);
  assert.equal(created.status, 201, await created.clone().text());
  return await created.json() as { id: string; exportReview: { fingerprint: string } };
}
async function decide(approval: { id: string; exportReview: { fingerprint: string } }, action: 'approve' | 'reject') {
  const token = (await fetch(`${world.base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: world.reviewer } })).headers.get('x-lolly-review-token');
  const res = await post(`/api/v1/approvals/${approval.id}/act`, { action, comment: 'noted', artifactFingerprint: approval.exportReview.fingerprint, reviewToken: token }, world.reviewer);
  assert.equal(res.status, 200, await res.clone().text());
}
const direct = (title: string) => post('/api/v1/render', { toolId: TOOL, format: 'svg', inputs: { title } }, world.owner);

test('a real request moves a real render from marked to clean, and the headers say why', async () => {
  const title = 'Real flow';
  const before = await direct(title);
  assert.equal(before.status, 200, await before.clone().text());
  assert.equal(before.headers.get('x-lolly-watermark'), 'Marked until approved');
  assert.match(await before.text(), MARK);

  const approval = await raise(title);
  assert.match(await (await direct(title)).text(), MARK, 'a request in review changes nothing');
  await decide(approval, 'approve');

  const after = await direct(title);
  assert.equal(after.headers.get('x-lolly-watermark'), 'Approved, not marked');
  assert.doesNotMatch(await after.text(), MARK);
  assert.match(await (await direct('Another title')).text(), MARK, 'other inputs stay marked');

  const url = await fetch(`${world.base}/render/${TOOL}.svg?title=${encodeURIComponent(title)}`, { headers: { cookie: world.owner } });
  assert.equal(url.status, 200, await url.clone().text());
  assert.equal(url.headers.get('x-lolly-watermark'), 'Approved, not marked');
  assert.match(url.headers.get('cache-control') ?? '', /no-store/, 'no shared or browser cache holds a render under this rule');
  assert.doesNotMatch(await url.text(), MARK);
});

test('a durable render applies the rule at its attempt and says so on its receipt', async () => {
  const durable = async (title: string) => {
    const made = await post('/api/v1/renders', { toolId: TOOL, format: 'svg', inputs: { title } }, world.owner);
    assert.equal(made.status, 202, await made.clone().text());
    const { id } = await made.json() as { id: string };
    for (let tries = 0; tries < 200; tries++) {
      const record = await (await fetch(`${world.base}/api/v1/renders/${id}`, { headers: { cookie: world.owner } })).json() as { state: string; output?: { watermark?: { marked: boolean; note: string } } };
      if (record.state === 'succeeded') return { id, record };
      assert.ok(record.state === 'queued' || record.state === 'running', JSON.stringify(record));
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    throw new Error('the render did not finish');
  };
  const title = 'Durable one';
  const before = await durable(title);
  assert.deepEqual(before.record.output?.watermark, { marked: true, note: 'Marked until approved' });
  const file = await fetch(`${world.base}/api/v1/renders/${before.id}/output/default`, { headers: { cookie: world.owner } });
  assert.equal(file.headers.get('x-lolly-watermark'), 'Marked until approved');
  assert.match(await file.text(), MARK);
  await decide(await raise(title), 'approve');
  const after = await durable(title);
  assert.deepEqual(after.record.output?.watermark, { marked: false, note: 'Approved, not marked' });
  const { evidence } = await (await fetch(`${world.base}/api/v1/renders/${after.id}/evidence`, { headers: { cookie: world.owner } })).json() as { evidence: { untilApproved?: { marked: boolean; approvalId: string | null } } };
  assert.equal(evidence.untilApproved?.marked, false);
  assert.match(evidence.untilApproved?.approvalId ?? '', /^apr_/);
});

test('a rejected or withdrawn request leaves a real render marked', async () => {
  await decide(await raise('Rejected one'), 'reject');
  assert.match(await (await direct('Rejected one')).text(), MARK);
  const withdrawn = await raise('Withdrawn one');
  assert.equal((await post(`/api/v1/approvals/${withdrawn.id}/withdraw`, {}, world.author)).status, 200);
  assert.match(await (await direct('Withdrawn one')).text(), MARK);
});

test('the match route answers all five states for a requester', async () => {
  const w = world;
  assert.deepEqual(await match('Five states', w.author2), { state: 'none' });
  const approval = await raise('Five states', w.author2);
  const open = await match('Five states', w.author2);
  assert.equal(open.state, 'in_review');
  assert.equal(open.approvalId, approval.id);
  assert.equal(open.fingerprint, approval.exportReview.fingerprint);
  assert.equal(open.title, 'Card Five states');
  assert.equal(open.decidedAt, undefined);
  assert.equal((await match('Five states, edited', w.author2)).state, 'changed', 'their own earlier request, under other inputs');
  await decide(approval, 'approve');
  const approved = await match('Five states', w.author2);
  assert.equal(approved.state, 'approved');
  assert.match(approved.decidedAt ?? '', /^\d{4}-/);
  const rejected = await raise('Five states B', w.author2);
  await decide(rejected, 'reject');
  assert.equal((await match('Five states B', w.author2)).state, 'rejected');
  assert.deepEqual(await match('Five states B', w.author2, { format: 'png' }), { state: 'none' }, 'a request for another format says nothing about this one');
  const keys = Object.keys(approved).sort();
  assert.deepEqual(keys, ['approvalId', 'decidedAt', 'fingerprint', 'state', 'title'], 'the shape a shell reads, and no bytes or digest');
});

test('the match route only speaks of requests a person may read, and keeps no values', async () => {
  const w = world;
  const approval = await raise('Private values 42', w.author);
  assert.equal((await match('Private values 42', w.reviewer)).state, 'in_review', 'an eligible reviewer may read it');
  assert.deepEqual(await match('Private values 42', w.outsider), { state: 'none' }, 'an approver outside the chain learns nothing');
  const theirs = await match('Private values 42', w.author2);
  assert.equal(theirs.state, 'changed', 'another member sees only their own earlier request');
  assert.notEqual(theirs.approvalId, approval.id);
  await decide(approval, 'approve');
  assert.deepEqual(await match('Private values 42', w.outsider), { state: 'none' }, 'still nothing after approval, though a render would be clean');
  const stored = JSON.stringify((await w.store.getApproval(approval.id))!.exportReview);
  assert.doesNotMatch(stored, /Private values|title=/, 'the record keeps the digest, not the values');

  const anonymous = await post('/api/v1/approvals/match', { toolId: TOOL, format: 'svg', query: '' });
  assert.equal(anonymous.status, 401);
  assert.equal((await post('/api/v1/approvals/match', { toolId: TOOL, format: 'svg' }, w.author)).status, 400);
  const absent = await post('/api/v1/approvals/match', { toolId: 'no-such-tool', format: 'svg', query: '' }, w.author);
  assert.equal(absent.status, 404);
  const minted = await post('/api/v1/tokens', { label: 'ci', role: 'admin' }, w.owner);
  assert.equal(minted.status, 201, await minted.clone().text());
  const { token } = await minted.json() as { token: string };
  const service = await fetch(`${w.base}/api/v1/approvals/match`, { method: 'POST', headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: JSON.stringify({ toolId: TOOL, format: 'svg', query: '' }) });
  assert.equal(service.status, 401, 'this route is for people, like the rest of approvals');
});

test('the capability is advertised to shells and in public discovery', async () => {
  const discovery = await (await fetch(`${world.base}/api/v1/discovery`)).json() as { approvals: Record<string, unknown> };
  assert.deepEqual(discovery.approvals, { exportReview: true, exportReviewMatch: true });
  const org = await (await fetch(`${world.base}/api/v1/org-config`, { headers: { cookie: world.author } })).json() as { approvals?: { exportReview?: { match?: boolean } } };
  assert.equal(org.approvals?.exportReview?.match, true);
});
