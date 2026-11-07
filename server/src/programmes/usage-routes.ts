// SPDX-License-Identifier: MPL-2.0
/**
 * What a programme's tokens did, counted (plans/82 M7 section 7).
 *
 *   GET /api/v1/programmes/:id/usage?from&to&by=day|week[&token=][&format=csv]
 *       under `programme.manage` for that programme
 *   GET /api/v1/tokens/:id/usage?from&to&by    under `token.manage`
 *
 * Read from records Work already keeps, with nothing new collected: the
 * per-token day rows (calls, and the calls and requests a limit turned away),
 * render and batch records by principal, deliveries by principal, approval
 * requests a token made, and the `mcp.tool-call` audit rows for the refusals a
 * route answered. Work's telemetry rules bound what is shown: counts and closed
 * codes only. Never an input value, a prompt, a title or a file name, never the
 * agent's client name, version or model, and never who minted a token; the
 * audit row an admin opens one at a time keeps those as it always has.
 *
 * Renders by tool, format and state come from durable render records; a sync
 * render (POST /api/v1/render) leaves no record, so it shows only in the day's
 * render count. The company a render was made for is the one its file records
 * (W-M3-5), else the token's own.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, sendJson, type createRouter } from '../api/router.ts';
import type { ApiTokenRecord, Store, UserRecord } from '../store/types.ts';
import { tokenPlacement } from '../iam/service-tokens.ts';

type Router = ReturnType<typeof createRouter>;

/** The refusal codes the counts name. Any other code is counted as `other`. */
export const USAGE_REFUSAL_CODES = ['RATE_LIMITED', 'BUDGET_EXHAUSTED', 'INPUT_LOCKED', 'TOKEN_SCOPE', 'FORBIDDEN'] as const;
/** The widest window one request reads. */
export const USAGE_MAX_DAYS = 92;
/** Audit rows read per token for refusals; past it the answer says so. */
export const USAGE_AUDIT_ROWS = 20_000;
const DAY_MS = 86_400_000;
const DAY = /^\d{4}-\d{2}-\d{2}$/;

type RenderCell = { toolId: string; format: string; succeeded: number; failed: number; cancelled: number; unfinished: number };
interface Cells {
  calls: number;
  renders: number;
  rendersByTool: RenderCell[];
  batches: { count: number; rows: number };
  deliveries: Array<{ destinationId: string; state: string; count: number }>;
  approvals: { open: number; approved: number; rejected: number; withdrawn: number };
  refusals: Record<(typeof USAGE_REFUSAL_CODES)[number] | 'other', number>;
}
const empty = (): Cells => ({
  calls: 0, renders: 0, rendersByTool: [], batches: { count: 0, rows: 0 }, deliveries: [],
  approvals: { open: 0, approved: 0, rejected: 0, withdrawn: 0 },
  refusals: { RATE_LIMITED: 0, BUDGET_EXHAUSTED: 0, INPUT_LOCKED: 0, TOKEN_SCOPE: 0, FORBIDDEN: 0, other: 0 },
});
const addCells = (into: Cells, from: Cells): void => {
  into.calls += from.calls; into.renders += from.renders;
  for (const r of from.rendersByTool) {
    const at = into.rendersByTool.find((x) => x.toolId === r.toolId && x.format === r.format);
    if (at) { at.succeeded += r.succeeded; at.failed += r.failed; at.cancelled += r.cancelled; at.unfinished += r.unfinished; } else into.rendersByTool.push({ ...r });
  }
  into.batches.count += from.batches.count; into.batches.rows += from.batches.rows;
  for (const d of from.deliveries) {
    const at = into.deliveries.find((x) => x.destinationId === d.destinationId && x.state === d.state);
    if (at) at.count += d.count; else into.deliveries.push({ ...d });
  }
  for (const k of Object.keys(into.approvals) as Array<keyof Cells['approvals']>) into.approvals[k] += from.approvals[k];
  for (const k of Object.keys(into.refusals) as Array<keyof Cells['refusals']>) into.refusals[k] += from.refusals[k];
};

