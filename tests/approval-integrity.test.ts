// SPDX-License-Identifier: MPL-2.0
/**
 * Approval integrity over the real app (plan 357, W-M0-2):
 *
 *  - two people deciding one catalog submission at the same moment, from the
 *    review queue and the approvals inbox: one decision is kept, the other is
 *    told 409 APPROVAL_CHANGED, and the asset agrees with the decision kept;
 *  - a withdrawal racing a decision ends the same way;
 *  - a withdrawal goes on the trail as the submitter's own action, and the
 *    submission settles as withdrawn with no reviewer's name or words, in the
 *    record, the queue, the inbox and the email;
 *  - an approval that cannot be stored leaves no record, bytes or charge.
 *
 * The store's half (compare-and-set on both drivers, and a token's request on
 * Postgres) is in tests/store-conformance.ts and tests/store-postgres.test.ts.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { submissionNotice, sweepDiscardedSubmissions } from '../server/src/catalog/submit.ts';
import { withdraw, createApproval, applyAction, type Approval, type Chain } from '../server/src/approvals/engine.ts';
import type { InstanceAssetRecord } from '../server/src/catalog/instance-assets.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');

const ONE_STEP: Chain = { id: 'brand-review', name: 'Brand review', steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter' };
const TWO_STEPS: Chain = { id: 'brand-review', name: 'Brand then legal', steps: [
  { name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' },
  { name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' },
], onReject: 'return-to-submitter' };

async function boot(chain: Chain) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-approval-integrity-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Integrity', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    policy: { submit: { chain: chain.id } },
    dev: { enabled: true, users: [
      { email: 'author@test', groups: ['author', 'design'] },
      { email: 'ana@test', groups: ['approver', 'brand'] },
      { email: 'ben@test', groups: ['approver', 'brand'] },
    ] },
  }));
  const store = createMemoryStore();
  await store.putChain(chain);
  const blobs = createMemoryBlobStore();
  const app = buildApp({ config, store, blobs, secrets: { session: 'sI', link: 'lI' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
  };
  const post = (cookie: string, path: string, body?: unknown) => fetch(`${base}${path}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const submit = async (cookie: string): Promise<{ assetId: string; approvalId: string }> => {
    const res = await fetch(`${base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
    assert.equal(res.status, 201, await res.clone().text());
    return await res.json() as { assetId: string; approvalId: string };
  };
  return { base, store, blobs, login, post, submit };
}

/** Hold every compare-and-set until `count` have arrived, so each request has
 *  read the approval before any of them writes. A write that waits too long
 *  fails its request, so a race that never formed cannot pass. */
function holdWrites(store: ReturnType<typeof createMemoryStore>, count: number): void {
  const real = store.casApproval.bind(store);
  let arrived = 0;
  let open!: () => void;
  const all = new Promise<void>((resolve) => { open = resolve; });
  store.casApproval = async (next, expected) => {
    if (++arrived === count) open();
    let timer: NodeJS.Timeout | undefined;
    const late = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`only ${arrived} of ${count} writes arrived`)), 5000); });
    try { await Promise.race([all, late]); } finally { clearTimeout(timer); }
    return real(next, expected);
  };
}

async function errorCode(res: Response): Promise<string | undefined> {
  return ((await res.json()) as { error?: { code?: string } }).error?.code;
}

test('a simultaneous approve and reject: one decision is kept, the other is told 409, and the asset agrees', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const ana = await w.login('ana@test');
  const ben = await w.login('ben@test');
  const { assetId, approvalId } = await w.submit(author);
  holdWrites(w.store, 2);
  // One from the review queue, one from the approvals inbox: both settle assets.
  const [approve, reject] = await Promise.all([
    w.post(ana, `/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}/act`, { action: 'approve', comment: 'on brand' }),
    w.post(ben, `/api/v1/approvals/${approvalId}/act`, { action: 'reject', comment: 'wrong lockup' }),
  ]);
  assert.deepEqual([approve.status, reject.status].sort(), [200, 409]);
  const lost = approve.status === 409 ? approve : reject;
  assert.equal(await errorCode(lost), 'APPROVAL_CHANGED');

  const approval = (await w.store.getApproval(approvalId))!;
  const record = (await w.store.getInstanceAsset(assetId))!;
  const approved = approve.status === 200;
  assert.equal(approval.state, approved ? 'approved' : 'rejected');
  assert.equal(approval.actions.length, 1, 'the losing action is not on the trail');
  assert.equal(approval.revision, 1);
  assert.equal(record.submission?.state, approved ? 'live' : 'returned', 'the asset agrees with the approval');
  assert.equal(record.submission?.comment, approved ? 'on brand' : 'wrong lockup');
  const decisions = (await w.store.listAudit()).filter((e) => e.action === 'approval.approve' || e.action === 'approval.reject');
  assert.equal(decisions.length, 1, 'only the decision kept is audited');
  const told = (await w.store.listMessages()).filter((m) => m.data?.assetId === assetId);
  assert.equal(told.length, 1, 'the submitter is told once');
  assert.match(told[0]!.title, approved ? /^Published/ : /^Returned/);
});

