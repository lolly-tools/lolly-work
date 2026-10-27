/**
 * The OFREP resolver against an in-process double of an OpenFeature Remote
 * Evaluation Protocol service: the request shape and its minimised context,
 * caching and in-flight sharing, bounded timeouts, closed fallback to Work's
 * governed value on every failure, the error metric, configuration
 * validation, and the org-config route reading one resolved value.
 */
import { test, type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { createOfrepResolver, ofrepContext, validateOfrepConfig, type OfrepConfig } from '../server/src/policy/ofrep.ts';
import { createMetrics } from '../server/src/observability/metrics.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { parseConfig, loadSecrets } from '../server/src/config/instance.ts';
import { buildApp } from '../server/src/api/app.ts';

interface Seen { method: string; url: string; headers: IncomingMessage['headers']; body: unknown }
type Handler = (req: Seen, res: ServerResponse) => void | Promise<void>;

/** An OFREP service on a loopback port. `handle` answers each request; every
 *  request is recorded with its parsed body. */
async function double(t: TestContext, handle: Handler) {
  const seen: Seen[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const text = Buffer.concat(chunks).toString('utf8');
    const entry: Seen = { method: req.method ?? '', url: req.url ?? '', headers: req.headers, body: text ? JSON.parse(text) : null };
    seen.push(entry);
    await handle(entry, res);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  return { url: `http://127.0.0.1:${addr.port}`, seen };
}
const json = (res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};
/** Answer every flag with `value`, OFREP's single-flag success shape. */
const answer = (value: unknown): Handler => (req, res) => {
  const key = decodeURIComponent(req.url.split('/').pop()!);
  json(res, 200, { key, value, reason: 'TARGETING_MATCH', variant: String(value), metadata: {} });
};
function config(url: string, extra: Record<string, unknown> = {}): OfrepConfig {
  const c: Record<string, unknown> = { url, ...extra };
  validateOfrepConfig(c, false);
  return c as unknown as OfrepConfig;
}
const PERSON = { groups: ['pilot', 'design', 'pilot'], role: 'author' };

test('request shape: one POST per governed flag with the spec path, JSON headers, bearer credential and a context of groups and role only', async (t) => {
  const svc = await double(t, answer(true));
  const resolver = createOfrepResolver({ config: config(svc.url), token: 'tok-123' });
  const out = await resolver.evaluate(PERSON);
  assert.deepEqual(resolver.flags, ['neurospicy', 'jelly-effects', 'strip-upload-metadata', 'export-preflight', 'private-collab', 'nearby-discovery']);
  assert.equal(svc.seen.length, resolver.flags.length);
  assert.deepEqual(svc.seen.map((s) => s.url).sort(), resolver.flags.map((f) => `/ofrep/v1/evaluate/flags/${f}`).sort());
  for (const s of svc.seen) {
    assert.equal(s.method, 'POST');
    assert.equal(s.headers['content-type'], 'application/json');
    assert.equal(s.headers.authorization, 'Bearer tok-123');
    assert.equal(s.headers['x-api-key'], undefined);
    // Exactly these two facts, sorted and de-duplicated; no targetingKey.
    assert.deepEqual(s.body, { context: { groups: ['design', 'pilot'], role: 'author' } });
  }
  assert.equal(out.size, resolver.flags.length);
  assert.ok([...out.values()].every((v) => v === true));
  assert.equal(out.has('ai'), false, 'managed AI is never asked');
});

test('context minimisation: contextGroups narrows the groups sent; a cohort key is opt-in and the same for the same groups and role', () => {
  const narrowed = ofrepContext({ contextGroups: ['pilot'], targetingKey: 'none' }, { groups: ['pilot', 'payroll-2026', 'u-jsmith'], role: 'member' });
  assert.deepEqual(narrowed, { groups: ['pilot'], role: 'member' });
  const a = ofrepContext({ targetingKey: 'cohort' }, { groups: ['b', 'a'], role: 'member' });
  const b = ofrepContext({ targetingKey: 'cohort' }, { groups: ['a', 'b'], role: 'member' });
  const c = ofrepContext({ targetingKey: 'cohort' }, { groups: ['a', 'b'], role: 'admin' });
  assert.match(String(a.targetingKey), /^cohort-[0-9a-f]{32}$/);
  assert.equal(a.targetingKey, b.targetingKey);
  assert.notEqual(a.targetingKey, c.targetingKey);
  assert.deepEqual(Object.keys(a).sort(), ['groups', 'role', 'targetingKey']);
});

test('flags, keyPrefix and api-key auth shape the request', async (t) => {
  const svc = await double(t, answer(false));
  const resolver = createOfrepResolver({ config: config(svc.url, { flags: ['export-preflight'], keyPrefix: 'lolly.', auth: 'api-key' }), token: 'k' });
  const out = await resolver.evaluate(PERSON);
  assert.deepEqual([...out], [['export-preflight', false]]);
  assert.equal(svc.seen.length, 1);
  assert.equal(svc.seen[0]!.url, '/ofrep/v1/evaluate/flags/lolly.export-preflight');
  assert.equal(svc.seen[0]!.headers['x-api-key'], 'k');
  assert.equal(svc.seen[0]!.headers.authorization, undefined);
});

test('no token sends no credential at all', async (t) => {
  const svc = await double(t, answer(true));
  await createOfrepResolver({ config: config(svc.url, { flags: ['neurospicy'] }) }).evaluate(PERSON);
  assert.equal(svc.seen[0]!.headers.authorization, undefined);
  assert.equal(svc.seen[0]!.headers['x-api-key'], undefined);
});

test('caching: answers are reused per flag and context until cacheSeconds pass; concurrent polls share one request', async (t) => {
  const svc = await double(t, answer(true));
  let clock = 1_000_000;
  const resolver = createOfrepResolver({ config: config(svc.url, { flags: ['neurospicy'], cacheSeconds: 30 }), now: () => clock });
  await Promise.all([resolver.evaluate(PERSON), resolver.evaluate(PERSON), resolver.evaluate({ groups: ['design', 'pilot'], role: 'author' })]);
  assert.equal(svc.seen.length, 1, 'same context, one request');
  await resolver.evaluate({ groups: ['sales'], role: 'author' });
  assert.equal(svc.seen.length, 2, 'a different context asks again');
  clock += 29_000;
  await resolver.evaluate(PERSON);
  assert.equal(svc.seen.length, 2);
  clock += 2_000;
  await resolver.evaluate(PERSON);
  assert.equal(svc.seen.length, 3, 'expired answers are refreshed');
});

test('timeout: a slow service is abandoned within timeoutMs and the flag keeps Work\'s value; the metric counts it', async (t) => {
  const svc = await double(t, async (req, res) => {
    await new Promise((r) => setTimeout(r, 1000));
    if (!res.destroyed) answer(true)(req, res);
  });
  const metrics = createMetrics();
  const resolver = createOfrepResolver({
    config: config(svc.url, { flags: ['neurospicy'], timeoutMs: 100 }),
    metrics: { request: (f) => metrics.ofrepRequest(f), error: (f, r) => metrics.ofrepError(f, r) },
  });
  const started = Date.now();
  const out = await resolver.evaluate(PERSON);
  assert.ok(Date.now() - started < 800, 'bounded by the timeout');
  assert.equal(out.size, 0);
  const text = metrics.renderText([]);
  assert.match(text, /lw_ofrep_requests_total\{flag="neurospicy"\} 1/);
  assert.match(text, /lw_ofrep_evaluation_errors_total\{flag="neurospicy",reason="timeout"\} 1/);
  assert.equal(resolver.stats().lastError?.reason, 'timeout');
});

test('every failure falls back to Work\'s value with a fixed reason', async (t) => {
  const cases: Array<[string, Handler]> = [
    ['server', (_q, res) => json(res, 500, { errorDetails: 'boom' })],
    ['status', (_q, res) => json(res, 418, {})],
    ['unauthorized', (_q, res) => json(res, 401, {})],
    ['unauthorized', (_q, res) => json(res, 403, {})],
    ['not_found', (q, res) => json(res, 404, { key: 'x', errorCode: 'FLAG_NOT_FOUND', errorDetails: 'no flag' })],
    ['targeting_key_missing', (_q, res) => json(res, 400, { key: 'x', errorCode: 'TARGETING_KEY_MISSING' })],
    ['invalid_request', (_q, res) => json(res, 400, { key: 'x', errorCode: 'INVALID_CONTEXT' })],
    ['type_mismatch', answer('on')],
    ['type_mismatch', answer(1)],
    ['bad_response', (_q, res) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end('{not json'); }],
    ['bad_response', (_q, res) => json(res, 200, ['not', 'an', 'object'])],
    ['bad_response', (_q, res) => json(res, 200, { value: true, pad: 'x'.repeat(70 * 1024) })],
    ['network', (_q, res) => { res.writeHead(302, { location: 'http://127.0.0.1:1/' }); res.end(); }],
    ['network', (_q, res) => { res.socket?.destroy(); }],
  ];
  for (const [reason, handler] of cases) {
    const svc = await double(t, handler);
    const errors: string[] = [];
    const resolver = createOfrepResolver({ config: config(svc.url, { flags: ['neurospicy'] }), metrics: { request: () => {}, error: (_f, r) => errors.push(r) } });
    const out = await resolver.evaluate(PERSON);
    assert.equal(out.size, 0, reason);
    assert.deepEqual(errors, [reason], `${reason}: ${errors.join()}`);
  }
});

test('an unreachable service falls back without throwing', async () => {
  const errors: string[] = [];
  const resolver = createOfrepResolver({ config: config('http://127.0.0.1:1', { flags: ['neurospicy'] }), metrics: { request: () => {}, error: (_f, r) => errors.push(r) } });
  assert.equal((await resolver.evaluate(PERSON)).size, 0);
  assert.deepEqual(errors, ['network']);
});

test('the spec\'s code default (no value) and a DISABLED flag keep Work\'s value without counting as errors', async (t) => {
  for (const body of [{ key: 'neurospicy', reason: 'DEFAULT' }, { key: 'neurospicy', value: true, reason: 'DISABLED' }]) {
    const svc = await double(t, (_q, res) => json(res, 200, body));
    const errors: string[] = [];
    const resolver = createOfrepResolver({ config: config(svc.url, { flags: ['neurospicy'] }), metrics: { request: () => {}, error: (_f, r) => errors.push(r) } });
    assert.equal((await resolver.evaluate(PERSON)).size, 0);
    assert.deepEqual(errors, []);
  }
});

test('failures are cached briefly; a 429 waits for its Retry-After, bounded', async (t) => {
  let status = 500;
  const svc = await double(t, (q, res) => (status === 200 ? answer(true)(q, res) : json(res, status, {}, status === 429 ? { 'retry-after': '20' } : {})));
  let clock = 0;
  const resolver = createOfrepResolver({ config: config(svc.url, { flags: ['neurospicy'], cacheSeconds: 60 }), now: () => clock });
  await resolver.evaluate(PERSON);
  await resolver.evaluate(PERSON);
  assert.equal(svc.seen.length, 1, 'a failure is not retried on every poll');
  clock += 5_001;
  status = 429;
  await resolver.evaluate(PERSON);
  assert.equal(svc.seen.length, 2, 'a transient failure is retried after five seconds');
  clock += 10_000;
  status = 200;
  assert.equal((await resolver.evaluate(PERSON)).size, 0);
  assert.equal(svc.seen.length, 2, 'Retry-After is honoured');
  clock += 10_001;
  assert.equal((await resolver.evaluate(PERSON)).get('neurospicy'), true);
  assert.equal(svc.seen.length, 3);
});

test('configuration: defaults fill in, typos and unsafe values stop the boot', () => {
  const c: Record<string, unknown> = { url: 'https://flags.example.org/' };
  validateOfrepConfig(c, true);
  assert.deepEqual(c, { url: 'https://flags.example.org', timeoutMs: 500, cacheSeconds: 30, targetingKey: 'none', auth: 'bearer' });
  for (const [bad, pattern] of [
    [{ url: 'http://flags.example.org' }, /HTTPS/],
    [{ url: 'http://127.0.0.1:8016' }, /HTTPS/],
    [{ url: 'https://user:pw@flags.example.org' }, /HTTPS/],
    [{ url: 'https://flags.example.org', flag: ['neurospicy'] }, /unknown key "flag"/],
    [{ url: 'https://flags.example.org', flags: ['ai'] }, /flags must list governed flag ids/],
    [{ url: 'https://flags.example.org', flags: ['neurospicy', 'neurospicy'] }, /flags/],
    [{ url: 'https://flags.example.org', flags: [] }, /flags/],
    [{ url: 'https://flags.example.org', timeoutMs: 10 }, /timeoutMs/],
    [{ url: 'https://flags.example.org', timeoutMs: 60_000 }, /timeoutMs/],
    [{ url: 'https://flags.example.org', cacheSeconds: 0 }, /cacheSeconds/],
    [{ url: 'https://flags.example.org', keyPrefix: 'a b' }, /keyPrefix/],
    [{ url: 'https://flags.example.org', contextGroups: [' x'] }, /contextGroups/],
    [{ url: 'https://flags.example.org', targetingKey: 'email' }, /targetingKey/],
    [{ url: 'https://flags.example.org', auth: 'basic' }, /auth/],
  ] as const) {
    assert.throws(() => validateOfrepConfig({ ...bad }, true), pattern, JSON.stringify(bad));
  }
  // Loopback HTTP is for evaluation only.
  const local: Record<string, unknown> = { url: 'http://127.0.0.1:8016' };
  validateOfrepConfig(local, false);
  assert.equal(local.url, 'http://127.0.0.1:8016');
});

test('instance.json carries the block; the credential comes from LW_OFREP_TOKEN', () => {
  const dev = { enabled: true, users: [] };
  const cfg = parseConfig(JSON.stringify({ deployment: { mode: 'evaluation' }, dev, featureFlags: { ofrep: { url: 'http://localhost:8016', flags: ['neurospicy'] } } }));
  assert.deepEqual(cfg.featureFlags.ofrep, { url: 'http://localhost:8016', flags: ['neurospicy'], timeoutMs: 500, cacheSeconds: 30, targetingKey: 'none', auth: 'bearer' });
  assert.deepEqual(parseConfig(JSON.stringify({ dev })).featureFlags, {});
  assert.throws(() => parseConfig(JSON.stringify({ dev, featureFlags: { flagd: {} } })), /featureFlags/);
  assert.throws(() => parseConfig(JSON.stringify({ deployment: { mode: 'production' }, dev, featureFlags: { ofrep: { url: 'http://localhost:8016' } } })), /HTTPS/);
  assert.equal(loadSecrets({ LW_OFREP_TOKEN: 'secret-value' } as NodeJS.ProcessEnv).ofrepToken, 'secret-value');
});

/** Work in front of an OFREP double, for the end-to-end path the shell sees. */
async function serveWork(t: TestContext, ofrepUrl: string, extra: Record<string, unknown> = {}) {
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({
    deployment: { mode: 'evaluation' },
    rateLimit: { enabled: false },
    featureFlags: { ofrep: { url: ofrepUrl, flags: ['export-preflight', 'neurospicy'], timeoutMs: 200, ...extra } },
    dev: { enabled: true, users: [
      { email: 'admin@test', name: 'Admin', groups: ['admin'] },
      { email: 'pilot@test', name: 'Pilot', groups: ['pilot'] },
    ] },
  }));
  const metrics = createMetrics();
  const app = buildApp({ config, store, metrics, secrets: { session: 'test-session', link: 'test-link', ofrepToken: 'tok' } });
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
  const orgConfig = async (cookie: string) => (await (await fetch(`${base}/api/v1/org-config`, { headers: { cookie } })).json()) as {
    featureFlags: Record<string, { default: boolean; hidden: boolean }>; policyVersion: string;
  };
  return { store, base, login, orgConfig, metrics };
}

