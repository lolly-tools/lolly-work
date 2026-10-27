/**
 * OpenTelemetry export (observability/otel.ts): OTLP/HTTP traces, metrics and
 * logs to an in-process receiver double. Proves the settings follow the
 * standard OTEL_* variables, nothing is sent unless an endpoint is set, the
 * payloads carry the `/metrics` series, one server span per request and the
 * structured logger's records, both encodings decode, back-pressure drops and
 * counts instead of waiting, and that no identity leaves: the captured bytes
 * of every export are searched for each email, cookie, token, address, query
 * value, body and user id the requests carried.
 */
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { gunzipSync } from 'node:zlib';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { otelConfigFromEnv, parseKeyValueList, printableEndpoint } from '../server/src/observability/otel-config.ts';
import { createOtel, errorType, logAttributes, NOOP_OTEL, parseTraceparent, sampled, scrubText, sqlSummary, type Otel } from '../server/src/observability/otel.ts';
import { encodeMetrics, encodeTraces, SPAN_KIND } from '../server/src/observability/otlp-encode.ts';
import { createLogger } from '../server/src/observability/log.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createMemoryStore } from '../server/src/store/memory.ts';
import { createMemoryBlobStore } from '../server/src/blobs/memory.ts';
import { buildApp } from '../server/src/api/app.ts';

// ── the receiver double ─────────────────────────────────────────────────────

interface Capture { path: string; headers: IncomingHttpHeaders; body: Buffer }
interface Receiver { url: string; got: Capture[]; close(): Promise<void> }

/** An OTLP/HTTP endpoint that records every request. `mode: 'hang'` accepts
 *  the request and never answers, a collector that has stalled. */
async function receiver(mode: 'ok' | 'fail' | 'hang' = 'ok'): Promise<Receiver> {
  const got: Capture[] = [];
  const server: Server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const raw = Buffer.concat(chunks);
    got.push({ path: req.url ?? '', headers: req.headers, body: req.headers['content-encoding'] === 'gzip' ? gunzipSync(raw) : raw });
    if (mode === 'hang') return;
    res.writeHead(mode === 'ok' ? 200 : 400, { 'content-type': String(req.headers['content-type'] ?? 'application/json') });
    res.end(mode === 'ok' && req.headers['content-type'] === 'application/json' ? '{}' : '');
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  const close = (): Promise<void> => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); };
  after(() => (server.listening ? close() : undefined)); // a failed assertion still frees the port
  return { url: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`, got, close };
}

// ── a protobuf reader, enough to walk the three export requests ─────────────

type Field = bigint | Buffer;
function readVarint(buf: Buffer, at: number): [bigint, number] {
  let value = 0n, shift = 0n;
  for (;;) {
    const byte = buf[at++]!;
    value |= BigInt(byte & 0x7f) << shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7n;
  }
}
/** Field number to its values: varints as bigint, everything else as bytes. */
function pb(buf: Buffer): Map<number, Field[]> {
  const out = new Map<number, Field[]>();
  let at = 0;
  while (at < buf.length) {
    const [key, next] = readVarint(buf, at);
    at = next;
    const field = Number(key >> 3n), wire = Number(key & 7n);
    let value: Field;
    if (wire === 0) [value, at] = readVarint(buf, at);
    else if (wire === 1) { value = buf.subarray(at, at + 8); at += 8; }
    else if (wire === 5) { value = buf.subarray(at, at + 4); at += 4; }
    else if (wire === 2) { const [len, start] = readVarint(buf, at); value = buf.subarray(start, start + Number(len)); at = start + Number(len); }
    else throw new Error(`wire type ${wire}`);
    out.set(field, [...(out.get(field) ?? []), value]);
  }
  return out;
}
const msgs = (m: Map<number, Field[]>, field: number): Map<number, Field[]>[] => (m.get(field) ?? []).map(v => pb(v as Buffer));
const str = (m: Map<number, Field[]>, field: number): string => ((m.get(field)?.[0] as Buffer | undefined) ?? Buffer.alloc(0)).toString('utf8');
/** KeyValue list to a plain object (string, int and double values). */
function pbAttrs(m: Map<number, Field[]>, field: number): Record<string, string | number | boolean> {
  const out: Record<string, string | number | boolean> = {};
  for (const kv of msgs(m, field)) {
    const value = msgs(kv, 2)[0]!;
    if (value.has(1)) out[str(kv, 1)] = str(value, 1);
    else if (value.has(2)) out[str(kv, 1)] = value.get(2)![0] === 1n;
    else if (value.has(3)) out[str(kv, 1)] = Number(BigInt.asIntN(64, value.get(3)![0] as bigint));
    else if (value.has(4)) out[str(kv, 1)] = (value.get(4)![0] as Buffer).readDoubleLE(0);
  }
  return out;
}

// ── OTLP/JSON helpers ───────────────────────────────────────────────────────

type J = Record<string, any>;
const jsonAttrs = (list: J[] = []): Record<string, string | number | boolean> =>
  Object.fromEntries(list.map(kv => [kv.key, kv.value.stringValue ?? (kv.value.intValue !== undefined ? Number(kv.value.intValue) : kv.value.doubleValue ?? kv.value.boolValue)]));
const bodies = (r: Receiver, path: string): Capture[] => r.got.filter(c => c.path === path);

// ── the app under test ──────────────────────────────────────────────────────

const SECRETS = { session: 's'.repeat(32), link: 'l'.repeat(32) };

async function startApp(env: NodeJS.ProcessEnv): Promise<{ base: string; otel: Otel; close(): Promise<void> }> {
  const settings = otelConfigFromEnv(env, '9.9.9-test');
  const otel = createOtel(settings.config);
  const pack = await mkdtemp(join(tmpdir(), 'lw-otlp-'));
  await mkdir(join(pack, 'catalog', 'tools'), { recursive: true });
  await writeFile(join(pack, 'catalog', 'tools', 'index.json'), JSON.stringify({ version: 1, tools: [] }));
  const config = parseConfig(JSON.stringify({
    instance: { name: 'Otlp', baseUrl: 'http://localhost', pack },
    rateLimit: { enabled: false },
    dev: { enabled: true, users: [{ email: 'admin@test', groups: ['admin'] }, { email: 'member@test', groups: [] }] },
  }));
  // A blob driver whose usage query fails with a message full of identity:
  // the logger's warning must leave as a type, not as this text.
  const blobs = { ...createMemoryBlobStore(), usage: async () => { throw new Error('usage denied for alice@example.com from 198.51.100.23 token=abcdef'); } };
  const app = buildApp({ config, store: createMemoryStore(), secrets: SECRETS, blobs, otel });
  const server = createServer((req, res) => void app(req, res));
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const address = server.address();
  return {
    base: `http://127.0.0.1:${typeof address === 'object' && address ? address.port : 0}`,
    otel,
    close: () => { server.closeAllConnections(); return new Promise<void>((r) => server.close(() => r())); },
  };
}

