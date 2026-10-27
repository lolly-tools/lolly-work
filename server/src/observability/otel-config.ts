// SPDX-License-Identifier: MPL-2.0
/**
 * OpenTelemetry export settings, read from the standard OTEL_* environment
 * variables (opentelemetry.io/docs/specs/otel/configuration/sdk-environment-variables
 * and .../protocol/exporter). Work honours the variables an OpenTelemetry SDK
 * would, with one deliberate difference: nothing is exported until an OTLP
 * endpoint is set. An SDK falls back to http://localhost:4318; Work does not,
 * so an instance whose administrator never asked for export sends nothing,
 * starts no timer and opens no socket.
 *
 * Transport is OTLP over HTTP, in either encoding: `http/protobuf` (the
 * OpenTelemetry default, and what Dynatrace and Splunk's direct intakes
 * require) or `http/json`. `grpc` is refused with a note rather than sent to
 * the wrong port: a collector listens for both HTTP encodings on 4318.
 */
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Attrs, OtlpProtocol } from './otlp-encode.ts';

export type Signal = 'traces' | 'metrics' | 'logs';
export const SIGNALS: readonly Signal[] = ['traces', 'metrics', 'logs'];

export interface ExporterConfig {
  signal: Signal;
  url: string;
  protocol: OtlpProtocol;
  /** Sent on every export; often a credential, so never logged. */
  headers: Record<string, string>;
  timeoutMs: number;
  compression: 'gzip' | 'none';
  ca?: Buffer;
  cert?: Buffer;
  key?: Buffer;
}

export interface BatchConfig { scheduleDelayMs: number; exportTimeoutMs: number; maxQueueSize: number; maxExportBatchSize: number }
export interface SamplerConfig { root: 'always_on' | 'always_off' | 'ratio'; ratio: number; parentBased: boolean }

export interface OtelConfig {
  resource: Attrs;
  scope: { name: string; version: string };
  traces?: ExporterConfig;
  metrics?: ExporterConfig;
  logs?: ExporterConfig;
  sampler: SamplerConfig;
  /** Read an incoming W3C `traceparent` (OTEL_PROPAGATORS tracecontext, the default). */
  propagate: boolean;
  spanBatch: BatchConfig;
  logBatch: BatchConfig;
  metricIntervalMs: number;
  metricTimeoutMs: number;
  temporality: 'cumulative' | 'delta';
}

const SIGNAL_VAR: Record<Signal, string> = { traces: 'TRACES', metrics: 'METRICS', logs: 'LOGS' };
const truthy = (v: string | undefined): boolean => (v ?? '').trim().toLowerCase() === 'true';
const val = (env: NodeJS.ProcessEnv, name: string): string | undefined => {
  const v = env[name]?.trim();
  return v ? v : undefined;
};

/** A non-negative integer setting, or the default with a note when it does not parse. */
function int(env: NodeJS.ProcessEnv, name: string, fallback: number, notes: string[], min = 0): number {
  const raw = val(env, name);
  if (raw === undefined) return fallback;
  const n = Number(raw);
  if (Number.isInteger(n) && n >= min) return n;
  notes.push(`${name}=${raw} is not a whole number of at least ${min}; using ${fallback}`);
  return fallback;
}

/** `key1=value1,key2=value2`, values percent-encoded (the W3C Baggage form both
 *  OTEL_RESOURCE_ATTRIBUTES and OTEL_EXPORTER_OTLP_HEADERS use). A pair that
 *  does not parse is skipped and reported by key only, never by value. */
export function parseKeyValueList(raw: string | undefined, label: string, notes: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (const pair of (raw ?? '').split(',')) {
    if (!pair.trim()) continue;
    const at = pair.indexOf('=');
    const key = (at > 0 ? pair.slice(0, at) : '').trim();
    if (!key) { notes.push(`${label}: skipped an entry with no key`); continue; }
    try { out[key] = decodeURIComponent(pair.slice(at + 1).trim()); }
    catch { notes.push(`${label}: skipped "${key}", its value is not valid percent-encoding`); }
  }
  return out;
}

/** The signal's URL: its own endpoint as given, or the shared one plus `v1/<signal>`. */
function endpointOf(env: NodeJS.ProcessEnv, signal: Signal): string | undefined {
  const own = val(env, `OTEL_EXPORTER_OTLP_${SIGNAL_VAR[signal]}_ENDPOINT`);
  if (own) return own;
  const base = val(env, 'OTEL_EXPORTER_OTLP_ENDPOINT');
  return base ? `${base.replace(/\/+$/, '')}/v1/${signal}` : undefined;
}

