# Security headers for the Lolly web shell the server serves at / - the same set
# the open-source app ships on lolly.tools and in its own YunoHost package
# (deploy/yunohost/conf/security-headers.inc in the Lolly repository; the test
# tests/yunohost-package.test.ts compares the two when that checkout is beside
# this one). YunoHost's own baseline (HSTS, X-Frame-Options, a permissive CSP,
# Referrer-Policy same-origin) runs at server level first; for a header both
# set, this file's later directive wins, and the baseline headers it does not
# set stay. See nginx.conf for the whole picture.
#
# Only the shell's location includes this file. The control plane's own routes
# (/api, /admin, /activate, /l, /render, ...) send their own per-route
# Content-Security-Policy, which this file would overwrite; nginx.conf puts the
# upstream's own value back there instead.
more_set_headers "Content-Security-Policy: default-src 'self'; script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'unsafe-inline'; style-src 'self' 'unsafe-inline'; connect-src 'self' blob: data: https://lolli.li https://www.googleapis.com https://fonts.googleapis.com https://fonts.gstatic.com https://api.somafm.com https://registry.color.org https://www.color.org https://geocoding-api.open-meteo.com https://api.dropboxapi.com https://content.dropboxapi.com https://login.microsoftonline.com https://graph.microsoft.com https://api.onedrive.com https://*.up.1drv.com https://*.sharepoint.com; img-src 'self' data: blob:; media-src 'self' blob: data: https://*.somafm.com; font-src 'self' data: blob:; worker-src 'self' blob:; child-src 'self' blob:; frame-src 'self' blob:; object-src 'none'; base-uri 'none'; form-action 'self'; frame-ancestors 'self'";
more_set_headers "Referrer-Policy: no-referrer";
more_set_headers "X-Content-Type-Options: nosniff";
more_set_headers "Cross-Origin-Opener-Policy: same-origin";
more_set_headers "Cross-Origin-Embedder-Policy: credentialless";
more_set_headers "Permissions-Policy: camera=(self), microphone=(self), display-capture=(self), geolocation=()";
