// SPDX-License-Identifier: MPL-2.0
/**
 * How long a member session lives (plans/75 G18 and RENEW), over real HTTP:
 *   - "Sign out on all devices" (`POST /api/v1/me/revoke-sessions`): the
 *     caller's own epoch bump, audited with `self: true`, this browser's
 *     cookie cleared, five an hour, a signed-in person only;
 *   - sliding renewal: a member request past half the TTL gets a fresh cookie,
 *     never one that outlives `authAt + policy.sessionMaxHours`; a revoked,
 *     disabled or no longer admitted person gets none; a cookie minted before
 *     `authAt` existed counts from when it was issued;
 *   - `policy.sessionMaxHours` validation.
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
import { b64uDecode } from '../server/src/lib/crypto.ts';
import { mintToken } from '../server/src/iam/tokens.ts';
import {
  mintSessionCookie, readMemberSession, sessionRenewal, type MemberSession, type SessionUser,
} from '../server/src/iam/sessions.ts';
import { subjectHash } from '../server/src/iam/identities.ts';
import type { Store, UserRecord } from '../server/src/store/types.ts';

const SECRET = 'sLife';
const HOUR = 3_600_000;
const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(policy: Record<string, unknown> = {}, idp: Record<string, unknown> = {}) {
  const pack = await mkdtemp(join(tmpdir(), 'lw-lifetime-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Lifetime', baseUrl: 'https://life.example', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'dana@test', name: 'Dana', groups: [] }, { email: 'eli@test', name: 'Eli', groups: [] }] },
    idp,
    policy,
  }));
  const store: Store = createMemoryStore();
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: SECRET, link: 'lLife' } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  const base = `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302, `dev login ${email}`);
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const call = async (cookie: string, method: string, path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, {
      method,
      headers: { cookie, ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
    const text = await res.text();
    return { status: res.status, headers: res.headers, text };
  };
  return { base, store, login, call };
}

/** The session cookie a response set, as `name=value` plus its Max-Age. */
function sessionCookieOf(headers: Headers): { pair: string; maxAge: number } | null {
  const raw = headers.getSetCookie().find((c) => c.startsWith('lw_session='));
  if (!raw) return null;
  return { pair: raw.split(';')[0]!, maxAge: Number(/Max-Age=(\d+)/.exec(raw)?.[1]) };
}

/** The signed box inside a cookie pair (the signature is checked elsewhere). */
function boxOf(pair: string): { exp: number; p: SessionUser } {
  const token = pair.slice('lw_session='.length);
  return JSON.parse(b64uDecode(token.slice(0, token.lastIndexOf('.'))).toString('utf8')) as { exp: number; p: SessionUser };
}

/** A cookie for `user` as if minted at `issuedAt` for `ttlHours`. */
function cookieAt(user: UserRecord, issuedAt: number, ttlHours: number, extra: Partial<SessionUser> = {}): string {
  const sessionUser: SessionUser = { sub: user.sub, email: user.email, groups: user.groups, role: user.role, name: user.email, epoch: user.sessionEpoch, ...extra };
  return mintSessionCookie(sessionUser, SECRET, true, ttlHours * 3600, issuedAt).split(';')[0]!;
}

// ── sign out on all devices (G18) ──────────────────────────────────────────

test('sign out on all devices ends every session of the caller, this browser included, and only theirs', async () => {
  const env = await boot();
  const laptop = await env.login('dana@test');
  const phone = await env.login('dana@test');
  const other = await env.login('eli@test');
  for (const cookie of [laptop, phone, other]) assert.equal((await env.call(cookie, 'GET', '/api/auth/session')).status, 200);

  const done = await env.call(phone, 'POST', '/api/v1/me/revoke-sessions');
  assert.equal(done.status, 204);
  assert.equal(done.headers.get('cache-control'), 'no-store');
  const cleared = done.headers.getSetCookie();
  assert.ok(cleared.some((c) => c.startsWith('lw_session=;') && /Max-Age=0/.test(c)), 'this browser\'s session cookie is cleared');
  assert.ok(cleared.some((c) => c.startsWith('lw_guest=;') && /Max-Age=0/.test(c)), 'and its guest cookie, as logout does');

  // A cookie minted before the call is refused afterwards, on every device.
  assert.equal((await env.call(laptop, 'GET', '/api/auth/session')).status, 401);
  assert.equal((await env.call(phone, 'GET', '/api/auth/session')).status, 401);
  assert.equal((await env.call(laptop, 'GET', '/api/v1/projects')).status, 401);
  // Someone else is untouched.
  assert.equal((await env.call(other, 'GET', '/api/auth/session')).status, 200);
  // Signing in again works at the new epoch.
  assert.equal((await env.call(await env.login('dana@test'), 'GET', '/api/auth/session')).status, 200);

  const dana = (await env.store.findUsersByEmail('dana@test'))[0]!;
  const rows = (await env.store.listAudit()).filter((e) => e.action === 'user.sessions.revoked');
  assert.equal(rows.length, 1);
  assert.deepEqual([rows[0]!.actor, rows[0]!.subject, rows[0]!.payload], [`user:${dana.id}`, `user:${dana.id}`, { self: true }]);
});

