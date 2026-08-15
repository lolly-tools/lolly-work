# Third-Party Notices

This file lists the third-party components lolly-work distributes and
reproduces their required copyright and permission notices. lolly-work itself
is licensed under **MPL-2.0**; the third-party components below keep their own licenses.
The full machine-readable dependency graph, with per-component registry
hashes, is `sbom.cdx.json` (`npm run sbom`).

Only runtime dependencies appear here — dev tooling (TypeScript, type
packages) is neither distributed nor listed.

## Vendored Lolly OSS packages (MPL-2.0)

### @lolly/engine and @lolly-tools/core

- SPDX-License-Identifier: `MPL-2.0`
- Files: `vendor/@lolly/engine/`, `vendor/@lolly-tools/core/`
- Source: [github.com/lolly-tools/lolly](https://github.com/lolly-tools/lolly)

```text
The Lolly engine and the tool-author core contract are vendored from the
open-source lolly repository as a pinned, UNMODIFIED snapshot. lolly-work is
itself licensed under MPL-2.0, so the whole work — this vendored MPL-covered
engine (kept in its own separate files under vendor/) and the surrounding
control-plane code alike — is available under MPL-2.0. The Covered Software
also remains available under MPL-2.0 from the source repository above.

That the snapshot is consumed unmodified is enforced, not promised:
scripts/verify-engine-pin.ts recomputes the vendored tree's content hashes
against engine-pin.json on every test run and in CI, and fails on any drift.
The pin is only ever regenerated from the OSS repo's pack-engine output.

The full MPL-2.0 text is available at https://mozilla.org/MPL/2.0/ and ships
with the source repository.
```

## npm runtime dependencies

### jsdom 25.0.1

- SPDX-License-Identifier: `MIT`
- Copyright: Copyright (c) 2010 Elijah Insua
- Server-side DOM for the render workers.

```text
Copyright (c) 2010 Elijah Insua

Permission is hereby granted, free of charge, to any person
obtaining a copy of this software and associated documentation
files (the "Software"), to deal in the Software without
restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the
Software is furnished to do so, subject to the following
conditions:

The above copyright notice and this permission notice shall be
included in all copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND,
EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES
OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE AND
NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT
HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER LIABILITY,
WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING
FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR
OTHER DEALINGS IN THE SOFTWARE.
```

jsdom's own transitive dependencies (parse5, whatwg-url, tough-cookie, ws, and
the rest) are MIT/BSD/Apache-2.0-licensed; each appears individually with its
license id in `sbom.cdx.json`.

### @resvg/resvg-js 2.6.2

- SPDX-License-Identifier: `MPL-2.0`
- SVG → PNG rasterizer (Rust resvg, N-API binding) for server-side exports.

```text
@resvg/resvg-js is licensed under the Mozilla Public License, Version 2.0.
lolly-work consumes it unmodified as a separate package; the surrounding
lolly-work code is itself licensed under MPL-2.0. The
full MPL-2.0 text ships with the package
(node_modules/@resvg/resvg-js/LICENSE) and is available at
https://mozilla.org/MPL/2.0/. Source: https://github.com/thx/resvg-js.
```

### pg 8.22.0

- SPDX-License-Identifier: `MIT`
- Copyright: Copyright (c) 2010 - 2021 Brian Carlson
- PostgreSQL client for the control-plane store.

```text
MIT License

Copyright (c) 2010 - 2021 Brian Carlson

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

pg's companion packages (pg-protocol, pg-types, pg-pool, pg-connection-string,
pg-cloudflare, pgpass and their helpers) are MIT-licensed by the same project;
see `sbom.cdx.json` for each.

The engine's own npm dependencies — handlebars (MIT) and ajv (MIT) — are
installed via the vendored packages above and are likewise enumerated in
`sbom.cdx.json`.

## Fonts (self-hosted by the console)

### Outfit (variable)

- SPDX-License-Identifier: `OFL-1.1`
- Files: `console/fonts/Outfit-latin[wght].woff2`, `console/fonts/Outfit-latin-ext[wght].woff2`
- Copyright: Copyright 2021 The Outfit Project Authors (https://github.com/Outfitio/Outfit-Fonts)

```text
Outfit is licensed under the SIL Open Font License, Version 1.1 (OFL-1.1).
The full license ships verbatim beside the fonts at console/fonts/OFL-Outfit.txt
and is not reproduced here to avoid divergence.
```

### SUSE Mono (variable)

- SPDX-License-Identifier: `OFL-1.1`
- Files: `console/fonts/SUSEMono[wght].woff2`
- Copyright: Copyright 2025 The SUSE Project Authors (https://github.com/SUSE/suse-font)

```text
SUSE Mono is licensed under the SIL Open Font License, Version 1.1 (OFL-1.1).
The full license ships verbatim beside the font at
console/fonts/OFL-SUSE-Mono.txt and is not reproduced here to avoid
divergence. "SUSE" is a trademark of SUSE; the OFL grant does not include
trademark rights (see OFL §3-4).
```