/** Requests that carry every kind of identity the rule names. Returns the
 *  strings that must never appear in an export. */
async function exercise(base: string): Promise<{ forbidden: string[]; traceId: string; parentSpanId: string }> {
  const login = async (email: string): Promise<string> => {
    const res = await fetch(`${base}/api/auth/dev?email=${encodeURIComponent(email)}`, { redirect: 'manual' });
    assert.equal(res.status, 302);
    return res.headers.getSetCookie().find((c) => c.startsWith('lw_session='))!.split(';')[0]!;
  };
  const admin = await login('admin@test');
  const member = await login('member@test');
  const users = await (await fetch(`${base}/api/v1/users?q=member%40test`, { headers: { cookie: admin } })).json() as { users: Array<{ id: string; email: string }> };
  const memberId = users.users.find(u => u.email === 'member@test')!.id;
  const traceId = '4bf92f3577b34da6a3ce929d0e0e4736', parentSpanId = '00f067aa0ba902b7';
  const one = await fetch(`${base}/api/v1/users/${memberId}?secret=query-value-xyz`, {
    headers: {
      cookie: admin, 'x-forwarded-for': '203.0.113.77', 'user-agent': 'TestAgent/9.9 private-ua',
      traceparent: `00-${traceId}-${parentSpanId}-01`, tracestate: 'vendor=leaky-state',
    },
  });
  assert.equal(one.status, 200);
  await one.arrayBuffer();
  await (await fetch(`${base}/api/v1/telemetry`, {
    method: 'POST', headers: { cookie: member, 'content-type': 'application/json', authorization: 'Bearer sekrit-token-123' },
    body: JSON.stringify({ events: [{ event: 'tool.open', attrs: { toolId: 'body-content-qwerty' } }] }),
  })).arrayBuffer();
  await (await fetch(`${base}/api/v1/nothing-here/${memberId}?email=admin@test`, { headers: { authorization: 'Bearer sekrit-token-123' } })).arrayBuffer();
  // The gauges are read once here, so the blob usage warning is logged.
  await (await fetch(`${base}/metrics`)).text();
  return {
    traceId, parentSpanId,
    forbidden: ['admin@test', 'member@test', 'admin%40test', 'member%40test', 'alice@example.com', '198.51.100.23', 'token=abcdef',
      admin.split('=')[1]!, member.split('=')[1]!, 'sekrit-token-123', '203.0.113.77', '127.0.0.1', 'private-ua', 'leaky-state',
      'query-value-xyz', 'secret=', 'body-content-qwerty', memberId, `/api/v1/users/${memberId}`, 'nothing-here'],
  };
}