test('sign out on all devices needs a signed-in person and is limited to five an hour', async () => {
  const env = await boot();
  assert.equal((await env.call('', 'POST', '/api/v1/me/revoke-sessions')).status, 401);
  assert.equal((await env.call('lw_session=forged.sig', 'POST', '/api/v1/me/revoke-sessions')).status, 401);
  // A bearer credential is not a session of the person's own.
  const bearer = await fetch(`${env.base}/api/v1/me/revoke-sessions`, { method: 'POST', headers: { authorization: 'Bearer svc_not_a_session' } });
  assert.equal(bearer.status, 401);
  // A cross-site form post is refused before the route runs.
  const cookie = await env.login('dana@test');
  const crossSite = await fetch(`${env.base}/api/v1/me/revoke-sessions`, { method: 'POST', headers: { cookie, origin: 'https://evil.example' } });
  assert.equal(crossSite.status, 403);
  assert.equal((await env.call(cookie, 'GET', '/api/auth/session')).status, 200, 'the refused post ended nothing');

  for (let i = 0; i < 5; i++) {
    assert.equal((await env.call(await env.login('dana@test'), 'POST', '/api/v1/me/revoke-sessions')).status, 204, `call ${i + 1}`);
  }
  const sixth = await env.call(await env.login('dana@test'), 'POST', '/api/v1/me/revoke-sessions');
  assert.equal(sixth.status, 429);
  assert.equal(JSON.parse(sixth.text).error.code, 'RATE_LIMITED');
  assert.equal(sixth.headers.get('retry-after'), '3600');
  // Another person has an allowance of their own.
  assert.equal((await env.call(await env.login('eli@test'), 'POST', '/api/v1/me/revoke-sessions')).status, 204);
});

// ── sliding renewal (RENEW): the pure rule ─────────────────────────────────

const at = (issuedAt: number, ttlHours: number, authAt?: number): MemberSession => ({
  user: { sub: 's', email: 'e', name: 'n', groups: [], role: 'member', ...(authAt !== undefined ? { authAt } : {}) },
  exp: Math.floor((issuedAt + ttlHours * HOUR) / 1000),
});

test('renewal rule: nothing in the first half, a full TTL after it, cut at the cap, nothing past it', () => {
  const t0 = Date.UTC(2026, 9, 8, 9, 0, 0);
  const policy = { ttlSec: 12 * 3600, maxSec: 72 * 3600 };
  // First half of the lifetime: no renewal.
  assert.equal(sessionRenewal(at(t0, 12, t0), policy, t0 + 5 * HOUR), null);
  assert.equal(sessionRenewal(at(t0, 12, t0), policy, t0 + 6 * HOUR - 1000), null);
  // Past half: a full TTL, the chain's start carried over.
  assert.deepEqual(sessionRenewal(at(t0, 12, t0), policy, t0 + 7 * HOUR), { authAt: t0, ttlSec: 12 * 3600 });
  // Near the cap the lifetime is cut so it ends at authAt + 72 h, never later.
  const late = sessionRenewal(at(t0 + 58 * HOUR, 12, t0), policy, t0 + 66 * HOUR);
  assert.deepEqual(late, { authAt: t0, ttlSec: 6 * 3600 });
  // A cookie that already ends at the cap, or within a minute of it, has nothing to renew.
  assert.equal(sessionRenewal(at(t0 + 60 * HOUR, 12, t0), policy, t0 + 66 * HOUR), null);
  const nearly = { user: at(t0, 12, t0).user, exp: Math.floor((t0 + 72 * HOUR - 30_000) / 1000) };
  assert.equal(sessionRenewal(nearly, policy, t0 + 69 * HOUR), null);
  // At or past the cap: never.
  assert.equal(sessionRenewal(at(t0 + 66 * HOUR, 12, t0), policy, t0 + 72 * HOUR), null);
  assert.equal(sessionRenewal(at(t0 + 66 * HOUR, 12, t0), policy, t0 + 75 * HOUR), null);
});