/** The per-signal variable, falling back to the shared one. */
const signalVal = (env: NodeJS.ProcessEnv, signal: Signal, suffix: string): string | undefined =>
  val(env, `OTEL_EXPORTER_OTLP_${SIGNAL_VAR[signal]}_${suffix}`) ?? val(env, `OTEL_EXPORTER_OTLP_${suffix}`);

function exporterFor(env: NodeJS.ProcessEnv, signal: Signal, notes: string[]): ExporterConfig | undefined {
  const exporter = (val(env, `OTEL_${SIGNAL_VAR[signal]}_EXPORTER`) ?? 'otlp').toLowerCase();
  if (exporter === 'none') return undefined;
  const raw = endpointOf(env, signal);
  if (!raw) return undefined;
  if (exporter !== 'otlp') {
    notes.push(`OTEL_${SIGNAL_VAR[signal]}_EXPORTER=${exporter} is not supported (otlp or none); ${signal} are not exported`);
    return undefined;
  }
  let url: URL;
  try { url = new URL(raw); } catch { notes.push(`${signal}: the OTLP endpoint is not a valid URL; ${signal} are not exported`); return undefined; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    notes.push(`${signal}: the OTLP endpoint must be http or https; ${signal} are not exported`);
    return undefined;
  }
  const protocol = (signalVal(env, signal, 'PROTOCOL') ?? 'http/protobuf').toLowerCase();
  if (protocol !== 'http/protobuf' && protocol !== 'http/json') {
    notes.push(`${signal}: OTLP protocol "${protocol}" is not supported; Work sends OTLP over HTTP (http/protobuf or http/json, usually port 4318). ${signal} are not exported`);
    return undefined;
  }
  const compression = (signalVal(env, signal, 'COMPRESSION') ?? 'none').toLowerCase();
  if (compression !== 'gzip' && compression !== 'none') notes.push(`${signal}: compression "${compression}" is not supported (gzip or none); sending uncompressed`);
  const headers = {
    ...parseKeyValueList(val(env, 'OTEL_EXPORTER_OTLP_HEADERS'), 'OTEL_EXPORTER_OTLP_HEADERS', notes),
    ...parseKeyValueList(val(env, `OTEL_EXPORTER_OTLP_${SIGNAL_VAR[signal]}_HEADERS`), `OTEL_EXPORTER_OTLP_${SIGNAL_VAR[signal]}_HEADERS`, notes),
  };
  const files: Partial<Record<'ca' | 'cert' | 'key', Buffer>> = {};
  for (const [field, suffix] of [['ca', 'CERTIFICATE'], ['cert', 'CLIENT_CERTIFICATE'], ['key', 'CLIENT_KEY']] as const) {
    const path = signalVal(env, signal, suffix);
    if (!path) continue;
    try { files[field] = readFileSync(path); }
    catch (err) { notes.push(`${signal}: cannot read OTEL_EXPORTER_OTLP_${suffix} (${(err as NodeJS.ErrnoException).code ?? 'error'}); ${signal} are not exported`); return undefined; }
  }
  const timeout = signalVal(env, signal, 'TIMEOUT');
  const timeoutMs = timeout !== undefined && Number.isInteger(Number(timeout)) && Number(timeout) > 0 ? Number(timeout) : 10_000;
  if (timeout !== undefined && timeoutMs !== Number(timeout)) notes.push(`${signal}: OTLP timeout "${timeout}" is not a positive whole number of milliseconds; using 10000`);
  return { signal, url: url.href, protocol, headers, timeoutMs, compression: compression === 'gzip' ? 'gzip' : 'none', ...files };
}

function samplerFrom(env: NodeJS.ProcessEnv, notes: string[]): SamplerConfig {
  const name = (val(env, 'OTEL_TRACES_SAMPLER') ?? 'parentbased_always_on').toLowerCase();
  const arg = val(env, 'OTEL_TRACES_SAMPLER_ARG');
  const ratio = arg !== undefined && Number.isFinite(Number(arg)) && Number(arg) >= 0 && Number(arg) <= 1 ? Number(arg) : 1;
  if (arg !== undefined && ratio !== Number(arg)) notes.push(`OTEL_TRACES_SAMPLER_ARG=${arg} is not a ratio between 0 and 1; using 1`);
  const table: Record<string, SamplerConfig> = {
    always_on: { root: 'always_on', ratio, parentBased: false },
    always_off: { root: 'always_off', ratio, parentBased: false },
    traceidratio: { root: 'ratio', ratio, parentBased: false },
    parentbased_always_on: { root: 'always_on', ratio, parentBased: true },
    parentbased_always_off: { root: 'always_off', ratio, parentBased: true },
    parentbased_traceidratio: { root: 'ratio', ratio, parentBased: true },
  };
  const chosen = Object.hasOwn(table, name) ? table[name]! : undefined;
  if (!chosen) notes.push(`OTEL_TRACES_SAMPLER=${name} is not supported; using parentbased_always_on`);
  return chosen ?? table.parentbased_always_on!;
}

