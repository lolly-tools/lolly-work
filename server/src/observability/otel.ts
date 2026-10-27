// SPDX-License-Identifier: MPL-2.0
/**
 * OpenTelemetry export for platform teams that run their own observability
 * stack: traces, metrics and logs sent over OTLP/HTTP to the collector or
 * backend named in the standard OTEL_* variables (otel-config.ts).
 *
 * Off unless configured. Without an endpoint `createOtel(null)` returns the
 * no-op below: no timer, no socket, no span object, no context store, and the
 * request path calls the handler directly.
 *
 * What leaves the instance is fixed here, by allowlist, not by review of each
 * call site. Work's telemetry floor says nothing about identity leaves the
 * instance, and that holds for this export too:
 *   - spans carry the request method, the matched ROUTE PATTERN
 *     (`/api/v1/users/:id`, never the path), the status code, the protocol
 *     version and the scheme; never the path, the query string, a header,
 *     a cookie, the client address, the user agent or a body;
 *   - database spans carry the statement's operation and table, never its text
 *     or parameters;
 *   - render spans carry the tool id and output format, the labels usage
 *     telemetry already allows;
 *   - log records carry the logger's static message and five mapped fields;
 *     an error travels as its type, never its message;
 *   - metrics are the `/metrics` series, which are aggregates by design.
 * An incoming `tracestate` is not kept: it is caller-controlled free text.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomFillSync } from 'node:crypto';
import { isIP } from 'node:net';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { TLSSocket } from 'node:tls';
import type { GaugeLine } from './metrics.ts';
import type { LogLevel } from './log.ts';
import type { ExporterConfig, OtelConfig, SamplerConfig, Signal } from './otel-config.ts';
import { SIGNALS } from './otel-config.ts';
import {
  encodeLogs, encodeMetrics, encodeTraces, SPAN_KIND, STATUS, TEMPORALITY,
  type Attrs, type Envelope, type LogData, type MetricData, type SpanData,
} from './otlp-encode.ts';
import { BatchQueue, createSender, type QueueOutcome, type SendFailure, type Sender } from './otlp-export.ts';

/** Handed to the request handler so the span can read the matched route when it ends. */
export interface RequestSpan { routeFrom(read: () => string): void }

export interface Otel {
  readonly enabled: boolean;
  readonly signals: Readonly<Record<Signal, boolean>>;
  /** Run one HTTP request under a server span (or straight through when tracing is off). */
  serve(req: IncomingMessage, res: ServerResponse, handler: (span: RequestSpan | undefined) => Promise<void>): Promise<void>;
  /** Run `fn` under an internal or client span. Without a sampled parent the
   *  work is traced only when `root` is set (background work such as a queued render). */
  span<T>(name: string, attributes: Attrs, fn: () => Promise<T>, opts?: { kind?: 'internal' | 'client'; root?: boolean }): Promise<T>;
  /** One structured logger record (log.ts). */
  log(level: LogLevel, msg: string, fields: Record<string, unknown> | undefined): void;
  /** The series `/metrics` serves; read once per export interval. */
  setMetricSource(source: () => Promise<GaugeLine[]>): void;
  /** Trace this node-postgres pool's queries under the active span. */
  instrumentPool(pool: object): void;
  /** Exported and dropped counts, for `/metrics`. Empty when export is off. */
  selfMetrics(): GaugeLine[];
  /** Export what is waiting and close the connections, within `timeoutMs`. */
  shutdown(timeoutMs?: number): Promise<void>;
}

const OFF: Readonly<Record<Signal, boolean>> = Object.freeze({ traces: false, metrics: false, logs: false });

export const NOOP_OTEL: Otel = Object.freeze({
  enabled: false,
  signals: OFF,
  serve: (_req: IncomingMessage, _res: ServerResponse, handler: (span: RequestSpan | undefined) => Promise<void>) => handler(undefined),
  span: <T>(_name: string, _attributes: Attrs, fn: () => Promise<T>) => fn(),
  log: () => {},
  setMetricSource: () => {},
  instrumentPool: () => {},
  selfMetrics: () => [],
  shutdown: async () => {},
});