test('renewal rule: a cookie without authAt counts from its sign-in, else its issue time; no sessionMaxHours means no renewal', () => {
  const t0 = Date.UTC(2026, 9, 8, 9, 0, 0);
  const legacy = at(t0, 2);
  // authAt = iat = exp - ttl; with a 3 h cap the new cookie ends at iat + 3 h.
  assert.deepEqual(sessionRenewal(legacy, { ttlSec: 2 * 3600, maxSec: 3 * 3600 }, t0 + 1.5 * HOUR), { authAt: t0, ttlSec: 1.5 * 3600 });
  // Absent sessionMaxHours is the TTL itself: the cut never outlasts the cookie.
  for (const now of [t0 + 1.1 * HOUR, t0 + 1.5 * HOUR, t0 + 1.99 * HOUR]) {
    assert.equal(sessionRenewal(at(t0, 2, t0), { ttlSec: 2 * 3600, maxSec: 2 * 3600 }, now), null);
  }
  // An authAt later than the issue time (a TTL raised since) cannot lengthen the chain.
  assert.deepEqual(sessionRenewal(at(t0, 2, t0 + HOUR), { ttlSec: 2 * 3600, maxSec: 3 * 3600 }, t0 + 1.5 * HOUR), { authAt: t0, ttlSec: 1.5 * 3600 });
  // Without authAt, a cookie's sign-in time counts first: a cookie minted for
  // 72 h before the TTL was lowered to 12 h still ends its chain 72 h after
  // that sign-in, not 72 h after the issue time the new TTL would suggest.
  const signedIn = { user: { ...at(t0, 72).user, authenticatedAt: t0 }, exp: Math.floor((t0 + 72 * HOUR) / 1000) };
  assert.equal(sessionRenewal(signedIn, { ttlSec: 12 * 3600, maxSec: 72 * 3600 }, t0 + 67 * HOUR), null);
  assert.deepEqual(sessionRenewal({ ...signedIn, exp: Math.floor((t0 + 60 * HOUR) / 1000) }, { ttlSec: 12 * 3600, maxSec: 72 * 3600 }, t0 + 55 * HOUR),
    { authAt: t0, ttlSec: 12 * 3600 });
});

test('mintSessionCookie stamps authAt from the sign-in, or now, and keeps one it is given', () => {
  const t0 = Date.UTC(2026, 9, 8, 9, 0, 0);
  const base: SessionUser = { sub: 's', email: 'e', name: 'n', groups: [], role: 'member' };
  assert.equal(boxOf(mintSessionCookie(base, SECRET, true, 60, t0).split(';')[0]!).p.authAt, t0);
  assert.equal(boxOf(mintSessionCookie({ ...base, authenticatedAt: t0 - 5 }, SECRET, true, 60, t0).split(';')[0]!).p.authAt, t0 - 5);
  assert.equal(boxOf(mintSessionCookie({ ...base, authAt: t0 - 9 }, SECRET, true, 60, t0).split(';')[0]!).p.authAt, t0 - 9);
  const read = readMemberSession(mintSessionCookie(base, SECRET, true, 60, Date.now()).split(';')[0], SECRET);
  assert.ok(read && read.exp > Date.now() / 1000 && read.exp <= Date.now() / 1000 + 60);
  assert.equal(readMemberSession(mintSessionCookie(base, 'other', true, 60).split(';')[0], SECRET), null, 'a bad signature reads as nothing');
  assert.equal(readMemberSession(mintSessionCookie(base, SECRET, true, 60, Date.now() - 120_000).split(';')[0], SECRET), null, 'an expired one too');
});

// ── sliding renewal over HTTP ──────────────────────────────────────────────

