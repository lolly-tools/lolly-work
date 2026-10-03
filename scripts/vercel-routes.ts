// SPDX-License-Identifier: MPL-2.0
/**
 * Route table for the Vercel Build Output API (`.vercel/output/config.json`),
 * kept pure so tests can check it without running a build.
 *
 * Two modes:
 *
 * - Without a shell origin (the demo at lolly.work), one catch-all sends every
 *   path to the function. This is the table the build has always written.
 * - With `LW_SHELL_ORIGIN` (a private instance that serves the Lolly app on its
 *   own origin), the order is:
 *     1. the OSS project's own serverless functions (`/api/ca/*`, `/api/penpot/*`,
 *        `/api/mcp`, `/api/mcp/*`, `/api/fetch-image`) proxied to the shell origin,
 *        because the shell calls them same-origin and this function has none of them;
 *     2. every top-level prefix the lolly-work router registers, to the function,
 *        with the `request.path` transform that restores the caller's path;
 *     3. `/tools/<anything>` to the function (tool files, filtered per caller);
 *     4. everything else, including the bare `/tools` gallery route, proxied to
 *        the shell origin.
 *   Both proxy routes delete the Cookie header before the request leaves for the
 *   shell origin, so the instance's session cookie (Path=/) never reaches another
 *   project's functions, logs or upstreams. The catch-all also deletes
 *   Authorization; the OSS functions keep it, because the Penpot proxy forwards
 *   it as the user's own Penpot token.
 *
 * The function prefixes are derived by scanning `server/src` for router
 * registrations and unioned with a baseline list, so a scan that misses an
 * unusual registration can never drop a prefix that is known today.
 *
 * `caddyfile()` writes the same table for Caddy in front of a long-lived server
 * (deploy/vm, the lolly.ing VM), from the same scan, plus the WebSocket upgrade
 * path the server's collab gateway answers (`UPGRADE_PREFIXES`), which the
 * function has no gateway for.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Build Output API route transforms (shape checked against
 *  vercel.com/docs/build-output-api/configuration, 2026-10-02). */
export type VercelTransform =
  | { type: 'request.path'; op: 'set'; args: string }
  | { type: 'request.headers'; op: 'delete'; target: { key: string } };

export interface VercelRoute {
  src: string;
  dest: string;
  transforms?: VercelTransform[];
}

/** Top-level path segments the lolly-work router owns today. */
export const FUNCTION_PREFIX_BASELINE: readonly string[] = [
  'activate', 'admin', 'api', 'catalog', 'connect', 'healthz', 'l', 'metrics', 'readyz', 'render', 'scim', 'tools',
];

/** Paths the OSS deployment serves from its own functions, which the shell
 *  calls on its own origin. lolly-work registers nothing under them (a test
 *  checks that), so they go to the shell origin before the `api` prefix. */
export const SHELL_FUNCTION_PATHS = '^/(api/(?:ca|penpot|mcp)(?:/.*)?|api/fetch-image)$';

/** Function prefixes, other than `api`, `catalog` and `tools`, whose paths a
 *  browser may navigate to: the console, activation, share links, connect,
 *  renders, SCIM and the probes. The shell's service worker stores any ok
 *  navigation whose last segment has no dot as its offline app shell, and
 *  answers a 5xx navigation with that shell, unless the path is in its
 *  BYPASS_PATTERNS (lolly shells/web/public/sw.js). On a shared origin each of
 *  these must be listed there; tests/vercel-routes.test.ts checks this list
 *  against the router and, when a Lolly checkout is beside this repository,
 *  against that sw.js. (`/api/` and `/catalog/` are bypassed already, and
 *  `/tools/<id>/<file>` paths end in a file name.) */
export const SHELL_SW_BYPASS_PREFIXES: readonly string[] = [
  'activate', 'admin', 'connect', 'healthz', 'l', 'metrics', 'readyz', 'render', 'scim',
];

/** Top-level paths a WebSocket upgrade arrives on: the collab gateway's
 *  `/ws/collab/<session>` (server/src/collab/gateway.ts COLLAB_WS_PREFIX). The
 *  router registers nothing there, so they are not in the scan or the
 *  baseline; only a host that runs the gateway (server/src/main.ts) routes them
 *  to the server. The Vercel table leaves them to the shell origin: a rewrite
 *  to another origin does not carry a WebSocket. */
export const UPGRADE_PREFIXES: readonly string[] = ['ws'];

