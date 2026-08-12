// SPDX-License-Identifier: LicenseRef-Lolly-Work-Proprietary
/**
 * Live-collab invites over real HTTP (lolly-work plans/14 §6, OSS plans/100 §7
 * item 9): the eligible-principals autocomplete and the inbox delivery.
 *
 * The property under test throughout is that **the invite surface never widens
 * access**. A directory member with no visibility of the session's project is
 * invisible to the search AND refused by the POST — the two must agree, because
 * a client is free to skip the search and post an id it guessed. Everything
 * else here (prefix, cap, self-exclusion, duplicate collapse, the grant gate) is
 * a consequence of that one rule plus the approver-search disclosure precedent.
 *
 * Own server + pack, like tests/sessions.test.ts: an admin, a team that shares a
 * project, an outsider, an observer (session.edit denied), and 22 padding
 * members so the result cap is exercised against a real list.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../../server/src/config/instance.ts';
import { createMemoryStore } from '../../server/src/store/memory.ts';
import { buildApp } from '../../server/src/api/app.ts';
import { INVITEE_LIMIT, MAX_TITLE_CHARS, inviteMessageId } from '../../server/src/collab/invites.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

/** Enough eligible people that the cap has something to cut. */
const PADDING = Array.from({ length: 22 }, (_, i) => ({
  email: `zed${String(i).padStart(2, '0')}@test`,
  name: `Zed ${String(i).padStart(2, '0')}`,
  groups: ['team-eng'],
}));

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-collab-invites-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));

  const config = parseConfig(JSON.stringify({
    instance: { name: 'Invite Hub', baseUrl: 'http://localhost', pack, appUrl: 'https://app.example' },
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        // An admin who is ALSO in the project's group. The membership rule is
        // "the bypass is not a signal", not "hide admins" — she is offered.
        { email: 'owen@test', name: 'Owen Ops', groups: ['admin', 'team-eng'] },
        // In the project's group, but their group is denied `collab.join`: the
        // gateway would refuse the socket, so the invite box must not offer them.
        { email: 'cody@test', name: 'Cody Contractor', groups: ['team-eng', 'contractors'] },
        { email: 'alice@test', name: 'Alice Eng', groups: ['team-eng'] },
        { email: 'bob@test', name: 'Bob Eng', groups: ['team-eng'] },
        { email: 'bella@test', name: 'Bella Eng', groups: ['team-eng'] },
        // In the project, but session.edit is denied by grant below: the
        // observer seat. Holds collab.join, does not hold collab.edit.
        { email: 'ollie@test', name: 'Ollie Observer', groups: ['team-eng', 'readonly'] },
        // In the directory, NOT in the project's group. The control.
        { email: 'carol@test', name: 'Carol Design', groups: ['team-design'] },
        ...PADDING,
      ],
    },
  }));
  store = createMemoryStore();
  const app = buildApp({ config, store, secrets: { session: 'si', link: 'li' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}
const call = (cookie: string, method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

interface InviteeRow { id: string; name: string }
const invitees = async (cookie: string, query: string): Promise<{
  invitees: InviteeRow[]; truncated: boolean; limit: number;
}> => (await call(cookie, 'GET', `/api/v1/collab/invitees${query}`)).json() as never;

const inbox = async (cookie: string): Promise<Array<{ id: string; kind: string; title: string; cta?: { url: string }; data?: Record<string, string> }>> =>
  ((await (await call(cookie, 'GET', '/api/v1/inbox')).json()) as { messages: never[] }).messages;

const userId = async (email: string): Promise<string> =>
  ((await store.listUsers()).find((u) => u.email === email) as { id: string }).id;

// Shared across tests: the team project, its session, and a tombstoned one.
let sessionId = '';
let deletedSessionId = '';
let cookies: Record<string, string> = {};

test('setup: everyone signs in once, alice owns a team session, ollie is denied session.edit', async () => {
  for (const u of ['admin', 'owen', 'cody', 'alice', 'bob', 'bella', 'ollie', 'carol']) cookies[u] = await login(`${u}@test`);
  // Dev users only exist in the store once they authenticate — materialise the
  // padding so the directory is genuinely bigger than one page of results.
  for (const p of PADDING) await login(p.email);

  const project = await (await call(cookies['alice'] as string, 'POST', '/api/v1/projects', {
    name: 'Summit 2026', visibility: { groups: ['team-eng'] },
  })).json() as { id: string };

  const made = await (await call(cookies['alice'] as string, 'POST', `/api/v1/projects/${project.id}/sessions`, {
    toolId: 'poster', toolVersion: '1.0.0', inputs: { title: 'Draft' }, meta: { label: 'Keynote badge' },
  })).json() as { id: string };
  sessionId = made.id;

  const doomed = await (await call(cookies['alice'] as string, 'POST', `/api/v1/projects/${project.id}/sessions`, {
    toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: { label: 'Scrapped' },
  })).json() as { id: string };
  deletedSessionId = doomed.id;
  assert.equal((await call(cookies['alice'] as string, 'DELETE', `/api/v1/sessions/${doomed.id}`)).status, 200);

  // The observer seat: collab.edit IS session.edit (rbac/evaluate.ts
  // mayEditCollab), so denying that one grant is what makes a member an
  // observer — there is no separate collab.edit table to get out of step with.
  const deny = await call(cookies['admin'] as string, 'POST', '/api/v1/grants', {
    principal: 'group:readonly', action: 'session.edit', resource: '*', effect: 'deny',
  });
  assert.equal(deny.status, 201);

  const can = (await (await call(cookies['ollie'] as string, 'GET', '/api/v1/org-config')).json() as {
    can: Record<string, boolean>;
  }).can;
  assert.equal(can['collab.join'], true, 'the observer may still join the room');
  assert.equal(can['collab.edit'], false, 'but not write in it');
});

test('both routes are member-only, and answer the session read gate in the gateway’s order', async () => {
  assert.equal((await fetch(`${base}/api/v1/collab/invitees?sessionId=${sessionId}`)).status, 401);
  assert.equal((await fetch(`${base}/api/v1/collab/invites`, { method: 'POST' })).status, 401);

  const alice = cookies['alice'] as string;
  assert.equal((await call(alice, 'GET', '/api/v1/collab/invitees')).status, 400, 'sessionId required');
  assert.equal((await call(alice, 'GET', '/api/v1/collab/invitees?sessionId=ses_nope')).status, 404);
  assert.equal((await call(alice, 'GET', `/api/v1/collab/invitees?sessionId=${deletedSessionId}`)).status, 410);
  // Carol is a live member of the instance and a stranger to this project.
  assert.equal((await call(cookies['carol'] as string, 'GET', `/api/v1/collab/invitees?sessionId=${sessionId}`)).status, 403);
  assert.equal((await call(cookies['carol'] as string, 'POST', '/api/v1/collab/invites', {
    sessionId, userId: await userId('bob@test'),
  })).status, 403, 'a stranger cannot invite into a project they cannot see');
});

test('eligibility: only principals who could join appear — never the directory, never yourself', async () => {
  const { invitees: rows } = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=`);
  const names = rows.map((r) => r.name);
  assert.ok(!names.includes('Alice Eng'), 'self excluded — you are already in the room');
  assert.ok(!names.includes('Carol Design'), 'a directory member with no project access is invisible');
  // No emails, ever — the approver-search disclosure, one surface over.
  assert.deepEqual([...new Set(rows.flatMap((r) => Object.keys(r)))].sort(), ['id', 'name']);

  const teamOnly = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=B`);
  assert.deepEqual(teamOnly.invitees.map((r) => r.name), ['Bella Eng', 'Bob Eng']);

  // Admins see every project (rbac/project-access.ts `canSeeProject`), so an
  // admin genuinely CAN join this room — and is still not offered, because
  // eligibility here is MEMBERSHIP (`isProjectMember`), not the role bypass.
  // Ada is not in team-eng. Offering her would make the autocomplete an
  // admin-identification oracle over any project its caller can mint (the case
  // below), and admins lose nothing: they can already open any room.
  const ada = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=Ada`);
  assert.deepEqual(ada.invitees, [], 'the admin/owner bypass is not a membership signal');

  // …and the same admin, when she is genuinely in the project's group, IS
  // offered. The rule excludes the bypass, not the person.
  const owen = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=Owen`);
  assert.deepEqual(owen.invitees.map((r) => r.name), ['Owen Ops']);

  // An observer may look up who else could watch — read access is the gate here.
  const asObserver = await invitees(cookies['ollie'] as string, `?sessionId=${sessionId}&q=bob`);
  assert.deepEqual(asObserver.invitees.map((r) => r.name), ['Bob Eng']);
});

test('a member cannot mint a project to enumerate the instance’s admins', async () => {
  // The oracle this closes: eligibility over `canSeeProject` is true for every
  // admin and owner on EVERY project, so a plain member could create one, create
  // a session in it, and read back a list whose only rows are the instance's
  // privileged accounts — ids and display names that GET /api/v1/users refuses
  // them outright. The eligibility set was attacker-chosen; the approver-search
  // precedent this surface cites has an admin-authored one.
  const alice = cookies['alice'] as string;
  assert.equal((await call(alice, 'GET', '/api/v1/users')).status, 403, 'the directory itself is admin-only');

  for (const [what, visibility] of [
    ['private', 'private'],
    ['shared to a group nobody holds', { groups: ['group-that-nobody-is-in'] }],
  ] as const) {
    const project = await (await call(alice, 'POST', '/api/v1/projects', {
      name: `Probe (${what})`, visibility,
    })).json() as { id: string };
    const probe = await (await call(alice, 'POST', `/api/v1/projects/${project.id}/sessions`, {
      toolId: 'poster', toolVersion: '1.0.0', inputs: {}, meta: { label: 'probe' },
    })).json() as { id: string };

    const rows = await invitees(alice, `?sessionId=${probe.id}`);
    assert.deepEqual(rows.invitees, [], `${what}: nobody is a member but the caller, so nobody is offered`);

    // And guessing the id is not a way around the search: the POST resolves the
    // SAME predicate, so 201-vs-400 cannot answer "is this account an admin?".
    for (const email of ['admin@test', 'owen@test']) {
      const res = await call(alice, 'POST', '/api/v1/collab/invites', { sessionId: probe.id, userId: await userId(email) });
      assert.equal(res.status, 400, `${what}: ${email} cannot be invited by id either`);
      assert.equal((await res.json() as { error: { code: string } }).error.code, 'INVITEE_NOT_ELIGIBLE');
    }
    assert.deepEqual((await inbox(cookies['admin'] as string)).filter((m) => m.kind === 'collab'), [], 'and no invite was delivered');
  }
});

test('a group denied collab.join is neither offered nor invitable — the gateway would refuse the socket', async () => {
  const alice = cookies['alice'] as string;
  const codyId = await userId('cody@test');
  assert.deepEqual(
    (await invitees(alice, `?sessionId=${sessionId}&q=Cody`)).invitees.map((r) => r.name),
    ['Cody Contractor'],
    'precondition: an ordinary team member is offered',
  );

  const deny = await call(cookies['admin'] as string, 'POST', '/api/v1/grants', {
    principal: 'group:contractors', action: 'collab.join', resource: '*', effect: 'deny',
  });
  assert.equal(deny.status, 201);

  assert.deepEqual((await invitees(alice, `?sessionId=${sessionId}&q=Cody`)).invitees, [], 'gone from the autocomplete');
  const res = await call(alice, 'POST', '/api/v1/collab/invites', { sessionId, userId: codyId });
  assert.equal(res.status, 400);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'INVITEE_NOT_ELIGIBLE');
  assert.deepEqual((await inbox(cookies['cody'] as string)).filter((m) => m.kind === 'collab'), []);
  // The denied principal's own org-config agrees, so the shell shows no room UI.
  const can = (await (await call(cookies['cody'] as string, 'GET', '/api/v1/org-config')).json() as {
    can: Record<string, boolean>;
  }).can;
  assert.equal(can['collab.join'], false);
});

