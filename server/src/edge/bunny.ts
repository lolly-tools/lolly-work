// SPDX-License-Identifier: MPL-2.0
/**
 * Bunny CDN (BunnyWay d.o.o., Slovenia). Endpoints and fields checked against
 * the Bunny API reference on 2026-11-03:
 *
 *   POST https://api.bunny.net/pullzone/{id}/purgeCache  {"CacheTag": "<tag>"}  -> 204
 *   POST https://api.bunny.net/purge?url=<url>&async=false&exactPath=true       -> 200
 *   GET  https://api.bunny.net/pullzone/{id}                                     -> PullZoneModel
 *
 * Every call sends the account API key as `AccessKey`. Purge budget: tag and
 * exact URL purges share the "exact" bucket, 120 requests at once refilling at
 * 5 per second, one item per request. `CDN-Tag` values are limited to 1024
 * bytes. Tag purges are not supported on a zone with Perma-Cache.
 *
 * The pull zone answer also carries the zone's token-authentication key
 * (`ZoneSecurityKey`). verifyZone copies out only the fields it checks and
 * never stores, logs or returns the answer itself.
 */
import { renderTags } from '@lolly-tools/core/delivery-v1';
import { answerError, apiRequest, httpsHost } from './http.ts';
import { EdgeApiError, type EdgeAdapter, type EdgeCapabilities, type EdgeJurisdiction, type PurgeReceipt, type ZoneFinding } from './types.ts';

const BASE = 'https://api.bunny.net';

export interface BunnyOptions {
  pullZoneId: number;
  /** `["europe"]` restricts the zone to European locations; absent means every region. */
  regions?: ['europe'];
}

export const BUNNY_CAPABILITIES: EdgeCapabilities = {
  tagHeader: 'CDN-Tag',
  tagSeparator: ',',
  maxTagHeaderBytes: 1024,
  tagPurge: { requestsPerSecond: 5, burst: 120, opsPerRequest: 1 },
  urlPurge: { requestsPerSecond: 5, burst: 120, opsPerRequest: 1 },
  prefixPurge: null,
  hostPurge: null,
  sharedPurgeBudget: true,
  maxCacheableBytes: null,
  checkedOn: '2026-11-03',
  unverified: [
    'How CDN-Tag separates several tags and how a CacheTag purge matches them: the API takes one tag per request and the separator is not documented.',
    'Whether the CDN-Tag header reaches visitors.',
    'Whether the edge declines to store private and no-store responses, and whether it reads CDN-Cache-Control.',
    'That CacheControlMaxAgeOverride -1 means the zone follows the origin Cache-Control (from a client library, not the reference).',
    'Where Bunny keeps its own edge logs.',
  ],
};

export function validateBunnyOptions(id: string, options: Record<string, unknown>): BunnyOptions {
  for (const key of Object.keys(options)) {
    if (!['pullZoneId', 'regions'].includes(key)) throw new Error(`edge provider ${id}: unknown bunny option "${key}" (pullZoneId, regions)`);
  }
  const zone = options.pullZoneId;
  if (typeof zone !== 'number' || !Number.isSafeInteger(zone) || zone <= 0) throw new Error(`edge provider ${id}: bunny options.pullZoneId must be the pull zone's numeric id`);
  const regions = options.regions;
  if (regions !== undefined && !(Array.isArray(regions) && regions.length === 1 && regions[0] === 'europe')) {
    throw new Error(`edge provider ${id}: bunny options.regions must be ["europe"] or absent (every region)`);
  }
  return { pullZoneId: zone, ...(regions ? { regions: ['europe'] as ['europe'] } : {}) };
}

/** What is known about Bunny without asking it. Logs stay `unknown` until the operator states them. */
export function bunnyJurisdiction(options: BunnyOptions): EdgeJurisdiction {
  return { company: 'eu', edgeLocations: options.regions ? 'eu' : 'global', logs: 'unknown' };
}

