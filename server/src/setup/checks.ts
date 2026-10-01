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