const assertNothingForbidden = (r: Receiver, forbidden: string[]): void => {
  assert.ok(r.got.length > 0, 'something was exported');
  for (const capture of r.got) {
    for (const needle of forbidden) {
      assert.equal(capture.body.includes(Buffer.from(needle)), false, `${capture.path} carried "${needle}"`);
    }
  }
};

const ENDPOINT_ENV = (url: string, protocol: string): NodeJS.ProcessEnv => ({
  OTEL_EXPORTER_OTLP_ENDPOINT: url,
  OTEL_EXPORTER_OTLP_PROTOCOL: protocol,
  OTEL_SERVICE_NAME: 'work-under-test',
  OTEL_RESOURCE_ATTRIBUTES: 'deployment.environment.name=test,service.name=ignored-by-precedence',
  OTEL_EXPORTER_OTLP_HEADERS: 'x-collector-key=k%3D1',
});

// Access lines are the logger's records; the second app sees them too.
process.env.LW_LOG_HTTP = '1';
after(() => { delete process.env.LW_LOG_HTTP; });

// ── settings ────────────────────────────────────────────────────────────────

test('no endpoint, or OTEL_SDK_DISABLED, means no export at all', () => {
  assert.equal(otelConfigFromEnv({}, '1').config, null);
  assert.equal(otelConfigFromEnv({ OTEL_SERVICE_NAME: 'x', OTEL_TRACES_SAMPLER: 'always_on' }, '1').config, null);
  assert.equal(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_SDK_DISABLED: 'true' }, '1').config, null);
  assert.equal(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_TRACES_EXPORTER: 'none', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, '1').config, null);
  assert.equal(createOtel(null), NOOP_OTEL);
  assert.deepEqual(NOOP_OTEL.selfMetrics(), []);
});

test('endpoints, protocol, headers and resource follow the OpenTelemetry variables', () => {
  const { config, notes } = otelConfigFromEnv({
    OTEL_EXPORTER_OTLP_ENDPOINT: 'https://collector.example:4318/base/',
    OTEL_EXPORTER_OTLP_LOGS_ENDPOINT: 'http://logs.example:4318/custom/path',
    OTEL_EXPORTER_OTLP_METRICS_PROTOCOL: 'http/json',
    OTEL_EXPORTER_OTLP_HEADERS: 'authorization=Basic%20abc,x-a=1',
    OTEL_EXPORTER_OTLP_TRACES_HEADERS: 'x-a=2',
    OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip',
    OTEL_RESOURCE_ATTRIBUTES: 'service.name=from-resource,team=brand',
    OTEL_TRACES_SAMPLER: 'parentbased_traceidratio', OTEL_TRACES_SAMPLER_ARG: '0.25',
    OTEL_BSP_MAX_QUEUE_SIZE: '100', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '500',
  }, '1.2.3');
  assert.deepEqual(notes, []);
  assert.ok(config);
  assert.equal(config.traces!.url, 'https://collector.example:4318/base/v1/traces');
  assert.equal(config.metrics!.url, 'https://collector.example:4318/base/v1/metrics');
  assert.equal(config.logs!.url, 'http://logs.example:4318/custom/path', 'a per-signal endpoint is used as given');
  assert.equal(config.traces!.protocol, 'http/protobuf', 'http/protobuf is the default');
  assert.equal(config.metrics!.protocol, 'http/json');
  assert.deepEqual(config.traces!.headers, { authorization: 'Basic abc', 'x-a': '2' });
  assert.deepEqual(config.metrics!.headers, { authorization: 'Basic abc', 'x-a': '1' });
  assert.equal(config.traces!.compression, 'gzip');
  assert.equal(config.resource['service.name'], 'from-resource');
  assert.equal(config.resource.team, 'brand');
  assert.equal(config.resource['service.version'], '1.2.3');
  assert.equal(config.resource['host.name'], undefined, 'no host name unless the administrator adds one');
  assert.deepEqual(config.sampler, { root: 'ratio', ratio: 0.25, parentBased: true });
  assert.equal(config.spanBatch.maxExportBatchSize, 100, 'a batch never exceeds the queue');
  assert.equal(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c', OTEL_SERVICE_NAME: 'svc', OTEL_RESOURCE_ATTRIBUTES: 'service.name=r' }, '1').config!.resource['service.name'], 'svc');
  assert.equal(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c' }, '1').config!.resource['service.name'], 'lolly-work');
  assert.equal(printableEndpoint('https://user:pass@c.example:4318/v1/traces?key=1'), 'https://c.example:4318/v1/traces');
});

test('grpc and unknown exporters are refused with a note, never a wrong port', () => {
  const grpc = otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4317', OTEL_EXPORTER_OTLP_PROTOCOL: 'grpc' }, '1');
  assert.equal(grpc.config, null);
  assert.equal(grpc.notes.length, 3);
  assert.match(grpc.notes[0]!, /OTLP over HTTP/);
  const mixed = otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: 'http://c:4318', OTEL_METRICS_EXPORTER: 'prometheus', OTEL_EXPORTER_OTLP_HEADERS: 'k=%zz' }, '1');
  assert.ok(mixed.config?.traces && mixed.config.logs && !mixed.config.metrics);
  assert.ok(mixed.notes.some(n => /OTEL_METRICS_EXPORTER=prometheus/.test(n)));
  assert.ok(mixed.notes.some(n => /skipped "k"/.test(n)) && !mixed.notes.some(n => n.includes('%zz')), 'a bad header is named by key only');
  assert.deepEqual(parseKeyValueList('a=1, b = x%20y ,=bad,c', 'T', []), { a: '1', b: 'x y' });
});

