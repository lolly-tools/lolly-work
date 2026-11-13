// SPDX-License-Identifier: MPL-2.0
/**
 * Three access fences on approvals and catalog submission (plans/357 W-M0-1),
 * over the real app. Pinned here:
 *
 *  - W1: a partner programme member reads, and asks through, only the approval
 *    chains that belong to their programme: the chain bound to a tool they may
 *    use, and the chains their programme lists. That is the rule a programme
 *    token already follows. Every other chain, internal or missing, gets one
 *    answer, and a partner never files a request about the workspace's settings,
 *    tools or guest links. Staff keep every chain. A rules tool published to
 *    the programme keeps its own chain without a grant. Deciding and
 *    withdrawing answer a partner the same for another's request and a
 *    missing one, and an action from before they joined a programme opens no
 *    internal request file.
 *  - W2: being in a step's approver group is not enough to review a catalog
 *    submission. The queue row, the pending bytes, the metadata edit and the
 *    reviewer email each also need `approval.act` on that request, checked with
 *    the resources the decide route checks, so a grant or a deny on the chain
 *    moves all of them together.
 *  - W3: a service token cannot submit to the catalog or add a version,
 *    whatever its role. A scoped token is still refused by the scope table.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import { createServer as createNetServer, type Server as NetServer, type Socket } from 'node:net';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { instanceAssetEntry } from '../server/src/catalog/instance-assets.ts';
import { mintServiceSecret } from '../server/src/iam/service-tokens.ts';
import { createApproval } from '../server/src/approvals/engine.ts';
import { ZipBuilder } from '../server/src/links/zip.ts';

/** A tool in the programme whose outputs go through its own chain. */
const BOUND_TOOL = 'partner-card';
/** A tool in the programme with no chain of its own. */
const FREE_TOOL = 'free-card';
/** A staff tool outside the programme, bound to an internal chain. */
const STAFF_TOOL = 'staff-card';

/** A 1x1 PNG, real enough that the sniffer reads its IHDR. */
const PNG = Buffer.from(
  '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c6360000002000100' +
  '05fe02fea7c1cd0e0000000049454e44ae426082', 'hex');
const SVG = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>');
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex');

interface CapturedMail { to: string[]; data: string }

let pack = '';
let server: Server;
let smtpServer: NetServer;
let base = '';
let store: ReturnType<typeof createMemoryStore>;
const mails: CapturedMail[] = [];
const cookies: Record<string, string> = {};
const ids: Record<string, string> = {};
const tokens: Record<string, string> = {};

/** A minimal ESMTP relay that keeps every message it is handed. */
function smtpFixture(): Promise<number> {
  smtpServer = createNetServer((socket: Socket) => {
    socket.on('error', () => { /* client teardown races are fine for a fixture */ });
    let mail: CapturedMail = { to: [], data: '' };
    let inData = false;
    let buf = '';
    socket.write('220 fixture ESMTP\r\n');
    socket.on('data', (chunk) => {
      buf += chunk.toString('utf8');
      if (inData) {
        const end = buf.indexOf('\r\n.\r\n');
        if (end < 0) return;
        mail.data = buf.slice(0, end);
        buf = buf.slice(end + 5);
        inData = false;
        mails.push(mail);
        mail = { to: [], data: '' };
        socket.write('250 stored\r\n');
      }
      let at: number;
      while (!inData && (at = buf.indexOf('\r\n')) >= 0) {
        const line = buf.slice(0, at);
        buf = buf.slice(at + 2);
        if (/^EHLO/i.test(line)) socket.write('250-fixture\r\n250 OK\r\n');
        else if (/^RCPT TO:/i.test(line)) { mail.to.push(line.slice(8).replace(/[<>]/g, '')); socket.write('250 OK\r\n'); }
        else if (/^DATA/i.test(line)) { inData = true; socket.write('354 go\r\n'); }
        else if (/^QUIT/i.test(line)) socket.write('221 bye\r\n');
        else socket.write('250 OK\r\n');
      }
    });
  });
  return new Promise((resolve) => smtpServer.listen(0, '127.0.0.1', () => {
    const addr = smtpServer.address();
    resolve(typeof addr === 'object' && addr ? addr.port : 0);
  }));
}