/** The Monday a UTC day falls in, so weeks line up across tokens. */
export function weekOf(day: string): string {
  const at = Date.parse(`${day}T00:00:00Z`);
  const weekday = (new Date(at).getUTCDay() + 6) % 7;
  return new Date(at - weekday * DAY_MS).toISOString().slice(0, 10);
}

export interface UsageWindow { from: string; to: string; by: 'day' | 'week' }

/** Read `from`, `to` and `by`; the default is the last four weeks, by week. */
export function readWindow(url: URL, now = Date.now()): UsageWindow | { error: string } {
  const today = new Date(now).toISOString().slice(0, 10);
  const to = url.searchParams.get('to') ?? today;
  const from = url.searchParams.get('from') ?? new Date(Date.parse(`${to}T00:00:00Z`) - 27 * DAY_MS).toISOString().slice(0, 10);
  const by = url.searchParams.get('by') ?? 'week';
  if (!DAY.test(from) || !DAY.test(to) || Number.isNaN(Date.parse(`${from}T00:00:00Z`)) || Number.isNaN(Date.parse(`${to}T00:00:00Z`))) return { error: 'from and to are UTC days, YYYY-MM-DD' };
  if (from > to) return { error: 'from must not be after to' };
  if ((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS + 1 > USAGE_MAX_DAYS) return { error: `a window holds at most ${USAGE_MAX_DAYS} days` };
  if (by !== 'day' && by !== 'week') return { error: 'by is day or week' };
  return { from, to, by };
}

type UsageStore = Pick<Store, 'listTokenUsage' | 'renderUsage' | 'renderBatchUsage' | 'listDeliveries' | 'listApprovals' | 'listAuditBefore'>;

export interface TokenUsageRow {
  id: string; label: string; company: string | null; lastUsedAt: string | null; expiresAt: string | null; revokedAt: string | null;
  periods: Array<{ period: string } & Cells>;
  totals: Cells;
  /** True when more refusal rows were in the window than one answer reads. */
  auditTruncated?: boolean;
}

/** The counts for these tokens, by period. */
export async function tokenUsageRows(store: UsageStore, tokens: readonly ApiTokenRecord[], window: UsageWindow): Promise<TokenUsageRow[]> {
  const fromIso = `${window.from}T00:00:00.000Z`;
  const toIso = new Date(Date.parse(`${window.to}T00:00:00Z`) + DAY_MS).toISOString();
  const ids = tokens.map((t) => t.id);
  const principals = ids.map((id) => `service:svc_${id}`);
  const period = (day: string) => (window.by === 'day' ? day : weekOf(day));
  const [days, renders, batches] = await Promise.all([
    store.listTokenUsage(window.from, window.to, ids), store.renderUsage(principals, fromIso, toIso), store.renderBatchUsage(principals, fromIso, toIso),
  ]);
  const out: TokenUsageRow[] = [];
  for (const token of tokens) {
    const svc = `svc_${token.id}`;
    const cells = new Map<string, Cells>();
    const at = (day: string): Cells => { const p = period(day); let c = cells.get(p); if (!c) { c = empty(); cells.set(p, c); } return c; };
    for (const d of days) {
      if (d.tokenId !== token.id) continue;
      const c = at(d.day);
      c.calls += d.calls; c.renders += d.renders;
      c.refusals.RATE_LIMITED += d.rateLimited; c.refusals.BUDGET_EXHAUSTED += d.budgetRefused;
    }
    for (const r of renders) {
      if (r.principal !== `service:${svc}`) continue;
      const c = at(r.day);
      let cell = c.rendersByTool.find((x) => x.toolId === r.toolId && x.format === r.format);
      if (!cell) { cell = { toolId: r.toolId, format: r.format, succeeded: 0, failed: 0, cancelled: 0, unfinished: 0 }; c.rendersByTool.push(cell); }
      if (r.state === 'succeeded') cell.succeeded += r.count; else if (r.state === 'failed') cell.failed += r.count;
      else if (r.state === 'cancelled') cell.cancelled += r.count; else cell.unfinished += r.count;
    }
    for (const b of batches) {
      if (b.principal !== `service:${svc}`) continue;
      const c = at(b.day);
      c.batches.count += b.batches; c.batches.rows += b.rows;
    }
    for (const d of await store.listDeliveries(`user:${svc}`)) {
      if (d.createdAt < fromIso || d.createdAt >= toIso) continue;
      const c = at(d.createdAt.slice(0, 10));
      const cell = c.deliveries.find((x) => x.destinationId === d.destinationId && x.state === d.state);
      if (cell) cell.count++; else c.deliveries.push({ destinationId: d.destinationId, state: d.state, count: 1 });
    }
    for (const a of await store.listApprovals({ createdBy: svc })) {
      if (a.createdAt < fromIso || a.createdAt >= toIso) continue;
      const c = at(a.createdAt.slice(0, 10));
      if (a.state === 'approved') c.approvals.approved++; else if (a.state === 'rejected') c.approvals.rejected++;
      else if (a.state === 'withdrawn') c.approvals.withdrawn++; else c.approvals.open++;
    }
    // Refusals a route answered over MCP, by code, from the audit rows that already record them.
    let read = 0, before = 0, truncated = false;
    for (;;) {
      const page = await store.listAuditBefore(before, 1000, { actor: `service:${svc}`, action: 'mcp.tool-call', since: fromIso, until: toIso });
      if (!page.length) break;
      for (const e of page) {
        const p = e.payload as { outcome?: unknown; code?: unknown } | undefined;
        if (p?.outcome !== 'rejected' || typeof p.code !== 'string') continue;
        // The minute brake and the budget are counted from the day rows already.
        if (p.code === 'RATE_LIMITED' || p.code === 'BUDGET_EXHAUSTED') continue;
        const key = (USAGE_REFUSAL_CODES as readonly string[]).includes(p.code) ? p.code as keyof Cells['refusals'] : 'other';
        at(e.at.slice(0, 10)).refusals[key]++;
      }
      read += page.length;
      before = page[0]!.seq;
      if (page.length < 1000) break;
      if (read >= USAGE_AUDIT_ROWS) { truncated = true; break; }
    }
    const periods = [...cells.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([p, c]) => ({ period: p, ...c }));
    const totals = empty();
    for (const p of periods) addCells(totals, p);
    out.push({
      id: token.id, label: token.label, company: tokenPlacement(token).companyId ?? null,
      lastUsedAt: token.lastUsedAt ?? null, expiresAt: token.expiresAt ?? null, revokedAt: token.revokedAt ?? null,
      periods, totals, ...(truncated ? { auditTruncated: true } : {}),
    });
  }
  return out;
}

const CSV_COLUMNS = ['period', 'token', 'label', 'company', 'calls', 'renders', 'renders_succeeded', 'renders_failed', 'renders_cancelled', 'batches', 'batch_rows',
  'deliveries', 'approvals_open', 'approvals_approved', 'approvals_rejected', 'approvals_withdrawn',
  'refused_rate_limited', 'refused_budget_exhausted', 'refused_input_locked', 'refused_token_scope', 'refused_forbidden', 'refused_other'] as const;
/** RFC 4180 quoting, and a leading formula character kept as text. */
const csvCell = (value: unknown): string => {
  const text = String(value ?? '');
  const safe = /^[=+\-@\t\r]/.test(text) ? `'${text}` : text;
  return /[",\r\n]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
};

/** One row per token per period: the same cells the JSON holds, summed by tool and destination. */
export function usageCsv(rows: readonly TokenUsageRow[]): string {
  const lines = [CSV_COLUMNS.join(',')];
  for (const t of rows) for (const p of t.periods) {
    const sum = (key: 'succeeded' | 'failed' | 'cancelled') => p.rendersByTool.reduce((n, r) => n + r[key], 0);
    lines.push([p.period, t.id, t.label, t.company ?? '', p.calls, p.renders, sum('succeeded'), sum('failed'), sum('cancelled'), p.batches.count, p.batches.rows,
      p.deliveries.reduce((n, d) => n + d.count, 0), p.approvals.open, p.approvals.approved, p.approvals.rejected, p.approvals.withdrawn,
      p.refusals.RATE_LIMITED, p.refusals.BUDGET_EXHAUSTED, p.refusals.INPUT_LOCKED, p.refusals.TOKEN_SCOPE, p.refusals.FORBIDDEN, p.refusals.other].map(csvCell).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

export interface UsageRouteDeps {
  store: Store;
  requireAction(req: IncomingMessage, res: ServerResponse, action: string, resources?: string[]): Promise<UserRecord | null>;
}

const send = (res: ServerResponse, url: URL, body: Record<string, unknown>, rows: TokenUsageRow[], name: string): void => {
  if (url.searchParams.get('format') === 'csv') {
    const bytes = Buffer.from(usageCsv(rows));
    res.writeHead(200, { 'content-type': 'text/csv; charset=utf-8', 'content-length': String(bytes.length), 'cache-control': 'no-store',
      'content-disposition': `attachment; filename="${name}"`, 'x-content-type-options': 'nosniff' });
    res.end(bytes);
    return;
  }
  sendJson(res, 200, body, { 'cache-control': 'no-store' });
};

export function registerUsageRoutes(router: Router, deps: UsageRouteDeps): void {
  const { store } = deps;

  router.add('GET', '/api/v1/programmes/:id/usage', async (req, res, ctx) => {
    const programmeId = String(ctx.params.id);
    if (!(await deps.requireAction(req, res, 'programme.manage', [`programme:${programmeId}`, '*']))) return;
    const programme = await store.getProgramme(programmeId);
    if (!programme) return sendError(res, 404, 'NOT_FOUND', 'no such programme');
    const window = readWindow(ctx.url);
    if ('error' in window) return sendError(res, 400, 'INVALID_INPUT', window.error);
    const only = ctx.url.searchParams.get('token');
    const placed = (await store.listApiTokens()).filter((t) => tokenPlacement(t).programmeId === programmeId && (only === null || t.id === only));
    const rows = await tokenUsageRows(store, placed, window);
    const companies = new Map((await store.listCompanies()).filter((c) => c.programmeId === programmeId).map((c) => [c.id, c.name]));
    const byCompany = new Map<string, Cells>();
    const totals = empty();
    for (const row of rows) {
      addCells(totals, row.totals);
      if (!row.company) continue;
      const c = byCompany.get(row.company) ?? empty();
      addCells(c, row.totals);
      byCompany.set(row.company, c);
    }
    send(res, ctx.url, {
      programme: programmeId, ...window, tokens: rows,
      companies: [...byCompany.entries()].map(([id, cells]) => ({ id, name: companies.get(id) ?? id, totals: cells })),
      totals,
    }, rows, `${programmeId}-usage-${window.from}-${window.to}.csv`);
  }, { delivery: 'person-private' });

  router.add('GET', '/api/v1/tokens/:id/usage', async (req, res, ctx) => {
    if (!(await deps.requireAction(req, res, 'token.manage'))) return;
    const token = await store.getApiToken(String(ctx.params.id));
    if (!token) return sendError(res, 404, 'NOT_FOUND', 'no such token');
    const window = readWindow(ctx.url);
    if ('error' in window) return sendError(res, 400, 'INVALID_INPUT', window.error);
    const [row] = await tokenUsageRows(store, [token], window);
    send(res, ctx.url, { ...window, token: row }, [row!], `${token.id}-usage-${window.from}-${window.to}.csv`);
  }, { delivery: 'person-private' });
}