test('org-config: the service decides the default, Work keeps visibility, and the shell reads one resolved value', async (t) => {
  let decide = true;
  const svc = await double(t, (q, res) => {
    const groups = (q.body as { context: { groups: string[] } }).context.groups;
    answer(groups.includes('pilot') ? decide : !decide)(q, res);
  });
  const work = await serveWork(t, svc.url, { cacheSeconds: 1 });
  await work.store.putFlagGovernance({ id: 'export-preflight', default: 'off', visibility: 'hide', updatedAt: '2026-10-27T00:00:00Z' });
  const pilot = await work.login('pilot@test');
  const first = await work.orgConfig(pilot);
  assert.deepEqual(first.featureFlags['export-preflight'], { default: true, hidden: true });
  assert.equal(first.featureFlags.neurospicy!.default, true);
  // The context reached the service minimised, with Work's own credential.
  const sent = svc.seen.find((s) => s.url.endsWith('/export-preflight'))!;
  assert.deepEqual(sent.body, { context: { groups: ['pilot'], role: 'member' } });
  assert.equal(sent.headers.authorization, 'Bearer tok');
  // A change in the service moves the policy version once the cache expires.
  decide = false;
  await new Promise((r) => setTimeout(r, 1100));
  const second = await work.orgConfig(pilot);
  assert.equal(second.featureFlags['export-preflight']!.default, false);
  assert.notEqual(second.policyVersion, first.policyVersion);
});