// The process-wide exporter, for code that has no dependency injection of its
// own: database pools are built inside the stores (pg-options.ts guardPool).
let processWide: Otel = NOOP_OTEL;
export function setProcessOtel(otel: Otel): void { processWide = otel; }
export function processOtel(): Otel { return processWide; }

// ── ids, time, context ──────────────────────────────────────────────────────

const idPool = Buffer.alloc(4096);
let idAt = idPool.length;
function randomHex(bytes: number): string {
  if (idAt + bytes > idPool.length) { randomFillSync(idPool); idAt = 0; }
  const hex = idPool.toString('hex', idAt, idAt + bytes);
  idAt += bytes;
  return /^0+$/.test(hex) ? randomHex(bytes) : hex; // an all-zero id is invalid
}
const nowNs = (): bigint => BigInt(Math.round((performance.timeOrigin + performance.now()) * 1000)) * 1000n;
const PROCESS_START_NS = BigInt(Math.round(performance.timeOrigin * 1000)) * 1000n;

interface TraceCtx { traceId: string; spanId: string; sampled: boolean }

const TRACEPARENT = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})(-.*)?$/;
/** W3C Trace Context `traceparent`, level 1. Anything malformed starts a new trace. */
export function parseTraceparent(header: string | string[] | undefined): TraceCtx | undefined {
  const value = (Array.isArray(header) ? header[0] : header)?.trim().toLowerCase();
  const m = value ? TRACEPARENT.exec(value) : null;
  if (!m) return undefined;
  const [, version, traceId, spanId, flags, rest] = m as unknown as [string, string, string, string, string, string | undefined];
  if (version === 'ff' || (version === '00' && rest) || /^0+$/.test(traceId) || /^0+$/.test(spanId)) return undefined;
  return { traceId, spanId, sampled: (parseInt(flags, 16) & 1) === 1 };
}

/** The root decision for a new trace; a parent's flag decides when parent-based. */
export function sampled(sampler: SamplerConfig, traceId: string, parent: TraceCtx | undefined): boolean {
  if (parent && sampler.parentBased) return parent.sampled;
  if (sampler.root === 'always_on') return true;
  if (sampler.root === 'always_off') return false;
  // TraceIdRatioBased: the low 52 bits of the trace id against the ratio, so
  // every service that sees this trace with the same ratio decides the same way.
  return parseInt(traceId.slice(-13), 16) < sampler.ratio * 2 ** 52;
}

// ── what may leave ──────────────────────────────────────────────────────────

const METHODS = new Set(['CONNECT', 'DELETE', 'GET', 'HEAD', 'OPTIONS', 'PATCH', 'POST', 'PUT', 'TRACE']);
const methodOf = (m: string | undefined): string => (m && METHODS.has(m) ? m : '_OTHER');

/** An error as a type: its code (`RENDER_BUSY`) or class name (`WorkerError`), never its message. */
export function errorType(err: unknown): string {
  const code = (err as { code?: unknown })?.code;
  if (typeof code === 'string' && /^[A-Z][A-Z0-9_]{1,63}$/.test(code)) return code;
  const name = (err as { name?: unknown })?.name;
  return typeof name === 'string' && /^[A-Za-z][A-Za-z0-9]{0,63}$/.test(name) ? name : 'Error';
}

