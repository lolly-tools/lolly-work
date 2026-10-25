// SPDX-License-Identifier: MPL-2.0
// Public GitHub approval checks shared by private CI and the operator's tests.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const PUBLIC_REPOSITORY = 'lolly-tools/lolly-work';
export const WORKFLOW_PATH = '.github/workflows/lolly-ing-approval.yml';
export const REVIEWER = 'ndftz';
export const SIGNING_ENVIRONMENT = 'lolly-ing-signing';
export const MAINTENANCE_ENVIRONMENT = 'lolly-ing-maintenance';
export const REQUEST_PREFIX = 'lolly.ing approval request v1\n';
export const MAX_TTL_SECONDS = 4 * 60 * 60;
const MAX_BODY_BYTES = 1024 * 1024;
const SHA = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const ID = /^[1-9][0-9]{0,19}$/;
const THUMBPRINT = /^[A-Za-z0-9_-]{43}$/;
const KEYS = ['version', 'stage', 'privateRun', 'sources', 'pinThumbprint', 'buildBlobs', 'migrationManifest',
  'maintenance', 'minSeq', 'artifactSha256', 'nonce', 'issuedAt', 'expiresAt'];

export class ApprovalError extends Error {
  constructor(code, message, retrySeconds = 0) {
    super(message);
    this.name = 'ApprovalError';
    this.code = code;
    this.retrySeconds = retrySeconds;
  }
}

function requireValue(value, code, message) {
  if (!value) throw new ApprovalError(code, message);
}

function plain(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value) &&
    [Object.prototype, null].includes(Object.getPrototypeOf(value));
}

function exactKeys(value, keys) {
  return plain(value) && JSON.stringify(Object.keys(value).sort()) === JSON.stringify([...keys].sort());
}

function nowSeconds(options) {
  return options.now === undefined ? Math.floor(Date.now() / 1000) : options.now();
}

export function validateRequest(request, options = {}) {
  const valid = exactKeys(request, KEYS) && request.version === 1 && ['source', 'final'].includes(request.stage) &&
    exactKeys(request.privateRun, ['repository', 'id', 'attempt', 'workflowSha']) &&
    request.privateRun.repository === 'lolly-tools/suse-lolly' && ID.test(request.privateRun.id) &&
    typeof request.privateRun.id === 'string' && request.privateRun.attempt === 1 && SHA.test(request.privateRun.workflowSha) &&
    exactKeys(request.sources, ['lolly', 'work', 'suse']) && Object.values(request.sources).every(v => typeof v === 'string' && SHA.test(v)) &&
    request.sources.suse === request.privateRun.workflowSha && typeof request.pinThumbprint === 'string' && THUMBPRINT.test(request.pinThumbprint) &&
    plain(request.buildBlobs) && Object.keys(request.buildBlobs).length > 0 && Object.keys(request.buildBlobs).length <= 16 &&
    Object.entries(request.buildBlobs).every(([path, sha]) => /^\.github\/[A-Za-z0-9_./-]{1,200}$/.test(path) &&
      !path.split('/').includes('..') && typeof sha === 'string' && SHA.test(sha)) &&
    typeof request.migrationManifest === 'string' && SHA256.test(request.migrationManifest) && typeof request.maintenance === 'boolean' &&
    typeof request.minSeq === 'string' && (request.minSeq === '' || /^(0|[1-9][0-9]{0,15})$/.test(request.minSeq) && Number.isSafeInteger(Number(request.minSeq))) &&
    (request.stage === 'source' ? request.artifactSha256 === null : typeof request.artifactSha256 === 'string' && SHA256.test(request.artifactSha256)) &&
    typeof request.nonce === 'string' && SHA256.test(request.nonce) && Number.isSafeInteger(request.issuedAt) && request.issuedAt > 0 &&
    Number.isSafeInteger(request.expiresAt) && request.expiresAt > request.issuedAt && request.expiresAt - request.issuedAt <= MAX_TTL_SECONDS;
  requireValue(valid, 'REQUEST_INVALID', 'The private approval request does not match version 1');
  if (options.checkTime !== false) {
    const now = nowSeconds(options);
    requireValue(request.issuedAt <= now + 60 && now < request.expiresAt, 'REQUEST_EXPIRED', 'The approval request is expired or issued in the future');
  }
  return request;
}

