// SPDX-License-Identifier: MPL-2.0
/**
 * Nearby registry - the control-plane half of the browser "nearby" story
 * (OSS plans/110 §5, lolly-work plans/26 §8).
 *
 * A browser PWA cannot discover other devices on a network (no mDNS/multicast/raw
 * sockets - that is the Tauri shells' native advantage, OSS plans/110 §3). What an
 * INSTANCE can do for its browser members is far weaker but still useful: group the
 * members who are online right now by the network they appear to be on, so the
 * ceremony's invite flow can surface "people in your org, likely nearby" first.
 *
 * This is a SORTING HINT, never an identity claim, and the wording downstream must
 * say so: two members share a public IP when they are behind the same NAT, but CGNAT
 * puts strangers behind one address and a VPN puts colleagues behind different ones.
 * `near` means "same apparent address", nothing more.
 *
 * ── Why in-memory, ephemeral, and never in the store ────────────────────────────
 *
 * Presence is deliberately unpersisted across the whole collab subsystem (the room's
 * presence map dies with the room, and `rooms.ts` cannot even reach the store). This
 * registry keeps that invariant: it is a plain Map with a TTL, it holds nothing an
 * audit would want, and it is constructed only in the long-lived server process
 * (main.ts, beside the ws gateway). On Vercel there is no long-lived process - a POST
 * and a GET can land on different function instances - so the registry is simply
 * absent there and the routes answer 501 rather than lying with a half-populated list.
 *
 * ── Opt-in ──────────────────────────────────────────────────────────────────────
 *
 * A member is listed only after they explicitly turn themselves visible (the shell's
 * profile-side preference POSTs here). `setVisible` stamps the moment; entries older
 * than the TTL are swept lazily on read, so a member who closed the tab drops off on
 * their own. `clear` is the explicit "stop being visible".
 */

/** One visible member, as the caller sees them (never their address). */
export interface NearbyMemberView {
  userId: string;
  name: string;
  /** Same apparent public address as the caller - a hint, see the header. */
  near: boolean;
}

export interface NearbyRegistry {
  /** Mark a member visible (or refresh their stamp) with the address they appear on. */
  setVisible(userId: string, name: string, ip: string): void;
  /** Stop showing a member. */
  clear(userId: string): void;
  /** Visible members other than the caller, nearest first then by name. */
  list(callerUserId: string, callerIp: string): NearbyMemberView[];
  /** Live entry count (post-sweep) - for tests and any future metric. */
  size(): number;
}

interface Entry {
  name: string;
  ip: string;
  at: number;
}

/** 12 hours: long enough to span a working session, short enough that a stale entry
 *  from a closed laptop ages off the same day. */
export const NEARBY_TTL_MS = 12 * 60 * 60 * 1000;

export function createNearbyRegistry(opts?: { now?: () => number; ttlMs?: number }): NearbyRegistry {
  const now = opts?.now ?? Date.now;
  const ttl = opts?.ttlMs ?? NEARBY_TTL_MS;
  const entries = new Map<string, Entry>();

  function sweep(): void {
    const cutoff = now() - ttl;
    for (const [id, e] of entries) if (e.at < cutoff) entries.delete(id);
  }

  return {
    setVisible(userId, name, ip) {
      entries.set(userId, { name, ip, at: now() });
    },
    clear(userId) {
      entries.delete(userId);
    },
    list(callerUserId, callerIp) {
      sweep();
      const out: NearbyMemberView[] = [];
      for (const [userId, e] of entries) {
        if (userId === callerUserId) continue; // never list the caller to themselves
        out.push({ userId, name: e.name, near: e.ip === callerIp });
      }
      // Nearest first, then a stable alphabetical order within each band.
      out.sort((a, b) => (Number(b.near) - Number(a.near)) || a.name.localeCompare(b.name));
      return out;
    },
    size() {
      sweep();
      return entries.size;
    },
  };
}
