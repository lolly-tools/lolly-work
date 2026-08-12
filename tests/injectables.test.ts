/**
 * The injectable-resource rail (plans/19): the four kind envelopes accept/refuse by
 * shape, the registry projects the live set group-filtered into declarative
 * descriptors, flag-kind injectables fold into org-config's featureFlags, and any
 * authored change moves policyVersion so a publish busts connected shells' ETag.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { KIND_HANDLERS } from '../server/src/injectables/kinds.ts';
import {
  validatePublish, projectInjectables, flagInjectableGovernance, injectablesDigest, visibleTo,
} from '../server/src/injectables/registry.ts';
import type { InjectableRecord } from '../server/src/injectables/types.ts';
import { assembleOrgConfig, policyVersionOf } from '../server/src/policy/org-config.ts';
import type { InstanceConfig } from '../server/src/config/instance.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const rec = (over: Partial<InjectableRecord> & Pick<InjectableRecord, 'id' | 'kind' | 'payload'>): InjectableRecord => ({
  title: over.title ?? over.id, groups: over.groups ?? ['*'], state: over.state ?? 'live',
  version: 1, createdBy: 'u', createdAt: '2026-08-02T00:00:00.000Z', updatedAt: '2026-08-02T00:00:00.000Z',
  ...over,
});

// ── envelopes ─────────────────────────────────────────────────────────────────
test('flag envelope: known flag + on/off + visibility', () => {
  const f = KIND_HANDLERS.flag;
  // 'pride-theme' is not guaranteed to be a governable flag, so drive off the
  // shell's real set indirectly: an unknown id must be refused with a reason.
  const bad = f.envelope({ flagId: 'definitely-not-a-real-flag', default: 'on' });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /unknown feature flag/);
  assert.equal(f.envelope({ flagId: 'x', default: 'maybe' }).ok, false);
});

test('resource envelope requires type + assetId', () => {
  const r = KIND_HANDLERS.resource;
  assert.equal(r.envelope({ resourceType: 'ratecard' }).ok, false);
  const ok = r.envelope({ resourceType: 'ratecard', assetId: 'acme/rates' });
  assert.equal(ok.ok, true);
  assert.deepEqual((ok as { facts: unknown }).facts, { type: 'ratecard', asset: 'acme/rates' });
});

test('tool envelope: slug + source, url needs ref', () => {
  const t = KIND_HANDLERS.tool;
  assert.equal(t.envelope({ toolId: 'Bad ID', source: 'catalog' }).ok, false);
  assert.equal(t.envelope({ toolId: 'qr-code', source: 'url' }).ok, false); // no ref
  assert.equal(t.envelope({ toolId: 'qr-code', source: 'catalog' }).ok, true);
});

test('chrome envelope: known slot, plain text (no markup), valid link', () => {
  const c = KIND_HANDLERS.chrome;
  assert.equal(c.envelope({ slot: 'sidebar', text: 'hi' }).ok, false); // unknown slot
  assert.equal(c.envelope({ slot: 'banner', text: '<b>hi</b>' }).ok, false); // markup refused
  assert.equal(c.envelope({ slot: 'banner', text: 'Planned maintenance Sunday', tone: 'warn' }).ok, true);
  assert.equal(c.envelope({ slot: 'banner', text: 'x', link: { label: 'more', href: 'javascript:1' } }).ok, false);
  assert.equal(c.envelope({ slot: 'banner', text: 'x', link: { label: 'more', href: '/status' } }).ok, true);
});

// ── data-not-code guards (adversarial review, 2026-08-02) ───────────────────────
test('no field smuggles code/markup into a descriptor', () => {
  const { tool, chrome, resource } = KIND_HANDLERS;
  // tool.ref must be a real URL, never an active scheme.
  assert.equal(tool.envelope({ toolId: 'x', source: 'url', ref: 'javascript:alert(1)' }).ok, false);
  assert.equal(tool.envelope({ toolId: 'x', source: 'url', ref: 'https://ok.example/t' }).ok, true);
  // chrome.link.label must be plain text; a valid link projects with ONLY label+href
  // (extra keys like onclick/target are dropped, never shipped).
  assert.equal(chrome.envelope({ slot: 'banner', text: 'x', link: { label: '<img onerror=1>', href: '/' } }).ok, false);
  const proj = chrome.project({
    id: 'c', kind: 'chrome', title: 'T', groups: ['*'], state: 'live', version: 1,
    createdBy: 'u', createdAt: '', updatedAt: '',
    payload: { slot: 'banner', text: 'ok', link: { label: 'more', href: '/x', onclick: 'steal()', target: '_blank' } },
  });
  assert.deepEqual((proj as { link: unknown }).link, { label: 'more', href: '/x' });
  // resource ids can't traverse or carry a scheme.
  assert.equal(resource.envelope({ resourceType: 'ratecard', assetId: '../../etc/passwd' }).ok, false);
  assert.equal(resource.envelope({ resourceType: 'Rate Card', assetId: 'a/b' }).ok, false); // type not a slug
  assert.equal(resource.envelope({ resourceType: 'ratecard', assetId: 'acme/rates-2026' }).ok, true);
});

test('title is markup-checked for every kind', () => {
  const good = validatePublish({ id: 'ok', kind: 'chrome', title: 'Fine title', groups: ['*'], payload: { slot: 'banner', text: 'x' } });
  assert.equal(good.ok, true);
  const bad = validatePublish({ id: 'ok', kind: 'chrome', title: '<script>x</script>', groups: ['*'], payload: { slot: 'banner', text: 'x' } });
  assert.equal(bad.ok, false);
  assert.match((bad as { reason: string }).reason, /markup is not allowed/);
});

// ── validatePublish ─────────────────────────────────────────────────────────────
test('validatePublish enforces id slug, known kind, groups, and the kind envelope', () => {
  assert.equal(validatePublish({ id: 'Bad', kind: 'chrome', title: 't', groups: ['*'], payload: { slot: 'banner', text: 'x' } }).ok, false);
  assert.equal(validatePublish({ id: 'ok', kind: 'nope', title: 't', groups: ['*'], payload: {} }).ok, false);
  assert.equal(validatePublish({ id: 'ok', kind: 'chrome', title: 't', groups: [], payload: { slot: 'banner', text: 'x' } }).ok, false);
  const good = validatePublish({ id: 'maint', kind: 'chrome', title: 'Maintenance', groups: ['*'], payload: { slot: 'banner', text: 'Sunday' } });
  assert.equal(good.ok, true);
});

// ── projection + group filter ─────────────────────────────────────────────────
test('projectInjectables filters by group + live state and emits declarative descriptors', () => {
  const recs = [
    rec({ id: 'a', kind: 'chrome', groups: ['design'], payload: { slot: 'banner', text: 'design only' } }),
    rec({ id: 'b', kind: 'chrome', groups: ['*'], payload: { slot: 'banner', text: 'everyone' } }),
    rec({ id: 'c', kind: 'chrome', groups: ['*'], state: 'revoked', payload: { slot: 'banner', text: 'gone' } }),
  ];
  const forMarketer = projectInjectables(recs, ['marketing']);
  assert.deepEqual(forMarketer.map((d) => d.id), ['b']); // not design-scoped, not revoked
  const forDesigner = projectInjectables(recs, ['design']);
  assert.deepEqual(forDesigner.map((d) => d.id), ['a', 'b']);
  assert.equal(visibleTo(recs[2]!, ['design']), false); // revoked never visible
});

// ── flag merge into org-config featureFlags ─────────────────────────────────────
test('a flag injectable for a real governable flag folds into org-config featureFlags', () => {
  // Discover a real governable flag id from the empty-governance baseline.
  const baseFlags = Object.keys(assembleOrgConfigFixture(new Map()).featureFlags);
  assert.ok(baseFlags.length > 0, 'the shell declares at least one governable flag');
  const flagId = baseFlags[0]!;
  const inj = new Map<string, InjectableRecord>([
    ['f', rec({ id: 'f', kind: 'flag', groups: ['*'], payload: { flagId, default: 'on', visibility: 'hide' } })],
  ]);
  const gov = flagInjectableGovernance(inj.values(), ['anyone']);
  assert.deepEqual(gov.get(flagId), { default: 'on', hidden: true });
  const payload = assembleOrgConfigFixture(inj);
  assert.equal(payload.featureFlags[flagId]!.default, true);
  assert.equal(payload.featureFlags[flagId]!.hidden, true);
  // And the flag injectable is NOT also duplicated into the generic list.
  assert.equal(payload.injectables.length, 0);
});

// ── policyVersion moves on any authored change ──────────────────────────────────
test('publishing / revoking an injectable moves policyVersion (busts the ETag)', () => {
  const empty = new Map<string, InjectableRecord>();
  const one = new Map(empty).set('m', rec({ id: 'm', kind: 'chrome', payload: { slot: 'banner', text: 'hi' } }));
  const overlays = new Map();
  const profile = {};
  const v0 = policyVersionOf(overlays, profile, new Map(), empty);
  const v1 = policyVersionOf(overlays, profile, new Map(), one);
  assert.notEqual(v0, v1, 'a publish changes the version');
  const revoked = new Map(one);
  revoked.set('m', { ...revoked.get('m')!, state: 'revoked' });
  const v2 = policyVersionOf(overlays, profile, new Map(), revoked);
  assert.notEqual(v1, v2, 'a revoke changes the version');
  assert.equal(v2, v0, 'a revoked-only set hashes like an empty one'); // revoked drops from the fold
  assert.notEqual(injectablesDigest(one.values()), injectablesDigest(empty.values()));
});

// helper: assemble org-config with a stub user/config and a given injectable map.
function assembleOrgConfigFixture(injectables: Map<string, InjectableRecord>) {
  const user = { id: 'u1', sub: 's', email: 'u@x.io', firstname: 'U', lastname: '', groups: ['anyone'], role: 'member', telemetryConsent: false } as unknown as UserRecord;
  const config = { instance: { name: 'Test' }, policy: { telemetry: 'aggregate', telemetryAttribution: 'opt-in' } } as unknown as InstanceConfig;
  return assembleOrgConfig({ config, user, overlays: new Map(), injectables, inboxUnread: 0 });
}
