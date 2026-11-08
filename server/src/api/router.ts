/**
 * Minimal method+path router - the services/ca / services/mcp house pattern:
 * a plain (req, res) handler with no framework, which runs identically under
 * node:http, a container, and a Vercel function wrapper.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { cachePolicy, renderTags, type DeliveryClass, type CachePolicyOptions } from '@lolly-tools/core/delivery-v1';
import { appendVary, encodeText } from './file-delivery.ts';
import { JSON_BODY_DEFAULT_BYTES } from './body-limits.ts';

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
  delivery: DeliveryClass;
  declared: boolean;
}

const requests = new WeakMap<ServerResponse, IncomingMessage>();
const classes = new WeakMap<ServerResponse, DeliveryClass>();
const classOptions = new WeakMap<ServerResponse, CachePolicyOptions>();
/** Browsers revalidate the service worker; shared caches never retain it. */
export const SERVICE_WORKER_CACHE_CONTROL = 'no-cache, s-maxage=0, no-transform';
/** Dynamic file routes select their class after resolving the actual file. */
export function setDeliveryClass(res: ServerResponse, delivery: DeliveryClass, options: CachePolicyOptions = {}): void { classes.set(res, delivery); classOptions.set(res, options); }
/** The class the matched route (or its handler) chose; unmatched responses are person-private. */
export function deliveryClassOf(res: ServerResponse): DeliveryClass { return classes.get(res) ?? 'person-private'; }
/** Credentials of any kind keep a response out of a shared cache. */
export function carriesCredential(req: IncomingMessage): boolean {
  return Object.keys(req.headers).some(name => ['cookie', 'authorization', 'x-lolly-client'].includes(name.toLowerCase()) || name.toLowerCase().startsWith('x-lw-'));
}
/** The options a handler passed with setDeliveryClass, for the route conformance test. */
export function deliveryOptionsOf(res: ServerResponse): CachePolicyOptions { return classOptions.get(res) ?? {}; }

/** Every purge-tag header a provider or a reference proxy reads. The guard
 *  removes them all and adds back only the configured providers' headers, on
 *  answers a shared cache may store. */
export const PURGE_TAG_HEADERS = ['cache-tag', 'cdn-tag', 'surrogate-key', 'edge-cache-tag'] as const;
const tags = new WeakMap<ServerResponse, string[]>();
/** Delivery-v1 tags for this response (`b_...`, `t_...`, `h_...`). Sent only when
 *  the answer is public and an edge provider is configured. */
export function setDeliveryTags(res: ServerResponse, values: string[]): void { tags.set(res, [...(tags.get(res) ?? []), ...values]); }

/** What the guard needs to know about the configured edge providers. */
export interface EdgeDelivery {
  /** Lower-case header names of the configured providers (`cdn-tag`, `cache-tag`). */
  tagHeaders: readonly string[];
  /** Added to every tagged answer, so one purge can evict everything this instance put on an edge. */
  instanceTag?: string;
  /** Hostnames that serve public classes only. */
  publicOnlyHosts: ReadonlySet<string>;
}
const publicOnly = new WeakSet<ServerResponse>();
/** The request's Host, lower-cased and without a port. Never X-Forwarded-Host, which a client can set. */
export function requestHost(req: IncomingMessage): string {
  const host = String(req.headers.host ?? '').trim().toLowerCase();
  return host.startsWith('[') ? host.slice(0, host.indexOf(']') + 1) : host.replace(/:\d+$/, '');
}
/** True when this response belongs to a request on a public-only edge hostname. */
export function servesPublicOnly(res: ServerResponse): boolean { return publicOnly.has(res); }
const PUBLIC_ONLY_BODY = Buffer.from(JSON.stringify({ error: { code: 'PUBLIC_HOST_ONLY', message: 'This hostname serves public files only.' } }));

/** Render the tags a provider header carries, dropping any that break the delivery-v1 grammar. */
function edgeTagValue(values: Array<string | undefined>): string | null {
  const valid: string[] = [];
  for (const value of new Set(values)) {
    if (!value || valid.length >= 12) continue;
    try { renderTags([value], 'comma'); valid.push(value); } catch { /* an invalid tag is left out, never sent */ }
  }
  try { return valid.length ? renderTags(valid, 'comma') : null; } catch { return null; }
}

/** Install before dispatch, so auth errors and early raw responses are covered too.
 *  On a public-only edge hostname every credential is removed from the request
 *  first, so nothing there can act as a person, and any answer that is not
 *  public becomes an empty 404 before a byte of it is written. */
