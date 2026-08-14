/**
 * Provider onboarding-doc contract (plans/28 §3). Turns docs/providers/<kind>.md
 * into a checked contract so a driver change can't silently outrun its guide:
 *   - every shipped kind (except mock) has a guide with the skeleton headings;
 *   - each guide's instance.json example parses through parseConfig;
 *   - its options keys stay within the driver's option set;
 *   - the OAuth credential shape the guides document is the one the code accepts;
 *   - a guide only claims publish-out for a kind whose driver supports it;
 *   - parseConfig rejects the documented failure modes.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROVIDER_KINDS, type ProviderRecord } from '../server/src/catalog/providers/types.ts';
import { parseConfig } from '../server/src/config/instance.ts';
import { createProvider } from '../server/src/catalog/providers/registry.ts';
import { parseOAuthCredential } from '../server/src/catalog/providers/oauth.ts';

const DOCS = join(dirname(fileURLToPath(import.meta.url)), '..', 'docs', 'providers');
const KINDS = PROVIDER_KINDS.filter((k) => k !== 'mock');
const OAUTH_KINDS = ['dropbox', 'gdrive', 'o365', 'optimizely-cmp', 'imagerelay'] as const;

const REQUIRED_HEADINGS = ['## What you need', '## Credential shape', '## instance.json', '## Verify', '## Notes / limits'];

// Kept in sync with each driver's *Options interface — a guide documenting an
// option the driver doesn't have (or vice versa) fails here.
const OPTION_ALLOWLIST: Record<string, string[]> = {
  brandfolder: ['brandfolderId', 'baseUrl'],
  s3: ['bucket', 'region', 'endpoint', 'prefix'],
  git: ['rawBase', 'manifestPath', 'authHeader'],
  dropbox: ['path'],
  gdrive: ['folderId'],
  o365: ['driveId', 'tenant', 'itemPath'],
  'optimizely-cmp': ['baseUrl', 'tokenUrl', 'publish'],
  imagerelay: ['baseUrl', 'tokenUrl', 'folderId', 'recursive'],
  'acquia-dam': ['baseUrl', 'query', 'approvedStatuses'],
};

// Minimal construct-valid options per kind (git parses rawBase at construction).
const MIN_OPTIONS: Record<string, Record<string, unknown>> = {
  brandfolder: { brandfolderId: 'x' }, s3: { bucket: 'b' }, git: { rawBase: 'https://raw.example/o/r/main' },
  dropbox: {}, gdrive: { folderId: 'f' }, o365: { driveId: 'd' }, 'optimizely-cmp': { publish: true },
  imagerelay: {}, 'acquia-dam': {},
};

const guide = (kind: string): string => readFileSync(join(DOCS, `${kind}.md`), 'utf8');

/** The provider-entry example: the first ```json block AFTER the "## instance.json"
 *  heading (so an earlier ```json — e.g. s3's IAM policy — is never picked). */
function exampleEntry(md: string): Record<string, unknown> {
  const at = md.indexOf('## instance.json');
  assert.ok(at >= 0, 'guide has an instance.json section');
  const m = /```json\s*([\s\S]*?)```/.exec(md.slice(at));
  assert.ok(m?.[1], 'instance.json section has a ```json example');
  return JSON.parse(m[1]) as Record<string, unknown>;
}

const baseCfg = (extra: Record<string, unknown>): string =>
  JSON.stringify({ instance: { name: 'T', baseUrl: 'http://localhost', pack: '/tmp/pack' }, dev: { enabled: true }, ...extra });

test('every shipped kind has a guide with the required skeleton headings', () => {
  for (const kind of KINDS) {
    const md = guide(kind);
    for (const h of REQUIRED_HEADINGS) assert.ok(md.includes(h), `${kind}.md missing heading "${h}"`);
    assert.ok(md.includes(`kind: \`${kind}\``), `${kind}.md names its kind`);
  }
});

test("each guide's instance.json example parses and its options match the driver", () => {
  for (const kind of KINDS) {
    const entry = exampleEntry(guide(kind));
    assert.equal(entry.kind, kind, `${kind}.md example is the right kind`);
    // Round-trips through the real config validator.
    const cfg = parseConfig(baseCfg({ catalogProviders: [entry] }));
    assert.equal(cfg.catalogProviders[0]?.kind, kind);
    // Options stay within the driver's set.
    const opts = Object.keys((entry.options as Record<string, unknown>) ?? {});
    for (const k of opts) assert.ok(OPTION_ALLOWLIST[kind]!.includes(k), `${kind}.md documents unknown option "${k}"`);
  }
});

test('the documented OAuth credential shape is exactly what the code accepts', () => {
  // Valid: clientId + refreshToken (clientSecret optional) — the shape every OAuth guide shows.
  const cred = parseOAuthCredential(JSON.stringify({ clientId: 'c', clientSecret: 's', refreshToken: 'r' }));
  assert.equal(cred.clientId, 'c');
  assert.equal(cred.refreshToken, 'r');
  parseOAuthCredential(JSON.stringify({ clientId: 'c', refreshToken: 'r' })); // public/PKCE app: no secret
  // Malformed shapes the guides never show are refused.
  assert.throws(() => parseOAuthCredential('not json'));
  assert.throws(() => parseOAuthCredential(JSON.stringify({ clientId: 'c' })), /refreshToken/i);
  assert.throws(() => parseOAuthCredential(undefined));
  for (const kind of OAUTH_KINDS) assert.ok(guide(kind).includes('"refreshToken"'), `${kind}.md shows the OAuth blob`);
});

test('publish-out is claimed only where the driver supports it', () => {
  for (const kind of KINDS) {
    const rec = { id: 't', kind, options: MIN_OPTIONS[kind] } as unknown as ProviderRecord;
    const driver = createProvider(rec, undefined);
    const canPublish = driver.capabilities.publish === true;
    assert.equal(canPublish, kind === 'optimizely-cmp', `${kind} publish capability`);
    // Only the kind that can publish documents a "Publishing" section.
    assert.equal(guide(kind).includes('## Publishing'), canPublish, `${kind}.md publish section matches capability`);
  }
});

test('parseConfig rejects the failure modes the guides warn about', () => {
  assert.throws(() => parseConfig(baseCfg({ catalogProviders: [{ id: 'x', kind: 'bogus', label: 'l' }] })), /unknown catalog provider kind/);
  assert.throws(() => parseConfig(baseCfg({ catalogProviders: [{ id: 'x', kind: 's3' }] })), /needs a label/);
  assert.throws(() => parseConfig(baseCfg({ blobs: { driver: 'floppy' } })), /blobs\.driver/);
  assert.throws(() => parseConfig(baseCfg({ blobs: { driver: 's3' } })), /requires blobs\.s3\.bucket/);
});
