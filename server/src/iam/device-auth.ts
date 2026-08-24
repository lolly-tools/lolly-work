/**
 * Device-code sign-in (plans/34 wave 4; store-backed in plans/35 wave 5) -
 * the named replacement for pasting a browser cookie into `lw login`, and the
 * sign-in path a native shell uses against a gated instance without embedding
 * a webview.
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
 * Codes are STORE rows (device_codes, migration 0026), so any replica answers
 * the poll, HA needs no sticky sessions, and serverless deploys have the flow
 * too - the original in-memory registry (the nearby precedent) was
 * single-replica and answered 501 elsewhere. The single-read claim - an
 * approved code hands out its session exactly once - is the store's atomic
 * delete-returning; a replayed deviceCode reads as expired.
 */
import { randomBytes } from 'node:crypto';
import type { SessionUser } from './sessions.ts';
import type { Store } from '../store/types.ts';

/** No I/L/O/0/1 - the code is read off one screen and typed into another. */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_LEN = 8;
export const DEVICE_CODE_TTL_SEC = 600;
export const DEVICE_POLL_INTERVAL_SEC = 5;
/** Pending-request ceiling - a memory/table bound, far above any honest use. */
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

export interface DeviceAuth {
  /** Start a flow. Null when the pending ceiling is hit (the route answers 429). */
  request(clientTag?: string): Promise<{ deviceCode: string; userCode: string; expiresIn: number; interval: number } | null>;
  /** The pending request behind a user code - what /activate renders. */
  describe(userCode: string): Promise<DeviceAuthPending | null>;
  /** Bind the approving person's session identity to the pending code. */
  approve(userCode: string, user: SessionUser): Promise<boolean>;
  deny(userCode: string): Promise<boolean>;
  /** The device's poll. 'approved' is returned exactly once - the row is
   *  consumed with it, so a replayed deviceCode reads as expired. */
  claim(deviceCode: string): Promise<DeviceClaim>;
  /** Pending requests, oldest first - the console's refuse-a-surprise list. */
  pending(): Promise<DeviceAuthPending[]>;
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

export function createDeviceAuth(store: Store, now: () => number = Date.now): DeviceAuth {
  const toPending = (r: { userCode: string; clientTag?: string; createdAt: string }): DeviceAuthPending =>
    ({ userCode: r.userCode, ...(r.clientTag ? { clientTag: r.clientTag } : {}), createdAt: r.createdAt });

  return {
    async request(clientTag) {
      if ((await store.listPendingDeviceCodes()).length >= MAX_PENDING) return null;
      const rec = {
        deviceCode: randomBytes(24).toString('base64url'),
        userCode: code(),
        ...(clientTag ? { clientTag: clientTag.slice(0, 120) } : {}),
        status: 'pending' as const,
        createdAt: new Date(now()).toISOString(),
        expiresAt: new Date(now() + DEVICE_CODE_TTL_SEC * 1000).toISOString(),
      };
      await store.putDeviceCode(rec);
      return { deviceCode: rec.deviceCode, userCode: rec.userCode, expiresIn: DEVICE_CODE_TTL_SEC, interval: DEVICE_POLL_INTERVAL_SEC };
    },
    async describe(userCode) {
      const rec = await store.getPendingDeviceCode(normalizeUserCode(userCode));
      return rec ? toPending(rec) : null;
    },
    async approve(userCode, user) {
      return store.settleDeviceCode(normalizeUserCode(userCode), 'approved', user as unknown as Record<string, unknown>);
    },
    async deny(userCode) {
      return store.settleDeviceCode(normalizeUserCode(userCode), 'denied');
    },
    async claim(deviceCode) {
      const r = await store.claimDeviceCode(deviceCode);
      if (r.status === 'approved') return { status: 'approved', user: r.userPayload as unknown as SessionUser };
      return { status: r.status };
    },
    async pending() {
      return (await store.listPendingDeviceCodes()).map(toPending);
    },
  };
}
