/**
 * End-to-end over real HTTP: dev-provider login, org-config (locked profile
 * fields, ETag), catalog filtering, the guest-link lifecycle, telemetry
 * attribution, and fleet - the golden paths of plans/02/03/04/06/07/09/10.
 */
import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { ToolOverlay } from '../server/src/policy/overlay.ts';

let server: Server;
let base = '';
let store: ReturnType<typeof createMemoryStore>;

const OVERLAY: ToolOverlay = {
  toolId: 'event-badge',
  version: 1,
  inputAccess: { logo: [{ groups: ['*'], level: 'locked', value: 'acme/logo' }] },
  visibility: { groups: ['brand-team'] },
};

// Visible to everyone; policies its inputs - feeds the org-config annotation tests.
const QR_OVERLAY: ToolOverlay = {
  toolId: 'qr-code',
  version: 1,
  inputAccess: {
    logo: [
      { groups: ['brand-team'], level: 'editable' },
      { groups: ['*'], level: 'locked', value: 'acme/logo' },
    ],
    discount: [
      { groups: ['sales-managers'], level: 'editable' },
      { groups: ['*'], level: 'hidden' },
    ],
  },
  enforce: { escalation: 'brand-review' }, // binds qr-code outputs to the brand-review chain
};

before(async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-pack-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(
    join(pack, 'catalog', 'tools', 'index.json'),
    JSON.stringify({ version: 1, tools: [{ id: 'qr-code' }, { id: 'event-badge' }] }),
  );
  await mkdir(join(pack, 'tools', 'qr-code'), { recursive: true });
  await writeFile(
    join(pack, 'tools', 'qr-code', 'tool.json'),
    JSON.stringify({ id: 'qr-code', inputs: [{ id: 'url' }, { id: 'logo' }, { id: 'discount' }] }),
  );
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Test Hub', baseUrl: 'http://localhost', pack },
    policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
    rateLimit: { enabled: false }, // this shared suite hammers auth/telemetry; don't throttle
    dev: {
      enabled: true,
      users: [
        { email: 'admin@test', name: 'Ada Admin', groups: ['admin'] },
        { email: 'marketer@test', name: 'Mia Marketer', groups: ['marketing'] },
        { email: 'owner@test', name: 'Odin Owner', groups: ['owner'] },
      ],
    },
  }));
  store = createMemoryStore({
    overlays: [OVERLAY, QR_OVERLAY],
    grants: [{ principal: 'group:marketing', action: 'export.download', resource: '*', effect: 'deny' }],
  });
  const app = buildApp({ config, store, secrets: { session: 's3', link: 'l3' } });
  server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
});

after(() => server.close());

async function login(email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  assert.equal(res.status, 302);
  const cookie = res.headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  assert.ok(cookie, 'session cookie set');
  return cookie.split(';')[0] as string;
}

test('gated: org-config and catalog are 401 without a session', async () => {
  assert.equal((await fetch(`${base}/api/v1/org-config`)).status, 401);
  assert.equal((await fetch(`${base}/catalog/tools/index.json`)).status, 401);
});

test('org-config: locked profile fields, policy tools, ETag 304', async () => {
  const cookie = await login('admin@test');
  const res = await fetch(`${base}/api/v1/org-config`, { headers: { cookie } });
  assert.equal(res.status, 200);
  const etag = res.headers.get('etag');
  assert.ok(etag);
  const payload = await res.json() as {
    profilePolicy: Record<string, { mode: string; source?: string }>;
    tools: Record<string, unknown>;
    telemetry: { attribution: string; consented: boolean };
    session: { role: string };
  };
  assert.equal(payload.session.role, 'admin');
  assert.equal(payload.profilePolicy.firstname?.mode, 'locked');
  assert.equal(payload.profilePolicy.email?.source, 'idp');
  assert.equal(payload.profilePolicy.useDetails?.mode, 'hidden');
  assert.equal(payload.telemetry.attribution, 'opt-in');
  // admin isn't in brand-team → event-badge is ABSENT, not marked; qr-code (no
  // visibility clause) is present with its input policy for admin's groups
  assert.deepEqual(Object.keys(payload.tools), ['qr-code']);
  const again = await fetch(`${base}/api/v1/org-config`, { headers: { cookie, 'if-none-match': etag } });
  assert.equal(again.status, 304);
});

