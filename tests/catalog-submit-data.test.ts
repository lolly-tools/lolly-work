/**
 * Templates and user tools through catalog submit (plan 299, track B).
 *
 * Both are data for one of the pack's tools, never code, so they ride the
 * same pipeline as a picture: quota, duplicate check, scan hook, review. What
 * this suite pins: the JSON is validated and normalized BEFORE it is hashed
 * or stored, against a tool the pack really has; an approved one composes
 * into the feed as type `template` or `user-tool` with the tool it opens in;
 * a reviewer reads a summary instead of a thumbnail and can choose the
 * collection it joins on approval; and a user tool's icon never carries
 * markup into another member's shell.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { createRequire } from 'node:module';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { parseDataSubmission } from '../server/src/catalog/submit-data.ts';
import type { AssetIndex } from '../server/src/catalog/lifecycle.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

const lookup = async (id: string) => (id === 'design' ? { inputs: ['doc', 'title'], name: 'Design' } : null);

test('a template is validated against the pack and normalized to what the feed will serve', async () => {
  const sent = Buffer.from(JSON.stringify({ toolId: 'design', id: 'x', name: '  Launch   poster ', values: { doc: '{}', __export_w: 1, stray: true }, extra: 'dropped' }));
  const out = await parseDataSubmission('template', sent, lookup);
  assert.equal(out.ok, true);
  if (!out.ok) return;
  assert.equal(out.name, 'Launch poster');
  assert.deepEqual(JSON.parse(out.bytes.toString('utf8')), { toolId: 'design', name: 'Launch poster', values: { doc: '{}', __export_w: 1, stray: true } });
  assert.deepEqual(out.summary, { kind: 'template', toolId: 'design', toolName: 'Design', valueCount: 3, undeclared: 1 });

  // The exported template file carries no tool id; the route passes it in.
  const file = Buffer.from(JSON.stringify({ id: 'poster', name: 'Poster', values: {} }));
  assert.equal((await parseDataSubmission('template', file, lookup)).ok, false);
  assert.equal((await parseDataSubmission('template', file, lookup, { toolId: 'design' })).ok, true);

  for (const [bytes, why] of [
    ['not json', /JSON document/], ['[1,2]', /one JSON object/], ['{"toolId":"design","name":"a","values":[]}', /values must be an object/],
    ['{"toolId":"nope","name":"a","values":{}}', /no tool "nope"/], ['{"toolId":"../x","name":"a","values":{}}', /must name a tool/],
    ['{"toolId":"design","values":{}}', /needs a name/],
  ] as const) {
    const r = await parseDataSubmission('template', Buffer.from(bytes), lookup);
    assert.equal(r.ok, false, bytes);
    if (!r.ok) assert.match(r.detail, why);
  }
});

test('a user tool keeps a glyph icon and drops markup', async () => {
  const svg = await parseDataSubmission('user-tool', Buffer.from(JSON.stringify({
    baseToolId: 'design', title: 'Badge maker', icon: '<svg onload="x()"/>', formats: ['PNG', 'svg', 'bad format'], values: { doc: '{}' },
  })), lookup);
  assert.equal(svg.ok, true);
  if (svg.ok) {
    assert.equal(svg.icon, undefined);
    assert.deepEqual(svg.formats, ['png', 'svg']);
    assert.equal(JSON.parse(svg.bytes.toString('utf8')).icon, undefined);
  }
  const glyph = await parseDataSubmission('user-tool', Buffer.from(JSON.stringify({ baseToolId: 'design', title: 'Badge', icon: '★', values: {} })), lookup);
  assert.equal(glyph.ok && glyph.icon, '★');
});

// ── over HTTP ───────────────────────────────────────────────────────────────

async function boot(overrides: Record<string, unknown> = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-submit-data-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  await mkdir(join(pack, 'tools', 'design'), { recursive: true });
  await writeFile(join(pack, 'tools', 'design', 'tool.json'), JSON.stringify({ id: 'design', name: 'Design', inputs: [{ id: 'doc', type: 'longtext' }, { id: 'title', type: 'text' }] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Data Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'author@test', groups: ['author'] },
      { email: 'brand@test', groups: ['approver', 'brand'] },
      { email: 'viewer@test', groups: ['viewer'] },
    ] },
    ...overrides,
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sD', link: 'lD' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, store };
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const submitJson = (base: string, cookie: string, doc: unknown, params: Record<string, string>) =>
  fetch(`${base}/api/v1/catalog/submit?${new URLSearchParams(params)}`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(doc),
  });

test('over HTTP: an approved-by-default template composes into the feed as a template', async () => {
  const { base } = await boot();
  const author = await login(base, 'author@test');
  const res = await submitJson(base, author, { name: 'Launch poster', values: { doc: '{"pages":[]}', title: 'Hello' } },
    { type: 'template', toolId: 'design', tags: 'launch', clientRef: 'template:ut-1', note: 'For the October launch' });
  assert.equal(res.status, 201);
  const body = await res.json() as { assetId: string; state: string; type: string; formats: string[] };
  assert.equal(body.state, 'live');
  assert.equal(body.type, 'template');
  assert.deepEqual(body.formats, ['json']);

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  const entry = feed.assets?.find((a) => a.id === body.assetId);
  assert.equal(entry?.type, 'template');
  assert.equal(entry?.name, 'Launch poster');
  assert.deepEqual(entry?.meta, { toolId: 'design', valueCount: 2 });
  assert.deepEqual(entry?.tags, ['launch']);
  const bytes = await fetch(`${base}/catalog/${body.assetId}/json`, { headers: { cookie: author } });
  assert.equal(bytes.headers.get('content-type'), 'application/json');
  assert.deepEqual(await bytes.json(), { toolId: 'design', name: 'Launch poster', values: { doc: '{"pages":[]}', title: 'Hello' } });

  // The same document again is a duplicate, reported, not a second asset.
  const again = await submitJson(base, author, { name: 'Launch poster', values: { doc: '{"pages":[]}', title: 'Hello' } }, { type: 'template', toolId: 'design' });
  assert.equal(again.status, 200);
  assert.equal((await again.json() as { duplicate: boolean }).duplicate, true);

  const mine = await (await fetch(`${base}/api/v1/catalog/submissions`, { headers: { cookie: author } })).json() as {
    submissions: Array<{ clientRef?: string; data?: { kind: string; toolName: string; valueCount: number } }>;
  };
  assert.equal(mine.submissions[0]?.clientRef, 'template:ut-1');
  assert.equal((mine.submissions[0] as { note?: string }).note, 'For the October launch', 'the note reaches the reviewer');
  assert.deepEqual(mine.submissions[0]?.data, { kind: 'template', toolId: 'design', toolName: 'Design', valueCount: 2, undeclared: 0 });

  // Refusals are 422 with the reason, and nothing is stored.
  const bad = await submitJson(base, author, { name: 'x', values: {} }, { type: 'template', toolId: 'no-such-tool' });
  assert.equal(bad.status, 422);
  assert.equal((await bad.json() as { error: { code: string } }).error.code, 'INVALID_SUBMISSION');
  const unnamed = await fetch(`${base}/api/v1/catalog/submit`, { method: 'POST', headers: { cookie: author }, body: 'x' });
  assert.equal(unnamed.status, 400, 'a file still needs a name');
  const viewer = await login(base, 'viewer@test');
  assert.equal((await submitJson(base, viewer, { name: 'x', values: {} }, { type: 'template', toolId: 'design' })).status, 403);
});

test('over HTTP: under review, a reviewer reads the summary, keeps the kind, and chooses the collection it joins', async () => {
  const { base, store } = await boot({ policy: { submit: { chain: 'brand-review' } } });
  await store.putChain({ id: 'brand-review', name: 'Brand review', steps: [{ name: 'Brand', approvers: { groups: ['brand'] }, rule: 'any' }], onReject: 'return-to-submitter' });
  await store.putGrant({ principal: 'group:brand', action: 'catalog.collection.manage', resource: '*', effect: 'allow' });
  await store.putCollection({ id: 'launch-kit', name: 'Launch kit', members: ['acme/logo'], curator: 'user:x', createdAt: 'a', updatedAt: 'a' });

  const author = await login(base, 'author@test');
  const res = await submitJson(base, author, { baseToolId: 'design', title: 'Badge maker', icon: '★', values: { doc: '{}' } }, { type: 'user-tool' });
  assert.equal(res.status, 201);
  const { assetId, state } = await res.json() as { assetId: string; state: string };
  assert.equal(state, 'submitted');
  const short = assetId.slice('inst/'.length);

  const brand = await login(base, 'brand@test');
  const queue = await (await fetch(`${base}/api/v1/catalog/submissions?state=submitted`, { headers: { cookie: brand } })).json() as {
    submissions: Array<{ id: string; type: string; name: string; data: { kind: string; toolName: string; valueCount: number } }>;
  };
  assert.equal(queue.submissions[0]?.type, 'user-tool');
  assert.equal(queue.submissions[0]?.name, 'Badge maker');
  assert.equal(queue.submissions[0]?.data.toolName, 'Design');

  const patch = (body: unknown, cookie = brand) => fetch(`${base}/api/v1/catalog/submissions/${short}`, {
    method: 'PATCH', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  assert.equal((await patch({ type: 'image' })).status, 400, 'a user tool keeps its type');
  assert.equal((await patch({ collectionId: 'no-such' })).status, 404);
  assert.equal((await patch({ collectionId: 'launch-kit' }, author)).status, 403, 'choosing a collection is the collection right');
  const chosen = await patch({ collectionId: 'launch-kit', tags: ['badges'] });
  assert.equal(chosen.status, 200);
  assert.equal((await chosen.json() as { submission: { collectionId: string } }).submission.collectionId, 'launch-kit');
  assert.deepEqual((await store.getCollection('launch-kit'))?.members, ['acme/logo'], 'nothing joins before approval');

  const acted = await fetch(`${base}/api/v1/catalog/submissions/${short}/act`, {
    method: 'POST', headers: { cookie: brand, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(acted.status, 200);
  assert.deepEqual((await store.getCollection('launch-kit'))?.members, ['acme/logo', assetId], 'appended, curated order kept');
  assert.equal((await store.getInstanceAsset(assetId))?.submission?.joinedCollection, 'launch-kit');
  const audit = (await store.listAudit()).find((e) => e.action === 'catalog.approve-submission');
  assert.equal((audit?.payload as { collection?: string }).collection, 'launch-kit');

  const feed = await (await fetch(`${base}/catalog/assets/index.json`, { headers: { cookie: author } })).json() as AssetIndex;
  const entry = feed.assets?.find((a) => a.id === assetId);
  assert.equal(entry?.type, 'user-tool');
  assert.deepEqual(entry?.meta, { baseToolId: 'design', valueCount: 1, icon: '★' });
  assert.deepEqual(entry?.tags, ['badges']);
  assert.deepEqual((feed.collections as Array<{ id: string; members: string[] }>)[0]?.members, [assetId], 'the served collection lists it');
});

test('console: an exported template file names its tool by the longest known prefix', async () => {
  const { toolFromFilename } = createRequire(import.meta.url)('../console/catalog-submit.js') as { toolFromFilename: (f: string, ids: string[]) => string };
  const ids = ['qr', 'qr-code', 'design', 'event-name-badge'];
  assert.equal(toolFromFilename('qr-code-booth-qr.json', ids), 'qr-code');
  assert.equal(toolFromFilename('event-name-badge-summit.json', ids), 'event-name-badge');
  assert.equal(toolFromFilename('poster.json', ids), '');
});
