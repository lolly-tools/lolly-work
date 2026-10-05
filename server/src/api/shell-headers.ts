/**
 * The security headers the Lolly web shell ships with (plans/58 WP0), sent on every
 * response serveShell makes: index.html and the shell's own assets.
 *
 * Before this, serveShell sent only content-type and cache-control, so a shell served by
 * this server (Compose, Helm, bare metal, the demo) ran with no Content-Security-Policy,
 * no cross-origin isolation and a full Referer on every outbound request, unless an
 * ingress added them. Only the YunoHost package did.
 *
 * This is the same set the open-source app sends on lolly.tools and in its own
 * packages. tests/shell-headers.test.ts pins it to deploy/yunohost/conf/shell-headers.inc,
 * which tests/yunohost-package.test.ts pins in turn to the Lolly repository's copy, so
 * the three cannot drift apart unnoticed. A deployment that needs to reach more hosts
 * adds them through its site policy (plans/58 section 4.3), never by widening this base.
 */
export const SHELL_SECURITY_HEADERS: Readonly<Record<string, string>> = Object.freeze({
  'content-security-policy': "default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data: https://lolli.li https://www.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.somafm.com https://registry.color.org https://www.color.org https://geocoding-api.open-meteo.com https://api.dropboxapi.com https://content.dropboxapi.com https://login.microsoftonline.com https://graph.microsoft.com https://api.onedrive.com https://*.up.1drv.com https://*.files.1drv.com https://my.microsoftpersonalcontent.com https://*.sharepoint.com; img-src 'self' data: blob:; media-src 'self' blob: data: https://*.somafm.com; font-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self' blob: https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com https://www.google.com https://www.figma.com https://wikipedia.org https://*.wikipedia.org https://commons.wikimedia.org https://upload.wikimedia.org https://www.wikidata.org https://www.mediawiki.org https://www.openstreetmap.org; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'",
  'referrer-policy': 'no-referrer',
  'x-content-type-options': 'nosniff',
  'cross-origin-opener-policy': 'same-origin',
  'cross-origin-embedder-policy': 'credentialless',
  'permissions-policy': 'camera=(self), microphone=(self), display-capture=(self), geolocation=()',
});
