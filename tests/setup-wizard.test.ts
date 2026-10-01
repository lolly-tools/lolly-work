// SPDX-License-Identifier: MPL-2.0
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { createSign, generateKeyPairSync, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';
import { parseConfig } from '../server/src/config/instance.ts';
import { generateSetup, mergeSetupPatch, setupDraft, setupSettingsHash } from '../server/src/setup/configuration.ts';
import { testIdentityDiscovery } from '../server/src/setup/identity.ts';
import { roleFromGroups } from '../server/src/rbac/evaluate.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { buildApp } from '../server/src/api/app.ts';
import type { RenderRunner } from '../server/src/renders/runner.ts';

const mapping = { owner: ['Customer Owners', 'owner'], admin: ['Customer Admins'], approver: ['Legal, EMEA'], author: [], member: [], viewer: ['Read Only'] };
const configured = () => parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' },
  instance: { name: 'Customer', baseUrl: 'https://work.test' },
  idp: { issuer: 'https://idp.test', clientId: 'customer', roleGroups: mapping },
  dev: { enabled: true, users: [{ email: 'bootstrap@test', groups: ['owner'] }] },
}));

test('role mapping keeps legacy defaults, supports exact customer groups and applies a highest-role fallback', () => {
  assert.equal(roleFromGroups(['owner']), 'owner'); assert.equal(roleFromGroups(['viewer']), 'member');
  assert.equal(roleFromGroups(['Read Only'], mapping), 'viewer');
  assert.equal(roleFromGroups(['Read Only', 'Legal, EMEA', 'Customer Owners'], mapping), 'owner');
  assert.equal(roleFromGroups(['unmapped'], mapping), 'member');
  assert.equal(roleFromGroups(['owner'], { owner: [] }), 'member');
  for (const roleGroups of [{ owner: ['x'], admin: ['x'] }, { owner: ['admin'] }, { owner: ['*'] }, { owner: [' x'] }, { owner: ['x\ny'] }, { guest: ['x'] }, { owner: 'x' }, { owner: [''] }, JSON.parse('{"__proto__":{"owner":["Evil"]}}')]) {
    assert.throws(() => parseConfig(JSON.stringify({ idp: { roleGroups } })), /roleGroups/);
  }
});

test('generated configuration preserves advanced settings, excludes secrets and matches the applied projection', () => {
  const config = configured(); config.idp.additional = [{ id: 'subsidiary', issuer: 'https://other.test', clientId: 'other', displayName: 'Other', groupsClaim: 'roles', claimMap: config.idp.claimMap, clientSecretRef: 'OTHER_SECRET' }];
  const original = JSON.stringify(config);
  const draft = setupDraft(config, ['Customer Owners']); draft.name = 'New name'; draft.workerUrl = 'http://renderer:9090';
  const proposal = generateSetup(draft, config);
  const next = parseConfig(JSON.stringify(mergeSetupPatch(config as unknown as Record<string, unknown>, proposal.patch)));
  assert.deepEqual(next.idp.additional, config.idp.additional); assert.equal(next.policy.sessionTtlHours, config.policy.sessionTtlHours);
  assert.equal(JSON.stringify(config), original);
  assert.equal(setupSettingsHash(setupDraft(next)), proposal.expectedSettingsHash);
  assert.equal(next.instance.name, 'New name'); assert.ok(proposal.requiredEnvironment.includes('LW_RENDER_WORKER_SECRET'));
  assert.doesNotMatch(JSON.stringify(proposal), /clientSecretRef|OTHER_SECRET|dev.users/);
  assert.deepEqual(proposal.ownerPreview.groups, ['Customer Owners']);
});

test('assistant rejects unsafe endpoints, ambiguous mappings and loss of the evaluation owner', () => {
  const config = configured();
  const fails = (changes: Record<string, unknown>, pattern: RegExp) => assert.throws(() => generateSetup({ ...setupDraft(config, ['Customer Owners']), ...changes }, config), pattern);
  fails({ workerUrl: 'https://token:secret@worker.test' }, /without credentials/);
  fails({ issuer: 'https://idp.test?token=private' }, /without credentials/);
  fails({ roleGroups: { owner: ['Customer Owners'] } }, /existing development owner/);
  fails({ ownerTestGroups: ['Read Only'] }, /do not map to owner/);
  fails({ mode: 'production', keepDevelopmentLogin: true }, /development login disabled/);
  fails({ application: 'web', appUrl: '', shellDir: '' }, /served shell path/);
  fails({ constructor: 'unsupported' }, /fields provided/);
  const draft = setupDraft(config, ['Customer Owners']); draft.mode = 'production'; draft.keepDevelopmentLogin = false;
  config.policy.defaultAccessMode = 'open';
  assert.equal(generateSetup(draft, config).patch.policy.defaultAccessMode, 'gated');
});

