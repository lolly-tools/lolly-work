/**
 * One logger for the server. Two shapes, chosen by LW_LOG_FORMAT:
 *   text (default)  `[lolly-work] message key=value …`   what an operator reads on a terminal
 *   json            `{"t":…,"level":…,"msg":…,…}`        one object per line for a log pipeline
 * Every line carries the fields it was given verbatim; the http access line
 * (see api/app.ts) adds the request id, route label, status and duration, so a
 * SIEM can join a 5xx to the request that produced it. Access lines are on
 * with LW_LOG_HTTP=1, or whenever the format is json.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface Logger {
  (level: LogLevel, msg: string, fields?: Record<string, unknown>): void;
  readonly format: 'text' | 'json';
  readonly accessLog: boolean;
}

export function formatLine(format: 'text' | 'json', level: LogLevel, msg: string, fields: Record<string, unknown> = {}, at = new Date()): string {
  if (format === 'json') return JSON.stringify({ t: at.toISOString(), level, msg, ...fields });
  const tail = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === 'string' ? (/\s/.test(v) ? JSON.stringify(v) : v) : JSON.stringify(v)}`)
    .join(' ');
  return `[lolly-work] ${level === 'info' ? '' : level.toUpperCase() + ' '}${msg}${tail ? ' ' + tail : ''}`;
}

export function createLogger(env: NodeJS.ProcessEnv = process.env, sink: { out(line: string): void; err(line: string): void } = {
  out: (l) => console.log(l), err: (l) => console.error(l),
}): Logger {
  const format: 'text' | 'json' = env.LW_LOG_FORMAT === 'json' ? 'json' : 'text';
  const accessLog = format === 'json' || env.LW_LOG_HTTP === '1';
  const log = ((level, msg, fields) => {
    const line = formatLine(format, level, msg, fields);
    if (level === 'error' || level === 'warn') sink.err(line); else sink.out(line);
  }) as Logger;
  Object.defineProperty(log, 'format', { value: format });
  Object.defineProperty(log, 'accessLog', { value: accessLog });
  return log;
}

/** A request id: the caller's `x-request-id` when it is a sane token, else a fresh one. */
export function requestId(header: string | string[] | undefined): string {
  const h = Array.isArray(header) ? header[0] : header;
  if (h && /^[A-Za-z0-9._:-]{4,128}$/.test(h)) return h;
  return `r_${Math.random().toString(36).slice(2, 10)}${Date.now().toString(36).slice(-4)}`;
}
