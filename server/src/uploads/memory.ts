// SPDX-License-Identifier: MPL-2.0
/** In-memory scoped uploads for the memory store; the same rules as postgres.ts. */
import { liveUpload, uploadCharge, type UploadRecord, type UploadStore } from './scoped.ts';

export function createMemoryUploadStore(): UploadStore {
  const uploads = new Map<string, UploadRecord>();
  const newestFirst = (a: UploadRecord, b: UploadRecord): number => b.createdAt.localeCompare(a.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return {
    async reserveUpload(upload, limits) {
      if (uploads.has(upload.id)) return 'refused';
      const now = Date.now();
      let ownerBytes = 0, instanceBytes = 0, pending = 0;
      for (const u of uploads.values()) {
        if (!liveUpload(u, now)) continue;
        instanceBytes += uploadCharge(u);
        if (u.owner !== upload.owner) continue;
        ownerBytes += uploadCharge(u);
        if (!u.ready) pending++;
      }
      const charge = uploadCharge(upload);
      if (pending >= limits.maxPending) return 'pending';
      if (ownerBytes + charge > limits.ownerBudgetBytes) return 'owner-budget';
      if (instanceBytes + charge > limits.instanceBudgetBytes) return 'instance-budget';
      uploads.set(upload.id, structuredClone(upload));
      return 'reserved';
    },
    async getUpload(id) {
      const u = uploads.get(id);
      return u ? structuredClone(u) : null;
    },
    async listUploads(owner, limit, filter = {}) {
      const now = Date.now(), { scope, ready, before } = filter;
      // After `before` in newest-first order: older, or as old with a later id.
      const after = (u: UploadRecord): boolean => !before || u.createdAt < before.createdAt || (u.createdAt === before.createdAt && u.id > before.id);
      return [...uploads.values()]
        .filter((u) => u.owner === owner && liveUpload(u, now) && (scope === undefined || u.scope === scope) && (ready === undefined || u.ready === ready) && after(u))
        .sort(newestFirst).slice(0, limit).map((u) => structuredClone(u));
    },
    async listUploadsToRemove(filter, limit) {
      const cutoff = filter.expiredBy === undefined ? undefined : Date.parse(filter.expiredBy);
      return [...uploads.values()]
        .filter((u) => (filter.owner === undefined || u.owner === filter.owner) && (cutoff === undefined || Date.parse(u.expiresAt) <= cutoff))
        .sort((a, b) => a.expiresAt.localeCompare(b.expiresAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
        .slice(0, limit).map((u) => structuredClone(u));
    },
    async uploadUsage(owner) {
      const now = Date.now();
      let ownerBytes = 0, instanceBytes = 0;
      for (const u of uploads.values()) {
        if (!liveUpload(u, now)) continue;
        instanceBytes += uploadCharge(u);
        if (u.owner === owner) ownerBytes += uploadCharge(u);
      }
      return { ownerBytes, instanceBytes };
    },
    async touchUpload(id, expiresAt) {
      const u = uploads.get(id);
      if (!u || !liveUpload(u)) return false;
      if (!u.ready && Date.parse(expiresAt) > Date.parse(u.expiresAt)) u.expiresAt = new Date(expiresAt).toISOString();
      return true;
    },
    async completeUpload(id, expiresAt) {
      const u = uploads.get(id);
      if (!u || !liveUpload(u)) return false;
      if (!u.ready) { u.ready = true; u.expiresAt = new Date(expiresAt).toISOString(); }
      return true;
    },
    async deleteUpload(id) {
      return uploads.delete(id);
    },
  };
}
