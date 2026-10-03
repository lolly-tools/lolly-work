// SPDX-License-Identifier: MPL-2.0
/**
 * Production setup warning (server/src/setup/checks.ts `idp-secrets`): an
 * additional identity provider whose client secret variable is unset still
 * appears on the sign-in chooser, and every sign-in through it fails at the
 * provider. The check names the provider and the variable, never a value.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseConfig } from '../server/src/config/instance.ts';
import { startupChecks } from '../server/src/setup/checks.ts';

const secrets = { session: 'a'.repeat(32), link: 'b'.repeat(32) };
const config = (mode: 'production' | 'evaluation') => parseConfig(JSON.stringify({
  deployment: { mode },
  instance: { pack: '/tmp', baseUrl: 'https://work.test' },
  idp: {
    issuer: 'https://accounts.google.com', clientId: 'google-client',
    additional: [
      { id: 'github', kind: 'github', displayName: 'GitHub', clientId: 'gh-client', clientSecretRef: 'LW_IDP_GITHUB_SECRET' },
      { id: 'entra', displayName: 'Microsoft', issuer: 'https://login.microsoftonline.com/t/v2.0', clientId: 'ms', clientSecretRef: 'LW_IDP_MICROSOFT_SECRET' },
      // A public (PKCE) client names no secret and is never reported.
      { id: 'pkce', displayName: 'Public', issuer: 'https://idp.public.test', clientId: 'p' },
    ],
  },
}));

test('production warns, by name, about each additional provider whose secret variable is unset', () => {
  const env = { LW_IDP_MICROSOFT_SECRET: 'present-value-never-shown' };
  const check = startupChecks(config('production'), secrets, true, env).find((c) => c.id === 'idp-secrets');
  assert.equal(check?.status, 'warning', 'a warning, not a refusal: the primary provider still works');
  assert.match(check!.message, /GitHub \(github\)/);
  assert.match(check!.message, /LW_IDP_GITHUB_SECRET is not set/);
  assert.doesNotMatch(check!.message, /Microsoft|LW_IDP_MICROSOFT_SECRET|present-value/);
  assert.doesNotMatch(check!.message, /Public|pkce/);
});

test('a blank secret counts as unset; with every secret set, or outside production, nothing is reported', () => {
  const blank = startupChecks(config('production'), secrets, true, { LW_IDP_GITHUB_SECRET: '  ', LW_IDP_MICROSOFT_SECRET: 'x' });
  assert.match(blank.find((c) => c.id === 'idp-secrets')!.message, /LW_IDP_GITHUB_SECRET/);
  const all = startupChecks(config('production'), secrets, true, { LW_IDP_GITHUB_SECRET: 'x', LW_IDP_MICROSOFT_SECRET: 'y' });
  assert.equal(all.find((c) => c.id === 'idp-secrets'), undefined);
  assert.equal(startupChecks(config('evaluation'), secrets, true, {}).find((c) => c.id === 'idp-secrets'), undefined);
});