test('a member request past half the TTL gets a fresh cookie that keeps the chain and the sign-in time', async () => {
  const env = await boot({ sessionTtlHours: 2, sessionMaxHours: 6 });
  await env.login('dana@test');
  const dana = (await env.store.findUsersByEmail('dana@test'))[0]!;
  const now = Date.now();
  const signedIn = now - 1.5 * HOUR;

  // Early in the session: no renewal.
  const fresh = cookieAt(dana, now - 0.5 * HOUR, 2, { authenticatedAt: now - 0.5 * HOUR });
  assert.equal(sessionCookieOf((await env.call(fresh, 'GET', '/api/v1/org-config')).headers), null);

  // Past half: the polled documents and any write renew.
  const old = cookieAt(dana, signedIn, 2, { authenticatedAt: signedIn });
  for (const [method, path, body] of [['GET', '/api/v1/org-config'], ['GET', '/api/auth/session'], ['GET', '/api/v1/inbox'], ['POST', '/api/v1/projects', { name: 'Renewed' }]] as const) {
    const res = await env.call(old, method, path, body);
    assert.ok(res.status < 300, `${method} ${path} → ${res.status}`);
    const renewed = sessionCookieOf(res.headers);
    assert.ok(renewed, `${method} ${path} renews`);
    assert.equal(renewed.maxAge, 2 * 3600);
    const box = boxOf(renewed.pair);
    assert.ok(Math.abs(box.exp * 1000 - (Date.now() + 2 * HOUR)) < 5000, 'a full TTL from now');
    // Carried over; it may lose the sub-second part, which only ever moves the cap earlier.
    assert.ok(box.p.authAt! <= signedIn && signedIn - box.p.authAt! < 1000, 'the chain\'s start is carried over');
    assert.equal(box.p.authenticatedAt, signedIn, 'a renewal is not a sign-in');
    assert.equal(box.p.epoch, dana.sessionEpoch);
    assert.equal((await env.call(renewed.pair, 'GET', '/api/auth/session')).status, 200, 'the new cookie works');
  }
  // Reads that a shared cache could keep, and pages, never carry a cookie.
  for (const path of ['/api/v1/projects', '/api/v1/catalog', '/']) {
    assert.equal(sessionCookieOf((await env.call(old, 'GET', path)).headers), null, `GET ${path} does not renew`);
  }
  // A route that sets its own cookie wins: logout still signs out.
  const out = await env.call(old, 'POST', '/api/auth/logout');
  assert.equal(out.status, 204);
  assert.ok(out.headers.getSetCookie().some((c) => c.startsWith('lw_session=;') && /Max-Age=0/.test(c)));
  assert.ok(!out.headers.getSetCookie().some((c) => /^lw_session=[^;]/.test(c)), 'no renewed cookie beside the cleared one');
});

test('renewal never passes sessionMaxHours, and a cookie without authAt counts from its issue time', async () => {
  const env = await boot({ sessionTtlHours: 2, sessionMaxHours: 6 });
  await env.login('dana@test');
  const dana = (await env.store.findUsersByEmail('dana@test'))[0]!;
  const now = Date.now();

  // Signed in 5 h ago, this cookie issued 1.5 h ago: one hour is left to the cap.
  const nearCap = await env.call(cookieAt(dana, now - 1.5 * HOUR, 2, { authAt: now - 5 * HOUR }), 'GET', '/api/v1/org-config');
  const cut = sessionCookieOf(nearCap.headers)!;
  assert.ok(cut, 'renewed');
  assert.ok(cut.maxAge <= 3600 && cut.maxAge > 3590, `cut to the cap (${cut.maxAge})`);
  assert.ok(boxOf(cut.pair).exp * 1000 <= now - 5 * HOUR + 6 * HOUR + 1000, 'ends no later than authAt + sessionMaxHours');
  // The renewed cookie, near its own end, cannot be renewed past the cap either.
  assert.equal(sessionRenewal(readMemberSession(cut.pair, SECRET)!, { ttlSec: 2 * 3600, maxSec: 6 * 3600 }, Date.now() + 0.9 * HOUR), null);

  // Signed in 6 h ago: past the cap, no renewal, though the cookie still works until it ends.
  const capped = cookieAt(dana, now - 1.5 * HOUR, 2, { authAt: now - 6 * HOUR });
  const res = await env.call(capped, 'GET', '/api/v1/org-config');
  assert.equal(res.status, 200);
  assert.equal(sessionCookieOf(res.headers), null);

  // A cookie minted before authAt existed: authAt = its issue time.
  const issuedAt = now - 1.5 * HOUR;
  const legacy = `lw_session=${mintToken('lw/session', { sub: dana.sub, email: dana.email, groups: [], role: dana.role, name: 'Dana', epoch: dana.sessionEpoch }, SECRET, 2 * 3600, issuedAt)}`;
  const renewed = sessionCookieOf((await env.call(legacy, 'GET', '/api/v1/org-config')).headers)!;
  assert.ok(renewed, 'a legacy cookie renews');
  assert.ok(Math.abs(boxOf(renewed.pair).p.authAt! - issuedAt) <= 1000, 'from its issue time');
  assert.equal(renewed.maxAge, 2 * 3600);
});

