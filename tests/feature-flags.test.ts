/**
 * Feature-flag governance (plans/04): the control plane sets a default state and
 * toggle visibility for the shell's per-user flags. Resolver honours built-in
 * defaults on inherit, overrides when set, and marks hidden ones; org-config
 * emits every governable flag and its policyVersion moves when governance does;
 * the memory store round-trips records and clears no-opinion ones.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GOVERNABLE_FLAGS,
  resolveFeatureFlags,
  normalizeFlagGovernance,
  flagGovernanceCatalog,
  type FlagGovernance,
} from '../server/src/policy/feature-flags.ts';
import { assembleOrgConfig } from '../server/src/policy/org-config.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;

function user(): UserRecord {
  const now = new Date().toISOString();
  return {
    id: 'u', sub: 'dev:u@x', email: 'u@x',
    idpGroups: [], localGroups: [], groups: [], role: 'member',
    sessionEpoch: 0, createdAt: now, lastSeenAt: now,
  };
}
const govMap = (...recs: FlagGovernance[]) => new Map(recs.map((r) => [r.id, r]));
const now = () => '2026-07-23T00:00:00.000Z';

test('resolve: empty governance inherits every built-in default', () => {
  const resolved = resolveFeatureFlags(new Map());
  for (const f of GOVERNABLE_FLAGS) {
    assert.equal(resolved[f.id]!.default, f.builtinDefault, `${f.id} default`);
    assert.equal(resolved[f.id]!.hidden, false, `${f.id} shown`);
  }
});

test('resolve: an override wins over the built-in; strip-metadata (built-in off) can be forced on', () => {
  const r = resolveFeatureFlags(govMap({ id: 'strip-upload-metadata', default: 'on', updatedAt: now() }));
  assert.equal(r['strip-upload-metadata']!.default, true);
});

test('resolve: hidden marks the flag hidden while the default still applies', () => {
  const r = resolveFeatureFlags(govMap({ id: 'jelly-effects', default: 'off', visibility: 'hide', updatedAt: now() }));
  assert.deepEqual(r['jelly-effects'], { default: false, hidden: true });
});

// private-collab (OSS plans/100 §7 item 7 / §6.3): the shell's Track-A P2P collab
// flag is ON by default there as of 2026-08-10 (it shipped opt-in) — the control
// plane's builtinDefault MUST match, or an instance that chose "inherit" would be
// told the wrong thing. An instance that wants collaboration to go through Track B
// only can still force this off and hidden, which is the lever that matters more now
// that the shell's own default is on.
test('private-collab is governable, ON by default (builtinDefault true), and round-trips like any other flag', () => {
  const flag = GOVERNABLE_FLAGS.find((f) => f.id === 'private-collab');
  assert.ok(flag, 'private-collab is a governable flag');
  assert.equal(flag!.builtinDefault, true, 'parity with the OSS shell flag, which is on by default');

  // dormant: inherits the built-in default, toggle shown
  const dormant = resolveFeatureFlags(new Map());
  assert.deepEqual(dormant['private-collab'], { default: true, hidden: false });

  // forced OFF — the direction that now differs from the built-in
  const forcedOff = resolveFeatureFlags(govMap({ id: 'private-collab', default: 'off', updatedAt: now() }));
  assert.equal(forcedOff['private-collab']!.default, false);

  // forced hidden with an explicit off default — a fleet that must not have direct
  // device-to-device egress, and no per-user toggle to undo it
  const hidden = resolveFeatureFlags(govMap({ id: 'private-collab', default: 'off', visibility: 'hide', updatedAt: now() }));
  assert.deepEqual(hidden['private-collab'], { default: false, hidden: true });
});

test('private-collab governance reflects in the org-config payload and moves policyVersion', () => {
  const base = assembleOrgConfig({ config: CONFIG, user: user(), overlays: new Map(), inboxUnread: 0 });
  assert.deepEqual(base.featureFlags['private-collab'], { default: true, hidden: false });

  // Off + hidden: the payload has to carry BOTH halves, since the shell needs the
  // forced value (it overrides a user's stored true) as well as the missing toggle.
  const governed = assembleOrgConfig({
    config: CONFIG, user: user(), overlays: new Map(), inboxUnread: 0,
    flagGovernance: govMap({ id: 'private-collab', default: 'off', visibility: 'hide', updatedAt: now() }),
  });
  assert.deepEqual(governed.featureFlags['private-collab'], { default: false, hidden: true });
  assert.notEqual(governed.policyVersion, base.policyVersion);
});

test('normalize: unknown flag id is rejected', () => {
  assert.equal(normalizeFlagGovernance('not-a-flag', { default: 'on' }, now()), null);
});

test('normalize: bad enums are rejected', () => {
  assert.equal(normalizeFlagGovernance('neurospicy', { default: 'maybe' }, now()), null);
  assert.equal(normalizeFlagGovernance('neurospicy', { visibility: 'peek' }, now()), null);
});

test('normalize: show collapses to no-opinion (only hide is stored)', () => {
  const rec = normalizeFlagGovernance('neurospicy', { default: null, visibility: 'show' }, now());
  assert.deepEqual(rec, { id: 'neurospicy', updatedAt: now() }); // no default, no visibility
});

test('catalog: reports built-in default and current override for admins', () => {
  const cat = flagGovernanceCatalog(govMap({ id: 'neurospicy', visibility: 'hide', updatedAt: now() }));
  const neuro = cat.find((c) => c.id === 'neurospicy')!;
  assert.equal(neuro.builtinDefault, true);
  assert.equal(neuro.default, null); // inherited
  assert.equal(neuro.visibility, 'hide');
});

test('org-config emits featureFlags for every governable flag', () => {
  const oc = assembleOrgConfig({ config: CONFIG, user: user(), overlays: new Map(), inboxUnread: 0 });
  for (const f of GOVERNABLE_FLAGS) assert.ok(f.id in oc.featureFlags, `${f.id} present`);
});

test('org-config policyVersion moves when flag governance changes', () => {
  const base = assembleOrgConfig({ config: CONFIG, user: user(), overlays: new Map(), inboxUnread: 0 }).policyVersion;
  const governed = assembleOrgConfig({
    config: CONFIG, user: user(), overlays: new Map(), inboxUnread: 0,
    flagGovernance: govMap({ id: 'neurospicy', visibility: 'hide', updatedAt: now() }),
  }).policyVersion;
  assert.notEqual(base, governed);
});

test('store: put round-trips, and a no-opinion record clears the row', async () => {
  const store = createMemoryStore();
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'off', visibility: 'hide', updatedAt: now() });
  assert.deepEqual((await store.listFlagGovernance()).get('jelly-effects'),
    { id: 'jelly-effects', default: 'off', visibility: 'hide', updatedAt: now() });
  await store.putFlagGovernance({ id: 'jelly-effects', updatedAt: now() }); // reset to inherit + show
  assert.equal((await store.listFlagGovernance()).has('jelly-effects'), false);
});
