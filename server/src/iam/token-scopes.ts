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

export const TOKEN_SCOPES = ['render', 'documents', 'files', 'delivery', 'catalog.read', 'audit.read', 'approvals.request'] as const;
export type TokenScope = (typeof TOKEN_SCOPES)[number];

/** Plain words for the console, the CLI and the docs. */
const SCOPE_WORDS: Record<TokenScope, { label: string; description: string }> = {
  render: { label: 'Render files', description: 'Make files from tools, as single renders or batches, and follow their jobs. Also reads tool schemas and resolves visual intents.' },
  documents: { label: 'Work with documents', description: 'Compile, check, inspect, measure, optimize, compare and package documents.' },
  files: { label: 'Send and keep files', description: 'Upload input files and keep file references.' },
  delivery: { label: 'Deliver finished renders', description: 'Send this token\'s own finished renders to organisation destinations and follow those sends.' },
  'catalog.read': { label: 'Read the catalog', description: 'Read catalog and tool files, and search the catalog.' },
  'audit.read': { label: 'Read the audit trail', description: 'Read audit records and the audit head.' },
  'approvals.request': { label: 'Ask for approval', description: 'File an export review on this token\'s own finished renders, read those requests and withdraw them. Deciding stays with people.' },
};

export function tokenScopeVocabulary(): { version: number; scopes: Array<{ id: TokenScope; label: string; description: string }> } {
  return { version: TOKEN_SCOPES_VERSION, scopes: TOKEN_SCOPES.map((id) => ({ id, ...SCOPE_WORDS[id] })) };
}

/** The scopes a token minted for a partner programme may hold (plans/82 M7).
 *  Never `delivery`, which pushes to the lead brand's own destinations, and never
 *  `audit.read`, because the audit trail names people. */
export const PROGRAMME_TOKEN_SCOPES: readonly TokenScope[] = ['render', 'documents', 'files', 'catalog.read', 'approvals.request'];
/** What a programme token holds when the manager names no scopes. */
export const PROGRAMME_TOKEN_DEFAULT_SCOPES: readonly TokenScope[] = ['render', 'catalog.read'];

/** The scopes a programme token's mint asks for, checked against the caps. */
export function parseProgrammeTokenScopes(raw: unknown): TokenScope[] | { error: string; code: 'INVALID_INPUT' | 'SCOPE_NOT_FOR_PROGRAMME' } {
  if (raw === undefined) return [...PROGRAMME_TOKEN_DEFAULT_SCOPES];
  if (!Array.isArray(raw) || !raw.length) return { error: 'scopes must be a non-empty list', code: 'INVALID_INPUT' };
  const unknown = raw.find((scope) => !TOKEN_SCOPES.includes(scope as TokenScope));
  if (unknown !== undefined) return { error: `unknown scope: ${String(unknown).slice(0, 40)}. Scopes are: ${TOKEN_SCOPES.join(', ')}`, code: 'INVALID_INPUT' };
  const refused = raw.find((scope) => !PROGRAMME_TOKEN_SCOPES.includes(scope as TokenScope));
  if (refused !== undefined) {
    return { error: `a programme token cannot hold ${String(refused)}. It may hold ${PROGRAMME_TOKEN_SCOPES.join(', ')}`, code: 'SCOPE_NOT_FOR_PROGRAMME' };
  }
  return TOKEN_SCOPES.filter((scope) => raw.includes(scope));
}

/** Roles a token may name. The automation role is for tokens only and always needs scopes. */
export const TOKEN_ROLES: readonly string[] = [...ROLES.filter((role) => role !== 'guest'), AUTOMATION_ROLE];

const ANY = 'any' as const;
const WORK = ['render', 'documents'] as const;

/** The migration API's answers for what it does not cover. A scoped token reaches
 *  them so a client learns why with a 501, rather than a scope refusal. */
const MIGRATION_API_UNSUPPORTED = ['/compat/bannerbear/v5/webhooks', '/compat/bannerbear/v5/webhooks/*', '/compat/bannerbear/v5/*', '/compat/bannerbear/v2/*', '/compat/placid/api/rest/*']
  .flatMap((path) => ['GET', 'POST', 'PATCH', 'PUT', 'DELETE'].map((method): [string, readonly TokenScope[]] => [`${method} ${path}`, ['render']]));

/** `METHOD pattern` to the scopes that open it. `any` is a route that only says
 *  who the caller is and what they can do, so every scoped token may read it. */
