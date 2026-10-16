// SPDX-License-Identifier: MPL-2.0
import { existsSync, lstatSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function instanceConfiguration(env) {
  const required = (name) => {
    const value = env[name]?.trim();
    if (!value || /[\r\n\0]/.test(value)) throw new Error(`Set ${name} before deployment`);
    return value;
  };
  const domain = required('LOLLY_DOMAIN');
  if (!/^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z][a-z0-9-]{1,62}$/.test(domain)) {
    throw new Error('LOLLY_DOMAIN must be a DNS name without scheme, port or path');
  }
  const mode = env.LOLLY_AUTH_MODE || 'password';
  if (!['password', 'oidc'].includes(mode)) throw new Error('LOLLY_AUTH_MODE must be password or oidc');
  const issuerValue = mode === 'oidc' ? required('LOLLY_OIDC_ISSUER') : '';
  if (mode === 'oidc') {
    const issuer = new URL(issuerValue);
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password || issuer.search || issuer.hash) {
      throw new Error('LOLLY_OIDC_ISSUER must be an HTTPS issuer without credentials, query or fragment');
    }
  }
  const owner = required('LOLLY_OWNER_EMAIL').toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(owner)) throw new Error('Set a valid LOLLY_OWNER_EMAIL');
  const hash = required('LW_SHELL_SHA256');
  if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error('Invalid pinned shell checksum');
  const generation = Number(required('LW_CATALOG_GENERATION'));
  if (!Number.isSafeInteger(generation) || generation < 1) throw new Error('Invalid catalogue generation');
  for (const name of ['LW_SESSION_SECRET', 'LW_LINK_SECRET', 'LW_CREDENTIAL_SECRET']) {
    if (required(name).length < 32) throw new Error(`${name} must contain at least 32 characters`);
  }
  if (!/^postgres(?:ql)?:\/\//.test(required('DATABASE_URL'))) throw new Error('A PostgreSQL DATABASE_URL is required');
  return {
    deployment: { mode: 'production', application: 'web', requireServerRendering: false },
    instance: {
      name: 'Lolly Work', baseUrl: `https://${domain}`,
      pack: `/app/content/${hash}/pack`, shellDir: `/app/content/${hash}/shell`,
      catalogPublicationGeneration: generation,
    },
    idp: {
      issuer: issuerValue, clientId: mode === 'oidc' ? required('LOLLY_OIDC_CLIENT_ID') : '',
      additional: mode === 'password' ? [{ id: 'email', kind: 'password', label: 'Email and password' }] : [],
      admission: { emails: [owner], invitations: true }, bootstrapOwners: [owner],
      roleGroups: { owner: ['lolly-owner'], admin: [], approver: [], author: [] },
    },
    policy: {
      defaultAccessMode: 'gated', telemetry: 'off', telemetryAttribution: 'opt-in',
      guestLinks: { enabled: false }, nearby: { enabled: false },
      activity: { mode: 'off', auditSessionUpdates: false }, sessionTtlHours: 12,
    },
    render: { allowHooksInFastPath: false },
    rateLimit: { enabled: true, trustedProxyHops: 1 },
    dev: { enabled: false, users: [] }, blobs: { driver: 'pg' }, catalogProviders: [],
  };
}

export function prepareConfiguration(env, path) {
  const initial = instanceConfiguration(env);
  let configuration = initial;
  if (existsSync(path)) {
    if (!lstatSync(path).isFile() || lstatSync(path).isSymbolicLink()) throw new Error('Instance configuration must be a regular file');
    configuration = JSON.parse(readFileSync(path, 'utf8'));
    if (!configuration.instance) throw new Error('Stored instance configuration is incomplete');
    // Keep console/operator settings. Only installer-managed release paths move.
    for (const [key, leaf] of [['pack', 'pack'], ['shellDir', 'shell']]) {
      if (new RegExp('^/app/content/[a-f0-9]{64}/' + leaf + '$').test(configuration.instance[key])) {
        configuration.instance[key] = initial.instance[key];
      }
    }
    const previous = configuration.instance.catalogPublicationGeneration ?? 0;
    configuration.instance.catalogPublicationGeneration = Math.max(previous, initial.instance.catalogPublicationGeneration);
  }
  const temporary = path + '.next-' + randomUUID();
  writeFileSync(temporary, JSON.stringify(configuration, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
  renameSync(temporary, path);
  return configuration;
}

if (process.env.LW_DISTRIBUTION_START === '1') {
  process.env.LW_CATALOG_SIGNING_KEY = readFileSync('/app/keys/catalog.jwk', 'utf8');
  process.env.LW_CONFIG = '/app/state/instance.json';
  prepareConfiguration(process.env, process.env.LW_CONFIG);
  await import('file:///app/server/src/main.ts');
}
