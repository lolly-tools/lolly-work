/**
 * Device-code sign-in (plans/34 wave 4) - the named replacement for pasting a
 * browser cookie into `lw login`, and the sign-in path a native shell uses
 * against a gated instance without embedding a webview.
 *
 * The shape is RFC 8628's, with this instance's session as the artifact: a
 * device asks for a code pair, a person who is ALREADY signed in in a browser
 * confirms the short code at /activate, and the device's next poll collects an
 * ordinary session cookie minted for that person. The flow never touches IdP
 * credentials itself - the approving browser session is the whole authority -
 * and approval deliberately lives on the typed-code page, not in the console:
 * binding YOUR identity to a device is a personal act, so the person types the
 * code; the console only ever refuses (deny), never approves on your behalf.
 *
 * In-memory by the same reasoning as collab/nearby.ts: pending codes cannot
 * span function instances, so main.ts injects a registry on the long-lived
 * server and the Vercel path leaves it undefined - the routes answer 501 there
 * rather than a flow that works only when the load balancer feels like it.
 */
import { randomBytes } from 'node:crypto';
import type { SessionUser } from './sessions.ts';

/** No I/L/O/0/1 - the code is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
export const DEVICE_CODE_TTL_SEC = 600;
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** Pending-request ceiling - a memory bound, far above any honest use. */
const MAX_PENDING = 100;

export interface DeviceAuthPending {
  userCode: string;
  /** The requesting client's X-Lolly-Client tag, shown verbatim to the person
   *  approving so they can recognise (or refuse) what is asking. */
  clientTag?: string;
  createdAt: string;
}

export type DeviceClaim =
  | { status: 'pending' | 'denied' | 'expired' }
  | { status: 'approved'; user: SessionUser };

export interface DeviceAuthRegistry {
  /** Start a flow. Null when the pending ceiling is hit (the route answers 429). */
  request(clientTag?: string): { deviceCode: string; userCode: string; expiresIn: number; interval: number } | null;
  /** The pending request behind a user code - what /activate renders. */
  describe(userCode: string): DeviceAuthPending | null;
  /** Bind the approving person's session identity to the pending code. */
  approve(userCode: string, user: SessionUser): boolean;
  deny(userCode: string): boolean;
  /** The device's poll. 'approved' is returned exactly once - the code is
   *  consumed with it, so a replayed deviceCode reads as expired. */
  claim(deviceCode: string): DeviceClaim;
  /** Pending requests, oldest first - the console's refuse-a-surprise list. */
  pending(): DeviceAuthPending[];
}

interface Row {
  deviceCode: string;
  userCode: string;
  clientTag?: string;
  createdAt: number;
  expiresAt: number;
  status: 'pending' | 'denied' | 'approved';
  user?: SessionUser;
}

function code(): string {
  const bytes = randomBytes(CODE_LEN);
  let out = '';
  for (let i = 0; i < CODE_LEN; i++) out += CODE_ALPHABET[(bytes[i] as number) % CODE_ALPHABET.length];
  return `${out.slice(0, 4)}-${out.slice(4)}`;
}

/** Typed codes arrive however humans type them - case, spaces, a lost hyphen. */
export function normalizeUserCode(raw: string): string {
  const flat = raw.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return flat.length === CODE_LEN ? `${flat.slice(0, 4)}-${flat.slice(4)}` : raw.trim().toUpperCase();
}

export function createDeviceAuthRegistry(now: () => number = Date.now): DeviceAuthRegistry {
  const byDevice = new Map<string, Row>();
  const byUser = new Map<string, Row>();

  const drop = (row: Row): void => {
    byDevice.delete(row.deviceCode);
    byUser.delete(row.userCode);
  };
  const prune = (): void => {
    const t = now();
    for (const row of byDevice.values()) if (row.expiresAt <= t) drop(row);
  };
  const live = (row: Row | undefined): Row | null => (row && row.expiresAt > now() ? row : null);

  return {
    request(clientTag) {
      prune();
      if (byDevice.size >= MAX_PENDING) return null;
      const row: Row = {
        deviceCode: randomBytes(24).toString('base64url'),
        userCode: code(),
        ...(clientTag ? { clientTag: clientTag.slice(0, 120) } : {}),
        createdAt: now(),
        expiresAt: now() + DEVICE_CODE_TTL_SEC * 1000,
        status: 'pending',
      };
      byDevice.set(row.deviceCode, row);
      byUser.set(row.userCode, row);
      return { deviceCode: row.deviceCode, userCode: row.userCode, expiresIn: DEVICE_CODE_TTL_SEC, interval: DEVICE_POLL_INTERVAL_SEC };
    },
    describe(userCode) {
      const row = live(byUser.get(normalizeUserCode(userCode)));
      if (!row || row.status !== 'pending') return null;
      return { userCode: row.userCode, ...(row.clientTag ? { clientTag: row.clientTag } : {}), createdAt: new Date(row.createdAt).toISOString() };
    },
    approve(userCode, user) {
      const row = live(byUser.get(normalizeUserCode(userCode)));
      if (!row || row.status !== 'pending') return false;
      row.status = 'approved';
      row.user = user;
      return true;
    },
    deny(userCode) {
      const row = live(byUser.get(normalizeUserCode(userCode)));
      if (!row || row.status !== 'pending') return false;
      row.status = 'denied';
      return true;
    },
    claim(deviceCode) {
      prune();
      const row = live(byDevice.get(deviceCode));
      if (!row) return { status: 'expired' };
      if (row.status === 'pending') return { status: 'pending' };
      drop(row); // denied and approved are both single-read
      if (row.status === 'denied' || !row.user) return { status: 'denied' };
      return { status: 'approved', user: row.user };
    },
    pending() {
      prune();
      return [...byDevice.values()]
        .filter((r) => r.status === 'pending')
        .sort((a, b) => a.createdAt - b.createdAt)
        .map((r) => ({ userCode: r.userCode, ...(r.clientTag ? { clientTag: r.clientTag } : {}), createdAt: new Date(r.createdAt).toISOString() }));
    },
  };
}
