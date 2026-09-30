/**
 * What the render worker's browser may reach (plans/58 WP0).
 *
 * The worker runs the least-trusted content there is: tool hooks, a Sandbox pen, any
 * <img>, <iframe> or fetch a rendered page asks for. Before this module every request
 * except model weights was continued, so a rendered page could reach anything the pod
 * can: the cluster's own services, the cloud metadata endpoint, a private network.
 *
 * The rule, applied to every request of both /render and /rasterise:
 *   1. blob:, data: and about: stay inside the page and are allowed; other non-HTTP
 *      schemes are refused.
 *   2. Model weights are refused (server exports have no member AI lease).
 *   3. The shell the worker drives (LOLLY_WEB_BASE) and any origin the operator lists in
 *      LW_RENDER_ALLOWED_ORIGINS are allowed as declared, private or not: the operator
 *      chose them.
 *   4. Anything else must be a public address: an IP literal is checked directly, a name
 *      is resolved and EVERY answer must be public, and an unresolved name is refused.
 *
 * The same address ranges as the open-source MCP's browser tier
 * (lolly/services/mcp/src/egress.ts). One residual gap remains at this layer: Chromium
 * resolves a name again when it connects, so a name that answers publicly here and
 * privately there (DNS rebinding) is not caught. The render worker's NetworkPolicy
 * (deploy/helm/templates/render-worker-networkpolicy.yaml) closes that at the network.
 */
import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';

const blocked = new BlockList();
for (const [network, prefix] of [
  ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
  ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
  ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24],
  ['224.0.0.0', 4], ['240.0.0.0', 4],
] as const) blocked.addSubnet(network, prefix, 'ipv4');
// No ::ffff:0:0/96 entry: node's BlockList already checks an IPv4-mapped address against
// the IPv4 rules above, and listing the mapped range would block every IPv4 address.
for (const [network, prefix] of [
  ['::', 128], ['::1', 128], ['64:ff9b::', 96], ['100::', 64],
  ['2001:db8::', 32], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8],
] as const) blocked.addSubnet(network, prefix, 'ipv6');

export type HostResolver = (hostname: string) => Promise<string[]>;

const MODEL_PATH = /\/models\/|\.(onnx|gguf|safetensors)$/i;

export function isPublicAddress(address: string): boolean {
  const family = isIP(address);
  return family !== 0 && !blocked.check(address, family === 4 ? 'ipv4' : 'ipv6');
}

/** The origins declared by the operator: the shell base plus LW_RENDER_ALLOWED_ORIGINS
 *  (comma-separated absolute http(s) origins, no path, query or credentials). A bad entry
 *  fails at start-up, never at render time. */
export function declaredOrigins(base: string, extra = ''): Set<string> {
  const origins = new Set<string>([originOf(base, 'LOLLY_WEB_BASE')]);
  for (const raw of extra.split(',')) {
    const value = raw.trim();
    if (value) origins.add(originOf(value, 'LW_RENDER_ALLOWED_ORIGINS'));
  }
  return origins;
}

function originOf(raw: string, name: string): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error(`${name} entries must be absolute URLs`); }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new Error(`${name} entries must be http(s)`);
  if (url.username || url.password || url.search || url.hash || (name !== 'LOLLY_WEB_BASE' && url.pathname !== '/')) {
    throw new Error(`${name} entries must be credential-free origins`);
  }
  return url.origin;
}

export type EgressVerdict = { allow: true } | { allow: false; reason: string };

/** Decide one request. Pure apart from the resolver, which tests replace. */
export async function checkRequest(raw: string, declared: Set<string>, resolver: HostResolver = resolveHost): Promise<EgressVerdict> {
  let url: URL;
  try { url = new URL(raw); } catch { return { allow: false, reason: 'unparseable URL' }; }
  if (url.protocol === 'blob:' || url.protocol === 'data:' || url.protocol === 'about:') return { allow: true };
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { allow: false, reason: `scheme ${url.protocol}` };
  if (MODEL_PATH.test(url.pathname)) return { allow: false, reason: 'model weights' };
  if (declared.has(url.origin)) return { allow: true };
  const host = url.hostname.startsWith('[') && url.hostname.endsWith(']') ? url.hostname.slice(1, -1) : url.hostname;
  if (isIP(host)) return isPublicAddress(host) ? { allow: true } : { allow: false, reason: 'non-public address' };
  const answers = await resolver(host);
  if (!answers.length) return { allow: false, reason: 'unresolved name' };
  if (answers.some((address) => !isPublicAddress(address))) return { allow: false, reason: 'name resolves to a non-public address' };
  return { allow: true };
}

/** A per-context checker with its own DNS cache, so one page's burst of requests to the
 *  same host resolves once. */
export function egressChecker(declared: Set<string>, resolver: HostResolver = resolveHost): (raw: string) => Promise<EgressVerdict> {
  const cache = new Map<string, Promise<string[]>>();
  const cached: HostResolver = (hostname) => {
    let pending = cache.get(hostname);
    if (!pending) { pending = resolver(hostname); cache.set(hostname, pending); }
    return pending;
  };
  return (raw) => checkRequest(raw, declared, cached);
}

async function resolveHost(hostname: string): Promise<string[]> {
  try { return (await lookup(hostname, { all: true, verbatim: true })).map((answer) => answer.address); }
  catch { return []; }
}
