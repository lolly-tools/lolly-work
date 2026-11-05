// SPDX-License-Identifier: MPL-2.0
/**
 * The seam between an approved request and the engine that writes the record into the
 * file's Content Credentials. Work adds no credential logic of its own: it hands the
 * engine the reviewed bytes and its signing identity, and keeps what comes back only
 * when the engine reports a readback confirmed it.
 *
 * PINNED ENGINE. `recordApprovalInCredential` arrives with the engine's approval record
 * (lolly `feat/approval-in-credentials`). An engine without it answers
 * `engine-unsupported` here, so the capability stays off, the dialog offers nothing and
 * an approved download stays the reviewed bytes. Re-pinning turns this on with no code
 * change here.
 */
import { loadEngine } from '../render/contract.ts';
import type { LoadedSigner } from '../render/c2pa-signer.ts';

export type RecorderUnavailable = 'no-signing-identity' | 'engine-unsupported';

export type RecorderOutcome =
  | { status: 'recorded'; bytes: Uint8Array; sha256: string }
  | { status: 'not-recorded'; reason: string; detail?: string };

export interface ApprovalRecorder {
  /** Why this server cannot record an approval in a file, or null when it can. */
  unavailable(): Promise<RecorderUnavailable | null>;
  record(reviewed: Uint8Array, format: string, facts: { approvalId: string; decidedAt: string }): Promise<RecorderOutcome>;
}

/** The engine call this seam needs, read off whatever engine is mounted. */
type RecordFn = (bytes: Uint8Array, format: string, opts: { approvalId: string; decidedAt: string; signer: LoadedSigner; claimGenerator?: string }) => Promise<RecorderOutcome>;

export function createApprovalRecorder(deps: {
  signer(): Promise<LoadedSigner | null>;
  /** The engine to use. Tests name one; the server uses the pinned one. */
  engine?: () => Promise<unknown>;
}): ApprovalRecorder {
  const engineCall = async (): Promise<RecordFn | null> => {
    const engine = await (deps.engine ?? loadEngine)() as { recordApprovalInCredential?: unknown };
    return typeof engine.recordApprovalInCredential === 'function' ? engine.recordApprovalInCredential as RecordFn : null;
  };
  const self: ApprovalRecorder = {
    async unavailable() {
      if (!await engineCall()) return 'engine-unsupported';
      return await deps.signer() ? null : 'no-signing-identity';
    },
    async record(reviewed, format, facts) {
      const write = await engineCall();
      if (!write) return { status: 'not-recorded', reason: 'engine-unsupported' };
      const signer = await deps.signer();
      if (!signer) return { status: 'not-recorded', reason: 'no-signing-identity' };
      return write(reviewed, format, { ...facts, signer, ...(signer.claimGenerator ? { claimGenerator: signer.claimGenerator } : {}) });
    },
  };
  return self;
}
