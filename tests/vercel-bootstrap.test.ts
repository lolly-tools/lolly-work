// SPDX-License-Identifier: MPL-2.0
/**
 * The Vercel bootstrap (api/_lib/bootstrap.ts) applies the same production
 * refusals as server/src/main.ts: a production-mode config with the development
 * login and a memory store does not boot, while the same config in evaluation
 * mode does. Runs the bootstrap in-process; no Vercel runtime is involved.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

const BASE = {
  instance: { name: 'Bootstrap fixture', baseUrl: 'https://fixture.test', pack: 'packs/demo' },
  dev: { enabled: true, users: [{ email: 'owner@fixture.test', groups: ['owner'] }] },
  policy: { defaultAccessMode: 'open' },
  rateLimit: { enabled: false },
};

for (const name of Object.keys(process.env)) if (name.startsWith('LW_') || name === 'DATABASE_URL') delete process.env[name];
process.env.LW_SESSION_SECRET = 'fixture-session-secret-'.repeat(2);
process.env.LW_LINK_SECRET = 'fixture-link-secret-'.repeat(2);

const { getApp } = await import('../api/_lib/bootstrap.ts');

test('production mode refuses a memory store and the development login', async () => {
  process.env.LW_CONFIG_JSON = JSON.stringify({ ...BASE, deployment: { mode: 'production' } });
  const errors: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
  try {
    await assert.rejects(getApp(), /Production setup validation failed/);
  } finally {
    console.error = original;
  }
  for (const id of ['storage', 'development-login', 'access']) {
    assert.ok(errors.some((e) => e.includes(`] ${id}:`)), `the ${id} check is reported`);
  }
  assert.ok(errors.every((e) => !e.includes('fixture-session-secret')), 'no secret value is logged');
});

test('production warnings reach the function log, as main.ts writes them at boot', async () => {
  // No admission policy is a warning, not a refusal: every account the identity
  // provider accepts gets in. main.ts logs it; the function must too.
  process.env.LW_CONFIG_JSON = JSON.stringify({
    ...BASE, deployment: { mode: 'production' },
    idp: { issuer: 'https://idp.fixture.test', clientId: 'fixture-client' },
  });
  const warnings: string[] = [];
  const original = { warn: console.warn, error: console.error };
  console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
  console.error = () => {};
  try {
    await assert.rejects(getApp(), /Production setup validation failed/);
  } finally {
    console.warn = original.warn;
    console.error = original.error;
  }
  assert.ok(warnings.some((w) => w.includes('WARNING admission:')), 'the open admission policy is reported');
  assert.ok(warnings.every((w) => !w.includes('fixture-session-secret')), 'no secret value is logged');
});

test('the same settings boot in evaluation mode, and a failed boot is not cached', async () => {
  process.env.LW_CONFIG_JSON = JSON.stringify({ ...BASE, deployment: { mode: 'evaluation' } });
  const app = await getApp();
  assert.equal(typeof app, 'function');
});

// ── the boot deadline (lolly.ing, 2026-10-03: requests stuck behind one boot) ──

test('a boot that never settles fails its callers at the deadline, and the next call boots afresh', async () => {
  const { memoisedBoot } = await import('../api/_lib/bootstrap.ts');
  let starts = 0;
  let succeed = false;
  const getApp = memoisedBoot(() => {
    starts++;
    return succeed ? Promise.resolve('app') : new Promise<string>(() => {}); // hangs like the stuck pg lock
  }, () => 50);
  const [a, b] = [getApp(), getApp()];
  assert.equal(starts, 1, 'concurrent callers share one boot');
  await assert.rejects(a, /did not finish within 50 ms/);
  await assert.rejects(b, /did not finish within 50 ms/);
  succeed = true;
  assert.equal(await getApp(), 'app', 'the next request starts a fresh boot instead of waiting on the stuck one');
  assert.equal(starts, 2);
  assert.equal(await getApp(), 'app');
  assert.equal(starts, 2, 'a booted app is kept');
});

test('a failed boot is retried by the next call; a late failure of an abandoned boot is ignored', async () => {
  const { memoisedBoot } = await import('../api/_lib/bootstrap.ts');
  let starts = 0;
  let failLate!: (err: Error) => void;
  const getApp = memoisedBoot(() => {
    starts++;
    if (starts === 1) return Promise.reject(new Error('database refused'));
    if (starts === 2) return new Promise<string>((_, reject) => { failLate = reject; });
    return Promise.resolve('app');
  }, () => 30);
  await assert.rejects(getApp(), /database refused/);
  await assert.rejects(getApp(), /did not finish/);
  assert.equal(await getApp(), 'app');
  failLate(new Error('late')); // the abandoned second boot fails after its replacement booted
  await new Promise((resolve) => setTimeout(resolve, 10));
  assert.equal(await getApp(), 'app', 'the late failure does not clear the booted app');
  assert.equal(starts, 3);
});

test('LW_BOOT_TIMEOUT_MS sets the deadline; anything but a positive integer keeps 30 s', async () => {
  const { bootDeadlineMs } = await import('../api/_lib/bootstrap.ts');
  assert.equal(bootDeadlineMs({}), 30_000);
  assert.equal(bootDeadlineMs({ LW_BOOT_TIMEOUT_MS: '45000' }), 45_000);
  for (const bad of ['', '0', '-5', '1.5', 'soon']) assert.equal(bootDeadlineMs({ LW_BOOT_TIMEOUT_MS: bad }), 30_000, bad);
  // Past 2^31-1 ms a Node timer fires after 1 ms: every boot would time out at once.
  assert.equal(bootDeadlineMs({ LW_BOOT_TIMEOUT_MS: '2147483647' }), 2_147_483_647);
  assert.equal(bootDeadlineMs({ LW_BOOT_TIMEOUT_MS: '3000000000' }), 2_147_483_647);
});
