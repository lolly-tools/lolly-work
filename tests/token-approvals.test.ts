// SPDX-License-Identifier: MPL-2.0
/**
 * A partner's agent asks for approval (plans/82 M7 section 6a), over the real
 * app. Pinned here:
 *
 *  - only a token that names `approvals.request` asks, and only for an export
 *    review of one of its own finished renders; deciding stays with people;
 *  - nobody is nominated, and the chain is the tool's own or one the programme
 *    lists, so a partner's agent never reaches an internal chain by name;
 *  - the reviewed file is the render's own output, with the tool version and the
 *    digest the render took, never the tool's current ones;
 *  - an explicit export.request deny refuses a token as it refuses a person;
 *  - the approver reads who asked as the agent it is, never as a person;
 *  - under until-approved the next render after the decision is clean;
 *  - the token reads and withdraws its own requests, and nobody else's.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';
import { TOKEN_SCOPES, PROGRAMME_TOKEN_SCOPES, PROGRAMME_TOKEN_DEFAULT_SCOPES } from '../server/src/iam/token-scopes.ts';

const TOOL = 'plain-card';
const MARK = /lw-preview-watermark/;
let pack = '';
let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
let runner: RenderRunner | undefined;
const cookies: Record<string, string> = {};
const tokens: Record<string, { id: string; token: string }> = {};

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-token-approvals-'));
  await mkdir(join(pack, 'tools', TOOL), { recursive: true });
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'tools', TOOL, 'tool.json'), JSON.stringify({
    id: TOOL, name: 'Plain card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] }, inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' }],
  }));
  await writeFile(join(pack, 'tools', TOOL, 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100" viewBox="0 0 100 100"><text>{{title}}</text></svg>');
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: TOOL }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ assets: [] }));
  store = createMemoryStore();
  await store.putChain({ id: 'partner-review', name: 'Partner review', steps: [{ name: 'Brand team', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putChain({ id: 'internal-review', name: 'Internal', steps: [{ name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putOverlay({ toolId: TOOL, version: 1, enforce: { watermark: 'until-approved' } });
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Approvals', baseUrl: 'http://localhost', pack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'bruno@test', groups: ['approver', 'brand'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), metrics: createMetrics(), secrets: { session: 'sA', link: 'lA' },
    onRenderRunner: (r) => { runner = r; r.kick = () => {}; } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const who of ['owner', 'bruno']) {
    const login = await fetch(`${base}/api/auth/dev?email=${who}@test`, { redirect: 'manual' });
    cookies[who] = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  }
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: [TOOL], approvalChains: ['partner-review'] })).status, 201);
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/quiet', { name: 'Quiet', tools: [TOOL] })).status, 201);
  assert.ok((await as('owner', 'PUT', '/api/v1/programmes/resellers/companies/northwind', { name: 'Northwind IT' })).status < 300);
  const mint = async (key: string, programme: string, body: Record<string, unknown>) => {
    const made = await as('owner', 'POST', `/api/v1/programmes/${programme}/tokens`, body);
    assert.equal(made.status, 201, JSON.stringify(made.body));
    tokens[key] = { id: made.body.id, token: made.body.token };
  };
  await mint('rita', 'resellers', { label: "Rita's agent", company: 'northwind', scopes: ['render', 'catalog.read', 'approvals.request'] });
  await mint('other', 'resellers', { label: 'Other agent', company: 'northwind', scopes: ['render', 'catalog.read', 'approvals.request'] });
  await mint('plain', 'resellers', { label: 'Plain agent', scopes: ['render', 'catalog.read'] });
  await mint('quiet', 'quiet', { label: 'Quiet agent', scopes: ['render', 'catalog.read', 'approvals.request'] });
});
after(async () => {
  server.close();
  await rm(pack, { recursive: true, force: true });
});

async function as(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
async function bearer(key: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { authorization: `Bearer ${tokens[key]!.token}`, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
let rpcId = 0;
async function tool(key: string, name: string, args: Record<string, unknown>) {
  const res = await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens[key]!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/call', params: { name, arguments: args } }) });
  return ((await res.json()) as { result: { isError?: boolean; structuredContent: Record<string, any> } }).result;
}
async function toolNames(key: string): Promise<string[]> {
  const res = await fetch(`${base}/api/v1/mcp`, { method: 'POST', headers: { authorization: `Bearer ${tokens[key]!.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: ++rpcId, method: 'tools/list' }) });
  return ((await res.json()) as { result: { tools: Array<{ name: string }> } }).result.tools.map((t) => t.name);
}
/** One finished render by this token. */
async function rendered(key: string, title: string): Promise<{ id: string; marked: boolean; sha256: string }> {
  const made = await bearer(key, 'POST', '/api/v1/renders', { toolId: TOOL, format: 'svg', inputs: { title } });
  assert.equal(made.status, 202, JSON.stringify(made.body));
  let done = await bearer(key, 'GET', `/api/v1/renders/${made.body.id}`);
  for (let attempt = 0; attempt < 200 && !['succeeded', 'failed', 'cancelled'].includes(done.body.state); attempt++) {
    await runner!.tick();
    await new Promise((resolve) => setTimeout(resolve, 25));
    done = await bearer(key, 'GET', `/api/v1/renders/${made.body.id}`);
  }
  assert.equal(done.body.state, 'succeeded', JSON.stringify(done.body));
  const bytes = await (await fetch(`${base}/api/v1/renders/${made.body.id}/output/default`, { headers: { authorization: `Bearer ${tokens[key]!.token}` } })).text();
  return { id: made.body.id, marked: MARK.test(bytes), sha256: done.body.output.sha256 };
}

