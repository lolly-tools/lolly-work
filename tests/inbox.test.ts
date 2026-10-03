import { test } from 'node:test';
import assert from 'node:assert/strict';
import { audienceMatches, compareVersions, targetedMessages, type Message } from '../server/src/inbox/target.ts';
import { createServer } from 'node:http';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

test('version compare handles unequal lengths and double digits', () => {
  assert.equal(compareVersions('1.61.0', '1.61.0'), 0);
  assert.equal(compareVersions('1.9.0', '1.10.0'), -1);
  assert.equal(compareVersions('1.61', '1.61.0'), 0);
  assert.equal(compareVersions('2.0.0', '1.99.99'), 1);
});

test('audience matrix: groups × shells × version range', () => {
  const upgradeNudge = { groups: ['*'], shells: ['tauri'], maxEngine: '1.52.99' };
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.50.0' }), true);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri', engineVersion: '1.61.0' }), false);
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'web', engineVersion: '1.50.0' }), false);
  // version-scoped messages don't reach clients whose version is unknown
  assert.equal(audienceMatches(upgradeNudge, { groups: ['eng'], shell: 'tauri' }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['marketing'] }), false);
  assert.equal(audienceMatches({ groups: ['brand-team'] }, { groups: ['brand-team', 'x'] }), true);
  assert.equal(audienceMatches({}, { groups: [] }), true); // default = everyone
});

test('per-user audience: only the named users match, and it ANDs with groups', () => {
  const aud = { users: ['u1', 'u2'] };
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u1' }), true);
  assert.equal(audienceMatches(aud, { groups: [], userId: 'u3' }), false);
  assert.equal(audienceMatches(aud, { groups: [] }), false); // no userId → no match
  // combined with a group selector, BOTH must hold
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u1' }), true);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['legal'], userId: 'u1' }), false);
  assert.equal(audienceMatches({ users: ['u1'], groups: ['brand'] }, { groups: ['brand'], userId: 'u2' }), false);
});

function msg(id: string, over: Partial<Message> = {}): Message {
  return { id, kind: 'announcement', severity: 'info', audience: {}, title: id, ...over };
}

test('targeting excludes acked and out-of-window messages', () => {
  const now = new Date('2026-07-21T12:00:00Z');
  const messages = [
    msg('live'),
    msg('acked'),
    msg('future', { startsAt: '2026-08-01T00:00:00Z' }),
    msg('ended', { endsAt: '2026-07-01T00:00:00Z' }),
  ];
  const out = targetedMessages(messages, { groups: [] }, new Set(['acked']), now);
  assert.deepEqual(out.map((m) => m.id), ['live']);
});

// ── GET /api/v1/inbox over HTTP (plans/74 invite spec R5) ───────────────────
// The shell asks on focus and once a minute while visible, so a quiet read
// must be a 304, and anything the caller would see differently must not be.

test('GET /api/v1/inbox: an ETag over what the caller sees, a 304 when nothing moved, and the unread count', async (t) => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-inbox-'));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Inbox Hub', baseUrl: 'https://team.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'ana@test', groups: [] }, { email: 'bo@test', groups: [] }] },
  }));
  const store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'sIb', link: 'lIb' } });
  const server = createServer((req, res) => void app(req, res));
  t.after(() => server.close());
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const ana = await login('ana@test');
  const bo = await login('bo@test');
  const anaId = (await store.findUsersByEmail('ana@test'))[0]!.id;
  const read = (cookie: string, etag?: string) => fetch(`${base}/api/v1/inbox`, { headers: { cookie, ...(etag ? { 'if-none-match': etag } : {}) } });

  await store.putMessage(msg('m1', { audience: { users: [anaId] }, data: { kind: 'welcome', at: new Date().toISOString() } }));
  const first = await read(ana);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag')!;
  assert.match(etag, /^"ib-[0-9a-f]{16}"$/);
  assert.equal(first.headers.get('cache-control'), 'private, no-cache');
  const body = await first.json() as { messages: Message[]; unread: number };
  assert.deepEqual([body.messages.map((m) => m.id), body.unread], [['m1'], 1]);

  // Nothing moved: 304 with the same tag and no body, a weak tag or a list included.
  const quiet = await read(ana, etag);
  assert.deepEqual([quiet.status, quiet.headers.get('etag'), await quiet.text()], [304, etag, '']);
  assert.equal((await read(ana, `"ib-0000000000000000", W/${etag}`)).status, 304);
  // Someone else's inbox has its own tag.
  assert.notEqual((await read(bo)).headers.get('etag'), etag);

  // A new message, and an acknowledgement, each move it.
  await store.putMessage(msg('m2', { audience: { users: [anaId] } }));
  const grown = await read(ana, etag);
  assert.equal(grown.status, 200);
  const grownTag = grown.headers.get('etag')!;
  assert.equal((await grown.json() as { unread: number }).unread, 2);
  assert.equal((await fetch(`${base}/api/v1/inbox/m1/ack`, { method: 'POST', headers: { cookie: ana } })).status, 200);
  const acked = await read(ana, grownTag);
  assert.equal(acked.status, 200);
  const ackedBody = await acked.json() as { messages: Message[]; unread: number };
  assert.deepEqual([ackedBody.messages.map((m) => m.id), ackedBody.unread], [['m2'], 1]);
  assert.equal((await fetch(`${base}/api/v1/inbox`)).status, 401);
});
