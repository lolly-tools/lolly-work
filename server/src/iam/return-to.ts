/**
 * Post-sign-in return targets. A `returnTo` arrives from the query string of a
 * sign-in route and becomes a 302 `location`, so it is an open-redirect vector
 * unless it is held to this instance. Two shapes are allowed: a same-origin
 * absolute path, and an absolute URL whose ORIGIN (scheme + host + port) equals
 * the instance base URL's. Everything else, including the browser-specific
 * spellings that read as protocol-relative (`/\evil`, `\/evil`), a userinfo
 * trick (`https://base@evil`), or a longer host that merely starts with the
 * base (`https://base.evil`), falls back to `/`.
 */
export function safeReturnTo(raw: string | null | undefined, baseUrl: string): string {
  if (!raw) return '/';
  // Control characters and whitespace never belong in a redirect target.
  for (const ch of raw) if (ch.charCodeAt(0) <= 0x20 || ch.charCodeAt(0) === 0x7f) return '/';
  if (raw.startsWith('/')) {
    // A second slash or a backslash in position two is a network-path reference
    // to browsers, whatever the URL parser says.
    if (raw.length > 1 && (raw[1] === '/' || raw[1] === '\\')) return '/';
    return raw;
  }
  let target: URL;
  let base: URL;
  try {
    target = new URL(raw);
    base = new URL(baseUrl);
  } catch {
    return '/';
  }
  if (target.username || target.password) return '/';
  if (target.origin !== base.origin) return '/';
  return `${target.pathname}${target.search}${target.hash}`;
}