test('approvals.request is a scope a programme token may hold, opt-in and never by default', () => {
  assert.ok(TOKEN_SCOPES.includes('approvals.request'));
  assert.ok(PROGRAMME_TOKEN_SCOPES.includes('approvals.request'));
  assert.ok(!PROGRAMME_TOKEN_DEFAULT_SCOPES.includes('approvals.request'));
});

test('a token without the scope cannot ask, and is not offered the tools', async () => {
  const render = await rendered('plain', 'No scope');
  const refused = await bearer('plain', 'POST', '/api/v1/approvals', { subjectType: 'export-review', exportReview: { renderId: render.id } });
  assert.equal(refused.status, 403);
  assert.equal(refused.body.error.code, 'TOKEN_SCOPE');
  const names = await toolNames('plain');
  assert.ok(!names.includes('request_approval') && !names.includes('get_approval') && !names.includes('withdraw_approval'));
  assert.ok((await toolNames('rita')).includes('request_approval'));
});

test('an agent asks about its own render: the file is the render\'s, nobody is nominated, and the approver reads who asked', async () => {
  const render = await rendered('rita', 'SLES 16 webinar');
  assert.equal(render.marked, true, 'until approved, the render is marked');
  const asked = await tool('rita', 'request_approval', { renderId: render.id, title: 'Webinar banner' });
  assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent));
  const approval = (await store.getApproval(asked.structuredContent.id))!;
  assert.equal(approval.chainId, 'partner-review', 'the one chain the programme lists');
  assert.deepEqual(approval.nominees ?? [], []);
  assert.equal(approval.createdBy, `svc_${tokens.rita!.id}`);
  assert.equal(approval.exportReview?.origin, 'service-token');
  assert.equal(approval.exportReview?.sha256, render.sha256, 'the reviewed bytes are the render\'s own');
  assert.match(String(approval.exportReview?.inputsDigest), /^[a-f0-9]{64}$/, 'the digest the render took');
  const audit = (await store.listAudit()).find((a) => a.action === 'approval.submit' && a.subject === `approval:${approval.id}`);
  assert.equal(audit?.actor, `service:svc_${tokens.rita!.id}`);
  const inbox = (await store.listMessages()).find((m) => m.data?.approvalId === approval.id);
  assert.equal(inbox?.body, 'Northwind IT\'s agent (Rita\'s agent) asked for your review on the “Brand team” step.');
  // Bruno decides, a person; then the agent's next render of the same piece is clean.
  const reviewToken = (await fetch(`${base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: cookies.bruno! } })).headers.get('x-lolly-review-token');
  const decided = await as('bruno', 'POST', `/api/v1/approvals/${approval.id}/act`, { action: 'approve', comment: 'Good', artifactFingerprint: approval.exportReview!.fingerprint, reviewToken });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((await rendered('rita', 'SLES 16 webinar')).marked, false, 'the render after the decision is clean');
  assert.equal((await rendered('rita', 'Something else')).marked, true, 'another piece still needs its own approval');
  const read = await tool('rita', 'get_approval', { approvalId: approval.id });
  assert.equal(read.structuredContent.state, 'approved');
});

test('the notice names a long label short, and drops the brackets when there is none', async () => {
  const long = 'An agent with a label far longer than any notice should ever print in full';
  const made = await as('owner', 'POST', '/api/v1/programmes/resellers/tokens', { label: long, company: 'northwind', scopes: ['render', 'catalog.read', 'approvals.request'] });
  tokens.long = { id: made.body.id, token: made.body.token };
  const render = await rendered('long', 'Long label');
  const asked = await tool('long', 'request_approval', { renderId: render.id });
  const notice = (await store.listMessages()).find((m) => m.data?.approvalId === asked.structuredContent.id);
  assert.equal(notice?.body, 'Northwind IT\'s agent (An agent with a label far longer than...) asked for your review on the “Brand team” step.');
  // A label of spaces only, written straight to the store, prints no brackets.
  const record = (await store.getApiToken(tokens.long.id))!;
  await store.putApiToken({ ...record, label: '   ' });
  const again = await tool('long', 'request_approval', { renderId: (await rendered('long', 'No label')).id });
  const bare = (await store.listMessages()).find((m) => m.data?.approvalId === again.structuredContent.id);
  assert.equal(bare?.body, 'Northwind IT\'s agent asked for your review on the “Brand team” step.');
});

test('the chain: never an internal one by name, and none when the programme lists none', async () => {
  const render = await rendered('rita', 'Chains');
  const named = await bearer('rita', 'POST', '/api/v1/approvals', { subjectType: 'export-review', chainId: 'internal-review', exportReview: { renderId: render.id } });
  assert.equal(named.status, 403);
  assert.equal(named.body.error.code, 'CHAIN_NOT_FOR_PROGRAMME');
  const quiet = await rendered('quiet', 'Quiet');
  const none = await bearer('quiet', 'POST', '/api/v1/approvals', { subjectType: 'export-review', exportReview: { renderId: quiet.id } });
  assert.equal(none.body.error.code, 'CHAIN_NOT_FOR_PROGRAMME');
});

test('what a token may not ask: another subject, nominees, or someone else\'s render', async () => {
  const render = await rendered('rita', 'Refusals');
  assert.equal((await bearer('rita', 'POST', '/api/v1/approvals', { subjectType: 'asset', title: 'x', chainId: 'partner-review' })).status, 400);
  const nominated = await bearer('rita', 'POST', '/api/v1/approvals', { subjectType: 'export-review', nominees: ['someone'], exportReview: { renderId: render.id } });
  assert.equal(nominated.body.error.code, 'NOMINEES_NOT_FOR_TOKEN');
  assert.equal((await bearer('other', 'POST', '/api/v1/approvals', { subjectType: 'export-review', exportReview: { renderId: render.id } })).status, 404, 'another token\'s render is not there');
  assert.equal((await bearer('rita', 'POST', '/api/v1/approvals', { subjectType: 'export-review', exportReview: { renderId: 'rnd_missing' } })).status, 404);
  assert.equal((await bearer('rita', 'POST', '/api/v1/approvals/x/act', { action: 'approve' })).status, 403, 'deciding stays with people');
});

test('an explicit export.request deny refuses a token, as it refuses a person; no allow grant is needed', async () => {
  const made = await as('owner', 'POST', '/api/v1/programmes/resellers/tokens', { label: 'Denied agent', company: 'northwind', scopes: ['render', 'catalog.read', 'approvals.request'] });
  tokens.denied = { id: made.body.id, token: made.body.token };
  const render = await rendered('denied', 'Denied piece');
  await store.putGrant({ principal: `user:svc_${tokens.denied.id}`, action: 'export.request', resource: `tool:${TOOL}`, effect: 'deny' });
  const before = (await store.listApprovals()).length;
  const refused = await bearer('denied', 'POST', '/api/v1/approvals', { subjectType: 'export-review', exportReview: { renderId: render.id } });
  assert.equal(refused.status, 403, JSON.stringify(refused.body));
  assert.equal(refused.body.error.code, 'FORBIDDEN');
  const overMcp = await tool('denied', 'request_approval', { renderId: render.id });
  assert.equal(overMcp.isError, true);
  assert.equal((await store.listApprovals()).length, before, 'nothing was asked');
  assert.ok(!(await store.listGrants()).some((g) => g.action === 'export.request' && g.effect === 'allow'), 'the tokens that ask hold no allow grant');
});

test('the reviewed file carries only its own render\'s facts: an approval of an older file never clears a newer tool\'s render', async () => {
  const manifest = join(pack, 'tools', TOOL, 'tool.json');
  const original = JSON.parse(await readFile(manifest, 'utf8')) as Record<string, unknown>;
  try {
    // A render made before until-approved was on has no digest of its own.
    await store.putOverlay({ toolId: TOOL, version: 2, enforce: {} });
    const early = await rendered('rita', 'Early piece');
    assert.equal(early.marked, false);
    await store.putOverlay({ toolId: TOOL, version: 3, enforce: { watermark: 'until-approved' } });
    // A render made under until-approved by version 1.0.0 has one.
    const v1 = await rendered('rita', 'Version one piece');
    assert.equal(v1.marked, true);
    await writeFile(manifest, JSON.stringify({ ...original, version: '1.1.0' }));
    for (const [render, title] of [[early, 'Early piece'], [v1, 'Version one piece']] as const) {
      const asked = await tool('rita', 'request_approval', { renderId: render.id });
      assert.equal(asked.isError, undefined, JSON.stringify(asked.structuredContent));
      const approval = (await store.getApproval(asked.structuredContent.id))!;
      assert.equal(approval.exportReview?.toolVersion, '1.0.0', 'the version that made the file, not the one in the pack now');
      if (render === early) assert.equal(approval.exportReview?.inputsDigest, null, 'no digest the render did not take');
      else assert.match(String(approval.exportReview?.inputsDigest), /^[a-f0-9]{64}$/);
      const reviewToken = (await fetch(`${base}/api/v1/approvals/${approval.id}/artifact`, { headers: { cookie: cookies.bruno! } })).headers.get('x-lolly-review-token');
      const decided = await as('bruno', 'POST', `/api/v1/approvals/${approval.id}/act`, { action: 'approve', comment: 'Good', artifactFingerprint: approval.exportReview!.fingerprint, reviewToken });
      assert.equal(decided.status, 200, JSON.stringify(decided.body));
      assert.equal((await rendered('rita', title)).marked, true, `a 1.1.0 render of "${title}" still needs its own approval`);
    }
  } finally {
    await writeFile(manifest, JSON.stringify(original));
    await store.putOverlay({ toolId: TOOL, version: 4, enforce: { watermark: 'until-approved' } });
  }
});

test('a token reads and withdraws its own requests, and nobody else\'s', async () => {
  const render = await rendered('rita', 'Withdraw me');
  const asked = await tool('rita', 'request_approval', { renderId: render.id });
  const id = asked.structuredContent.id as string;
  assert.equal((await bearer('other', 'GET', `/api/v1/approvals/${id}`)).status, 404);
  assert.ok(!(await bearer('other', 'GET', '/api/v1/approvals')).body.approvals.some((a: { id: string }) => a.id === id));
  assert.ok((await bearer('rita', 'GET', '/api/v1/approvals')).body.approvals.some((a: { id: string }) => a.id === id));
  // Another token's request reads as a missing one, so withdrawing cannot tell them apart (plans/357 W1).
  const others = await bearer('other', 'POST', `/api/v1/approvals/${id}/withdraw`, {});
  const missing = await bearer('other', 'POST', '/api/v1/approvals/apr_missing0/withdraw', {});
  assert.deepEqual([others.status, others.body], [missing.status, missing.body]);
  assert.equal(others.status, 404);
  const withdrawn = await tool('rita', 'withdraw_approval', { approvalId: id });
  assert.equal(withdrawn.isError, undefined, JSON.stringify(withdrawn.structuredContent));
  assert.equal((await store.getApproval(id))!.state, 'withdrawn');
});

test('a programme\'s manager sets the chains its tokens may ask through', async () => {
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/quiet', { name: 'Quiet', approvalChains: ['nope'] })).body.error.code, 'UNKNOWN_CHAIN');
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/quiet', { name: 'Quiet', approvalChains: ['partner-review'] })).status, 200);
  assert.deepEqual((await store.getProgramme('quiet'))!.approvalChains, ['partner-review']);
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/quiet', { name: 'Quiet' })).status, 200);
  assert.deepEqual((await store.getProgramme('quiet'))!.approvalChains, ['partner-review'], 'a body that does not name them keeps them');
  assert.equal((await as('owner', 'PUT', '/api/v1/programmes/quiet', { name: 'Quiet', approvalChains: null })).status, 200);
  assert.equal((await store.getProgramme('quiet'))!.approvalChains, undefined);
});