test('a withdrawal racing a decision: one is kept and the asset agrees with it', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const ana = await w.login('ana@test');
  const { assetId, approvalId } = await w.submit(author);
  holdWrites(w.store, 2);
  const [approve, pulled] = await Promise.all([
    w.post(ana, `/api/v1/approvals/${approvalId}/act`, { action: 'approve' }),
    w.post(author, `/api/v1/approvals/${approvalId}/withdraw`),
  ]);
  assert.deepEqual([approve.status, pulled.status].sort(), [200, 409]);
  assert.equal(await errorCode(approve.status === 409 ? approve : pulled), 'APPROVAL_CHANGED');
  const approval = (await w.store.getApproval(approvalId))!;
  const record = (await w.store.getInstanceAsset(assetId))!;
  if (approve.status === 200) {
    assert.equal(approval.state, 'approved');
    assert.equal(record.submission?.state, 'live');
  } else {
    assert.equal(approval.state, 'withdrawn');
    assert.equal(record.submission?.state, 'returned');
    assert.equal(record.submission?.withdrawn, true);
  }
});

test('a withdrawn submission names the person who withdrew it and carries no reviewer’s words', async () => {
  const w = await boot(TWO_STEPS);
  const author = await w.login('author@test');
  const ana = await w.login('ana@test');
  const { assetId, approvalId } = await w.submit(author);
  // The first step clears with a reviewer's comment; the second never decides.
  const first = await w.post(ana, `/api/v1/approvals/${approvalId}/act`, { action: 'approve', comment: 'Looks right to me' });
  assert.equal(first.status, 200);
  assert.equal((await w.store.getApproval(approvalId))?.state, 'in_review');
  const pulled = await w.post(author, `/api/v1/approvals/${approvalId}/withdraw`);
  assert.equal(pulled.status, 200);

  const approval = (await w.store.getApproval(approvalId))!;
  const authorId = approval.createdBy;
  assert.equal(approval.state, 'withdrawn');
  const last = approval.actions.at(-1)!;
  assert.equal(last.action, 'withdraw', 'the withdrawal is its own action on the trail');
  assert.equal(last.actor, authorId);
  assert.equal(last.step, 1);
  assert.equal(last.comment, undefined);
  assert.ok(Date.parse(last.at) > 0, 'it says when');

  const record = (await w.store.getInstanceAsset(assetId))!;
  assert.equal(record.submission?.state, 'returned');
  assert.equal(record.submission?.withdrawn, true);
  assert.equal(record.submission?.decidedBy, `user:${authorId}`, 'decided by the submitter, not the reviewer');
  assert.equal(record.submission?.comment, undefined, 'the reviewer’s comment is not copied');

  const queue = await (await fetch(`${w.base}/api/v1/catalog/submissions?state=returned`, { headers: { cookie: author } })).json() as { submissions: Array<Record<string, unknown>> };
  const row = queue.submissions.find((s) => s.id === assetId)!;
  assert.equal(row.withdrawn, true);
  assert.equal(row.comment, undefined);
  assert.equal(row.decidedBy, `user:${authorId}`);

  const told = (await w.store.listMessages()).filter((m) => m.data?.assetId === assetId);
  assert.equal(told.length, 1);
  assert.equal(told[0]!.title, 'Withdrawn: Campaign Hero');
  assert.equal(told[0]!.body, 'You withdrew this catalog submission, so it was not published.');
  assert.equal(told[0]!.severity, 'info');
  assert.doesNotMatch(`${told[0]!.title} ${told[0]!.body}`, /Looks right|Returned|ana/i);

  const audited = (await w.store.listAudit()).filter((e) => e.subject === `catalog:${assetId}` && e.action !== 'catalog.submit');
  assert.deepEqual(audited.map((e) => [e.action, e.actor]), [['catalog.withdraw-submission', `user:${authorId}`]]);
});

