// SPDX-License-Identifier: MPL-2.0
/**
 * Export review: an approval of one exact exported file. A person's app makes
 * the export it would have downloaded and sends the bytes by the parts protocol
 * (scope `approval-artifact`); creating the request moves those parts here, under
 * approval-artifact/<id>/<n>, and freezes the facts under one fingerprint. A
 * changed file is a new request, because nothing here can be rewritten.
 *
 * Who gets the bytes (mayReadArtifact): eligible reviewers and people who already
 * acted, at any time. The requester sees the facts and digest, and receives the
 * bytes only once the request is approved. A rejected or withdrawn request never
 * releases them. Work never watermarks the file.
 *
 * approvedArtifactBytes is the one way approved bytes leave. Keep it that way:
 * anything that changes what an approved download holds belongs in that function.
 * The frozen reviewed bytes never change. When the requester chose to, the instance
 * allows it and this server can sign, the approved file is those bytes plus a signed
 * credential update recording the approval (approval-recorder.ts): made once, kept
 * under its own parts and handed out unchanged after that. In every other case the
 * approved file is the reviewed bytes, and the record says why.
 *
 * The inputs digest (render/inputs-digest.ts) comes from values the requesting app
 * states, and those values are discarded. It says "these are the inputs the app
 * reported", never that the file was made from them.
 */
import type { BlobStore } from '../blobs/types.ts';
import { readBlobBody } from '../blobs/types.ts';
import { canonicalJson, deriveKey, hmac, macEquals, sha256Hex } from '../lib/crypto.ts';
import { UNSAFE_TEXT } from '../projects/files.ts';
import { removeTransferParts, sha256 as sha256Bytes, transferChunks, TRANSFER_MAX_BYTES, TRANSFER_PART_BYTES, type TransferPart, type TransferParts } from '../uploads/parts.ts';
import { uploadPartId, uploadParts, type UploadRecord } from '../uploads/scoped.ts';
import type { Approval } from './engine.ts';
import type { ApprovalRecorder } from './approval-recorder.ts';

const MIB = 1024 * 1024;

/** `policy.approvalArtifacts` (config/instance.ts validates it). */
export interface ApprovalArtifactPolicy {
  /** Whether a request can carry its file. Off, shells send the older request. */
  enabled: boolean;
  /** The largest file one request can carry. */
  maxFileBytes: number;
  /** Bytes all stored request files may hold. Over it: 413 APPROVAL_ARTIFACT_BUDGET. */
  instanceBudgetBytes: number;
  /** Days a rejected request keeps its file; 0 keeps it for as long as the record. */
  closedRetentionDays: number;
  /** Days an approved request keeps its file; 0 keeps it for as long as the record. */
  approvedRetentionDays: number;
  /** Whether a request may ask for the approval to be recorded in the approved file's
   *  Content Credentials. It also needs a signing identity and an engine that can. */
  recordInCredentials: boolean;
}
/** On by default, unlike general uploads: nothing is stored until an admin binds a
 *  chain to a tool and someone asks for a review, and the budget bounds what a
 *  request can add to the blob store. */
export const APPROVAL_ARTIFACT_DEFAULTS: Readonly<ApprovalArtifactPolicy> = {
  enabled: true, maxFileBytes: 64 * MIB, instanceBudgetBytes: 1024 * MIB, closedRetentionDays: 30, approvedRetentionDays: 0, recordInCredentials: true,
};
/** The largest file an update is written for. Signing holds the whole file in memory. */
export const APPROVAL_RECORD_MAX_BYTES = 128 * MIB;
/** Every part's checksum rides in the approval's jsonb doc, so a file this size is
 *  still a small record. */
export const APPROVAL_ARTIFACT_MAX_FILE_BYTES = Math.min(512 * MIB, TRANSFER_MAX_BYTES);

export function approvalArtifactPolicy(config: { policy?: { approvalArtifacts?: Partial<ApprovalArtifactPolicy> } }): ApprovalArtifactPolicy {
  return { ...APPROVAL_ARTIFACT_DEFAULTS, ...config.policy?.approvalArtifacts };
}

