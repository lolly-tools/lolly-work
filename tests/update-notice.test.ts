// SPDX-License-Identifier: MPL-2.0
/**
 * The release notice (server/src/updates): reading the chart repository index,
 * semver and channel selection, the settings and their environment forms, the
 * upgrade steps for each install route, the guarded check, and the two routes
 * with their permission.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import { compareSemver, newerReleases, parseChartIndex, parseSemver, readChanges } from '../server/src/updates/feed.ts';
import { DEFAULT_FEED_URL, resolveUpdateSettings, type UpdateSettings } from '../server/src/updates/settings.ts';
import { repositoryUrl, upgradeSteps } from '../server/src/updates/steps.ts';
import { createUpdateChecker, feedNetworkPolicy } from '../server/src/updates/checker.ts';
import { parseChartIndexOffThread } from '../server/src/updates/feed-thread.ts';
import { updatesView } from '../server/src/updates/routes.ts';
import { parseConfig, DEFAULTS } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

const FIXTURE = readFileSync(new URL('./fixtures/update-feed/index.yaml', import.meta.url), 'utf8');
const NETWORK = { allowedPrivateOrigins: [], redirectOrigins: [], maxBytes: 64 * 1024 * 1024 };
const PUBLIC = async () => ['140.82.121.4'];
const RELEASE: UpdateSettings['release'] = { name: 'lolly-work', namespace: 'lolly', fullname: 'lolly-work', chartVersion: '1.2.0' };

const settings = (over: Partial<UpdateSettings> = {}): UpdateSettings => ({
  check: true, channel: 'stable', feedUrl: DEFAULT_FEED_URL, route: 'helm', release: RELEASE, ...over,
});

// ── the feed ────────────────────────────────────────────────────────────────

test('the chart index gives each release its version, date, security, migrations, notes and highlights', () => {
  const releases = parseChartIndex(FIXTURE);
  assert.deepEqual(releases.map(r => r.version), ['1.4.0-rc.1', '1.3.1', '1.3.0', '1.2.0', '1.1.3'],
    'newest first; the deprecated entry, the other chart and the version with a shell command in it are left out');
  const fix = releases.find(r => r.version === '1.3.1')!;
  assert.equal(fix.security, true);
  assert.equal(fix.migrations, 2);
  assert.deepEqual(fix.migrationClasses, { additive: 2, maintenance: 0 });
  assert.equal(fix.notesUrl, 'https://github.com/lolly-tools/lolly-work/releases/tag/v1.3.1');
  assert.equal(fix.created, '2026-12-02T10:15:00.000Z');
  assert.equal(fix.prerelease, false);
  assert.deepEqual(fix.changes.map(c => c.kind), ['security', 'added', 'fixed']);
  const plain = releases.find(r => r.version === '1.3.0')!;
  assert.equal(plain.security, false);
  assert.equal(plain.migrations, 0);
  assert.equal(plain.notesUrl, null, 'a javascript: URL is never kept');
  assert.equal(plain.changes[1]!.kind, 'changed', 'an unknown kind reads as a change');
  const rc = releases.find(r => r.version === '1.4.0-rc.1')!;
  assert.equal(rc.prerelease, true);
  assert.deepEqual(rc.changes.map(c => c.description), ['Partner programmes can share a folder of templates.', 'Plain-string changes are read too.']);
  const old = releases.find(r => r.version === '1.2.0')!;
  assert.equal(old.migrations, null, 'a release published before the annotation does not say');
  assert.equal(old.migrationClasses, null);
});

test('an index that is not a Helm repository index, or not YAML, is refused', () => {
  assert.throws(() => parseChartIndex('apiVersion: v1\nentries: {}\n'), { code: 'invalid' });
  assert.throws(() => parseChartIndex('{ not yaml'), { code: 'invalid' });
  assert.throws(() => parseChartIndex('<html>sign in</html>'), { code: 'invalid' });
  // An alias bomb is refused before it expands.
  assert.throws(() => parseChartIndex('a: &a [x]\nb: *a\napiVersion: v1\nentries: { lolly-work: [] }\n'), { code: 'invalid' });
});

test('highlights are plain, bounded single lines', () => {
  const long = 'x'.repeat(600);
  const [one, two] = readChanges(`- kind: Added\n  description: "two\\nlines\\u202e reversed"\n- description: ${long}\n`);
  assert.equal(one!.kind, 'added');
  assert.equal(one!.description, 'two lines reversed');
  assert.ok(two!.description.length <= 400 && two!.description.endsWith('…'));
  assert.deepEqual(readChanges('not a list'), []);
  assert.equal(readChanges(Array.from({ length: 40 }, (_, i) => `- change ${i}`).join('\n')).length, 25);
});

test('semver precedence follows the spec, pre-releases included', () => {
  const order = ['1.0.0-alpha', '1.0.0-alpha.1', '1.0.0-alpha.beta', '1.0.0-beta', '1.0.0-beta.2', '1.0.0-beta.11', '1.0.0-rc.1', '1.0.0', '1.0.1', '1.2.0', '1.10.0', '2.0.0'];
  for (let i = 1; i < order.length; i++) {
    assert.equal(compareSemver(parseSemver(order[i - 1])!, parseSemver(order[i])!), -1, `${order[i - 1]} < ${order[i]}`);
  }
  assert.equal(compareSemver(parseSemver('1.2.0+build.1')!, parseSemver('1.2.0')!), 0);
  for (const bad of ['v1.2.0', '1.2', '01.2.0', '1.2.0-', '1.2.0;id', '', '1.2.0 ']) assert.equal(parseSemver(bad), null, bad);
  // Numeric identifiers past Number's precision still order exactly.
  assert.equal(compareSemver(parseSemver('1.2.0-9007199254740992')!, parseSemver('1.2.0-9007199254740993')!), -1);
  assert.equal(compareSemver(parseSemver('1.2.0-99999999999999999999')!, parseSemver('1.2.0-100000000000000000000')!), -1);
});

test('stable skips pre-releases, preview includes them, and only newer releases count', () => {
  const releases = parseChartIndex(FIXTURE);
  assert.deepEqual(newerReleases(releases, '1.2.0', 'stable').map(r => r.version), ['1.3.1', '1.3.0']);
  assert.deepEqual(newerReleases(releases, '1.2.0', 'preview').map(r => r.version), ['1.4.0-rc.1', '1.3.1', '1.3.0']);
  assert.deepEqual(newerReleases(releases, '1.3.1', 'stable'), []);
  assert.deepEqual(newerReleases(releases, '1.4.0-rc.0', 'stable'), [], 'a preview server sees no older stable release');
  assert.deepEqual(newerReleases(releases, 'unknown', 'preview'), [], 'an unreadable version has nothing to compare with');
});

// ── settings ────────────────────────────────────────────────────────────────

test('settings: defaults, environment forms, and either one can turn the check off', () => {
  const cfg = { updates: DEFAULTS.updates, install: DEFAULTS.install };
  const d = resolveUpdateSettings(cfg, {});
  assert.deepEqual({ check: d.check, channel: d.channel, feedUrl: d.feedUrl, route: d.route }, { check: true, channel: 'stable', feedUrl: DEFAULT_FEED_URL, route: 'other' });
  const env = resolveUpdateSettings(cfg, {
    LW_UPDATES_CHANNEL: 'preview', LW_UPDATES_FEED_URL: 'https://charts.internal.example/lolly/index.yaml', LW_INSTALL_ROUTE: 'rancher',
    LW_RELEASE_NAME: 'work', LW_RELEASE_NAMESPACE: 'brand', LW_RELEASE_FULLNAME: 'work-lolly-work', LW_CHART_VERSION: '1.2.0',
  });
  assert.equal(env.channel, 'preview');
  assert.equal(env.route, 'rancher');
  assert.equal(env.feedUrl, 'https://charts.internal.example/lolly/index.yaml');
  assert.deepEqual(env.release, { name: 'work', namespace: 'brand', fullname: 'work-lolly-work', chartVersion: '1.2.0' });
  assert.equal(resolveUpdateSettings(cfg, { LW_UPDATES_CHECK: 'false' }).check, false);
  assert.equal(resolveUpdateSettings({ ...cfg, updates: { ...cfg.updates, check: false } }, { LW_UPDATES_CHECK: 'true' }).check, false, 'off in instance.json stays off');
  for (const [name, value] of [['LW_UPDATES_CHECK', 'maybe'], ['LW_UPDATES_CHANNEL', 'nightly'], ['LW_INSTALL_ROUTE', 'kustomize'],
    ['LW_UPDATES_FEED_URL', 'http://charts.example/index.yaml'], ['LW_UPDATES_FEED_URL', 'https://user:pw@charts.example/index.yaml']]) {
    assert.throws(() => resolveUpdateSettings(cfg, { [name!]: value }), new RegExp(name!), `${name}=${value}`);
  }
  const odd = resolveUpdateSettings(cfg, { LW_RELEASE_NAME: 'Work; rm -rf /', LW_RELEASE_NAMESPACE: '$(id)', LW_RELEASE_FULLNAME: 'a'.repeat(64) });
  assert.deepEqual(odd.release, { name: null, namespace: null, fullname: null, chartVersion: null }, 'a value that is not a Kubernetes name is left out');
});

test('instance.json: updates and install are checked at load', () => {
  const base = { instance: { name: 'T', baseUrl: 'http://localhost', pack: './packs/demo' }, dev: { enabled: true } };
  const ok = parseConfig(JSON.stringify({ ...base, updates: { channel: 'preview', feedUrl: 'http://127.0.0.1:9000/index.yaml' }, install: { route: 'argocd' } }));
  assert.deepEqual(ok.updates, { check: true, channel: 'preview', feedUrl: 'http://127.0.0.1:9000/index.yaml' });
  assert.equal(ok.install.route, 'argocd');
  for (const [over, message] of [
    [{ updates: { check: 'yes' } }, /updates.check/], [{ updates: { channel: 'beta' } }, /updates.channel/],
    [{ updates: { feedUrl: 'ftp://x/index.yaml' } }, /updates.feedUrl/], [{ updates: { interval: 3 } }, /updates.interval/],
    [{ install: { route: 'manual' } }, /install.route/],
  ] as const) assert.throws(() => parseConfig(JSON.stringify({ ...base, ...over })), message);
});

// ── upgrade steps ───────────────────────────────────────────────────────────

const ctx = { version: '1.3.1', release: RELEASE, repoUrl: repositoryUrl(DEFAULT_FEED_URL), migrates: true as boolean | null };
const commands = (route: Parameters<typeof upgradeSteps>[0], c = ctx) => upgradeSteps(route, c).map(s => s.command ?? '').join('\n');

test('helm: update the repository, check the signature, upgrade with -f, then the Job and the rollout', () => {
  const steps = upgradeSteps('helm', ctx);
  assert.deepEqual(steps.map(s => s.id), ['backup', 'repo-update', 'verify', 'upgrade', 'migration-job', 'rollout', 'accept']);
  assert.match(steps[0]!.detail, /migrates the database/);
  assert.deepEqual(steps[0]!.doc, { page: 'operations', anchor: 'backup-and-restore' });
  const all = commands('helm');
  assert.match(all, /^helm repo update lolly-work$/m);
  assert.match(all, /^helm upgrade lolly-work lolly-work\/lolly-work -n lolly --version 1\.3\.1 -f <your-values\.yaml>$/m);
  assert.doesNotMatch(all, /--reuse-values/, 'the command never reuses values');
  assert.match(steps.find(s => s.id === 'upgrade')!.detail, /--reuse-values replaces the new chart’s defaults/);
  assert.match(all, /cosign verify-blob --bundle lolly-work-1\.3\.1\.tgz\.sigstore\.json/);
  assert.match(all, /--certificate-identity https:\/\/github\.com\/lolly-tools\/lolly-work\/\.github\/workflows\/publish-helm\.yml@refs\/heads\/main/);
  assert.match(all, /releases\/download\/chart-v1\.3\.1\/lolly-work-1\.3\.1\.tgz$/m);
  assert.match(all, /^kubectl -n lolly logs job\/lolly-work-migrate$/m);
  assert.match(all, /^kubectl -n lolly rollout status deploy\/lolly-work$/m);
  assert.equal(steps.find(s => s.id === 'verify')!.optional, true);
});

test('rancher, fleet and argocd: the repository once, then the app or the Git change', () => {
  const rancher = upgradeSteps('rancher', ctx);
  assert.equal(rancher.find(s => s.id === 'repository')!.command, 'https://github.com/lolly-tools/lolly-work/releases/download/helm-index');
  assert.match(rancher.find(s => s.id === 'upgrade')!.detail, /Apps > Installed Apps > lolly-work in namespace lolly, choose Upgrade, then version 1\.3\.1/);
  assert.match(commands('fleet'), /^helm:\n {2}chart: lolly-work\n {2}repo: https:\/\/github\.com\/lolly-tools\/lolly-work\/releases\/download\/helm-index\n {2}version: 1\.3\.1$/m);
  assert.match(commands('argocd'), /^ {4}targetRevision: 1\.3\.1$/m);
  for (const route of ['fleet', 'argocd'] as const) assert.doesNotMatch(commands(route), /helm upgrade/, `${route} changes Git, not the cluster`);
  assert.match(commands('other'), /helm upgrade/);
});

test('steps show placeholders for what is not known and refuse a version that is not semver', () => {
  const unknown = { ...ctx, release: { name: null, namespace: null, fullname: null, chartVersion: null }, repoUrl: null, migrates: null };
  assert.match(commands('helm', unknown), /^helm upgrade <release> lolly-work\/lolly-work -n <namespace> --version 1\.3\.1/m);
  assert.match(commands('helm', unknown), /rollout status deploy\/<deployment>$/m);
  assert.match(upgradeSteps('helm', unknown)[0]!.detail, /does not say whether it migrates/);
  assert.equal(upgradeSteps('rancher', unknown).find(s => s.id === 'repository')!.command, '<chart repository URL>');
  assert.deepEqual(upgradeSteps('helm', { ...ctx, version: '1.3.1;id' }), []);
  assert.deepEqual(upgradeSteps('helm', { ...ctx, version: '$(id)' }), []);
  assert.equal(repositoryUrl('https://charts.example/x/index.yaml?token=1'), null, 'a query is not shown as a repository');
});

// ── the check ───────────────────────────────────────────────────────────────

function feedFetch(body: string | (() => Response), seen: string[] = []): typeof fetch {
  return (async (input: string | URL | Request) => {
    seen.push(String(input instanceof Request ? input.url : input));
    return typeof body === 'function' ? body() : new Response(body, { status: 200, headers: { 'content-type': 'application/octet-stream' } });
  }) as typeof fetch;
}

test('a check reads the feed through the egress guard and keeps the answer; a failure keeps it too and logs once', async () => {
  const logs: string[] = [];
  let answer: () => Response = () => new Response(FIXTURE, { status: 200 });
  let time = 1_000_000;
  const checker = createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: feedFetch(() => answer()), resolver: PUBLIC, log: (_l, m) => logs.push(m), now: () => time });
  assert.equal(checker.snapshot().status, 'never');
  const first = await checker.checkNow();
  assert.equal(first.status, 'ok');
  assert.deepEqual(first.newer.map(r => r.version), ['1.3.1', '1.3.0']);
  assert.equal(first.checkedAt, new Date(1_000_000).toISOString());
  answer = () => new Response('nope', { status: 503 });
  time += 10_000;
  assert.equal((await checker.checkNow()).status, 'ok', 'within the cooldown the answer comes from memory');
  time += 60_000;
  const failed = await checker.checkNow();
  assert.equal(failed.status, 'failed');
  assert.equal(failed.error, 'status');
  assert.deepEqual(failed.newer.map(r => r.version), ['1.3.1', '1.3.0'], 'the last good answer stays');
  time += 60_000;
  answer = () => new Response('<html>', { status: 200 });
  assert.equal((await checker.checkNow()).error, 'invalid');
  assert.equal(logs.filter(l => /could not be read/.test(l)).length, 1, 'logged once when it starts failing');
});

test('the guard: public addresses only, the feed origin may be private, redirects only to the GitHub asset hosts', async () => {
  const policy = feedNetworkPolicy(settings(), NETWORK);
  assert.deepEqual(policy.redirectOrigins, ['https://release-assets.githubusercontent.com', 'https://objects.githubusercontent.com']);
  assert.ok(policy.allowedPrivateOrigins.includes('https://github.com'));
  assert.deepEqual(feedNetworkPolicy(settings({ feedUrl: 'https://charts.internal.example/index.yaml' }), NETWORK).redirectOrigins, [],
    'a mirror gets no GitHub redirect allowance');

  const hops: string[] = [];
  const redirecting = (target: string) => (async (input: string | URL | Request) => {
    const url = String(input instanceof Request ? input.url : input);
    hops.push(url);
    return url === DEFAULT_FEED_URL ? new Response(null, { status: 302, headers: { location: target } }) : new Response(FIXTURE, { status: 200 });
  }) as typeof fetch;
  const ok = createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: redirecting('https://release-assets.githubusercontent.com/github-production-release-asset/1?sig=x'), resolver: PUBLIC });
  assert.equal((await ok.checkNow()).status, 'ok');
  assert.equal(hops.length, 2);

  const elsewhere = createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: redirecting('https://attacker.example/index.yaml'), resolver: PUBLIC });
  assert.equal((await elsewhere.checkNow()).error, 'redirect');

  const metadata = createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: redirecting('https://release-assets.githubusercontent.com/x'), resolver: async (host) => host === 'github.com' ? ['140.82.121.4'] : ['169.254.169.254'] });
  assert.equal((await metadata.checkNow()).error, 'refused', 'a redirect target on a private address is refused');

  const mirror = createUpdateChecker({ settings: settings({ feedUrl: 'https://charts.internal.example/index.yaml' }), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: feedFetch(FIXTURE), resolver: async () => ['10.0.4.2'] });
  assert.equal((await mirror.checkNow()).status, 'ok', 'the configured mirror may sit on a private address');

  const big = createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK,
    fetchImpl: feedFetch(() => new Response('x', { status: 200, headers: { 'content-length': String(5 * 1024 * 1024) } })), resolver: PUBLIC });
  assert.ok(['too-large', 'invalid'].includes(String((await big.checkNow()).error)));
});

test('the request carries nothing about the instance: no cookie, no user agent, no version', async () => {
  let headers: Headers | undefined;
  const capture = (async (_input: unknown, init?: RequestInit) => { headers = new Headers(init?.headers); return new Response(FIXTURE); }) as typeof fetch;
  await createUpdateChecker({ settings: settings(), currentVersion: '1.2.0', network: NETWORK, fetchImpl: capture, resolver: PUBLIC }).checkNow();
  assert.ok(headers);
  assert.deepEqual([...headers.keys()].sort(), ['accept']);
});

test('off: no timer, no request, and the snapshot says so', async () => {
  const seen: string[] = [];
  const checker = createUpdateChecker({ settings: settings({ check: false }), currentVersion: '1.2.0', network: NETWORK, fetchImpl: feedFetch(FIXTURE, seen), resolver: PUBLIC });
  checker.start();
  assert.equal((await checker.checkNow()).status, 'off');
  assert.deepEqual(seen, []);
  checker.stop();
});

test('every newer release counts toward the warnings, not only the ones listed', () => {
  // 1.0.1 migrates and fixes a vulnerability; twenty quieter releases follow it.
  const entries = Array.from({ length: 21 }, (_, i) => ({
    name: 'lolly-work', version: `1.0.${i + 1}`,
    annotations: i === 0
      ? { 'artifacthub.io/containsSecurityUpdates': 'true', 'lolly.tools/migrations': '3', 'lolly.tools/migration-classes': 'additive=3,maintenance=0' }
      : { 'lolly.tools/migrations': '0', 'lolly.tools/migration-classes': 'additive=0,maintenance=0' },
  }));
  const releases = parseChartIndex(JSON.stringify({ apiVersion: 'v1', entries: { 'lolly-work': entries } }));
  assert.equal(newerReleases(releases, '1.0.0', 'stable').length, 21);
  const checker = { settings: settings(), snapshot: () => ({ status: 'ok', checkedAt: null, attemptedAt: null, error: null, current: '1.0.0', newer: newerReleases(releases, '1.0.0', 'stable') }) };
  const view = updatesView(checker as never) as Record<string, any>;
  assert.equal(view.releases.length, 20, 'the list is shortened');
  assert.equal(view.newer, 21);
  assert.equal(view.security, true, '1.0.1 is not listed, and still counts');
  assert.equal(view.migrates, true);
  assert.equal(view.migrationCount, 3);
  assert.equal(view.feed, 'https://github.com', 'the feed shows as its origin only');
  assert.ok(!JSON.stringify(view).includes('index.yaml'), 'never the full feed address');
});

test('the feed is parsed off the main thread, within a deadline', async () => {
  assert.deepEqual((await parseChartIndexOffThread(FIXTURE)).map(r => r.version), parseChartIndex(FIXTURE).map(r => r.version));
  // A large mapping of valid YAML: the main thread keeps answering while it parses.
  const big = `apiVersion: v1\nentries:\n  lolly-work: []\nx:\n${Array.from({ length: 100_000 }, (_, i) => `  k${i}: ${i}`).join('\n')}\n`;
  let ticks = 0;
  const tick = setInterval(() => { ticks++; }, 5);
  await parseChartIndexOffThread(big, { deadlineMs: 20_000 });
  clearInterval(tick);
  assert.ok(ticks > 3, `the event loop kept turning (${ticks} ticks)`);
  await assert.rejects(parseChartIndexOffThread(big, { deadlineMs: 5 }), { code: 'too-slow' });
  await assert.rejects(parseChartIndexOffThread('apiVersion: v1\nentries: { other: [] }\n'), { code: 'invalid' });
  await assert.rejects(parseChartIndexOffThread('{ not yaml'), { code: 'invalid' });
});

// ── the routes ──────────────────────────────────────────────────────────────

const servers: Server[] = [];
after(() => { for (const s of servers) s.close(); });

async function boot(env: NodeJS.ProcessEnv = {}, seen: string[] = []) {
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Release Hub', baseUrl: 'http://localhost', pack: './packs/demo' },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [
      { email: 'owner@test', groups: ['owner'] }, { email: 'admin@test', groups: ['admin'] }, { email: 'maker@test', groups: ['member'] },
    ] },
  }));
  const app = buildApp({ config, store: createMemoryStore(), blobs: createMemoryBlobStore(), secrets: { session: 'sU', link: 'lU' },
    fetchImpl: feedFetch(FIXTURE, seen), providerResolver: PUBLIC, workVersion: '1.2.0',
    updatesEnv: { LW_INSTALL_ROUTE: 'helm', LW_RELEASE_NAME: 'lolly-work', LW_RELEASE_NAMESPACE: 'lolly', LW_RELEASE_FULLNAME: 'lolly-work', LW_CHART_VERSION: '1.2.0', ...env } });
  const server = createServer((req, res) => void app(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  const addr = server.address();
  return `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}`;
}

async function login(base: string, email: string): Promise<string> {
  const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
  return (res.headers.getSetCookie().find((c) => c.startsWith('lw_session=')) as string).split(';')[0] as string;
}

test('owners and admins read the notice and ask for a check; members and anonymous callers are refused', async () => {
  const seen: string[] = [];
  const base = await boot({}, seen);
  const owner = await login(base, 'owner@test'), admin = await login(base, 'admin@test'), member = await login(base, 'maker@test');
  const same = { origin: 'http://localhost' };

  const before = await (await fetch(`${base}/api/v1/admin/updates`, { headers: { cookie: admin } })).json() as any;
  assert.equal(before.status, 'never');
  assert.deepEqual(before.releases, []);
  assert.deepEqual(seen, [], 'reading the notice never reaches the network');

  const checked = await fetch(`${base}/api/v1/admin/updates/check`, { method: 'POST', headers: { cookie: owner, ...same } });
  assert.equal(checked.status, 200);
  assert.match(String(checked.headers.get('cache-control')), /no-store/);
  const body = await checked.json() as any;
  assert.deepEqual(seen, [DEFAULT_FEED_URL]);
  assert.equal(body.status, 'ok');
  assert.deepEqual(body.current, { version: '1.2.0', chartVersion: '1.2.0' });
  assert.equal(body.feed, 'https://github.com');
  assert.equal(body.feedUrl, undefined);
  assert.equal(body.latest, '1.3.1');
  assert.deepEqual(body.releases.map((r: { version: string }) => r.version), ['1.3.1', '1.3.0']);
  assert.equal(body.security, true);
  assert.equal(body.migrates, true);
  assert.deepEqual(body.releases[0].migrationClasses, { additive: 2, maintenance: 0 });
  assert.deepEqual(body.install, { route: 'helm', release: 'lolly-work', namespace: 'lolly', deployment: 'lolly-work', repository: 'https://github.com/lolly-tools/lolly-work/releases/download/helm-index' });
  assert.ok(body.checkedAt);
  assert.ok(body.steps.some((s: { command?: string }) => s.command === 'helm upgrade lolly-work lolly-work/lolly-work -n lolly --version 1.3.1 -f <your-values.yaml>'));

  const adminView = await (await fetch(`${base}/api/v1/admin/updates`, { headers: { cookie: admin } })).json() as any;
  assert.equal(adminView.latest, '1.3.1');

  for (const [cookie, status] of [[member, 403], [null, 401]] as const) {
    const headers = { ...(cookie ? { cookie } : {}), ...same };
    assert.equal((await fetch(`${base}/api/v1/admin/updates`, { headers })).status, status);
    assert.equal((await fetch(`${base}/api/v1/admin/updates/check`, { method: 'POST', headers })).status, status);
  }
  assert.equal(seen.length, 1, 'refused callers caused no request');
});

test('with checks off the routes answer, and a check is refused without a request', async () => {
  const seen: string[] = [];
  const base = await boot({ LW_UPDATES_CHECK: 'false' }, seen);
  const owner = await login(base, 'owner@test');
  const view = await (await fetch(`${base}/api/v1/admin/updates`, { headers: { cookie: owner } })).json() as any;
  assert.equal(view.check, false);
  assert.equal(view.status, 'off');
  const res = await fetch(`${base}/api/v1/admin/updates/check`, { method: 'POST', headers: { cookie: owner, origin: 'http://localhost' } });
  assert.equal(res.status, 409);
  assert.equal((await res.json() as any).error.code, 'UPDATES_OFF');
  assert.deepEqual(seen, []);
});