test('the submitter’s notice for each outcome: no email follows a withdrawal', () => {
  const record = { id: 'inst/x', entry: { id: 'inst/x', name: 'Hero' } } as unknown as InstanceAssetRecord;
  assert.deepEqual(submissionNotice({ record, state: 'live' }),
    { severity: 'info', title: 'Published: Hero', body: 'Your catalog submission was approved and is live.', email: 'Your catalog submission was approved and is live.' });
  assert.deepEqual(submissionNotice({ record, state: 'returned', comment: 'wrong lockup' }),
    { severity: 'action', title: 'Returned: Hero', body: 'Your catalog submission was returned: “wrong lockup”', email: 'Your catalog submission was returned: “wrong lockup”' });
  assert.deepEqual(submissionNotice({ record, state: 'returned', withdrawn: true, comment: 'ignored' }),
    { severity: 'info', title: 'Withdrawn: Hero', body: 'You withdrew this catalog submission, so it was not published.', email: null });
});

test('withdraw adds the submitter’s action and leaves every step count alone', () => {
  const now = '2026-11-12T00:00:00.000Z';
  const quorum: Chain = { id: 'q', name: 'Q', steps: [{ name: 'Two', approvers: { groups: ['brand'] }, rule: { quorum: 2 } }], onReject: 'return-to-submitter' };
  let a: Approval = createApproval({ id: 'apr_q', subjectType: 'asset', subjectRef: 'inst/q', title: 'Q', chain: quorum, nominees: [], createdBy: 'maker', now });
  a = applyAction(a, { id: 'r1', groups: ['brand'] }, 'approve', 'one of two', now);
  const pulled = withdraw(a, 'maker', '2026-11-12T01:00:00.000Z');
  assert.equal(pulled.state, 'withdrawn');
  assert.deepEqual(pulled.actions.at(-1), { actor: 'maker', step: 0, action: 'withdraw', at: '2026-11-12T01:00:00.000Z' });
  assert.equal(a.actions.length, 1, 'the input is not changed');
  assert.throws(() => withdraw(pulled, 'maker', now), /already withdrawn/);
});

