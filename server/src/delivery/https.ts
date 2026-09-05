// SPDX-License-Identifier: MPL-2.0
/** Fixed signed-HTTPS egress for an organization-owned receiving service. */
import { createHmac } from 'node:crypto';
import type { DeliveryInput, DeliveryProvider, DeliveryReceipt } from './types.ts';

export interface HttpsDeliveryOptions {
  /** Exact receiver endpoint. Redirects are refused. */
  url: string;
}

interface HttpsReceipt {
  id?: unknown;
  url?: unknown;
  sha256?: unknown;
}

function endpoint(raw: string | undefined): URL {
  let parsed: URL;
  try { parsed = new URL(raw ?? ''); }
  catch { throw new Error('https delivery options.url must be an HTTPS URL'); }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.hash) {
    throw new Error('https delivery options.url must be an HTTPS URL without embedded credentials or a fragment');
  }
  return parsed;
}

export function httpsDeliveryCanonical(input: DeliveryInput, timestamp: string, encodedName: string): string {
  return [
    'lolly-delivery-v1', timestamp, input.deliveryId, input.format.toLowerCase(), encodedName,
    input.contentType, String(input.bytes.byteLength), input.sha256.toLowerCase(),
  ].join('\n');
}

async function receiptFrom(response: Response, input: DeliveryInput): Promise<DeliveryReceipt> {
  const text = await response.text();
  if (text.length > 64 * 1024) throw new Error('https delivery receipt exceeds 64 KiB');
  if (!text.trim()) return { remoteId: input.deliveryId, transformation: 'unknown' };
  let body: HttpsReceipt;
  try { body = JSON.parse(text) as HttpsReceipt; }
  catch { throw new Error('https delivery receiver returned a non-JSON receipt'); }
  const remoteId = typeof body.id === 'string' && body.id.trim() && body.id.length <= 256
    ? body.id.trim() : input.deliveryId;
  let url: string | undefined;
  if (body.url !== undefined) {
    let parsed: URL | null = null;
    try { parsed = new URL(String(body.url)); } catch { /* refused below */ }
    if (!parsed || !/^https?:$/.test(parsed.protocol)) throw new Error('https delivery receipt url must be http(s)');
    url = parsed.toString();
  }
  let deliveredSha256: string | undefined;
  if (body.sha256 !== undefined) {
    if (typeof body.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(body.sha256)) {
      throw new Error('https delivery receipt sha256 is invalid');
    }
    deliveredSha256 = body.sha256.toLowerCase();
  }
  return {
    remoteId,
    ...(url ? { url } : {}),
    ...(deliveredSha256 ? { deliveredSha256 } : {}),
    transformation: deliveredSha256
      ? (deliveredSha256 === input.sha256.toLowerCase() ? 'none' : 'provider-managed')
      : 'unknown',
  };
}

export function createHttpsDeliveryProvider(
  options: HttpsDeliveryOptions,
  secret: string | undefined,
  fetchImpl: typeof fetch = fetch,
  now: () => number = Date.now,
): DeliveryProvider {
  const url = endpoint(options?.url);
  if (!secret?.trim()) throw new Error('https delivery credential must be a non-empty HMAC secret');
  return {
    kind: 'https',
    async deliver(input) {
      const timestamp = String(now());
      const encodedName = Buffer.from(input.name, 'utf8').toString('base64url');
      const signature = createHmac('sha256', secret)
        .update(httpsDeliveryCanonical(input, timestamp, encodedName))
        .digest('hex');
      const response = await fetchImpl(url, {
        method: 'POST',
        redirect: 'error',
        headers: {
          'content-type': input.contentType,
          'content-length': String(input.bytes.byteLength),
          'x-lolly-delivery-id': input.deliveryId,
          'x-lolly-format': input.format.toLowerCase(),
          'x-lolly-name': encodedName,
          'x-lolly-name-encoding': 'base64url',
          'x-lolly-content-sha256': input.sha256.toLowerCase(),
          'x-lolly-timestamp': timestamp,
          'x-lolly-signature': `v1=${signature}`,
        },
        body: Buffer.from(input.bytes.buffer, input.bytes.byteOffset, input.bytes.byteLength),
      });
      if (!response.ok) throw new Error(`https delivery receiver ${response.status}`);
      return receiptFrom(response, input);
    },
  };
}
