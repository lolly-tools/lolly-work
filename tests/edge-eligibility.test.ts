// SPDX-License-Identifier: MPL-2.0
/**
 * The edge jurisdiction rule (plan 80 section 3.1), decided per hostname when
 * the configuration loads. A CDN terminates TLS for every route on a hostname,
 * so under eu-only a non-EU provider may front only a hostname marked
 * publicOnly, and the instance's own hostname can never be publicOnly.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseConfig } from '../server/src/config/instance.ts';
import { edgeProviderDescriptor, edgeTagHeaders, euEligible, publicOnlyHosts, validateEdgeConfig } from '../server/src/edge/config.ts';

const INSTANCE = ['work.example.eu'];
const ZONE = '0123456789abcdef0123456789abcdef';
const bunnyEu = { id: 'eu-cdn', kind: 'bunny', hostnames: ['work.example.eu'], options: { pullZoneId: 42, regions: ['europe'] }, jurisdiction: { logs: 'eu' } };
const cloudflare = (hostnames: string[], publicOnly?: boolean) => ({ id: 'cf', kind: 'cloudflare', hostnames, options: { zoneId: ZONE }, ...(publicOnly === undefined ? {} : { publicOnly }) });

test('the eligibility matrix: who may front which hostname under each policy', () => {
  type Case = [label: string, policy: 'eu-only' | 'any' | undefined, provider: Record<string, unknown>, expect: RegExp | 'ok'];
  const cases: Case[] = [
    ['eu-only is the default and accepts Bunny restricted to Europe with EU logs on the instance hostname', undefined, bunnyEu, 'ok'],
    ['eu-only refuses Bunny serving every region', 'eu-only', { ...bunnyEu, options: { pullZoneId: 42 } }, /edge locations global/],
    ['eu-only refuses Bunny until its log location is stated', 'eu-only', { ...bunnyEu, jurisdiction: undefined }, /logs unknown/],
    ['eu-only refuses Cloudflare on the instance hostname', 'eu-only', cloudflare(['work.example.eu']), /cannot front work\.example\.eu under edge\.jurisdiction "eu-only": company us/],
    ['eu-only refuses Cloudflare on any hostname not marked publicOnly', 'eu-only', cloudflare(['assets.example.eu']), /cannot front assets\.example\.eu/],
    ['eu-only allows Cloudflare on a separate publicOnly hostname', 'eu-only', cloudflare(['assets.example.eu'], true), 'ok'],
    ['eu-only never lets the instance hostname be publicOnly', 'eu-only', cloudflare(['work.example.eu'], true), /own hostname/],
    ['any allows Cloudflare on the instance hostname', 'any', cloudflare(['work.example.eu']), 'ok'],
    ['any still never lets the instance hostname be publicOnly', 'any', cloudflare(['work.example.eu'], true), /own hostname/],
    ['any allows Bunny serving every region', 'any', { ...bunnyEu, options: { pullZoneId: 42 }, jurisdiction: undefined }, 'ok'],
    ['a declaration cannot move Cloudflare to the EU', 'any', { ...cloudflare(['assets.example.eu']), jurisdiction: { company: 'eu' } }, /company is us .* cannot be declared eu/],
    ['a declaration cannot restrict an unrestricted Bunny zone', 'eu-only', { ...bunnyEu, options: { pullZoneId: 42 }, jurisdiction: { edgeLocations: 'eu', logs: 'eu' } }, /edgeLocations is global/],
    ['a typo in a provider key fails', 'eu-only', { ...bunnyEu, publiconly: true }, /unknown key "publiconly"/],
    ['an unknown option fails', 'eu-only', { ...bunnyEu, options: { pullZoneId: 42, regions: ['europe'], optimizer: true } }, /unknown bunny option "optimizer"/],
    ['an unknown kind fails', 'eu-only', { ...bunnyEu, kind: 'akamai' }, /kind must be one of bunny, cloudflare/],
    ['a credential written into the file instead of an env var name fails', 'eu-only', { ...bunnyEu, credentialRef: 'pasted key value' }, /credentialRef must name an env var/],
    ['a Cloudflare zone id must be the 32-character id', 'any', { ...cloudflare(['assets.example.eu']), options: { zoneId: 'example.eu' } }, /zoneId must be the 32-character zone id/],
    ['a hostname must be lower case', 'any', cloudflare(['Assets.example.eu']), /not a lower-case hostname/],
  ];
  for (const [label, policy, provider, expect] of cases) {
    const raw = { ...(policy ? { jurisdiction: policy } : {}), providers: [provider] };
    if (expect === 'ok') assert.doesNotThrow(() => validateEdgeConfig(raw, INSTANCE), label);
    else assert.throws(() => validateEdgeConfig(raw, INSTANCE), expect, label);
  }
});

test('one hostname has one edge, and the appUrl host counts as the instance', () => {
  assert.throws(() => validateEdgeConfig({ providers: [bunnyEu, { ...bunnyEu, id: 'second' }] }, INSTANCE), /already fronted by eu-cdn/);
  assert.throws(() => validateEdgeConfig({ jurisdiction: 'any', providers: [cloudflare(['app.example.eu'], true)] }, ['work.example.eu', 'app.example.eu']), /own hostname/);
  assert.throws(() => validateEdgeConfig({ jurisdiction: 'eu-or-us' }, INSTANCE), /"eu-only" \(the default\) or "any"/);
});

test('the load fails closed through parseConfig, and an absent block means eu-only with no providers', () => {
  const base = { instance: { name: 'Edge', baseUrl: 'https://work.example.eu', pack: './packs/demo' }, dev: { enabled: true } };
  const plain = parseConfig(JSON.stringify(base));
  assert.deepEqual(plain.edge, { jurisdiction: 'eu-only', providers: [] });
  assert.throws(() => parseConfig(JSON.stringify({ ...base, edge: { providers: [cloudflare(['work.example.eu'])] } })), /cannot front work\.example\.eu/);
  assert.throws(() => parseConfig(JSON.stringify({ ...base, edge: { jurisdiction: 'any', providers: [cloudflare(['work.example.eu'], true)] } })), /own hostname/);
  const split = parseConfig(JSON.stringify({ ...base, edge: { providers: [bunnyEu, cloudflare(['assets.example.eu'], true)] } }));
  assert.deepEqual(split.edge.providers.map(p => [p.id, p.publicOnly, euEligible(p.jurisdiction)]), [['eu-cdn', false, true], ['cf', true, false]]);
  assert.deepEqual(edgeTagHeaders(split.edge), ['cdn-tag', 'cache-tag']);
  assert.deepEqual([...publicOnlyHosts(split.edge)], ['assets.example.eu']);
});

test('a provider descriptor names no credential and no variable', () => {
  const config = validateEdgeConfig({ providers: [{ ...bunnyEu, credentialRef: 'LW_EDGE_BUNNY_KEY' }] }, INSTANCE);
  const text = JSON.stringify(edgeProviderDescriptor(config.providers[0]!));
  assert.doesNotMatch(text, /LW_EDGE_BUNNY_KEY/);
  assert.match(text, /"credentialSource":"environment"/);
});
