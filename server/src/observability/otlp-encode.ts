// SPDX-License-Identifier: MPL-2.0
/**
 * OTLP request bodies for traces, metrics and logs, written by hand in both
 * encodings the OTLP/HTTP transport defines: binary protobuf
 * (`http/protobuf`, the OpenTelemetry default) and JSON (`http/json`).
 *
 * Zero dependencies, like the S3 SigV4 client: the three export requests use
 * a small, stable subset of opentelemetry-proto v1 (resource, one scope, and
 * spans, number data points or log records), so a forty-line protobuf writer
 * covers them without pulling a code generator, protobufjs or the SDK into the
 * server image. Field numbers below are those of opentelemetry-proto
 * `opentelemetry/proto/{common,resource,trace,metrics,logs}/v1/*.proto`.
 *
 * JSON follows the OTLP/JSON rules, which differ from the generic protobuf
 * JSON mapping: trace and span ids are lowercase hex, not base64; enums are
 * integers; 64-bit integers are decimal strings.
 */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;
export type OtlpProtocol = 'http/protobuf' | 'http/json';

/** opentelemetry.proto.trace.v1.Span.SpanKind */
export const SPAN_KIND = { internal: 1, server: 2, client: 3 } as const;
/** opentelemetry.proto.trace.v1.Status.StatusCode */
export const STATUS = { unset: 0, ok: 1, error: 2 } as const;
/** opentelemetry.proto.metrics.v1.AggregationTemporality */
export const TEMPORALITY = { delta: 1, cumulative: 2 } as const;

export interface SpanData {
  traceId: string; // 32 hex
  spanId: string; // 16 hex
  parentSpanId?: string;
  name: string;
  kind: number;
  startNs: bigint;
  endNs: bigint;
  attributes: Attrs;
  status: number;
}

export interface LogData {
  timeNs: bigint;
  severityNumber: number;
  severityText: string;
  body: string;
  attributes: Attrs;
  traceId?: string;
  spanId?: string;
}

/** `startNs` 0 leaves the start time unset, as a gauge's is. */
export interface PointData { attributes: Attrs; startNs: bigint; timeNs: bigint; value: number }
export interface MetricData {
  name: string;
  description: string;
  unit: string;
  /** A gauge, or a monotonic sum with the given temporality. */
  sum?: { temporality: number };
  points: PointData[];
}

/** What every request carries: the resource and the instrumentation scope. */
export interface Envelope { resource: Attrs; scope: { name: string; version: string } }

// ── protobuf writer ─────────────────────────────────────────────────────────

const utf8 = new TextEncoder();

function varint(value: number | bigint): number[] {
  let v = BigInt.asUintN(64, BigInt(value));
  const out: number[] = [];
  while (v >= 0x80n) { out.push(Number(v & 0x7fn) | 0x80); v >>= 7n; }
  out.push(Number(v));
  return out;
}

/** One message under construction. Each method appends a field; `bytes()`
 *  returns the encoded message, ready to nest with `message()`. */
class Pb {
  private parts: Uint8Array[] = [];
  private head(field: number, wire: number): void { this.parts.push(Uint8Array.from(varint((field << 3) | wire))); }
  private delimited(field: number, body: Uint8Array): this {
    this.head(field, 2);
    this.parts.push(Uint8Array.from(varint(body.length)), body);
    return this;
  }
  string(field: number, value: string | undefined, always = false): this {
    return value || always ? this.delimited(field, utf8.encode(value ?? '')) : this;
  }
  hexBytes(field: number, hex: string | undefined): this {
    return hex ? this.delimited(field, Uint8Array.from(Buffer.from(hex, 'hex'))) : this;
  }
  message(field: number, body: Pb): this { return this.delimited(field, body.bytes()); }
  uint(field: number, value: number | bigint, always = false): this {
    if (!value && !always) return this;
    this.head(field, 0);
    this.parts.push(Uint8Array.from(varint(value)));
    return this;
  }
  fixed64(field: number, value: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt.asUintN(64, value), true);
    this.head(field, 1);
    this.parts.push(b);
    return this;
  }
  sfixed64(field: number, value: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigInt64(0, value, true);
    this.head(field, 1);
    this.parts.push(b);
    return this;
  }
  double(field: number, value: number): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setFloat64(0, value, true);
    this.head(field, 1);
    this.parts.push(b);
    return this;
  }
  fixed32(field: number, value: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, value >>> 0, true);
    this.head(field, 5);
    this.parts.push(b);
    return this;
  }
  bytes(): Uint8Array {
    const size = this.parts.reduce((n, p) => n + p.length, 0);
    const out = new Uint8Array(size);
    let at = 0;
    for (const p of this.parts) { out.set(p, at); at += p.length; }
    return out;
  }
}

