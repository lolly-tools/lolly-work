/**
 * Minimal method+path router - the services/ca / services/mcp house pattern:
 * a plain (req, res) handler with no framework, which runs identically under
 * node:http, a container, and a Vercel function wrapper.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';

export type Handler = (req: IncomingMessage, res: ServerResponse, ctx: RouteCtx) => void | Promise<void>;

export interface RouteCtx {
  params: Record<string, string>;
  url: URL;
}

interface Route {
  method: string;
  path: string; // the registered pattern, e.g. '/api/v1/users/:id' - used as a low-cardinality metric label
  segments: string[]; // ':name' = param, '*' = trailing wildcard (rest in params['*'])
  handler: Handler;
}

export function createRouter(): {
  add: (method: string, path: string, handler: Handler) => void;
  /** Returns the matched route PATTERN (e.g. '/api/v1/users/:id'), or null when
   *  nothing matched - a bounded label for the HTTP request metric. */
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<string | null>;
} {
  const routes: Route[] = [];
  return {
    add(method, path, handler) {
      routes.push({ method, path, segments: path.split('/').filter(Boolean), handler });
    },
    async dispatch(req, res) {
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = match(route.segments, parts);
        if (!params) continue;
        await route.handler(req, res, { params, url });
        return route.path;
      }
      return null;
    },
  };
}

function match(pattern: string[], parts: string[]): Record<string, string> | null {
  const params: Record<string, string> = {};
  for (let i = 0; i < pattern.length; i++) {
    const seg = pattern[i] as string;
    if (seg === '*') {
      params['*'] = parts.slice(i).map(decodeURIComponent).join('/');
      return params;
    }
    const part = parts[i];
    if (part === undefined) return null;
    if (seg.startsWith(':')) params[seg.slice(1)] = decodeURIComponent(part);
    else if (seg !== part) return null;
  }
  return parts.length === pattern.length ? params : null;
}

export async function readJson(req: IncomingMessage, maxBytes = 512 * 1024): Promise<unknown> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  if (!total) return null;
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON body'), { status: 400 });
  }
}

/** Read a non-JSON request body into one Buffer, size-capped (plans/26 §2 - 
 *  the router's first raw reader). Used by the publish-out route, which streams
 *  an export's bytes in. Buffered, not streamed to disk. */
export async function readRaw(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += (chunk as Buffer).length;
    if (total > maxBytes) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}

export function sendJson(res: ServerResponse, status: number, body: unknown, headers?: Record<string, string>): void {
  const data = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(data);
}

export function sendError(res: ServerResponse, status: number, code: string, message: string): void {
  sendJson(res, status, { error: { code, message } });
}