test('trace context, sampling, error types and the free-text scrubber', () => {
  const ctx = parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01');
  assert.deepEqual(ctx, { traceId: '4bf92f3577b34da6a3ce929d0e0e4736', spanId: '00f067aa0ba902b7', sampled: true });
  assert.equal(parseTraceparent('00-00000000000000000000000000000000-00f067aa0ba902b7-01'), undefined);
  assert.equal(parseTraceparent('ff-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01'), undefined);
  assert.equal(parseTraceparent('00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01-extra'), undefined);
  const parentBasedRatio = { root: 'ratio' as const, ratio: 0, parentBased: true };
  assert.equal(sampled(parentBasedRatio, 'f'.repeat(32), { ...ctx!, sampled: true }), true, 'the parent decides');
  assert.equal(sampled(parentBasedRatio, 'f'.repeat(32), undefined), false);
  assert.equal(sampled({ root: 'ratio', ratio: 0.5, parentBased: false }, '0'.repeat(31) + '1', undefined), true);
  assert.equal(sampled({ root: 'ratio', ratio: 0.5, parentBased: false }, 'f'.repeat(32), undefined), false);
  assert.equal(errorType(Object.assign(new Error('for bob@example.com'), { code: 'RENDER_BUSY' })), 'RENDER_BUSY');
  assert.equal(errorType(new TypeError('x')), 'TypeError');
  assert.equal(errorType('a message with bob@example.com'), 'Error');
  assert.equal(scrubText('sent to bob@example.com via 10.0.0.1 and ::1 with Bearer abc.def at https://x/y?token=1'),
    'sent to [email] via [address] and [address] with [credential] at https://x/y?[query]');
  assert.equal(scrubText('blob usage unavailable'), 'blob usage unavailable');
  assert.deepEqual(logAttributes({ reqId: 'caller-chosen', method: 'GET', route: '/api/v1/users/:id', status: 200, ms: 3, error: 'bob@example.com', extra: 'x' }),
    { 'http.request.method': 'GET', 'http.route': '/api/v1/users/:id', 'http.response.status_code': 200, 'lw.duration_ms': 3, 'exception.type': 'Error' });
  assert.deepEqual(logAttributes({ route: 'ratelimited:auth', method: 'BREW' }), { 'http.request.method': '_OTHER', 'lw.route_class': 'ratelimited:auth' });
  assert.deepEqual(sqlSummary("select * from users where email = 'bob@example.com'"), { operation: 'SELECT', table: 'users' });
  assert.deepEqual(sqlSummary('  insert into audit_log(seq) values($1)'), { operation: 'INSERT', table: 'audit_log' });
  assert.deepEqual(sqlSummary('UPDATE sessions SET x=$1'), { operation: 'UPDATE', table: 'sessions' });
  assert.deepEqual(sqlSummary('begin'), { operation: 'BEGIN' });
  assert.deepEqual(sqlSummary('bob@example.com'), { operation: 'QUERY' });
});

// ── nothing configured, nothing sent ────────────────────────────────────────

