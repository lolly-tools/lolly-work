// SPDX-License-Identifier: MPL-2.0
/** Service credentials only travel to an unambiguous configured endpoint. */
export function serviceUrl(raw: string, requireHttps: boolean): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new Error('Service endpoint must be a HTTPS URL'); }
  if (!raw || raw.trim() !== raw || /[\s\\\u0000-\u001f\u007f]/.test(raw) || url.username || url.password || url.search || url.hash
    || !['http:', 'https:'].includes(url.protocol) || !url.hostname || url.port === '0') throw new Error('Service endpoint must be a HTTPS URL');
  if (url.protocol === 'http:') {
    const explicitLoopback = /^http:\/\/(?:localhost|127\.0\.0\.1|\[::1\])(?::[1-9][0-9]*)?(?:\/|$)/i.test(raw);
    if (requireHttps || !explicitLoopback) throw new Error('Service endpoint requires HTTPS; HTTP is only for explicit loopback evaluation');
  }
  return url.href.replace(/\/$/, '');
}