test('org-config: permission bits + hidden input ids + locked annotations', async () => {
  const cookie = await login('marketer@test');
  const payload = await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json() as {
    can: Record<string, boolean>;
    tools: Record<string, { inputs?: Array<{ id: string; access?: { level: string; value?: unknown } }>; hidden?: string[] }>;
  };
  assert.equal(payload.can['export.download'], false); // group deny grant
  assert.equal(payload.can['export.request'], true);   // role default survives
  assert.equal(payload.can['link.create-guest'], false); // member role
  const qr = payload.tools['qr-code'] as {
    inputs?: Array<{ id: string; access?: { level: string; value?: unknown } }>; hidden?: string[]; approvalChain?: string;
  };
  assert.ok(qr);
  assert.deepEqual(qr.hidden, ['discount']);
  const logo = qr.inputs?.find((i) => i.id === 'logo');
  assert.equal(logo?.access?.level, 'locked');
  assert.equal(logo?.access?.value, 'acme/logo');
  assert.equal(qr.approvalChain, 'brand-review', 'bound chain surfaced for the export-request flow');
});

test('catalog index is filtered per caller groups', async () => {
  const cookie = await login('marketer@test');
  const res = await fetch(`${base}/catalog/tools/index.json`, { headers: { cookie } });
  const index = await res.json() as { tools: Array<{ id: string }> };
  assert.deepEqual(index.tools.map((t) => t.id), ['qr-code']); // event-badge visible to brand-team only
});

test('guest-link lifecycle: mint (admin) → password gate → guest session → revoke → 410', async () => {
  const cookie = await login('admin@test');
  const mint = await fetch(`${base}/api/v1/links`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'guest-edit', target: { toolId: 'event-badge' }, password: 'hunter2', ttlHours: 48 }),
  });
  assert.equal(mint.status, 201);
  const { id, url } = await mint.json() as { id: string; url: string };
  const path = url.replace('http://localhost', base);

  assert.equal((await fetch(path)).status, 401); // PASSWORD_REQUIRED
  const admitted = await fetch(`${path}&pw=hunter2&name=Sam`);
  assert.equal(admitted.status, 200);
  const guestCookie = admitted.headers.getSetCookie().find((c) => c.startsWith('lw_guest='))?.split(';')[0];
  assert.ok(guestCookie);
  const who = await fetch(`${base}/api/auth/session`, { headers: { cookie: guestCookie as string } });
  const session = await who.json() as { kind: string; guest: { name: string; toolId: string } };
  assert.equal(session.kind, 'guest');
  assert.equal(session.guest.name, 'Sam');
  assert.equal(session.guest.toolId, 'event-badge');

  const revoke = await fetch(`${base}/api/v1/links/${id}/revoke`, { method: 'POST', headers: { cookie } });
  assert.equal(revoke.status, 200);
  assert.equal((await fetch(`${path}&pw=hunter2`)).status, 410);
});

test('member cannot mint guest links; ordinary member CAN mint share links', async () => {
  const cookie = await login('marketer@test');
  const guest = await fetch(`${base}/api/v1/links`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'guest-edit', target: { toolId: 'qr-code' } }),
  });
  assert.equal(guest.status, 403);
  const share = await fetch(`${base}/api/v1/links`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ kind: 'share', target: { toolId: 'qr-code' } }),
  });
  assert.equal(share.status, 201);
});

