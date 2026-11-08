# Demo pack

The small, **committed**, static pack the hosted testing sandbox
(lolly.work) serves as its governed catalog. Unlike a real
instance's pack (large brand assets, gitignored under `packs/*`, mounted at
deploy time), this one is curated and tiny. It rides in the server image
(`deploy/compose/Dockerfile` copies it to `/app/packs/demo`, the default pack of
the Helm chart and the appliance) and is bundled into the optional Vercel Function by
`scripts/build-vercel-fn.mjs`, so `GET /render/<tool>.<format>`,
`GET /catalog/*` and `GET /api/brand` work with no external mount.

## Brand profile: Lolly Demo

The pack is **profile-aware** (plans/29): `catalog` is a symlink to
`brands/lolly-demo/catalog`, and `.lolly-profile` names the active profile.
The brand is **Lolly Demo**, Lolly's own public demo design system, as a curated
slice copied from `brands/lolly-demo` in the Lolly repository: the design tokens
(`lolly/tokens/demo`), the horizontal Lolly wordmark for light and dark
backgrounds (`lolly/logo/horizontal`, `lolly/logo/horizontal-reverse`) and the
SUSE and SUSE Mono variable webfonts that Lolly Demo names, with their OFL texts.
`brands/lolly-demo/NOTICE.md` states the terms of each part. The tokens row is
marked `brandLock: true` here, so the sandbox shows a governed brand. The Vercel
bundler dereferences the symlink (a read-only deploy cannot switch profiles
anyway; the marker keeps the listing honest).

To refresh the brand slice from the Lolly tree: copy
`brands/lolly-demo/catalog/assets/lolly/tokens/demo.json` and the two wordmark
SVGs, copy their three rows from that catalog's `assets/index.json` (keep
`brandLock: true` on the tokens row), and keep `catalog/assets/index.json` down
to the entries whose files actually ship here.

## The connect download

`lolly-demo-brand-1.1.3.lolly` is the Lolly Demo instance pack cut by the Lolly
builder for THIS deployment (`node scripts/build-instance-pack.ts --brand
lolly-demo --instance https://lolly.work`, from the Lolly repository), hosted
from boot via `instance.connectPack` and offered at `/connect/pack.lolly` + the
instance manifest's `connect.packUrl`. It carries Lolly Demo's tokens, its
variable fonts with their OFL texts, six logo slots and 116 catalog assets; no
audio, LUTs, 3D models or photos. It is UNSIGNED (no signing key in the build
environment), which the hosting surfaces label dev-only - a key-pinned app
build will refuse it, a plain one imports it. Rebuild it with the same command
whenever Lolly Demo moves.

## Tools

Every tool here is **self-contained** (no external assets) and renders
**Tier-A** (SVG/PNG via the in-process engine + resvg - no Chromium), copied
from the Lolly `community/` tools:

| Tool | What it shows |
|---|---|
| `qr-code` | A real QR to any URL - the canonical "render a tool over a GET" demo |
| `mesh-gradient` | A colourful vector mesh gradient (real `<radialGradient>` stops) |
| `color-palette` | Brand palette swatches |

`brands/lolly-demo/catalog/tools/index.json` is the generated listing the catalog +
console read. To refresh from the Lolly tree: copy the tool directories from
`../../vendor/lolly/community/<id>/` (drop `i18n/` to stay lean) and
regenerate the index from each `tool.json`.
