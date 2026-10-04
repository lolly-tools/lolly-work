// SPDX-License-Identifier: MPL-2.0
import { randomUUID } from 'node:crypto';
import { CANVAS_CLAIM_TTL_MS, claimCoversOp, claimsOverlap } from '@lolly-tools/core/canvas-interaction-v1';
import type { CanvasClaim, CanvasClaimTarget, CanvasPreview } from '@lolly-tools/core/canvas-interaction-v1';
import type { CanvasOp } from '@lolly-tools/core/canvas-op-v1';

export type ClaimAnswer = { claim: CanvasClaim } | { reason: string; blockedBy?: string };
interface Seat { id: string; name: string; role: 'writer' | 'observer' }

/** Room-local leases. Authentication belongs to the gateway; these never reach storage. */
export class CanvasClaims {
  private readonly claims = new Map<string, CanvasClaim>();
  private readonly changed: (claims: CanvasClaim[]) => void;
  private readonly now: () => number;
  constructor(changed: (claims: CanvasClaim[]) => void, now = Date.now) { this.changed = changed; this.now = now; }
  list(): CanvasClaim[] { this.expire(); return [...this.claims.values()]; }
  expire(): void {
    let changed = false;
    for (const [id, claim] of this.claims) if (claim.expiresAt <= this.now()) { this.claims.delete(id); changed = true; }
    if (changed) this.publish();
  }
  acquire(seat: Seat, target: CanvasClaimTarget): ClaimAnswer {
    this.expire();
    if (seat.role !== 'writer') return { reason: 'view-only' };
    for (const claim of this.claims.values()) {
      if (claimsOverlap(claim.target, target)) return { reason: 'claimed', blockedBy: claim.name };
    }
    if ([...this.claims.values()].filter(claim => claim.owner === seat.id).length >= 2 || this.claims.size >= 20)
      return { reason: 'claim-limit' };
    const claim = { id: randomUUID(), owner: seat.id, name: seat.name, target, expiresAt: this.now() + CANVAS_CLAIM_TTL_MS };
    this.claims.set(claim.id, claim); this.publish();
    return { claim };
  }
  renew(seat: Seat, id: string): ClaimAnswer {
    this.expire();
    const old = this.claims.get(id);
    if (!old || old.owner !== seat.id || seat.role !== 'writer') return { reason: 'claim-lost' };
    const claim = { ...old, expiresAt: this.now() + CANVAS_CLAIM_TTL_MS };
    this.claims.set(id, claim); this.publish();
    return { claim };
  }
  release(owner: string, id?: string): void {
    let changed = false;
    for (const [key, claim] of this.claims) if (claim.owner === owner && (id === undefined || id === key)) {
      this.claims.delete(key); changed = true;
    }
    if (changed) this.publish();
  }
  clear(): void { if (this.claims.size) { this.claims.clear(); this.publish(); } }
  allows(owner: string, ops: readonly CanvasOp[], token?: string): boolean {
    this.expire();
    if (token && this.claims.get(token)?.owner !== owner) return false;
    return !ops.some(op => [...this.claims.values()].some(claim => claim.owner !== owner && claimCoversOp(claim.target, op)));
  }
  preview(owner: string, preview: CanvasPreview): boolean {
    this.expire();
    const claim = this.claims.get(preview.claimId);
    return claim?.owner === owner && claim.target.kind === 'transform' && claim.target.collection === preview.collection
      && preview.objects.every(row => claim.target.ids.includes(row.id));
  }
  removed(ops: readonly CanvasOp[]): void {
    let changed = false;
    for (const [id, claim] of this.claims) if (ops.some(op => op.k === 'remove'
      && op.col === claim.target.collection && claim.target.ids.includes(op.id))) {
      this.claims.delete(id); changed = true;
    }
    if (changed) this.publish();
  }
  private publish(): void { this.changed([...this.claims.values()]); }
}