function sorted(value) {
  if (Array.isArray(value)) return value.map(sorted);
  if (!plain(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map(key => [key, sorted(value[key])]));
}

export function canonicalRequest(request) {
  validateRequest(request, { checkTime: false });
  return JSON.stringify(sorted(request));
}

export function requestDigest(request) {
  return createHash('sha256').update(REQUEST_PREFIX + canonicalRequest(request), 'utf8').digest('hex');
}

export function createRequest(spec, options = {}) {
  requireValue(plain(spec), 'REQUEST_INVALID', 'The request specification must be an object');
  const issuedAt = nowSeconds(options);
  const request = { version: 1, nonce: randomBytes(32).toString('hex'), issuedAt, expiresAt: issuedAt + MAX_TTL_SECONDS, ...spec };
  return validateRequest(request, options);
}

export function runTitle(request) {
  return `lolly.ing approval ${request.stage} ${requestDigest(request)}`;
}

function runId(value) {
  if (typeof value === 'number' && Number.isSafeInteger(value)) value = String(value);
  requireValue(typeof value === 'string' && ID.test(value), 'APPROVAL_NOT_BOUND', 'The public run id is invalid');
  return value;
}

function checkRun(run, request, options, completed) {
  requireValue(plain(run), 'APPROVAL_NOT_BOUND', 'The public run is unreadable');
  runId(run.id);
  requireValue(run.path === WORKFLOW_PATH && run.event === 'workflow_dispatch' && run.head_branch === 'main' &&
    SHA.test(run.head_sha) && run.repository?.full_name === PUBLIC_REPOSITORY && run.head_repository?.full_name === PUBLIC_REPOSITORY &&
    run.actor?.login === REVIEWER && run.triggering_actor?.login === REVIEWER && run.run_attempt === 1 &&
    run.display_title === runTitle(request), 'APPROVAL_NOT_BOUND', 'The public run does not bind to this approval request');
  const created = Date.parse(run.created_at) / 1000;
  const updated = Date.parse(run.updated_at) / 1000;
  requireValue(Number.isFinite(created) && created >= request.issuedAt - 60 && created <= request.expiresAt &&
    created <= nowSeconds(options) + 60 && Number.isFinite(updated) && updated >= created && updated <= request.expiresAt,
  'APPROVAL_NOT_BOUND', 'The public run is outside the request lifetime');
  if (completed) {
    requireValue(run.status === 'completed' && run.conclusion === 'success', 'APPROVAL_REJECTED', 'The public approval run did not succeed');
  }
  return run;
}

async function readBody(response) {
  const reader = response.body?.getReader();
  requireValue(reader, 'GITHUB_FAILED', 'GitHub returned no response body');
  const chunks = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      requireValue(length <= MAX_BODY_BYTES, 'GITHUB_FAILED', 'GitHub returned an oversized response');
      chunks.push(Buffer.from(value));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ApprovalError('GITHUB_FAILED', 'GitHub returned invalid JSON'); }
}

async function apiJSON(path, options) {
  const remaining = options.deadline === undefined ? 15 : options.deadline - options.monotonic();
  requireValue(remaining > 0, 'APPROVAL_TIMEOUT', 'The public approval check exhausted its wait budget');
  if (options.apiJSON) return options.apiJSON(path);
  const fetcher = options.fetch ?? globalThis.fetch;
  let response;
  try {
    response = await fetcher(`https://api.github.com/${path}`, {
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'lolly-ing-approval-verifier' },
      redirect: 'error', signal: AbortSignal.timeout(Math.max(1, Math.floor(Math.min(15, remaining) * 1000))),
    });
  } catch { throw new ApprovalError('GITHUB_FAILED', 'The public GitHub API request failed'); }
  if (response.status === 429 || response.status === 403 && (response.headers.get('x-ratelimit-remaining') === '0' || response.headers.has('retry-after'))) {
    const retry = Number(response.headers.get('retry-after'));
    const reset = Number(response.headers.get('x-ratelimit-reset')) - nowSeconds(options);
    throw new ApprovalError('GITHUB_RATE_LIMIT', 'The public GitHub API rate limit was reached', Math.max(1, Number.isFinite(retry) && retry > 0 ? retry : Number.isFinite(reset) && reset > 0 ? reset : 60));
  }
  requireValue(response.status === 200, 'GITHUB_FAILED', `The public GitHub API returned HTTP ${response.status}`);
  return readBody(response);
}