test('q is a PREFIX (on the name or any word in it), not a substring probe', async () => {
  const alice = cookies['alice'] as string;
  const byWord = await invitees(alice, `?sessionId=${sessionId}&q=eng`);
  assert.deepEqual(byWord.invitees.map((r) => r.name), ['Bella Eng', 'Bob Eng'], 'matches the surname word');

  // 'ell' is inside "Bella" but starts no word — a substring search would find
  // her, and typing three letters would walk the directory.
  assert.deepEqual((await invitees(alice, `?sessionId=${sessionId}&q=ell`)).invitees, []);
  assert.deepEqual((await invitees(alice, `?sessionId=${sessionId}&q=zzz-nobody`)).invitees, []);
  // Case-insensitive, and whitespace-only is the same as no query.
  assert.deepEqual((await invitees(alice, `?sessionId=${sessionId}&q=bOb`)).invitees.map((r) => r.name), ['Bob Eng']);
});

test('results are capped and say so', async () => {
  const all = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}`);
  assert.equal(all.limit, INVITEE_LIMIT);
  assert.equal(all.invitees.length, INVITEE_LIMIT);
  assert.equal(all.truncated, true, 'more eligible people than one page');
  // Sorted by name, so the same query gives the same page.
  assert.deepEqual([...all.invitees.map((r) => r.name)].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)), all.invitees.map((r) => r.name));

  const padded = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=zed`);
  assert.equal(padded.invitees.length, INVITEE_LIMIT);
  assert.equal(padded.truncated, true, `${PADDING.length} match, ${INVITEE_LIMIT} returned`);

  const narrow = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=zed 0`);
  assert.equal(narrow.truncated, false, 'a longer prefix is how you reach the 21st person');
});

test('invite delivers one inbox message, to the invitee ONLY', async () => {
  const bobId = await userId('bob@test');
  const res = await call(cookies['alice'] as string, 'POST', '/api/v1/collab/invites', { sessionId, userId: bobId });
  assert.equal(res.status, 201);
  const created = await res.json() as { messageId: string; sessionId: string; userId: string };
  assert.equal(created.messageId, inviteMessageId(sessionId, bobId));

  const [msg, ...rest] = (await inbox(cookies['bob'] as string)).filter((m) => m.kind === 'collab');
  assert.equal(rest.length, 0);
  assert.equal(msg?.title, 'Alice Eng invited you to edit Keynote badge together');
  // The machine-readable half: the shell builds its own deep link from this.
  assert.equal(msg?.data?.['sessionId'], sessionId);
  assert.equal(msg?.data?.['toolId'], 'poster');
  assert.equal(msg?.data?.['kind'], 'collab-invite');
  assert.ok(msg?.cta?.url.startsWith('https://app.example/t/poster?session='), msg?.cta?.url);

  for (const who of ['carol', 'bella', 'alice']) {
    const theirs = (await inbox(cookies[who] as string)).filter((m) => m.kind === 'collab');
    assert.deepEqual(theirs, [], `${who} must not see an invite addressed to bob`);
  }
});

test('a duplicate invite updates the pending one instead of stacking a second', async () => {
  const bobId = await userId('bob@test');
  const again = await call(cookies['bella'] as string, 'POST', '/api/v1/collab/invites', { sessionId, userId: bobId });
  assert.equal(again.status, 201);
  assert.equal((await again.json() as { messageId: string }).messageId, inviteMessageId(sessionId, bobId));

  const collab = (await inbox(cookies['bob'] as string)).filter((m) => m.kind === 'collab');
  assert.equal(collab.length, 1, 'still exactly one invite for this session');
  assert.equal(collab[0]?.title, 'Bella Eng invited you to edit Keynote badge together', 'refreshed, not duplicated');
});

test('an ineligible invitee is refused with one indistinguishable code, and gets nothing', async () => {
  const alice = cookies['alice'] as string;
  const cases: Array<[string, unknown]> = [
    ['outsider', await userId('carol@test')],
    ['self', await userId('alice@test')],
    ['unknown id', 'usr_does_not_exist'],
  ];
  for (const [what, id] of cases) {
    const res = await call(alice, 'POST', '/api/v1/collab/invites', { sessionId, userId: id });
    assert.equal(res.status, 400, what);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'INVITEE_NOT_ELIGIBLE', what);
  }
  assert.equal((await call(alice, 'POST', '/api/v1/collab/invites', { sessionId })).status, 400, 'userId required');
  assert.deepEqual((await inbox(cookies['carol'] as string)).filter((m) => m.kind === 'collab'), []);
});

test('inviting needs the WRITE right: an observer with collab.join is refused 403', async () => {
  const ollie = cookies['ollie'] as string;
  // He can search — read access is that route's gate (asserted above too).
  assert.equal((await call(ollie, 'GET', `/api/v1/collab/invitees?sessionId=${sessionId}`)).status, 200);

  const res = await call(ollie, 'POST', '/api/v1/collab/invites', { sessionId, userId: await userId('bella@test') });
  assert.equal(res.status, 403);
  assert.equal((await res.json() as { error: { code: string } }).error.code, 'FORBIDDEN');
  assert.deepEqual((await inbox(cookies['bella'] as string)).filter((m) => m.kind === 'collab'), []);
});

test('an oversized session label cannot become an oversized inbox title', async () => {
  const alice = cookies['alice'] as string;
  const current = await (await call(alice, 'GET', `/api/v1/sessions/${sessionId}`)).json() as { rev: number; meta: unknown };
  const put = await call(alice, 'PUT', `/api/v1/sessions/${sessionId}`, {
    rev: current.rev, meta: { label: 'L'.repeat(5000) },
  });
  assert.equal(put.status, 200);
  try {
    assert.equal((await call(alice, 'POST', '/api/v1/collab/invites', {
      sessionId, userId: await userId('bob@test'),
    })).status, 201);
    const msg = (await inbox(cookies['bob'] as string)).find((m) => m.kind === 'collab');
    assert.ok((msg?.title.length ?? 0) <= MAX_TITLE_CHARS, `title was ${msg?.title.length} chars`);
  } finally {
    const now = await (await call(alice, 'GET', `/api/v1/sessions/${sessionId}`)).json() as { rev: number };
    await call(alice, 'PUT', `/api/v1/sessions/${sessionId}`, { rev: now.rev, meta: { label: 'Keynote badge' } });
  }
});

test('a disabled account is neither offered nor invitable — it authenticates as nobody', async () => {
  const bellaId = await userId('bella@test');
  assert.equal((await call(cookies['admin'] as string, 'POST', `/api/v1/users/${bellaId}/disabled`, { disabled: true })).status, 200);
  try {
    const rows = await invitees(cookies['alice'] as string, `?sessionId=${sessionId}&q=bella`);
    assert.deepEqual(rows.invitees, [], 'gone from the autocomplete');
    const res = await call(cookies['alice'] as string, 'POST', '/api/v1/collab/invites', { sessionId, userId: bellaId });
    assert.equal(res.status, 400);
    assert.equal((await res.json() as { error: { code: string } }).error.code, 'INVITEE_NOT_ELIGIBLE');
  } finally {
    await call(cookies['admin'] as string, 'POST', `/api/v1/users/${bellaId}/disabled`, { disabled: false });
  }
});

test('audit: one collab.invite per delivered invite, keys only — never a label or an input value', async () => {
  const events = (await store.listAudit()).filter((e) => e.action === 'collab.invite');
  // One per ACCEPTED invite — the three 201s above, including the duplicate,
  // which collapses one inbox row but is still a distinct act to record.
  // Every refusal (403, INVITEE_NOT_ELIGIBLE) audits nothing.
  assert.equal(events.length, 3);
  for (const e of events) {
    assert.equal(e.subject, `session:${sessionId}`);
    assert.deepEqual(Object.keys(e.payload ?? {}).sort(), ['invitee', 'messageId', 'projectId', 'toolId']);
  }
  const serialized = JSON.stringify(events);
  assert.ok(!serialized.includes('Keynote badge'), 'no session label in the audit payload');
  assert.ok(!serialized.includes('Draft'), 'no input value in the audit payload');
  assert.ok(!serialized.includes('@test'), 'no email in the audit payload');
});

// Runs last on purpose: it delivers a fourth invite, and the audit count above
// is pinned to the three that precede it.
test('a re-invite after the invitee dismissed the first one is delivered again', async () => {
  // The invite id is derived from (session, invitee) so a duplicate refreshes
  // one row — but acks are permanent per (messageId, userId) and delivery
  // filters acked ids unconditionally, so "dismissed once" would otherwise mean
  // "never invitable to this session again": 201, an audit row, and an inbox
  // that stays empty forever. The idempotence promise is ONE LIVE invite per
  // pair, not one ever.
  const alice = cookies['alice'] as string;
  const bob = cookies['bob'] as string;
  const bobId = await userId('bob@test');
  const id = inviteMessageId(sessionId, bobId);

  const pending = (await inbox(bob)).filter((m) => m.kind === 'collab');
  assert.equal(pending.length, 1, 'precondition: bob still holds the invite from earlier');
  assert.equal((await call(bob, 'POST', `/api/v1/inbox/${id}/ack`)).status, 200);
  assert.deepEqual((await inbox(bob)).filter((m) => m.kind === 'collab'), [], 'dismissed');

  const again = await call(alice, 'POST', '/api/v1/collab/invites', { sessionId, userId: bobId });
  assert.equal(again.status, 201);
  assert.equal((await again.json() as { messageId: string }).messageId, id, 'still the same derived id');

  const redelivered = (await inbox(bob)).filter((m) => m.kind === 'collab');
  assert.equal(redelivered.length, 1, 'the invite is pending again — one row, not two');
  assert.equal(redelivered[0]?.id, id);
  assert.equal(redelivered[0]?.title, 'Alice Eng invited you to edit Keynote badge together');

  // Only the invitee's own dismissal is cleared, and only for this message.
  await call(bob, 'POST', `/api/v1/inbox/${id}/ack`);
  assert.deepEqual((await inbox(bob)).filter((m) => m.kind === 'collab'), [], 'and it can be dismissed again');
});
