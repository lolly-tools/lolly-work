// SPDX-License-Identifier: MPL-2.0
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  ApprovalError, createRequest, canonicalRequest, requestDigest, runTitle, validateRequest, verifyPublicApproval,
  waitForPublicApproval, PUBLIC_REPOSITORY, WORKFLOW_PATH,
} from './approval.mjs';

const fixture = JSON.parse(readFileSync(new URL('./request.fixture.json', import.meta.url), 'utf8'));
const NOW = fixture.issuedAt + 60;
const BLOB = 'a'.repeat(40);
const HEAD = 'b'.repeat(40);
const NOW_OPTIONS = { now: () => NOW };
const clone = value => structuredClone(value);

function request(stage = 'source', maintenance = false) {
  return { ...clone(fixture), stage, maintenance, artifactSha256: stage === 'final' ? 'c'.repeat(64) : null };
}

function run(req = request(), patch = {}) {
  return { id: 7654321, path: WORKFLOW_PATH, event: 'workflow_dispatch', head_branch: 'main', head_sha: HEAD,
    repository: { full_name: PUBLIC_REPOSITORY }, head_repository: { full_name: PUBLIC_REPOSITORY }, actor: { login: 'ndftz' },
    triggering_actor: { login: 'ndftz' }, run_attempt: 1, display_title: runTitle(req), status: 'completed', conclusion: 'success',
    created_at: new Date(NOW * 1000).toISOString(), updated_at: new Date(NOW * 1000).toISOString(), ...patch };
}

function environment(name) {
  return { name, can_admins_bypass: false, protection_rules: [{ type: 'required_reviewers', prevent_self_review: false,
    reviewers: [{ type: 'User', reviewer: { login: 'ndftz' } }] }],
  deployment_branch_policy: { protected_branches: false, custom_branch_policies: true } };
}

function api(req = request(), edit = () => {}, selectedRun = run(req)) {
  const data = new Map();
  const base = `repos/${PUBLIC_REPOSITORY}`;
  data.set(`${base}/actions/runs/7654321`, selectedRun);
  data.set(`${base}/contents/${WORKFLOW_PATH}?ref=${HEAD}`, { type: 'file', path: WORKFLOW_PATH, sha: BLOB });
  data.set(`${base}/actions/runs/7654321/approvals`, [{ state: 'approved', user: { login: 'ndftz' },
    environments: [{ name: 'lolly-ing-signing' }, ...(req.stage === 'final' && req.maintenance ? [{ name: 'lolly-ing-maintenance' }] : [])] }]);
  for (const name of ['lolly-ing-signing', 'lolly-ing-maintenance']) {
    data.set(`${base}/environments/${name}`, environment(name));
    data.set(`${base}/environments/${name}/deployment-branch-policies?per_page=100`, { total_count: 1, branch_policies: [{ name: 'main', type: 'branch' }] });
  }
  data.set(`${base}/actions/workflows/lolly-ing-approval.yml/runs?event=workflow_dispatch&branch=main&per_page=100`, { workflow_runs: [selectedRun] });
  edit(data);
  const calls = [];
  return { data, calls, options: { ...NOW_OPTIONS, workflowBlob: BLOB, apiJSON: async path => {
    calls.push(path);
    assert.ok(data.has(path), `Unexpected API path ${path}`);
    return clone(data.get(path));
  } } };
}

const code = expected => error => error instanceof ApprovalError && error.code === expected;

test('the request digest has a stable cross-language canonical vector', () => {
  const reordered = Object.fromEntries(Object.entries(fixture).reverse());
  assert.equal(canonicalRequest(fixture), canonicalRequest(reordered));
  assert.equal(requestDigest(fixture), '4a31d228babbdaa309740f7ea14da11f471578112a082ee9ccd396956f5e40c1');
  assert.ok(canonicalRequest(fixture).startsWith('{"artifactSha256":null,'));
  assert.ok(!canonicalRequest(fixture).endsWith('\n'));
});

test('request creation seeds a fresh nonce and four-hour lifetime', () => {
  const spec = clone(fixture);
  for (const field of ['nonce', 'issuedAt', 'expiresAt', 'version']) delete spec[field];
  const first = createRequest(spec, NOW_OPTIONS);
  const second = createRequest(spec, NOW_OPTIONS);
  assert.equal(first.issuedAt, NOW);
  assert.equal(first.expiresAt, NOW + 14400);
  assert.match(first.nonce, /^[a-f0-9]{64}$/);
  assert.notEqual(first.nonce, second.nonce);
  assert.notEqual(requestDigest(first), requestDigest(second));
});

