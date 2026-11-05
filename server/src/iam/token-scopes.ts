// SPDX-License-Identifier: MPL-2.0
/**
 * Scopes on service tokens: what a token may reach, stated when it is minted.
 *
 * A scope only ever takes away. The route table below decides which routes a
 * scoped token may reach at all; the handler then applies the token's role and
 * grants exactly as it does for any other caller. So a route must pass both, and
 * no scope can give a token an action its role lacks.
 *
 * The table is the whole contract. A route that is not in it refuses every scoped
 * token, so a new route stays out of reach until someone adds it here on purpose.
 * The check runs once, in the router (`tokenScopeGuard`), before any handler, and
 * tests/token-scopes.test.ts walks the routes the real app registers.
 *
 * A token with no scopes keeps the behaviour it always had: the guard never looks
 * at it. Scopes and the tool list are fixed at mint; a change means a new token.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import { sendError, type RouteGuard } from '../api/router.ts';
import { AUTOMATION_ROLE, ROLES } from '../rbac/evaluate.ts';

/** Raised when the vocabulary changes meaning. New scopes are added, never redefined. */
export const TOKEN_SCOPES_VERSION = 1;

export const TOKEN_SCOPES = ['render', 'documents', 'files', 'delivery', 'catalog.read', 'audit.read'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Plain words for the console, the CLI and the docs. */
const SCOPE_WORDS: Record<TokenScope, { label: string; description: string }> = {
  render: { label: 'Render files', description: 'Make files from tools, as single renders or batches, and follow their jobs. Also reads tool schemas.' },
  documents: { label: 'Work with documents', description: 'Compile, check, inspect, measure, optimize, compare and package documents.' },
  files: { label: 'Send and keep files', description: 'Upload input files and keep file references.' },
  delivery: { label: 'Deliver finished renders', description: 'Send this token\'s own finished renders to organisation destinations and follow those sends.' },
  'catalog.read': { label: 'Read the catalog', description: 'Read catalog and tool files, and search the catalog.' },
  'audit.read': { label: 'Read the audit trail', description: 'Read audit records and the audit head.' },
};

export function tokenScopeVocabulary(): { version: number; scopes: Array<{ id: TokenScope; label: string; description: string }> } {
  return { version: TOKEN_SCOPES_VERSION, scopes: TOKEN_SCOPES.map((id) => ({ id, ...SCOPE_WORDS[id] })) };
}

/** Roles a token may name. The automation role is for tokens only and always needs scopes. */
export const TOKEN_ROLES: readonly string[] = [...ROLES.filter((role) => role !== 'guest'), AUTOMATION_ROLE];

const ANY = 'any' as const;
const WORK = ['render', 'documents'] as const;

/** `METHOD pattern` to the scopes that open it. `any` is a route that only says
 *  who the caller is and what they can do, so every scoped token may read it. */
const ROUTE_SCOPES: Readonly<Record<string, typeof ANY | readonly TokenScope[]>> = {
  'GET /api/auth/session': ANY,
  'GET /api/v1/discovery': ANY,
  'GET /api/v1/discovery/me': ANY,

  'GET /api/v1/discovery/tools': WORK,
  'GET /api/v1/schema/:toolId': WORK,
  'POST /api/v1/validate': WORK,
  'GET /api/v1/jobs': WORK,
  'GET /api/v1/jobs/:id': WORK,
  'GET /api/v1/jobs/:id/result': WORK,
  'DELETE /api/v1/jobs/:id': WORK,

  'POST /api/v1/render': ['render'],
  'POST /api/v1/batch': ['render'],
  'GET /api/v1/renders': ['render'],
  'POST /api/v1/renders': ['render'],
  'GET /api/v1/renders/:id': ['render'],
  'DELETE /api/v1/renders/:id': ['render'],
  'GET /api/v1/renders/:id/output/:name': ['render'],
  'GET /api/v1/renders/:id/evidence': ['render'],
  'POST /api/v1/renders/:id/retry': ['render'],
  'GET /api/v1/render-batches': ['render'],
  'POST /api/v1/render-batches': ['render'],
  'GET /api/v1/render-batches/:id': ['render'],
  'DELETE /api/v1/render-batches/:id': ['render'],
  'GET /api/v1/render-batches/:id/manifest': ['render'],
  'POST /api/v1/render-batches/:id/retry': ['render'],

  'POST /api/v1/compile': ['documents'],
  'POST /api/v1/inspect': ['documents'],
  'POST /api/v1/measure': ['documents'],
  'POST /api/v1/optimize': ['documents'],
  'POST /api/v1/diff': ['documents'],
  'POST /api/v1/package': ['documents'],

  'GET /api/v1/uploads': ['files'],
  'POST /api/v1/uploads': ['files'],
  'GET /api/v1/uploads/:id': ['files'],
  'DELETE /api/v1/uploads/:id': ['files'],
  'GET /api/v1/uploads/:id/parts': ['files'],
  'PUT /api/v1/uploads/:id/parts/:part': ['files'],
  'POST /api/v1/uploads/:id/finalize': ['files'],
  'GET /api/v1/files': ['files'],
  'POST /api/v1/files': ['files'],
  'GET /api/v1/files/:id': ['files'],
  'DELETE /api/v1/files/:id': ['files'],
  'GET /api/v1/files/:id/content': ['files'],

  // Only by reference to a job this token finished. Sending a raw body stays with
  // a person or an unscoped token.
  'GET /api/v1/destinations': ['delivery'],
  'POST /api/v1/jobs/:id/deliveries': ['delivery'],
  'GET /api/v1/deliveries': ['delivery'],
  'GET /api/v1/deliveries/:id': ['delivery'],
  'POST /api/v1/deliveries/:id/retry': ['delivery'],

  'GET /catalog/*': ['catalog.read'],
  'HEAD /catalog/*': ['catalog.read'],
  'HEAD /catalog/fonts/*': ['catalog.read'],
  'GET /tools/*': ['catalog.read'],
  'HEAD /tools/*': ['catalog.read'],
  'GET /api/v1/catalog/fields': ['catalog.read'],
  'GET /api/v1/catalog/search': ['catalog.read'],

  'GET /api/v1/audit': ['audit.read'],
  'GET /api/v1/audit/head': ['audit.read'],
};

/** Every route a scoped token could ever reach, for the walking test. */
export function scopedRouteKeys(): string[] {
  return Object.keys(ROUTE_SCOPES);
}

/** The scopes that open a route, `any`, or null when the route declares none. */
export function routeScopes(method: string, path: string): typeof ANY | readonly TokenScope[] | null {
  return Object.hasOwn(ROUTE_SCOPES, `${method} ${path}`) ? ROUTE_SCOPES[`${method} ${path}`]! : null;
}

export function scopesAllowRoute(scopes: readonly string[], method: string, path: string): boolean {
  const required = routeScopes(method, path);
  if (required === null) return false;
  return required === ANY || required.some((scope) => scopes.includes(scope));
}

/** RBAC action to the scopes that can use it, so discovery reports what the token
 *  can really do. An action not listed here is out of reach of every scoped token. */
const ACTION_SCOPES: Readonly<Record<string, readonly TokenScope[]>> = {
  'tool.use': WORK,
  'export.server': ['render'],
  'delivery.create': ['delivery'],
  'catalog.read': ['catalog.read'],
  'audit.export': ['audit.read'],
};

export function scopesCoverAction(scopes: readonly string[], action: string): boolean {
  return Object.hasOwn(ACTION_SCOPES, action) && ACTION_SCOPES[action]!.some((scope) => scopes.includes(scope));
}

const TOOL_ID = /^[a-z0-9][a-z0-9-]{0,127}$/;
const MAX_TOKEN_TOOLS = 64;

export interface TokenAuthority { role: string; scopes?: TokenScope[]; tools?: string[] }

/** Read `role`, `scopes` and `tools` from a mint request. Naming scopes without a
 *  role picks the automation role; a token with no scopes keeps today's rule that
 *  the role is required. */
export function parseTokenAuthority(body: { role?: unknown; scopes?: unknown; tools?: unknown } | null): TokenAuthority | { error: string } {
  let scopes: TokenScope[] | undefined;
  if (body?.scopes !== undefined) {
    if (!Array.isArray(body.scopes) || !body.scopes.length) return { error: 'scopes must be a non-empty list; leave it out for a token with its role\'s full reach' };
    const unknown = body.scopes.filter((scope) => !TOKEN_SCOPES.includes(scope as TokenScope));
    if (unknown.length) return { error: `unknown scope: ${String(unknown[0]).slice(0, 40)}. Scopes are: ${TOKEN_SCOPES.join(', ')}` };
    scopes = TOKEN_SCOPES.filter((scope) => (body.scopes as unknown[]).includes(scope));
  }
  const role = body?.role === undefined && scopes ? AUTOMATION_ROLE : body?.role;
  if (typeof role !== 'string' || !TOKEN_ROLES.includes(role)) return { error: `role must be one of: ${TOKEN_ROLES.join(', ')}` };
  if (role === AUTOMATION_ROLE && !scopes) return { error: `the ${AUTOMATION_ROLE} role needs scopes` };
  let tools: string[] | undefined;
  if (body?.tools !== undefined) {
    if (!scopes?.some((scope) => WORK.includes(scope as (typeof WORK)[number]))) return { error: 'a tools list needs the render or documents scope' };
    if (!Array.isArray(body.tools) || !body.tools.length || body.tools.length > MAX_TOKEN_TOOLS) return { error: `tools must list 1 to ${MAX_TOKEN_TOOLS} tool ids` };
    if (body.tools.some((id) => typeof id !== 'string' || !TOOL_ID.test(id))) return { error: 'tools must be tool ids' };
    tools = [...new Set(body.tools as string[])].sort();
  }
  return { role, ...(scopes ? { scopes } : {}), ...(tools ? { tools } : {}) };
}

/** The one enforcement point, installed on the router. `scopesOf` answers null for
 *  a request with no live scoped token, which the guard leaves alone: an unknown or
 *  revoked token is refused by the route's own sign-in check, as it always was. */
export function tokenScopeGuard(deps: {
  scopesOf(req: IncomingMessage): Promise<readonly string[] | null>;
  onRefused?(routePath: string): void;
}): RouteGuard {
  return async (req: IncomingMessage, res: ServerResponse, route) => {
    const scopes = await deps.scopesOf(req);
    if (!scopes || scopesAllowRoute(scopes, route.method, route.path)) return true;
    deps.onRefused?.(route.path);
    const required = routeScopes(route.method, route.path);
    sendError(res, 403, 'TOKEN_SCOPE', 'This service token\'s scopes do not cover this route.', Array.isArray(required) ? { requiredScopes: required } : undefined);
    return false;
  };
}
