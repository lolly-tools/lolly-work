/**
 * Per-group feature-flag governance: a group rule sets a flag's default or
 * toggle visibility for members of that group, over the instance setting.
 * When several of a person's groups disagree, Off beats On and Hidden beats
 * Shown, whatever the order. Managed AI takes no group rules. The routes keep
 * stored rules when a client sends only the two instance settings, and the
 * policy-as-code document carries the rules.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  resolveFeatureFlags, normalizeFlagGovernance, flagGovernanceCatalog, flagGovernanceForVersion,
  hasFlagOpinion, MAX_FLAG_GROUP_RULES, type FlagGovernance,
} from '../server/src/policy/feature-flags.ts';
import { assembleOrgConfig } from '../server/src/policy/org-config.ts';
import { buildConfigDocument, validateConfigDocument, diffConfigDocument, commitConfigApply } from '../server/src/policy/config-doc.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig, type InstanceConfig } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { UserRecord } from '../server/src/store/types.ts';

const AT = '2026-10-27T00:00:00.000Z';
const gov = (...recs: FlagGovernance[]) => new Map(recs.map((r) => [r.id, r]));
const CONFIG = {
  instance: { name: 'Test' },
  policy: { telemetry: 'standard', telemetryAttribution: 'opt-in' },
} as unknown as InstanceConfig;
function user(groups: string[]): UserRecord {
  return {
    id: 'u', sub: 'dev:u@x', email: 'u@x', idpGroups: groups, localGroups: [], groups, role: 'member',
    sessionEpoch: 0, createdAt: AT, lastSeenAt: AT,
  };
}

test('precedence: a matching group rule beats the instance default, others keep the instance default', () => {
  const g = gov({ id: 'export-preflight', default: 'off', groups: [{ group: 'print', default: 'on' }], updatedAt: AT });
  assert.equal(resolveFeatureFlags(g, ['print'])['export-preflight']!.default, true);
  assert.equal(resolveFeatureFlags(g, ['sales'])['export-preflight']!.default, false);
  assert.equal(resolveFeatureFlags(g, [])['export-preflight']!.default, false);
  // Without the caller's groups only the instance setting is visible.
  assert.equal(resolveFeatureFlags(g)['export-preflight']!.default, false);
});

test('precedence: a group rule with no instance default overrides the built-in default', () => {
  const g = gov({ id: 'jelly-effects', groups: [{ group: 'calm', default: 'off' }], updatedAt: AT });
  assert.equal(resolveFeatureFlags(g, ['calm'])['jelly-effects']!.default, false);
  assert.equal(resolveFeatureFlags(g, ['other'])['jelly-effects']!.default, true, 'built-in default');
});

test('several matching groups: Off beats On and Hidden beats Shown, in any order', () => {
  const rules = [
    { group: 'pilot', default: 'on' as const, visibility: 'show' as const },
    { group: 'contractors', default: 'off' as const, visibility: 'hide' as const },
  ];
  for (const order of [rules, [...rules].reverse()]) {
    const g = gov({ id: 'neurospicy', groups: order, updatedAt: AT });
    for (const groups of [['pilot', 'contractors'], ['contractors', 'pilot']]) {
      assert.deepEqual(resolveFeatureFlags(g, groups).neurospicy, { default: false, hidden: true });
    }
  }
});

test('knobs resolve independently: a rule that sets only visibility leaves the default to the instance', () => {
  const g = gov({ id: 'private-collab', default: 'off', visibility: 'hide', groups: [{ group: 'pilot', visibility: 'show' }], updatedAt: AT });
  assert.deepEqual(resolveFeatureFlags(g, ['pilot'])['private-collab'], { default: false, hidden: false });
  assert.deepEqual(resolveFeatureFlags(g, ['x'])['private-collab'], { default: false, hidden: true });
});

test('the pilot pattern: dark for everyone, On and shown for one team', () => {
  const g = gov({ id: 'export-preflight', default: 'off', visibility: 'hide', groups: [{ group: 'pilot', default: 'on', visibility: 'show' }], updatedAt: AT });
  assert.deepEqual(resolveFeatureFlags(g, ['pilot', 'staff'])['export-preflight'], { default: true, hidden: false });
  assert.deepEqual(resolveFeatureFlags(g, ['staff'])['export-preflight'], { default: false, hidden: true });
});

test('group matching is exact: case, prefixes and the * wildcard never match', () => {
  const g = gov({ id: 'export-preflight', groups: [{ group: 'Print', default: 'on' }], updatedAt: AT });
  for (const groups of [['print'], ['Print-team'], ['*'], ['Prin']]) {
    assert.equal(resolveFeatureFlags(g, groups)['export-preflight']!.default, false, groups.join());
  }
});

test('managed AI takes no group rules: refused on save and ignored if one were stored', () => {
  assert.equal(normalizeFlagGovernance('ai', { default: 'off', groups: [{ group: 'pilot', default: 'on' }] }, AT), null);
  // An empty list is no rule at all, so a client that always sends groups still works.
  assert.deepEqual(normalizeFlagGovernance('ai', { default: 'on', groups: [] }, AT), { id: 'ai', default: 'on', updatedAt: AT });
  const stored = gov({ id: 'ai', groups: [{ group: 'pilot', default: 'on' }], updatedAt: AT });
  assert.equal(resolveFeatureFlags(stored, ['pilot']).ai!.default, false);
});

test('normalize: group rules are validated, sorted, and no-opinion rules dropped', () => {
  const rec = normalizeFlagGovernance('neurospicy', { groups: [
    { group: 'zeta', default: 'off' }, { group: 'alpha', visibility: 'show' }, { group: 'empty', default: null, visibility: null },
  ] }, AT);
  assert.deepEqual(rec, { id: 'neurospicy', updatedAt: AT, groups: [{ group: 'alpha', visibility: 'show' }, { group: 'zeta', default: 'off' }] });
  for (const groups of [
    'pilot', [{ group: 'a', default: 'maybe' }], [{ group: 'a', visibility: 'peek' }], [{ group: '' }],
    [{ group: ' padded ', default: 'on' }], [{ group: '*', default: 'on' }], [{ group: 'a\nb', default: 'on' }],
    [{ group: 'a', default: 'on' }, { group: 'a', default: 'off' }], [{ group: 'a', default: 'on', extra: 1 }],
    [null], Array.from({ length: MAX_FLAG_GROUP_RULES + 1 }, (_, i) => ({ group: `g${i}`, default: 'on' })),
  ]) {
    assert.equal(normalizeFlagGovernance('neurospicy', { groups }, AT), null, JSON.stringify(groups).slice(0, 60));
  }
  // IdP group names with spaces or paths are accepted as sent.
  assert.ok(normalizeFlagGovernance('neurospicy', { groups: [{ group: '/eng/Design Team', default: 'on' }] }, AT));
});

test('a record holding only group rules is an opinion; clearing them clears the row', async () => {
  const store = createMemoryStore();
  const rec = normalizeFlagGovernance('neurospicy', { groups: [{ group: 'calm', default: 'off' }] }, AT)!;
  assert.equal(hasFlagOpinion(rec), true);
  await store.putFlagGovernance(rec);
  assert.deepEqual((await store.listFlagGovernance()).get('neurospicy')?.groups, [{ group: 'calm', default: 'off' }]);
  await store.putFlagGovernance(normalizeFlagGovernance('neurospicy', { groups: [] }, AT)!);
  assert.equal((await store.listFlagGovernance()).has('neurospicy'), false);
});

test('catalog reports group rules, whether a flag takes them, and whether the flag service decides it', () => {
  const cat = flagGovernanceCatalog(gov({ id: 'neurospicy', groups: [{ group: 'calm', default: 'off' }], updatedAt: AT }), { flagService: ['neurospicy'] });
  const neuro = cat.find((c) => c.id === 'neurospicy')!;
  assert.deepEqual(neuro.groups, [{ group: 'calm', default: 'off', visibility: null }]);
  assert.equal(neuro.groupRules, true);
  assert.equal(neuro.flagService, true);
  const ai = cat.find((c) => c.id === 'ai')!;
  assert.equal(ai.groupRules, false);
  assert.equal(ai.flagService, false);
});

test('version: rules move the hash; a deployment without rules keeps its earlier digest shape', () => {
  const plain = gov({ id: 'neurospicy', visibility: 'hide', updatedAt: AT });
  assert.deepEqual(flagGovernanceForVersion(plain), [{ id: 'neurospicy', default: null, visibility: 'hide' }]);
  const ruled = gov({ id: 'neurospicy', visibility: 'hide', groups: [{ group: 'calm', default: 'off' }], updatedAt: AT });
  assert.notDeepEqual(flagGovernanceForVersion(ruled), flagGovernanceForVersion(plain));
  const a = assembleOrgConfig({ config: CONFIG, user: user(['calm']), overlays: new Map(), inboxUnread: 0, flagGovernance: plain });
  const b = assembleOrgConfig({ config: CONFIG, user: user(['calm']), overlays: new Map(), inboxUnread: 0, flagGovernance: ruled });
  assert.notEqual(a.policyVersion, b.policyVersion);
});

test('org-config resolves group rules for the caller only', () => {
  const g = gov({ id: 'export-preflight', groups: [{ group: 'print', default: 'on', visibility: 'hide' }], updatedAt: AT });
  const printer = assembleOrgConfig({ config: CONFIG, user: user(['print']), overlays: new Map(), inboxUnread: 0, flagGovernance: g });
  const other = assembleOrgConfig({ config: CONFIG, user: user(['sales']), overlays: new Map(), inboxUnread: 0, flagGovernance: g });
  assert.deepEqual(printer.featureFlags['export-preflight'], { default: true, hidden: true });
  assert.deepEqual(other.featureFlags['export-preflight'], { default: false, hidden: false });
});

test('policy-as-code: group rules export, validate, diff and apply; an export without rules keeps its shape', async () => {
  const store = createMemoryStore();
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'off', updatedAt: AT });
  const plainDoc = await buildConfigDocument(store);
  assert.deepEqual(plainDoc.featureFlags, [{ id: 'jelly-effects', default: 'off' }]);
  await store.putFlagGovernance({ id: 'jelly-effects', default: 'off', groups: [{ group: 'fun', default: 'on' }], updatedAt: AT });
  const doc = await buildConfigDocument(store);
  assert.deepEqual(doc.featureFlags, [{ id: 'jelly-effects', default: 'off', groups: [{ group: 'fun', default: 'on' }] }]);

  const target = createMemoryStore();
  const parsed = validateConfigDocument(JSON.parse(JSON.stringify(doc)));
  assert.ok('doc' in parsed, JSON.stringify(parsed));
  const current = await buildConfigDocument(target);
  const diff = diffConfigDocument(current, parsed.doc, { prune: false }, new Set());
  assert.equal(diff.featureFlags.create.length, 1);
  await commitConfigApply(target, diff, 'u1');
  assert.deepEqual((await target.listFlagGovernance()).get('jelly-effects')?.groups, [{ group: 'fun', default: 'on' }]);

  const bad = validateConfigDocument({ ...JSON.parse(JSON.stringify(doc)), featureFlags: [{ id: 'ai', groups: [{ group: 'x', default: 'on' }] }] });
  assert.ok('errors' in bad);
});

/** A live app with an admin and two members, for the route contract. */
async function serve(t: TestContext) {
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'admin@test', name: 'Admin', groups: ['admin'] },
      { email: 'pilot@test', name: 'Pilot', groups: ['pilot'] },
      { email: 'member@test', name: 'Member', groups: [] },
    ] },
  }));
  const app = buildApp({ config, store, secrets: { session: 'test-session', link: 'test-link' } });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const login = async (email: string) => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const put = (cookie: string, id: string, body: unknown) => fetch(`${base}/api/v1/policy/flags/${id}`, {
    method: 'PUT', headers: { cookie, 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
  const orgConfig = async (cookie: string) => (await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json()) as {
    featureFlags: Record<string, { default: boolean; hidden: boolean }>;
  };
  return { store, base, login, put, orgConfig };
}

test('HTTP: group rules save, reach only their members, survive an instance-only save, and clear with []', async (t) => {
  const { store, base, login, put, orgConfig } = await serve(t);
  const admin = await login('admin@test');
  const pilot = await login('pilot@test');
  const member = await login('member@test');

  let res = await put(admin, 'export-preflight', { default: 'off', visibility: 'hide', groups: [{ group: 'pilot', default: 'on', visibility: 'show' }] });
  assert.equal(res.status, 200);
  const body = await res.json() as { flags: Array<{ id: string; groups: unknown[] }>; flagService: unknown };
  assert.deepEqual(body.flags.find((f) => f.id === 'export-preflight')!.groups, [{ group: 'pilot', default: 'on', visibility: 'show' }]);
  assert.equal(body.flagService, null);
  assert.deepEqual((await orgConfig(pilot)).featureFlags['export-preflight'], { default: true, hidden: false });
  assert.deepEqual((await orgConfig(member)).featureFlags['export-preflight'], { default: false, hidden: true });

  // An older client that knows only the two instance settings keeps the rules.
  res = await put(admin, 'export-preflight', { default: 'on', visibility: 'show' });
  assert.equal(res.status, 200);
  assert.deepEqual((await store.listFlagGovernance()).get('export-preflight')?.groups, [{ group: 'pilot', default: 'on', visibility: 'show' }]);

  // A member cannot edit governance; malformed rules are refused.
  assert.equal((await put(member, 'export-preflight', { groups: [] })).status, 403);
  assert.equal((await put(admin, 'export-preflight', { groups: [{ group: 'a', default: 'on' }, { group: 'a', default: 'off' }] })).status, 400);
  assert.equal((await put(admin, 'ai', { groups: [{ group: 'pilot', default: 'on' }] })).status, 400);

  res = await put(admin, 'export-preflight', { default: null, visibility: 'show', groups: [] });
  assert.equal(res.status, 200);
  assert.equal((await store.listFlagGovernance()).has('export-preflight'), false);

  const audit = await (await fetch(`${base}/api/v1/audit?action=policy.flag.edit`, { headers: { cookie: admin } })).json() as { events: unknown[] };
  assert.equal(audit.events.length, 3, 'every accepted save is audited');
});
