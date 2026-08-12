# Demo pack

The small, **committed**, static tool pack the hosted testing sandbox
(`deploy/vercel`, lolly.work) serves as its governed catalog. Unlike a real
instance's pack (large brand assets, gitignored under `packs/*`, mounted at
deploy time), this one is curated, tiny, and bundled straight into the Vercel
Function via `vercel.json`'s `includeFiles` — so `GET /render/<tool>.<format>`
and `GET /catalog/*` work with no external mount.

Every tool here is **self-contained** (no external assets) and renders **Tier-A**
(SVG/PNG via the in-process engine + resvg — no Chromium), copied verbatim from
the OSS `community/` tools:

| Tool | What it shows |
|---|---|
| `qr-code` | A real QR to any URL — the canonical "render a tool over a GET" demo |
| `mesh-gradient` | A colourful vector mesh gradient (real `<radialGradient>` stops) |
| `color-palette` | Brand palette swatches |

`catalog/tools/index.json` is the generated listing the catalog + console read.

To refresh from the OSS tree: copy the tool directories from
`../../vendor/lolly/community/<id>/` (drop `i18n/` to stay lean) and regenerate
the index from each `tool.json`.