export type ArtifactPreview = 'image' | 'video' | 'audio' | 'pdf' | 'none';

/** What became of the approval record for one approved file. */
export type ApprovalCredentialRecord =
  | { state: 'recorded'; sha256: string; size: number; parts: TransferPart[]; settledAt: string }
  /** The approved file is the reviewed bytes. `reason` is a stable code: `opted-out`,
   *  `not-offered`, `instance-off`, `no-signing-identity`, `engine-unsupported`,
   *  `too-large`, or the engine's own (`no-route`, `no-credential`, `write-failed`,
   *  `readback-failed`, `artwork-changed`). */
  | { state: 'not-recorded'; reason: string; settledAt: string };

export interface ExportReviewSubject {
  apiVersion: 'work/export-review-v1';
  sha256: string;
  size: number;
  name: string;
  format: string;
  /** From this table and the file's own opening bytes, never from the client. */
  mediaType: string;
  preview: ArtifactPreview;
  toolId: string;
  /** The version this instance serves, or null when the tool is not in its pack. */
  toolVersion: string | null;
  /** Digest of the reported inputs under the render path's own normalisation, or null. */
  inputsDigest: string | null;
  /** `template-variants`: the request covers every file made from one version of a
   *  published template (plans/82 M7), so `inputsDigest` is the template's fixed
   *  inputs' and this file is one example. Absent: it covers this file's inputs. */
  covers?: 'template-variants';
  /** The template and version a template-variants request covers, with the
   *  template's name at that version, which the approval card reads out. */
  templateRef?: { id: string; version: number; name?: string };
  inputsGap?: 'values-not-sent' | 'values-unreadable' | 'tool-not-in-pack';
  sessionId?: string;
  /** What the requesting app reports about the file. */
  widthPx?: number;
  heightPx?: number;
  /** The person's choice at the request. Absent when the instance did not offer one. */
  recordInCredentials?: boolean;
  fingerprint: string;
  /** `service-token`: a token holding `approvals.request` asked about one of its own
   *  finished renders (plans/82 M7), and the bytes came from that render, not an upload. */
  origin: 'member-session' | 'agent-delegated' | 'service-token';
  frozenAt: string;
  /** Set once, when the approved file is settled. Outside the fingerprint: it records
   *  what happened after the decision the fingerprint binds. */
  credentialRecord?: ApprovalCredentialRecord;
  removedAt?: string;
  removedBecause?: 'withdrawn' | 'retention';
  /** The transfer manifest for reading the stored parts back. Never sent to clients. */
  parts: TransferPart[];
}

export interface ExportReviewRequest {
  uploadId: string;
  checksum: string;
  toolId: string;
  format: string;
  name?: string;
  /** The tool's current inputs as a URL-mode query. Read once, never stored. */
  query?: string;
  sessionId?: string;
  widthPx?: number;
  heightPx?: number;
  recordInCredentials?: boolean;
}

const positiveInt = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) <= 1_000_000;

/** A request's `exportReview`, or null. A digest or version named by the client is
 *  not read: the server works out both for itself. */
export function parseExportReview(value: unknown): ExportReviewRequest | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  if (typeof v.uploadId !== 'string' || !/^upl_[A-Za-z0-9_-]{1,64}$/.test(v.uploadId)) return null;
  if (typeof v.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(v.checksum)) return null;
  if (typeof v.toolId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(v.toolId)) return null;
  if (typeof v.format !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9+.-]{0,23}$/.test(v.format)) return null;
  const lower = v.format.toLowerCase();
  const out: ExportReviewRequest = { uploadId: v.uploadId, checksum: v.checksum, toolId: v.toolId, format: lower === 'jpeg' ? 'jpg' : lower };
  if (v.name !== undefined) {
    if (typeof v.name !== 'string' || !v.name.trim() || v.name.length > 200 || UNSAFE_TEXT.test(v.name)) return null;
    out.name = v.name.trim();
  }
  if (v.query !== undefined) {
    if (typeof v.query !== 'string') return null;
    out.query = v.query;
  }
  if (v.sessionId !== undefined) {
    if (typeof v.sessionId !== 'string' || !/^[A-Za-z0-9_:.-]{1,200}$/.test(v.sessionId)) return null;
    out.sessionId = v.sessionId;
  }
  for (const key of ['widthPx', 'heightPx'] as const) {
    if (v[key] === undefined) continue;
    if (!positiveInt(v[key])) return null;
    out[key] = v[key];
  }
  if (v.recordInCredentials !== undefined) {
    if (typeof v.recordInCredentials !== 'boolean') return null;
    out.recordInCredentials = v.recordInCredentials;
  }
  return out;
}

