// SPDX-License-Identifier: MPL-2.0
import type { AuditEvent, AuditEventBody } from './chain.ts';
import { privateAuditBody } from './privacy.ts';
import { canonicalJson, deriveKey, hmac, macEquals, sha256Hex } from '../lib/crypto.ts';

export const AUDIT_PROJECTION_FORMAT = 'lolly.audit-projection.v1';
export interface AuditProjection {
  version: 1;
  source: { seq: number; hash: string; prevHash: string };
  body: AuditEventBody;
  projectionDigest: string;
  projectionMac: string;
}

/** Source hashes identify retained rows; the projected body has its own proof. */
export function projectAuditEvent(event: AuditEvent, projectionSecret: string, auditPrivacyKey?: string): AuditProjection {
  const projected = { version: 1 as const, source: { seq: event.seq, hash: event.hash, prevHash: event.prevHash },
    body: privateAuditBody(event, auditPrivacyKey) };
  const projectionDigest = sha256Hex(canonicalJson(projected));
  return { ...projected, projectionDigest, projectionMac: hmac(`lw/siem-projection\n${projectionDigest}`, deriveKey(projectionSecret, 'lw/siem-projection')) };
}

export function verifyAuditProjection(event: AuditProjection, projectionSecret: string): boolean {
  if (event.version !== 1) return false;
  const digest = sha256Hex(canonicalJson({ version: event.version, source: event.source, body: event.body }));
  return digest === event.projectionDigest && macEquals(event.projectionMac, hmac(`lw/siem-projection\n${digest}`, deriveKey(projectionSecret, 'lw/siem-projection')));
}