const isInt = (v: number): boolean => Number.isSafeInteger(v);

/** common.v1.AnyValue: string 1, bool 2, int64 3, double 4. A oneof member is
 *  written even when it holds the default, so an empty string still says "string". */
function pbAnyValue(v: AttrValue): Pb {
  const m = new Pb();
  if (typeof v === 'string') return m.string(1, v, true);
  if (typeof v === 'boolean') return m.uint(2, v ? 1 : 0, true);
  return isInt(v) ? m.uint(3, BigInt(v), true) : m.double(4, v);
}
/** common.v1.KeyValue: key 1, value 2. */
function pbAttrs(m: Pb, field: number, attrs: Attrs): Pb {
  for (const [key, value] of Object.entries(attrs)) m.message(field, new Pb().string(1, key, true).message(2, pbAnyValue(value)));
  return m;
}
/** resource.v1.Resource (attributes 1) and common.v1.InstrumentationScope (name 1, version 2). */
const pbResource = (e: Envelope): Pb => pbAttrs(new Pb(), 1, e.resource);
const pbScope = (e: Envelope): Pb => new Pb().string(1, e.scope.name).string(2, e.scope.version);

// ── JSON ────────────────────────────────────────────────────────────────────

type Json = Record<string, unknown>;
const jsonAnyValue = (v: AttrValue): Json =>
  typeof v === 'string' ? { stringValue: v }
    : typeof v === 'boolean' ? { boolValue: v }
      : isInt(v) ? { intValue: String(v) } : { doubleValue: v };
const jsonAttrs = (attrs: Attrs): Json[] => Object.entries(attrs).map(([key, value]) => ({ key, value: jsonAnyValue(value) }));
const jsonResource = (e: Envelope): Json => ({ attributes: jsonAttrs(e.resource) });
const jsonScope = (e: Envelope): Json => ({ name: e.scope.name, version: e.scope.version });
const toBytes = (body: unknown): Uint8Array => utf8.encode(JSON.stringify(body));

// ── traces ──────────────────────────────────────────────────────────────────

/** collector.trace.v1.ExportTraceServiceRequest. */
export function encodeTraces(e: Envelope, spans: SpanData[], protocol: OtlpProtocol): Uint8Array {
  if (protocol === 'http/json') {
    return toBytes({ resourceSpans: [{ resource: jsonResource(e), scopeSpans: [{ scope: jsonScope(e), spans: spans.map(s => ({
      traceId: s.traceId, spanId: s.spanId, ...(s.parentSpanId ? { parentSpanId: s.parentSpanId } : {}),
      flags: 1, name: s.name, kind: s.kind,
      startTimeUnixNano: String(s.startNs), endTimeUnixNano: String(s.endNs),
      attributes: jsonAttrs(s.attributes), status: s.status ? { code: s.status } : {},
    })) }] }] });
  }
  // ResourceSpans: resource 1, scope_spans 2. ScopeSpans: scope 1, spans 2.
  // Span: trace_id 1, span_id 2, parent_span_id 4, name 5, kind 6, start 7,
  // end 8, attributes 9, status 15 (code 3), flags 16 (sampled bit).
  const scopeSpans = new Pb().message(1, pbScope(e));
  for (const s of spans) {
    const span = new Pb().hexBytes(1, s.traceId).hexBytes(2, s.spanId).hexBytes(4, s.parentSpanId)
      .string(5, s.name, true).uint(6, s.kind).fixed64(7, s.startNs).fixed64(8, s.endNs);
    pbAttrs(span, 9, s.attributes);
    span.message(15, new Pb().uint(3, s.status)).fixed32(16, 1);
    scopeSpans.message(2, span);
  }
  return new Pb().message(1, new Pb().message(1, pbResource(e)).message(2, scopeSpans)).bytes();
}

