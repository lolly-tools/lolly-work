// SPDX-License-Identifier: MPL-2.0
import { canonicalJson, sha256Hex } from '../lib/crypto.ts';
import { grantDecision, roleAllows, type Grant, type PrincipalCtx } from '../rbac/evaluate.ts';
import type { ConfigDeliveryDestination, DeliveryDestinationDescriptor } from './types.ts';

const DELIVERY_CONTENT_TYPES: Readonly<Record<string, string>> = Object.freeze({
  png: 'image/png',
  apng: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  svg: 'image/svg+xml',
  tiff: 'image/tiff',
  'cmyk-tiff': 'image/tiff',
  webp: 'image/webp',
  avif: 'image/avif',
  pdf: 'application/pdf',
  'pdf-cmyk': 'application/pdf',
  mp4: 'video/mp4',
  webm: 'video/webm',
  mp3: 'audio/mpeg',
  wav: 'audio/wav',
  ogg: 'audio/ogg',
  opus: 'audio/ogg',
  m4a: 'audio/mp4',
  flac: 'audio/flac',
  html: 'text/html; charset=utf-8',
  'html-fragment': 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  md: 'text/markdown; charset=utf-8',
});

/** MIME is derived from the C2PA-verified format, never from a request header. */
export function deliveryContentType(format: string): string {
  return DELIVERY_CONTENT_TYPES[format.toLowerCase()] ?? 'application/octet-stream';
}

export function destinationExposedTo(destination: ConfigDeliveryDestination, groups: readonly string[]): boolean {
  if (destination.enabled !== true) return false;
  if (!destination.groups || destination.groups === '*') return true;
  return destination.groups.some((group) => groups.includes(group));
}

/**
 * One authorization projection for discovery and every write boundary. A
 * destination-specific allow may deliberately extend a group exposure rule
 * (needed for narrowly scoped viewer automation); deny always wins. Without an
 * explicit decision, both group exposure and the role default are required.
 */
export function destinationAvailableTo(
  destination: ConfigDeliveryDestination,
  principal: PrincipalCtx,
  grants: Grant[],
): boolean {
  if (destination.enabled !== true) return false;
  const decision = grantDecision(principal, 'delivery.create', [`destination:${destination.id}`, '*'], grants);
  if (decision === 'deny') return false;
  if (decision === 'allow') return true;
  return destinationExposedTo(destination, principal.groups) && roleAllows(principal.role, 'delivery.create');
}

/** Credential references are intentionally absent: even env-var names are not client data. */
export function destinationDescriptor(destination: ConfigDeliveryDestination, globalMaxBytes: number): DeliveryDestinationDescriptor {
  return {
    id: destination.id,
    kind: destination.kind,
    label: destination.label,
    formats: [...destination.formats],
    maxBytes: Math.min(globalMaxBytes, destination.maxBytes ?? globalMaxBytes),
    visibility: typeof destination.options.publicBaseUrl === 'string' ? 'public' : 'private',
  };
}

/**
 * Bind a delivery to the exact destination semantics it was created under.
 * Credential rotation does not change those semantics, so credentialRef is
 * excluded; endpoint/bucket/prefix and public URL behaviour do move the hash.
 */
export function destinationVersion(destination: ConfigDeliveryDestination): string {
  return sha256Hex(canonicalJson({
    id: destination.id,
    kind: destination.kind,
    label: destination.label,
    groups: destination.groups ?? '*',
    formats: destination.formats,
    maxBytes: destination.maxBytes ?? null,
    approvalChain: destination.approvalChain ?? null,
    options: destination.options,
  })).slice(0, 16);
}