function approvalEnvironments(request) {
  return request.stage === 'final' && request.maintenance ? [SIGNING_ENVIRONMENT, MAINTENANCE_ENVIRONMENT] : [SIGNING_ENVIRONMENT];
}

async function verifyEnvironment(name, options) {
  const base = `repos/${PUBLIC_REPOSITORY}/environments/${encodeURIComponent(name)}`;
  const env = await apiJSON(base, options);
  const required = (env.protection_rules ?? []).filter(rule => rule.type === 'required_reviewers');
  requireValue(env.name === name && env.can_admins_bypass === false && required.length === 1 && required[0].prevent_self_review === false &&
    Array.isArray(required[0].reviewers) && required[0].reviewers.length === 1 && required[0].reviewers[0].type === 'User' &&
    required[0].reviewers[0].reviewer?.login === REVIEWER && env.deployment_branch_policy?.protected_branches === false &&
    env.deployment_branch_policy?.custom_branch_policies === true,
  'APPROVAL_POLICY', 'The public approval environment does not have the reviewed rules');
  const branches = await apiJSON(`${base}/deployment-branch-policies?per_page=100`, options);
  requireValue(branches.total_count === 1 && Array.isArray(branches.branch_policies) && branches.branch_policies.length === 1 &&
    branches.branch_policies[0].name === 'main' && branches.branch_policies[0].type === 'branch',
  'APPROVAL_POLICY', 'The public approval environment permits another deployment branch or tag');
}

export async function verifyPublicApproval(request, runOrId, options = {}) {
  validateRequest(request, options);
  requireValue(typeof options.workflowBlob === 'string' && SHA.test(options.workflowBlob), 'APPROVAL_ANCHOR', 'The public workflow blob is not pinned');
  const run = typeof runOrId === 'object' ? runOrId : await apiJSON(`repos/${PUBLIC_REPOSITORY}/actions/runs/${runId(runOrId)}`, options);
  checkRun(run, request, options, true);
  const blob = await apiJSON(`repos/${PUBLIC_REPOSITORY}/contents/${WORKFLOW_PATH}?ref=${run.head_sha}`, options);
  requireValue(blob.type === 'file' && blob.path === WORKFLOW_PATH && blob.sha === options.workflowBlob,
    'APPROVAL_CODE_CHANGED', 'The public gate workflow differs from its reviewed blob');
  const history = await apiJSON(`repos/${PUBLIC_REPOSITORY}/actions/runs/${runId(run.id)}/approvals`, options);
  requireValue(Array.isArray(history), 'APPROVAL_MISSING', 'The public approval history is unreadable');
  for (const name of approvalEnvironments(request)) {
    requireValue(history.some(entry => entry.state === 'approved' && entry.user?.login === REVIEWER &&
      Array.isArray(entry.environments) && entry.environments.some(env => env.name === name)),
    'APPROVAL_MISSING', 'The public run has no required human approval');
    await verifyEnvironment(name, options);
  }
  validateRequest(request, options);
  const id = runId(run.id);
  return { version: 1, requestSha256: requestDigest(request), stage: request.stage, run: { id, attempt: 1 },
    publicRun: { repository: PUBLIC_REPOSITORY, id, attempt: 1, workflowSha: run.head_sha }, approver: REVIEWER,
    maintenanceApproval: request.stage === 'final' && request.maintenance ? { run: id, approver: REVIEWER, environment: MAINTENANCE_ENVIRONMENT } : null };
}