function batchFrom(env: NodeJS.ProcessEnv, prefix: 'OTEL_BSP' | 'OTEL_BLRP', delay: number, notes: string[]): BatchConfig {
  const maxQueueSize = int(env, `${prefix}_MAX_QUEUE_SIZE`, 2048, notes, 1);
  const batch = int(env, `${prefix}_MAX_EXPORT_BATCH_SIZE`, 512, notes, 1);
  return {
    scheduleDelayMs: int(env, `${prefix}_SCHEDULE_DELAY`, delay, notes),
    exportTimeoutMs: int(env, `${prefix}_EXPORT_TIMEOUT`, 30_000, notes, 1),
    maxQueueSize,
    // The specification: a batch larger than the queue is clamped to the queue.
    maxExportBatchSize: Math.min(batch, maxQueueSize),
  };
}

/** Where to send what, or `config: null` when nothing is to be sent. `notes`
 *  are the settings Work could not follow, for one line each at boot. */
export function otelConfigFromEnv(env: NodeJS.ProcessEnv, version: string): { config: OtelConfig | null; notes: string[] } {
  const notes: string[] = [];
  if (truthy(env.OTEL_SDK_DISABLED)) return { config: null, notes };
  const traces = exporterFor(env, 'traces', notes);
  const metrics = exporterFor(env, 'metrics', notes);
  const logs = exporterFor(env, 'logs', notes);
  if (!traces && !metrics && !logs) return { config: null, notes };

  const resourceAttrs = parseKeyValueList(val(env, 'OTEL_RESOURCE_ATTRIBUTES'), 'OTEL_RESOURCE_ATTRIBUTES', notes);
  // Identifies the software and this process, nothing about the machine's
  // owner: host.name is left out because a home server's hostname is often a
  // person's name. An administrator who wants it adds it in OTEL_RESOURCE_ATTRIBUTES.
  const resource: Attrs = {
    'service.version': version,
    'service.instance.id': randomUUID(),
    'telemetry.sdk.name': 'lolly-work',
    'telemetry.sdk.language': 'nodejs',
    'telemetry.sdk.version': version,
    'process.runtime.name': 'nodejs',
    'process.runtime.version': process.versions.node,
    ...resourceAttrs,
    'service.name': val(env, 'OTEL_SERVICE_NAME') ?? resourceAttrs['service.name'] ?? 'lolly-work',
  };

  const propagators = (val(env, 'OTEL_PROPAGATORS') ?? 'tracecontext').toLowerCase().split(',').map(p => p.trim()).filter(Boolean);
  const unknown = propagators.filter(p => p !== 'tracecontext' && p !== 'none' && p !== 'baggage');
  if (unknown.length) notes.push(`OTEL_PROPAGATORS: ${unknown.join(', ')} not supported; only tracecontext is read`);

  const temporality = (val(env, 'OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE') ?? 'cumulative').toLowerCase();
  if (!['cumulative', 'delta', 'lowmemory'].includes(temporality)) notes.push(`OTEL_EXPORTER_OTLP_METRICS_TEMPORALITY_PREFERENCE=${temporality} is not supported; using cumulative`);

  return {
    config: {
      resource,
      scope: { name: 'lolly-work', version },
      ...(traces ? { traces } : {}),
      ...(metrics ? { metrics } : {}),
      ...(logs ? { logs } : {}),
      sampler: samplerFrom(env, notes),
      propagate: propagators.includes('tracecontext'),
      spanBatch: batchFrom(env, 'OTEL_BSP', 5_000, notes),
      logBatch: batchFrom(env, 'OTEL_BLRP', 1_000, notes),
      metricIntervalMs: int(env, 'OTEL_METRIC_EXPORT_INTERVAL', 60_000, notes, 1),
      metricTimeoutMs: int(env, 'OTEL_METRIC_EXPORT_TIMEOUT', 30_000, notes, 1),
      // lowmemory asks for delta on synchronous counters only. Work reads it as
      // delta for every sum, which a delta-only backend accepts as well.
      temporality: temporality === 'delta' || temporality === 'lowmemory' ? 'delta' : 'cumulative',
    },
    notes,
  };
}

/** The endpoint as it may be printed: scheme, host and path, never userinfo or query. */
export function printableEndpoint(url: string): string {
  try { const u = new URL(url); return `${u.protocol}//${u.host}${u.pathname}`; }
  catch { return '(invalid URL)'; }
}
