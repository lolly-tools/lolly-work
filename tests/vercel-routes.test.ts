// SPDX-License-Identifier: MPL-2.0
/**
 * The Vercel route table (scripts/vercel-routes.ts) in both modes. The demo
 * keeps its single catch-all; shell mode must send every path the lolly-work
 * router registers to the function and everything else, including the OSS
 * project's own functions and the bare /tools gallery, to the shell origin.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';

import {
  FUNCTION_PREFIX_BASELINE, SHELL_SW_BYPASS_PREFIXES, UPGRADE_PREFIXES, caddyRules, caddyfile, functionPrefixes, parseRegions,
  parseShellOrigin, resolveCaddyRoute, resolveRoute, scanRouterPaths, scanRouterPrefixes, vcFunctionConfig, vercelRoutes,
} from '../scripts/vercel-routes.ts';
import { CADDYFILE_PATH, LOLLY_ING, generate as generateLollyIngCaddyfile } from '../scripts/build-caddyfile.ts';

const SRC = join(dirname(fileURLToPath(import.meta.url)), '..', 'server', 'src');
const ORIGIN = 'https://shell.example.test';
const LOLLY_SW = ((): string | undefined => {
  const path = join(resolve(process.env.LOLLY_DIR ?? join(SRC, '..', '..', '..', 'lolly')), 'shells', 'web', 'public', 'sw.js');
  return existsSync(path) ? path : undefined;
})();

test('without a shell origin the table is the demo catch-all, unchanged', () => {
  assert.deepEqual(vercelRoutes(), [
    { src: '^/(.*)$', dest: '/api/index', transforms: [{ type: 'request.path', op: 'set', args: '/$1' }] },
  ]);
  assert.deepEqual(resolveRoute(vercelRoutes(), '/'), { to: 'function', path: '/' });
  assert.deepEqual(resolveRoute(vercelRoutes(), '/tools'), { to: 'function', path: '/tools' });
});

test('the router scan finds every prefix the baseline names, and nothing outside it', () => {
  const scanned = scanRouterPrefixes(SRC);
  assert.deepEqual(scanned, [...FUNCTION_PREFIX_BASELINE].sort(),
    'a new top-level route prefix needs adding to FUNCTION_PREFIX_BASELINE (and a look at RESERVED_PREFIX in app.ts)');
});

test('shell mode sends every registered route to the function', () => {
  const routes = vercelRoutes({ shellOrigin: ORIGIN, prefixes: functionPrefixes(SRC) });
  const paths = scanRouterPaths(SRC);
  assert.ok(paths.length > 100, 'the scan sees the router');
  for (const pattern of paths) {
    // A path that opens with a parameter belongs to a module-local helper that
    // prefixes its own base (renders/batch-routes.ts adds under /api/v1/render-batches).
    if (pattern.startsWith('/:')) continue;
    const sample = pattern.replace(/\$\{[^}]*\}.*$/, '').replace(/:[A-Za-z_]+/g, 'x').replace(/\/\*$/, '/a/b');
    if (sample === '/' || sample === '/a/b') continue; // the shell fallback, never mounted on Vercel
    assert.deepEqual(resolveRoute(routes, sample), { to: 'function', path: sample }, `${pattern} (sampled as ${sample})`);
  }
});

/** Paths the shell-mode table must send to the shell origin, and to the function. */
const SHELL_PATHS = ['/', '/tools', '/tools/', '/t/qr-code', '/view/tools.html', '/_app/x.js', '/info/index.html', '/models/a.onnx',
  '/sw.js', '/lab', '/llms.txt', '/api/ca/sign', '/api/penpot/export', '/api/mcp', '/api/mcp/sse', '/api/fetch-image'];
const FUNCTION_PATHS = ['/tools/qr-code/tool.json', '/catalog/tools/index.json', '/catalog/tools/index.sig.json', '/api/v1/org-config',
  '/api/auth/callback', '/api/brand/x', '/healthz', '/readyz', '/metrics', '/admin', '/admin/app.js', '/l/abc', '/render/qr.svg',
  '/scim/v2/Users', '/activate', '/connect/pack.lolly', '/api/castle', '/api/mcpx', '/info/media/agent-collaboration-review.mp4'];