test('an approval that cannot be stored leaves no record, no bytes and no charge', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  w.store.putApproval = async () => { throw new Error('synthetic approval store failure'); };
  const res = await fetch(`${w.base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  assert.equal(res.status, 500);
  assert.deepEqual(await w.store.listInstanceAssets(), [], 'no record waits for an approval that does not exist');
  assert.equal(((await w.blobs.usage!())?.storedBytes ?? 0), 0, 'the bytes went too');
  for (const scope of ['design', 'author']) {
    const row = await w.store.getSubmitQuota(scope);
    assert.equal(row?.count ?? 0, 0, `${scope}: the charge was released`);
    assert.equal(row?.bytes ?? 0, 0);
  }
  assert.deepEqual(await w.store.listCredentials(), []);
});

test('an approval write that committed but reported an error keeps the submission whole', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const real = w.store.putApproval.bind(w.store);
  w.store.putApproval = async (approval) => { await real(approval); throw new Error('synthetic lost acknowledgement'); };
  const { assetId, approvalId } = await w.submit(author);
  assert.ok(await w.store.getApproval(approvalId), 'the approval a reviewer may already act on');
  const record = (await w.store.getInstanceAsset(assetId))!;
  assert.equal(record.submission?.approvalId, approvalId);
  assert.ok(((await w.blobs.usage!())?.storedBytes ?? 0) > 0, 'the bytes stay');
  assert.equal((await w.store.getSubmitQuota('design'))?.count, 1, 'charged once, and kept');
});

test('an approval write whose outcome cannot be read keeps everything for an administrator', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const realGet = w.store.getApproval.bind(w.store);
  w.store.putApproval = async () => { throw new Error('synthetic approval store failure'); };
  w.store.getApproval = async () => { throw new Error('synthetic read failure'); };
  const res = await fetch(`${w.base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  assert.equal(res.status, 500);
  w.store.getApproval = realGet;
  const records = await w.store.listInstanceAssets();
  assert.equal(records.length, 1, 'nothing is deleted on a guess');
  assert.equal(records[0]!.submission?.state, 'submitted');
  assert.equal(await w.store.getApproval(records[0]!.submission!.approvalId!), null);
  assert.ok(((await w.blobs.usage!())?.storedBytes ?? 0) > 0);
});

test('a credential write that fails leaves no record, bytes or charge', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  w.store.putCredential = async () => { throw new Error('synthetic credential store failure'); };
  const res = await fetch(`${w.base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  assert.equal(res.status, 500);
  assert.deepEqual(await w.store.listInstanceAssets(), []);
  assert.deepEqual(await w.store.listApprovals(), [], 'no review was asked for');
  assert.equal(((await w.blobs.usage!())?.storedBytes ?? 0), 0);
  for (const scope of ['design', 'author']) assert.equal((await w.store.getSubmitQuota(scope))?.count ?? 0, 0, scope);
});

test('a metadata edit read before a decision never writes the published asset back to submitted', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const ana = await w.login('ana@test');
  const { assetId, approvalId } = await w.submit(author);
  // Hold the edit after it has read the pending record and passed its checks.
  const realMeta = w.store.getAssetMeta.bind(w.store);
  let arrived!: () => void, release!: () => void;
  const atGate = new Promise<void>((resolve) => { arrived = resolve; });
  const gate = new Promise<void>((resolve) => { release = resolve; });
  w.store.getAssetMeta = async (id) => { w.store.getAssetMeta = realMeta; arrived(); await gate; return realMeta(id); };
  const edit = fetch(`${w.base}/api/v1/catalog/submissions/${assetId.slice('inst/'.length)}`, {
    method: 'PATCH', headers: { cookie: author, 'content-type': 'application/json' }, body: JSON.stringify({ name: 'Renamed late' }),
  });
  await atGate;
  const decided = await w.post(ana, `/api/v1/approvals/${approvalId}/act`, { action: 'approve' });
  assert.equal(decided.status, 200);
  assert.equal((await w.store.getInstanceAsset(assetId))?.submission?.state, 'live');
  release();
  const edited = await edit;
  assert.equal(edited.status, 409);
  assert.equal(await errorCode(edited), 'ALREADY_SETTLED');
  const record = (await w.store.getInstanceAsset(assetId))!;
  assert.equal(record.submission?.state, 'live', 'the asset agrees with the approval');
  assert.equal((await w.store.getApproval(approvalId))?.state, 'approved');
  assert.equal(record.entry.name, 'Campaign Hero', 'the late edit wrote nothing');
});

test('bytes a failed submission could not delete keep a record until the sweep removes them', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const realDelete = w.blobs.delete.bind(w.blobs);
  w.store.putCredential = async () => { throw new Error('synthetic credential store failure'); };
  w.blobs.delete = async () => { throw new Error('synthetic blob outage'); };
  const res = await fetch(`${w.base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  assert.equal(res.status, 500);
  w.blobs.delete = realDelete;
  const [kept] = await w.store.listInstanceAssets();
  assert.ok(kept, 'the record still names the bytes');
  assert.equal(kept!.submission?.discarded, true);
  assert.equal(kept!.submission?.state, 'returned', 'never published, never pending');
  assert.ok(((await w.blobs.usage!())?.storedBytes ?? 0) > 0);
  assert.equal((await w.store.getSubmitQuota('design'))?.count ?? 0, 0, 'the charge was released');
  const queue = await (await fetch(`${w.base}/api/v1/catalog/submissions`, { headers: { cookie: author } })).json() as { submissions: unknown[] };
  assert.deepEqual(queue.submissions, [], 'no queue lists a submission that never finished');
  assert.equal(await sweepDiscardedSubmissions(w.store, w.blobs), 1);
  assert.deepEqual(await w.store.listInstanceAssets(), []);
  assert.equal(((await w.blobs.usage!())?.storedBytes ?? 0), 0);
  assert.equal(await sweepDiscardedSubmissions(w.store, w.blobs), 0, 'done once');
});

test('a record write that committed but reported an error finishes the submission', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  const real = w.store.putInstanceAsset.bind(w.store);
  w.store.putInstanceAsset = async (rec) => { w.store.putInstanceAsset = real; await real(rec); throw new Error('synthetic lost acknowledgement'); };
  const { assetId, approvalId } = await w.submit(author);
  const record = (await w.store.getInstanceAsset(assetId))!;
  assert.equal(record.submission?.state, 'submitted');
  assert.equal(record.submission?.approvalId, approvalId);
  assert.ok(await w.store.getApproval(approvalId), 'review started, so a retry is not told the admission is unfinished');
  assert.ok(await w.store.getCredential(assetId));
  assert.ok(((await w.blobs.usage!())?.storedBytes ?? 0) > 0, 'the bytes the record names are there');
});

test('a record write that did not commit leaves no bytes and no charge', async () => {
  const w = await boot(ONE_STEP);
  const author = await w.login('author@test');
  w.store.putInstanceAsset = async () => { throw new Error('synthetic record store failure'); };
  const res = await fetch(`${w.base}/api/v1/catalog/submit?name=Campaign%20Hero`, { method: 'POST', headers: { cookie: author, 'content-type': 'image/png' }, body: new Uint8Array(PNG) });
  assert.equal(res.status, 500);
  assert.deepEqual(await w.store.listInstanceAssets(), []);
  assert.deepEqual(await w.store.listApprovals(), []);
  assert.equal(((await w.blobs.usage!())?.storedBytes ?? 0), 0);
  assert.equal((await w.store.getSubmitQuota('design'))?.count ?? 0, 0);
});

