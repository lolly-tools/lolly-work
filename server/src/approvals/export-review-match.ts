// SPDX-License-Identifier: MPL-2.0
/**
 * Does an approved file exist for these inputs? One answer for two callers: a server
 * render under `enforce.watermark: until-approved`, and a person's export bar asking
 * where their current inputs stand (POST /api/v1/approvals/match).
 *
 * The lookup is one indexed store query by digest (migration 0082), with no cache, so
 * every render reads the record as it stands and a decision takes effect on the next
 * render on every replica. A render only looks when the tool's rule asks it to.
 *
 * The match rests on input values the requesting app states. A member could send values
 * that do not match the file, so the PREVIEW mark is a signal for people, not a security
 * boundary. Values never reach this module: callers pass the digest alone.
 */
import type { IncomingMessage } from 'node:http';
import { readJson, sendError, sendJson, type createRouter } from '../api/router.ts';
import { evaluate, type Grant, type Role } from '../rbac/evaluate.ts';
import { artifactRelation } from './export-review.ts';
import { isTerminal, type Approval } from './engine.ts';
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';

/** What a template-variants approval names: the template and its version. */
export interface TemplateCovered { id: string; version: number }

/**
 * The key one approval of a template's variants matches (plans/82 M7): the
 * template's fixed inputs only, which are its own values minus the inputs the
 * programme may edit and minus those its company bindings fill. A partner cannot
 * change a fixed value (422 INPUT_LOCKED), so the key reduces to the template and
 * its version, and a new template version needs a new approval. Prices, headings,
 * logos and contacts vary freely under one decision.
 */
export function templateVariantDigest(template: TemplateCovered & { values: Record<string, unknown>; editable?: string[]; bindings?: Record<string, unknown> }): string {
  const open = new Set([...(template.editable ?? []), ...Object.keys(template.bindings ?? {})]);
  const fixed = Object.fromEntries(Object.entries(template.values).filter(([key]) => !open.has(key)));
  return sha256Hex(canonicalJson({ covers: 'template-variants', template: template.id, version: template.version, fixed }));
}

export interface ExportReviewKey { toolId: string; format: string; inputsDigest: string }

export interface ExportReviewLookup { listExportReviewsForInputs(key: ExportReviewKey): Promise<Approval[]> }

/** The one rule for what counts: approved, for this tool version, and not withdrawn.
 *  A file later removed by retention still counts, because the decision stands. */
export function approvedAmong(rows: Approval[], toolVersion: string): Approval | null {
  return rows.find(row => row.state === 'approved' && row.exportReview?.toolVersion === toolVersion
    && row.exportReview.removedBecause !== 'withdrawn') ?? null;
}

/** The approved request a server render with these inputs matches, or null. */
export async function approvedExportReview(store: ExportReviewLookup, key: ExportReviewKey & { toolVersion: string }): Promise<Approval | null> {
  return approvedAmong(await store.listExportReviewsForInputs(key), key.toolVersion);
}

export type ExportReviewMatchState = 'none' | 'in_review' | 'approved' | 'rejected' | 'changed';
export interface ExportReviewMatch {
  state: ExportReviewMatchState;
  approvalId?: string;
  fingerprint?: string;
  title?: string;
  decidedAt?: string;
}

const describe = (state: ExportReviewMatchState, approval: Approval): ExportReviewMatch => ({
  state, approvalId: approval.id, fingerprint: approval.exportReview!.fingerprint, title: approval.title,
  ...(isTerminal(approval.state) && approval.actions.length ? { decidedAt: approval.actions.at(-1)!.at } : {}),
});

/**
 * Where these inputs stand for one person, from requests they may read. `exact` holds
 * those with this tool, format and digest; `own` holds the person's own requests.
 * Approved beats in review beats rejected. `changed` means they have a request for this
 * tool and format under other inputs or an older tool version. A withdrawn request is
 * as if it was never made.
 */