export function guardDelivery(req: IncomingMessage, res: ServerResponse, edge?: EdgeDelivery): void {
  if (requests.has(res)) return;
  requests.set(res, req);
  if (edge?.publicOnlyHosts.size && edge.publicOnlyHosts.has(requestHost(req))) {
    publicOnly.add(res);
    for (const name of Object.keys(req.headers)) {
      const lower = name.toLowerCase();
      if (['cookie', 'authorization', 'x-lolly-client'].includes(lower) || lower.startsWith('x-lw-')) delete req.headers[name];
    }
  }
  const original = res.writeHead;
  res.writeHead = function (this: ServerResponse, status: number, ...args: unknown[]) {
    const passed = (typeof args[0] === 'string' ? args[1] : args[0]) as Record<string, string | number | string[]> | undefined;
    const entries = Array.isArray(passed) ? Array.from({ length: passed.length / 2 }, (_, i) => [passed[2 * i]!, passed[2 * i + 1]!]) : Object.entries(passed ?? {});
    const merged = new Map<string, string | number | string[]>();
    for (const [name, value] of Object.entries(res.getHeaders())) if (value !== undefined) merged.set(name.toLowerCase(), value as string | number | string[]);
    for (const [name, value] of entries) merged.set(String(name).toLowerCase(), value);
    const cls = classes.get(res) ?? 'person-private';
    const publicAllowed = cls.startsWith('public-') && !carriesCredential(req) && !merged.has('set-cookie');
    const policy = cachePolicy(publicAllowed ? cls : cls.startsWith('public-') ? 'instance-private' : cls, { ...classOptions.get(res), status });
    let control = String(merged.get('cache-control') ?? policy.cacheControl);
    if (cls === 'person-private') control = cachePolicy('person-private', { status }).cacheControl;
    if (cls === 'link' && !/\bno-store\b/.test(control)) control = policy.cacheControl;
    if (status >= 400 || merged.has('set-cookie') || (/\bpublic\b/.test(control) && !publicAllowed)) control = cachePolicy('person-private').cacheControl;
    if (!/\bno-transform\b/.test(control)) control += ', no-transform';
    const serviceWorker = cls === 'public-revalidate' && new URL(req.url ?? '/', 'http://local').pathname === '/sw.js';
    if (serviceWorker && !publicAllowed) control = cachePolicy('person-private').cacheControl;
    else if (serviceWorker && [200, 206, 304].includes(status) && (/^public\b/.test(control) || control === SERVICE_WORKER_CACHE_CONTROL) && !/\bno-store\b/.test(control)) control = SERVICE_WORKER_CACHE_CONTROL;
    merged.set('cache-control', control);
    const shared = publicAllowed && /^public\b/.test(control) && !serviceWorker;
    merged.set('cdn-cache-control', shared ? policy.cdnCacheControl : 'no-store');
    if (shared) {
      const max = /(?:^|,)\s*max-age=(\d+)/.exec(control)?.[1] ?? '0';
      if (!/\bs-maxage=/.test(control)) merged.set('cache-control', control + `, s-maxage=${max}`);
      merged.set('surrogate-control', policy.surrogateControl ?? policy.cdnCacheControl);
    } else merged.delete('surrogate-control');
    if (!merged.has('referrer-policy')) merged.set('referrer-policy', 'no-referrer');
    // Tags only ever describe an answer a shared cache may store, and only the
    // configured providers' headers carry them. A tag a handler wrote itself is
    // dropped, so a private or credentialed answer never carries one.
    for (const name of PURGE_TAG_HEADERS) merged.delete(name);
    const tagValue = shared && edge?.tagHeaders.length && [200, 206, 304].includes(status)
      ? edgeTagValue([...(tags.get(res) ?? []), `x_${cls}`, edge.instanceTag]) : null;
    if (tagValue) for (const name of edge!.tagHeaders) merged.set(name, tagValue);
    // writeHead merges headers set earlier with setHeader, so a removed header must be removed there too.
    // In-process callers (agents/project-requests.ts) pass a minimal response without removeHeader.
    const removable = typeof res.removeHeader === 'function';
    if (removable) for (const name of ['surrogate-control', ...PURGE_TAG_HEADERS]) if (!merged.has(name) && res.getHeader(name) !== undefined) res.removeHeader(name);
    if (publicOnly.has(res) && !shared && status < 400) {
      if (removable) for (const name of Object.keys(res.getHeaders())) res.removeHeader(name);
      const end = res.end;
      const head = req.method === 'HEAD';
      res.write = function (...chunk: unknown[]) { const done = chunk.find(arg => typeof arg === 'function') as (() => void) | undefined; done?.(); return true; } as ServerResponse['write'];
      res.end = function (this: ServerResponse, ...chunk: unknown[]) {
        const done = chunk.find(arg => typeof arg === 'function') as (() => void) | undefined;
        return Reflect.apply(end, this, head ? [done] : [PUBLIC_ONLY_BODY, done]);
      } as ServerResponse['end'];
      return original.call(this, 404, { 'content-type': 'application/json; charset=utf-8', 'content-length': String(PUBLIC_ONLY_BODY.length),
        'cache-control': cachePolicy('person-private').cacheControl, 'cdn-cache-control': 'no-store', 'referrer-policy': 'no-referrer', 'x-content-type-options': 'nosniff' });
    }
    return typeof args[0] === 'string'
      ? Reflect.apply(original, this, [status, args[0], Object.fromEntries(merged)])
      : original.call(this, status, Object.fromEntries(merged));
  } as ServerResponse['writeHead'];
}

