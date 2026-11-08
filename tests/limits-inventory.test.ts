// SPDX-License-Identifier: MPL-2.0
/** The Limits and quotas inventory (plans/82 M7): every limit Work enforces, with its value and source, read from the enforcing constants. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DEFAULTS, parseConfig } from '../server/src/config/instance.ts';
import { RENDER_RUNNER_DEFAULTS } from '../server/src/renders/runner.ts';
import { createRouter, sendError } from '../server/src/api/router.ts';
import { TOKEN_LIMIT_KEYS, TOKEN_LIMIT_SEED } from '../server/src/iam/token-limits.ts';
import { EXIT_ROW_BOUND } from '../server/src/programmes/exit.ts';
import { REOPEN_DAYS } from '../server/src/programmes/reopen.ts';
import { limitsInventory, type LimitEntry } from '../server/src/observability/limits-inventory.ts';
import { registerLimitsRoute } from '../server/src/observability/limits-route.ts';

const configWith = (overrides: Record<string, unknown> = {}) => parseConfig(JSON.stringify({
  instance: { name: 'Limits Hub', baseUrl: 'http://localhost', pack: './packs/demo' },
  dev: { enabled: true },
  ...overrides,
}));
const byId = (limits: LimitEntry[], id: string): LimitEntry => {
  const found = limits.find((entry) => entry.id === id);
  assert.ok(found, `missing limit: ${id}`);
  return found;
};

test('limits have unique ids, plain labels, known sources and each area in order', () => {
  const limits = limitsInventory(configWith(), { env: {} });
  assert.equal(new Set(limits.map((entry) => entry.id)).size, limits.length);
  for (const entry of limits) {
    assert.ok(entry.id.trim());
    assert.ok(entry.label.trim(), entry.id);
    assert.ok(['configuration', 'environment', 'built-in'].includes(entry.source), entry.id);
  }
  assert.deepEqual([...new Set(limits.map((entry) => entry.area))], [
    'Rate limits', 'Sign-in and accounts', 'Agent tokens', 'Renders', 'Request bodies', 'Uploads and files', 'Approvals and submissions',
    'Projects and versions',
    'Comments and notices', 'Live collaboration', 'Access requests and sharing', 'Retention and purge', 'Links', 'Catalog and rights',
    'Providers', 'Brand edits and tool policies', 'Brand pages', 'Partner programmes', 'Storage, audit and connections',
  ]);
});

test('agent token defaults match parsed config and missing fields use the enforcing seed', () => {
  const config = configWith();
  const defaults = limitsInventory(config, { env: {} });
  for (const key of TOKEN_LIMIT_KEYS) {
    assert.equal(byId(defaults, `automation.tokenLimits.${key}`).value, config.automation.tokenLimits[key]);
    assert.equal(config.automation.tokenLimits[key], TOKEN_LIMIT_SEED[key]);
  }
  const missing = structuredClone(config);
  Reflect.deleteProperty(missing.automation, 'tokenLimits');
  for (const key of TOKEN_LIMIT_KEYS) {
    const entry = byId(limitsInventory(missing, { env: {} }), `automation.tokenLimits.${key}`);
    assert.equal(entry.value, TOKEN_LIMIT_SEED[key]);
    assert.equal(entry.source, 'built-in');
  }
  const configured = configWith({ automation: { tokenLimits: { callsPerMinute: 45, rendersPerDay: 300, rendersPerMonth: 4500 } } });
  const limits = limitsInventory(configured, { env: {} });
  for (const key of TOKEN_LIMIT_KEYS) {
    const entry = byId(limits, `automation.tokenLimits.${key}`);
    assert.equal(entry.value, configured.automation.tokenLimits[key]);
    assert.equal(entry.source, 'configuration');
  }
});

test('an explicit null cap reads as configuration where it differs from the built-in default', () => {
  const config = configWith({ automation: { tokenLimits: { callsPerMinute: null, rendersPerDay: null, rendersPerMonth: null } } });
  for (const key of TOKEN_LIMIT_KEYS) {
    const entry = byId(limitsInventory(config, { env: {} }), `automation.tokenLimits.${key}`);
    assert.equal(entry.value, null);
    assert.equal(entry.source, TOKEN_LIMIT_SEED[key] === null ? 'built-in' : 'configuration', key);
  }
});

test('a setting equal to its built-in default reads as built-in, never as configuration', () => {
  const limits = limitsInventory(configWith(), { env: {} });
  assert.equal(byId(limits, 'rateLimit.enabled').source, 'built-in');
  assert.equal(byId(limits, 'policy.retention.auditDays').source, 'built-in');
  assert.equal(byId(limits, 'automation.tokenLimits.callsPerMinute').source, 'built-in');
});

test('the render runner shows the figures it holds, and LW_RENDER_CONCURRENCY as their source', () => {
  const built = limitsInventory(configWith(), { env: {} });
  assert.equal(byId(built, 'renders.concurrency').value, RENDER_RUNNER_DEFAULTS.concurrency);
  assert.equal(byId(built, 'renders.attemptTimeoutMs').value, RENDER_RUNNER_DEFAULTS.timeoutMs);
  assert.equal(byId(built, 'renders.concurrency').source, 'built-in');
  const live = limitsInventory(configWith(), { env: { LW_RENDER_CONCURRENCY: '6' }, runner: { concurrency: 6, leaseMs: 30_000, timeoutMs: 120_000 } });
  assert.equal(byId(live, 'renders.concurrency').value, 6);
  assert.equal(byId(live, 'renders.concurrency').source, 'environment');
});

test('exit and Reopen values come from their enforcing constants', () => {
  const limits = limitsInventory(configWith(), { env: {} });
  assert.equal(byId(limits, 'programmes.exitRowBound').value, EXIT_ROW_BOUND);
  assert.equal(byId(limits, 'programmes.reopenDays').value, REOPEN_DAYS);
});

test('configuration values preserve disabled switches and zero retention', () => {
  const config = configWith({
    rateLimit: { enabled: false, automation: { capacity: 33, refillPerSec: 0 } },
    policy: { retention: { auditDays: 0, renderOutputDays: 7, deletedDocumentsDays: 31, telemetryDays: 12 } },
  });
  const limits = limitsInventory(config, { env: {} });
  assert.equal(byId(limits, 'rateLimit.enabled').value, false);
  assert.equal(byId(limits, 'rateLimit.automation.capacity').value, config.rateLimit.automation.capacity);
  assert.equal(byId(limits, 'rateLimit.automation.refillPerSec').value, 0);
  for (const key of Object.keys(config.policy.retention) as (keyof typeof config.policy.retention)[]) {
    const entry = byId(limits, `policy.retention.${key}`);
    assert.equal(entry.value, config.policy.retention[key]);
    assert.equal(entry.source, config.policy.retention[key] === DEFAULTS.policy.retention[key] ? 'built-in' : 'configuration', key);
  }
});

test('the partner licence gate uses the active decision and configuration overrides it', () => {
  const entry = byId(limitsInventory(configWith(), { partnerRightsMode: 'gate', env: {} }), 'programmes.partnerRightsMode');
  assert.equal(entry.label, 'Partner licence gate');
  assert.equal(entry.value, 'gate');
  assert.equal(entry.source, 'built-in');
  const config = configWith({ policy: { catalog: { partnerRights: 'report' } } });
  const override = byId(limitsInventory(config, { partnerRightsMode: 'gate', env: {} }), entry.id);
  assert.equal(override.value, config.policy.catalog.partnerRights);
  assert.equal(override.source, 'configuration');
  // A configured mode reads as configuration even when it matches the recorded decision.
  const same = byId(limitsInventory(configWith({ policy: { catalog: { partnerRights: 'gate' } } }), { partnerRightsMode: 'gate', env: {} }), entry.id);
  assert.equal(same.source, 'configuration');
});

function responseDouble() {
  const headers = new Map<string, unknown>();
  let body = '';
  const res = {
    statusCode: 0,
    setHeader(key: string, value: unknown) { headers.set(key.toLowerCase(), value); },
    getHeader(key: string) { return headers.get(key.toLowerCase()); },
    getHeaders() { return Object.fromEntries(headers); },
    removeHeader(key: string) { headers.delete(key.toLowerCase()); },
    writeHead(status: number, values: Record<string, unknown>) {
      res.statusCode = status;
      for (const [key, value] of Object.entries(values)) res.setHeader(key, value);
      return res;
    },
    end(value: Buffer) { body = value.toString('utf8'); },
  };
  return { res, headers, body: () => body };
}

test('the admin route needs policy.edit, reads the active mode and sends a private uncached inventory', async () => {
  const router = createRouter();
  const config = configWith();
  const actions: string[] = [];
  registerLimitsRoute(router, {
    config,
    requireAction: async (_req, _res, action) => { actions.push(action); return {}; },
    partnerRightsMode: async () => 'gate',
  });
  assert.deepEqual(router.descriptions(), [{ method: 'GET', path: '/api/v1/limits', delivery: 'person-private', declared: true }]);
  const response = responseDouble();
  await router.dispatch({ method: 'GET', url: '/api/v1/limits', headers: {} } as IncomingMessage, response.res as unknown as ServerResponse);
  assert.deepEqual(actions, ['policy.edit']);
  assert.equal(response.res.statusCode, 200);
  assert.match(String(response.headers.get('cache-control')), /\bno-store\b/);
  assert.deepEqual(JSON.parse(response.body()), { limits: limitsInventory(config, { partnerRightsMode: 'gate' }) });
});

test('the admin route stops when policy.edit is refused', async () => {
  const router = createRouter();
  let modeRead = false;
  registerLimitsRoute(router, {
    config: configWith(),
    requireAction: async (_req, res) => { sendError(res, 403, 'FORBIDDEN', 'policy.edit required'); return null; },
    partnerRightsMode: () => { modeRead = true; return 'gate'; },
  });
  const response = responseDouble();
  await router.dispatch({ method: 'GET', url: '/api/v1/limits', headers: {} } as IncomingMessage, response.res as unknown as ServerResponse);
  assert.equal(response.res.statusCode, 403);
  assert.equal(modeRead, false);
  assert.equal(JSON.parse(response.body()).error.code, 'FORBIDDEN');
  assert.equal(Object.hasOwn(JSON.parse(response.body()), 'limits'), false);
});