test('shell mode proxies the app, the gallery and the OSS functions to the shell origin', () => {
  const routes = vercelRoutes({ shellOrigin: ORIGIN, prefixes: functionPrefixes(SRC) });
  for (const path of SHELL_PATHS) {
    assert.deepEqual(resolveRoute(routes, path), { to: 'proxy', url: `${ORIGIN}${path}` }, path);
  }
  for (const path of FUNCTION_PATHS) {
    assert.deepEqual(resolveRoute(routes, path), { to: 'function', path }, path);
  }
  // Order: the OSS functions are matched before the generic api prefix.
  assert.match(routes[0]!.dest, /^https:/);
  assert.equal(routes.at(-1)!.src, '^/(.*)$');
});

test('no proxied request carries the instance session to the shell origin', () => {
  const routes = vercelRoutes({ shellOrigin: ORIGIN, prefixes: functionPrefixes(SRC) });
  const proxies = routes.filter((r) => /^https:/.test(r.dest));
  assert.ok(proxies.length >= 2);
  const deleted = (r: (typeof routes)[number]): string[] =>
    (r.transforms ?? []).filter((t) => t.type === 'request.headers' && t.op === 'delete').map((t) => String((t as { target: { key: string } }).target.key));
  for (const route of proxies) assert.ok(deleted(route).includes('cookie'), `${route.src} strips the Cookie header`);
  // The app itself needs no credential. The OSS functions keep Authorization,
  // which the Penpot proxy forwards as the user's own Penpot token.
  const shellCatchAll = proxies.find((r) => r.src.startsWith('^/(?!'));
  assert.ok(shellCatchAll && deleted(shellCatchAll).includes('authorization'), 'the shell catch-all strips Authorization');
  assert.ok(!deleted(routes[0]!).includes('authorization'), 'the OSS functions keep Authorization');
  // Function routes are untouched: the function needs the session.
  for (const route of routes.filter((r) => r.dest === '/api/index')) assert.equal(deleted(route).length, 0);
  // The demo table has no proxy and so no transform beyond the path.
  assert.deepEqual(vercelRoutes()[0]!.transforms, [{ type: 'request.path', op: 'set', args: '/$1' }]);
});

test('every function navigation outside /api and /catalog is one the shell service worker must bypass', () => {
  // A navigation the shell's service worker does not bypass, and whose last
  // segment has no dot, is stored as the offline app shell. Each of these is a
  // function page or endpoint, so the worker must leave it to the network.
  assert.deepEqual([...SHELL_SW_BYPASS_PREFIXES].sort(), functionPrefixes(SRC).filter((p) => !['api', 'catalog', 'tools'].includes(p)).sort());
});

test('a Lolly checkout\'s service worker bypasses every function navigation', { skip: !LOLLY_SW && 'no Lolly checkout beside this repository (set LOLLY_DIR)' }, () => {
  const source = readFileSync(LOLLY_SW!, 'utf8');
  const block = /const BYPASS_PATTERNS = (\[[\s\S]*?\n\]);/.exec(source)?.[1];
  assert.ok(block, 'sw.js declares BYPASS_PATTERNS');
  const patterns = runInNewContext(block) as RegExp[];
  const paths = [...SHELL_SW_BYPASS_PREFIXES.flatMap((prefix) => [`/${prefix}`, `/${prefix}/x`]), '/api/x', '/catalog/x'];
  for (const path of paths) {
    assert.ok(patterns.some((p) => p.test(path)), `${path} must be in the shell service worker's BYPASS_PATTERNS`);
  }
});

