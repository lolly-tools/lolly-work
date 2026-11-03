// SPDX-License-Identifier: MPL-2.0
/**
 * Cloudflare (a US company). Under `eu-only` it may front only a hostname that
 * serves public classes, because it terminates TLS for every route on the
 * hostname (config.ts refuses anything else at load).
 *
 * Endpoints checked against the Cloudflare API reference on 2026-11-03, all
 * with `Authorization: Bearer <API token>`:
 *
 *   POST /zones/{zone}/purge_cache  {"tags"|"files"|"prefixes"|"hosts": [...]}
 *   GET  /zones/{zone}
 *   GET  /zones/{zone}/settings/{setting}
 *   GET  /zones/{zone}/rulesets/phases/http_request_cache_settings/entrypoint
 *
 * Purge by tag, prefix and host is on every plan since 2025-04-01 and shares
 * one budget: Free 5 requests a minute (bucket 25), Pro 5 a second (25),
 * Business 10 (50), Enterprise 50 (500), 100 items per request. URL purge has
 * its own budget: 800 URLs a second on Free, 1,500 on Pro and Business, 3,000
 * on Enterprise, 100 per request (500 on Enterprise). `Cache-Tag` is comma
 * separated, at most 16 KB, without spaces, case-insensitive, and Cloudflare
 * removes it before the response reaches the visitor. Below Enterprise the
 * largest cacheable file is 512 MB.
 */
import { renderTags } from '@lolly-tools/core/delivery-v1';
import { answerError, apiRequest, chunks, httpsHost, scrub, type ApiAnswer } from './http.ts';
import { EdgeApiError, type EdgeAdapter, type EdgeCapabilities, type EdgeJurisdiction, type PurgeKind, type PurgeLimits, type PurgeReceipt, type ZoneFinding } from './types.ts';

const BASE = 'https://api.cloudflare.com/client/v4';
export type CloudflarePlan = 'free' | 'pro' | 'business' | 'enterprise';
const PLANS: readonly CloudflarePlan[] = ['free', 'pro', 'business', 'enterprise'];

export interface CloudflareOptions {
  zoneId: string;
  /** The zone's plan, which sets the purge budget. Absent means Free, the smallest. */
  plan?: CloudflarePlan;
}

const TAG_BUDGET: Record<CloudflarePlan, PurgeLimits> = {
  free: { requestsPerSecond: 5 / 60, burst: 25, opsPerRequest: 100 },
  pro: { requestsPerSecond: 5, burst: 25, opsPerRequest: 100 },
  business: { requestsPerSecond: 10, burst: 50, opsPerRequest: 100 },
  enterprise: { requestsPerSecond: 50, burst: 500, opsPerRequest: 100 },
};
// URL budgets are published in URLs per second; one request carries up to opsPerRequest URLs.
const URL_BUDGET: Record<CloudflarePlan, PurgeLimits> = {
  free: { requestsPerSecond: 8, burst: 8, opsPerRequest: 100 },
  pro: { requestsPerSecond: 15, burst: 15, opsPerRequest: 100 },
  business: { requestsPerSecond: 15, burst: 15, opsPerRequest: 100 },
  enterprise: { requestsPerSecond: 6, burst: 6, opsPerRequest: 500 },
};

export function cloudflareCapabilities(plan: CloudflarePlan = 'free'): EdgeCapabilities {
  return {
    tagHeader: 'Cache-Tag',
    tagSeparator: ',',
    maxTagHeaderBytes: 16 * 1024,
    tagPurge: TAG_BUDGET[plan],
    urlPurge: URL_BUDGET[plan],
    prefixPurge: TAG_BUDGET[plan],
    hostPurge: TAG_BUDGET[plan],
    sharedPurgeBudget: false,
    maxCacheableBytes: plan === 'enterprise' ? 5 * 1024 ** 3 : 512 * 1024 ** 2,
    checkedOn: '2026-11-03',
    unverified: [
      'Whether transformations honour no-transform.',
      'Whether the edge compresses a response that carries no-transform.',
      'The answer for a zone that has no cache rules entry point yet (taken to be 404).',
    ],
  };
}

export function validateCloudflareOptions(id: string, options: Record<string, unknown>): CloudflareOptions {
  for (const key of Object.keys(options)) {
    if (!['zoneId', 'plan'].includes(key)) throw new Error(`edge provider ${id}: unknown cloudflare option "${key}" (zoneId, plan)`);
  }
  if (typeof options.zoneId !== 'string' || !/^[0-9a-f]{32}$/.test(options.zoneId)) throw new Error(`edge provider ${id}: cloudflare options.zoneId must be the 32-character zone id`);
  if (options.plan !== undefined && !PLANS.includes(options.plan as CloudflarePlan)) throw new Error(`edge provider ${id}: cloudflare options.plan must be one of ${PLANS.join(', ')}`);
  return { zoneId: options.zoneId, ...(options.plan ? { plan: options.plan as CloudflarePlan } : {}) };
}