export function exportReviewMatch(exact: Approval[], own: Approval[], key: { toolId: string; format: string; toolVersion: string }): ExportReviewMatch {
  const approved = approvedAmong(exact, key.toolVersion);
  if (approved) return describe('approved', approved);
  const current = exact.filter(row => row.exportReview?.toolVersion === key.toolVersion);
  const open = current.find(row => !isTerminal(row.state));
  if (open) return describe('in_review', open);
  const rejected = current.find(row => row.state === 'rejected');
  if (rejected) return describe('rejected', rejected);
  const earlier = own
    .filter(row => row.exportReview?.toolId === key.toolId && row.exportReview.format === key.format && row.state !== 'withdrawn')
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))[0];
  return earlier ? describe('changed', earlier) : { state: 'none' };
}

/** A match request's fields, or null. Format follows the render path's spelling. */
export function parseMatchRequest(value: unknown): { toolId: string; format: string; query: string } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const { toolId, format, query } = value as Record<string, unknown>;
  if (typeof toolId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(toolId)) return null;
  if (typeof format !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+.-]{0,23}$/.test(format)) return null;
  if (typeof query !== 'string') return null;
  const lower = format.toLowerCase();
  return { toolId, format: lower === 'jpeg' ? 'jpg' : lower, query };
}

interface MatchUser { id: string; groups: string[]; role: string }

export interface MatchRouteDeps<User extends MatchUser> {
  store: ExportReviewLookup & {
    listApprovals(filter: { createdBy: string }): Promise<Approval[]>;
    listGrants(): Promise<Grant[]>;
  };
  enabled: () => boolean;
  memberOf(req: IncomingMessage): Promise<User | null>;
  mayUse(user: User, toolId: string): Promise<boolean>;
  /** The server's own reading of the values; they go no further than this call. */
  readInputs(user: User, toolId: string, format: string, query: string): Promise<{ toolVersion: string | null; inputsDigest: string | null; inputsGap?: string }>;
}

/** POST /api/v1/approvals/match: a person's own requests plus anything they may read.
 *  No bytes, and the values are read once and not kept. */
export function registerExportReviewMatch<User extends MatchUser>(
  router: Pick<ReturnType<typeof createRouter>, 'add'>, deps: MatchRouteDeps<User>,
): void {
  router.add('POST', '/api/v1/approvals/match', async (req, res) => {
    const user = await deps.memberOf(req);
    if (!user) return sendError(res, 401, 'UNAUTHORIZED', 'sign in first');
    if (!deps.enabled()) return sendError(res, 404, 'NOT_FOUND', 'This instance does not take a file with a request.');
    const request = parseMatchRequest(await readJson(req));
    if (!request) return sendError(res, 400, 'INVALID_INPUT', 'A match needs toolId, format and query.');
    if (!await deps.mayUse(user, request.toolId)) return sendError(res, 403, 'FORBIDDEN', 'You cannot use this tool.');
    const inputs = await deps.readInputs(user, request.toolId, request.format, request.query);
    if (!inputs.toolVersion) return sendError(res, 404, 'NOT_FOUND', 'This instance does not serve that tool.');
    if (!inputs.inputsDigest) return sendError(res, 400, 'INVALID_INPUT', 'Those input values could not be read.');
    const key = { toolId: request.toolId, format: request.format, inputsDigest: inputs.inputsDigest };
    const [rows, own, grants] = await Promise.all([deps.store.listExportReviewsForInputs(key), deps.store.listApprovals({ createdBy: user.id }), deps.store.listGrants()]);
    const subject = { userId: user.id, groups: user.groups, role: user.role as Role };
    const readable = rows.filter(row => artifactRelation(row, user,
      evaluate(subject, 'approval.act', [`approval:${row.id}`, `chain:${row.chainId}`, row.subjectRef, '*'], grants)) !== null);
    sendJson(res, 200, exportReviewMatch(readable, own, { toolId: request.toolId, format: request.format, toolVersion: inputs.toolVersion }));
  });
}