const ascii = (bytes: Uint8Array, from: number, to: number): string => Buffer.from(bytes.subarray(from, to)).toString('latin1');
const opensWith = (bytes: Uint8Array, ...lead: number[]): boolean => lead.every((byte, i) => bytes[i] === byte);
const isMp4Family = (b: Uint8Array): boolean => ascii(b, 4, 8) === 'ftyp';
/** Text, then an <svg root, allowing a BOM, an XML declaration and comments first. */
const isSvg = (b: Uint8Array): boolean => /^(?:﻿)?\s*(?:<\?xml[^>]*\?>\s*)?(?:<!--[\s\S]*?-->\s*|<!DOCTYPE[^>]*>\s*)*<svg[\s/>]/i.test(Buffer.from(b.subarray(0, 64 * 1024)).toString('utf8'));
const isZip = (b: Uint8Array): boolean => opensWith(b, 0x50, 0x4b, 0x03, 0x04) || opensWith(b, 0x50, 0x4b, 0x05, 0x06);

/** The formats whose opening bytes can be checked and whose media type this table
 *  states. Anything else is stored as opaque bytes and offers no preview. */
const FORMATS: Record<string, { mediaType: string; preview: ArtifactPreview; check: (b: Uint8Array) => boolean }> = {
  png: { mediaType: 'image/png', preview: 'image', check: b => opensWith(b, 0x89, 0x50, 0x4e, 0x47) },
  jpg: { mediaType: 'image/jpeg', preview: 'image', check: b => opensWith(b, 0xff, 0xd8, 0xff) },
  gif: { mediaType: 'image/gif', preview: 'image', check: b => ascii(b, 0, 4) === 'GIF8' },
  webp: { mediaType: 'image/webp', preview: 'image', check: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WEBP' },
  avif: { mediaType: 'image/avif', preview: 'image', check: isMp4Family },
  svg: { mediaType: 'image/svg+xml', preview: 'image', check: isSvg },
  pdf: { mediaType: 'application/pdf', preview: 'pdf', check: b => ascii(b, 0, 5) === '%PDF-' },
  mp4: { mediaType: 'video/mp4', preview: 'video', check: isMp4Family },
  mov: { mediaType: 'video/quicktime', preview: 'video', check: isMp4Family },
  webm: { mediaType: 'video/webm', preview: 'video', check: b => opensWith(b, 0x1a, 0x45, 0xdf, 0xa3) },
  mp3: { mediaType: 'audio/mpeg', preview: 'audio', check: b => ascii(b, 0, 3) === 'ID3' || opensWith(b, 0xff) },
  wav: { mediaType: 'audio/wav', preview: 'audio', check: b => ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 12) === 'WAVE' },
  zip: { mediaType: 'application/zip', preview: 'none', check: isZip },
};

/** What the file is, or null when its opening bytes contradict the named format. */
export function artifactMedia(format: string, head: Uint8Array): { mediaType: string; preview: ArtifactPreview } | null {
  const known = FORMATS[format];
  if (!known) return { mediaType: 'application/octet-stream', preview: 'none' };
  return known.check(head) ? { mediaType: known.mediaType, preview: known.preview } : null;
}

export const artifactPartId = (approvalId: string, n: number): string => `approval-artifact/${approvalId}/${n}`;

type Frozen = Omit<ExportReviewSubject, 'fingerprint' | 'parts' | 'origin' | 'frozenAt' | 'credentialRecord' | 'removedAt' | 'removedBecause' | 'apiVersion'>;

