/**
 * Policy-as-code pure logic (plan Rec 2): canonical hashing, build/strip,
 * validation, diff, and required-permission derivation - no HTTP, driven against
 * a memory store. The HTTP contract is in config-export-apply.test.ts.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  canonicalize, canonicalHash, buildConfigDocument, validateConfigDocument,
  diffConfigDocument, requiredActions, commitConfigApply, diffSummary,
  CONFIG_DOC_KIND, type ConfigDocument,
} from '../server/src/policy/config-doc.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';

const base = (over: Partial<ConfigDocument> = {}): ConfigDocument => ({
  kind: CONFIG_DOC_KIND, version: 1, grants: [], overlays: [], chains: [], providers: [], featureFlags: [], catalogFields: [], ...over,
});

test('canonicalize deep-sorts object keys, preserves array order; equal docs hash identically', () => {
  const a = base({ grants: [{ principal: 'group:x', action: 'a', resource: '*', effect: 'deny' }], featureFlags: [{ id: 'neurospicy', default: 'off' }] });
  // Same content, different key order in the raw objects.
  const b = base({ featureFlags: [{ id: 'neurospicy', default: 'off' }], grants: [{ effect: 'deny', resource: '*', action: 'a', principal: 'group:x' } as never] });
  assert.equal(canonicalHash(a), canonicalHash(b));
  assert.deepEqual(canonicalize({ b: 1, a: [3, 1, 2] }), { a: [3, 1, 2], b: 1 }); // array order kept
});

test('exportedAt does not affect the hash', () => {
  assert.equal(canonicalHash(base({ exportedAt: '2020-01-01' })), canonicalHash(base({ exportedAt: '2999-12-31' })));
});

test('buildConfigDocument strips volatile fields and excludes config-managed providers', async () => {
  const store = createMemoryStore();
  await store.putOverlay({ toolId: 'qr', version: 7, visibility: { groups: ['brand'] } });
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'on', visibility: 'hide', updatedAt: 'now' });
  const doc = await buildConfigDocument(store);
  const flat = JSON.stringify(doc);
  assert.ok(!flat.includes('"version":7'), 'overlay version stripped');
  assert.ok(!flat.includes('"updatedAt"'), 'flag updatedAt stripped');
  assert.deepEqual(doc.overlays[0], { toolId: 'qr', visibility: { groups: ['brand'] } });
  assert.deepEqual(doc.featureFlags[0], { id: 'jelly-effects', default: 'on', visibility: 'hide' });
});

test('validate rejects wrong kind/version, bad grant tuple, unknown flag, path-tagged', () => {
  assert.ok('errors' in validateConfigDocument({ kind: 'nope', version: 1 }));
  const bad = validateConfigDocument(base({ grants: [{ principal: 'nope', action: '', resource: '', effect: 'maybe' } as never], featureFlags: [{ id: 'not-a-flag' } as never] }));
  assert.ok('errors' in bad);
  if ('errors' in bad) {
    assert.ok(bad.errors.some((e) => e.startsWith('grants[0]')));
    assert.ok(bad.errors.some((e) => e.includes('featureFlags[0]') && e.includes('unknown flag')));
  }
});

test('diff: create/update/unchanged; grants are create/delete only; delete only with prune', () => {
  const cur = base({
    grants: [{ principal: 'group:a', action: 'x', resource: '*', effect: 'allow' }],
    overlays: [{ toolId: 'qr', visibility: { groups: ['brand'] } }],
  });
  const inc = base({
    grants: [{ principal: 'group:b', action: 'y', resource: '*', effect: 'allow' }], // different tuple
    overlays: [{ toolId: 'qr', visibility: { groups: ['legal'] } }], // changed content
  });
  const noPrune = diffConfigDocument(cur, inc, { prune: false }, new Set());
  assert.equal(noPrune.grants.create.length, 1);
  assert.equal(noPrune.grants.delete.length, 0); // no prune
  assert.equal(noPrune.overlays.update.length, 1);
  const pruned = diffConfigDocument(cur, inc, { prune: true }, new Set());
  assert.equal(pruned.grants.delete.length, 1); // old grant removed under prune
});

test('requiredActions maps categories and flags ownerOnly only for a NEW owner-only grant', () => {
  const ownerGrant = { principal: 'group:a', action: 'instance.config', resource: '*', effect: 'allow' as const };
  const cur = base();
  const inc = base({ grants: [ownerGrant] });
  const need = requiredActions(diffConfigDocument(cur, inc, { prune: false }, new Set()));
  assert.ok(need.actions.includes('grant.edit'));
  assert.equal(need.ownerOnly, true);
  // Already present ⇒ unchanged ⇒ not owner-gated.
  const stable = requiredActions(diffConfigDocument(inc, inc, { prune: false }, new Set()));
  assert.equal(stable.ownerOnly, false);
  assert.deepEqual(stable.actions, []);
});

test('commit writes only changes; re-apply is a no-op (overlay version does not churn)', async () => {
  const store = createMemoryStore();
  const doc = base({ overlays: [{ toolId: 'qr', visibility: { groups: ['brand'] } }] });
  const d1 = diffConfigDocument(await buildConfigDocument(store), doc, { prune: false }, new Set());
  await commitConfigApply(store, d1, 'u1');
  const v1 = (await store.listOverlays()).get('qr')!.version;
  const d2 = diffConfigDocument(await buildConfigDocument(store), doc, { prune: false }, new Set());
  assert.equal(d2.overlays.unchanged.length, 1);
  assert.equal(diffSummary(d2).overlays && (diffSummary(d2).overlays as { update: number }).update, 0);
  await commitConfigApply(store, d2, 'u1');
  assert.equal((await store.listOverlays()).get('qr')!.version, v1, 'version stable on no-op re-apply');
});
