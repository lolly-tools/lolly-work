// SPDX-License-Identifier: MPL-2.0
import { createHash } from 'node:crypto';
import { parseConfig, type InstanceConfig } from '../config/instance.ts';
import { roleFromGroups, type RoleGroups } from '../rbac/evaluate.ts';
import { productionMode } from './checks.ts';

export const SETUP_ROLES = ['owner', 'admin', 'approver', 'author', 'member', 'viewer'] as const;
export class SetupInputError extends Error {
  readonly field: string;
  constructor(field: string, message: string) { super(message); this.field = field; }
}
export interface SetupDraft {
  name: string; baseUrl: string; pack: string; mode: 'evaluation' | 'production'; application: 'api' | 'web';
  shellDir: string; appUrl: string; authentication: 'development' | 'oidc' | 'proxy';
  issuer: string; clientId: string; providerName: string; groupsClaim: string; roleGroups: RoleGroups;
  ownerTestGroups: string[]; workerUrl: string; requireServerRendering: boolean;
  telemetry: 'off' | 'aggregate' | 'standard'; guestLinks: boolean; keepDevelopmentLogin: boolean;
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');
/** Apply the assistant's merge patch while preserving unrelated deployment settings. */
export function mergeSetupPatch(target: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const result = structuredClone(target);
  for (const [key, value] of Object.entries(patch)) {
    if (['__proto__', 'constructor', 'prototype'].includes(key)) throw new SetupInputError('configuration', 'Unsupported configuration key.');
    if (value === null) delete result[key];
    else if (value && typeof value === 'object' && !Array.isArray(value)) {
      const previous = result[key];
      result[key] = mergeSetupPatch(previous && typeof previous === 'object' && !Array.isArray(previous) ? previous as Record<string, unknown> : {}, value as Record<string, unknown>);
    } else result[key] = structuredClone(value);
  }
  return result;
}
function endpoint(value: string): string {
  try { const url = new URL(value); return !url.username && !url.password && !url.search && !url.hash ? value : ''; }
  catch { return ''; }
}
export function setupDraft(config: InstanceConfig, groups: string[] = []): SetupDraft {
  return { name: config.instance.name, baseUrl: endpoint(config.instance.baseUrl), pack: config.instance.pack,
    mode: productionMode(config) ? 'production' : 'evaluation', application: config.deployment.application,
    shellDir: config.instance.shellDir ?? '', appUrl: endpoint(config.instance.appUrl ?? ''),
    authentication: config.idp.issuer ? 'oidc' : config.proxyAuth.enabled ? 'proxy' : 'development',
    issuer: endpoint(config.idp.issuer), clientId: config.idp.clientId, providerName: config.idp.displayName,
    groupsClaim: config.idp.groupsClaim,
    roleGroups: Object.fromEntries(SETUP_ROLES.map(role => [role, config.idp.roleGroups[role] ?? (['owner', 'admin', 'approver', 'author'].includes(role) ? [role] : [])])),
    ownerTestGroups: groups, workerUrl: endpoint(config.render.worker.url), requireServerRendering: config.deployment.requireServerRendering,
    telemetry: config.policy.telemetry, guestLinks: config.policy.guestLinks.enabled, keepDevelopmentLogin: config.dev.enabled };
}
/** Hash the effective editable settings, excluding the hypothetical owner preview. */
export function setupSettingsHash(draft: SetupDraft): string {
  const { ownerTestGroups: _groups, ...settings } = draft; return digest(settings);
}
export function identitySettingsHash(config: InstanceConfig): string {
  return digest([config.instance.baseUrl, config.idp.issuer, config.idp.clientId, config.idp.groupsClaim, config.idp.claimMap, config.idp.roleGroups, config.idp.additional, config.proxyAuth]);
}
export function generateSetup(value: unknown, current: InstanceConfig) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new SetupInputError('configuration', 'Enter the setup settings first.');
  const raw = value as Record<string, unknown>;
  const draft = structuredClone(setupDraft(current));
  if (Object.keys(raw).some(key => !Object.hasOwn(draft, key))) throw new SetupInputError('configuration', 'Use the fields provided by this setup assistant.');
  for (const key of ['name', 'baseUrl', 'pack', 'shellDir', 'appUrl', 'issuer', 'clientId', 'providerName', 'groupsClaim', 'workerUrl'] as const) {
    if (typeof raw[key] !== 'string' || raw[key].length > 1000 || /[\u0000-\u001f]/.test(raw[key])) throw new SetupInputError(key, 'Enter a single value of at most 1000 characters.');
    draft[key] = raw[key].trim();
  }
  for (const key of ['mode', 'application', 'authentication', 'telemetry'] as const) {
    const choices = { mode: ['evaluation', 'production'], application: ['api', 'web'], authentication: ['development', 'oidc', 'proxy'], telemetry: ['off', 'aggregate', 'standard'] }[key];
    if (!choices.includes(String(raw[key]))) throw new SetupInputError(key, 'Choose one of the available options.');
    Object.assign(draft, { [key]: raw[key] });
  }
  for (const key of ['requireServerRendering', 'guestLinks', 'keepDevelopmentLogin'] as const) {
    if (typeof raw[key] !== 'boolean') throw new SetupInputError(key, 'Choose whether this feature is enabled.');
    draft[key] = raw[key];
  }
  const checkUrl = (key: 'baseUrl' | 'issuer' | 'appUrl' | 'workerUrl', required = false) => {
    if (!draft[key] && !required) return;
    let url: URL; try { url = new URL(draft[key]); } catch { throw new SetupInputError(key, 'Enter a complete HTTP or HTTPS URL.'); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) throw new SetupInputError(key, 'Use a URL without credentials, query parameters or a fragment.');
    if (draft.mode === 'production' && key !== 'workerUrl' && url.protocol !== 'https:') throw new SetupInputError(key, 'Use HTTPS for production.');
  };
  checkUrl('baseUrl', true); checkUrl('issuer', draft.authentication === 'oidc'); checkUrl('appUrl'); checkUrl('workerUrl');
  if (!draft.name) throw new SetupInputError('name', 'Give the instance a name.');
  if (!draft.pack) throw new SetupInputError('pack', 'Enter the mounted pack path.');
  if (draft.application === 'web' && !draft.shellDir && !draft.appUrl) throw new SetupInputError('shellDir', 'Set a served shell path or the external employee app URL.');
  if (draft.authentication === 'oidc' && (!draft.clientId || !draft.groupsClaim)) throw new SetupInputError('clientId', 'Set the registered client ID and groups claim name.');
  if (draft.authentication === 'proxy' && !current.proxyAuth.enabled) throw new SetupInputError('authentication', 'Configure and test the proxy headers and shared secret using the identity guide first.');
  if (draft.authentication !== 'oidc' && current.idp.additional.length) throw new SetupInputError('authentication', 'Additional issuers require the primary OIDC registration. Keep OIDC or update the advanced identity configuration first.');
  if (draft.mode === 'production' && (draft.authentication === 'development' || draft.keepDevelopmentLogin)) throw new SetupInputError('keepDevelopmentLogin', 'Production requires real identity and development login disabled.');
  if (!raw.roleGroups || typeof raw.roleGroups !== 'object' || Array.isArray(raw.roleGroups)) throw new SetupInputError('roleGroups', 'Enter the groups for each role.');
  draft.roleGroups = raw.roleGroups as RoleGroups;
  if (!Array.isArray(raw.ownerTestGroups) || raw.ownerTestGroups.length > 100 || raw.ownerTestGroups.some(group => typeof group !== 'string' || !group.trim() || group.length > 300)) throw new SetupInputError('ownerTestGroups', 'Enter the exact groups supplied for the intended first owner.');
  draft.ownerTestGroups = raw.ownerTestGroups as string[];
  const patch = {
    deployment: { mode: draft.mode, application: draft.application, requireServerRendering: draft.requireServerRendering },
    instance: { name: draft.name, baseUrl: draft.baseUrl.replace(/\/+$/, ''), pack: draft.pack, shellDir: draft.shellDir || null, appUrl: draft.appUrl || null },
    idp: { issuer: draft.authentication === 'oidc' ? draft.issuer.replace(/\/+$/, '') : '', clientId: draft.authentication === 'oidc' ? draft.clientId : '',
      displayName: draft.providerName, groupsClaim: draft.groupsClaim, roleGroups: draft.roleGroups },
    proxyAuth: { enabled: draft.authentication === 'proxy' },
    dev: { enabled: draft.authentication === 'development' || draft.keepDevelopmentLogin },
    render: { worker: { url: draft.workerUrl }, ...(draft.mode === 'production' ? { allowHooksInFastPath: false } : {}) },
    policy: { telemetry: draft.telemetry, guestLinks: { enabled: draft.guestLinks },
      ...(draft.mode === 'production' && current.policy.defaultAccessMode === 'open' ? { defaultAccessMode: 'gated' as const } : {}) },
  };
  // Null removes optional paths in a merge patch; the parser receives absent keys.
  const merged = { ...current, deployment: patch.deployment, instance: { ...current.instance, ...patch.instance },
    idp: { ...current.idp, ...patch.idp }, proxyAuth: { ...current.proxyAuth, ...patch.proxyAuth }, dev: { ...current.dev, ...patch.dev },
    render: { ...current.render, ...patch.render, worker: { ...current.render.worker, ...patch.render.worker } },
    policy: { ...current.policy, ...patch.policy, guestLinks: { ...current.policy.guestLinks, ...patch.policy.guestLinks } } };
  if (!draft.shellDir) delete (merged.instance as Partial<InstanceConfig['instance']>).shellDir;
  if (!draft.appUrl) delete (merged.instance as Partial<InstanceConfig['instance']>).appUrl;
  let config: InstanceConfig;
  try { config = parseConfig(JSON.stringify(merged)); }
  catch { throw new SetupInputError('roleGroups', 'Check group mappings: use supported roles, exact non-empty names and assign each group once.'); }
  if (roleFromGroups(draft.ownerTestGroups, config.idp.roleGroups) !== 'owner') throw new SetupInputError('ownerTestGroups', 'The intended first owner groups do not map to owner. Correct the mapping before changing sign-in.');
  if (config.dev.enabled && !config.dev.users.some(user => roleFromGroups(user.groups ?? [], config.idp.roleGroups) === 'owner')) throw new SetupInputError('roleGroups', 'Keep an existing development owner reachable while preparing identity. Remove that route only after a real owner signs in.');
  const effective = setupDraft(config);
  const helm = { config: patch };
  const requiredEnvironment = ['LW_SESSION_SECRET', 'LW_LINK_SECRET', ...(draft.mode === 'production' ? ['DATABASE_URL'] : []),
    ...(draft.workerUrl ? ['LW_RENDER_WORKER_SECRET'] : []), ...(draft.authentication === 'oidc' ? ['LW_IDP_CLIENT_SECRET (if your registration requires one)'] : []),
    ...(draft.authentication === 'proxy' ? [current.proxyAuth.secretRef] : [])];
  return { version: 1, settings: draft, patch, helm, expectedSettingsHash: setupSettingsHash(effective), ownerPreview: { role: 'owner', groups: draft.ownerTestGroups },
    redirectUri: draft.authentication === 'oidc' ? `${config.instance.baseUrl}/api/auth/callback` : null,
    requiredEnvironment, warnings: [
      'This is a deployment patch, not a saved change. Apply it to the existing configuration, preserve other settings, and restart.',
      ...(config.dev.enabled ? ['Development login remains enabled. Keep this instance restricted to evaluation.'] : []),
      ...(draft.mode === 'production' ? ['Verify real owner sign-in before cutover. Production refuses missing durable storage, secrets or compatible packs.'] : []),
      'The owner preview uses the groups you entered; it does not prove what the identity provider sends.',
    ] };
}