/** The fingerprint a reviewer's decision is bound to: the file and its stated facts. */
export function exportReviewFingerprint(facts: Frozen): string {
  return sha256Hex(canonicalJson({ apiVersion: 'work/export-review-v1', ...facts }));
}

/** The subject for this upload, with nothing written yet. Null when the file's own
 *  opening bytes contradict the format named for it. */
export async function describeExportReview(
  blobs: BlobStore, upload: UploadRecord, request: ExportReviewRequest,
  inputs: { toolVersion: string | null; inputsDigest: string | null; inputsGap?: ExportReviewSubject['inputsGap']; covers?: 'template-variants'; templateRef?: ExportReviewSubject['templateRef'] },
  origin: ExportReviewSubject['origin'], now: string,
): Promise<ExportReviewSubject | null> {
  const first = await blobs.get(uploadPartId(upload, 0));
  if (!first) return null;
  const head = await readBlobBody(first.body, TRANSFER_PART_BYTES);
  const media = artifactMedia(request.format, head);
  if (!media) return null;
  const facts: Frozen = {
    sha256: upload.checksum, size: upload.size, name: request.name ?? upload.name, format: request.format, ...media,
    toolId: request.toolId, toolVersion: inputs.toolVersion, inputsDigest: inputs.inputsDigest,
    ...(inputs.inputsGap ? { inputsGap: inputs.inputsGap } : {}),
    ...(inputs.covers && inputs.templateRef ? { covers: inputs.covers, templateRef: inputs.templateRef } : {}),
    ...(request.sessionId ? { sessionId: request.sessionId } : {}),
    ...(request.widthPx ? { widthPx: request.widthPx } : {}), ...(request.heightPx ? { heightPx: request.heightPx } : {}),
    ...(request.recordInCredentials !== undefined ? { recordInCredentials: request.recordInCredentials } : {}),
  };
  return { apiVersion: 'work/export-review-v1', ...facts, fingerprint: exportReviewFingerprint(facts), origin, frozenAt: now, parts: upload.parts };
}

/**
 * A service token's own finished render as the reviewed file (plans/82 M7). The
 * bytes are the render's output, already checked against its receipt, so there
 * is no upload round trip; the inputs digest is the one the render itself took,
 * so no gap is possible. Null when the format and the file's opening bytes
 * disagree.
 */
export function describeRenderReview(
  bytes: Uint8Array,
  facts: { toolId: string; format: string; name: string; toolVersion: string | null; inputsDigest: string | null },
  now: string,
): ExportReviewSubject | null {
  const media = artifactMedia(facts.format, bytes.subarray(0, TRANSFER_PART_BYTES));
  if (!media) return null;
  const parts: TransferPart[] = [];
  for (let at = 0; at < bytes.length; at += TRANSFER_PART_BYTES) {
    const chunk = bytes.subarray(at, Math.min(bytes.length, at + TRANSFER_PART_BYTES));
    parts.push({ size: chunk.length, checksum: sha256Bytes(chunk) });
  }
  const frozen: Frozen = {
    sha256: sha256Bytes(bytes), size: bytes.length, name: facts.name, format: facts.format, ...media,
    toolId: facts.toolId, toolVersion: facts.toolVersion, inputsDigest: facts.inputsDigest,
  };
  return { apiVersion: 'work/export-review-v1', ...frozen, fingerprint: exportReviewFingerprint(frozen), origin: 'service-token', frozenAt: now, parts };
}

/** Write a render's bytes as the approval's own parts, as an upload's are frozen. */
export async function freezeRenderBytes(blobs: BlobStore, bytes: Uint8Array, approvalId: string, subject: ExportReviewSubject): Promise<void> {
  try {
    for (let n = 0, at = 0; n < subject.parts.length; n++) {
      const part = subject.parts[n]!;
      await blobs.put(artifactPartId(approvalId, n), Buffer.from(bytes.subarray(at, at + part.size)), subject.mediaType, { size: part.size, sha256: part.checksum });
      at += part.size;
    }
  } catch (error) {
    await removeTransferParts({ blobs, partId: part => artifactPartId(approvalId, part) }, subject.parts.length);
    throw error;
  }
}

