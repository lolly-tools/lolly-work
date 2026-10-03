// SPDX-License-Identifier: MPL-2.0
import type { InstanceConfig, Secrets } from '../config/instance.ts';
import { checkShellDist } from '../lib/shell-dist.ts';
import { inspectPack, type PackCheck } from './pack.ts';

export interface SetupCheck { id: string; status: 'pass' | 'fail' | 'warning' | 'not-tested'; message: string }
export interface SetupReport {
  version: 1; checkedAt: string; mode: 'production' | 'evaluation'; ready: boolean;
  checks: SetupCheck[]; pack: PackCheck;
}
export function productionMode(config: InstanceConfig, env: Record<string, string | undefined> = process.env): boolean {
  return config.deployment.mode === 'production' || (config.deployment.mode === 'auto' && env.NODE_ENV === 'production');
}
/** Configuration checks contain names and remedies, never secret values or URLs. */
export function startupChecks(config: InstanceConfig, secrets: Secrets, durable: boolean,
  env: Record<string, string | undefined> = process.env): SetupCheck[] {
  const production = productionMode(config, env);
  const checks: SetupCheck[] = [];
  const check = (id: string, ok: boolean, pass: string, fail: string) => checks.push({ id,
    status: ok ? 'pass' : production ? 'fail' : 'warning', message: ok ? pass : fail });
  check('storage', durable, 'Durable database configured.', 'State uses memory and disappears on restart. Configure DATABASE_URL for production.');
  check('development-login', !config.dev.enabled, 'Development login disabled.', 'Disable dev.enabled before using production mode.');
  check('identity', !!(config.idp.issuer && config.idp.clientId) || config.proxyAuth.enabled,
    'An identity provider or authenticating proxy is configured.', 'Configure an identity provider or authenticating proxy.');
  check('access', config.policy.defaultAccessMode !== 'open', 'Access is governed.', 'Use gated or per-tool access for production.');
  // Not a refusal: an IdP that only ever issues accounts to your own people
  // (a single-tenant directory) is a policy on its own. A public one is not.
  if (production && config.idp.issuer) {
    checks.push(config.idp.admission
      ? { id: 'admission', status: 'pass', message: 'A sign-in admission policy is configured.' }
      : { id: 'admission', status: 'warning', message: 'Every account the identity provider accepts can sign in. Configure idp.admission (emails, domains or invitations) unless the provider only issues accounts to your own people.' });
  }
  // An unmapped role falls back to its literal name (rbac/evaluate.ts
  // roleFromGroups), so a group called "owner" or "admin" at ANY configured
  // IdP, or a proxy header, grants that role. Naming every role closes that.
  if (production && (config.idp.issuer || config.proxyAuth.enabled)) {
    const unmapped = (['owner', 'admin', 'approver', 'author'] as const).filter((role) => !Array.isArray(config.idp.roleGroups?.[role]));
    checks.push(unmapped.length
      ? { id: 'role-groups', status: 'warning', message: `idp.roleGroups does not map ${unmapped.join(', ')}, so a group with exactly that name from the identity provider grants the role. Map each role to your own group names, or to an empty list to turn it off.` }
      : { id: 'role-groups', status: 'pass', message: 'Every privileged role is mapped to named groups.' });
  }
  // An additional IdP whose secret variable is unset still shows on the sign-in
  // chooser, and every sign-in through it then fails at the IdP. Named, never read out.
  if (production) {
    const missing = config.idp.additional.filter((idp) => idp.clientSecretRef && !env[idp.clientSecretRef]?.trim());
    if (missing.length) {
      checks.push({ id: 'idp-secrets', status: 'warning', message: `Sign-in through ${missing.map((idp) => `${idp.displayName || idp.id} (${idp.id})`).join(', ')} will fail: ${missing.map((idp) => idp.clientSecretRef).join(', ')} ${missing.length === 1 ? 'is' : 'are'} not set. Set each in the server environment, or remove that provider from idp.additional.` });
    }
  }
  const protectedBase = (() => { try { const url = new URL(config.instance.baseUrl); return url.protocol === 'https:' && !url.username && !url.password && !url.search && !url.hash; } catch { return false; } })();
  check('transport', protectedBase, 'Public base URL uses HTTPS.', 'Set instance.baseUrl to the public HTTPS URL without credentials, query or fragment.');
  check('session-secret', Buffer.byteLength(secrets.session) >= 32, 'Session signing secret meets the length requirement.', 'Set LW_SESSION_SECRET to a stable random secret of at least 32 bytes.');
  check('link-secret', Buffer.byteLength(secrets.link) >= 32, 'Link signing secret meets the length requirement.', 'Set LW_LINK_SECRET to a stable random secret of at least 32 bytes.');
  check('renderer-secret', !config.render.worker.url || !!secrets.renderWorker,
    'Renderer configuration is consistent.', 'Set LW_RENDER_WORKER_SECRET when render.worker.url is configured.');
  check('signer', !!config.render.c2pa.certFile === !!secrets.c2paSigningKey,
    'Signing configuration is consistent.', 'Configure both the signing certificate and LW_C2PA_SIGNING_KEY, or neither.');
  if (config.instance.shellDir || config.deployment.application === 'web') {
    const shell = config.instance.shellDir ? checkShellDist(config.instance.shellDir) : null;
    check('web-shell', !!(shell?.present && shell.hasOrgConfig) || !!config.instance.appUrl,
      'An employee shell is configured.', 'Install a current governed shell or configure its external appUrl.');
    checks.push({ id: 'shell-contract', status: 'not-tested', message: 'Exact shell compatibility has not been verified. Validate the matched release before acceptance.' });
  }
  checks.push({ id: 'identity-live', status: 'not-tested', message: 'Verify the customer sign-in, provisioning, role-change and disable journey. Setup shows observed sign-ins and account correlation separately.' });
  if (config.render.worker.url) checks.push({ id: 'renderer-live', status: 'not-tested', message: 'A configured worker needs an exact-release canary; configuration alone does not prove rendering.' });
  return checks;
}
export async function assessSetup(config: InstanceConfig, secrets: Secrets, durable: boolean,
  options: { env?: Record<string, string | undefined>; pack?: PackCheck } = {}): Promise<SetupReport> {
  const checks = startupChecks(config, secrets, durable, options.env);
  const pack = options.pack ?? await inspectPack(config.instance.pack, {
    workerConfigured: !!config.render.worker.url && !!secrets.renderWorker,
    requireServerRendering: config.deployment.requireServerRendering,
    allowHooksInFastPath: config.render.allowHooksInFastPath,
  });
  const mode = productionMode(config, options.env) ? 'production' : 'evaluation';
  checks.push({ id: 'pack', status: pack.compatible ? 'pass' : mode === 'production' ? 'fail' : 'warning',
    message: pack.compatible ? 'The selected pack loads with the installed engine.' : 'The selected pack is missing or incompatible. Review the tool diagnostics before acceptance.' });
  return { version: 1, checkedAt: new Date().toISOString(), mode, ready: !checks.some(check => check.status === 'fail'), checks, pack };
}