export async function waitForPublicApproval(request, options = {}) {
  validateRequest(request, options);
  const timeout = options.timeoutSeconds ?? 1800;
  requireValue(Number.isFinite(timeout) && timeout > 0 && timeout <= 1800, 'BAD_INPUT', 'The approval wait must be at most 1800 seconds');
  const clock = options.monotonic ?? (() => performance.now() / 1000);
  const sleep = options.sleep ?? (seconds => new Promise(resolve => setTimeout(resolve, seconds * 1000)));
  const deadline = clock() + timeout;
  const bounded = { ...options, deadline, monotonic: clock };
  for (;;) {
    validateRequest(request, options);
    requireValue(clock() < deadline, 'APPROVAL_TIMEOUT', 'The human approval did not arrive within the wait budget');
    try {
      const listing = await apiJSON(`repos/${PUBLIC_REPOSITORY}/actions/workflows/lolly-ing-approval.yml/runs?event=workflow_dispatch&branch=main&per_page=100`, bounded);
      requireValue(Array.isArray(listing.workflow_runs), 'GITHUB_FAILED', 'The public workflow listing is unreadable');
      const matches = listing.workflow_runs.filter(run => run.display_title === runTitle(request));
      requireValue(matches.length <= 1, 'APPROVAL_AMBIGUOUS', 'Multiple public approval runs match this private request');
      if (matches.length === 1) {
        checkRun(matches[0], request, options, false);
        if (matches[0].status === 'completed') {
          const evidence = await verifyPublicApproval(request, matches[0], bounded);
          requireValue(clock() <= deadline, 'APPROVAL_TIMEOUT', 'The public approval verification exhausted its wait budget');
          return evidence;
        }
      }
    } catch (error) {
      if (!(error instanceof ApprovalError) || error.code !== 'GITHUB_RATE_LIMIT') throw error;
      const remaining = deadline - clock();
      requireValue(remaining > error.retrySeconds, 'APPROVAL_TIMEOUT', 'GitHub rate limiting exceeds the approval wait');
      await sleep(Math.max(60, error.retrySeconds));
      continue;
    }
    const remaining = deadline - clock();
    requireValue(remaining > 0, 'APPROVAL_TIMEOUT', 'The human approval did not arrive within the wait budget');
    await sleep(Math.min(60, remaining));
  }
}

function privateJSON(path, value) {
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
}

function readJSON(path) {
  const bytes = readFileSync(path);
  requireValue(bytes.length <= 64 * 1024, 'BAD_INPUT', 'The private JSON input is too large');
  return JSON.parse(bytes.toString('utf8'));
}

export async function main(argv) {
  const [command, ...args] = argv;
  const values = {};
  for (let i = 0; i < args.length; i += 2) {
    requireValue(['--spec', '--request', '--workflow-blob', '--out', '--timeout-seconds'].includes(args[i]) &&
      values[args[i]] === undefined && typeof args[i + 1] === 'string' && !args[i + 1].startsWith('--'), 'BAD_INPUT', 'Unknown, repeated or incomplete CLI argument');
    values[args[i]] = args[i + 1];
  }
  if (command === 'request') {
    requireValue(Object.keys(values).length === 2 && values['--spec'] && values['--out'], 'BAD_INPUT', 'request requires --spec and --out');
    const request = createRequest(readJSON(values['--spec']));
    privateJSON(values['--out'], request);
    console.log(JSON.stringify({ requestSha256: requestDigest(request), stage: request.stage }));
    return;
  }
  requireValue(command === 'wait' && values['--request'] && values['--workflow-blob'] && values['--out'] &&
    Object.keys(values).every(key => ['--request', '--workflow-blob', '--out', '--timeout-seconds'].includes(key)),
  'BAD_INPUT', 'wait requires --request, --workflow-blob and --out');
  const evidence = await waitForPublicApproval(readJSON(values['--request']), { workflowBlob: values['--workflow-blob'],
    timeoutSeconds: values['--timeout-seconds'] === undefined ? undefined : Number(values['--timeout-seconds']) });
  privateJSON(values['--out'], evidence);
  console.log(JSON.stringify(evidence));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).catch(error => {
    console.error(JSON.stringify({ result: 'REFUSED', code: error instanceof ApprovalError ? error.code : 'BAD_INPUT',
      message: error instanceof ApprovalError ? error.message : 'The approval command could not read or write its private input' }));
    process.exitCode = 1;
  });
}
