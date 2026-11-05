// SPDX-License-Identifier: MPL-2.0
/** Which URLs this instance sends signed callbacks to: its own notify webhook,
 *  exactly, and anything on an origin the configuration lists. An instance
 *  decision, never one a request can make for itself. */
import type { InstanceConfig } from '../config/instance.ts';

export function callbackUrlAllowed(config: Pick<InstanceConfig, 'notify' | 'automation'>, url: string): boolean {
  if (url === config.notify.webhook?.url) return true;
  let parsed: URL;
  try { parsed = new URL(url); } catch { return false; }
  return parsed.protocol === 'https:' && !parsed.username && !parsed.password
    && config.automation.callbacks.allowedOrigins.includes(parsed.origin);
}
