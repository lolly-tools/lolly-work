import type { RenderEvidence } from '../render/evidence.ts';

/** Recoverable single-tool requests. Full dependency locking is plan 40's next slice. */
export interface RenderSpec {
  toolId: string;
  format: string;
  inputs: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
}

export interface RenderResult {
  name: 'default';
  ref: string;
  mime: string;
  size: number;
  sha256: string;
  /** Pipeline cache identity, not a complete dependency snapshot. */
  cacheKey: string;
  /** Partial execution evidence, committed under the same lease as these bytes. */
  evidence?: RenderEvidence;
}

export interface RenderFailure { code: string; message: string }
export interface RenderRecord {
  id: string;
  principal: string;
  request: RenderSpec;
  requestHash: string;
  idempotencyKey?: string;
  retryOf?: string;
  state: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled';
  attempt: number;
  createdAt: string;
  updatedAt: string;
  availableAt: string;
  finishedAt?: string;
  leaseToken?: string;
  leaseUntil?: string;
  output?: RenderResult;
  error?: RenderFailure;
}

export type RenderSettlement =
  | { state: 'succeeded'; output: RenderResult }
  | { state: 'failed'; error: RenderFailure; retryAfterMs?: number };

export interface RenderStore {
  /** Parent and new children become visible together; successful children may be reused on retry. */
  insertRenderBatch(record: RenderBatchRecord): Promise<{ record: RenderBatchRecord; reused: boolean }>;
  /** Parent and child states are read from one consistent snapshot. */
  getRenderBatch(id: string, principal: string): Promise<RenderBatchRecord | null>;
  listRenderBatches(principal: string, limit: number, offset: number): Promise<RenderBatchRecord[]>;
  /** Atomically cancel unfinished children, preserving every terminal child. */
  cancelRenderBatch(id: string, principal: string): Promise<RenderBatchRecord | null>;
  /** Atomic insert; a principal/key collision returns the original immutable request. */
  insertRender(record: RenderRecord): Promise<{ record: RenderRecord; reused: boolean }>;
  getRender(id: string, principal: string): Promise<RenderRecord | null>;
  listRenders(principal: string, limit: number, offset: number): Promise<RenderRecord[]>;
  /** Claim queued/expired work, incrementing the fencing token/attempt atomically.
   * Exhausted expired attempts are settled as failed before claiming more work. */
  claimRender(leaseMs: number): Promise<RenderRecord | null>;
  heartbeatRender(id: string, token: string, leaseMs: number): Promise<boolean>;
  /** Only an unexpired current lease can publish an outcome. */
  settleRender(id: string, token: string, outcome: RenderSettlement): Promise<boolean>;
  /** Retain a terminal cancellation; completed output/history cannot be deleted here. */
  cancelRender(id: string, principal: string): Promise<RenderRecord | null>;
}

export interface RenderBatchSpec extends RenderSpec {
  rows: { key: string; inputs: Record<string, unknown> }[];
}

/** Immutable membership; status is derived from the durable child records. */
export interface RenderBatchRecord {
  id: string;
  principal: string;
  request: RenderBatchSpec;
  requestHash: string;
  idempotencyKey?: string;
  retryOf?: string;
  createdAt: string;
  rows: { key: string; render: RenderRecord }[];
}

export class RenderResourceError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, status: number, message: string) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'RenderResourceError';
  }
}
