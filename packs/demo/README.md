# Demo pack

The small, **committed**, static pack the hosted testing sandbox
(`deploy/vercel`, lolly.work) serves as its governed catalog. Unlike a real
instance's pack (large brand assets, gitignored under `packs/*`, mounted at
deploy time), this one is curated, tiny, and bundled straight into the Vercel
Function via `scripts/build-vercel-fn.mjs` - so `GET /render/<tool>.<format>`,
`GET /catalog/*` and `GET /api/brand` work with no external mount.

## Brand profile: SUSE

The pack is **profile-aware** (plans/29): `catalog` is a symlink to
`brands/suse/catalog`, `.lolly-profile` names the active profile, and the
SUSE brand chrome - design tokens, the horizontal wordmarks (positive green /
negative white), the SUSE variable webfonts - is a curated slice copied from
the OSS repo's `brands/suse` catalog (see `brands/suse/NOTICE.md` for the
asset licence). The Vercel bundler dereferences the symlink (a read-only
deploy cannot switch profiles anyway; the marker keeps the listing honest).

To refresh the brand slice from the OSS tree: copy
`brands/suse/catalog/assets/suse/tokens/brand.json` and the two wordmark SVGs
from `~/Build/lolly`, and keep `catalog/assets/index.json` down to the
entries whose files actually ship here.

## The connect download

`suse-brand-1.0.0.lolly` is the SUSE instance pack cut by the OSS builder for
THIS deployment (`node scripts/build-instance-pack.ts --brand suse
--instance https://lolly.work`), hosted from boot via `instance.connectPack`
and offered at `/connect/pack.lolly` + the instance manifest's
`connect.packUrl`. It is UNSIGNED (no signing key in the build environment),
which the hosting surfaces label dev-only - a key-pinned app build will
refuse it, a plain one imports it. Rebuild it with the same command whenever
the SUSE brand moves.

## Tools

Every tool here is **self-contained** (no external assets) and renders
**Tier-A** (SVG/PNG via the in-process engine + resvg - no Chromium), copied
verbatim from the OSS `community/` tools:

| Tool | What it shows |
|---|---|
| `qr-code` | A real QR to any URL - the canonical "render a tool over a GET" demo |
| `mesh-gradient` | A colourful vector mesh gradient (real `<radialGradient>` stops) |
| `color-palette` | Brand palette swatches |

`brands/suse/catalog/tools/index.json` is the generated listing the catalog +
console read. To refresh from the OSS tree: copy the tool directories from
`../../vendor/lolly/community/<id>/` (drop `i18n/` to stay lean) and
regenerate the index from each `tool.json`.