const ROUTE_SCOPES: Readonly<Record<string, typeof ANY | readonly TokenScope[]>> = {
  ...Object.fromEntries(MIGRATION_API_UNSUPPORTED),

  'POST /compat/bannerbear/v5/images': ['render'],
  'GET /compat/bannerbear/v5/images': ['render'],
  'GET /compat/bannerbear/v5/images/:id': ['render'],
  'POST /compat/bannerbear/sync/v5/images': ['render'],
  'POST /compat/bannerbear/v2/images': ['render'],
  'GET /compat/bannerbear/v2/images/:id': ['render'],
  'POST /compat/bannerbear/sync/v2/images': ['render'],
  'GET /compat/bannerbear/v2/auth': ['render'],
  'POST /compat/placid/api/rest/images': ['render'],
  'GET /compat/placid/api/rest/images/:id': ['render'],
  'DELETE /compat/placid/api/rest/images/:id': ['render'],
  'GET /compat/files/:id/:file': ['render'],
  'DELETE /compat/requests/:id': ['render'],
  // These need no token. A client that sends its token anyway must not lose the file.
  'GET /compat/files/:id/:expires/:signature/:file': ['render'],
  'HEAD /compat/files/:id/:expires/:signature/:file': ['render'],
  'GET /compat/placid/u/:uuid': ['render'],

  // A published brand page needs no token. A client that sends one anyway must not
  // lose the page. Publishing, listing, history, preview and unpublish are absent on
  // purpose: putting files at a public address is a person's or a full token's act.
  'GET /brand/:slug/*': ANY,
  'HEAD /brand/:slug/*': ANY,
  'GET /brand/:slug/mcp': ANY,
  'HEAD /brand/:slug/mcp': ANY,
  'POST /brand/:slug/mcp': ANY,
  'GET /.well-known/lolly-brand.json': ANY,
  'HEAD /.well-known/lolly-brand.json': ANY,
  'GET /api/v1/brand-pages/public': ANY,
  'HEAD /api/v1/brand-pages/public': ANY,

  'GET /api/auth/session': ANY,
  'GET /api/v1/discovery': ANY,
  'GET /api/v1/discovery/me': ANY,
  // The MCP endpoint itself is open to any scoped token. Each tool call dispatches
  // the route it mirrors, so this table refuses a tool outside the token's scopes.
  'GET /api/v1/mcp': ANY,
  'POST /api/v1/mcp': ANY,

  // Brand context (plans/82 M7, automation/context-routes.ts): who the token is and
  // which design system it draws with reach every token; the brand's files, its
  // skills and the partner's own details are catalog reads.
  'GET /api/v1/context': ANY,
  'GET /api/v1/context/me': ANY,
  'GET /api/v1/context/brand': ANY,
  'GET /api/v1/context/brand/design-md': ['catalog.read'],
  'GET /api/v1/context/brand/tokens': ['catalog.read'],
  'GET /api/v1/context/brand/agents-md': ['catalog.read'],
  'GET /api/v1/context/brand/checks': ['catalog.read'],
  'GET /api/v1/context/brand/skills': ['catalog.read'],
  'GET /api/v1/context/brand/skills/:slug/*': ['catalog.read'],
  'GET /api/v1/context/partner/company': ['catalog.read'],
  'GET /api/v1/context/partner/company/logo/:surface': ['catalog.read'],
  'GET /api/v1/context/partner/templates': ['catalog.read'],

  'GET /api/v1/discovery/tools': WORK,
  'GET /api/v1/schema/:toolId': WORK,
  'POST /api/v1/validate': WORK,
  'GET /api/v1/jobs': WORK,
  'GET /api/v1/jobs/:id': WORK,
  'GET /api/v1/jobs/:id/result': WORK,
  'DELETE /api/v1/jobs/:id': WORK,

  // A plan for a render, read with the same rights a render needs.
  'POST /api/v1/intents/resolve': ['render'],
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
  'GET /api/v1/render-batches/:id/archive': ['render'],
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

  // Only by reference to a job or render this token finished. Sending a raw body
  // stays with a person or an unscoped token.
  'GET /api/v1/destinations': ['delivery'],
  'POST /api/v1/jobs/:id/deliveries': ['delivery'],
  'POST /api/v1/renders/:id/deliveries': ['delivery'],
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

  // Asking for approval (plans/82 M7): a token files and follows its own export
  // reviews. Acting on a step, listing approvers and reading the file stay with people.
  'POST /api/v1/approvals': ['approvals.request'],
  'GET /api/v1/approvals': ['approvals.request'],
  'GET /api/v1/approvals/:id': ['approvals.request'],
  'POST /api/v1/approvals/:id/withdraw': ['approvals.request'],

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