test('the function config is the demo one until a private instance is built, which streams', () => {
  assert.deepEqual(vcFunctionConfig({}), {
    runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: false,
  });
  assert.equal(JSON.stringify(vcFunctionConfig({})), JSON.stringify({
    runtime: 'nodejs24.x', handler: 'index.mjs', launcherType: 'Nodejs', shouldAddHelpers: false, supportsResponseStreaming: false,
  }), 'key order is the demo build\'s');
  assert.deepEqual(vcFunctionConfig({ regions: ['fra1'] }).regions, ['fra1']);
  // A bundled pack can hold files over the 4.5 MB buffered response limit
  // (emoji sets, LUTs), which only a streaming function can return.
  assert.equal(vcFunctionConfig({ shellOrigin: ORIGIN }).supportsResponseStreaming, true);
  assert.equal(vcFunctionConfig({ pack: 'packs/x' }).supportsResponseStreaming, true);
});

test('lolly-work registers nothing under the paths proxied to the OSS functions', () => {
  for (const path of scanRouterPaths(SRC)) {
    assert.ok(!/^\/api\/(ca|penpot|mcp)(\/|$)|^\/api\/fetch-image$/.test(path), `${path} would be shadowed by the shell proxy`);
  }
});

test('the shell origin must be a bare https origin', () => {
  assert.equal(parseShellOrigin('https://lolly.tools'), 'https://lolly.tools');
  assert.equal(parseShellOrigin('https://lolly.tools/'), 'https://lolly.tools');
  assert.equal(parseShellOrigin('https://Lolly.Tools:8443'), 'https://lolly.tools:8443');
  for (const bad of ['http://lolly.tools', 'https://lolly.tools/app', 'https://lolly.tools?x=1', 'https://lolly.tools/#a',
    'https://u:p@lolly.tools', 'lolly.tools', '']) {
    assert.throws(() => parseShellOrigin(bad), /LW_SHELL_ORIGIN/, bad);
  }
  assert.throws(() => vercelRoutes({ shellOrigin: 'http://lolly.tools' }), /https/);
});

test('function regions are Vercel region ids', () => {
  assert.deepEqual(parseRegions('fra1'), ['fra1']);
  assert.deepEqual(parseRegions('fra1, cdg1'), ['fra1', 'cdg1']);
  for (const bad of ['', 'Frankfurt', 'fra-1', 'fra1;rm']) assert.throws(() => parseRegions(bad), /LW_FUNCTION_REGION/);
});

test('nothing follows the function rewrite, because Vercel keeps matching after a rewrite', () => {
  // The first lolly.ing deploy (2026-10-03) put a shell catch-all after the
  // function rows: Vercel matched it against the rewritten /api/index and
  // proxied every function path to the shell origin, which answered NOT_FOUND.
  for (const routes of [vercelRoutes(), vercelRoutes({ shellOrigin: ORIGIN, prefixes: functionPrefixes(SRC) })]) {
    const toFunction = routes.flatMap((r, i) => (r.dest === '/api/index' ? [i] : []));
    assert.deepEqual(toFunction, [routes.length - 1], 'exactly one function row, and it is the last route');
  }
});

// ── Caddy (deploy/vm): the same table for a long-lived server ────────────────

/** Every path the route tests use, every registered route (sampled), and the
 *  same paths in other letter cases. */
function parityPaths(): string[] {
  const sampled = scanRouterPaths(SRC).filter((p) => !p.startsWith('/:'))
    .map((p) => p.replace(/\$\{[^}]*\}.*$/, '').replace(/:[A-Za-z_]+/g, 'x').replace(/\/\*$/, '/a/b'));
  const base = [...SHELL_PATHS, ...FUNCTION_PATHS, ...sampled, '/apix', '/catalogue', '/l', '/lab/x', '/tools/x', '/wsx', '/w'];
  return [...new Set([...base, ...base.map((p) => p.toUpperCase()), '/Admin/App.js', '/API/CA/sign', '/Tools/Qr/tool.json'])];
}

test('Caddy and Vercel send every path to the same place, apart from the WebSocket upgrade', () => {
  const prefixes = functionPrefixes(SRC);
  const routes = vercelRoutes({ shellOrigin: ORIGIN, prefixes });
  const paths = parityPaths();
  assert.ok(paths.length > 200, 'the comparison covers the router');
  for (const path of paths) {
    const vercel = resolveRoute(routes, path);
    const caddy = resolveCaddyRoute({ shellOrigin: ORIGIN, prefixes }, path);
    if (vercel?.to === 'function') assert.deepEqual(caddy, { to: 'server', path }, path);
    else assert.deepEqual(caddy, vercel, path);
  }
});