test('strict request shape refuses hidden fields, invalid bindings and lifetimes', () => {
  const patches = [
    r => { r.extra = 'x'; }, r => { r.privateRun.extra = 'x'; }, r => { r.privateRun.attempt = 2; },
    r => { r.privateRun.id = 123; }, r => { r.privateRun.repository = 'another/repo'; },
    r => { r.sources.suse = 'a'.repeat(40); }, r => { r.pinThumbprint = 'bad'; },
    r => { r.buildBlobs['.github/../secret'] = BLOB; }, r => { r.buildBlobs = {}; },
    r => { r.artifactSha256 = 'a'.repeat(64); }, r => { r.maintenance = 'false'; },
    r => { r.nonce = ''; }, r => { r.minSeq = '1; bad'; }, r => { r.expiresAt = r.issuedAt + 14401; },
  ];
  for (const patch of patches) {
    const req = request(); patch(req);
    assert.throws(() => validateRequest(req, NOW_OPTIONS), code('REQUEST_INVALID'));
  }
  assert.throws(() => validateRequest({ ...request(), expiresAt: NOW }, NOW_OPTIONS), code('REQUEST_EXPIRED'));
  assert.throws(() => validateRequest({ ...request(), issuedAt: NOW + 61, expiresAt: NOW + 3600 }, NOW_OPTIONS), code('REQUEST_EXPIRED'));
  assert.throws(() => validateRequest({ ...request('final'), artifactSha256: null }, NOW_OPTIONS), code('REQUEST_INVALID'));
  assert.equal(validateRequest({ ...request(), minSeq: String(Number.MAX_SAFE_INTEGER) }, NOW_OPTIONS).minSeq, '9007199254740991');
  assert.throws(() => validateRequest({ ...request(), minSeq: '9007199254740992' }, NOW_OPTIONS), code('REQUEST_INVALID'));
});

test('a successful run requires the exact gate code, rules and an actual human approval', async () => {
  const req = request();
  const fixtureApi = api(req);
  const evidence = await verifyPublicApproval(req, '7654321', fixtureApi.options);
  assert.deepEqual(evidence.run, { id: '7654321', attempt: 1 });
  assert.equal(evidence.requestSha256, requestDigest(req));
  assert.equal(evidence.approver, 'ndftz');
  assert.equal(evidence.publicRun.repository, PUBLIC_REPOSITORY);
  assert.equal(evidence.maintenanceApproval, null);
  assert.ok(fixtureApi.calls.some(path => path.endsWith('/approvals')));
  assert.ok(fixtureApi.calls.some(path => path.includes('/deployment-branch-policies')));
});

test('a final maintenance approval is required independently of signing approval', async () => {
  const req = request('final', true);
  const { options } = api(req);
  const evidence = await verifyPublicApproval(req, run(req), options);
  assert.deepEqual(evidence.maintenanceApproval, { run: '7654321', approver: 'ndftz', environment: 'lolly-ing-maintenance' });
  const bad = api(req, data => data.get(`repos/${PUBLIC_REPOSITORY}/actions/runs/7654321/approvals`)[0].environments.pop());
  await assert.rejects(verifyPublicApproval(req, run(req), bad.options), code('APPROVAL_MISSING'));
});

test('a same-source request cannot reuse another nonce, stage, artifact or private run', async () => {
  const req = request();
  const oldRun = run(req);
  for (const mutate of [
    r => { r.nonce = '9'.repeat(64); }, r => { r.privateRun.id = '999'; },
    r => { r.stage = 'final'; r.artifactSha256 = 'd'.repeat(64); },
    r => { r.migrationManifest = '1'.repeat(64); }, r => { r.minSeq = '3'; },
  ]) {
    const changed = request(); mutate(changed);
    await assert.rejects(verifyPublicApproval(changed, oldRun, api(changed).options), code('APPROVAL_NOT_BOUND'));
  }
});

test('different repositories, events, branches, actors and reruns are refused', async () => {
  for (const patch of [
    { path: 'another.yml' }, { event: 'push' }, { head_branch: 'feature' }, { head_sha: 'bad' },
    { repository: { full_name: 'another/repo' } }, { head_repository: { full_name: 'another/repo' } },
    { actor: { login: 'someone' } }, { triggering_actor: { login: 'someone' } }, { run_attempt: 2 },
    { created_at: new Date((fixture.issuedAt - 61) * 1000).toISOString() },
    { updated_at: new Date((fixture.expiresAt + 1) * 1000).toISOString() },
  ]) {
    await assert.rejects(verifyPublicApproval(request(), run(request(), patch), api().options), code('APPROVAL_NOT_BOUND'));
  }
});

