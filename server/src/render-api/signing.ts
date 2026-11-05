// SPDX-License-Identifier: MPL-2.0
/**
 * Two signatures. Result URLs are capability URLs under this module's own secret:
 * clients built for hosted render APIs store them and embed them, so the URL is the
 * credential. That is the opposite of the choice made for job result tokens, and the
 * docs say so. Deleting the record is what revokes a URL.
 *
 * Placid's URL API signature is HMAC-SHA256 of the query string, keyed with the old
 * private token. The vendor's example signs a string beginning with `&`, and its docs
 * do not say whether that leading character is part of the contract, so both forms verify.
 */
import { createHmac, timingSafeEqual } from 'node:crypto';

const DAY_MS = 86_400_000;

const sameText = (a: string, b: string): boolean => {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};

export interface ResultUrlSigner {
  /** The URL for one output, stable while the same period runs. */
  url(baseUrl: string, recordId: string, format: string, finishedAt: string, filename: string | undefined, now?: number): string;
  /** Whether a signature and expiry are good for this output. */
  verify(recordId: string, format: string, expires: string, signature: string, now?: number): 'ok' | 'expired' | 'invalid';
}

export function resultUrlSigner(secret: string, signedDays: number): ResultUrlSigner {
  const sign = (recordId: string, format: string, expires: number): string =>
    createHmac('sha256', secret).update(`render-api-result\n${recordId}\n${format}\n${expires}`).digest('base64url');
  return {
    url(baseUrl, recordId, format, finishedAt, filename, now = Date.now()) {
      // Runs from when the render finished. An owner polling later gets the next period,
      // so someone holding the token can always get a working URL again.
      const period = signedDays * DAY_MS;
      let expires = Date.parse(finishedAt) + period;
      if (expires <= now) expires += Math.ceil((now - expires + 1) / period) * period;
      return `${baseUrl}/compat/files/${encodeURIComponent(recordId)}/${expires}/${sign(recordId, format, expires)}/${encodeURIComponent(fileName(filename, format))}`;
    },
    verify(recordId, format, expires, signature, now = Date.now()) {
      if (!/^\d{1,16}$/.test(expires)) return 'invalid';
      if (!sameText(sign(recordId, format, Number(expires)), signature)) return 'invalid';
      return Number(expires) > now ? 'ok' : 'expired';
    },
  };
}

/** A file name ending in the format's extension, so a client reading the URL sees what it is. */
export function fileName(filename: string | undefined, format: string): string {
  const stem = (filename ?? 'image').replace(/\.[A-Za-z0-9]{1,5}$/, '') || 'image';
  return `${stem}.${format}`;
}

/** The output format a result URL's file name asks for. */
export function formatOfFile(file: string): string | null {
  const match = /\.([a-z0-9]{1,5})$/.exec(file);
  return match ? match[1]! : null;
}

/** Checks Placid's `s` parameter against the raw query string, before any decoding. */
export function placidUrlSignatureValid(rawQuery: string, secret: string): boolean {
  const query = rawQuery.startsWith('?') ? rawQuery.slice(1) : rawQuery;
  const at = query.lastIndexOf('s=');
  // The docs put `s` last. Anything after it would not be covered by the signature.
  if (at < 0 || (at > 0 && query[at - 1] !== '&')) return false;
  const signature = query.slice(at + 2);
  if (!/^[0-9a-fA-F]{64}$/.test(signature)) return false;
  const signed = at > 0 ? query.slice(0, at - 1) : '';
  return [`&${signed}`, signed].some((form) => sameText(createHmac('sha256', secret).update(form).digest('hex'), signature.toLowerCase()));
}
