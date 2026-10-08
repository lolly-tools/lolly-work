// SPDX-License-Identifier: MPL-2.0
const message = 'LOLLY_WEB_BASE must be a HTTPS shell URL with trusted TLS, or HTTP localhost/127.0.0.1/[::1] for local development; credentials, query strings and fragments are not supported';

/** Browser navigation needs a secure context for the shell's Web Crypto calls. */
export function renderWebBase(value: string): string {
  if (!/^https?:\/\//.test(value) || /[\s\\?#]/.test(value)) throw new Error(message);
  let url: URL;
  try { url = new URL(value); } catch { throw new Error(message); }
  if (!url.hostname || url.username || url.password) throw new Error(message);
  // Keep HTTP development explicit, rather than treating a private Service as local.
  if (url.protocol === 'http:' && !/^(localhost|127\.0\.0\.1|\[::1\])(:[0-9]+)?$/.test(value.split('/')[2] ?? '')) {
    throw new Error(message);
  }
  return value.replace(/\/$/, '');
}
