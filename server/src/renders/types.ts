import type { ProductionRequest, ProductionReport } from '../render/production.ts';
import type { RenderEvidence, RenderIdentity } from '../render/evidence.ts';
import type { OutputInspection, OutputVerification } from '../render/output-inspection.ts';
import type { AutomationCallbackSummary } from '../store/types.ts';

/** Recoverable single-tool requests. Full dependency locking is plan 40's next slice. */
export interface RenderSpec {
  production?: ProductionRequest;
  verification?: OutputVerification;
  toolId: string;
  format: string;
  inputs: Record<string, unknown>;
  priority: number;
  maxAttempts: number;
  /** Where to send the signed callback when this request finishes. Part of the
   *  request hash, and left out of the render identity: where a result is
   *  announced says nothing about what was rendered. */
  callbackUrl?: string;
  /** Set only by the migration API, never read from a request: the record this render
   *  belongs to, so its webhook speaks that vendor's shape. Left out of the render
   *  identity, which hashes named fields. */
  compat?: { source: 'bannerbear-v5' | 'bannerbear-v2' | 'placid'; requestId: string };
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
  /** The request bound to what this attempt resolved, derived from the receipt above. */
  identity?: RenderIdentity;
  /** When output retention stopped serving these bytes. The record and receipt stay. */
  expiredAt?: string;
  /** When output retention removed the bytes. */
  purgedAt?: string;
  /** The partner the file was made for, as its credential records it (plans/82 M3):
   *  ids for the per-company counts, and the line an agent reads back. */
  partner?: { company?: string; programme?: string; line?: string };
}

export interface RenderFailure { code: string; message: string; inspection?: OutputInspection; production?: ProductionReport; productionAttempts?: ProductionReport[] }
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
  /** The batch an idempotency key already names, so a replay need not read its data source again. */
  findRenderBatchByKey(principal: string, key: string): Promise<RenderBatchRecord | null>;
  /** Atomically cancel unfinished children, preserving every terminal child. */
  cancelRenderBatch(id: string, principal: string): Promise<RenderBatchRecord | null>;
  /** Counts of renders made by these principals from `fromIso` (inclusive) to `toIso`
   *  (exclusive), by UTC day, tool, format, state and the company the output was made
   *  for (plans/82 M7). Counts only: never an input, a title or a file name. */
  renderUsage(principals: readonly string[], fromIso: string, toIso: string): Promise<RenderUsageRow[]>;
  /** Batches and their rows by principal and UTC day, in the same window. */
  renderBatchUsage(principals: readonly string[], fromIso: string, toIso: string): Promise<RenderBatchUsageRow[]>;
  /** Atomic insert; a principal/key collision returns the original immutable request. */
  insertRender(record: RenderRecord): Promise<{ record: RenderRecord; reused: boolean }>;
  /** The render an idempotency key already names, so a replay is known before it is counted. */
  findRenderByKey(principal: string, key: string): Promise<RenderRecord | null>;
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
  /** Queued renders by tool, for the queue signals on /metrics. `oldestClaimableAt`
   *  is the earliest `availableAt` among those a runner could claim now; a render
   *  waiting out a retry delay counts as queued but not as claimable. */
  renderQueue(): Promise<RenderQueueEntry[]>;
  /** The callback outbox entry of a render or batch, once it has one. */
  renderCallbackSummary(id: string): Promise<AutomationCallbackSummary | null>;
  /** Mark succeeded outputs that finished before `cutoff` as expired, oldest first,
   *  and return them. An output a delivery names is left alone. */
  expireRenderOutputs(cutoff: string, expiredAt: string, limit: number): Promise<RenderOutputExpiry[]>;
  /** Outputs marked before `markedBefore` whose bytes are still stored. A mark on an
   *  output that a delivery has since named is cleared here, and its bytes stay. */
  renderOutputsToPurge(markedBefore: string, limit: number): Promise<RenderOutputExpiry[]>;
  /** Record that an expired output's bytes are gone. */
  markRenderOutputPurged(id: string): Promise<void>;
}

export interface RenderOutputExpiry { id: string; ref: string; toolId: string; format: string }

export interface RenderUsageRow { principal: string; day: string; toolId: string; format: string; state: RenderRecord['state']; company: string | null; count: number }
export interface RenderBatchUsageRow { principal: string; day: string; batches: number; rows: number }

export interface RenderQueueEntry { toolId: string; queued: number; oldestClaimableAt: string | null }

/** A governed JSON or CSV source for a batch's rows (automation/bindings.ts).
 *  `keyField` names the column that holds each row's key and is not an input. */
export interface RenderBatchBinding {
  source: string;
  query?: Record<string, unknown>;
  as?: Record<string, unknown>;
  keyField?: string;
}

export interface RenderBatchSpec extends RenderSpec {
  rows: { key: string; inputs: Record<string, unknown> }[];
  /** Where the rows came from. They are read once, at submission, and kept in `rows`. */
  bind?: RenderBatchBinding;
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
  /** Fields the error body carries beside code and message, such as a budget's figures. */
  readonly detail?: Record<string, unknown>;
  /** Sent as Retry-After, for a refusal that a wait undoes. */
  readonly retryAfterSec?: number;
  constructor(code: string, status: number, message: string, detail?: Record<string, unknown>, retryAfterSec?: number) {
    super(message);
    this.code = code;
    this.status = status;
    this.name = 'RenderResourceError';
    if (detail) this.detail = detail;
    if (retryAfterSec !== undefined) this.retryAfterSec = retryAfterSec;
  }
}