test('unconfigured or disabled: the receiver hears nothing and /metrics is unchanged', async () => {
  const r = await receiver();
  for (const env of [{}, { OTEL_SDK_DISABLED: 'true', OTEL_EXPORTER_OTLP_ENDPOINT: r.url }, { OTEL_SERVICE_NAME: 'x', OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json' }]) {
    const app = await startApp(env);
    try {
      assert.equal(app.otel, NOOP_OTEL);
      await exercise(app.base);
      const text = await (await fetch(`${app.base}/metrics`)).text();
      assert.doesNotMatch(text, /lw_otlp_/);
      await app.otel.shutdown();
    } finally { await app.close(); }
  }
  assert.equal(r.got.length, 0);
  await r.close();
});

// ── the three signals, in both encodings, with the privacy rule ─────────────

test('http/json: traces, metrics and logs reach the receiver, and no identity does', async () => {
  const r = await receiver();
  const app = await startApp(ENDPOINT_ENV(r.url, 'http/json'));
  try {
    const { forbidden, traceId, parentSpanId } = await exercise(app.base);
    await app.otel.shutdown();
    assertNothingForbidden(r, forbidden);

    for (const c of r.got) {
      assert.equal(c.headers['content-type'], 'application/json');
      assert.equal(c.headers['x-collector-key'], 'k=1', 'OTEL_EXPORTER_OTLP_HEADERS are sent, percent-decoded');
    }
    const traces = bodies(r, '/v1/traces').map(c => JSON.parse(c.body.toString()) as J);
    assert.ok(traces.length >= 1);
    const resource = jsonAttrs(traces[0]!.resourceSpans[0].resource.attributes);
    assert.equal(resource['service.name'], 'work-under-test', 'OTEL_SERVICE_NAME wins over the resource list');
    assert.equal(resource['deployment.environment.name'], 'test');
    assert.equal(resource['service.version'], '9.9.9-test');
    const spans = traces.flatMap(t => t.resourceSpans[0].scopeSpans[0].spans as J[]);
    const user = spans.find(s => s.name === 'GET /api/v1/users/:id');
    assert.ok(user, `server span named by route pattern (got ${spans.map(s => s.name).join(', ')})`);
    assert.equal(user.kind, SPAN_KIND.server);
    assert.equal(user.traceId, traceId, 'the incoming traceparent is continued');
    assert.equal(user.parentSpanId, parentSpanId);
    assert.match(user.spanId, /^[0-9a-f]{16}$/);
    assert.ok(BigInt(user.endTimeUnixNano) >= BigInt(user.startTimeUnixNano));
    assert.deepEqual(jsonAttrs(user.attributes), {
      'http.request.method': 'GET', 'url.scheme': 'http', 'network.protocol.version': '1.1',
      'http.route': '/api/v1/users/:id', 'http.response.status_code': 200,
    });
    const unmatched = spans.find(s => jsonAttrs(s.attributes)['http.response.status_code'] === 404);
    assert.ok(unmatched && unmatched.name === 'GET' && !('http.route' in jsonAttrs(unmatched.attributes)), 'an unmatched request has no route and is named by its method');
    assert.ok(spans.some(s => s.name === 'POST /api/v1/telemetry'));
    assert.equal(new Set(spans.map(s => s.spanId)).size, spans.length, 'one span per request');

    const metrics = bodies(r, '/v1/metrics').map(c => JSON.parse(c.body.toString()) as J);
    assert.equal(metrics.length, 1, 'the shutdown sends the final reading');
    const series = metrics[0]!.resourceMetrics[0].scopeMetrics[0].metrics as J[];
    const named = (n: string): J => series.find(m => m.name === n)!;
    const http = named('lw_http_requests_total');
    assert.equal(http.sum.isMonotonic, true);
    assert.equal(http.sum.aggregationTemporality, 2, 'cumulative, like the Prometheus counter');
    const usersPoint = (http.sum.dataPoints as J[]).find(p => jsonAttrs(p.attributes).route === '/api/v1/users/:id');
    assert.deepEqual(jsonAttrs(usersPoint!.attributes), { route: '/api/v1/users/:id', status: '2xx' }, 'the same labels /metrics carries');
    assert.equal(usersPoint!.asInt, '1');
    assert.ok(named('lw_process_uptime_seconds').gauge.dataPoints[0].asDouble > 0);
    assert.equal(named('lw_process_uptime_seconds').unit, 's');
    assert.equal(named('lw_origin_bytes_total').unit, 'By');
    assert.ok(named('lw_audit_chain_intact').gauge);
    assert.ok(named('lw_otlp_exported_total'), 'the delivery counters travel too');
    const prometheus = await receiverlessScrape(app.base);
    for (const m of series) assert.ok(prometheus.has(m.name), `${m.name} is a /metrics series`);

    const logs = bodies(r, '/v1/logs').flatMap(c => (JSON.parse(c.body.toString()) as J).resourceLogs[0].scopeLogs[0].logRecords as J[]);
    const access = logs.find(l => l.body.stringValue === 'http' && jsonAttrs(l.attributes)['http.route'] === '/api/v1/users/:id');
    assert.ok(access, 'the access line is a log record');
    assert.equal(access.severityText, 'INFO');
    assert.equal(access.severityNumber, 9);
    assert.equal(access.traceId, traceId, 'a log record joins its request span');
    assert.equal(access.spanId, user.spanId);
    const warning = logs.find(l => l.body.stringValue === 'blob usage unavailable');
    assert.ok(warning);
    assert.equal(warning.severityText, 'WARN');
    assert.deepEqual(jsonAttrs(warning.attributes), { 'exception.type': 'Error' }, 'the error leaves as a type, its message stays on stdout');
  } finally {
    await app.close();
    await r.close();
  }
});

/** The series names a Prometheus scrape of /metrics returns. */
async function receiverlessScrape(base: string): Promise<Set<string>> {
  const text = await (await fetch(`${base}/metrics`)).text();
  return new Set(text.split('\n').filter(l => l.startsWith('# TYPE ')).map(l => l.split(' ')[2]!));
}

test('http/protobuf with gzip: the binary requests decode, and no identity is in the bytes', async () => {
  const r = await receiver();
  const app = await startApp({ ...ENDPOINT_ENV(r.url, 'http/protobuf'), OTEL_EXPORTER_OTLP_COMPRESSION: 'gzip' });
  try {
    const { forbidden, traceId } = await exercise(app.base);
    await app.otel.shutdown();
    assertNothingForbidden(r, forbidden);
    for (const c of r.got) {
      assert.equal(c.headers['content-type'], 'application/x-protobuf');
      assert.equal(c.headers['content-encoding'], 'gzip');
    }
    // ExportTraceServiceRequest → ResourceSpans(1) → ScopeSpans(2) → Span(2)
    const spans = bodies(r, '/v1/traces').flatMap(c => msgs(msgs(msgs(pb(c.body), 1)[0]!, 2)[0]!, 2));
    const resource = pbAttrs(msgs(msgs(pb(bodies(r, '/v1/traces')[0]!.body), 1)[0]!, 1)[0]!, 1);
    assert.equal(resource['service.name'], 'work-under-test');
    const user = spans.find(s => str(s, 5) === 'GET /api/v1/users/:id');
    assert.ok(user);
    assert.equal((user.get(1)![0] as Buffer).toString('hex'), traceId);
    assert.equal(user.get(6)![0], 2n, 'SPAN_KIND_SERVER');
    assert.deepEqual(pbAttrs(user, 9), {
      'http.request.method': 'GET', 'url.scheme': 'http', 'network.protocol.version': '1.1',
      'http.route': '/api/v1/users/:id', 'http.response.status_code': 200,
    });
    const start = (user.get(7)![0] as Buffer).readBigUInt64LE(0), end = (user.get(8)![0] as Buffer).readBigUInt64LE(0);
    assert.ok(end >= start && start > 1_700_000_000_000_000_000n, 'nanoseconds since the epoch');

    // ExportMetricsServiceRequest → ResourceMetrics → ScopeMetrics(2) → Metric(2)
    const metrics = msgs(msgs(msgs(pb(bodies(r, '/v1/metrics')[0]!.body), 1)[0]!, 2)[0]!, 2);
    const http = metrics.find(m => str(m, 1) === 'lw_http_requests_total')!;
    const sum = msgs(http, 7)[0]!;
    assert.equal(sum.get(2)![0], 2n, 'cumulative');
    assert.equal(sum.get(3)![0], 1n, 'monotonic');
    const point = msgs(sum, 1).find(p => pbAttrs(p, 7).route === '/api/v1/users/:id')!;
    assert.equal((point.get(6)![0] as Buffer).readBigInt64LE(0), 1n);
    const uptime = metrics.find(m => str(m, 1) === 'lw_process_uptime_seconds')!;
    assert.ok((msgs(msgs(uptime, 5)[0]!, 1)[0]!.get(4)![0] as Buffer).readDoubleLE(0) > 0, 'a gauge with a double value');

    // ExportLogsServiceRequest → ResourceLogs → ScopeLogs(2) → LogRecord(2)
    const logs = bodies(r, '/v1/logs').flatMap(c => msgs(msgs(msgs(pb(c.body), 1)[0]!, 2)[0]!, 2));
    const access = logs.find(l => str(msgs(l, 5)[0]!, 1) === 'http' && pbAttrs(l, 6)['http.route'] === '/api/v1/users/:id')!;
    assert.ok(access);
    assert.equal(access.get(2)![0], 9n);
    assert.equal(str(access, 3), 'INFO');
    assert.equal((access.get(9)![0] as Buffer).toString('hex'), traceId);
  } finally {
    await app.close();
    await r.close();
  }
});

// ── spans around render dispatch and database calls ─────────────────────────

test('child spans: render and database calls nest under the active span; text and values stay home', async () => {
  const r = await receiver();
  const otel = createOtel(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: r.url, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, '1').config);
  // A node-postgres pool double: pool.query takes a callback internally, a
  // checked-out client is used with promises.
  const listeners: Array<(client: unknown) => void> = [];
  const client = {
    query(_text: unknown, _values?: unknown, cb?: (err: unknown, result: unknown) => void): Promise<unknown> | undefined {
      const result = Promise.resolve({ rows: [] });
      if (!cb) return result;
      void result.then((r) => cb(null, r));
      return undefined;
    },
  };
  const pool = {
    // pg-pool's query checks out a client and calls its query with a callback.
    query: (text: unknown, values?: unknown) => new Promise((resolve, reject) => client.query(text, values, (err, r) => (err ? reject(err) : resolve(r)))),
    on: (event: string, listener: (c: unknown) => void) => { if (event === 'connect') listeners.push(listener); },
  };
  otel.instrumentPool(pool);
  for (const l of listeners) l(client);
  await pool.query('select 1 from users where email = $1', ['outside@example.com']); // no parent: not traced
  await otel.span('render', { 'lw.render.tool_id': 'qr-code', 'lw.render.format': 'png' }, async () => {
    await pool.query("select * from sessions where owner = 'carol@example.com'", ['carol@example.com']);
    await client.query('BEGIN');
    await client.query('update users set name = $1', ['Carol']);
  }, { root: true });
  await assert.rejects(otel.span('render', {}, async () => { throw Object.assign(new Error('worker busy for carol@example.com'), { code: 'RENDER_BUSY' }); }, { root: true }));
  await otel.span('not traced', {}, async () => {}); // no parent and not a root
  await otel.shutdown();
  const text = r.got.map(c => c.body.toString()).join('\n');
  for (const needle of ['carol@example.com', 'outside@example.com', 'Carol', 'owner =', 'worker busy']) assert.equal(text.includes(needle), false, needle);
  const spans = r.got.flatMap(c => (JSON.parse(c.body.toString()) as J).resourceSpans[0].scopeSpans[0].spans as J[]);
  assert.deepEqual(spans.map(s => s.name).sort(), ['BEGIN', 'SELECT sessions', 'UPDATE users', 'render', 'render']);
  const [ok, failed] = spans.filter(s => s.name === 'render');
  assert.ok(ok && failed);
  const children = spans.filter(s => s.name !== 'render');
  for (const s of children) {
    assert.equal(s.kind, SPAN_KIND.client);
    assert.equal(s.parentSpanId, ok.spanId);
    assert.equal(s.traceId, ok.traceId);
  }
  assert.deepEqual(jsonAttrs(children.find(s => s.name === 'SELECT sessions')!.attributes), { 'db.system.name': 'postgresql', 'db.operation.name': 'SELECT', 'db.collection.name': 'sessions' });
  assert.equal(ok.parentSpanId, undefined, 'a queued render is its own trace');
  assert.deepEqual(failed.status, { code: 2 });
  assert.equal(jsonAttrs(failed.attributes)['error.type'], 'RENDER_BUSY');
  await r.close();
});

// ── back-pressure ───────────────────────────────────────────────────────────

test('a stalled collector costs no request latency: the queue drops, counts and shuts down on time', async () => {
  const r = await receiver('hang');
  const app = await startApp({
    OTEL_EXPORTER_OTLP_ENDPOINT: r.url, OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none',
    OTEL_BSP_MAX_QUEUE_SIZE: '4', OTEL_BSP_MAX_EXPORT_BATCH_SIZE: '1', OTEL_BSP_SCHEDULE_DELAY: '60000', OTEL_EXPORTER_OTLP_TIMEOUT: '30000',
  });
  try {
    const started = Date.now();
    for (let i = 0; i < 30; i++) await (await fetch(`${app.base}/healthz`)).arrayBuffer();
    assert.ok(Date.now() - started < 5_000, 'thirty requests while the collector hangs');
    const text = await (await fetch(`${app.base}/metrics`)).text();
    const dropped = Number(/lw_otlp_dropped_total\{signal="traces",reason="queue_full"\} (\d+)/.exec(text)?.[1]);
    assert.ok(dropped >= 20, `spans beyond the queue are dropped and counted (${dropped})`);
    assert.match(text, /lw_otlp_exported_total\{signal="traces"\} 0/);
    const closing = Date.now();
    await app.otel.shutdown(300);
    assert.ok(Date.now() - closing < 2_000, 'shutdown is bounded even though the export never answers');
  } finally {
    await app.close();
    await r.close();
  }
});

test('a rejected export is counted as dropped, not retried forever', async () => {
  const r = await receiver('fail');
  const otel = createOtel(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_ENDPOINT: r.url, OTEL_METRICS_EXPORTER: 'none', OTEL_LOGS_EXPORTER: 'none' }, '1').config);
  const warned: string[] = [];
  const original = console.warn;
  console.warn = (line: string) => { warned.push(line); };
  try {
    await otel.span('render', {}, async () => {}, { root: true });
    await otel.shutdown();
  } finally { console.warn = original; }
  assert.equal(r.got.length, 1, 'a 400 is not retryable');
  const dropped = otel.selfMetrics().find(l => l.name === 'lw_otlp_dropped_total' && l.labels?.reason === 'export_failed' && l.labels.signal === 'traces');
  assert.equal(dropped?.value, 1);
  assert.equal(warned.length, 1);
  assert.match(warned[0]!, /otlp traces export failed \(HTTP 400/);
  await r.close();
});

