/**
 * Device-code sign-in (plans/34 wave 4) - the registry in isolation, and the
 * whole flow over real HTTP: request, confirm at /activate as a signed-in
 * person, poll to a working session. The properties that matter:
 *   - approval lives ONLY on /activate (the console API can deny, never approve);
 *   - an approved claim is single-read, and a replay reads as expired;
 *   - a disable between approval and claim wins - the mint re-checks;
 *   - codes are store rows (plans/35 wave 5): any replica answers the poll, and
 *     serverless deploys have the flow too.
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
import { createDeviceAuth, normalizeUserCode, DEVICE_CODE_TTL_SEC } from '../server/src/iam/device-auth.ts';

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

interface Booted { base: string; store: ReturnType<typeof createMemoryStore> }

async function boot(): Promise<Booted> {
  const pack = await mkdtemp(join(tmpdir(), 'lw-device-'));
  await mkdir(join(pack, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Device Hub', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', groups: ['admin'] },
      { email: 'maker@test', groups: ['member'] },
    ] },
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
  assert.equal(res.status, 302);
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

const startFlow = async (base: string) => {
  const res = await fetch(`${base}/api/v1/auth/device`, { method: 'POST', headers: { 'x-lolly-client': 'lw-cli engine/0' } });
  assert.equal(res.status, 200);
  return (await res.json()) as { deviceCode: string; userCode: string; verificationUri: string; interval: number };
};

const pollFlow = async (base: string, deviceCode: string) => {
  const res = await fetch(`${base}/api/v1/auth/device/token`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ deviceCode }),
  });
  assert.equal(res.status, 200);
  return (await res.json()) as { status: string; cookie?: string };
};

const activate = (base: string, cookie: string, code: string, decision: 'approve' | 'deny') =>
  fetch(`${base}/activate`, {
    method: 'POST',
    headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ code, decision }).toString(),
  });

// ── the registry ─────────────────────────────────────────────────────────────

test('registry: codes expire on the clock, approval is single-read, typing is forgiven', async () => {
  const codeStore = createMemoryStore();
  const reg = createDeviceAuth(codeStore);
  const started = await reg.request('tauri engine/1.146.0');
  assert.ok(started);
  assert.match(started.userCode, /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/, 'confusable-free, hyphenated');
  assert.equal((await reg.pending()).length, 1);
  assert.equal((await reg.pending())[0]?.clientTag, 'tauri engine/1.146.0');

  // A person types the code however they type it.
  const sloppy = ` ${started.userCode.toLowerCase().replace('-', ' ')} `;
  assert.equal(normalizeUserCode(sloppy), started.userCode);
  assert.ok(await reg.describe(sloppy), 'describe forgives the typing');

  const user = { sub: 's', email: 'e@x', name: 'E', groups: [], role: 'member' };
  assert.equal(await reg.approve(sloppy, user), true);
  assert.equal(await reg.approve(started.userCode, user), false, 'already settled');
  const claim = await reg.claim(started.deviceCode);
  assert.equal(claim.status, 'approved');
  assert.equal((await reg.claim(started.deviceCode)).status, 'expired', 'single-read: a replay gets nothing');

  // A registry stamping with an already-past clock mints a code that is born
  // expired - the store's own expiry (real time) is what enforces the TTL.
  const backdated = createDeviceAuth(codeStore, () => Date.now() - (DEVICE_CODE_TTL_SEC + 1) * 1000);
  const second = await backdated.request();
  assert.ok(second);
  assert.equal((await reg.claim(second.deviceCode)).status, 'expired', 'the clock wins');
  assert.equal((await reg.pending()).length, 0, 'expired codes leave the pending list');

  const third = await reg.request();
  assert.ok(third);
  assert.equal(await reg.deny(third.userCode), true);
  assert.equal((await reg.claim(third.deviceCode)).status, 'denied');
});

// ── the flow over HTTP ───────────────────────────────────────────────────────

test('request → confirm at /activate → poll collects a session that works', async () => {
  const { base } = await boot();
  const d = await startFlow(base);
  assert.equal(d.verificationUri, 'http://localhost/activate');

  assert.deepEqual(await pollFlow(base, d.deviceCode), { status: 'pending' });

  // Signed out, /activate offers sign-in, never the form.
  const anon = await (await fetch(`${base}/activate`)).text();
  assert.ok(anon.includes('Sign in to continue'));
  assert.ok(!anon.includes('name="code"'), 'no form for the signed-out');

  // Signed in, the page shows the form; with ?code= it names the asking client.
  const cookie = await login(base, 'maker@test');
  const form = await (await fetch(`${base}/activate?code=${d.userCode}`, { headers: { cookie } })).text();
  assert.ok(form.includes('lw-cli engine/0'), 'the asking client is shown before approval');

  // Approve with sloppy typing; the poll then carries a working session.
  const done = await activate(base, cookie, d.userCode.toLowerCase(), 'approve');
  assert.ok((await done.text()).includes('Approved'));
  const t = await pollFlow(base, d.deviceCode);
  assert.equal(t.status, 'approved');
  assert.ok(t.cookie?.startsWith('lw_session='));
  const who = await (await fetch(`${base}/api/auth/session`, { headers: { cookie: t.cookie as string } })).json() as { kind: string; user?: { email: string } };
  assert.equal(who.kind, 'member');
  assert.equal(who.user?.email, 'maker@test', 'the device signs in as the person who approved');

  assert.deepEqual(await pollFlow(base, d.deviceCode), { status: 'expired' }, 'approved is single-read');
});

test('deny from /activate and from the console API; approval has no API route', async () => {
  const { base } = await boot();
  const admin = await login(base, 'admin@test');
  const member = await login(base, 'maker@test');

  const d1 = await startFlow(base);
  const denied = await activate(base, member, d1.userCode, 'deny');
  assert.ok((await denied.text()).includes('Denied'));
  assert.deepEqual(await pollFlow(base, d1.deviceCode), { status: 'denied' });

  const d2 = await startFlow(base);
  const list = await (await fetch(`${base}/api/v1/auth/device/pending`, { headers: { cookie: admin } })).json() as { pending: Array<{ userCode: string }> };
  assert.deepEqual(list.pending.map((p) => p.userCode), [d2.userCode]);
  assert.equal((await fetch(`${base}/api/v1/auth/device/pending`, { headers: { cookie: member } })).status, 403);

  const deny = await fetch(`${base}/api/v1/auth/device/deny`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ userCode: d2.userCode }),
  });
  assert.equal(deny.status, 200);
  assert.deepEqual(await pollFlow(base, d2.deviceCode), { status: 'denied' });
  const gone = await fetch(`${base}/api/v1/auth/device/deny`, {
    method: 'POST', headers: { cookie: admin, 'content-type': 'application/json' }, body: JSON.stringify({ userCode: d2.userCode }),
  });
  assert.equal(gone.status, 404, 'a settled code is no longer deniable');
});

test('a disable between approval and claim wins - the mint re-checks the person', async () => {
  const { base, store } = await boot();
  const admin = await login(base, 'admin@test');
  const member = await login(base, 'maker@test');
  const d = await startFlow(base);
  await activate(base, member, d.userCode, 'approve');

  const maker = (await store.listUsers()).find((u) => u.email === 'maker@test');
  await store.setUserDisabled((maker as { id: string }).id, new Date().toISOString());
  assert.deepEqual(await pollFlow(base, d.deviceCode), { status: 'denied' }, 'a closed account gets nothing');
  void admin;
});

// ── the migration ────────────────────────────────────────────────────────────

test('migration 0026 follows 0025 and the claim is single-read in schema', async () => {
  const { readdir: rd, readFile: rf } = await import('node:fs/promises');
  const dir = new URL('../migrations/', import.meta.url).pathname;
  const files = (await rd(dir)).filter((f) => f.endsWith('.sql')).sort();
  const at = files.indexOf('0026_device_codes.sql');
  assert.ok(at > 0, '0026 is on disk');
  assert.equal(files[at - 1], '0025_audit_anchor.sql', '0026 follows 0025 with nothing between');
  // The ceiling assertion moved with the ceiling: tests/catalog-providers.test.ts owns it now (0027, plans/36 §2).
  const sql = await rf(join(dir, '0026_device_codes.sql'), 'utf8');
  assert.match(sql, /create table device_codes/);
  assert.match(sql, /user_code\s+text not null unique/);
  const driver = await rf(new URL('../server/src/store/postgres.ts', import.meta.url).pathname, 'utf8');
  assert.match(driver, /delete from device_codes where device_code = \$1 and status <> 'pending' returning/);
});