/** Copy the verified upload to the approval's own parts. A part that fails its
 *  digest stops the copy and takes back what was written. */
export async function freezeArtifactBytes(blobs: BlobStore, upload: UploadRecord, approvalId: string, subject: ExportReviewSubject): Promise<void> {
  let n = 0;
  try {
    for await (const chunk of transferChunks(uploadParts(blobs, upload))) {
      await blobs.put(artifactPartId(approvalId, n), Buffer.from(chunk), subject.mediaType, { size: subject.parts[n]!.size, sha256: subject.parts[n]!.checksum });
      n++;
    }
  } catch (error) {
    await removeTransferParts({ blobs, partId: part => artifactPartId(approvalId, part) }, subject.parts.length);
    throw error;
  }
}

function artifactTransfer(blobs: BlobStore, approval: Approval): TransferParts {
  const subject = approval.exportReview!;
  return { blobs, partId: n => artifactPartId(approval.id, n), manifest: { size: subject.size, checksum: subject.sha256, parts: subject.parts } };
}

export interface ArtifactFile { chunks: AsyncGenerator<Uint8Array>; size: number; sha256: string; mediaType: string; name: string }

/** The frozen bytes as reviewed, verified as they stream: a part or a whole file
 *  that fails its declared digest cuts the body short. */
export function reviewedArtifactBytes(blobs: BlobStore, approval: Approval): ArtifactFile {
  const subject = approval.exportReview!;
  return { chunks: transferChunks(artifactTransfer(blobs, approval)), size: subject.size, sha256: subject.sha256, mediaType: subject.mediaType, name: subject.name };
}

export interface ApprovedFileDeps {
  blobs: BlobStore;
  store: { getApproval(id: string): Promise<Approval | null>; putApproval(approval: Approval): Promise<void> };
  policy: ApprovalArtifactPolicy;
  recorder: ApprovalRecorder;
  /** Told once when a request's approved file is settled. */
  onSettled?(approval: Approval): void | Promise<void>;
}

const approvedPartId = (approvalId: string, sha256: string, n: number): string => `approval-artifact/${approvalId}/approved/${sha256.slice(0, 16)}/${n}`;

async function readReviewedBytes(blobs: BlobStore, approval: Approval): Promise<Buffer> {
  const out: Uint8Array[] = [];
  for await (const chunk of reviewedArtifactBytes(blobs, approval).chunks) out.push(chunk);
  return Buffer.concat(out);
}

/** Write an update's bytes as parts under a path of their own. Every part is verified
 *  as it is read back, the same as the reviewed file. */
async function storeApprovedParts(blobs: BlobStore, approvalId: string, bytes: Uint8Array, sha256: string): Promise<TransferPart[]> {
  const parts: TransferPart[] = [];
  for (let at = 0, n = 0; at < bytes.length; at += TRANSFER_PART_BYTES, n++) {
    const chunk = bytes.subarray(at, at + TRANSFER_PART_BYTES);
    const part = { size: chunk.length, checksum: sha256Bytes(chunk) };
    await blobs.put(approvedPartId(approvalId, sha256, n), Buffer.from(chunk), 'application/octet-stream', { size: part.size, sha256: part.checksum });
    parts.push(part);
  }
  return parts;
}

