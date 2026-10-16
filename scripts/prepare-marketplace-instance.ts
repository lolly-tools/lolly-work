// SPDX-License-Identifier: MPL-2.0
import { mkdirSync, writeFileSync, readFileSync, copyFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { instanceConfiguration } from '../deploy/marketplaces/server-start.mjs';

export function prepareInstance(directory: string, settings: Record<string, string>) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  const release = JSON.parse(readFileSync(join(root, 'deploy/marketplaces/release.json'), 'utf8'));
  const env: Record<string, string> = {
    LOLLY_AUTH_MODE: 'password', LOLLY_OIDC_ISSUER: '', LOLLY_OIDC_CLIENT_ID: '',
    ...settings,
    LW_IDP_CLIENT_SECRET: process.env.LW_IDP_CLIENT_SECRET ?? '',
    POSTGRES_PASSWORD: randomBytes(32).toString('hex'),
    LW_SESSION_SECRET: randomBytes(32).toString('hex'), LW_LINK_SECRET: randomBytes(32).toString('hex'),
    LW_CREDENTIAL_SECRET: randomBytes(32).toString('hex'),
  };
  instanceConfiguration({ ...env, DATABASE_URL: 'postgres://validation-only', LW_SHELL_SHA256: release.shell.sha256, LW_CATALOG_GENERATION: String(release.catalogGeneration) });
  if (Object.values(env).some(value => /[\r\n\0]/.test(value))) throw new Error('Settings must be single-line values');
  // Never reuse a destination: generating new keys over an installation breaks access.
  mkdirSync(directory, { mode: 0o700 });
  writeFileSync(join(directory, '.env'), Object.entries(env).map(([key, value]) => `${key}='${value.replaceAll("'", "\\'")}'`).join('\n') + '\n', { mode: 0o600, flag: 'wx' });
  for (const name of ['compose.yaml', 'Caddyfile', 'release.json']) copyFileSync(join(root, 'deploy/marketplaces', name), join(directory, name));
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' }, domain: { type: 'string' }, auth: { type: 'string' }, issuer: { type: 'string' }, client: { type: 'string' }, owner: { type: 'string' } } });
  if (!values.out || !values.domain || !values.owner) {
    throw new Error('Usage: node scripts/prepare-marketplace-instance.ts --out NEW_DIRECTORY --domain work.example.com --owner OWNER_EMAIL [--auth oidc --issuer HTTPS_ISSUER --client CLIENT_ID]');
  }
  prepareInstance(resolve(values.out), { LOLLY_DOMAIN: values.domain, LOLLY_AUTH_MODE: values.auth ?? (values.issuer ? 'oidc' : 'password'), LOLLY_OIDC_ISSUER: values.issuer ?? '', LOLLY_OIDC_CLIENT_ID: values.client ?? '', LOLLY_OWNER_EMAIL: values.owner });
  console.log('Prepared installation directory. Keep .env private and backed up; configure DNS, then issue the named owner link from the server after boot (or complete the selected OIDC registration).');
}
