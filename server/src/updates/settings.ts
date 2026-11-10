// SPDX-License-Identifier: MPL-2.0
/**
 * Release notice settings: instance.json's `updates` and `install` blocks, and
 * the environment the Helm chart sets.
 *
 *   updates.check    LW_UPDATES_CHECK     default true. Either one set to false turns it off
 *   updates.channel  LW_UPDATES_CHANNEL   stable (default) or preview
 *   updates.feedUrl  LW_UPDATES_FEED_URL  the chart repository index; a mirror for air-gapped installs
 *   install.route    LW_INSTALL_ROUTE     helm, rancher, fleet, argocd or other (default)
 *
 * The chart also says which release this is: LW_RELEASE_NAME, LW_RELEASE_NAMESPACE,
 * LW_RELEASE_FULLNAME (the Deployment's name) and LW_CHART_VERSION. They only fill
 * in the upgrade commands; a value that is not a valid Kubernetes name is left out
 * and the command shows a placeholder.
 */
export const DEFAULT_FEED_URL = 'https://github.com/lolly-tools/lolly-work/releases/download/helm-index/index.yaml';
export const UPDATE_CHANNELS = ['stable', 'preview'] as const;
export type UpdateChannel = (typeof UPDATE_CHANNELS)[number];
export const INSTALL_ROUTES = ['helm', 'rancher', 'fleet', 'argocd', 'other'] as const;
export type InstallRoute = (typeof INSTALL_ROUTES)[number];

export interface UpdatesConfig { check: boolean; channel: UpdateChannel; feedUrl: string }
export interface InstallConfig { route: InstallRoute }

export interface ReleaseIdentity {
  name: string | null;
  namespace: string | null;
  fullname: string | null;
  chartVersion: string | null;
}

export interface UpdateSettings {
  check: boolean;
  channel: UpdateChannel;
  feedUrl: string;
  route: InstallRoute;
  release: ReleaseIdentity;
}

/** Why a feed URL is refused, or null. https, or http on a loopback address for
 *  local testing; no credentials or fragment. A path and query are allowed, for
 *  a mirror that serves the index somewhere else. */
export function feedUrlProblem(value: unknown): string | null {
  if (typeof value !== 'string' || !value || value.length > 2048 || /[\s"'<>\\`]/.test(value)) return 'must be an https URL';
  let url: URL;
  try { url = new URL(value); } catch { return 'must be an https URL'; }
  const loopback = url.protocol === 'http:' && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if (url.protocol !== 'https:' && !loopback) return 'must be an https URL (http only on a loopback address)';
  if (url.username || url.password) return 'must not carry credentials';
  if (url.hash) return 'must not carry a fragment';
  return null;
}

/** Validate the two config blocks in place (config/instance.ts calls this). */
export function validateUpdatesConfig(updates: unknown, install: unknown): void {
  const u = updates as Record<string, unknown> | null;
  if (!u || typeof u !== 'object' || Array.isArray(u)) throw new Error('updates must be an object');
  for (const key of Object.keys(u)) {
    if (!['check', 'channel', 'feedUrl'].includes(key)) throw new Error(`updates.${key} is not a known key (check, channel, feedUrl)`);
  }
  if (typeof u.check !== 'boolean') throw new Error('updates.check must be true or false');
  if (!(UPDATE_CHANNELS as readonly unknown[]).includes(u.channel)) throw new Error('updates.channel must be "stable" or "preview"');
  const problem = feedUrlProblem(u.feedUrl);
  if (problem) throw new Error(`updates.feedUrl ${problem}`);
  const i = install as Record<string, unknown> | null;
  if (!i || typeof i !== 'object' || Array.isArray(i)) throw new Error('install must be an object');
  for (const key of Object.keys(i)) {
    if (key !== 'route') throw new Error(`install.${key} is not a known key (route)`);
  }
  if (!(INSTALL_ROUTES as readonly unknown[]).includes(i.route)) throw new Error(`install.route must be one of ${INSTALL_ROUTES.join(', ')}`);
}

const RELEASE_NAME = /^(?=.{1,53}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?(?:\.[a-z0-9](?:[-a-z0-9]*[a-z0-9])?)*$/;
const DNS_LABEL = /^(?=.{1,63}$)[a-z0-9](?:[-a-z0-9]*[a-z0-9])?$/;
const CHART_VERSION = /^[0-9A-Za-z.+-]{1,64}$/;

function envBoolean(name: string, raw: string | undefined): boolean | undefined {
  const v = raw?.trim().toLowerCase();
  if (!v) return undefined;
  if (['1', 'true', 'on', 'yes'].includes(v)) return true;
  if (['0', 'false', 'off', 'no'].includes(v)) return false;
  throw new Error(`${name} must be true or false`);
}

/** The settings in force. Environment values win over instance.json, except
 *  that either one can turn the check off. A malformed value is refused, so a
 *  mistyped setting fails at boot instead of leaving the default in force. */
export function resolveUpdateSettings(config: { updates: UpdatesConfig; install: InstallConfig }, env: NodeJS.ProcessEnv = process.env): UpdateSettings {
  const check = envBoolean('LW_UPDATES_CHECK', env.LW_UPDATES_CHECK);
  const channel = env.LW_UPDATES_CHANNEL?.trim() || config.updates.channel;
  if (!(UPDATE_CHANNELS as readonly string[]).includes(channel)) throw new Error('LW_UPDATES_CHANNEL must be "stable" or "preview"');
  const feedUrl = env.LW_UPDATES_FEED_URL?.trim() || config.updates.feedUrl;
  const problem = feedUrlProblem(feedUrl);
  if (problem) throw new Error(`LW_UPDATES_FEED_URL ${problem}`);
  const route = env.LW_INSTALL_ROUTE?.trim() || config.install.route;
  if (!(INSTALL_ROUTES as readonly string[]).includes(route)) throw new Error(`LW_INSTALL_ROUTE must be one of ${INSTALL_ROUTES.join(', ')}`);
  const pick = (value: string | undefined, pattern: RegExp) => {
    const v = value?.trim();
    return v && pattern.test(v) ? v : null;
  };
  return {
    check: config.updates.check && check !== false,
    channel: channel as UpdateChannel,
    feedUrl: new URL(feedUrl).href,
    route: route as InstallRoute,
    release: {
      name: pick(env.LW_RELEASE_NAME, RELEASE_NAME),
      namespace: pick(env.LW_RELEASE_NAMESPACE, DNS_LABEL),
      fullname: pick(env.LW_RELEASE_FULLNAME, DNS_LABEL),
      chartVersion: pick(env.LW_CHART_VERSION, CHART_VERSION),
    },
  };
}