test('delta temporality reports the change since the last export', async () => {
  const r = await receiver();
  const otel = createOtel(otelConfigFromEnv({ OTEL_EXPORTER_OTLP_METRICS_ENDPOINT: `${r.url}/v1/metrics`, OTEL_EXPORTER_OTLP_PROTOCOL: 'http/json', OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE: 'delta' }, '1').config);
  assert.deepEqual(otel.signals, { traces: false, metrics: true, logs: false });
  otel.setMetricSource(async () => [{ name: 'lw_test_total', help: 'h', type: 'counter', value: 5 }, { name: 'lw_test_gauge', help: 'g', type: 'gauge', value: 2.5 }]);
  await otel.shutdown(); // the shutdown sends one reading
  const series = (JSON.parse(r.got[0]!.body.toString()) as J).resourceMetrics[0].scopeMetrics[0].metrics as J[];
  const counter = series.find(m => m.name === 'lw_test_total')!;
  assert.equal(counter.sum.aggregationTemporality, 1);
  assert.equal(counter.sum.dataPoints[0].asInt, '5', 'the first delta is the whole count since start');
  assert.equal(series.find(m => m.name === 'lw_test_gauge')!.gauge.dataPoints[0].asDouble, 2.5);
  assert.equal(series.find(m => m.name === 'lw_test_gauge')!.gauge.dataPoints[0].startTimeUnixNano, undefined, 'a gauge has no start time');
  await r.close();
});