test('telemetry: opt-in strips attribution until consent is given', async () => {
  const cookie = await login('marketer@test');
  const post = () => fetch(`${base}/api/v1/telemetry`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/json' },
    body: JSON.stringify({ events: [{ event: 'tool.open', attrs: { toolId: 'qr-code', secret: 'nope' } }] }),
  });
  assert.equal((await post()).status, 202);
  await fetch(`${base}/api/v1/telemetry/consent`, {
    method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify({ consent: true }),
  });
  assert.equal((await post()).status, 202);
  const events = await store.listEvents();
  assert.equal(events.length, 2);
  assert.equal(events[0]?.userId, undefined);
  assert.ok(events[1]?.userId);
  assert.deepEqual(Object.keys(events[0]?.attrs ?? {}), ['toolId']);
});

test('fleet: header recorded; summary needs fleet.view', async () => {
  const admin = await login('admin@test');
  await fetch(`${base}/healthz`, { headers: { 'x-lolly-client': 'web engine/1.61.0' } });
  await fetch(`${base}/healthz`, { headers: { 'x-lolly-client': 'tauri engine/1.60.0' } });
  const denied = await fetch(`${base}/api/v1/fleet`, { headers: { cookie: await login('marketer@test') } });
  assert.equal(denied.status, 403);
  const res = await fetch(`${base}/api/v1/fleet`, { headers: { cookie: admin } });
  const { clients } = await res.json() as { clients: Array<{ bucket: string; count: number }> };
  const buckets = clients.map((c) => c.bucket);
  assert.ok(buckets.some((b) => b.startsWith('web|-|1.61.0')));
  assert.ok(buckets.some((b) => b.startsWith('tauri|-|1.60.0')));
});

test('audit chain is intact after the lifecycle above', async () => {
  const { verifyChain } = await import('../server/src/audit/chain.ts');
  const events = await store.listAudit();
  assert.ok(events.length >= 5); // logins, link.create, guest.admit, link.revoke, consent
  assert.deepEqual(verifyChain(events), { ok: true });
  assert.ok(events.some((e) => e.action === 'guest.admit'));
});

test('admin endpoints: grant-gated summary/audit/messages/users', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');

  // summary: telemetry.view - admin yes, member no
  assert.equal((await fetch(`${base}/api/v1/telemetry/summary`, { headers: { cookie: marketer } })).status, 403);
  const summary = await (await fetch(`${base}/api/v1/telemetry/summary`, { headers: { cookie: admin } })).json() as {
    totals: { events: number }; days: unknown[];
  };
  assert.ok(summary.totals.events >= 2); // telemetry test above ingested 2
  assert.equal(summary.days.length, 14);

  // audit: chain report over HTTP
  const audit = await (await fetch(`${base}/api/v1/audit`, { headers: { cookie: admin } })).json() as {
    chain: { ok: boolean }; total: number; events: Array<{ hash: string }>;
  };
  assert.equal(audit.chain.ok, true);
  assert.ok(audit.total >= 5);

  // audit head: the chain tip for external anchoring (gate: audit.export)
  assert.equal((await fetch(`${base}/api/v1/audit/head`, { headers: { cookie: marketer } })).status, 403);
  const head = await (await fetch(`${base}/api/v1/audit/head`, { headers: { cookie: admin } })).json() as {
    seq: number; hash: string; at: string | null; count: number; chainIntact: boolean;
  };
  assert.equal(head.chainIntact, true);
  assert.equal(head.count, audit.total);
  assert.equal(head.hash, audit.events[audit.events.length - 1]!.hash);
  assert.ok(head.seq >= 5 && typeof head.at === 'string');

  // system readiness: pending migrations - owner-gated (instance.config)
  assert.equal((await fetch(`${base}/api/v1/system/migrations`)).status, 401); // no session
  assert.equal((await fetch(`${base}/api/v1/system/migrations`, { headers: { cookie: admin } })).status, 403); // admin ≠ owner
  const owner = await login('owner@test');
  const mig = await (await fetch(`${base}/api/v1/system/migrations`, { headers: { cookie: owner } })).json() as { pending: string[]; current: boolean };
  assert.deepEqual(mig, { pending: [], current: true }); // memory store is always current

  // messages: send + list with ack counts
  assert.equal((await fetch(`${base}/api/v1/messages`, { headers: { cookie: marketer } })).status, 403);
  const sent = await fetch(`${base}/api/v1/messages`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ title: 'Hello fleet', severity: 'info', audience: { shells: ['tauri'] } }),
  });
  assert.equal(sent.status, 201);
  const list = await (await fetch(`${base}/api/v1/messages`, { headers: { cookie: admin } })).json() as {
    messages: Array<{ title: string; acks: number }>;
  };
  assert.equal(list.messages[0]?.title, 'Hello fleet');
  assert.equal(list.messages[0]?.acks, 0);
  // audience targeting over HTTP: web client doesn't get the tauri-only message
  const inboxWeb = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: marketer, 'x-lolly-client': 'web engine/1.61.0' } })).json() as { messages: unknown[] };
  assert.equal(inboxWeb.messages.length, 0);
  const inboxTauri = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: marketer, 'x-lolly-client': 'tauri engine/1.61.0' } })).json() as { messages: unknown[] };
  assert.equal(inboxTauri.messages.length, 1);

  // users: role-gated
  assert.equal((await fetch(`${base}/api/v1/users`, { headers: { cookie: marketer } })).status, 403);
  const users = await (await fetch(`${base}/api/v1/users`, { headers: { cookie: admin } })).json() as { users: Array<{ email: string }> };
  assert.ok(users.users.some((u) => u.email === 'marketer@test'));

  // links listing: own vs all
  assert.equal((await fetch(`${base}/api/v1/links?all=1`, { headers: { cookie: marketer } })).status, 403);
  const mineRes = await fetch(`${base}/api/v1/links`, { headers: { cookie: marketer } });
  assert.equal(mineRes.status, 200);
  // each listed link carries a ready-to-use signed url (baseUrl + linkPath)
  const mine = await mineRes.json() as { links: Array<{ id: string; url: string }> };
  assert.ok(mine.links.length >= 1);
  for (const l of mine.links) assert.match(l.url, new RegExp(`^http://localhost/l/${l.id}\\?s=`));
});

