// SPDX-License-Identifier: MPL-2.0
/**
 * The licence gate's mode at startup (plans/82 M4).
 *
 * Pinned here: the mode is decided before any request runs, so a first
 * sign-in cannot make an empty instance read as an upgrade; a failed read of
 * the recorded default is tried again and never turns into report mode; until
 * the mode is known, requests wait and then answer 503 while health and
 * readiness answer (readiness names the check); and a stored service token
 * counts as an account when an upgrade is told from a fresh install.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { decidePartnerRightsDefault, PARTNER_RIGHTS_KEY, type InstanceDefaultRecord } from '../server/src/catalog/rights-mode.ts';
import { withFreshPostgres } from './pg-test-schema.ts';

async function pack(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'lw-rights-startup-'));
  await mkdir(join(dir, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(dir, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(dir, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [] }));
  await writeFile(join(dir, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: 1, assets: [] }));
  return dir;
}

/** A memory store whose recorded defaults start empty, as a fresh database does, with a hook on each read. */
function freshStore(onRead: (attempt: number) => Promise<void>) {
  const store = createMemoryStore();
  const rows = new Map<string, InstanceDefaultRecord>();
  let reads = 0;
  store.getInstanceDefault = async (key) => { await onRead(reads++); return rows.get(key) ?? null; };
  store.recordInstanceDefault = async (rec) => { if (!rows.has(rec.key)) rows.set(rec.key, rec); return rows.get(rec.key)!; };
  return { store, rows, reads: () => reads };
}

async function serve(store: ReturnType<typeof createMemoryStore>): Promise<{ base: string; server: Server }> {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Startup', baseUrl: 'http://localhost', pack: await pack() }, rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'first@test', groups: ['owner'] }] },
  }));
  const app = buildApp({ config, store, blobs: createMemoryBlobStore(), secrets: { session: 'ss', link: 'ls' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, () => r()));
  const addr = server.address();
  return { base: `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`, server };
}

test('the first sign-in waits for the decision, so an empty instance is decided as a fresh install', async () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const { store, rows } = freshStore(async () => { await opened; });
  const { base, server } = await serve(store);
  try {
    const signIn = fetch(`${base}/api/auth/dev?email=first%40test`, { redirect: 'manual' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await store.hasAccounts(), false, 'no account before the mode is known');
    open();
    assert.ok([200, 302, 303].includes((await signIn).status));
    assert.equal(rows.get(PARTNER_RIGHTS_KEY)?.value, 'gate', 'decided before the account existed');
    assert.equal(await store.hasAccounts(), true);
  } finally { server.close(); }
});

test('a path that starts as the health check but resolves elsewhere waits too', async () => {
  let open!: () => void;
  const opened = new Promise<void>((r) => { open = r; });
  const { store, rows } = freshStore(async () => { await opened; });
  const { base, server } = await serve(store);
  try {
    const signIn = fetch(`${base}/healthz/%2e%2e/api/auth/dev?email=first%40test`, { redirect: 'manual' });
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(await store.hasAccounts(), false, 'no account before the mode is known');
    open();
    await signIn;
    assert.equal(rows.get(PARTNER_RIGHTS_KEY)?.value, 'gate');
  } finally { server.close(); }
});

test('a failed read is tried again and never turns a recorded gate into report mode', async () => {
  const { store, rows, reads } = freshStore(async (attempt) => { if (attempt === 0) throw new Error('connection reset'); });
  rows.set(PARTNER_RIGHTS_KEY, { key: PARTNER_RIGHTS_KEY, value: 'gate', why: 'fresh-install', decidedAt: '2026-11-07T00:00:00.000Z' });
  const { base, server } = await serve(store);
  try {
    const signIn = await fetch(`${base}/api/auth/dev?email=first%40test`, { redirect: 'manual' });
    const cookie = signIn.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
    const setup = await (await fetch(`${base}/api/v1/system/setup`, { headers: { cookie } })).json() as { checks: Array<{ id: string; message: string }> };
    assert.match(setup.checks.find((c) => c.id === 'partner-rights')!.message, /^Gate: decided at a fresh install/);
    assert.ok(reads() >= 2, 'read again after the failure');
    const ready = await (await fetch(`${base}/readyz`)).json() as { checks: Record<string, string> };
    assert.equal(ready.checks.licenceGate, 'ok');
  } finally { server.close(); }
});

test('until the mode is known, health and readiness answer and other requests are refused, never served in report mode', async () => {
  const { store } = freshStore(async () => { throw new Error('the database is down'); });
  const { base, server } = await serve(store);
  try {
    assert.equal((await fetch(`${base}/healthz`)).status, 200);
    const ready = await fetch(`${base}/readyz`);
    assert.equal(ready.status, 503);
    assert.equal(((await ready.json()) as { checks: Record<string, string> }).checks.licenceGate, 'deciding');
    const res = await fetch(`${base}/catalog/assets/index.json`);
    assert.equal(res.status, 503);
    assert.equal(((await res.json()) as { error: { code: string } }).error.code, 'STARTING');
    assert.equal(await store.hasAccounts(), false);
  } finally { server.close(); }
});

test('a stored service token counts as an account: an instance with tokens and no people is an upgrade', async () => {
  const store = createMemoryStore();
  assert.equal(await store.hasAccounts(), false);
  await store.putApiToken({ id: 'tok_old', label: 'old agent', role: 'member', tokenHash: 'h', scopes: ['render'], createdBy: 'usr_gone', createdAt: '2026-01-01T00:00:00.000Z' } as never);
  assert.equal(await store.hasAccounts(), true);
});

const pgUrl = process.env.LW_TEST_DATABASE_URL;
test('on Postgres: a database holding only service tokens is decided as an upgrade', { skip: !pgUrl && 'set LW_TEST_DATABASE_URL to run' }, async () => {
  await withFreshPostgres(pgUrl as string, async (pg) => {
    await pg.putApiToken({ id: 'tok_old', label: 'old agent', role: 'member', tokenHash: 'h', scopes: ['render'], createdBy: 'usr_gone', createdAt: '2026-01-01T00:00:00.000Z' } as never);
    assert.equal(await pg.hasAccounts(), true);
    const decided = await decidePartnerRightsDefault(pg);
    assert.deepEqual([decided.value, decided.why], ['report', 'upgrade-with-accounts']);
  });
});