async function until(cond: () => boolean, what: string, ms = 5000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`);
    await new Promise((r) => setTimeout(r, 25));
  }
}

const PEOPLE = ['owner', 'staff', 'rita', 'brand', 'lurker', 'lead', 'muted', 'legal', 'former', 'author'] as const;
const email = (who: string) => who === 'rita' ? 'rita@acme.test' : `${who}@test`;

before(async () => {
  pack = await mkdtemp(join(tmpdir(), 'lw-approval-fences-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  for (const tool of [BOUND_TOOL, FREE_TOOL, STAFF_TOOL]) {
    await mkdir(join(pack, 'tools', tool), { recursive: true });
    await writeFile(join(pack, 'tools', tool, 'tool.json'), JSON.stringify({
      id: tool, name: tool, version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
      render: { width: 10, height: 10, formats: ['svg'] }, inputs: [{ id: 'title', label: 'Title', type: 'text', default: 'Hello' }],
    }));
    await writeFile(join(pack, 'tools', tool, 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><text>{{title}}</text></svg>');
  }
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [{ id: BOUND_TOOL }, { id: FREE_TOOL }, { id: STAFF_TOOL }] }));
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const smtpPort = await smtpFixture();
  store = createMemoryStore({ grants: [
    // A member who decides catalog reviews through a grant on the chain, not a role.
    { principal: 'group:leads', action: 'approval.act', resource: 'chain:brand-review', effect: 'allow' },
    // An approver kept off catalog reviews by a deny on the chain.
    { principal: 'group:muted', action: 'approval.act', resource: 'chain:brand-review', effect: 'deny' },
  ] });
  const step = (name: string, group: string) => [{ name, approvers: { groups: [group] }, rule: 'any' as const }];
  await store.putChain({ id: 'partner-review', name: 'Partner review', steps: step('Brand team', 'brand'), onReject: 'return-to-submitter' });
  await store.putChain({ id: 'bound-review', name: 'Partner card review', steps: step('Brand team', 'brand'), onReject: 'return-to-submitter' });
  await store.putChain({ id: 'internal-review', name: 'Legal', steps: step('Legal', 'legal'), onReject: 'return-to-submitter' });
  await store.putChain({ id: 'brand-review', name: 'Catalog review', steps: step('Brand', 'brand'), onReject: 'return-to-submitter' });
  await store.putOverlay({ toolId: BOUND_TOOL, version: 1, enforce: { escalation: 'bound-review' } });
  await store.putOverlay({ toolId: STAFF_TOOL, version: 1, enforce: { escalation: 'internal-review' } });
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Fences', baseUrl: 'http://hub.example', pack }, rateLimit: { enabled: false },
    policy: { submit: { chain: 'brand-review' } },
    notify: { smtp: { host: '127.0.0.1', port: smtpPort, from: 'lolly@hub.example' } },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] },
      { email: 'staff@test', groups: ['marketing'] },
      { email: 'rita@acme.test', groups: [] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
      // In the step's group, with no right to decide.
      { email: 'lurker@test', groups: ['brand'] },
      { email: 'lead@test', groups: ['brand', 'leads'] },
      { email: 'muted@test', groups: ['approver', 'brand', 'muted'] },
      { email: 'legal@test', groups: ['approver', 'legal'] },
      // An internal reviewer who later joins a partner programme.
      { email: 'former@test', groups: ['approver', 'legal'] },
      { email: 'author@test', groups: ['author', 'design'] },
    ] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sF', link: 'lF' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  for (const who of PEOPLE) {
    const login = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email(who))}`, { redirect: 'manual' });
    cookies[who] = login.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
    ids[who] = (await store.getUserBySub(`dev:${email(who)}`))!.id;
  }
  const programme = await call('owner', 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers, EMEA', tools: [BOUND_TOOL, FREE_TOOL], approvalChains: ['partner-review'] });
  assert.equal(programme.status, 201, JSON.stringify(programme.body));
  assert.equal((await call('owner', 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
  // Sign Rita in again so the session carries the programme group.
  const relogin = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent('rita@acme.test')}`, { redirect: 'manual' });
  cookies.rita = relogin.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  assert.ok((await store.getUser(ids.rita!))!.groups.includes('programme-resellers'), 'Rita is in the programme');
  const token = async (id: string, role: string, scopes?: string[]) => {
    const secret = mintServiceSecret();
    await store.putApiToken({ id, label: id, role, tokenHash: secret.tokenHash, createdBy: 'system', createdAt: new Date().toISOString(), ...(scopes ? { scopes: scopes as never } : {}) });
    tokens[id] = secret.secret;
  };
  // An unscoped author token with no expiry, as tokens were minted before scopes.
  await token('legacy', 'author');
  await token('admin', 'admin');
  await token('scoped', 'automation', ['render', 'catalog.read']);
});
after(async () => {
  server.close();
  smtpServer.close();
  await rm(pack, { recursive: true, force: true });
});

async function call(who: string, method: string, path: string, body?: unknown) {
  const res = await fetch(`${base}${path}`, { method, headers: { cookie: cookies[who]!, 'content-type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
}
const codeOf = (r: { status: number; body: Record<string, any> }) => [r.status, r.body?.error?.code ?? 'ok'];

/** An approval-artifact upload of the SVG, finished, by this person. */
async function artifact(who: string): Promise<string> {
  const begun = await call(who, 'POST', '/api/v1/uploads', { scope: 'approval-artifact', name: 'card.svg', contentType: 'image/svg+xml', size: SVG.length, checksum: sha(SVG), parts: [{ size: SVG.length, checksum: sha(SVG) }] });
  assert.equal(begun.status, 201, JSON.stringify(begun.body));
  const id = begun.body.upload.id as string;
  assert.equal((await fetch(`${base}/api/v1/uploads/${id}/parts/0`, { method: 'PUT', headers: { cookie: cookies[who]!, 'content-type': 'application/octet-stream' }, body: SVG })).status, 204);
  assert.equal((await call(who, 'POST', `/api/v1/uploads/${id}/finalize`, {})).status, 200);
  return id;
}
async function exportReview(who: string, toolId: string, chainId: string, nominees: string[] = [ids.brand!]) {
  const uploadId = await artifact(who);
  return call(who, 'POST', '/api/v1/approvals', { subjectType: 'export-review', title: `${toolId} for review`, chainId, nominees,
    exportReview: { uploadId, checksum: sha(SVG), toolId, format: 'svg' } });
}

// ── W1: partner programme members and internal chains ───────────────────────

test('a partner reads only the chains that belong to their programme, and staff read every chain', async () => {
  const listed = (r: { body: Record<string, any> }) => (r.body.chains as Array<{ id: string }>).map((c) => c.id).sort();
  const staff = await call('staff', 'GET', '/api/v1/chains');
  assert.equal(staff.status, 200);
  assert.deepEqual(listed(staff), ['bound-review', 'brand-review', 'internal-review', 'partner-review']);
  const rita = await call('rita', 'GET', '/api/v1/chains');
  assert.equal(rita.status, 200);
  assert.deepEqual(listed(rita), ['bound-review', 'partner-review'], 'the chain of a tool in the programme, and the chain the programme lists');
});

test('a partner lists the approvers of their own chains only, and an internal chain reads as missing', async () => {
  for (const chainId of ['internal-review', 'brand-review', 'no-such-chain']) {
    const refused = await call('rita', 'GET', `/api/v1/approvals/approvers?chainId=${chainId}`);
    assert.deepEqual([refused.status, refused.body.error], [404, { code: 'NOT_FOUND', message: 'not available' }], chainId);
  }
  const bound = await call('rita', 'GET', '/api/v1/approvals/approvers?chainId=bound-review');
  assert.equal(bound.status, 200, JSON.stringify(bound.body));
  const names = (bound.body.approvers as Array<{ id: string }>).map((a) => a.id);
  assert.ok(names.includes(ids.brand!), 'an approver of the step is listed for nomination');
  assert.ok(!names.includes(ids.lurker!), 'nobody without approval.act');
  assert.equal((await call('rita', 'GET', '/api/v1/approvals/approvers?chainId=partner-review')).status, 200);
  assert.equal((await call('staff', 'GET', '/api/v1/approvals/approvers?chainId=internal-review')).status, 200, 'staff keep every chain');
});

test('a partner files a request only through their own chains and only about their own work', async () => {
  const ask = (who: string, subjectType: string, chainId: string) =>
    call(who, 'POST', '/api/v1/approvals', { subjectType, subjectRef: `tool:${FREE_TOOL}`, title: `${subjectType} on ${chainId}`, chainId });
  const before = (await store.listApprovals()).length;
  for (const chainId of ['internal-review', 'brand-review', 'no-such-chain']) {
    assert.deepEqual(codeOf(await ask('rita', 'asset', chainId)), [403, 'CHAIN_NOT_FOR_PROGRAMME'], chainId);
  }
  for (const subjectType of ['config', 'tool-change', 'guest-link']) {
    assert.deepEqual(codeOf(await ask('rita', subjectType, 'partner-review')), [403, 'FORBIDDEN'], subjectType);
  }
  assert.deepEqual(codeOf(await exportReview('rita', FREE_TOOL, 'internal-review')), [403, 'CHAIN_NOT_FOR_PROGRAMME'], 'a file for an unbound tool cannot go to an internal chain');
  assert.equal((await store.listApprovals()).length, before, 'nothing was filed');
  await new Promise((r) => setTimeout(r, 150));
  assert.ok(!mails.some((m) => m.to.includes('legal@test')), 'no internal approver was mailed');

  // What a partner legitimately asks: the request the app files for a tool's
  // output, with or without the file, on the tool's chain or the programme's.
  assert.deepEqual(codeOf(await call('rita', 'POST', '/api/v1/approvals', { subjectType: 'asset', subjectRef: `tool:${BOUND_TOOL}`, title: 'Partner card', chainId: 'bound-review', nominees: [ids.brand] })), [201, 'ok']);
  assert.deepEqual(codeOf(await ask('rita', 'asset', 'partner-review')), [201, 'ok']);
  assert.deepEqual(codeOf(await exportReview('rita', BOUND_TOOL, 'bound-review')), [201, 'ok']);
  assert.deepEqual(codeOf(await exportReview('rita', FREE_TOOL, 'partner-review')), [201, 'ok']);
  assert.deepEqual(codeOf(await exportReview('rita', BOUND_TOOL, 'partner-review')), [400, 'CHAIN_NOT_BOUND'], 'a bound tool still takes its own chain');
  const mine = await call('rita', 'GET', '/api/v1/approvals?mine=1');
  assert.equal(mine.body.approvals.length, 4, 'Rita follows her own requests');

  // Staff are not narrowed.
  assert.deepEqual(codeOf(await ask('staff', 'config', 'internal-review')), [201, 'ok']);
});

test('deciding and withdrawing tell a partner nothing about requests that are not theirs', async () => {
  const internal = await call('staff', 'POST', '/api/v1/approvals', { subjectType: 'config', subjectRef: 'cfg:theme', title: 'Theme change', chainId: 'internal-review' });
  assert.equal(internal.status, 201);
  // A source review Rita cannot see, which the decide route used to name in its refusal.
  const hidden = createApproval({ id: 'apr_hiddensrc', subjectType: 'source-review', subjectRef: 'source-review:x', title: 'Hidden source',
    chain: (await store.getChain('partner-review'))!, nominees: [], createdBy: ids.staff!, now: new Date().toISOString() });
  await store.putApproval({ ...hidden, sourceReview: { purpose: 'p', target: 't', fingerprint: 'x', origin: 'member-session', observedAt: new Date().toISOString(),
    mappingRevision: 'instance-source-review-v1', metadataHistory: 'not-recorded', files: [{ assetId: 'inst/nowhere', version: 1, format: 'png', sha256: '0'.repeat(64), representation: 'original' }] } });
  const refusal = { status: 404, body: { error: { code: 'NOT_FOUND', message: 'not available' } } };
  const answer = async (path: string, body: unknown) => { const r = await call('rita', 'POST', path, body); return { status: r.status, body: r.body }; };
  for (const id of [internal.body.id, 'apr_hiddensrc', 'apr_missing0']) {
    assert.deepEqual(await answer(`/api/v1/approvals/${id}/act`, { action: 'approve' }), refusal, `act on ${id}`);
    assert.deepEqual(await answer(`/api/v1/approvals/${id}/withdraw`, {}), refusal, `withdraw ${id}`);
  }
  assert.equal((await store.getApproval(internal.body.id))!.state, 'in_review', 'nothing moved');
  // Staff keep the plainer answers, and a partner still withdraws their own request.
  assert.deepEqual(codeOf(await call('lurker', 'POST', `/api/v1/approvals/${internal.body.id}/withdraw`, {})), [403, 'FORBIDDEN']);
  const own = (await call('rita', 'GET', '/api/v1/approvals?mine=1')).body.approvals.find((a: { state: string }) => a.state === 'in_review') as { id: string };
  assert.deepEqual(codeOf(await call('rita', 'POST', `/api/v1/approvals/${own.id}/withdraw`, {})), [200, 'ok']);
});

// ── W2: review visibility needs approval.act ────────────────────────────────

test('a submission under review reaches only the people who may decide it', async () => {
  const sent = mails.length;
  const submitted = await fetch(`${base}/api/v1/catalog/submit?name=Hero`, { method: 'POST', headers: { cookie: cookies.author!, 'content-type': 'image/png' }, body: PNG });
  assert.equal(submitted.status, 201);
  const { assetId, state } = await submitted.json() as { assetId: string; state: string };
  assert.equal(state, 'submitted');
  const short = assetId.slice('inst/'.length);

  await until(() => mails.slice(sent).some((m) => /Subject: Submission to review/.test(m.data)), 'the reviewer mail');
  const mail = mails.slice(sent).find((m) => /Subject: Submission to review/.test(m.data))!;
  assert.deepEqual([...mail.to].sort(), ['brand@test', 'lead@test'], 'the approver and the member with a grant on the chain, never the group alone or a denied approver');

  const queued = async (who: string) => ((await call(who, 'GET', '/api/v1/catalog/submissions?state=submitted')).body.submissions as Array<{ id: string; relation: string }>)
    .find((row) => row.id === assetId)?.relation ?? null;
  const bytes = async (who: string) => (await fetch(`${base}/api/v1/catalog/submissions/${short}/bytes`, { headers: { cookie: cookies[who]! } })).status;
  const rename = async (who: string, name: string) => codeOf(await call(who, 'PATCH', `/api/v1/catalog/submissions/${short}`, { name }));
  for (const who of ['lurker', 'muted']) {
    assert.equal(await queued(who), null, `${who} gets no queue row`);
    assert.equal(await bytes(who), 403, `${who} reads no pending bytes`);
    assert.deepEqual(await rename(who, `Hero by ${who}`), [403, 'FORBIDDEN'], `${who} edits nothing`);
    assert.deepEqual(codeOf(await call(who, 'POST', `/api/v1/catalog/submissions/${short}/act`, { action: 'approve' })), [403, 'FORBIDDEN'], `${who} cannot decide either`);
  }
  for (const who of ['brand', 'lead']) {
    assert.equal(await queued(who), 'inbox', `${who} reviews`);
    assert.equal(await bytes(who), 200, `${who} reads the bytes`);
  }
  assert.deepEqual(await rename('brand', 'Hero, corrected'), [200, 'ok']);
  assert.equal(await queued('author'), 'mine', 'the submitter keeps their own row');
  assert.equal((await store.getInstanceAsset(assetId))?.entry.name, 'Hero, corrected');
  // The person the queue and the mail name is the person who may decide.
  const decided = await call('lead', 'POST', `/api/v1/catalog/submissions/${short}/act`, { action: 'approve' });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal(decided.body.state, 'live');
});

// ── W3: service tokens do not submit ────────────────────────────────────────

test('a service token cannot submit to the catalog or add a version, whatever its role', async () => {
  const at = new Date().toISOString();
  const target = 'inst/token-target';
  await store.putInstanceAsset({
    id: target, entry: instanceAssetEntry(target, { name: 'Target', type: 'image' }, [{ format: 'png', size: PNG.length, checksum: sha(PNG) }]),
    blobs: { png: `${target}/png` }, groups: '*' as never, createdAt: at,
    submission: { at, checksum: sha(PNG), size: PNG.length, contentType: 'image/png', state: 'live', by: `user:${ids.author}` },
  } as never);
  const count = (await store.listInstanceAssets()).length;
  const head = (await store.getInstanceAsset(target))?.headVersion;
  const send = async (secret: string, query: string) => {
    const res = await fetch(`${base}/api/v1/catalog/submit?${query}`, { method: 'POST', headers: { authorization: `Bearer ${secret}`, 'content-type': 'image/png' }, body: PNG });
    return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
  };
  for (const id of ['legacy', 'admin']) {
    const refused = await send(tokens[id]!, 'name=From%20a%20token');
    assert.deepEqual(codeOf(refused), [403, 'HUMAN_SUBMISSION_REQUIRED'], `${id} token`);
    assert.match(refused.body.error.message, /person/);
  }
  assert.deepEqual(codeOf(await send(tokens.admin!, `assetId=${encodeURIComponent(target)}&note=token`)), [403, 'HUMAN_SUBMISSION_REQUIRED'], 'nor a new version');
  assert.deepEqual(codeOf(await send(tokens.scoped!, 'name=Scoped')), [403, 'TOKEN_SCOPE'], 'a scoped token stays refused by the scope table');
  assert.deepEqual(codeOf(await send('lwt_not-a-real-token', 'name=Nobody')), [401, 'UNAUTHORIZED'], 'an unknown token is not a caller');
  assert.equal((await store.listInstanceAssets()).length, count, 'nothing was stored');
  assert.equal((await store.getInstanceAsset(target))?.headVersion, head, 'the asset kept its version');
  assert.ok(!(await store.listAudit()).some((e) => e.action === 'catalog.submit' && e.actor.startsWith('user:svc_')), 'no token submission was audited');
});

// ── W1, continued: an earlier action opens no internal file ────────────────

test('a reviewer who later joins a programme reads no internal request file through an earlier decision', async () => {
  const asked = await exportReview('staff', STAFF_TOOL, 'internal-review', [ids.former!]);
  assert.equal(asked.status, 201, JSON.stringify(asked.body));
  const id = asked.body.id as string;
  const read = (who: string, approvalId = id) => fetch(`${base}/api/v1/approvals/${approvalId}/artifact`, { headers: { cookie: cookies[who]! } });
  const opened = await read('former');
  assert.equal(opened.status, 200);
  const decided = await call('former', 'POST', `/api/v1/approvals/${id}/act`, { action: 'approve', artifactFingerprint: asked.body.exportReview.fingerprint, reviewToken: opened.headers.get('x-lolly-review-token') });
  assert.equal(decided.status, 200, JSON.stringify(decided.body));
  assert.equal((await read('former')).status, 200, 'as staff, the reviewer who acted reads the file');

  assert.equal((await call('owner', 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'former@test' }], apply: true })).status, 200);
  const relogin = await fetch(`${base}/api/auth/dev?email=former%40test`, { redirect: 'manual' });
  cookies.former = relogin.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  assert.ok((await store.getUser(ids.former!))!.groups.includes('programme-resellers'));
  const fenced = await read('former');
  const missing = await read('former', 'apr_missing0');
  assert.deepEqual([fenced.status, await fenced.json()], [missing.status, await missing.json()], 'reads exactly as a missing file');
  assert.equal(fenced.status, 404);
  assert.equal((await read('staff')).status, 200, 'the requester still gets the approved file');
});

// ── W1, continued: a rules tool published to the programme keeps its chain ──

const RULES_RENDERER = '/* this workspace\'s Design renderer */ var LollyDesignRules = {};';
const ENGINE: string = '@lolly/engine';

/** A Share with rules file the way Lolly writes one: the compiled tool under tool/. */
async function rulesFile(): Promise<Buffer> {
  const { compileDesignTool } = await import(ENGINE) as {
    compileDesignTool(d: Record<string, unknown>, r: { source: string; styles: string }, a: Record<string, Uint8Array>): { files: Record<string, string | Uint8Array> };
  };
  const definition = {
    schemaVersion: 1, id: 'partner-data-sheet', name: 'Partner data sheet', description: 'Add your price.', version: '1.0.0',
    presentation: 'sidebar', formats: ['png', 'svg'],
    inputs: [{ input: { id: 'price', label: 'Price', type: 'text', default: '1,240', maxLength: 40 }, targets: [{ variantId: 'a4', layerId: 'price', property: 'text' }] }],
    variants: [{ id: 'a4', label: 'A4', width: 595, height: 842, background: '#ffffff', boxes: [{ id: 'price', kind: 'text', text: '1,240' }] }],
    defaultVariant: 'a4', choices: [], recipes: [],
    compilerVersion: 1, rendererDigest: sha(Buffer.from('/* the author\'s renderer */')), css: '', dependencies: [],
  };
  const compiled = compileDesignTool(definition, { source: '/* the author\'s renderer */', styles: '' }, {});
  const files: Record<string, Buffer> = {};
  for (const [path, value] of Object.entries(compiled.files)) files[`tool/${path}`] = Buffer.from(value as string);
  const manifest = {
    format: 'lolly-share', kind: 'tool', minReader: 2, tool: { id: definition.id, version: definition.version },
    bundledTool: { id: definition.id, version: definition.version, trust: 'custom', files: Object.keys(files).map((path) => ({ path })) },
    integrity: Object.fromEntries(Object.entries(files).map(([path, bytes]) => [path, sha(bytes)])),
  };
  const zip = new ZipBuilder();
  const parts = [zip.add('manifest.json', Buffer.from(JSON.stringify(manifest)))];
  for (const [path, bytes] of Object.entries(files)) parts.push(zip.add(path, bytes));
  parts.push(zip.end());
  return Buffer.concat(parts);
}

test('a rules tool published to the programme keeps its review chain for the partner, with no grant', async () => {
  const rulesPack = await mkdtemp(join(tmpdir(), 'lw-approval-fences-rules-'));
  await mkdir(join(rulesPack, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(rulesPack, 'catalog', 'assets'), { recursive: true });
  await mkdir(join(rulesPack, 'tools', 'design', 'assets'), { recursive: true });
  await writeFile(join(rulesPack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', version: '1.0.0', inputs: [] }));
  await writeFile(join(rulesPack, 'tools', 'design', 'assets', 'rules-renderer.js'), RULES_RENDERER);
  await writeFile(join(rulesPack, 'tools', 'design', 'styles.css'), '.design{}');
  await writeFile(join(rulesPack, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'design' }] }));
  await writeFile(join(rulesPack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const rulesStore = createMemoryStore();
  await rulesStore.putChain({ id: 'rules-review', name: 'Data sheet review', steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await rulesStore.putChain({ id: 'internal-review', name: 'Legal', steps: [{ name: 'Legal', approvers: { groups: ['legal'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await rulesStore.putOverlay({ toolId: 'partner-data-sheet', version: 1, enforce: { escalation: 'rules-review' } });
  const rulesConfig = parseConfig(JSON.stringify({
    instance: { name: 'Rules', baseUrl: 'http://localhost', pack: rulesPack }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'owner@test', groups: ['admin', 'owner'] }, { email: 'brand@test', groups: ['approver', 'brand'] }, { email: 'rita@acme.test', groups: [] }] },
  }));
  const rulesApp = buildApp({ config: rulesConfig, store: rulesStore, blobs: createMemoryBlobStore(), secrets: { session: 'sR', link: 'lR' } });
  const rulesServer = createServer((req, res) => void rulesApp(req, res));
  await new Promise<void>((r) => rulesServer.listen(0, '127.0.0.1', () => r()));
  try {
    const addr = rulesServer.address();
    const at = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
    const signIn = async (email: string) => (await fetch(`${at}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' }))
      .headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
    const send = async (cookie: string, method: string, path: string, body?: unknown, raw?: Buffer) => {
      const res = await fetch(`${at}${path}`, { method, headers: { cookie, 'content-type': raw ? 'application/octet-stream' : 'application/json' },
        ...(raw ? { body: new Uint8Array(raw) } : body === undefined ? {} : { body: JSON.stringify(body) }) });
      return { status: res.status, body: await res.json().catch(() => null) as Record<string, any> };
    };
    const owner = await signIn('owner@test');
    await signIn('brand@test');
    await signIn('rita@acme.test');
    assert.equal((await send(owner, 'PUT', '/api/v1/programmes/resellers', { name: 'Resellers', tools: [] })).status, 201);
    assert.equal((await send(owner, 'POST', '/api/v1/programmes/resellers/people', { rows: [{ email: 'rita@acme.test' }], apply: true })).status, 200);
    const published = await send(owner, 'POST', '/api/v1/catalog/submit?type=rules-tool&groups=programme-resellers', undefined, await rulesFile());
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const rita = await signIn('rita@acme.test');
    assert.ok(!(await rulesStore.listGrants()).some((g) => g.action === 'tool.use' && g.resource === 'tool:partner-data-sheet'), 'no grant names the rules tool');

    assert.deepEqual(((await send(rita, 'GET', '/api/v1/chains')).body.chains as Array<{ id: string }>).map((c) => c.id), ['rules-review']);
    assert.equal((await send(rita, 'GET', '/api/v1/approvals/approvers?chainId=rules-review')).status, 200);
    assert.equal((await send(rita, 'GET', '/api/v1/approvals/approvers?chainId=internal-review')).status, 404);
    const begun = await send(rita, 'POST', '/api/v1/uploads', { scope: 'approval-artifact', name: 'sheet.svg', contentType: 'image/svg+xml', size: SVG.length, checksum: sha(SVG), parts: [{ size: SVG.length, checksum: sha(SVG) }] });
    assert.equal(begun.status, 201, JSON.stringify(begun.body));
    const uploadId = begun.body.upload.id as string;
    assert.equal((await fetch(`${at}/api/v1/uploads/${uploadId}/parts/0`, { method: 'PUT', headers: { cookie: rita, 'content-type': 'application/octet-stream' }, body: SVG })).status, 204);
    assert.equal((await send(rita, 'POST', `/api/v1/uploads/${uploadId}/finalize`, {})).status, 200);
    const asked = await send(rita, 'POST', '/api/v1/approvals', { subjectType: 'export-review', title: 'Data sheet', chainId: 'rules-review',
      exportReview: { uploadId, checksum: sha(SVG), toolId: 'partner-data-sheet', format: 'svg' } });
    assert.equal(asked.status, 201, JSON.stringify(asked.body));
  } finally {
    rulesServer.close();
    await rm(rulesPack, { recursive: true, force: true });
  }
});