test('console shell is served at /admin', async () => {
  const res = await fetch(`${base}/admin`);
  assert.equal(res.status, 200);
  assert.match(await res.text(), /Console/);
  assert.equal((await fetch(`${base}/admin/app.js`)).status, 200);
  assert.equal((await fetch(`${base}/admin/../instance.json`)).status, 404);
});

test('render plane is auth-gated on a gated instance', async () => {
  // The render plane (fourth HostV1 shell) lives in server/src/render/**; its
  // full behaviour is covered in tests/render.test.ts against a real pack. Here we
  // only assert the route replaced the old 501 stub and enforces the gate: no
  // session on a gated instance is refused before any render work.
  const res = await fetch(`${base}/render/qr-code.png?url=x`);
  assert.equal(res.status, 401);
  const body = await res.json() as { error: { code: string } };
  assert.equal(body.error.code, 'UNAUTHORIZED');
});

async function adminUserId(cookie: string): Promise<string> {
  const { users } = await (await fetch(`${base}/api/v1/users`, { headers: { cookie } })).json() as {
    users: Array<{ id: string; email: string }>;
  };
  const id = users.find((u) => u.email === 'admin@test')?.id;
  assert.ok(id, 'admin user id resolved');
  return id as string;
}

test('approvals: chain edit is policy-gated; members can list chains', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');

  const put = await fetch(`${base}/api/v1/chains/brand-review`, {
    method: 'PUT', headers: { cookie: admin, 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'Brand review', steps: [{ name: 'Brand sign-off', approvers: { groups: ['admin'] }, rule: 'any' }] }),
  });
  assert.equal(put.status, 200);

  // a member cannot edit chains (policy.edit)
  const denied = await fetch(`${base}/api/v1/chains/x`, {
    method: 'PUT', headers: { cookie: marketer, 'content-type': 'application/json' },
    body: JSON.stringify({ steps: [{ approvers: { groups: ['admin'] }, rule: 'any' }] }),
  });
  assert.equal(denied.status, 403);

  // any member can read the chain catalogue
  const chains = await (await fetch(`${base}/api/v1/chains`, { headers: { cookie: marketer } })).json() as { chains: Array<{ id: string }> };
  assert.ok(chains.chains.some((c) => c.id === 'brand-review'));
});