/** What the approved file should be, before anything is stored. */
async function settleRecord(deps: ApprovedFileDeps, approval: Approval): Promise<ApprovalCredentialRecord> {
  const subject = approval.exportReview!;
  const settledAt = new Date().toISOString();
  const skip = (reason: string): ApprovalCredentialRecord => ({ state: 'not-recorded', reason, settledAt });
  if (subject.recordInCredentials === false) return skip('opted-out');
  if (subject.recordInCredentials !== true) return skip('not-offered');
  if (!deps.policy.recordInCredentials) return skip('instance-off');
  const unavailable = await deps.recorder.unavailable();
  if (unavailable) return skip(unavailable);
  if (subject.size > APPROVAL_RECORD_MAX_BYTES) return skip('too-large');
  const reviewed = await readReviewedBytes(deps.blobs, approval);
  // The last action is the one that took the request to approved.
  const decidedAt = approval.actions.at(-1)?.at ?? settledAt;
  const outcome = await deps.recorder.record(reviewed, subject.format, { approvalId: approval.id, decidedAt });
  if (outcome.status !== 'recorded') {
    if (outcome.detail) console.error(`[approvals] the record for ${approval.id} was not written: ${outcome.reason}: ${outcome.detail}`);
    return skip(outcome.reason);
  }
  const parts = await storeApprovedParts(deps.blobs, approval.id, outcome.bytes, outcome.sha256);
  return { state: 'recorded', sha256: outcome.sha256, size: outcome.bytes.length, parts, settledAt };
}

const settling = new Map<string, Promise<Approval>>();

/**
 * Settle an approved request's file once, and return the request as stored. Called
 * when the decision is made and again by a download that finds it unsettled, which is
 * how a restart between the two recovers. One writer per process; a second replica
 * that lost the same narrow race reads the first record back and drops its own parts.
 */
export function settleApprovedFile(deps: ApprovedFileDeps, approval: Approval): Promise<Approval> {
  if (approval.state !== 'approved') throw new Error('only an approved request releases its file');
  if (approval.exportReview?.credentialRecord) return Promise.resolve(approval);
  const running = settling.get(approval.id);
  if (running) return running;
  const work = (async () => {
    const record = await settleRecord(deps, approval);
    const fresh = await deps.store.getApproval(approval.id) ?? approval;
    const winner = fresh.exportReview?.credentialRecord;
    if (winner) {
      if (record.state === 'recorded' && (winner.state !== 'recorded' || winner.sha256 !== record.sha256)) {
        await removeTransferParts({ blobs: deps.blobs, partId: n => approvedPartId(approval.id, record.sha256, n) }, record.parts.length);
      }
      return fresh;
    }
    const next: Approval = { ...fresh, exportReview: { ...fresh.exportReview!, credentialRecord: record } };
    await deps.store.putApproval(next);
    await deps.onSettled?.(next);
    return next;
  })().finally(() => settling.delete(approval.id));
  settling.set(approval.id, work);
  return work;
}

/** The bytes an approved request releases, and the only way they leave: the signed
 *  update once one is recorded, otherwise exactly the reviewed bytes. */
export async function approvedArtifactBytes(deps: ApprovedFileDeps, approval: Approval): Promise<ArtifactFile> {
  const settled = await settleApprovedFile(deps, approval);
  const subject = settled.exportReview!;
  const record = subject.credentialRecord;
  if (record?.state !== 'recorded') return reviewedArtifactBytes(deps.blobs, settled);
  const transfer: TransferParts = {
    blobs: deps.blobs, partId: n => approvedPartId(settled.id, record.sha256, n),
    manifest: { size: record.size, checksum: record.sha256, parts: record.parts },
  };
  return { chunks: transferChunks(transfer), size: record.size, sha256: record.sha256, mediaType: subject.mediaType, name: subject.name };
}

/** Who this person is to the file. `null` is the 404 that says nothing to anyone else. */
export function artifactRelation(
  approval: Approval, viewer: { id: string; groups: string[] }, mayAct: boolean,
): 'requester' | 'actor' | 'reviewer' | null {
  if (approval.createdBy === viewer.id) return 'requester';
  if (approval.actions.some(action => action.actor === viewer.id)) return 'actor';
  if (mayAct && approval.chain.steps.some(step => step.approvers.groups.some(group => viewer.groups.includes(group)))) return 'reviewer';
  return null;
}

/** The refusal a relation meets, or null. The requester waits for approval. */
export function artifactRefusal(approval: Approval, relation: 'requester' | 'actor' | 'reviewer'): { code: string; status: number; message: string } | null {
  if (approval.exportReview?.removedAt) return { code: 'ARTIFACT_REMOVED', status: 410, message: 'This request no longer holds its file.' };
  if (relation === 'requester' && approval.state !== 'approved') {
    return { code: 'ARTIFACT_NOT_RELEASED', status: 403, message: 'The file is released to you once this request is approved.' };
  }
  return null;
}