// ── metrics ─────────────────────────────────────────────────────────────────

/** collector.metrics.v1.ExportMetricsServiceRequest. Gauges and monotonic
 *  sums of number data points, the two shapes the Prometheus series map to. */
export function encodeMetrics(e: Envelope, metrics: MetricData[], protocol: OtlpProtocol): Uint8Array {
  if (protocol === 'http/json') {
    const points = (m: MetricData): Json[] => m.points.map(p => ({
      attributes: jsonAttrs(p.attributes), ...(p.startNs ? { startTimeUnixNano: String(p.startNs) } : {}), timeUnixNano: String(p.timeNs),
      ...(isInt(p.value) ? { asInt: String(p.value) } : { asDouble: p.value }),
    }));
    return toBytes({ resourceMetrics: [{ resource: jsonResource(e), scopeMetrics: [{ scope: jsonScope(e), metrics: metrics.map(m => ({
      name: m.name, description: m.description, ...(m.unit ? { unit: m.unit } : {}),
      ...(m.sum
        ? { sum: { dataPoints: points(m), aggregationTemporality: m.sum.temporality, isMonotonic: true } }
        : { gauge: { dataPoints: points(m) } }),
    })) }] }] });
  }
  // Metric: name 1, description 2, unit 3, gauge 5, sum 7. Gauge: data_points 1.
  // Sum: data_points 1, aggregation_temporality 2, is_monotonic 3.
  // NumberDataPoint: start 2, time 3, as_double 4, as_int 6, attributes 7.
  const scopeMetrics = new Pb().message(1, pbScope(e));
  for (const m of metrics) {
    const data = new Pb();
    for (const p of m.points) {
      const point = p.startNs ? new Pb().fixed64(2, p.startNs) : new Pb();
      point.fixed64(3, p.timeNs);
      if (isInt(p.value)) point.sfixed64(6, BigInt(p.value)); else point.double(4, p.value);
      data.message(1, pbAttrs(point, 7, p.attributes));
    }
    if (m.sum) data.uint(2, m.sum.temporality).uint(3, 1);
    scopeMetrics.message(2, new Pb().string(1, m.name, true).string(2, m.description).string(3, m.unit).message(m.sum ? 7 : 5, data));
  }
  return new Pb().message(1, new Pb().message(1, pbResource(e)).message(2, scopeMetrics)).bytes();
}

// ── logs ────────────────────────────────────────────────────────────────────

/** collector.logs.v1.ExportLogsServiceRequest. */
export function encodeLogs(e: Envelope, logs: LogData[], protocol: OtlpProtocol): Uint8Array {
  if (protocol === 'http/json') {
    return toBytes({ resourceLogs: [{ resource: jsonResource(e), scopeLogs: [{ scope: jsonScope(e), logRecords: logs.map(l => ({
      timeUnixNano: String(l.timeNs), observedTimeUnixNano: String(l.timeNs),
      severityNumber: l.severityNumber, severityText: l.severityText,
      body: { stringValue: l.body }, attributes: jsonAttrs(l.attributes),
      ...(l.traceId && l.spanId ? { traceId: l.traceId, spanId: l.spanId, flags: 1 } : {}),
    })) }] }] });
  }
  // LogRecord: time 1, severity_number 2, severity_text 3, body 5, attributes 6,
  // flags 8, trace_id 9, span_id 10, observed_time 11.
  const scopeLogs = new Pb().message(1, pbScope(e));
  for (const l of logs) {
    const record = new Pb().fixed64(1, l.timeNs).uint(2, l.severityNumber).string(3, l.severityText)
      .message(5, pbAnyValue(l.body));
    pbAttrs(record, 6, l.attributes);
    if (l.traceId && l.spanId) record.fixed32(8, 1).hexBytes(9, l.traceId).hexBytes(10, l.spanId);
    scopeLogs.message(2, record.fixed64(11, l.timeNs));
  }
  return new Pb().message(1, new Pb().message(1, pbResource(e)).message(2, scopeLogs)).bytes();
}