test('workflow success, rejection, bypass and changed code do not substitute for approval', async () => {
  const base = `repos/${PUBLIC_REPOSITORY}`;
  for (const history of [[], [{ state: 'rejected', user: { login: 'ndftz' }, environments: [{ name: 'lolly-ing-signing' }] }],
    [{ state: 'approved', user: { login: 'someone' }, environments: [{ name: 'lolly-ing-signing' }] }]]) {
    const f = api(request(), data => data.set(`${base}/actions/runs/7654321/approvals`, history));
    await assert.rejects(verifyPublicApproval(request(), run(), f.options), code('APPROVAL_MISSING'));
  }
  await assert.rejects(verifyPublicApproval(request(), run(request(), { conclusion: 'failure' }), api().options), code('APPROVAL_REJECTED'));
  const changed = api(request(), data => { data.get(`${base}/contents/${WORKFLOW_PATH}?ref=${HEAD}`).sha = 'f'.repeat(40); });
  await assert.rejects(verifyPublicApproval(request(), run(), changed.options), code('APPROVAL_CODE_CHANGED'));
  await assert.rejects(verifyPublicApproval(request(), run(), { ...api().options, workflowBlob: undefined }), code('APPROVAL_ANCHOR'));
});

test('environment rules must require only ndftz with bypass off and main as the only branch', async () => {
  const base = `repos/${PUBLIC_REPOSITORY}/environments/lolly-ing-signing`;
  for (const edit of [
    data => { data.get(base).can_admins_bypass = true; },
    data => { data.get(base).protection_rules = []; },
    data => { data.get(base).protection_rules[0].prevent_self_review = true; },
    data => { data.get(base).protection_rules[0].reviewers.push({ type: 'User', reviewer: { login: 'someone' } }); },
    data => { data.get(base).protection_rules[0].reviewers[0].type = 'Team'; },
    data => { data.get(base).deployment_branch_policy.custom_branch_policies = false; },
    data => { data.get(`${base}/deployment-branch-policies?per_page=100`).branch_policies[0].name = '*'; },
    data => { data.get(`${base}/deployment-branch-policies?per_page=100`).branch_policies[0].type = 'tag'; },
    data => { data.get(`${base}/deployment-branch-policies?per_page=100`).total_count = 2; },
  ]) {
    await assert.rejects(verifyPublicApproval(request(), run(), api(request(), edit).options), code('APPROVAL_POLICY'));
  }
});

test('waiting discovers one matching run and refuses duplicates or an unapproved conclusion', async () => {
  const f = api();
  const evidence = await waitForPublicApproval(request(), { ...f.options, timeoutSeconds: 10 });
  assert.equal(evidence.run.id, '7654321');
  const listingPath = `repos/${PUBLIC_REPOSITORY}/actions/workflows/lolly-ing-approval.yml/runs?event=workflow_dispatch&branch=main&per_page=100`;
  f.data.get(listingPath).workflow_runs.push(run(request(), { id: 7654322 }));
  await assert.rejects(waitForPublicApproval(request(), f.options), code('APPROVAL_AMBIGUOUS'));
  const failed = api(request(), () => {}, run(request(), { conclusion: 'cancelled' }));
  await assert.rejects(waitForPublicApproval(request(), failed.options), code('APPROVAL_REJECTED'));
});

test('waiting is bounded and rate limits never turn into an accepted gate', async () => {
  let clock = 0;
  const timing = { ...NOW_OPTIONS, workflowBlob: BLOB, timeoutSeconds: 120, monotonic: () => clock,
    sleep: async seconds => { clock += seconds; } };
  await assert.rejects(waitForPublicApproval(request(), { ...timing, apiJSON: async () => ({ workflow_runs: [] }) }), code('APPROVAL_TIMEOUT'));
  clock = 0;
  await assert.rejects(waitForPublicApproval(request(), { ...timing, apiJSON: async () => {
    throw new ApprovalError('GITHUB_RATE_LIMIT', 'limited', 180);
  } }), code('APPROVAL_TIMEOUT'));
  let calls = 0;
  clock = 0;
  const f = api();
  const evidence = await waitForPublicApproval(request(), { ...f.options, ...timing, apiJSON: async path => {
    if (calls++ === 0) throw new ApprovalError('GITHUB_RATE_LIMIT', 'limited', 1);
    return f.options.apiJSON(path);
  } });
  assert.equal(evidence.run.id, '7654321');
  assert.equal(clock, 60);
});

