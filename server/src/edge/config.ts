// SPDX-License-Identifier: MPL-2.0
/**
 * The `edge` block of instance.json and the jurisdiction rule (plan 80 section
 * 3.1), checked when the configuration loads.
 *
 * A CDN fronts a whole hostname and terminates TLS for every route on it, so it
 * sees cookies, bearer tokens and private bytes even when it caches nothing
 * private. Jurisdiction is therefore decided per hostname, never per route.
 * Under `eu-only` (the default), a provider whose company, edge locations or
 * logs are not EU (or self-hosted) may front only a hostname marked
 * `publicOnly`. The instance's own hostnames always serve private classes, so
 * they can never be marked `publicOnly`. Anything unclear fails the load.
 */
import { bunnyJurisdiction, validateBunnyOptions, type BunnyOptions } from './bunny.ts';
import { cloudflareJurisdiction, validateCloudflareOptions, type CloudflareOptions } from './cloudflare.ts';
import { EDGE_KINDS, type EdgeJurisdiction, type EdgeKind } from './types.ts';

export type EdgeJurisdictionPolicy = 'eu-only' | 'any';

export interface EdgeProviderConfig {
  id: string;
  kind: EdgeKind;
  /** The hostnames this provider fronts (DNS points them at the provider). */
  hostnames: string[];
  /** The hostname serves public classes only; the server refuses everything else on it. */
  publicOnly: boolean;
  /** Env var holding the API credential. Absent: a sealed credential stored with `lw edge credential`. */
  credentialRef?: string;
  options: BunnyOptions | CloudflareOptions;
  /** Facts the operator states after reading the provider's terms. They may fill an unknown, never contradict a known fact. */
  jurisdiction: EdgeJurisdiction;
}

export interface EdgeConfig {
  jurisdiction: EdgeJurisdictionPolicy;
  providers: EdgeProviderConfig[];
}

export const EDGE_DEFAULTS: EdgeConfig = { jurisdiction: 'eu-only', providers: [] };

const ENV_NAME = /^[A-Z][A-Z0-9_]*$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/;
const PROVIDER_KEYS = ['id', 'kind', 'hostnames', 'publicOnly', 'credentialRef', 'options', 'jurisdiction'];
const VALUES = {
  company: ['eu', 'us', 'other', 'self'],
  edgeLocations: ['eu', 'global', 'self', 'unknown'],
  logs: ['eu', 'us', 'self', 'unknown'],
} as const;

/** Whether every part of a jurisdiction is EU or self-hosted. */
export function euEligible(j: EdgeJurisdiction): boolean {
  return ['eu', 'self'].includes(j.company) && ['eu', 'self'].includes(j.edgeLocations) && ['eu', 'self'].includes(j.logs);
}

function factsFor(kind: EdgeKind, options: BunnyOptions | CloudflareOptions): EdgeJurisdiction {
  return kind === 'bunny' ? bunnyJurisdiction(options as BunnyOptions) : cloudflareJurisdiction();
}

/** Known facts win; a declaration may only replace an `unknown`, and must otherwise agree. */
function resolveJurisdiction(id: string, known: EdgeJurisdiction, declared: unknown): EdgeJurisdiction {
  if (declared === undefined) return known;
  if (!declared || typeof declared !== 'object' || Array.isArray(declared)) throw new Error(`edge provider ${id}: jurisdiction must be an object with company, edgeLocations and/or logs`);
  const out = { ...known };
  for (const [field, value] of Object.entries(declared as Record<string, unknown>)) {
    if (!(field in VALUES)) throw new Error(`edge provider ${id}: unknown jurisdiction field "${field}" (company, edgeLocations, logs)`);
    const key = field as keyof EdgeJurisdiction;
    if (!(VALUES[key] as readonly string[]).includes(value as string)) throw new Error(`edge provider ${id}: jurisdiction.${key} must be one of ${VALUES[key].join(', ')}`);
    if (known[key] !== 'unknown' && known[key] !== value) {
      throw new Error(`edge provider ${id}: jurisdiction.${key} is ${known[key]} for this provider and configuration, so it cannot be declared ${String(value)}`);
    }
    (out as Record<string, string>)[key] = value as string;
  }
  return out;
}

/** The host part of an absolute URL, or null. */
export function hostOf(url: string | undefined): string | null {
  if (!url) return null;
  try { return new URL(url).hostname.toLowerCase(); } catch { return null; }
}

/**
 * Validate the `edge` block. `instanceHosts` are the hostnames the instance
 * serves its own routes on (baseUrl and appUrl); they serve private classes.
 */
