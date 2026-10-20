// SPDX-License-Identifier: MPL-2.0
import { readBlobBody } from '../blobs/types.ts';
import { sha256Hex } from '../lib/crypto.ts';
import { damOrigin } from '../catalog/providers/dam-http.ts';
import type { DeliveryInput } from './types.ts';

export function checkedDamInput(input: DeliveryInput): void {
  if (!/^[a-z0-9_-]{1,128}$/i.test(input.deliveryId) || !/^[a-f0-9]{64}$/.test(input.sha256)
    || !/^[a-z0-9][a-z0-9-]{0,31}$/.test(input.format) || !input.bytes.byteLength || sha256Hex(input.bytes) !== input.sha256) throw new Error('DAM delivery input failed verification');
}

export function exactOrigins(value: unknown, label: string): string[] {
  if (!Array.isArray(value) || !value.length || value.length > 16 || value.some(v => typeof v !== 'string')) {
    throw new Error(`${label} needs a non-empty list of exact HTTPS origins`);
  }
  return value.map(v => damOrigin(v, label));
}

/** Only operator-qualified origins; no redirect or upstream URL reaches a receipt. */
export function storageUrl(value: unknown, origins: readonly string[]): string {
  try {
    if (typeof value !== 'string' || /[\s\\]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.hash || !origins.includes(url.origin)) throw new Error();
    return url.toString();
  } catch { throw new Error('DAM storage URL is outside the configured origins'); }
}

export async function verifyDamBytes(response: Response, input: DeliveryInput): Promise<string> {
  if (!response.body) throw new Error('DAM original is not ready; retry this delivery later');
  let bytes: Buffer;
  try { bytes = await readBlobBody(response.body, input.bytes.byteLength + 1); }
  catch { throw new Error('DAM original exceeded the verification limit'); }
  const digest = sha256Hex(bytes);
  if (bytes.byteLength !== input.bytes.byteLength || digest !== input.sha256) throw new Error('DAM original digest mismatch; no byte-preserving receipt was issued');
  return digest;
}

/** Original downloads may redirect between qualified storage origins. Never send API auth. */
export async function readDamOriginal(url: string, origins: readonly string[], input: DeliveryInput, fetchImpl: typeof fetch): Promise<string> {
  let target = storageUrl(url, origins);
  for (let redirects = 0; redirects <= 3; redirects++) {
    let response: Response;
    try { response = await fetchImpl(target, { redirect: 'manual', signal: AbortSignal.timeout(30_000) }); }
    catch { throw new Error('DAM original transport failed'); }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get('location');
      await response.body?.cancel();
      if (!location || redirects === 3) throw new Error('DAM original redirect limit exceeded');
      let next: string;
      try { next = new URL(location, target).toString(); }
      catch { throw new Error('DAM original redirect is invalid'); }
      target = storageUrl(next, origins);
      continue;
    }
    if (!response.ok || response.status === 206) {
      await response.body?.cancel();
      throw new Error(`DAM original request failed (${response.status})`);
    }
    return verifyDamBytes(response, input);
  }
  throw new Error('DAM original redirect limit exceeded');
}