test('HTTP transport is anonymous, refuses redirects, limits bodies and does not leak API body text', async () => {
  let observed;
  const options = { ...NOW_OPTIONS, workflowBlob: BLOB, fetch: async (url, init) => {
    observed = { url, init };
    return new Response('private failure body', { status: 403 });
  } };
  await assert.rejects(verifyPublicApproval(request(), '7654321', options), error => error.code === 'GITHUB_FAILED' && !error.message.includes('private failure'));
  assert.equal(observed.init.headers.Authorization, undefined);
  assert.equal(observed.init.redirect, 'error');
  assert.ok(observed.init.signal instanceof AbortSignal);
  const tooBig = { ...options, fetch: async () => new Response('x'.repeat(1024 * 1024 + 1)) };
  await assert.rejects(verifyPublicApproval(request(), '7654321', tooBig), code('GITHUB_FAILED'));
  const limited = { ...options, fetch: async () => new Response('', { status: 429, headers: { 'retry-after': '7' } }) };
  await assert.rejects(verifyPublicApproval(request(), '7654321', limited), error => error.code === 'GITHUB_RATE_LIMIT' && error.retrySeconds === 7);
});

test('the request CLI writes mode 0600 and refuses to overwrite a private file', () => {
  const dir = mkdtempSync(join(tmpdir(), 'lolly-approval-test-'));
  try {
    const spec = request();
    for (const key of ['nonce', 'issuedAt', 'expiresAt']) delete spec[key];
    writeFileSync(join(dir, 'spec.json'), JSON.stringify(spec));
    const args = [new URL('./approval.mjs', import.meta.url).pathname, 'request', '--spec', join(dir, 'spec.json'), '--out', join(dir, 'request.json')];
    const first = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr);
    assert.equal(statSync(join(dir, 'request.json')).mode & 0o777, 0o600);
    assert.equal(JSON.parse(first.stdout).requestSha256, requestDigest(JSON.parse(readFileSync(join(dir, 'request.json'), 'utf8'))));
    const original = readFileSync(join(dir, 'request.json'), 'utf8');
    const again = spawnSync(process.execPath, args, { encoding: 'utf8' });
    assert.equal(again.status, 1);
    assert.equal(readFileSync(join(dir, 'request.json'), 'utf8'), original);
    assert.ok(!again.stderr.includes(original));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the public workflow has no secret, private checkout, upload or arbitrary command input', () => {
  const source = readFileSync(new URL('../../../.github/workflows/lolly-ing-approval.yml', import.meta.url), 'utf8');
  assert.ok(source.includes('permissions: {}'));
  assert.ok(source.includes('environment: lolly-ing-signing'));
  assert.ok(source.includes('environment: lolly-ing-maintenance'));
  assert.ok(source.includes("github.run_attempt == 1"));
  assert.ok(!/secrets\.|uses:|actions\/upload|repository_dispatch|curl|fetch\(/.test(source));
  const scripts = [...source.matchAll(/node --input-type=module - <<'JS'\n([\s\S]*?)\n          JS/g)].map(match => match[1].replace(/^          /gm, ''));
  assert.equal(scripts.length, 2);
  const digest = '1'.repeat(64);
  for (const [env, success] of [
    [{ REQUEST_SHA256: digest, STAGE: 'source', MAINTENANCE: 'false' }, true],
    [{ REQUEST_SHA256: digest, STAGE: 'final', MAINTENANCE: 'true' }, true],
    [{ REQUEST_SHA256: '$(secret)', STAGE: 'source', MAINTENANCE: 'false' }, false],
    [{ REQUEST_SHA256: digest, STAGE: 'source', MAINTENANCE: 'true' }, false],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', scripts[0]], { encoding: 'utf8', env });
    assert.equal(result.status === 0, success, result.stderr);
  }
  for (const [env, success] of [
    [{ VALIDATE: 'success', SIGNING: 'success', MAINTENANCE_RESULT: 'skipped', STAGE: 'source', MAINTENANCE: 'false' }, true],
    [{ VALIDATE: 'success', SIGNING: 'success', MAINTENANCE_RESULT: 'success', STAGE: 'final', MAINTENANCE: 'true' }, true],
    [{ VALIDATE: 'skipped', SIGNING: 'skipped', MAINTENANCE_RESULT: 'skipped', STAGE: 'source', MAINTENANCE: 'false' }, false],
    [{ VALIDATE: 'success', SIGNING: 'success', MAINTENANCE_RESULT: 'skipped', STAGE: 'final', MAINTENANCE: 'true' }, false],
  ]) {
    const result = spawnSync(process.execPath, ['--input-type=module', '-e', scripts[1]], { encoding: 'utf8', env });
    assert.equal(result.status === 0, success, result.stderr);
  }
});
