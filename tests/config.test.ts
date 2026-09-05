import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig, loadSecrets, parseAutoMigrate } from '../server/src/config/instance.ts';

test('defaults merge under a partial config', () => {
  const cfg = parseConfig(JSON.stringify({ instance: { name: 'Test Hub' }, dev: { enabled: true, users: [] } }));
  assert.equal(cfg.instance.name, 'Test Hub');
  assert.equal(cfg.policy.defaultAccessMode, 'gated');
  assert.equal(cfg.policy.telemetryAttribution, 'opt-in');
  assert.equal(cfg.idp.claimMap.firstname, 'given_name');
});

test('gated without an IdP or dev provider is rejected', () => {
  assert.throws(() => parseConfig(JSON.stringify({})), /gated access needs idp.issuer/);
  assert.throws(() => parseConfig(JSON.stringify({ policy: { telemetry: 'loud' }, dev: { enabled: true } })), /invalid telemetry/);
  // open mode needs neither
  const open = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } }));
  assert.equal(open.policy.defaultAccessMode, 'open');
});

test('sessionTtlHours: defaults to 12, overridable per-policy, bounds enforced', () => {
  assert.equal(parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } })).policy.sessionTtlHours, 12);
  // A partial policy override keeps the other policy defaults (deep merge).
  const over = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', sessionTtlHours: 8 } }));
  assert.equal(over.policy.sessionTtlHours, 8);
  assert.equal(over.policy.telemetryAttribution, 'opt-in');
  assert.equal(over.policy.guestLinks.defaultTtlHours, 72);
  // Footgun configs are rejected at boot rather than minting broken cookies.
  for (const bad of [0, -1, 1000]) {
    assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open', sessionTtlHours: bad } })), /invalid sessionTtlHours/);
  }
});

test('parseAutoMigrate: unset defaults on; explicit off values turn it off', () => {
  assert.equal(parseAutoMigrate({} as NodeJS.ProcessEnv), true); // unset ⇒ single-node default
  for (const v of ['false', '0', 'off', 'no', '', '  Off ']) {
    assert.equal(parseAutoMigrate({ LW_AUTO_MIGRATE: v } as NodeJS.ProcessEnv), false, `"${v}" ⇒ off`);
  }
  for (const v of ['true', '1', 'yes', 'on']) {
    assert.equal(parseAutoMigrate({ LW_AUTO_MIGRATE: v } as NodeJS.ProcessEnv), true, `"${v}" ⇒ on`);
  }
});

test('rateLimit: deep-merges defaults; a partial override keeps the rest', () => {
  const d = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' } })).rateLimit;
  assert.equal(d.enabled, true);
  assert.equal(d.auth.capacity, 10);
  const over = parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' }, rateLimit: { auth: { capacity: 3, refillPerSec: 0.5 } } })).rateLimit;
  assert.equal(over.auth.capacity, 3);
  assert.equal(over.telemetry.capacity, 120); // untouched default survives
  assert.equal(over.automation.capacity, 120);
  assert.equal(over.enabled, true);
  assert.throws(() => parseConfig(JSON.stringify({ policy: { defaultAccessMode: 'open' }, rateLimit: { auth: { capacity: 0, refillPerSec: 1 } } })), /rateLimit\.auth/);
});

test('secrets: required in production, ephemeral in dev', () => {
  assert.throws(() => loadSecrets({ NODE_ENV: 'production' } as NodeJS.ProcessEnv), /LW_SESSION_SECRET/);
  const dev = loadSecrets({} as NodeJS.ProcessEnv);
  assert.ok(dev.session.startsWith('dev-only-'));
  const prod = loadSecrets({ NODE_ENV: 'production', LW_SESSION_SECRET: 'a', LW_LINK_SECRET: 'b' } as NodeJS.ProcessEnv);
  assert.deepEqual([prod.session, prod.link], ['a', 'b']);
});