export interface BunnyAdapterInit {
  id: string;
  hostnames: readonly string[];
  options: BunnyOptions;
  jurisdiction: EdgeJurisdiction;
  credential: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

/** The pull zone fields verifyZone reads. Everything else in the answer is dropped. */
interface ZoneFacts {
  optimizer: unknown; smartCache: unknown; geo: Record<'US' | 'EU' | 'ASIA' | 'SA' | 'AF', unknown>;
  maxAgeOverride: unknown; cacheErrors: unknown; cookieVary: unknown; cookieVaryParameters: unknown;
  permaCacheZone: unknown; hostnames: string[]; logForwarding: unknown; logToStorage: unknown;
  ipAnonymized: unknown; originShield: unknown; originShieldZone: string | null; webpVary: unknown; avifVary: unknown;
}

function zoneFacts(json: unknown): ZoneFacts {
  const z = (json && typeof json === 'object' ? json : {}) as Record<string, unknown>;
  const hostnames = Array.isArray(z.Hostnames)
    ? z.Hostnames.map(h => (h && typeof h === 'object' ? (h as Record<string, unknown>).Value : null)).filter((v): v is string => typeof v === 'string').map(v => v.toLowerCase())
    : [];
  return {
    optimizer: z.OptimizerEnabled, smartCache: z.EnableSmartCache,
    geo: { US: z.EnableGeoZoneUS, EU: z.EnableGeoZoneEU, ASIA: z.EnableGeoZoneASIA, SA: z.EnableGeoZoneSA, AF: z.EnableGeoZoneAF },
    maxAgeOverride: z.CacheControlMaxAgeOverride, cacheErrors: z.CacheErrorResponses,
    cookieVary: z.EnableCookieVary, cookieVaryParameters: z.CookieVaryParameters,
    permaCacheZone: z.PermaCacheStorageZoneId, hostnames,
    logForwarding: z.LogForwardingEnabled, logToStorage: z.LoggingSaveToStorage, ipAnonymized: z.LoggingIPAnonymizationEnabled,
    originShield: z.EnableOriginShield, originShieldZone: typeof z.OriginShieldZoneCode === 'string' ? z.OriginShieldZoneCode : null,
    webpVary: z.EnableWebPVary, avifVary: z.EnableAvifVary,
  };
}

export function bunnyFindings(facts: ZoneFacts, init: Pick<BunnyAdapterInit, 'hostnames' | 'options'>): ZoneFinding[] {
  const out: ZoneFinding[] = [];
  const flag = (id: string, value: unknown, wantOff: boolean, onBad: 'fail' | 'warn', good: string, bad: string): void => {
    if (typeof value !== 'boolean') { out.push({ id, status: 'warn', message: `The zone did not report this setting; check it in the dashboard. ${bad}`, observed: null }); return; }
    const ok = wantOff ? !value : value;
    out.push({ id, status: ok ? 'pass' : onBad, message: ok ? good : bad, observed: value });
  };
  flag('bunny.optimizer', facts.optimizer, true, 'fail', 'Bunny Optimizer is off.',
    'Bunny Optimizer is on. It rewrites images and strips their metadata, which breaks Content Credentials. Turn it off.');
  flag('bunny.smart-cache', facts.smartCache, true, 'fail', 'Smart Cache is off.',
    'Smart Cache is on. It decides caching by file type instead of the origin headers and never caches JSON. Turn it off.');
  const geo = facts.geo;
  const others = (['US', 'ASIA', 'SA', 'AF'] as const).filter(region => geo[region] !== false);
  if (init.options.regions) {
    const ok = geo.EU === true && others.length === 0;
    out.push({ id: 'bunny.regions', status: ok ? 'pass' : 'fail',
      message: ok ? 'The zone serves from European locations only.'
        : `The configuration restricts this zone to Europe, but the zone also serves from ${others.join(', ') || 'unreported regions'}. Disable the other regions, or the hostname cannot count as EU-located.`,
      observed: (['EU', 'US', 'ASIA', 'SA', 'AF'] as const).filter(region => geo[region] === true).join(',') });
  } else {
    out.push({ id: 'bunny.regions', status: 'info', message: 'The configuration does not restrict this zone to Europe, so its edge locations count as global.',
      observed: (['EU', 'US', 'ASIA', 'SA', 'AF'] as const).filter(region => geo[region] === true).join(',') });
  }
  const override = facts.maxAgeOverride;
  out.push(override === -1
    ? { id: 'bunny.cache-time', status: 'pass', message: 'Cache expiration follows the origin Cache-Control.', observed: -1 }
    : { id: 'bunny.cache-time', status: 'fail', message: 'The zone overrides the origin cache time. It could store responses the origin marks private or no-store. Set Cache Expiration Time to respect the origin.', observed: typeof override === 'number' ? override : null });
  flag('bunny.error-caching', facts.cacheErrors, true, 'fail', 'Error responses are not cached.',
    'The zone caches error responses. The origin sends errors as private, no-store; turn error caching off.');
  const varyParams = Array.isArray(facts.cookieVaryParameters) ? facts.cookieVaryParameters.length : 0;
  out.push(facts.cookieVary === true || varyParams > 0
    ? { id: 'bunny.cookie-vary', status: 'warn', message: 'Cookie vary is on. A response that depends on a cookie is private and must not be cached at all; turn cookie vary off.', observed: true }
    : { id: 'bunny.cookie-vary', status: 'pass', message: 'Cookie vary is off.', observed: false });
  const perma = facts.permaCacheZone;
  out.push(typeof perma === 'number' && perma > 0
    ? { id: 'bunny.perma-cache', status: 'warn', message: 'Perma-Cache is on. Bunny does not support tag purges with Perma-Cache, so tag purges would not evict.', observed: perma }
    : { id: 'bunny.perma-cache', status: 'pass', message: 'Perma-Cache is off.', observed: null });
  const missing = init.hostnames.filter(host => !facts.hostnames.includes(host));
  out.push(missing.length
    ? { id: 'bunny.hostnames', status: 'warn', message: `The zone does not list ${missing.join(', ')}. Add the hostname to the pull zone, or remove it from the configuration.`, observed: facts.hostnames.join(',') }
    : { id: 'bunny.hostnames', status: 'pass', message: 'Every configured hostname is on the zone.', observed: facts.hostnames.join(',') });
  flag('bunny.log-forwarding', facts.logForwarding, true, 'warn', 'Log forwarding is off.',
    'Log forwarding is on. Logs leave Bunny for the forwarding host; check where that host keeps them.');
  flag('bunny.log-storage', facts.logToStorage, true, 'warn', 'Permanent log storage is off.',
    'Permanent log storage is on. Check that the storage zone is in a European region.');
  flag('bunny.log-anonymised', facts.ipAnonymized, false, 'warn', 'Log IP addresses are anonymised.',
    'Log IP anonymisation is off. Turn it on, preferably with the drop option.');
  if (facts.originShield === true) {
    out.push({ id: 'bunny.origin-shield', status: init.options.regions ? 'warn' : 'info',
      message: 'Origin shield is on. Check that its location is in Europe, because the shield caches responses too.', observed: facts.originShieldZone });
  }
  if (facts.webpVary === true || facts.avifVary === true) {
    out.push({ id: 'bunny.format-vary', status: 'warn', message: 'WebP or AVIF vary is on. Image formats are explicit URLs in Lolly; turn format vary off.', observed: true });
  }
  return out;
}

export function createBunnyAdapter(init: BunnyAdapterInit): EdgeAdapter {
  const fetchImpl = init.fetchImpl ?? fetch;
  const timeoutMs = init.timeoutMs ?? 15_000;
  const secret = init.credential;
  const hosts = new Set(init.hostnames);
  const headers = { AccessKey: secret };
  const receipt = (kind: PurgeReceipt['kind'], items: number): PurgeReceipt => ({ provider: init.id, kind, items, requests: items, ids: [] });
  return {
    id: init.id,
    kind: 'bunny',
    jurisdiction: init.jurisdiction,
    edgeRegion: init.options.regions ? 'europe' : 'global',
    tagHeader: BUNNY_CAPABILITIES.tagHeader,
    capabilities: BUNNY_CAPABILITIES,
    async purgeTags(tags) {
      const unique = [...new Set(tags)];
      // A star could act as a wildcard in CacheTag; delivery tags never need one.
      for (const value of unique) {
        if (value.includes('*')) throw new EdgeApiError(`Refused tag ${JSON.stringify(value)}: Bunny purges take exact tags.`, { permanent: true });
        try { renderTags([value], 'comma'); } catch { throw new EdgeApiError(`Refused tag ${JSON.stringify(value)}: not a delivery tag.`, { permanent: true }); }
      }
      for (const value of unique) {
        const answer = await apiRequest(fetchImpl, { method: 'POST', url: `${BASE}/pullzone/${init.options.pullZoneId}/purgeCache`, headers, body: { CacheTag: value } }, secret, timeoutMs);
        if (answer.status < 200 || answer.status > 299) throw answerError(answer, 'Bunny tag purge', secret);
      }
      return receipt('tags', unique.length);
    },
    async purgeUrls(urls) {
      const unique = [...new Set(urls)];
      for (const value of unique) {
        const host = httpsHost(value);
        if (!host || !hosts.has(host) || value.includes('*')) throw new EdgeApiError(`Refused URL ${JSON.stringify(value.slice(0, 200))}: purge exact HTTPS URLs on this provider's hostnames.`, { permanent: true });
      }
      for (const value of unique) {
        const answer = await apiRequest(fetchImpl, { method: 'POST', url: `${BASE}/purge?url=${encodeURIComponent(value)}&async=false&exactPath=true`, headers }, secret, timeoutMs);
        if (answer.status < 200 || answer.status > 299) throw answerError(answer, 'Bunny URL purge', secret);
      }
      return receipt('urls', unique.length);
    },
    async verifyZone() {
      const answer = await apiRequest(fetchImpl, { method: 'GET', url: `${BASE}/pullzone/${init.options.pullZoneId}`, headers }, secret, timeoutMs);
      if (answer.status !== 200) {
        return [{ id: 'bunny.zone', status: 'fail', message: `Could not read pull zone ${init.options.pullZoneId}: the API answered ${answer.status}. Check the zone id and the API key.`, observed: answer.status }];
      }
      return [{ id: 'bunny.zone', status: 'pass', message: `Read pull zone ${init.options.pullZoneId}.` }, ...bunnyFindings(zoneFacts(answer.json), init)];
    },
  };
}