test('offline apply validates first, preserves unrelated values, backs up and rejects changed artifacts', async () => {
  const root = await mkdtemp(join(tmpdir(), 'lw-apply-'));
  try {
    const config = configured(); const source = { ...config, deploymentNote: 'keep this' };
    const proposal = generateSetup({ ...setupDraft(config, ['Customer Owners']), name: 'Applied customer' }, config);
    const file = join(root, 'instance.json'), artifact = join(root, 'lolly-setup.json');
    await writeFile(file, JSON.stringify(source));
    await writeFile(artifact, JSON.stringify({ version: 1, settings: proposal.settings, expectedSettingsHash: proposal.expectedSettingsHash }));
    const run = (write = false) => spawnSync(process.execPath, ['scripts/apply-setup.ts', file, artifact, ...(write ? ['--write'] : [])], { encoding: 'utf8' });
    assert.equal(run().status, 0); assert.equal(JSON.parse(await readFile(file, 'utf8')).instance.name, 'Customer');
    const applied = run(true); assert.equal(applied.status, 0, applied.stderr);
    const next = JSON.parse(await readFile(file, 'utf8')); assert.equal(next.instance.name, 'Applied customer'); assert.equal(next.deploymentNote, 'keep this');
    assert.match(applied.stdout, /Backup:/);
    await writeFile(artifact, JSON.stringify({ version: 1, settings: proposal.settings, expectedSettingsHash: 'changed' }));
    assert.equal(run(true).status, 1); assert.equal(JSON.parse(await readFile(file, 'utf8')).instance.name, 'Applied customer');
  } finally { await rm(root, { recursive: true, force: true }); }
});

