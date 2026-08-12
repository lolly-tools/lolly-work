/**
 * Zero-dependency Prometheus metrics (plan Track B hardening). Counters
 * accumulate in memory; gauges are collected at scrape time (no timers). The
 * text renderer emits the 0.0.4 exposition format. The /metrics access gate
 * defaults to loopback-only so a curl/localhost or same-pod sidecar scrape works
 * with zero config and the endpoint never leaks publicly; set LW_METRICS_TOKEN to
 * require a bearer token from anywhere.
 */
import type { IncomingMessage } from 'node:http';
import { timingSafeEqual } from 'node:crypto';

export type Labels = Record<string, string>;
export interface GaugeLine { name: string; help: string; type: 'gauge'; value: number; labels?: Labels }
export interface Metrics {
  httpRequest(routeClass: string, statusClass: string): void;
  orgConfigPoll(): void;
  orgConfigError(): void;
  rateLimited(surface: string): void;
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
        out.push(`# HELP ${name} ${lines[0]!.help}`, `# TYPE ${name} gauge`);
        for (const g of lines) out.push(`${name}${fmtLabels(g.labels)} ${fmtNum(g.value)}`);
      }
      return out.join('\n') + '\n';
    },
  };
}

function timingSafeEq(a: string, b: string): boolean {
  const A = Buffer.from(a);
  const B = Buffer.from(b);
  if (A.length !== B.length) return false;
  return timingSafeEqual(A, B);
}

const isLoopback = (ip: string): boolean => {
  const a = ip.replace(/^::ffff:/, '');
  return a === '::1' || a.startsWith('127.') || ip === '';
};

/** Decide access to /metrics. No token ⇒ loopback-only (returns 'not-found' for
 *  a public peer so the endpoint is invisible off-box). Token set ⇒ require a
 *  matching bearer, compared in constant time. */
export function metricsGate(req: IncomingMessage, token?: string): 'ok' | 'unauthorized' | 'not-found' {
  if (token) {
    const auth = req.headers['authorization'];
    const presented = typeof auth === 'string' && auth.startsWith('Bearer ') ? auth.slice(7) : '';
    return timingSafeEq(presented, token) ? 'ok' : 'unauthorized';
  }
  return isLoopback(req.socket.remoteAddress ?? '') ? 'ok' : 'not-found';
}