test('a revoked, disabled or no longer admitted person gets no renewal', async () => {
  const env = await boot({ sessionTtlHours: 2, sessionMaxHours: 6 }, { admission: { domains: ['life.example'] } });
  const now = Date.now();
  const make = (email: string, sub: string) => env.store.upsertUserBySub({ sub, email, groups: [], role: 'member' });
  const kept = await make('kept@life.example', 'proxy:kept');
  const left = await make('left@else.example', 'proxy:left');
  const renews = async (user: UserRecord) => {
    const fresh = (await env.store.getUser(user.id))!;
    const res = await env.call(cookieAt(fresh, now - 1.5 * HOUR, 2), 'GET', '/api/v1/org-config');
    return { status: res.status, renewed: !!sessionCookieOf(res.headers) };
  };
  assert.deepEqual(await renews(kept), { status: 200, renewed: true });
  // Not admitted any more (not on the lists, no invitation): the session runs out, unrenewed.
  assert.deepEqual(await renews(left), { status: 200, renewed: false });

  // Revoked: the old cookie is refused outright, so nothing is renewed.
  const before = (await env.store.getUser(kept.id))!;
  const oldCookie = cookieAt(before, now - 1.5 * HOUR, 2);
  await env.store.bumpSessionEpoch(kept.id);
  const revoked = await env.call(oldCookie, 'GET', '/api/v1/org-config');
  assert.equal(revoked.status, 401);
  assert.equal(sessionCookieOf(revoked.headers), null);

  // Disabled: the same.
  const current = (await env.store.getUser(kept.id))!;
  const liveCookie = cookieAt(current, now - 1.5 * HOUR, 2);
  await env.store.setUserDisabled(kept.id, new Date().toISOString());
  const disabled = await env.call(liveCookie, 'GET', '/api/v1/org-config');
  assert.equal(disabled.status, 401);
  assert.equal(sessionCookieOf(disabled.headers), null);
});

// ── no new chain without a sign-in ─────────────────────────────────────────

/** Run the device-code flow: start it, approve it at /activate as `approver`, poll it. */
async function deviceSignIn(base: string, approver: string) {
  const started = await fetch(`${base}/api/v1/auth/device`, { method: 'POST' });
  assert.equal(started.status, 200);
  const { deviceCode, userCode } = (await started.json()) as { deviceCode: string; userCode: string };
  const approved = await fetch(`${base}/activate`, {
    method: 'POST',
    headers: { cookie: approver, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code: userCode, decision: 'approve' }).toString(),
  });
  assert.equal(approved.status, 200);
  const poll = await fetch(`${base}/api/v1/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode }),
  });
  assert.equal(poll.status, 200);
  return { body: (await poll.json()) as { status: string; cookie?: string }, cookie: sessionCookieOf(poll.headers) };
}

test('a device approved from an expiring session gets no cookie past that session\'s cap', async () => {
  const env = await boot({ sessionTtlHours: 2, sessionMaxHours: 6 });
  await env.login('dana@test');
  const dana = (await env.store.findUsersByEmail('dana@test'))[0]!;
  const now = Date.now();

  // Signed in 5.5 h ago, this cookie issued an hour ago: half an hour left to the cap.
  const signedIn = now - 5.5 * HOUR;
  const nearCap = cookieAt(dana, now - HOUR, 2, { authAt: signedIn, authenticatedAt: signedIn });
  const near = await deviceSignIn(env.base, nearCap);
  assert.equal(near.body.status, 'approved');
  assert.ok(near.cookie, 'the device gets a session');
  assert.ok(near.cookie.maxAge <= 1800 && near.cookie.maxAge > 1790, `cut to the approver's cap (${near.cookie.maxAge})`);
  const box = boxOf(near.cookie.pair);
  assert.ok(box.exp * 1000 <= signedIn + 6 * HOUR + 1000, 'ends no later than authAt + sessionMaxHours');
  assert.ok(box.p.authAt! <= signedIn && signedIn - box.p.authAt! < 1000, 'the device continues the approver\'s chain');
  assert.equal(box.p.authenticatedAt, signedIn, 'and keeps the time of the last real sign-in');
  assert.equal(near.body.cookie, near.cookie.pair, 'the JSON carries the same, cut cookie');
  // The device's cookie cannot be renewed past the cap either.
  assert.equal(sessionRenewal(readMemberSession(near.cookie.pair, SECRET)!, { ttlSec: 2 * 3600, maxSec: 6 * 3600 }, Date.now() + 1700_000), null);

  // At the cap (the approving cookie still works until it ends): the device is refused.
  const capped = cookieAt(dana, now - HOUR, 2, { authAt: now - 6 * HOUR - 60_000 });
  assert.equal((await env.call(capped, 'GET', '/api/auth/session')).status, 200, 'the approver is still signed in');
  const refused = await deviceSignIn(env.base, capped);
  assert.deepEqual([refused.body, refused.cookie], [{ status: 'denied' }, null], 'no cookie, so no new chain');
  const denied = (await env.store.listAudit()).filter((e) => e.action === 'auth.denied');
  assert.deepEqual(denied.at(-1)?.payload, { provider: 'device', reason: 'session-max', email: 'dana@test' });

  // A fresh session approves a device for a full TTL, in its own chain.
  const fresh = cookieAt(dana, now - 0.25 * HOUR, 2, { authAt: now - 0.25 * HOUR });
  const full = await deviceSignIn(env.base, fresh);
  assert.equal(full.cookie?.maxAge, 2 * 3600);
  assert.ok(Math.abs(boxOf(full.cookie!.pair).p.authAt! - (now - 0.25 * HOUR)) < 1000);
});

