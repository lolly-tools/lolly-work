// SPDX-License-Identifier: MPL-2.0
import type { UserRecord } from '../../store/types.ts';
import type { PasskeyChallenge, PasskeyRecord, PasskeyStore } from './types.ts';
export function createMemoryPasskeys(user: (id: string) => UserRecord | undefined) {
  const keys = new Map<string, PasskeyRecord>(), challenges = new Map<string, PasskeyChallenge>();
  const active = (id: string, epoch: number) => { const u = user(id); return u && !u.disabledAt && u.sessionEpoch === epoch; };
  const store: PasskeyStore = {
    async putPasskeyChallenge(record) {
      const now = Date.now();
      for (const [id, r] of challenges) if (Date.parse(r.expiresAt) <= now) challenges.delete(id);
      if (challenges.size >= 5000 || challenges.has(record.id)) return false;
      challenges.set(record.id, structuredClone(record)); return true;
    },
    async consumePasskeyChallenge(id, nonceHash) {
      const r = challenges.get(id);
      if (!r || r.nonceHash !== nonceHash) return null;
      challenges.delete(id);
      return Date.parse(r.expiresAt) > Date.now() ? structuredClone(r) : null;
    },
    async listPasskeys(userId) { return [...keys.values()].filter(r => r.userId === userId).map(r => structuredClone(r)); },
    async getPasskey(id) { const r = keys.get(id); return r ? structuredClone(r) : null; },
    async registerPasskey(record, epoch) {
      if (!active(record.userId, epoch) || keys.has(record.id) || [...keys.values()].filter(r => r.userId === record.userId).length >= 10) return false;
      keys.set(record.id, structuredClone(record)); return true;
    },
    async advancePasskey(expected, nextCounter, backedUp, epoch) {
      const {id,counter}=expected, r = keys.get(id);
      if (!r || r.userId !== expected.userId || r.publicKey !== expected.publicKey || r.createdAt !== expected.createdAt || !active(r.userId, epoch) || r.counter !== counter || (counter !== 0 || nextCounter !== 0) && nextCounter <= counter) return false;
      keys.set(id, { ...r, counter: nextCounter, backedUp, lastUsedAt: new Date().toISOString() }); return true;
    },
    async removePasskey(id, userId, epoch) {
      if (!active(userId, epoch) || keys.get(id)?.userId !== userId) return false;
      return keys.delete(id);
    },
  };
  return { store, forgetUser(id: string) {
    for (const [key, r] of keys) if (r.userId === id) keys.delete(key);
    for (const [key, r] of challenges) if (r.userId === id) challenges.delete(key);
  } };
}
