// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { parseConfig, loadSecrets } from '../server/src/config/instance.ts';
import { inspectPack } from '../server/src/setup/pack.ts';
import { assessSetup, startupChecks, productionMode } from '../server/src/setup/checks.ts';
import { consoleAccess } from '../server/src/setup/console-access.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import { createBrandService } from '../server/src/brand/service.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';

async function fixture(engineVersion = '^1.0.0', hooks = false) {
  const root = await mkdtemp(join(tmpdir(), 'lw-setup-'));
  await mkdir(join(root, 'catalog', 'tools'), { recursive: true });
  await mkdir(join(root, 'tools', 'card'), { recursive: true });
  await writeFile(join(root, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'card', name: 'Card' }] }));
  await writeFile(join(root, 'tools', 'card', 'tool.json'), JSON.stringify({ id: 'card', name: 'Card', version: '1.0.0', engineVersion, status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png', 'pdf'] }, inputs: [{ id: 'title', type: 'text', label: 'Title', default: 'Hello' }],
    ...(hooks ? { hooks: { onInit: true } } : {}) }));
  await writeFile(join(root, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>{{title}}</text></svg>');
  if (hooks) await writeFile(join(root, 'tools', 'card', 'hooks.js'), 'throw new Error("Inspection must never execute hooks");');
  return root;
}

test('pack inspection uses the installed engine, detects incompatible requirements and distinguishes server formats', async () => {
  const version = JSON.parse(readFileSync(new URL('../engine-pin.json', import.meta.url), 'utf8')).engine.version;
  for (const [range, compatible] of [['^1.0.0', true], ['^999.0.0', false]] as const) {
    const root = await fixture(range);
    try {
      const report = await inspectPack(root);
      assert.equal(report.engine, version); assert.equal(report.compatible, compatible);
      assert.equal(report.tools[0]?.requiredEngine, range);
      if (compatible) {
        assert.deepEqual(report.tools[0]?.serverFormats, ['svg', 'png']); assert.ok(report.tools[0]?.unavailableFormats.includes('pdf'));
        await writeFile(join(root, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><text>Changed</text></svg>');
        const changed = await inspectPack(root); assert.notEqual(changed.revision, report.revision); assert.notEqual(changed.tools[0]?.sourceHash, report.tools[0]?.sourceHash);
      }
      else assert.ok(report.tools[0]!.diagnostics.join(' ').includes(`engine ${range} against installed ${version}`));
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('hooked tools are inspected without executing code and require a worker when server rendering is mandatory', async () => {
  const root = await fixture('^1.0.0', true);
  try {
    assert.equal((await inspectPack(root)).compatible, true);
    assert.equal((await inspectPack(root, { requireServerRendering: true })).compatible, false);
    const workered = await inspectPack(root, { workerConfigured: true, requireServerRendering: true });
    assert.equal(workered.compatible, true); assert.deepEqual(workered.tools[0]?.serverFormats, ['svg', 'png', 'pdf']);
    const curated = await inspectPack(root, { allowHooksInFastPath: true, requireServerRendering: true });
    assert.equal(curated.compatible, true); assert.deepEqual(curated.tools[0]?.serverFormats, ['svg', 'png']);
    assert.match(curated.tools[0]!.diagnostics.join(' '), /application process/);
    await rm(join(root, 'tools', 'card', 'template.html'));
    assert.equal((await inspectPack(root)).compatible, false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('an HTML-only template is advertised as server renderable only when a worker can lay it out', async () => {
  const root = await fixture();
  try {
    await writeFile(join(root, 'tools', 'card', 'template.html'), '<html><body>{{title}}</body></html>');
    const local = await inspectPack(root, {});
    assert.equal(local.compatible, true); assert.deepEqual(local.tools[0]?.serverFormats, []);
    assert.ok(local.tools[0]?.diagnostics.includes('This tool needs a Chromium worker for server rendering.'));
    assert.equal((await inspectPack(root, { requireServerRendering: true })).compatible, false);
    const workered = await inspectPack(root, { workerConfigured: true, requireServerRendering: true });
    assert.equal(workered.compatible, true); assert.deepEqual(workered.tools[0]?.serverFormats, ['svg', 'png', 'pdf']);
  } finally { await rm(root, { recursive: true, force: true }); }
});

/** Write catalog files, keyed by their path under catalog/, plus an asset index over them. */
async function catalogWith(root: string, files: Record<string, string>, assets: unknown[]): Promise<void> {
  for (const [rel, bytes] of Object.entries(files)) {
    await mkdir(dirname(join(root, 'catalog', rel)), { recursive: true });
    await writeFile(join(root, 'catalog', rel), bytes);
  }
  await mkdir(join(root, 'catalog', 'assets'), { recursive: true });
  await writeFile(join(root, 'catalog', 'assets', 'index.json'), JSON.stringify({ version: '1', assets }));
}
const shaHex = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
const sri = (bytes: string) => `sha256-${createHash('sha256').update(bytes).digest('base64')}`;
const SHORT = shaHex('<svg/>').slice(0, 16);

test('a catalog path with two owners makes a pack incompatible and the report names the file and both ids', async () => {
  const cases: Array<{ name: string; files: Record<string, string>; assets: unknown[]; names: string[] }> = [
    { name: 'one file under two ids', names: ['assets/shared.jpg', 'lolly/demo/lorikeet', 'lolly/demo/sample-photo'],
      files: { 'assets/shared.jpg': 'jpg' }, assets: [
        { id: 'lolly/demo/lorikeet', formats: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] },
        { id: 'lolly/demo/sample-photo', formats: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] },
      ] },
    { name: 'a locale format', names: ['assets/shared.jpg', 'plain', 'localized'],
      files: { 'assets/shared.jpg': 'jpg' }, assets: [
        { id: 'plain', formats: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] },
        { id: 'localized', formats: [], locales: { de: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] } },
      ] },
    // Signed renditions in one folder: each address also claims renditions/out.webp.
    { name: 'addressed names that share a legacy name', names: ['renditions/out.webp', `renditions/out.${shaHex('two').slice(0, 16)}.webp`, 'first', 'second'],
      files: { [`renditions/out.${shaHex('one').slice(0, 16)}.webp`]: 'one', [`renditions/out.${shaHex('two').slice(0, 16)}.webp`]: 'two' }, assets: [
        { id: 'first', formats: [{ format: 'webp', url: `/catalog/renditions/out.${shaHex('one').slice(0, 16)}.webp`, checksum: sri('one') }] },
        { id: 'second', formats: [{ format: 'webp', url: `/catalog/renditions/out.${shaHex('two').slice(0, 16)}.webp`, checksum: sri('two') }] },
      ] },
    { name: 'an address claiming another asset\'s file', names: ['assets/a.svg', 'owner', 'other'],
      files: { 'assets/a.svg': '<svg/>', [`assets/a.${SHORT}.svg`]: '<svg/>' }, assets: [
        { id: 'owner', formats: [{ format: 'svg', url: '/catalog/assets/a.svg' }] },
        { id: 'other', formats: [{ format: 'svg', url: `/catalog/assets/a.${SHORT}.svg`, checksum: sri('<svg/>') }] },
      ] },
  ];
  for (const { name, files, assets, names } of cases) {
    const root = await fixture();
    try {
      await catalogWith(root, files, assets);
      const report = await inspectPack(root);
      assert.equal(report.compatible, false, name);
      assert.equal(report.tools[0]?.valid, true, `${name}: the tools still load`);
      const reason = report.diagnostics.join(' ');
      for (const expected of names) assert.ok(reason.includes(`"${expected}"`), `${name}: ${expected} in ${reason}`);
      assert.match(reason, /validate:catalog/, 'the reason says how to fix the pack');
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('the other refusals the blob route makes are reported the same way', async () => {
  const wrong = '0123456789abcdef';
  const cases: Array<{ files: Record<string, string>; assets: unknown[]; reason: RegExp }> = [
    { files: { [`assets/a.${wrong}.svg`]: '<svg/>' }, reason: new RegExp(`"assets/a\\.${wrong}\\.svg" on asset "a" does not match its checksum`),
      assets: [{ id: 'a', formats: [{ format: 'svg', url: `/catalog/assets/a.${wrong}.svg` }] }] },
    { files: { [`assets/a b.${SHORT}.svg`]: '<svg/>' }, reason: /unsafe catalog asset address "assets\/a b\.[0-9a-f]{16}\.svg" on asset "a"/,
      assets: [{ id: 'a', formats: [{ format: 'svg', url: `/catalog/assets/a b.${SHORT}.svg`, checksum: sri('<svg/>') }] }] },
  ];
  for (const { files, assets, reason } of cases) {
    const root = await fixture();
    try {
      await catalogWith(root, files, assets);
      const report = await inspectPack(root);
      assert.equal(report.compatible, false);
      assert.match(report.diagnostics.join(' '), reason);
    } finally { await rm(root, { recursive: true, force: true }); }
  }
});

test('one owner per path stays compatible, including addressed renditions under renditions/<id>/', async () => {
  const root = await fixture();
  try {
    // Identical bytes and identical file names, kept apart by the id in the folder.
    const rendition = (id: string) => ({ format: 'webp', url: `/catalog/renditions/${id}/out.${SHORT}.webp`, checksum: sri('<svg/>') });
    await catalogWith(root, {
      'renditions/lolly/demo/lorikeet/out.webp': '<svg/>', [`renditions/lolly/demo/lorikeet/out.${SHORT}.webp`]: '<svg/>',
      [`renditions/lolly/demo/sample-photo/out.${SHORT}.webp`]: '<svg/>',
      'assets/lorikeet.jpg': 'jpg', 'assets/sample-photo.jpg': 'jpg',
      'assets/logo.svg': '<svg/>', [`assets/logo.${SHORT}.svg`]: '<svg/>', [`assets/mark.${SHORT}.svg`]: '<svg/>',
    }, [
      { id: 'lolly/demo/lorikeet', formats: [{ format: 'jpg', url: '/catalog/assets/lorikeet.jpg' }, rendition('lolly/demo/lorikeet'),
        // One id may hold an addressed name and the plain name it also claims.
        { format: 'webp', url: '/catalog/renditions/lolly/demo/lorikeet/out.webp' }] },
      { id: 'lolly/demo/sample-photo', formats: [{ format: 'jpg', url: '/catalog/assets/sample-photo.jpg' }, rendition('lolly/demo/sample-photo')] },
      { id: 'lolly/logo', formats: [{ format: 'svg', url: `/catalog/assets/logo.${SHORT}.svg`, checksum: sri('<svg/>') }, { format: 'svg', url: '/catalog/assets/logo.svg' }],
        locales: { de: [{ format: 'svg', url: '/catalog/assets/logo.svg' }] } },
      // A format with no checksum gets one from its bytes, as the served index does.
      { id: 'lolly/mark', formats: [{ format: 'svg', url: `/catalog/assets/mark.${SHORT}.svg` }] },
    ]);
    const report = await inspectPack(root);
    assert.deepEqual(report.diagnostics, []);
    assert.equal(report.compatible, true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('a mounted pack with two owners for one path refuses a production boot, naming them, and only warns in evaluation', async () => {
  const root = await fixture();
  try {
    await catalogWith(root, { 'assets/shared.jpg': 'jpg' }, [
      { id: 'first', formats: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] },
      { id: 'second', formats: [{ format: 'jpg', url: '/catalog/assets/shared.jpg' }] },
    ]);
    const secrets = { session: 'a'.repeat(32), link: 'b'.repeat(32) };
    const evaluation = await assessSetup(parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, instance: { pack: root }, dev: { enabled: true } })), secrets, false);
    assert.equal(evaluation.checks.find(check => check.id === 'pack')?.status, 'warning');
    assert.equal(evaluation.ready, true);

    const config = parseConfig(JSON.stringify({ deployment: { mode: 'production', application: 'api' }, instance: { pack: root, baseUrl: 'https://work.test' }, idp: { issuer: 'https://idp.test', clientId: 'test' } }));
    const production = await assessSetup(config, secrets, true);
    assert.deepEqual(production.checks.filter(check => check.status === 'fail').map(check => check.id), ['pack']);
    assert.equal(production.ready, false);

    const path = join(root, 'instance.json'); await writeFile(path, JSON.stringify(config));
    const child = spawnSync(process.execPath, ['server/src/main.ts'], { encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: 'postgres://setup-check.invalid/none', LW_CONFIG: path, LW_SESSION_SECRET: secrets.session, LW_LINK_SECRET: secrets.link }, timeout: 60000 });
    assert.equal(child.status, 1);
    assert.match(child.stderr, /pack: .*"assets\/shared\.jpg" is claimed by assets "first" and "second"/);
    assert.match(child.stderr, /Production setup validation failed/);
    assert.doesNotMatch(child.stdout, /migrations applied/, 'the refusal comes before the database');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('production is explicit or inherited; evaluation remains explicit even inside a production container', () => {
  const cfg = (mode: string) => parseConfig(JSON.stringify({ deployment: { mode }, dev: { enabled: true } }));
  assert.equal(productionMode(cfg('production'), {}), true);
  assert.equal(productionMode(cfg('auto'), { NODE_ENV: 'production' }), true);
  assert.equal(productionMode(cfg('evaluation'), { NODE_ENV: 'production' }), false);
  assert.throws(() => loadSecrets({}, cfg('production')), /LW_SESSION_SECRET/);
  assert.ok(loadSecrets({ NODE_ENV: 'production' }, cfg('evaluation')).session);
  assert.throws(() => cfg('prod'), /deployment/);
});

test('production refuses evaluation storage, passwordless login, weak secrets and missing renderer credentials without exposing values', async () => {
  const root = await fixture();
  try {
    const config = parseConfig(JSON.stringify({ deployment: { mode: 'production' }, instance: { pack: root, baseUrl: 'https://work.test' },
      idp: { issuer: 'https://idp.test', clientId: 'test' }, dev: { enabled: true }, render: { worker: { url: 'https://worker.test' } } }));
    const secrets = { session: 'PRIVATE-SESSION', link: 'PRIVATE-LINK' };
    const report = await assessSetup(config, secrets, false);
    for (const id of ['storage', 'development-login', 'session-secret', 'link-secret', 'renderer-secret']) assert.equal(report.checks.find(check => check.id === id)?.status, 'fail');
    assert.equal(report.ready, false); assert.equal(JSON.stringify(report).includes('PRIVATE-'), false);
    const path = join(root, 'instance.json'); await writeFile(path, JSON.stringify(config));
    const child = spawnSync(process.execPath, ['server/src/main.ts'], { encoding: 'utf8',
      env: { ...process.env, DATABASE_URL: '', LW_CONFIG: path, LW_SESSION_SECRET: 'a'.repeat(32), LW_LINK_SECRET: 'b'.repeat(32) }, timeout: 60000 });
    assert.equal(child.status, 1); assert.match(child.stderr, /storage:.*DATABASE_URL/);
    assert.doesNotMatch(child.stderr, new RegExp('a'.repeat(32)));
    const safe = parseConfig(JSON.stringify({ deployment: { mode: 'production', application: 'api' }, instance: { pack: root, baseUrl: 'https://work.test' }, idp: { issuer: 'https://idp.test', clientId: 'test' } }));
    assert.equal(startupChecks(safe, { session: 'a'.repeat(32), link: 'b'.repeat(32) }, true).some(check => check.status === 'fail'), false);
    assert.equal(startupChecks(safe, secrets, true).some(check => check.id === 'web-shell'), false);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('console capabilities follow explicit denies and delegated grants without duplicating client role rules', () => {
  const principal = { groups: ['brand'], role: 'member' as const };
  const access = consoleAccess(principal, [{ principal: 'group:brand', action: 'policy.edit', resource: '*', effect: 'allow' }]);
  assert.equal(access.views.tools, true); assert.equal(access.views.setup, false); assert.equal(access.views.users, false);
  const denied = consoleAccess({ groups: ['admin'], role: 'admin' }, [{ principal: '*', action: 'policy.edit', resource: '*', effect: 'deny' }]);
  assert.equal(denied.views.tools, false); assert.equal(denied.views.overview, true);
});

test('a source compatibility refusal prevents brand activation without changing the active state', async () => {
  const root = await fixture('^999.0.0');
  try {
    await writeFile(join(root, 'profiles.json'), JSON.stringify({ default: 'alpha', profiles: {
      alpha: { tools: ['tools'], catalog: 'catalog' }, beta: { tools: ['tools'], catalog: 'catalog' },
    } }));
    const config = parseConfig(JSON.stringify({ instance: { pack: root }, dev: { enabled: true } }));
    const store = createMemoryStore();
    const owner = await store.upsertUserBySub({ sub: 'owner', email: 'owner@test', groups: ['owner'], role: 'owner' });
    const service = createBrandService(config, store, createMemoryBlobStore(), { inspectSource: async source =>
      (await inspectPack(root, { source })).compatible ? [] : ['Incompatible engine requirement.'] });
    const change = { action: 'select' as const, sourceId: 'profile:beta' };
    const preview = await service.preview(owner, change);
    assert.ok(preview.blockers.includes('Incompatible engine requirement.'));
    await assert.rejects(service.apply(owner, change, preview.revision, preview.reviewToken), /Incompatible engine/);
    assert.equal((await service.snapshot()).source.id, 'profile:alpha');
    assert.equal((await store.getBrandState()).revision, 0);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('setup is owner gated, readiness describes the actual store, and a reviewer deny cannot act on an eligible chain', async () => {
  const root = await fixture();
  const store = createMemoryStore({ grants: [{ principal: 'group:approver', action: 'approval.act', resource: '*', effect: 'deny' }] });
  const config = parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, instance: { pack: root }, dev: { enabled: true,
    users: [{ email: 'owner@test', groups: ['owner'] }, { email: 'member@test', groups: ['member'] }, { email: 'reviewer@test', groups: ['approver'] }] } }));
  const app = buildApp({ config, store, secrets: { session: 'fixture-session', link: 'fixture-link' } });
  const server = createServer((req, res) => void app(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const login = async (email: string) => (await fetch(`${base}/api/auth/dev?email=${email}`, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
  try {
    const owner = await login('owner@test'); const member = await login('member@test'); const reviewer = await login('reviewer@test');
    assert.equal((await fetch(base + '/api/v1/system/setup', { headers: { cookie: member } })).status, 403);
    const report = await (await fetch(base + '/api/v1/system/setup', { headers: { cookie: owner } })).json() as any;
    assert.equal(report.mode, 'evaluation'); assert.equal(report.pack.compatible, true);
    assert.equal(report.checks.find((check: any) => check.id === 'identity-live').status, 'not-tested');
    const ready = await (await fetch(base + '/readyz')).json() as any; assert.equal(ready.store, 'memory');
    config.deployment.mode = 'production';
    const production = await fetch(base + '/readyz');
    assert.equal(production.status, 503);
    const held = (await production.json() as { checks: Record<string, string> }).checks;
    assert.deepEqual(Object.keys(held), ['store', 'migrations', 'setup', 'catalog', 'licenceGate'], 'production adds the migration and setup checks');
    assert.ok(Object.values(held).some((value) => value !== 'ok'), `a check names what holds readiness back: ${JSON.stringify(held)}`);
    assert.equal((await fetch(base + '/healthz')).status, 200);
    config.deployment.mode = 'evaluation';
    const access = await (await fetch(base + '/api/auth/session', { headers: { cookie: owner } })).json() as any;
    assert.equal(access.console.views.setup, true);
    const tokenResponse = await fetch(base + '/api/v1/tokens', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' }, body: JSON.stringify({ label: 'Canary', role: 'viewer' }) });
    assert.equal(tokenResponse.status, 201); assert.equal(tokenResponse.headers.get('cache-control'), 'private, no-store, max-age=0, no-transform');
    const token = await tokenResponse.json() as any;
    const listed = await (await fetch(base + '/api/v1/tokens', { headers: { cookie: owner } })).json() as any;
    assert.equal(JSON.stringify(listed).includes(token.token), false);
    assert.equal((await fetch(`${base}/api/v1/tokens/${token.id}`, { method: 'DELETE', headers: { cookie: owner } })).status, 200);
    await store.putChain({ id: 'brand', name: 'Brand', steps: [{ name: 'Review', approvers: { groups: ['approver'] }, rule: 'any' }], onReject: 'return-to-submitter' });
    const submission = await fetch(base + '/api/v1/approvals', { method: 'POST', headers: { cookie: member, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectType: 'tool-change', subjectRef: 'tool:card', title: 'Review', chainId: 'brand' }) });
    assert.equal(submission.status, 201); const approval = await submission.json() as any;
    const action = await fetch(`${base}/api/v1/approvals/${approval.id}/act`, { method: 'POST', headers: { cookie: reviewer, 'content-type': 'application/json' }, body: JSON.stringify({ action: 'approve' }) });
    assert.equal(action.status, 403); assert.equal((await store.getApproval(approval.id))?.state, approval.state);
    const reviewerInbox = await (await fetch(base + '/api/v1/approvals?inbox=1', { headers: { cookie: reviewer } })).json() as any;
    assert.equal(reviewerInbox.approvals.length, 0);
    const approvers = await (await fetch(base + '/api/v1/approvals/approvers?chainId=brand', { headers: { cookie: member } })).json() as any;
    assert.equal(approvers.approvers.length, 0);
    const reviewerSession = await (await fetch(base + '/api/auth/session', { headers: { cookie: reviewer } })).json() as any;
    const reviewerId = (await store.getUserBySub(reviewerSession.user.sub))!.id;
    const deniedNomination = await fetch(base + '/api/v1/approvals', { method: 'POST', headers: { cookie: member, 'content-type': 'application/json' },
      body: JSON.stringify({ subjectType: 'tool-change', title: 'Cannot nominate', chainId: 'brand', nominees: [reviewerId] }) });
    assert.equal(deniedNomination.status, 400);
    const preview = await fetch(base + '/api/v1/chains/preview', { method: 'POST', headers: { cookie: owner, 'content-type': 'application/json' },
      body: JSON.stringify({ id: 'brand', steps: [{ name: 'Review', approvers: { groups: ['approver'] }, rule: 'any' }] }) });
    assert.equal(preview.status, 200); assert.equal((await preview.json() as any).viable, false);
    for (let index = 0; index < 75; index++) await store.appendAudit({ at: new Date(2026, 0, 1).toISOString(), actor: 'system', action: index % 2 ? 'older.canary' : 'noise', subject: 'tool:card' });
    for (let index = 0; index < 75; index++) await store.appendAudit({ at: new Date(2026, 0, 2).toISOString(), actor: 'system', action: 'noise', subject: 'other' });
    const filtered = await (await fetch(base + '/api/v1/audit?action=older.canary&actor=system&limit=10', { headers: { cookie: owner } })).json() as any;
    assert.equal(filtered.matched, 37); assert.equal(filtered.events.length, 10);
    assert.ok(filtered.events.every((event: any) => event.action === 'older.canary'));
    const older = await (await fetch(`${base}/api/v1/audit?action=older.canary&actor=system&limit=100&before=${filtered.nextBefore}`, { headers: { cookie: owner } })).json() as any;
    assert.equal(older.events.length, 27); assert.equal(older.nextBefore, null);
    assert.equal((await fetch(base + '/api/v1/audit?since=broken', { headers: { cookie: owner } })).status, 400);
    assert.equal((await fetch(base + '/api/v1/audit?since=2026-02-01&until=2026-01-01', { headers: { cookie: owner } })).status, 400);
    store.ping = async () => false;
    assert.equal((await fetch(base + '/readyz')).status, 503); assert.equal((await fetch(base + '/healthz')).status, 200);
    store.pendingMigrations = async () => { throw new Error('PRIVATE database connection detail'); };
    const outageReport = await (await fetch(base + '/api/v1/system/setup', { headers: { cookie: owner } })).json() as any;
    assert.equal(outageReport.ready, false);
    assert.equal(outageReport.checks.find((check: any) => check.id === 'schema').status, 'fail');
    assert.equal(JSON.stringify(outageReport).includes('PRIVATE'), false);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});

test('the settings entry follows delegated settings permissions, including access tokens', () => {
  const principal = { groups: ['operators'], role: 'member' as const };
  const denies = ['catalog.read', 'policy.edit', 'catalog.injectable.manage', 'grant.edit', 'token.manage', 'scim.manage', 'instance.config']
    .map(action => ({ principal: '*', action, resource: '*', effect: 'deny' as const }));
  assert.equal(consoleAccess(principal, denies).views.instance, false);
  for (const action of ['token.manage', 'scim.manage', 'grant.edit']) {
    const access = consoleAccess(principal, [
      ...denies.filter(grant => grant.action !== action),
      { principal: 'group:operators', action, resource: '*', effect: 'allow' },
    ]);
    assert.equal(access.views.instance, true, `${action} needs a settings entry`);
    assert.equal(access.views.setup, false, 'the settings entry does not grant server setup');
  }
});