/** Runs after a route matches and before its handler. Answering false means the
 *  guard has already sent the response and the handler must not run. */
export type RouteGuard = (req: IncomingMessage, res: ServerResponse, route: { method: string; path: string }) => boolean | Promise<boolean>;

/** One registered route. `declared` is false when the route took the
 *  person-private default instead of naming a class. */
export interface RouteDescription { method: string; path: string; delivery: DeliveryClass; declared: boolean }

export function createRouter(): {
  add: (method: string, path: string, handler: Handler, options?: { delivery?: DeliveryClass }) => void;
  /** Classes are conservative by default; public routes opt in explicitly. */
  descriptions: () => RouteDescription[];
  /** Install the check every matched request passes first. One guard per router. */
  setGuard: (guard: RouteGuard) => void;
  /** Returns the matched route PATTERN (e.g. '/api/v1/users/:id'), or null when
   *  nothing matched - a bounded label for the HTTP request metric. */
  dispatch: (req: IncomingMessage, res: ServerResponse) => Promise<string | null>;
} {
  const routes: Route[] = [];
  let guard: RouteGuard | undefined;
  return {
    setGuard(next) { guard = next; },
    add(method, path, handler, options) {
      routes.push({ method, path, segments: path.split('/').filter(Boolean), handler,
        delivery: options?.delivery ?? 'person-private', declared: options?.delivery !== undefined });
    },
    descriptions: () => routes.map(({ method, path, delivery, declared }) => ({ method, path, delivery, declared })),
    async dispatch(req, res) {
      // Unit callers can use a minimal response double; HTTP callers get the guard.
      if (typeof res.writeHead === 'function') guardDelivery(req, res);
      const url = new URL(req.url ?? '/', 'http://local');
      const parts = url.pathname.split('/').filter(Boolean);
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = match(route.segments, parts);
        if (!params) continue;
        classes.set(res, route.delivery);
        // A person-private route never answers a public class, so on a
        // public-only hostname its handler does not run at all.
        if (publicOnly.has(res) && route.delivery === 'person-private') {
          sendError(res, 404, 'PUBLIC_HOST_ONLY', 'This hostname serves public files only.');
          return route.path;
        }
        if (guard && !(await guard(req, res, { method: route.method, path: route.path }))) return route.path;
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

export async function readJson(req: IncomingMessage, maxBytes = JSON_BODY_DEFAULT_BYTES): Promise<unknown> {
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
  const data = Buffer.from(JSON.stringify(body)), req = requests.get(res);
  const encoded = req ? encodeText(req, data, 'application/json') : { bytes: data };
  const output: Record<string, string> = { 'cache-control': cachePolicy('person-private', { status }).cacheControl, ...headers };
  if (req) output.vary = appendVary(res.getHeader('vary') ?? headers?.vary, 'Accept-Encoding');
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...output,
    ...(encoded.encoding ? { 'content-encoding': encoded.encoding } : {}), 'content-length': String(encoded.bytes.length) });
  res.end(req?.method === 'HEAD' ? undefined : encoded.bytes);
}

/** `detail` merges extra, already-safe fields into the error object (e.g. the
 *  input a policy refused and the overlay that refused it), so a caller gets
 *  the explanation without parsing the prose message. */
export function sendError(
  res: ServerResponse, status: number, code: string, message: string, detail?: Record<string, unknown>,
): void {
  sendJson(res, status, { error: { code, message, ...detail } });
}