/** A US company with a global network; EU-only delivery (Regional Services) does not change the company. */
export function cloudflareJurisdiction(): EdgeJurisdiction {
  return { company: 'us', edgeLocations: 'global', logs: 'unknown' };
}

/** Settings that rewrite bytes or expose an open endpoint. Each must read "off". */
const REQUIRED_OFF: ReadonlyArray<readonly [setting: string, why: string]> = [
  ['polish', 'Polish recompresses images and strips their metadata, which breaks Content Credentials.'],
  ['mirage', 'Mirage rewrites how HTML loads images.'],
  ['rocket_loader', 'Rocket Loader rewrites script tags, which breaks the Content Security Policy.'],
  ['email_obfuscation', 'Email Obfuscation rewrites HTML and adds a script.'],
  ['image_resizing', 'Image transformations answer /cdn-cgi/image/ for any path on the zone, without the origin\'s checks, and strip metadata.'],
  ['transformations', 'Image transformations answer /cdn-cgi/image/ for any path on the zone, without the origin\'s checks, and strip metadata.'],
  ['automatic_https_rewrites', 'Automatic HTTPS Rewrites changes HTML bytes.'],
  ['always_online', 'Always Online shares popular URLs with the Internet Archive and serves old copies.'],
];

export interface CloudflareAdapterInit {
  id: string;
  hostnames: readonly string[];
  publicOnly: boolean;
  options: CloudflareOptions;
  jurisdiction: EdgeJurisdiction;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface CloudflareAdapter extends EdgeAdapter {
  /** Purge everything under `<host>/<path>`; each prefix on a configured hostname. */
  purgePrefixes(prefixes: string[]): Promise<PurgeReceipt>;
  /** Purge everything on configured hostnames. */
  purgeHosts(hosts: string[]): Promise<PurgeReceipt>;
}

function explanation(answer: ApiAnswer): string | undefined {
  const errors = (answer.json as { errors?: Array<{ code?: unknown; message?: unknown }> } | null)?.errors;
  if (!Array.isArray(errors) || !errors.length) return undefined;
  return errors.slice(0, 3).map(e => `${typeof e.code === 'number' ? e.code : '?'} ${typeof e.message === 'string' ? e.message : ''}`.trim()).join('; ');
}

function succeeded(answer: ApiAnswer): boolean {
  return answer.status >= 200 && answer.status < 300 && (answer.json as { success?: unknown } | null)?.success === true;
}

export function createCloudflareAdapter(init: CloudflareAdapterInit): CloudflareAdapter {
  const fetchImpl = init.fetchImpl ?? fetch;
  const timeoutMs = init.timeoutMs ?? 15_000;
  const secret = init.credential;
  const capabilities = cloudflareCapabilities(init.options.plan);
  const hosts = new Set(init.hostnames);
  const zone = `${BASE}/zones/${init.options.zoneId}`;
  const headers = { authorization: `Bearer ${secret}` };
  const get = (path: string) => apiRequest(fetchImpl, { method: 'GET', url: `${zone}${path}`, headers }, secret, timeoutMs);
  const refuse = (what: string, value: string): never => {
    throw new EdgeApiError(`Refused ${what} ${JSON.stringify(scrub(value, secret).slice(0, 200))}: it is not on this provider's hostnames.`, { permanent: true });
  };

  const purge = async (kind: PurgeKind, field: 'tags' | 'files' | 'prefixes' | 'hosts', items: string[], size: number): Promise<PurgeReceipt> => {
    const unique = [...new Set(items)];
    const ids: string[] = [];
    const batches = chunks(unique, size);
    for (const batch of batches) {
      const answer = await apiRequest(fetchImpl, { method: 'POST', url: `${zone}/purge_cache`, headers, body: { [field]: batch } }, secret, timeoutMs);
      if (!succeeded(answer)) throw answerError(answer, `Cloudflare ${kind} purge`, secret, explanation(answer));
      const id = (answer.json as { result?: { id?: unknown } } | null)?.result?.id;
      if (typeof id === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(id)) ids.push(id);
    }
    return { provider: init.id, kind, items: unique.length, requests: batches.length, ids };
  };

  const setting = async (name: string): Promise<{ ok: true; value: unknown } | { ok: false; status: number }> => {
    const answer = await get(`/settings/${name}`);
    if (!succeeded(answer)) return { ok: false, status: answer.status };
    return { ok: true, value: (answer.json as { result?: { value?: unknown } } | null)?.result?.value };
  };

  return {
    id: init.id,
    kind: 'cloudflare',
    jurisdiction: init.jurisdiction,
    edgeRegion: 'global',
    tagHeader: capabilities.tagHeader,
    capabilities,
    async purgeTags(tags) {
      for (const value of tags) {
        try { renderTags([value], 'comma'); } catch { throw new EdgeApiError(`Refused tag ${JSON.stringify(value)}: not a delivery tag.`, { permanent: true }); }
      }
      return purge('tags', 'tags', tags, capabilities.tagPurge.opsPerRequest);
    },
    async purgeUrls(urls) {
      for (const value of urls) { const host = httpsHost(value); if (!host || !hosts.has(host)) refuse('URL', value); }
      return purge('urls', 'files', urls, capabilities.urlPurge.opsPerRequest);
    },
    async purgePrefixes(prefixes) {
      for (const value of prefixes) {
        // Cloudflare's form: hostname plus path, with no scheme, query or fragment.
        const match = /^([a-z0-9.-]+)(\/[^\s?#]*)$/.exec(value);
        if (!match || !hosts.has(match[1]!) || match[2]!.includes('*')) refuse('prefix', value);
      }
      return purge('prefixes', 'prefixes', prefixes, capabilities.prefixPurge!.opsPerRequest);
    },
    async purgeHosts(list) {
      for (const value of list) if (!hosts.has(value)) refuse('host', value);
      return purge('hosts', 'hosts', list, capabilities.hostPurge!.opsPerRequest);
    },
    async verifyZone() {
      const out: ZoneFinding[] = [];
      const zoneAnswer = await get('');
      if (!succeeded(zoneAnswer)) {
        return [{ id: 'cloudflare.zone', status: 'fail', message: `Could not read zone ${init.options.zoneId}: the API answered ${zoneAnswer.status}. Check the zone id and that the token can read zone settings.`, observed: zoneAnswer.status }];
      }
      const name = String((zoneAnswer.json as { result?: { name?: unknown } } | null)?.result?.name ?? '').toLowerCase();
      const outside = init.hostnames.filter(host => host !== name && !host.endsWith(`.${name}`));
      out.push(outside.length
        ? { id: 'cloudflare.zone', status: 'warn', message: `${outside.join(', ')} is not in zone ${name || init.options.zoneId}. Purges and settings here do not cover it.`, observed: name }
        : { id: 'cloudflare.zone', status: 'pass', message: `Every configured hostname is in zone ${name}.`, observed: name });
      for (const [name, why] of REQUIRED_OFF) {
        const id = `cloudflare.${name.replaceAll('_', '-')}`;
        const read = await setting(name);
        if (!read.ok) {
          // Mirage was retired on 2025-09-15, so a zone may no longer report it.
          out.push(name === 'mirage'
            ? { id, status: 'pass', message: 'Mirage is not available on this zone (Cloudflare retired it on 2025-09-15).', observed: null }
            : { id, status: 'warn', message: `Could not read ${name} (the API answered ${read.status}). Check it is off in the dashboard. ${why}`, observed: null });
          continue;
        }
        const value = typeof read.value === 'string' || typeof read.value === 'boolean' || typeof read.value === 'number' ? read.value : null;
        out.push(value === 'off'
          ? { id, status: 'pass', message: `${name} is off.`, observed: value }
          : { id, status: 'fail', message: `${name} is ${String(value)}. ${why} Turn it off.`, observed: value });
      }
      const rules = await get('/rulesets/phases/http_request_cache_settings/entrypoint');
      if (rules.status === 404) {
        out.push({ id: 'cloudflare.cache-rules', status: 'pass', message: 'The zone has no cache rules, so caching follows the origin headers.' });
      } else if (!succeeded(rules)) {
        out.push({ id: 'cloudflare.cache-rules', status: 'warn', message: `Could not read the cache rules (the API answered ${rules.status}). Check that no rule overrides the origin cache time.`, observed: rules.status });
      } else {
        const list = (rules.json as { result?: { rules?: unknown } } | null)?.result?.rules;
        const live = (Array.isArray(list) ? list : []).filter((r): r is Record<string, unknown> => !!r && typeof r === 'object' && (r as Record<string, unknown>).enabled !== false);
        const mode = (r: Record<string, unknown>, field: 'edge_ttl' | 'browser_ttl') => ((r.action_parameters as Record<string, { mode?: unknown }> | undefined)?.[field])?.mode;
        const edge = live.filter(r => mode(r, 'edge_ttl') === 'override_origin').length;
        const browser = live.filter(r => mode(r, 'browser_ttl') === 'override_origin').length;
        if (edge) {
          out.push({ id: 'cloudflare.cache-rules', status: init.publicOnly ? 'warn' : 'fail', observed: edge,
            message: `${edge} cache rule${edge === 1 ? '' : 's'} override${edge === 1 ? 's' : ''} the origin edge cache time. Such a rule can store responses the origin marks private or no-store. Use "respect origin" instead.` });
        } else {
          out.push({ id: 'cloudflare.cache-rules', status: 'pass', message: 'No cache rule overrides the origin edge cache time.', observed: 0 });
        }
        if (browser) out.push({ id: 'cloudflare.browser-ttl', status: 'warn', observed: browser, message: `${browser} cache rule${browser === 1 ? '' : 's'} override the browser cache time the origin sends.` });
      }
      out.push({ id: 'cloudflare.max-cacheable', status: 'info', observed: capabilities.maxCacheableBytes,
        message: init.options.plan === 'enterprise' ? 'Files above 5 GB pass through uncached.' : 'Files above 512 MB pass through uncached on Free, Pro and Business plans.' });
      return out;
    },
  };
}