test('the collab WebSocket goes to the server on Caddy and stays out of the router prefixes', () => {
  const prefixes = functionPrefixes(SRC);
  for (const path of ['/ws/collab/s_123', '/WS/collab/x', '/ws']) {
    assert.deepEqual(resolveCaddyRoute({ shellOrigin: ORIGIN, prefixes }, path), { to: 'server', path }, path);
  }
  // A Vercel rewrite to another origin carries no WebSocket and the function has
  // no gateway, so on Vercel the path is the shell origin's (which answers 404).
  assert.equal(resolveRoute(vercelRoutes({ shellOrigin: ORIGIN, prefixes }), '/ws/collab/x')?.to, 'proxy');
  for (const p of UPGRADE_PREFIXES) {
    assert.ok(!FUNCTION_PREFIX_BASELINE.includes(p) && !scanRouterPrefixes(SRC).includes(p), `${p} is an upgrade path, not a router prefix`);
  }
});

test('Caddy rules are plain RE2 a Caddyfile can carry unquoted', () => {
  for (const rule of caddyRules(functionPrefixes(SRC))) {
    assert.ok(!/\(\?[=!<]/.test(rule.pattern), `${rule.name}: Go's RE2 has no lookaround`);
    assert.ok(!/[\s{}"'#\\]/.test(rule.pattern), `${rule.name}: nothing that needs quoting or escaping`);
  }
  assert.throws(() => caddyRules(['api', 'bad prefix']), /plain path segment/);
  assert.throws(() => caddyfile({ ...LOLLY_ING, upstream: 'server' }), /host:port/);
  assert.throws(() => caddyfile({ ...LOLLY_ING, domain: 'https://lolly.ing' }), /host name/);
  assert.throws(() => caddyfile({ ...LOLLY_ING, shellOrigin: 'http://lolly.tools' }), /https/);
});

test('a mounted local shell keeps workspace and OSS function routing separate', () => {
  const text = caddyfile({ ...LOLLY_ING, serveShell: true });
  const last = text.slice(text.lastIndexOf('\thandle {'));
  assert.match(last, /reverse_proxy server:8787/);
  assert.match(last, /header_up -Cookie/); assert.match(last, /header_up -Authorization/);
  assert.ok(!last.includes('lolly.tools'));
  const functions = text.slice(text.indexOf('\thandle @shell_functions'), text.indexOf('\thandle @control_plane'));
  assert.match(functions, /reverse_proxy https:\/\/lolly.tools/);
});

test('the generated Caddyfile proxies like the Vercel table and keeps credentials home', () => {
  const text = caddyfile({ ...LOLLY_ING, prefixes: functionPrefixes(SRC) });
  // Site blocks: the redirect host and the instance.
  assert.match(text, /^www\.lolly\.ing \{\n\tredir https:\/\/lolly\.ing\{uri\} 308\n\}$/m);
  assert.match(text, /^lolly\.ing \{$/m);
  // Matchers in order, ignoring case, exactly the rules resolveCaddyRoute uses.
  const rules = caddyRules(functionPrefixes(SRC));
  const order = rules.map((r) => text.indexOf(`\t@${r.name} path_regexp ${r.name} (?i)${r.pattern}\n`));
  assert.ok(order.every((i) => i > 0) && order[0]! < order[1]!, 'the OSS functions are matched before the server prefixes');
  assert.ok(text.indexOf('\thandle {') > order[1]!, 'the shell catch-all comes last');
  // Each handle block's proxy settings.
  const block = (start: string): string => text.slice(text.indexOf(start), text.indexOf('\n\t}\n', text.indexOf(start)));
  const fns = block('\thandle @shell_functions {');
  const server = block('\thandle @control_plane {');
  const app = block('\thandle {');
  for (const proxy of [fns, app]) {
    assert.match(proxy, /reverse_proxy https:\/\/lolly\.tools \{/);
    assert.match(proxy, /header_up Host lolly\.tools/);
    assert.match(proxy, /header_up -Cookie/, 'the session cookie never leaves for the shell origin');
  }
  assert.match(app, /header_up -Authorization/, 'the app catch-all drops Authorization');
  assert.doesNotMatch(fns, /-Authorization/, 'the OSS functions keep Authorization (the Penpot proxy forwards it)');
  assert.match(server, /reverse_proxy server:8787 \{\n\t\t\tflush_interval -1\n\t\t\tstream_close_delay 5m\n\t\t\}/);
  assert.doesNotMatch(server, /header_up/, 'the server sees the request as sent');
  // Bodies: the server's largest limit, with tighter ones for parts and sessions.
  assert.match(text, /request_body @file_parts \{\n\t\tmax_size 2MiB/);
  assert.match(text, /request_body @session_writes \{\n\t\tmax_size 5MiB/);
  assert.match(text, /request_body \{\n\t\tmax_size 65MiB/);
  const parts = new RegExp(/@file_parts path_regexp file_parts \(\?i\)(\S+)/.exec(text)![1]!, 'i');
  const sessions = new RegExp(/@session_writes path_regexp session_writes \(\?i\)(\S+)/.exec(text)![1]!, 'i');
  assert.ok(parts.test('/api/v1/projects/p1/files/f1/parts/3') && !parts.test('/api/v1/projects/p1/files'));
  assert.ok(sessions.test('/api/v1/projects/p1/sessions') && sessions.test('/api/v1/sessions/s1') && !sessions.test('/api/v1/sessions/s1/revisions'));
  // HSTS as Vercel sends it, only where the upstream did not set one.
  assert.match(text, /header \?Strict-Transport-Security "max-age=63072000"/);
  // TLS mode from caddy.env, never written into the file.
  assert.match(text, /\{\n\tgrace_period 30s\n\t\{\$LW_CADDY_GLOBAL\}\n\}/);
});

test('deploy/vm/Caddyfile is the generated one', () => {
  assert.equal(readFileSync(CADDYFILE_PATH, 'utf8'), generateLollyIngCaddyfile(),
    'run node scripts/build-caddyfile.ts after changing the routes or the generator');
});

test('a configured document relay wins before the local shell fallback', () => {
  const file = caddyfile({ ...LOLLY_ING, serveShell: true, liveRelayUpstream: 'live-relay:8790', prefixes: functionPrefixes(SRC) });
  assert.match(file, /@live_relay path \/live\/\*/);
  assert.ok(file.indexOf('handle @live_relay') < file.indexOf('handle @shell_functions'));
  assert.match(file, /reverse_proxy live-relay:8790/);
  const relay = file.slice(file.indexOf('\thandle @live_relay'), file.indexOf('\t@shell_functions'));
  assert.match(relay, /header_up -Cookie/);
  assert.doesNotMatch(relay, /-Authorization/, 'the relay keeps the invitation bearer token');
});

test('relay generation accepts only one hostname or IP with a valid port', () => {
  for (const upstream of ['live-relay:8790', 'relay.internal.example:443', 'localhost:1',
    '127.0.0.1:65535', '[::1]:8790', '[2001:db8::1]:8790']) {
    assert.ok(caddyfile({ ...LOLLY_ING, liveRelayUpstream: upstream }).includes(`reverse_proxy ${upstream} {`), upstream);
  }
  for (const upstream of ['', 'relay', 'relay:0', 'relay:-1', 'relay:1.5', 'relay:65536',
    'http://relay:8790', 'relay:8790/path', 'relay:8790?x=1', 'relay:8790#x', 'user:pass@relay:8790',
    'relay:8790\nrespond hacked', 'relay:8790\r\n}', 'relay:8790 other:8790', '{$RELAY}:8790',
    '-relay:8790', 'relay-:8790', 'relay..example:8790', `${'a'.repeat(64)}:8790`,
    '999.1.1.1:8790', '::1:8790', '[::1:8790', '[1.2.3.4]:8790', '[2001:db8:::1]:8790']) {
    assert.throws(() => caddyfile({ ...LOLLY_ING, liveRelayUpstream: upstream }), /live relay upstream must be host:port/, upstream);
  }
});
