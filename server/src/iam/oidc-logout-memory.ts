// SPDX-License-Identifier: MPL-2.0
import { sessionLogoutKeys, type OidcLogoutStore } from './oidc-logout.ts';
export function createMemoryOidcLogout(): OidcLogoutStore {
  const events = new Map<string, number>();
  const targets = new Map<string, number>();
  return {
    async recordOidcLogout(e) {
      const now = Date.now() / 1000;
      for (const [key, iat] of events) if (iat < now - 600) events.delete(key);
      for (const [key, iat] of targets) if (iat < now - 31 * 86400) targets.delete(key);
      if (events.has(e.replayKey)) return false;
      events.set(e.replayKey, e.iat);
      targets.set(e.targetKey, Math.max(targets.get(e.targetKey) ?? 0, e.iat));
      return true;
    },
    async oidcSessionRevoked(s) { return sessionLogoutKeys(s).some(k => targets.has(k)); },
    async localSessionRevoked(key) { return (targets.get(key) ?? 0) > Date.now() / 1000 - 31 * 86400; },
  };
}