export function validateEdgeConfig(raw: unknown, instanceHosts: readonly string[]): EdgeConfig {
  if (raw === undefined || raw === null) return { ...EDGE_DEFAULTS, providers: [] };
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new Error('edge must be an object with jurisdiction and providers');
  const block = raw as Record<string, unknown>;
  for (const key of Object.keys(block)) if (!['jurisdiction', 'providers'].includes(key)) throw new Error(`edge: unknown key "${key}" (jurisdiction, providers)`);
  const policy = block.jurisdiction ?? 'eu-only';
  if (policy !== 'eu-only' && policy !== 'any') throw new Error('edge.jurisdiction must be "eu-only" (the default) or "any"');
  const list = block.providers ?? [];
  if (!Array.isArray(list)) throw new Error('edge.providers must be a list');
  const ids = new Set<string>();
  const claimed = new Map<string, string>();
  const ownHosts = new Set(instanceHosts.map(host => host.toLowerCase()));
  const providers = list.map((entry, index): EdgeProviderConfig => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`edge.providers[${index}] must be an object`);
    const p = entry as Record<string, unknown>;
    const id = typeof p.id === 'string' ? p.id : '';
    if (!/^[a-z0-9][a-z0-9-]{0,62}$/.test(id)) throw new Error(`edge.providers[${index}].id must be lower-case letters, digits and hyphens`);
    if (ids.has(id)) throw new Error(`edge provider ${id} is listed twice`);
    ids.add(id);
    for (const key of Object.keys(p)) if (!PROVIDER_KEYS.includes(key)) throw new Error(`edge provider ${id}: unknown key "${key}" (${PROVIDER_KEYS.join(', ')})`);
    if (!EDGE_KINDS.includes(p.kind as EdgeKind)) throw new Error(`edge provider ${id}: kind must be one of ${EDGE_KINDS.join(', ')}`);
    const kind = p.kind as EdgeKind;
    if (!Array.isArray(p.hostnames) || !p.hostnames.length || p.hostnames.length > 32) throw new Error(`edge provider ${id}: hostnames must list 1 to 32 hostnames`);
    const hostnames = p.hostnames.map(host => {
      if (typeof host !== 'string' || !HOSTNAME.test(host)) throw new Error(`edge provider ${id}: ${JSON.stringify(host)} is not a lower-case hostname`);
      const owner = claimed.get(host);
      if (owner) throw new Error(`edge provider ${id}: hostname ${host} is already fronted by ${owner}; one hostname has one edge`);
      claimed.set(host, id);
      return host;
    });
    if (p.publicOnly !== undefined && typeof p.publicOnly !== 'boolean') throw new Error(`edge provider ${id}: publicOnly must be true or false`);
    const publicOnly = p.publicOnly === true;
    if (p.credentialRef !== undefined && (typeof p.credentialRef !== 'string' || !ENV_NAME.test(p.credentialRef))) {
      throw new Error(`edge provider ${id}: credentialRef must name an env var (UPPER_SNAKE); the credential itself never goes in instance.json`);
    }
    if (!p.options || typeof p.options !== 'object' || Array.isArray(p.options)) throw new Error(`edge provider ${id}: options must be an object`);
    const options = kind === 'bunny'
      ? validateBunnyOptions(id, p.options as Record<string, unknown>)
      : validateCloudflareOptions(id, p.options as Record<string, unknown>);
    const jurisdiction = resolveJurisdiction(id, factsFor(kind, options), p.jurisdiction);
    if (publicOnly) {
      const own = hostnames.filter(host => ownHosts.has(host));
      if (own.length) {
        throw new Error(`edge provider ${id}: ${own.join(', ')} is this instance's own hostname, which serves sign-in, sessions and private files. It cannot be publicOnly. Use a separate hostname for public files.`);
      }
    }
    if (policy === 'eu-only' && !publicOnly && !euEligible(jurisdiction)) {
      throw new Error(`edge provider ${id} (${kind}) cannot front ${hostnames.join(', ')} under edge.jurisdiction "eu-only": `
        + `company ${jurisdiction.company}, edge locations ${jurisdiction.edgeLocations}, logs ${jurisdiction.logs}. `
        + 'A CDN terminates TLS for every route on a hostname, so a hostname that serves anything private needs an EU or self-hosted edge'
        + (kind === 'bunny' ? ' (for Bunny: options.regions ["europe"], and jurisdiction.logs "eu" once you have confirmed where Bunny keeps your logs)' : '')
        + '. Otherwise mark a separate hostname publicOnly, or set edge.jurisdiction to "any".');
    }
    return { id, kind, hostnames, publicOnly, ...(p.credentialRef ? { credentialRef: p.credentialRef as string } : {}), options, jurisdiction };
  });
  return { jurisdiction: policy, providers };
}

/** The response headers that carry purge tags for the configured providers, lower-cased and unique. */
export function edgeTagHeaders(config: EdgeConfig): string[] {
  return [...new Set(config.providers.map(p => (p.kind === 'bunny' ? 'cdn-tag' : 'cache-tag')))];
}

/** Hostnames that must serve public classes only. */
export function publicOnlyHosts(config: EdgeConfig): Set<string> {
  return new Set(config.providers.filter(p => p.publicOnly).flatMap(p => p.hostnames));
}

/** What the console and CLI may see about a provider: never the credential, never the env var name. */
export function edgeProviderDescriptor(p: EdgeProviderConfig): Record<string, unknown> {
  return {
    id: p.id, kind: p.kind, hostnames: p.hostnames, publicOnly: p.publicOnly,
    jurisdiction: p.jurisdiction, euEligible: euEligible(p.jurisdiction),
    zone: p.kind === 'bunny' ? { pullZoneId: (p.options as BunnyOptions).pullZoneId, regions: (p.options as BunnyOptions).regions ?? ['all'] }
      : { zoneId: (p.options as CloudflareOptions).zoneId, plan: (p.options as CloudflareOptions).plan ?? 'free' },
    credentialSource: p.credentialRef ? 'environment' : 'sealed',
  };
}