const FUNCTION_DEST = '/api/index';
const restorePath: VercelTransform[] = [{ type: 'request.path', op: 'set', args: '/$1' }];
const dropHeader = (key: string): VercelTransform => ({ type: 'request.headers', op: 'delete', target: { key } });

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path, out);
    else if (name.endsWith('.ts')) out.push(path);
  }
  return out;
}

/** Every registered route path literal under `srcDir`: the second argument of an
 *  `add('METHOD', '/path', ...)` or `add(method, \`/path...\`, ...)` call. */
export function scanRouterPaths(srcDir: string): string[] {
  const paths = new Set<string>();
  const call = /\badd\(\s*(?:'[A-Z]+'|[a-zA-Z_$][\w$]*)\s*,\s*(['`])(\/[^'`]*)\1?/g;
  for (const file of walk(srcDir)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(call)) paths.add(match[2]!);
  }
  return [...paths].sort();
}

/** First path segment of each registered route, excluding the shell fallback
 *  (`/` and `/*`), which only exists when a shell directory is mounted, and
 *  paths that open with a parameter: those come from module-local helpers that
 *  prepend their own base (renders/batch-routes.ts), not from the root. */
export function scanRouterPrefixes(srcDir: string): string[] {
  const prefixes = new Set<string>();
  for (const path of scanRouterPaths(srcDir)) {
    const first = path.split('/')[1]?.split('${')[0] ?? '';
    if (first && first !== '*' && !first.startsWith(':')) prefixes.add(first);
  }
  return [...prefixes].sort();
}

export function functionPrefixes(srcDir: string): string[] {
  return [...new Set([...FUNCTION_PREFIX_BASELINE, ...scanRouterPrefixes(srcDir)])].sort();
}

/** An https origin with no path, query, fragment or credentials; returned in
 *  its normalised `URL.origin` form. Throws with the reason otherwise. */
export function parseShellOrigin(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error('LW_SHELL_ORIGIN must be an absolute https origin such as https://lolly.tools');
  }
  if (url.protocol !== 'https:') throw new Error('LW_SHELL_ORIGIN must use https');
  if (url.username || url.password) throw new Error('LW_SHELL_ORIGIN must not carry credentials');
  if (url.pathname !== '/' || url.search || url.hash || /[?#]/.test(value)) {
    throw new Error('LW_SHELL_ORIGIN must be an origin only, with no path, query or fragment');
  }
  return url.origin;
}

/** Vercel region ids for `.vc-config.json` `regions`, from a comma-separated list. */
export function parseRegions(value: string): string[] {
  const regions = value.split(',').map((r) => r.trim()).filter(Boolean);
  if (!regions.length || regions.some((r) => !/^[a-z]{3}\d+$/.test(r))) {
    throw new Error('LW_FUNCTION_REGION must be one or more Vercel region ids, such as fra1');
  }
  return regions;
}

const escape = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

export function vercelRoutes(opts: { shellOrigin?: string; prefixes?: readonly string[] } = {}): VercelRoute[] {
  if (!opts.shellOrigin) {
    return [{ src: '^/(.*)$', dest: FUNCTION_DEST, transforms: restorePath }];
  }
  const origin = parseShellOrigin(opts.shellOrigin);
  const prefixes = [...(opts.prefixes ?? FUNCTION_PREFIX_BASELINE)].filter((p) => p !== 'tools').sort();
  if (!prefixes.length) throw new Error('no function prefixes');
  // A proxy to the shell origin ends routing, but a rewrite to the function does
  // not: Vercel keeps matching later routes against the rewritten path. With the
  // function rows first and a shell catch-all after them, every function path
  // went on to the shell origin as /api/index and came back NOT_FOUND (first
  // lolly.ing deploy, 2026-10-03). So the shell catch-all excludes the function
  // paths itself and the function row comes last, with nothing after it.
  const functionPaths = `(?:${prefixes.map(escape).join('|')})(?:/|$)|tools/.`;
  return [
    { src: SHELL_FUNCTION_PATHS, dest: `${origin}/$1`, transforms: [dropHeader('cookie')] },
    { src: `^/(?!${functionPaths})(.*)$`, dest: `${origin}/$1`, transforms: [dropHeader('cookie'), dropHeader('authorization')] },
    { src: '^/(.*)$', dest: FUNCTION_DEST, transforms: restorePath },
  ];
}

/** The function's `.vc-config.json`. The demo's is unchanged. A private
 *  instance (a shell origin or a bundled pack) streams its responses: Vercel
 *  refuses a buffered function response over 4.5 MB (413
 *  FUNCTION_PAYLOAD_TOO_LARGE), and a pack built from Lolly holds files above
 *  that, such as the shared emoji sets and Darkroom's LUTs. A streamed response
 *  has no such limit (vercel.com/docs/functions/limitations and the "bypass the
 *  4.5MB body size limit" guide, checked 2026-10-02). */
export function vcFunctionConfig(opts: { shellOrigin?: string; pack?: string; regions?: string[] }): Record<string, unknown> {
  return {
    runtime: 'nodejs24.x',
    handler: 'index.mjs',
    launcherType: 'Nodejs',
    shouldAddHelpers: false,
    supportsResponseStreaming: !!(opts.shellOrigin || opts.pack),
    // Build Output API v3 function config: `regions` is a string[] (verified
    // against vercel.com/docs/build-output-api/primitives, 2026-10-02).
    ...(opts.regions ? { regions: opts.regions } : {}),
  };
}

/** Where a route table sends a request path: the function, or the URL it
 *  is proxied to. First match wins and matching ignores case, as Vercel does by
 *  default. Used by tests and by the build check. */
export function resolveRoute(routes: readonly VercelRoute[], path: string): { to: 'function'; path: string } | { to: 'proxy'; url: string } | null {
  for (const route of routes) {
    const match = new RegExp(route.src, 'i').exec(path);
    if (!match) continue;
    const fill = (template: string): string => template.replace(/\$(\d)/g, (_, n: string) => match[Number(n)] ?? '');
    const setPath = route.transforms?.find((t) => t.type === 'request.path');
    if (route.dest === FUNCTION_DEST) return { to: 'function', path: fill(setPath?.args ?? path) };
    return { to: 'proxy', url: fill(route.dest) };
  }
  return null;
}

// ── Caddy (deploy/vm) ─────────────────────────────────────────────────────────

export interface CaddyOptions {
  /** The instance's own domain, e.g. lolly.ing. */
  domain: string;
  /** Domains answered with a permanent redirect to `domain`, e.g. www.lolly.ing. */
  redirectDomains?: readonly string[];
  /** The https origin the Lolly app is proxied from, as for Vercel. */
  shellOrigin: string;
  /** host:port of the lolly-work server (server/src/main.ts). */
  upstream: string;
  /** Function prefixes; the router scan in practice (`functionPrefixes`). */
  prefixes?: readonly string[];
}

/** One `path_regexp` rule of the Caddy table, in match order. The pattern is
 *  matched ignoring case (Caddy gets it with `(?i)`), as Vercel and
 *  `resolveRoute` match. Anything no rule matches goes to the shell origin with
 *  both credentials removed. */
export interface CaddyRule { name: string; pattern: string; to: 'shell' | 'server' }

/** The Caddy rules: the OSS functions first, then every server path. Caddy's
 *  regular expressions (Go RE2) have no lookahead, so unlike the Vercel table
 *  the order alone keeps the OSS functions away from the `api` prefix. */
export function caddyRules(prefixes: readonly string[] = FUNCTION_PREFIX_BASELINE): CaddyRule[] {
  const own = [...new Set([...prefixes, ...UPGRADE_PREFIXES])].filter((p) => p !== 'tools').sort();
  if (!own.length) throw new Error('no function prefixes');
  // Prefixes come from route literals; anything but a plain word would need
  // quoting in a Caddyfile, so it is refused rather than escaped.
  for (const p of own) if (!/^[a-z0-9_-]+$/i.test(p)) throw new Error(`prefix ${JSON.stringify(p)} is not a plain path segment`);
  return [
    { name: 'shell_functions', pattern: SHELL_FUNCTION_PATHS, to: 'shell' },
    { name: 'control_plane', pattern: `^/(?:(?:${own.join('|')})(?:/|$)|tools/.)`, to: 'server' },
  ];
}

/** Where the Caddy table sends a request path (no query): the server with the
 *  path unchanged, or the shell origin URL. The counterpart of `resolveRoute`. */
export function resolveCaddyRoute(opts: { shellOrigin: string; prefixes?: readonly string[] }, path: string): { to: 'server'; path: string } | { to: 'proxy'; url: string } {
  const origin = parseShellOrigin(opts.shellOrigin);
  const rule = caddyRules(opts.prefixes).find((r) => new RegExp(r.pattern, 'i').test(path));
  return rule?.to === 'server' ? { to: 'server', path } : { to: 'proxy', url: `${origin}${path}` };
}

const hostName = (value: string, what: string): string => {
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(value)) throw new Error(`${what} must be a host name such as lolly.ing`);
  return value.toLowerCase();
};

/** The Caddyfile for one domain on one host (deploy/vm/Caddyfile). */
export function caddyfile(opts: CaddyOptions): string {
  const domain = hostName(opts.domain, 'domain');
  const redirects = (opts.redirectDomains ?? []).map((d) => hostName(d, 'redirect domain'));
  const origin = parseShellOrigin(opts.shellOrigin);
  const shellHost = new URL(origin).host;
  if (!/^[a-z0-9.-]+:\d+$/i.test(opts.upstream)) throw new Error('upstream must be host:port, such as server:8787');
  const rules = caddyRules(opts.prefixes);
  const shell = rules.find((r) => r.to === 'shell')!;
  const server = rules.find((r) => r.to === 'server')!;
  const proxyShell = (dropAuthorization: boolean): string[] => [
    `\t\treverse_proxy ${origin} {`,
    // Caddy sends the upstream's own Host to an https upstream from 2.11 on; say
    // it anyway, so an older Caddy cannot send ours to the shell origin.
    `\t\t\theader_up Host ${shellHost}`,
    '\t\t\theader_up -Cookie',
    ...(dropAuthorization ? ['\t\t\theader_up -Authorization'] : []),
    '\t\t}',
  ];
  return [
    `# Caddy in front of the lolly-work server for ${domain} (deploy/vm/README.md).`,
    '# Generated by `node scripts/build-caddyfile.ts` from scripts/vercel-routes.ts,',
    '# the router scan the Vercel route table also uses. Change the generator and',
    '# regenerate; tests/vercel-routes.test.ts fails while this file is stale.',
    '',
    '# Global options. LW_CADDY_GLOBAL (caddy.env beside docker-compose.yml) is',
    '# empty in normal operation, or `local_certs` to serve certificates from',
    "# Caddy's own authority before DNS points here (smoke.sh --insecure).",
    '{',
    '\tgrace_period 30s',
    '\t{$LW_CADDY_GLOBAL}',
    '}',
    '',
    ...redirects.flatMap((d) => [`${d} {`, `\tredir https://${domain}{uri} 308`, '}', '']),
    `${domain} {`,
    '\t# Vercel sends HSTS with every answer; keep that on this host. `?` leaves',
    '\t# a value the upstream already set alone.',
    '\theader ?Strict-Transport-Security "max-age=63072000"',
    '',
    '\t# Request bodies. The server enforces exact limits; these stop an oversized',
    '\t# body here. 64 MiB is the most the server accepts (a pack or a catalog',
    '\t# submission); project file parts are 1 MiB and sessions 4 MiB.',
    '\t@file_parts path_regexp file_parts (?i)^/api/v1/projects/[^/]+/files/[^/]+/parts/',
    '\trequest_body @file_parts {',
    '\t\tmax_size 2MiB',
    '\t}',
    '\t@session_writes path_regexp session_writes (?i)^/api/v1/(?:projects/[^/]+/sessions|sessions/[^/]+)/?$',
    '\trequest_body @session_writes {',
    '\t\tmax_size 5MiB',
    '\t}',
    '\trequest_body {',
    '\t\tmax_size 65MiB',
    '\t}',
    '',
    "\t# 1. The OSS project's own functions, which the shell calls on its own",
    '\t#    origin. The session cookie stays here; Authorization is kept for the',
    "\t#    Penpot proxy, which forwards it as the user's own Penpot token.",
    `\t@${shell.name} path_regexp ${shell.name} (?i)${shell.pattern}`,
    `\thandle @${shell.name} {`,
    ...proxyShell(false),
    '\t}',
    '',
    '\t# 2. Every path the lolly-work router registers, tool files under /tools/<x>',
    '\t#    and the collab WebSocket (/ws/collab/<session>). Responses stream',
    '\t#    (flush_interval -1); a WebSocket survives a Caddy reload for 5 minutes.',
    `\t@${server.name} path_regexp ${server.name} (?i)${server.pattern}`,
    `\thandle @${server.name} {`,
    `\t\treverse_proxy ${opts.upstream} {`,
    '\t\t\tflush_interval -1',
    '\t\t\tstream_close_delay 5m',
    '\t\t}',
    '\t}',
    '',
    '\t# 3. Everything else is the Lolly app, proxied from the shell origin with',
    '\t#    no credential of this instance.',
    '\thandle {',
    ...proxyShell(true),
    '\t}',
    '}',
    '',
  ].join('\n');
}
