// SPDX-License-Identifier: MPL-2.0
/** One-use native socket credentials. Kept by the same process that owns live rooms. */
import { randomBytes } from 'node:crypto';

export const SOCKET_TICKET_PROTOCOL = 'lolly-collab-v1';
export const SOCKET_TICKET_PREFIX = 'lolly-ticket.';
export const SOCKET_TICKET_TTL_MS = 30_000;
const MAX_TICKETS = 1024;

export function createSocketTickets(now: () => number = Date.now) {
  const pending = new Map<string, { cookie: string; sessionId: string; expires: number }>();
  const sweep = (): void => { for (const [key, value] of pending) if (value.expires <= now()) pending.delete(key); };
  return {
    issue(cookie: string, sessionId: string): string | null {
      sweep();
      // Reconnects replace an unused ticket for the same member session and room.
      for (const [key, value] of pending) if (value.cookie === cookie && value.sessionId === sessionId) pending.delete(key);
      if (pending.size >= MAX_TICKETS) return null;
      const token = randomBytes(32).toString('hex');
      pending.set(token, { cookie, sessionId, expires: now() + SOCKET_TICKET_TTL_MS });
      return token;
    },
    consume(header: string | undefined, sessionId: string): string | null {
      sweep();
      const parts = header?.split(',').map(value => value.trim());
      if (parts?.length !== 2 || parts[0] !== SOCKET_TICKET_PROTOCOL || !parts[1]?.startsWith(SOCKET_TICKET_PREFIX)) return null;
      const token = parts[1].slice(SOCKET_TICKET_PREFIX.length);
      const record = pending.get(token);
      if (!record) return null;
      pending.delete(token);
      return record.sessionId === sessionId ? record.cookie : null;
    },
    clear(): void { pending.clear(); },
  };
}