test('the encoders agree on one span and one point', () => {
  const envelope = { resource: { 'service.name': 's' }, scope: { name: 'lolly-work', version: '1' } };
  const span = { traceId: 'a'.repeat(32), spanId: 'b'.repeat(16), name: 'n', kind: SPAN_KIND.internal, startNs: 1n, endNs: 2n, attributes: { k: 'v', i: -3, d: 0.5, b: true }, status: 0 };
  const json = JSON.parse(Buffer.from(encodeTraces(envelope, [span], 'http/json')).toString()) as J;
  const proto = msgs(msgs(msgs(pb(Buffer.from(encodeTraces(envelope, [span], 'http/protobuf'))), 1)[0]!, 2)[0]!, 2)[0]!;
  assert.deepEqual(jsonAttrs(json.resourceSpans[0].scopeSpans[0].spans[0].attributes), pbAttrs(proto, 9));
  assert.deepEqual(pbAttrs(proto, 9), { k: 'v', i: -3, d: 0.5, b: true });
  const metric = { name: 'm', description: 'd', unit: '', points: [{ attributes: {}, startNs: 0n, timeNs: 5n, value: -7 }] };
  const point = msgs(msgs(msgs(msgs(msgs(pb(Buffer.from(encodeMetrics(envelope, [metric], 'http/protobuf'))), 1)[0]!, 2)[0]!, 2)[0]!, 5)[0]!, 1)[0]!;
  assert.equal((point.get(6)![0] as Buffer).readBigInt64LE(0), -7n);
  assert.equal(point.has(2), false, 'no start time on a gauge');
});

test('the structured logger hands each record to the tap', () => {
  const seen: unknown[] = [];
  const log = createLogger({}, { out: () => {}, err: () => {} }, (level, msg, fields) => seen.push([level, msg, fields]));
  log('warn', 'w', { a: 1 });
  log('info', 'i');
  assert.deepEqual(seen, [['warn', 'w', { a: 1 }], ['info', 'i', undefined]]);
});
