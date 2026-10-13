// SPDX-License-Identifier: MPL-2.0
import type { OidcLogoutStore } from './oidc-logout.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { GUEST_COOKIE, parseCookies, readPrincipal, type Principal } from './sessions.ts';

export function localSessionKey(principal: Principal): string | null {
  const id = principal.kind === 'member' ? principal.user.revocationId : principal.guest.revocationId;
  if (!id) return null;
  return sha256Hex(JSON.stringify(['local-session', principal.kind, id]));
}

/** Clear both local cookie sessions without revoking another device's session. */
export async function revokeBrowserSessions(store: OidcLogoutStore, cookie: string | undefined, keys: string | readonly string[]): Promise<void> {
  const member = readPrincipal(cookie, keys);
  const guestToken = parseCookies(cookie)[GUEST_COOKIE];
  const guest = guestToken ? readPrincipal(`${GUEST_COOKIE}=${guestToken}`, keys) : null;
  const sessionKeys = new Set([member, guest].flatMap(principal => principal ? [localSessionKey(principal)].filter((key): key is string => !!key) : []));
  for (const key of sessionKeys) await store.recordOidcLogout({ replayKey: key, targetKey: key, iat: Math.floor(Date.now() / 1000) });
}
