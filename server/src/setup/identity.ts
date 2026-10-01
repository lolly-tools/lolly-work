// SPDX-License-Identifier: MPL-2.0
import type { InstanceConfig } from '../config/instance.ts';

/** Test only the installed issuer; no draft endpoint, credential or redirect is accepted. */
export async function testIdentityDiscovery(config: InstanceConfig, fetchImpl: typeof fetch = fetch) {
  const checkedAt = new Date().toISOString();
  if (!config.idp.issuer || !config.idp.clientId) return { ok: false, checkedAt, message: 'Apply an OIDC issuer and registered client ID, restart, then run this test.' };
  try {
    const issuer = new URL(config.idp.issuer);
    if (!['https:', 'http:'].includes(issuer.protocol) || issuer.username || issuer.password || issuer.search || issuer.hash) throw new Error();
    const response = await fetchImpl(`${config.idp.issuer.replace(/\/+$/, '')}/.well-known/openid-configuration`, { redirect: 'error', signal: AbortSignal.timeout(10_000) });
    if (!response.ok || !response.body) throw new Error();
    const reader = response.body.getReader(); const chunks: Uint8Array[] = []; let size = 0;
    try {
      while (true) { const part = await reader.read(); if (part.done) break; size += part.value.length; if (size > 256 * 1024) throw new Error(); chunks.push(part.value); }
    } finally { await reader.cancel().catch(() => {}); }
    const doc = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>;
    if (typeof doc.issuer !== 'string' || doc.issuer.replace(/\/+$/, '') !== config.idp.issuer.replace(/\/+$/, '')) throw new Error();
    for (const key of ['authorization_endpoint', 'token_endpoint', 'jwks_uri']) {
      if (typeof doc[key] !== 'string') throw new Error();
      const url = new URL(doc[key]);
      if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.hash
        || (issuer.protocol === 'https:' && url.protocol !== 'https:')) throw new Error();
    }
    return { ok: true, checkedAt, message: 'The installed issuer answered discovery with matching identity endpoints. Complete a real sign-in to test the registration and owner groups.' };
  } catch { return { ok: false, checkedAt, message: 'Discovery failed, timed out or named invalid endpoints. Check issuer, network access and provider registration; no sign-in was attempted.' }; }
}