test('approvals: a member can discover nominatable approvers (self excluded)', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');
  const adminId = await adminUserId(admin);

  // marketer (not an eligible approver) sees the admin as nominatable
  const res = await fetch(`${base}/api/v1/approvals/approvers?chainId=brand-review`, { headers: { cookie: marketer } });
  assert.equal(res.status, 200);
  const body = await res.json() as { chainId: string; stepName: string; approvers: Array<{ id: string; name: string }> };
  assert.equal(body.chainId, 'brand-review');
  assert.equal(body.stepName, 'Brand sign-off');
  assert.ok(body.approvers.some((a) => a.id === adminId), 'admin is nominatable');

  // an eligible approver never sees themselves (separation of duties at nomination)
  const selfView = await (await fetch(`${base}/api/v1/approvals/approvers?chainId=brand-review`, { headers: { cookie: admin } })).json() as { approvers: Array<{ id: string }> };
  assert.ok(!selfView.approvers.some((a) => a.id === adminId), 'admin excluded from their own approver list');

  // unknown chain 404s
  assert.equal((await fetch(`${base}/api/v1/approvals/approvers?chainId=nope`, { headers: { cookie: marketer } })).status, 404);
});

test('approvals: submit → SoD block → approve, with both notifications', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');
  const adminId = await adminUserId(admin);

  // marketer submits, nominating the admin as approver
  const submit = await fetch(`${base}/api/v1/approvals`, {
    method: 'POST', headers: { cookie: marketer, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectType: 'asset', subjectRef: 'sess:42', title: 'Summit hero', chainId: 'brand-review', nominees: [adminId] }),
  });
  assert.equal(submit.status, 201);
  const created = await submit.json() as { id: string; state: string };
  assert.equal(created.state, 'in_review');

  // the submitter cannot act on their own approval - separation of duties
  const own = await fetch(`${base}/api/v1/approvals/${created.id}/act`, {
    method: 'POST', headers: { cookie: marketer, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(own.status, 403);
  assert.equal((await own.json() as { error: { code: string } }).error.code, 'SEPARATION_OF_DUTIES');

  // the nominee sees it in their approvals inbox, tagged 'inbox'
  const inbox = await (await fetch(`${base}/api/v1/approvals?inbox=1`, { headers: { cookie: admin } })).json() as {
    approvals: Array<{ id: string; relation: string }>;
  };
  assert.ok(inbox.approvals.some((a) => a.id === created.id && a.relation === 'inbox'));

  // and a message landed in the nominee's inbox (any client header)
  const adminMsgs = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: admin, 'x-lolly-client': 'web engine/1.61.0' } })).json() as {
    messages: Array<{ title: string }>;
  };
  assert.ok(adminMsgs.messages.some((m) => /Approval requested/.test(m.title)));

  // admin approves → approved
  const act = await fetch(`${base}/api/v1/approvals/${created.id}/act`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(act.status, 200);
  assert.equal((await act.json() as { state: string }).state, 'approved');

  // the submitter got a terminal notification and sees it under 'mine'
  const marketerMsgs = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: marketer, 'x-lolly-client': 'web engine/1.61.0' } })).json() as {
    messages: Array<{ title: string }>;
  };
  assert.ok(marketerMsgs.messages.some((m) => /Approval approved/.test(m.title)));
  const mine = await (await fetch(`${base}/api/v1/approvals?mine=1`, { headers: { cookie: marketer } })).json() as {
    approvals: Array<{ id: string; state: string; relation: string }>;
  };
  assert.ok(mine.approvals.some((a) => a.id === created.id && a.state === 'approved' && a.relation === 'mine'));
});

