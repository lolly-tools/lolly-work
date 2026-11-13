// SPDX-License-Identifier: MPL-2.0
/**
 * Writing a change to an approval that is already stored.
 *
 * Two people can decide the same request at the same moment: one approves, the
 * other rejects, and both read the approval before either wrote. A plain upsert
 * keeps whichever write came last, while the asset, delivery or file the first
 * decision settled has already moved. So every change is written against the
 * revision it was read at, and only one of two writes from the same read is
 * kept. The other caller is told, and settles nothing.
 */
import { approvalRevision, type Approval } from './engine.ts';

/** The store half this module needs, so tests and narrow callers can pass less than a Store. */
export interface ApprovalWriter {
  casApproval(next: Approval, expectedRevision: number): Promise<boolean>;
}

/** The code a route answers with when another write got there first. */
export const APPROVAL_CHANGED = 'APPROVAL_CHANGED';
export const APPROVAL_CHANGED_MESSAGE = 'Someone else acted on this request at the same time. Reopen it to see where it stands.';

/**
 * Store `next` as the change that follows `read`, the approval as it was read.
 * Returns the approval as stored, with its new revision, or null when the
 * stored approval is no longer the one `read` describes (or is gone). Nothing
 * is written in that case, so the caller must not settle anything either.
 */
export async function replaceApproval(store: ApprovalWriter, read: Approval, next: Approval): Promise<Approval | null> {
  const expected = approvalRevision(read);
  const stored: Approval = { ...next, revision: expected + 1 };
  return (await store.casApproval(stored, expected)) ? stored : null;
}