test('identity discovery is bounded, installed-only and reports safe failures', async () => {
  const config = configured();
  const doc = { issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' };
  let requested = '';
  const valid = await testIdentityDiscovery(config, (async (url, opts) => { requested = String(url); assert.equal(opts?.redirect, 'error'); assert.ok(opts?.signal); return Response.json(doc); }) as typeof fetch);
  assert.equal(valid.ok, true); assert.equal(requested, 'https://idp.test/.well-known/openid-configuration');
  for (const response of [Response.json({ ...doc, issuer: 'https://other.test' }), Response.json({ ...doc, jwks_uri: 'http://idp.test/jwks' }), new Response('x'.repeat(300 * 1024)), new Response('private-error', { status: 500 })]) {
    const result = await testIdentityDiscovery(config, (async () => response) as typeof fetch); assert.equal(result.ok, false); assert.doesNotMatch(result.message, /private-error|other.test/);
  }
  config.idp.issuer = ''; assert.equal((await testIdentityDiscovery(config)).ok, false);
});

async function samplePack() {
  const root = await mkdtemp(join(tmpdir(), 'lw-wizard-'));
  await mkdir(join(root, 'catalog', 'tools'), { recursive: true }); await mkdir(join(root, 'tools', 'card'), { recursive: true });
  await writeFile(join(root, 'catalog', 'tools', 'index.json'), JSON.stringify({ tools: [{ id: 'card', name: 'Customer card' }] }));
  await writeFile(join(root, 'tools', 'card', 'tool.json'), JSON.stringify({ id: 'card', name: 'Customer card', version: '1.0.0', engineVersion: '^1.0.0', status: 'official',
    render: { width: 100, height: 100, formats: ['svg', 'png'] }, inputs: [{ id: 'title', type: 'text', label: 'Title', default: 'Welcome' }] }));
  await writeFile(join(root, 'tools', 'card', 'template.html'), '<svg xmlns="http://www.w3.org/2000/svg" width="100" height="100"><rect width="100" height="100" fill="#fff"/><text x="5" y="50">{{title}}</text></svg>');
  return root;
}

test('an administrator provisions one identity, signs in as mapped owner and produces a governed verified sample', async () => {
  const root = await samplePack(), store = createMemoryStore(); const config = configured(); config.instance.pack = root;
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const jwk = { ...publicKey.export({ format: 'jwk' }), kid: 'setup-fixture', alg: 'RS256', use: 'sig' };
  let nonce = '', discoveryCount = 0, oidcGroups = ['Customer Owners'];
  const fetchImpl = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith('/.well-known/openid-configuration')) { discoveryCount++; return Response.json({ issuer: 'https://idp.test', authorization_endpoint: 'https://idp.test/authorize', token_endpoint: 'https://idp.test/token', jwks_uri: 'https://idp.test/jwks' }); }
    if (url.endsWith('/jwks')) return Response.json({ keys: [jwk] });
    if (url.endsWith('/token')) {
      const head = Buffer.from(JSON.stringify({ alg: 'RS256', kid: jwk.kid })).toString('base64url');
      const body = Buffer.from(JSON.stringify({ iss: 'https://idp.test', aud: 'customer', sub: 'customer-owner', nonce, exp: Math.floor(Date.now() / 1000) + 300, iat: Math.floor(Date.now() / 1000), email: 'real@test', groups: oidcGroups })).toString('base64url');
      const signature = createSign('sha256').update(`${head}.${body}`).sign(privateKey).toString('base64url');
      return Response.json({ id_token: `${head}.${body}.${signature}` });
    }
    throw new Error('PRIVATE provider detail');
  }) as typeof fetch;
  let runner: RenderRunner | undefined;
  const app = buildApp({ config, store, secrets: { session: 's'.repeat(32), link: 'l'.repeat(32), idpClientSecret: 'PRIVATE client secret' }, fetchImpl,
    onRenderRunner: value => { runner = value; value.start(); } });
  const server = createServer((req, res) => void app(req, res)); await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address(); assert.ok(address && typeof address === 'object'); const base = `http://127.0.0.1:${address.port}`;
  const call = (path: string, cookie: string, body?: unknown) => fetch(base + path, { headers: { cookie, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { method: 'POST', body: JSON.stringify(body) } : {}) });
  try {
    const bootstrap = (await fetch(base + '/api/auth/dev?email=bootstrap@test', { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
    assert.equal((await fetch(base + '/api/v1/system/setup/configuration')).status, 401);
    const projection = await (await call('/api/v1/system/setup/configuration', bootstrap)).json() as any;
    assert.doesNotMatch(JSON.stringify(projection), /PRIVATE|clientSecretRef/); assert.equal(projection.account.signIn, null);
    const cutover = { ...projection.settings, mode: 'production', keepDevelopmentLogin: false, ownerTestGroups: ['Customer Owners'] };
    assert.equal((await call('/api/v1/system/setup/configuration', bootstrap, cutover)).status, 400);
    const discovery = await fetch(base + '/api/v1/system/setup/identity-test', { method: 'POST', headers: { cookie: bootstrap } });
    assert.equal((await discovery.json() as any).ok, true); assert.equal(discoveryCount, 1);
    const minted = await (await call('/api/v1/scim/tokens', bootstrap, { idp: 'Customer' })).json() as any;
    const provision = await fetch(base + '/scim/v2/Users', { method: 'POST', headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ externalId: 'customer-owner', userName: 'real@test', active: true }) });
    assert.equal(provision.status, 201); const scimUser = await provision.json() as any;
    const start = await fetch(base + '/api/auth/login?returnTo=%2Fadmin%23%2Fsetup', { redirect: 'manual' });
    const authorize = new URL(start.headers.get('location')!); nonce = authorize.searchParams.get('nonce')!;
    const stateCookie = start.headers.getSetCookie().find(cookie => cookie.startsWith('lw_state='))!.split(';')[0]!;
    const callback = await fetch(`${base}/api/auth/callback?code=setup-code&state=${authorize.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: stateCookie } });
    assert.equal(callback.status, 302); assert.equal(callback.headers.get('location'), '/admin#/setup');
    const owner = callback.headers.getSetCookie().find(cookie => cookie.startsWith('lw_session='))!.split(';')[0]!;
    const current = await (await call('/api/v1/system/setup/configuration', owner)).json() as any;
    assert.equal(current.account.id, scimUser.id); assert.equal(current.account.role, 'owner'); assert.equal(current.account.signIn.provider, 'oidc'); assert.ok(current.account.provisioned);
    const correlation = await (await call('/api/v1/system/setup/account-test', owner, { sub: 'customer-owner' })).json() as any;
    assert.equal(correlation.account.id, scimUser.id);
    const preview = await call('/api/v1/system/setup/configuration', owner, cutover); assert.equal(preview.status, 200); assert.equal(preview.headers.get('cache-control'), 'no-store'); assert.equal(config.dev.enabled, true);
    await store.putOverlay({ toolId: 'card', version: 1, inputAccess: { title: [{ groups: ['*'], level: 'locked', value: 'Governed welcome' }] } });
    const metadata = await (await call('/api/v1/system/setup/tools/card', owner)).json() as any;
    assert.equal(metadata.inputs[0].access, 'locked'); assert.deepEqual(metadata.formats, ['svg', 'png']);
    assert.deepEqual(metadata.expectedDimensions, { widthPx: 100, heightPx: 100 });
    let result = await (await call('/api/v1/renders', owner, { toolId: 'card', format: 'svg', inputs: {}, verification: { profile: 'output-v1', ...metadata.expectedDimensions }, maxAttempts: 1 })).json() as any;
    const until = Date.now() + 10000;
    while (['queued', 'running'].includes(result.state) && Date.now() < until) { await new Promise(resolve => setTimeout(resolve, 30)); result = await (await call(result.statusUrl, owner)).json(); }
    assert.equal(result.state, 'succeeded', JSON.stringify(result.error));
    const bytes = Buffer.from(await (await call(result.output.url, owner)).arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), result.output.sha256); assert.match(bytes.toString(), /Governed welcome/);
    const evidence = await (await call(result.output.evidence.url, owner)).json() as any;
    assert.equal(evidence.evidence.outputSha256, result.output.sha256); assert.ok(evidence.evidence.inspection.checks.every((check: any) => check.state === 'pass'));
    await store.putGrant({ principal: `user:${scimUser.id}`, action: 'export.server', resource: '*', effect: 'deny' });
    assert.equal((await call('/api/v1/system/setup/tools/card', owner)).status, 403); assert.equal((await call(result.output.url, owner)).status, 403);
    const audit = await store.listAudit(); assert.doesNotMatch(JSON.stringify(audit), /PRIVATE client secret|setup-code|id_token/);
    const scim = (method: string, path: string, body: unknown) => fetch(`${base}/scim/v2/${path}`, { method, headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    assert.equal((await scim('POST', 'Groups', { displayName: 'Customer Admins', members: [{ value: scimUser.id }] })).status, 201);
    oidcGroups = [];
    const secondStart = await fetch(base + '/api/auth/login', { redirect: 'manual' });
    const secondAuthorize = new URL(secondStart.headers.get('location')!); nonce = secondAuthorize.searchParams.get('nonce')!;
    const secondCookie = secondStart.headers.getSetCookie().find(cookie => cookie.startsWith('lw_state='))!.split(';')[0]!;
    assert.equal((await fetch(`${base}/api/auth/callback?code=updated-groups&state=${secondAuthorize.searchParams.get('state')}`, { redirect: 'manual', headers: { cookie: secondCookie } })).status, 302);
    assert.equal((await (await call('/api/auth/session', owner)).json() as any).user.role, 'admin', 'existing session resolves the new IdP/local group union');
    assert.equal((await scim('PATCH', 'Groups/Customer%20Admins', { Operations: [{ op: 'remove', path: 'members' }] })).status, 200);
    assert.equal((await scim('POST', 'Groups', { displayName: 'Read Only', members: [{ value: scimUser.id }] })).status, 201);
    assert.equal((await (await call('/api/auth/session', owner)).json() as any).user.role, 'viewer', 'SCIM group change applies the customer mapping to the existing session');
    const disabled = await fetch(`${base}/scim/v2/Users/${scimUser.id}`, { method: 'PATCH', headers: { authorization: `Bearer ${minted.token}`, 'content-type': 'application/json' },
      body: JSON.stringify({ Operations: [{ op: 'replace', path: 'active', value: false }] }) });
    assert.equal(disabled.status, 200); assert.equal((await call('/api/v1/system/setup/configuration', owner)).status, 401);
  } finally { await runner?.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); await rm(root, { recursive: true, force: true }); }
});