test('approvals: reject path terminates and notifies the submitter', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');
  const adminId = await adminUserId(admin);

  const { id } = await (await fetch(`${base}/api/v1/approvals`, {
    method: 'POST', headers: { cookie: marketer, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectType: 'tool-change', subjectRef: 'event-badge@v5', title: 'Badge v5', chainId: 'brand-review', nominees: [adminId] }),
  })).json() as { id: string };

  const rej = await fetch(`${base}/api/v1/approvals/${id}/act`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'reject', comment: 'Needs legal too' }),
  });
  assert.equal(rej.status, 200);
  assert.equal((await rej.json() as { state: string }).state, 'rejected');

  // a second act is refused as terminal
  const again = await fetch(`${base}/api/v1/approvals/${id}/act`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }),
  });
  assert.equal(again.status, 409);
  assert.equal((await again.json() as { error: { code: string } }).error.code, 'TERMINAL');

  const msgs = await (await fetch(`${base}/api/v1/inbox`, { headers: { cookie: marketer, 'x-lolly-client': 'web engine/1.61.0' } })).json() as {
    messages: Array<{ title: string }>;
  };
  assert.ok(msgs.messages.some((m) => /Approval rejected/.test(m.title)));
});

test('approvals: submitter can withdraw; others cannot', async () => {
  const admin = await login('admin@test');
  const marketer = await login('marketer@test');

  const { id } = await (await fetch(`${base}/api/v1/approvals`, {
    method: 'POST', headers: { cookie: marketer, 'content-type': 'application/json' },
    body: JSON.stringify({ subjectType: 'config', subjectRef: 'accent-lock', title: 'Lock accent', chainId: 'brand-review', nominees: [] }),
  })).json() as { id: string };

  // a non-submitter cannot withdraw
  assert.equal((await fetch(`${base}/api/v1/approvals/${id}/withdraw`, { method: 'POST', headers: { cookie: admin } })).status, 403);

  const w = await fetch(`${base}/api/v1/approvals/${id}/withdraw`, { method: 'POST', headers: { cookie: marketer } });
  assert.equal(w.status, 200);
  assert.equal((await w.json() as { state: string }).state, 'withdrawn');
});

// ── observability: /metrics scrape + rate limiting (plan Track B) ──────────────

test('GET /metrics: loopback-scrapeable Prometheus text with counters + gauges', async () => {
  const res = await fetch(`${base}/metrics`); // 127.0.0.1 loopback, no token → allowed
  assert.equal(res.status, 200);
  assert.match(res.headers.get('content-type') || '', /text\/plain/);
  const body = await res.text();
  assert.match(body, /# TYPE lw_http_requests_total counter/);
  assert.match(body, /lw_audit_chain_intact 1/); // chain intact after the suite's activity
  assert.match(body, /# TYPE lw_process_uptime_seconds gauge/);
});

test('rate limiting: the public link surface 429s past capacity, with Retry-After', async () => {
  const pack = await mkdtemp(join(tmpdir(), 'lw-rl-'));
  await mkdir(join(pack, 'catalog'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'keep'), '');
  const config = parseConfig(JSON.stringify({
    instance: { name: 'RL', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: true, link: { capacity: 2, refillPerSec: 0 } },
    dev: { enabled: true, users: [{ email: 'x@test', groups: [] }] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), secrets: { session: 's', link: 'l' } });
  const srv = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => srv.listen(0, () => r()));
  const addr = srv.address();
  const b = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  // capacity 2: first two link hits pass through (404 for a missing link), the third is throttled.
  assert.notEqual((await fetch(`${b}/l/nope`)).status, 429);
  assert.notEqual((await fetch(`${b}/l/nope`)).status, 429);
  const limited = await fetch(`${b}/l/nope`);
  assert.equal(limited.status, 429);
  assert.ok(Number(limited.headers.get('retry-after')) >= 1);
  assert.equal((await limited.json() as { error: { code: string } }).error.code, 'RATE_LIMITED');
  // The rejection is counted in metrics.
  assert.match(await (await fetch(`${b}/metrics`)).text(), /lw_rate_limited_total\{surface="link"\} 1/);
  srv.close();
});
