// SPDX-License-Identifier: MPL-2.0
/**
 * Organization-owned outbound delivery. Deliberately separate from catalog
 * providers (remote assets coming IN) and personal send targets (device-owned
 * credentials): a destination is a fixed place the instance is allowed to
 * write, and a delivery is one immutable request to put one Lolly export there.
 */

export const DELIVERY_DESTINATION_KINDS = ['s3', 'webdav', 'https'] as const;
export type DeliveryDestinationKind = (typeof DELIVERY_DESTINATION_KINDS)[number];

export interface ConfigDeliveryDestination {
  id: string;
  kind: DeliveryDestinationKind;
  label: string;
  /** The environment variable holding this destination's write credential. */
  credentialRef: string;
  enabled?: boolean;
  /** Absent or '*' exposes the destination to every otherwise-authorized member. */
  groups?: string[] | '*';
  /** Explicit allowlist; delivery never guesses whether a target accepts a format. */
  formats: string[];
  /** Per-destination ceiling, additionally bounded by delivery.maxBytes. */
  maxBytes?: number;
  /** Optional human review chain. Bytes stage first; provider egress waits for
   *  the terminal approved decision on the immutable delivery record. */
  approvalChain?: string;
  options: Record<string, unknown>;
}

/** The safe, pre-filtered descriptor sent to a connected shell. */
export interface DeliveryDestinationDescriptor {
  id: string;
  kind: DeliveryDestinationKind;
  label: string;
  formats: string[];
  maxBytes: number;
  visibility: 'private' | 'public';
}

export type DeliveryState =
  | 'awaiting-approval'
  | 'queued'
  | 'delivering'
  | 'delivered'
  | 'failed'
  | 'rejected'
  | 'cancelled';

/** Durable history for one immutable export+destination request. */
export interface DeliveryRecord {
  id: string;
  principal: string;
  destinationId: string;
  destinationVersion: string;
  name: string;
  format: string;
  contentType: string;
  size: number;
  sha256: string;
  /** Hash of destination/version + export facts; used to police idempotency-key reuse. */
  requestHash: string;
  /** Private BlobStore reference for retry. Never serialized to a client. */
  sourceRef: string;
  /** Durable automation output this delivery consumes directly. Absent for a
   * manual shell upload. The referenced job cannot be deleted while retained. */
  sourceJobId?: string;
  state: DeliveryState;
  attempt: number;
  approvalId?: string;
  idempotencyKey?: string;
  remoteId?: string;
  url?: string;
  deliveredSha256?: string;
  transformation?: 'none' | 'provider-managed' | 'unknown';
  error?: string;
  createdAt: string;
  updatedAt: string;
  deliveredAt?: string;
}

export interface DeliveryInput {
  deliveryId: string;
  bytes: Uint8Array;
  name: string;
  format: string;
  contentType: string;
  sha256: string;
}

export interface DeliveryReceipt {
  remoteId: string;
  url?: string;
  deliveredSha256?: string;
  transformation: 'none' | 'provider-managed' | 'unknown';
}

/** Server-only adapter. Credentials and provider options never cross this seam. */
export interface DeliveryProvider {
  readonly kind: DeliveryDestinationKind;
  deliver(input: DeliveryInput): Promise<DeliveryReceipt>;
  /** Internal exact-object cleanup; no public delete-by-remote-id API exists. */
  revoke?(remoteId: string): Promise<void>;
}
