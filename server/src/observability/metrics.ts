/**
 * Zero-dependency Prometheus metrics (plan Track B hardening). Counters
 * accumulate in memory; gauges are collected at scrape time (no timers). The
 * text renderer emits the 0.0.4 exposition format. The /metrics access gate
 * defaults to loopback-only so a curl/localhost or same-pod sidecar scrape works
 * with zero config and the endpoint never leaks publicly; set LW_METRICS_TOKEN to
 * require a bearer token from anywhere.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { timingSafeEqual } from 'node:crypto';
import type { BlobUsage } from '../blobs/types.ts';

export type Labels = Record<string, string>;
/** A line collected at scrape time. Usually a gauge; a `counter` here is a
 *  running total some other component keeps, such as a blob driver's reads. */
export interface GaugeLine { name: string; help: string; type: 'gauge' | 'counter'; value: number; labels?: Labels }
export interface Metrics {
  httpRequest(routeClass: string, statusClass: string): void;
  orgConfigPoll(): void;
  orgConfigError(): void;
  rateLimited(surface: string): void;
  /** Notification egress outcomes (plans/35 wave 1): channel smtp|webhook. */
  notify(channel: string, outcome: 'sent' | 'failed'): void;
  /** Response body bytes the origin wrote, by the route's delivery class
   *  (plan 80 section 10): what a CDN in front could take off this server. */
  originBytes(deliveryClass: string, bytes: number): void;
  /** The counters as lines, for the OTLP metric export (otel.ts): the same
   *  names, labels and values the text exposition carries. */
  snapshot(): GaugeLine[];
  renderText(gauges: GaugeLine[]): string;
}

interface Series { help: string; points: Map<string, { labels: Labels; value: number }> }

export function statusClass(code: number): string {
  return `${Math.floor((code || 0) / 100)}xx`;
}

const labelKey = (l: Labels): string => Object.keys(l).sort().map((k) => `${k}=${l[k]}`).join(',');
const esc = (v: string): string => v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');
const fmtLabels = (l?: Labels): string => {
  const e = Object.entries(l ?? {});
  return e.length ? `{${e.map(([k, v]) => `${k}="${esc(v)}"`).join(',')}}` : '';
};
const fmtNum = (n: number): string => (Number.isInteger(n) ? String(n) : n.toFixed(6));

export function createMetrics(): Metrics {
  const counters = new Map<string, Series>();
  const inc = (name: string, help: string, labels: Labels, by = 1): void => {
    let s = counters.get(name);
    if (!s) { s = { help, points: new Map() }; counters.set(name, s); }
    const key = labelKey(labels);
    const p = s.points.get(key);
    if (p) p.value += by;
    else s.points.set(key, { labels, value: by });
  };
  return {
    httpRequest: (route, status) => inc('lw_http_requests_total', 'HTTP requests by matched route pattern and status class.', { route, status }),
    orgConfigPoll: () => inc('lw_org_config_poll_total', 'org-config polls served (200+304) — the fleet heartbeat.', {}),
    orgConfigError: () => inc('lw_org_config_poll_errors_total', 'org-config polls that failed to assemble.', {}),
    rateLimited: (surface) => inc('lw_rate_limited_total', 'Requests rejected by the per-IP rate limiter.', { surface }),
    notify: (channel, outcome) => inc('lw_notify_total', 'Notification deliveries by channel and outcome.', { channel, outcome }),
    originBytes: (cls, bytes) => inc('lw_origin_bytes_total', 'Response body bytes written by the origin, by delivery class.', { class: cls }, bytes),
    snapshot() {
      const lines: GaugeLine[] = [];
      for (const [name, s] of counters) {
        for (const p of s.points.values()) lines.push({ name, help: s.help, type: 'counter', labels: { ...p.labels }, value: p.value });
      }
      return lines;
    },
    renderText(gauges) {
      const out: string[] = [];
      for (const [name, s] of counters) {
        out.push(`# HELP ${name} ${s.help}`, `# TYPE ${name} counter`);
        for (const p of s.points.values()) out.push(`${name}${fmtLabels(p.labels)} ${fmtNum(p.value)}`);
      }
      const byName = new Map<string, GaugeLine[]>();
      for (const g of gauges) {
        const a = byName.get(g.name) ?? [];
        a.push(g);
        byName.set(g.name, a);
      }
      for (const [name, lines] of byName) {
        out.push(`# HELP ${name} ${lines[0]!.help}`, `# TYPE ${name} ${lines[0]!.type}`);
        for (const g of lines) out.push(`${name}${fmtLabels(g.labels)} ${fmtNum(g.value)}`);
      }
      return out.join('\n') + '\n';
    },
  };
}

/** The blob lines for one scrape (plan 80 section 10). Stored bytes are left
 *  out where the driver cannot total them (s3). */
export function blobUsageLines(usage: BlobUsage): GaugeLine[] {
  const labels = { driver: usage.driver };
  const lines: GaugeLine[] = [
    { name: 'lw_blob_read_bytes_total', help: 'Bytes read out of the blob store since the process started, by driver.', type: 'counter', labels, value: usage.readBytesTotal },
  ];
  if (usage.storedBytes !== null) {
    lines.push({ name: 'lw_blob_stored_bytes', help: 'Bytes held in the blob store, by driver.', type: 'gauge', labels, value: usage.storedBytes });
  }
  return lines;
}

/** Count the body bytes a response writes, after any compression and without
 *  headers. Call before the handler runs; read the result once the response
 *  has finished. HEAD, 204 and 304 responses send no body, so they count 0. */
export function countResponseBytes(req: IncomingMessage, res: ServerResponse): () => number {
  let bytes = 0;
  const add = (chunk: unknown, encoding: unknown): void => {
    if (typeof chunk === 'string') bytes += Buffer.byteLength(chunk, typeof encoding === 'string' ? encoding as BufferEncoding : 'utf8');
    else if (chunk instanceof Uint8Array) bytes += chunk.byteLength;
  };
  const write = res.write;
  const end = res.end;
  res.write = function (this: ServerResponse, chunk: unknown, ...rest: unknown[]) {
    add(chunk, rest[0]);
    return Reflect.apply(write, this, [chunk, ...rest]) as boolean;
  } as ServerResponse['write'];
  res.end = function (this: ServerResponse, chunk?: unknown, ...rest: unknown[]) {
    add(chunk, rest[0]);
    return Reflect.apply(end, this, [chunk, ...rest]) as ServerResponse;
  } as ServerResponse['end'];
  return () => (req.method === 'HEAD' || res.statusCode === 204 || res.statusCode === 304 ? 0 : bytes);
}

function timingSafeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

const isLoopback = (ip: string): boolean => {
  const a = ip.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.');
};

/** Decide access to /metrics. No token ⇒ loopback-only (returns 'not-found' for
 *  a public peer so the endpoint is invisible off-box). Token set ⇒ require a
 *  matching bearer, compared in constant time. */
export function metricsGate(req: IncomingMessage, token?: string, requireToken = false): 'ok' | 'unauthorized' | 'not-found' {
  if (token) {
    const auth = req.headers['authorization'];
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return timingSafeEq(presented, token) ? 'ok' : 'unauthorized';
  }
  if (requireToken) return 'not-found';
  return isLoopback(req.socket.remoteAddress ?? '') ? 'ok' : 'not-found';
}