const EMAIL = /[^\s@<>"'(),;:]+@[^\s@<>"'(),;:]+\.[a-z]{2,}/gi;
const CREDENTIAL = /\b(?:bearer|basic)\s+[A-Za-z0-9._~+/=-]+|\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/gi;
const QUERY = /\?[^\s"'<>]*/g;
const ADDRESS_LIKE = /[0-9a-fA-F:.]{3,}/g;
/** Defence in depth for the one free-text value that leaves: a log record's
 *  message, which today is always a literal in the code. */
export function scrubText(text: string): string {
  return text.slice(0, 512)
    .replace(EMAIL, '[email]')
    .replace(CREDENTIAL, '[credential]')
    .replace(QUERY, '?[query]')
    .replace(ADDRESS_LIKE, (token) => (isIP(token) || isIP(token.replace(/[.:]+$/, '')) ? '[address]' : token));
}

/** The logger's fields that may leave, renamed to semantic-convention keys.
 *  Everything else (a request id the caller chose, any future field) stays on stdout. */
export function logAttributes(fields: Record<string, unknown> | undefined): Attrs {
  const out: Attrs = {};
  if (!fields) return out;
  if (typeof fields.method === 'string') out['http.request.method'] = methodOf(fields.method);
  if (typeof fields.route === 'string') {
    if (fields.route.startsWith('/')) out['http.route'] = fields.route;
    else if (/^[a-z-]+(?::[a-z-]+)?$/.test(fields.route)) out['lw.route_class'] = fields.route;
  }
  if (typeof fields.status === 'number' && Number.isInteger(fields.status)) out['http.response.status_code'] = fields.status;
  if (typeof fields.ms === 'number' && Number.isFinite(fields.ms)) out['lw.duration_ms'] = fields.ms;
  if (fields.error !== undefined) out['exception.type'] = errorType(fields.error);
  return out;
}

const SEVERITY: Record<LogLevel, [number, string]> = { debug: [5, 'DEBUG'], info: [9, 'INFO'], warn: [13, 'WARN'], error: [17, 'ERROR'] };

const SQL_OPERATIONS = new Set(['SELECT', 'INSERT', 'UPDATE', 'DELETE', 'WITH', 'BEGIN', 'COMMIT', 'ROLLBACK', 'SAVEPOINT', 'RELEASE',
  'CREATE', 'ALTER', 'DROP', 'TRUNCATE', 'LOCK', 'SET', 'SHOW', 'VALUES', 'CALL', 'NOTIFY', 'LISTEN', 'UNLISTEN', 'COPY', 'VACUUM', 'ANALYZE']);
/** The operation and table of a statement: schema names written in the code,
 *  never the statement or a value. */
export function sqlSummary(text: unknown): { operation: string; table?: string } {
  const sql = typeof text === 'string' ? text.replace(/^(?:\s|--[^\n]*\n)+/, '') : '';
  const word = /^[A-Za-z]+/.exec(sql)?.[0]?.toUpperCase() ?? '';
  const operation = SQL_OPERATIONS.has(word) ? word : 'QUERY';
  const pattern = operation === 'SELECT' || operation === 'DELETE' ? /\bfrom\s+([A-Za-z_][A-Za-z0-9_]*)/i
    : operation === 'INSERT' ? /^insert\s+into\s+([A-Za-z_][A-Za-z0-9_]*)/i
      : operation === 'UPDATE' ? /^update\s+([A-Za-z_][A-Za-z0-9_]*)/i : null;
  const table = pattern?.exec(sql)?.[1]?.toLowerCase();
  return table ? { operation, table } : { operation };
}

const unitOf = (name: string): string =>
  /_bytes(_total)?$/.test(name) ? 'By' : /_seconds(_total)?$/.test(name) ? 's' : /_days$/.test(name) ? 'd' : '';

// ── the exporter ────────────────────────────────────────────────────────────

export function createOtel(config: OtelConfig | null): Otel {
  if (!config) return NOOP_OTEL;
  const envelope: Envelope = { resource: config.resource, scope: config.scope };
  const signals = Object.freeze({ traces: !!config.traces, metrics: !!config.metrics, logs: !!config.logs });
  const als = new AsyncLocalStorage<TraceCtx>();

  // lw_otlp_exported_total / lw_otlp_dropped_total, by signal (and reason).
  const counts = new Map<string, number>();
  const count = (signal: Signal, outcome: QueueOutcome, n: number): void => {
    const key = `${signal}|${outcome}`;
    counts.set(key, (counts.get(key) ?? 0) + n);
  };
  // A collector that is down fails every export. Say so on stdout once, then
  // at most every five minutes; never through the OTLP logger, which would feed itself.
  const lastWarned = new Map<Signal, number>();
  const failures = new Map<Signal, number>();
  const warnFailure = (signal: Signal, failure: SendFailure): void => {
    failures.set(signal, (failures.get(signal) ?? 0) + 1);
    const at = lastWarned.get(signal);
    if (at !== undefined && Date.now() - at < 300_000) return;
    lastWarned.set(signal, Date.now());
    const why = failure.status !== undefined ? `HTTP ${failure.status}` : failure.error ?? 'error';
    console.warn(`[lolly-work] WARNING otlp ${signal} export failed (${why}; ${failures.get(signal)} failure(s) since the last notice). Dropped items are counted in lw_otlp_dropped_total.`);
    failures.set(signal, 0);
  };

  const senders: Sender[] = [];
  const senderFor = (cfg: ExporterConfig): Sender => {
    const sender = createSender(cfg, (f) => warnFailure(cfg.signal, f));
    senders.push(sender);
    return sender;
  };

  const traceCfg = config.traces;
  const spanQueue = traceCfg ? (() => {
    const sender = senderFor(traceCfg);
    return new BatchQueue<SpanData>(config.spanBatch,
      (spans, deadline) => sender.send(encodeTraces(envelope, spans, traceCfg.protocol), deadline),
      (outcome, n) => count('traces', outcome, n));
  })() : undefined;

  const logCfg = config.logs;
  const logQueue = logCfg ? (() => {
    const sender = senderFor(logCfg);
    return new BatchQueue<LogData>(config.logBatch,
      (logs, deadline) => sender.send(encodeLogs(envelope, logs, logCfg.protocol), deadline),
      (outcome, n) => count('logs', outcome, n));
  })() : undefined;

  const record = (span: SpanData): void => spanQueue?.push(span);

  // ── metrics: read the /metrics series on an interval ──
  const metricCfg = config.metrics;
  const metricSender = metricCfg ? senderFor(metricCfg) : undefined;
  let metricSource: (() => Promise<GaugeLine[]>) | undefined;
  let metricTimer: NodeJS.Timeout | undefined;
  let metricRun: Promise<void> | undefined;
  const lastValues = new Map<string, number>();
  let lastExportNs = PROCESS_START_NS;

  const toMetricData = (lines: GaugeLine[], timeNs: bigint): MetricData[] => {
    const byName = new Map<string, MetricData>();
    for (const line of lines) {
      if (!Number.isFinite(line.value)) continue;
      let metric = byName.get(line.name);
      if (!metric) {
        metric = { name: line.name, description: line.help, unit: unitOf(line.name), points: [],
          ...(line.type === 'counter' ? { sum: { temporality: config.temporality === 'delta' ? TEMPORALITY.delta : TEMPORALITY.cumulative } } : {}) };
        byName.set(line.name, metric);
      }
      const attributes: Attrs = { ...line.labels };
      if (!metric.sum) { metric.points.push({ attributes, startNs: 0n, timeNs, value: line.value }); continue; }
      if (config.temporality === 'cumulative') { metric.points.push({ attributes, startNs: PROCESS_START_NS, timeNs, value: line.value }); continue; }
      const key = `${line.name}{${Object.keys(attributes).sort().map(k => `${k}=${attributes[k]}`).join(',')}}`;
      const previous = lastValues.get(key) ?? 0;
      lastValues.set(key, line.value);
      metric.points.push({ attributes, startNs: lastExportNs, timeNs, value: line.value >= previous ? line.value - previous : line.value });
    }
    return [...byName.values()];
  };

  const exportMetrics = (deadline: number): Promise<void> => {
    if (!metricSender || !metricSource || !metricCfg) return Promise.resolve();
    if (metricRun) return metricRun;
    const source = metricSource;
    metricRun = (async () => {
      let timer: NodeJS.Timeout | undefined;
      const timedOut = new Promise<null>((resolve) => { timer = setTimeout(() => resolve(null), Math.max(0, deadline - Date.now())); timer.unref(); });
      const lines = await Promise.race([source().catch(() => null), timedOut]);
      clearTimeout(timer);
      if (!lines) { warnFailure('metrics', { error: 'collection' }); return; }
      const timeNs = nowNs();
      const data = toMetricData(lines, timeNs);
      lastExportNs = timeNs;
      const points = data.reduce((n, m) => n + m.points.length, 0);
      if (!points) return;
      const ok = await metricSender.send(encodeMetrics(envelope, data, metricCfg.protocol), deadline).catch(() => false);
      count('metrics', ok ? 'exported' : 'export_failed', points);
    })().finally(() => { metricRun = undefined; });
    return metricRun;
  };

  // ── spans ──
  const startChild = (name: string, kind: number, attributes: Attrs, root: boolean): { ctx: TraceCtx; end: (err?: unknown) => void } | { ctx: TraceCtx | undefined; end?: undefined } => {
    const parent = als.getStore();
    if (!traceCfg || (parent && !parent.sampled) || (!parent && !root)) return { ctx: undefined };
    const traceId = parent?.traceId ?? randomHex(16);
    const spanId = randomHex(8);
    if (!parent && !sampled(config.sampler, traceId, undefined)) return { ctx: { traceId, spanId, sampled: false } };
    const startNs = nowNs();
    return {
      ctx: { traceId, spanId, sampled: true },
      end: (err?: unknown) => {
        const attrs = err === undefined ? attributes : { ...attributes, 'error.type': errorType(err) };
        record({ traceId, spanId, ...(parent ? { parentSpanId: parent.spanId } : {}), name, kind, startNs, endNs: nowNs(), attributes: attrs, status: err === undefined ? STATUS.unset : STATUS.error });
      },
    };
  };

  let closed = false;
  const otel: Otel = {
    enabled: true,
    signals,

    serve(req, res, handler) {
      if (!traceCfg) return handler(undefined);
      const parent = config.propagate ? parseTraceparent(req.headers.traceparent) : undefined;
      const traceId = parent?.traceId ?? randomHex(16);
      const ctx: TraceCtx = { traceId, spanId: randomHex(8), sampled: sampled(config.sampler, traceId, parent) };
      if (!ctx.sampled) return als.run(ctx, () => handler(undefined));
      const startNs = nowNs();
      let readRoute: (() => string) | undefined;
      res.once('close', () => {
        const method = methodOf(req.method);
        const route = readRoute?.();
        const attributes: Attrs = {
          'http.request.method': method,
          'url.scheme': (req.socket as TLSSocket | null)?.encrypted ? 'https' : 'http',
          'network.protocol.version': req.httpVersion,
        };
        if (route?.startsWith('/')) attributes['http.route'] = route;
        if (res.headersSent) attributes['http.response.status_code'] = res.statusCode;
        const failed = res.headersSent && res.statusCode >= 500;
        if (failed) attributes['error.type'] = String(res.statusCode);
        const base = method === '_OTHER' ? 'HTTP' : method;
        record({
          traceId, spanId: ctx.spanId, ...(parent ? { parentSpanId: parent.spanId } : {}),
          name: attributes['http.route'] ? `${base} ${route}` : base,
          kind: SPAN_KIND.server, startNs, endNs: nowNs(), attributes, status: failed ? STATUS.error : STATUS.unset,
        });
      });
      return als.run(ctx, () => handler({ routeFrom(read) { readRoute = read; } }));
    },

    async span(name, attributes, fn, opts = {}) {
      const { ctx, end } = startChild(name, opts.kind === 'client' ? SPAN_KIND.client : SPAN_KIND.internal, attributes, opts.root === true);
      if (!ctx) return fn();
      if (!end) return als.run(ctx, fn);
      try {
        const out = await als.run(ctx, fn);
        end();
        return out;
      } catch (err) {
        end(err);
        throw err;
      }
    },

    log(level, msg, fields) {
      if (!logQueue) return;
      const ctx = als.getStore();
      const [severityNumber, severityText] = SEVERITY[level];
      logQueue.push({
        timeNs: nowNs(), severityNumber, severityText, body: scrubText(msg), attributes: logAttributes(fields),
        ...(ctx?.sampled ? { traceId: ctx.traceId, spanId: ctx.spanId } : {}),
      });
    },

    setMetricSource(source) {
      if (!metricCfg || closed) return;
      metricSource = source;
      if (!metricTimer) {
        metricTimer = setInterval(() => void exportMetrics(Date.now() + config.metricTimeoutMs), config.metricIntervalMs);
        metricTimer.unref();
      }
    },

    instrumentPool(pool) {
      if (!traceCfg) return;
      const target = pool as { query?: (...args: unknown[]) => unknown; on?: (event: string, listener: (client: unknown) => void) => void };
      const dbSpan = (statement: unknown): ((err?: unknown) => void) | undefined => {
        const text = typeof statement === 'string' ? statement : (statement as { text?: unknown } | null)?.text;
        const { operation, table } = sqlSummary(text);
        const attributes: Attrs = { 'db.system.name': 'postgresql', 'db.operation.name': operation, ...(table ? { 'db.collection.name': table } : {}) };
        return startChild(table ? `${operation} ${table}` : operation, SPAN_KIND.client, attributes, false).end;
      };
      const settle = (result: unknown, end: (err?: unknown) => void): unknown => {
        if (result && typeof (result as Promise<unknown>).then === 'function') {
          (result as Promise<unknown>).then(() => end(), (err) => end(err));
        } else end();
        return result;
      };
      // pool.query: the caller's context is the one current at the call, even
      // when the pool is busy and the query runs later on a freed client.
      const poolQuery = target.query;
      if (typeof poolQuery === 'function') {
        target.query = function (this: unknown, ...args: unknown[]) {
          const end = dbSpan(args[0]);
          if (!end) return Reflect.apply(poolQuery, this, args);
          const cb = args.findIndex(a => typeof a === 'function');
          if (cb >= 0) {
            const callback = args[cb] as (err: unknown, value: unknown) => unknown;
            args[cb] = (err: unknown, value: unknown) => { end(err ?? undefined); return callback(err, value); };
            return Reflect.apply(poolQuery, this, args);
          }
          try { return settle(Reflect.apply(poolQuery, this, args), end); } catch (err) { end(err); throw err; }
        };
      }
      // Checked-out clients (transactions). pg-pool's own query passes a
      // callback, and pool.query above already traced it, so only the
      // promise form is traced here.
      target.on?.('connect', (client) => {
        const c = client as { query?: (...args: unknown[]) => unknown };
        const clientQuery = c.query;
        if (typeof clientQuery !== 'function') return;
        c.query = function (this: unknown, ...args: unknown[]) {
          const submittable = typeof (args[0] as { submit?: unknown } | null)?.submit === 'function';
          const end = args.some(a => typeof a === 'function') || submittable ? undefined : dbSpan(args[0]);
          if (!end) return Reflect.apply(clientQuery, this, args);
          try { return settle(Reflect.apply(clientQuery, this, args), end); } catch (err) { end(err); throw err; }
        };
      });
    },

    selfMetrics() {
      const lines: GaugeLine[] = [];
      for (const signal of SIGNALS) {
        if (!signals[signal]) continue;
        lines.push({ name: 'lw_otlp_exported_total', help: 'Spans, data points and log records the OTLP receiver accepted, by signal.', type: 'counter', labels: { signal }, value: counts.get(`${signal}|exported`) ?? 0 });
      }
      for (const signal of SIGNALS) {
        if (!signals[signal]) continue;
        for (const reason of signal === 'metrics' ? ['export_failed'] : ['queue_full', 'export_failed']) {
          lines.push({ name: 'lw_otlp_dropped_total', help: 'Telemetry not delivered over OTLP: the queue was full or the export failed.', type: 'counter', labels: { signal, reason }, value: counts.get(`${signal}|${reason}`) ?? 0 });
        }
      }
      return lines;
    },

    async shutdown(timeoutMs = 5_000) {
      if (closed) return;
      closed = true;
      if (metricTimer) clearInterval(metricTimer);
      const deadline = Date.now() + timeoutMs;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([
        Promise.allSettled([spanQueue?.shutdown(), logQueue?.shutdown(), exportMetrics(deadline)]),
        new Promise<void>((resolve) => { timer = setTimeout(resolve, timeoutMs); timer.unref(); }),
      ]);
      clearTimeout(timer);
      for (const sender of senders) sender.close();
    },
  };
  return otel;
}