test('org-config: a failing service leaves Work\'s group rule in force, and the console sees the failure', async (t) => {
  const svc = await double(t, (_q, res) => json(res, 503, {}));
  const work = await serveWork(t, svc.url);
  await work.store.putFlagGovernance({ id: 'export-preflight', default: 'off', groups: [{ group: 'pilot', default: 'on' }], updatedAt: '2026-10-27T00:00:00Z' });
  const pilot = await work.login('pilot@test');
  const oc = await work.orgConfig(pilot);
  assert.equal(oc.featureFlags['export-preflight']!.default, true, 'the group rule, not the service');
  assert.match(work.metrics.renderText([]), /lw_ofrep_evaluation_errors_total\{flag="export-preflight",reason="server"\} 1/);
  const admin = await work.login('admin@test');
  const res = await fetch(`${work.base}/api/v1/policy/flags`, { headers: { cookie: admin } });
  const body = await res.json() as { flags: Array<{ id: string; flagService: boolean }>; flagService: { origin: string; flags: string[]; errors: number; lastError: { reason: string } } };
  assert.equal(body.flagService.origin, svc.url);
  assert.deepEqual(body.flagService.flags, ['export-preflight', 'neurospicy']);
  assert.ok(body.flagService.errors >= 1);
  assert.equal(body.flagService.lastError.reason, 'server');
  assert.equal(body.flags.find((f) => f.id === 'export-preflight')!.flagService, true);
  assert.equal(body.flags.find((f) => f.id === 'jelly-effects')!.flagService, false);
  assert.equal(JSON.stringify(body).includes('tok'), false, 'the credential never reaches the console');
});

test('org-config without a service is unchanged: no request, the same version as before', async (t) => {
  const store = createMemoryStore();
  const config = parseConfig(JSON.stringify({ rateLimit: { enabled: false }, dev: { enabled: true, users: [{ email: 'm@test', name: 'M', groups: [] }] } }));
  let calls = 0;
  const app = buildApp({ config, store, secrets: { session: 's', link: 'l' }, fetchImpl: (async () => { calls += 1; throw new Error('no egress'); }) as typeof fetch });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>((resolve) => server.close(() => resolve())));
  const addr = server.address();
  assert.ok(addr && typeof addr !== 'string');
  const base = `http://127.0.0.1:${addr.port}`;
  const cookie = (await fetch(`${base}/api/auth/dev?email=m%40test`, { redirect: 'manual' })).headers.getSetCookie()[0]!.split(';')[0]!;
  const res = await fetch(`${base}/api/v1/org-config`, { headers: { cookie } });
  assert.equal(res.status, 200);
  assert.equal(calls, 0);
});