const reviewTokenKey = (secret: string): string => deriveKey(secret, 'lw/approval-artifact-review');
const reviewTokenBody = (approval: Approval, userId: string): string => `${approval.id}\n${approval.exportReview!.fingerprint}\n${userId}`;

/** Returned only with the bytes, so an approval shows this person fetched this
 *  file through this route. It records no state and proves nothing about anyone's
 *  attention: it stops a decision made from the JSON alone. */
export function artifactReviewToken(secret: string, approval: Approval, userId: string): string {
  return hmac(reviewTokenBody(approval, userId), reviewTokenKey(secret));
}
export function checkArtifactReviewToken(token: unknown, secrets: Array<string | undefined>, approval: Approval, userId: string): boolean {
  if (typeof token !== 'string' || !token || token.length > 128) return false;
  return secrets.some(secret => !!secret && macEquals(token, artifactReviewToken(secret, approval, userId)));
}

/** What a client sees of the subject: everything but the part table. */
export function exportReviewWire(approval: Approval) {
  const { parts: _parts, credentialRecord, ...subject } = approval.exportReview!;
  let record: Record<string, unknown> | undefined;
  if (credentialRecord?.state === 'recorded') {
    const { parts: _recordParts, ...facts } = credentialRecord;
    record = facts;
  } else if (credentialRecord) record = credentialRecord;
  return { ...subject, ...(record ? { credentialRecord: record } : {}), artifactUrl: `/api/v1/approvals/${encodeURIComponent(approval.id)}/artifact` };
}

/** Bytes every request still holding its file holds. A linear read, which request
 *  volume keeps small; the creating request pays for it, not a reader. */
export function heldArtifactBytes(approvals: Approval[]): number {
  return approvals.reduce((sum, a) => {
    if (!a.exportReview || a.exportReview.removedAt) return sum;
    const record = a.exportReview.credentialRecord;
    return sum + a.exportReview.size + (record?.state === 'recorded' ? record.size : 0);
  }, 0);
}

/** Take back the bytes and keep the record: id, facts and digest stay as evidence
 *  of what was reviewed. */
export async function removeArtifactBytes(
  blobs: BlobStore, approval: Approval, because: NonNullable<ExportReviewSubject['removedBecause']>, now: string,
): Promise<Approval> {
  const subject = approval.exportReview!;
  await removeTransferParts({ blobs, partId: n => artifactPartId(approval.id, n) }, subject.parts.length);
  const record = subject.credentialRecord;
  if (record?.state === 'recorded') await removeTransferParts({ blobs, partId: n => approvedPartId(approval.id, record.sha256, n) }, record.parts.length);
  return { ...approval, exportReview: { ...subject, removedAt: now, removedBecause: because } };
}

const DAY_MS = 24 * 60 * 60 * 1000;
/** When this request last changed state, for retention. A later edit never moves it. */
const decidedAt = (approval: Approval): number => Date.parse(approval.actions.at(-1)?.at ?? approval.createdAt);

/** Remove files past their retention, at most `limit` per call. A request still in
 *  review is never touched. */
export async function sweepApprovalArtifacts(
  store: { listApprovals(): Promise<Approval[]>; putApproval(approval: Approval): Promise<void> }, blobs: BlobStore, policy: ApprovalArtifactPolicy,
  { now = Date.now(), limit = 100 }: { now?: number; limit?: number } = {},
): Promise<number> {
  let removed = 0;
  for (const approval of await store.listApprovals()) {
    if (removed >= limit) break;
    if (!approval.exportReview || approval.exportReview.removedAt) continue;
    const days = approval.state === 'rejected' ? policy.closedRetentionDays : approval.state === 'approved' ? policy.approvedRetentionDays : 0;
    if (days <= 0 || now - decidedAt(approval) < days * DAY_MS) continue;
    await store.putApproval(await removeArtifactBytes(blobs, approval, 'retention', new Date(now).toISOString()));
    removed++;
  }
  return removed;
}