test('staying signed in after removing a sign-in keeps the chain and the sign-in time', async () => {
  const env = await boot({ sessionTtlHours: 2, sessionMaxHours: 6 });
  await env.login('dana@test');
  const dana = (await env.store.findUsersByEmail('dana@test'))[0]!;
  const at = new Date().toISOString();
  for (const n of ['1', '2', '3']) {
    await env.store.linkIdentity({ identitySub: `github:${n}`, userId: dana.id, idp: 'github', email: `dana${n}@mail.test`, emailVerified: true, linkedAt: at });
  }
  const now = Date.now();
  const signedIn = now - 5 * HOUR;

  // Five hours into a six-hour cap: the new cookie keeps both times and ends at the cap.
  const before = (await env.store.getUser(dana.id))!;
  const removed = await env.call(cookieAt(before, now - 0.5 * HOUR, 2, { authAt: signedIn, authenticatedAt: signedIn }),
    'DELETE', `/api/v1/me/identities/github/${subjectHash('github:1')}`);
  assert.equal(removed.status, 204);
  const kept = sessionCookieOf(removed.headers);
  assert.ok(kept, 'this browser stays signed in');
  assert.ok(kept.maxAge <= 3600 && kept.maxAge > 3590, `cut to the cap (${kept.maxAge})`);
  const box = boxOf(kept.pair);
  assert.ok(box.p.authAt! <= signedIn && signedIn - box.p.authAt! < 1000, 'removing a sign-in is not a sign-in: the chain carries on');
  assert.equal(box.p.authenticatedAt, signedIn, 'and passkey changes still see the old sign-in time');
  assert.equal((await env.call(kept.pair, 'GET', '/api/auth/session')).status, 200, 'the kept cookie works at the new epoch');

  // Past the cap: every session ends, this browser's too, and the person signs in again.
  const after = (await env.store.getUser(dana.id))!;
  const atCap = cookieAt(after, now - 0.5 * HOUR, 2, { authAt: now - 6 * HOUR - 60_000 });
  const ended = await env.call(atCap, 'DELETE', `/api/v1/me/identities/github/${subjectHash('github:2')}`);
  assert.equal(ended.status, 204);
  assert.equal(sessionCookieOf(ended.headers), null, 'no fresh cookie past the cap');
  assert.equal((await env.call(atCap, 'GET', '/api/auth/session')).status, 401);
});

test('sessionMaxHours: optional, at least sessionTtlHours, at most 720', () => {
  const parse = (policy: Record<string, unknown>) => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', ...policy } }));
  assert.equal(parse({}).policy.sessionMaxHours, undefined);
  assert.equal(parse({ sessionTtlHours: 12, sessionMaxHours: 72 }).policy.sessionMaxHours, 72);
  assert.equal(parse({ sessionTtlHours: 12, sessionMaxHours: 12 }).policy.sessionMaxHours, 12);
  for (const bad of [11, 721, 0, -1, '72', null, true]) {
    assert.throws(() => parse({ sessionTtlHours: 12, sessionMaxHours: bad }), /invalid sessionMaxHours/, `rejects ${String(bad)}`);
  }
});
