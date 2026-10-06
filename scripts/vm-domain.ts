// SPDX-License-Identifier: MPL-2.0
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/** The VM kit serves one HTTPS hostname on port 443, from the instance configuration. */
export function vmDomain(configText: string): string {
  let config: { instance?: { baseUrl?: unknown } };
  try { config = JSON.parse(configText); } catch { throw new Error('Cannot parse VM instance configuration.'); }
  const value = config?.instance?.baseUrl;
  const message = 'VM instance.baseUrl must be a bare HTTPS origin on port 443 with a DNS hostname.';
  if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (url.protocol !== 'https:' || url.username || url.password || url.port || url.pathname !== '/'
    || url.search || url.hash || (value !== url.origin && value !== url.origin + '/') || url.hostname.length > 253
    || !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/i.test(url.hostname)
    || url.hostname.split('.').some(label => label.length > 63)) throw new Error(message);
  return url.hostname.toLowerCase();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    if (process.argv.length !== 3) throw new Error('Usage: node scripts/vm-domain.ts <instance.json>');
    console.log(vmDomain(readFileSync(process.argv[2]!, 'utf8')));
  } catch (error) {
    console.error(error instanceof Error ? error.message : 'Cannot read VM instance configuration.');
    process.exitCode = 1;
  }
}
