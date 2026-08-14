# Catalog and content

The catalog is what members can actually use: tools, brand assets, tokens, fonts, logos. It
comes from two sources — the **pack** on disk, and **providers** that federate external
systems read-only — and both are filtered by the same governance.

![The governed catalog — served assets with lifecycle, expiry and one-click revocation](shots/catalog-assets.svg)

![Federated catalog providers — external sources consumed read-only, credentials sealed](shots/catalog-providers.svg)

## The pack

`instance.pack` points at a directory (a "brand pack"). Everything brand-shaped lives there:

```
catalog/tools/index.json      the tools this deploy offers
catalog/assets/index.json     assets, with a formats list per asset
catalog/fonts/webfonts/       self-hosted woff2
tools/<id>/tool.json          per-tool input definitions
```

Served at `/catalog/*` (blobs) and `/api/v1/catalog/assets/*`, filtered per caller. The
pack's design tokens double as the console's own theme: **This Deploy → Design system**
shows the live tokens the tools consume, and the sign-in screen inherits the pack's colours,
fonts and logo through a deliberately narrow unauthenticated `/api/brand` route — brand
chrome only, never the governed catalog.

A pack is immutable for a process: publish a new pack and restart (or roll) to pick it up.

## Access modes

`policy.defaultAccessMode` decides who may read the catalog at all:

| Mode | Behaviour |
|---|---|
| `open` | anonymous reads allowed |
| `gated` | sign-in required (`401 UNAUTHORIZED`, "this deployment is sign-in gated") |
| `per-tool` | per-resource decision through grants |

On top of that, overlay `visibility` removes individual tools from the feed for groups that
should not see them ([governance](governance.md)).

## Content lifecycle

Every asset can carry a lifecycle row — the "stop sharing" primitive, as one action:

```
GET /api/v1/catalog/lifecycle
PUT /api/v1/catalog/lifecycle/<assetId>     # catalog.expire / catalog.publish
```

| Field | Meaning |
|---|---|
| `validFrom` | not live before this instant |
| `validUntil` | expired at or after this instant |
| `revokedAt` | revoked forever, regardless of the dates |
| `onExpiry` | `hide` (default) or `warn` |

Resolved state is one of `live`, `scheduled`, `expired`, `revoked`; revoked always wins, and
an asset that was never live reads `scheduled` even if its end date has also passed. The
feed drops revoked, scheduled and expired-`hide` entries, and keeps expired-`warn` entries
annotated `expired: true` so a client can nag without a second fetch. The blob route applies
the same state to individual files, so hiding an asset from the feed also stops serving its
bytes.

The console's Catalog view lists every asset the deploy serves with a thumbnail, expiry and
revocation state; a revoked or hidden-on-expiry asset stays listed there — without its
catalog metadata — so it can still be managed.

### Holds

A **hold** is the one governance verb that only ever *preserves* availability — a
permissioned block on making an asset go away. It rides on the same lifecycle row and the
same PUT, but is its own operation:

```
PUT /api/v1/catalog/lifecycle/<assetId>   { "hold": { "note": "legal review" } }   # catalog.hold
PUT /api/v1/catalog/lifecycle/<assetId>   { "hold": null }                          # catalog.hold.release
```

While a hold is set, a revocation — or any edit that would make the asset unavailable *now*
(a `validUntil` in the past, a `validFrom` in the future) — is refused `409 ASSET_HELD`, and
the hold note rides the refusal. Release the hold first; that friction is the point.
Non-removing edits (scheduling a *future* expiry, extending a window) still go through, and a
hold never blocks *serving* — a held asset streams exactly as before. Setting/releasing needs
`catalog.hold` (admin, grant-narrowable per resource; owner not required because a hold can
only ever keep something available) and audits under `catalog.hold` / `catalog.hold.release`.

A hold on a **federated** `ext/*` asset is accepted, but its bytes still live upstream, so the
row reports `pinned: false` honestly: the hold gives feed- and action-level protection now,
and byte durability arrives when materialization (the [exit path](#) — plans/27 §5) lands and
a hold implies a pin. A held pack asset is inherently byte-durable, so it reads `pinned: true`.

### Imported availability windows

A federated asset can also carry an **upstream availability window** — the DAM's own
scheduling/expiry, imported where the provider exposes it (Brandfolder's
`availability_start`/`availability_end`; other kinds via a `mapping.availabilityFields`
custom-field map). The window rides on the feed entry as `availableFrom`/`availableUntil`
and is combined with the local lifecycle row **most-restrictive-wins**: the asset is
`scheduled` if either start is still in the future and `expired` if either end has passed.
So a local admin can *narrow* an upstream window (pull the end earlier, delay the start
later) but never widen it past what the DAM allows — the DAM stays the source of truth for
its own asset. One consequence: **upstream expiry always hides** (it stops the bytes too),
because `onExpiry: 'warn'` only ever softens a *local* expiry, never upstream
unavailability. Providers with no availability API set no window, and the manual
`catalog.expire` arm is the whole story for them.

`GET /api/v1/catalog/assets/<id>` reports the resolved `state` plus a `lifecycle` object
that separates **where each constraint came from** — local `validFrom`/`validUntil`/
`revokedAt` versus the imported `upstream.availableFrom`/`upstream.availableUntil` — so the
console can label a hidden asset "unavailable upstream" distinctly from a locally-expired
one.

## Catalog providers

A provider is an admin-configured, **read-only** connector to a system that stays the source
of truth. Assets federate into the feed namespaced `ext/<providerId>/<remoteId>`, so
lifecycle rows, grants and render-cache invalidation work on them unchanged. Lolly stores
references plus its own governance overlays — deleting a provider never touches remote
content.

Kinds: `brandfolder`, `s3` (hand-rolled SigV4), `git` (raw-HTTP manifest), `dropbox`,
`gdrive`, `o365`/Graph, `optimizely-cmp` (CMP DAM v3, OAuth2), `imagerelay` (v2, OAuth2,
off-boarding source), `acquia-dam` (Widen v2, bearer, native availability), `mock`. No SDKs,
publicly documented endpoints only.

`imagerelay` has no native availability field — it imports expiry from a custom-metadata
field named in `mapping.availabilityFields` (plans/27 §2), the generic path for any DAM that
models expiry as custom metadata. Its role is the exit (federate → materialize → cutover),
and it reports `deleted` files positively (dropped, not inferred-missing).

`optimizely-cmp` federates Optimizely CMP's web DAM **read-only** — a source that stays
(the CMS owns those assets), never one that's exited. It maps CMP's native `expires_at` to
an [availability window](#imported-availability-windows) and uses `is_public` (and
not-`is_archived`) as the approved gate, so `requireApproved` federates only public, live
assets; a folder name or a label can scope an `includeSections` slice. Endpoint and field
names carry a live-verify note in the driver until confirmed against a real tenant.

```bash
lw providers list
lw providers add acme-bf --kind brandfolder --label "Acme Brandfolder" \
  --options '{"brandfolderId":"…"}' \
  --exposure '{"groups":["marketing"],"requireApproved":true,"tier":"reference"}'
lw providers credential acme-bf     # prompts; never argv, never shell history
lw providers auth acme-bf           # OAuth kinds: PKCE loopback consent flow
lw providers sync acme-bf
lw providers health acme-bf
lw providers enable acme-bf         # owner-only
```

Console equivalent: **This Deploy → Providers**.

### Exposure governance

| Field | Effect |
|---|---|
| `groups` | which member groups see these assets (`*`/absent = all members) |
| `requireApproved` | only assets the upstream marks approved |
| `includeSections` | provider-native folder/section scoping |
| `excludeTags` | drop assets carrying these tags |
| `tier` | catalog tier stamped on the entries |

Slice filters (`requireApproved`, `includeSections`, `excludeTags`) apply at
fragment-build time — excluded assets never enter the feed *or* the store. Group visibility
applies per caller at compose time.

### Credentials

Credentials are **write-only**. A stored credential is sealed with AES-256-GCM under
`LW_CREDENTIAL_SECRET`; APIs only ever return a display fingerprint (hash prefix +
last four). Storing one requires the owner-only `catalog.provider.credential`, and so does
the `enable` kill switch — an admin can shape a provider, but only an owner arms it.

Config-managed providers (declared in `instance.json`) are upserted at boot as
`managedBy: 'config'`, name their secret via `credentialRef` (an env var name), and are
read-only in the API: editing one returns `409 CONFIG_MANAGED` — change the file and
redeploy. That is the GitOps/air-gap path.

### Sync and resilience

Request-driven, not a cron: each provider keeps an in-process fragment with a TTL
(`sync.ttlSeconds`, default 300). An expired fragment is served as-is while a background
refresh runs, and the last successful fragment is persisted, so a cold boot or a provider
outage serves something marked stale rather than a 500. Fragment hashes fold into the
catalog version, so a refresh ripples through render-cache invalidation.

`GET /api/v1/catalog/search` fans out live to providers that support server-side search,
through the same exposure gates.

### The exit — materialize a source into your own store

Federation keeps the DAM as the source of truth. When you want to *leave* a DAM (contract
end, off-boarding), **materialize** its assets into the instance's own store and cut the
identity over — the same machinery also powers a hold's implied pin:

```bash
lw providers materialize acme-bf                    # whole provider (or --remote-id / --section)
lw providers cutover acme-bf                         # identities ext/* → inst/*, provider disabled
```

- **Materialize** streams every format's bytes into the [BlobStore](#where-instance-bytes-live),
  checksums them, sniffs each for an embedded [Content Credential](#imported-availability-windows),
  and mints an **instance asset** (`inst/<id>`) that carries a permanent `origin`
  (provider, remoteId, filename, materializedAt) so provenance stays honest long after the
  DAM is gone. It is idempotent per asset and needs `catalog.provider.manage` (admin). While
  the provider is still enabled its federated entry is suppressed in favour of the instance
  copy — no doubles.
- **Cutover** moves the identity to `inst/*`, migrates the lifecycle row (including any hold),
  the credential detection and asset-specific grants, and writes **aliases** so every old
  `/catalog/ext/…` URL — baked into already-rendered SVGs and live sessions — keeps
  resolving. It disables a db-managed provider (owner-only, `catalog.provider.credential`);
  deleting the provider afterwards deletes nothing, because the copies are instance-owned.
- Materialized `inst/*` entries carry a per-format **checksum + size**, so migrated assets
  gain the integrity-verification and offline-pin parity that federated `ext/*` entries
  structurally cannot have while their bytes live upstream.

A **hold** on a federated asset implies a pin: its bytes are materialized so they survive
upstream deletion, the identity stays `ext/*`, and the blob route prefers the local copy.

### Publishing lolly exports out

The reverse motion, for a source you *keep* (Optimizely CMP): push **lolly-generated**
exports into the destination DAM so lolly-made media is usable there and stays attributable
on downstream sites.

```bash
lw providers publish web-cmp --in ./summit-badge.png --name "Summit Badge"
```

Deliberately narrow: the provider must declare the `publish` capability (`optimizely-cmp`
with `options.publish: true`), the action is owner-grantable (`catalog.provider.publish`),
and the bytes must carry lolly's **C2PA export assertion** — verified server-side, so a
federated or pack asset can never be pushed out. Each publish is audited with the export's
provenance chain. Exports arrive in the web DAM already carrying their signed Content
Credential (see [c2pa](c2pa.md)).

### Where instance bytes live

Instance-owned catalog bytes (materialized assets, and later collab staging) live in a
**BlobStore** chosen by `blobs.driver`:

| Driver | When |
|---|---|
| `pg` (default) | zero moving parts — PG works everywhere the plane runs, including a single node |
| `s3` | any S3-compatible store (AWS, MinIO, Ceph RGW) for media-sized estates and the air-gap story — a config flip, not an architecture change |

```jsonc
// instance.json
"blobs": { "driver": "s3", "s3": { "bucket": "lolly-assets", "endpoint": "https://minio.internal:9000", "prefix": "inst" } }
```

The S3 credential is env-only: `LW_BLOBS_S3_CREDENTIAL="<accessKeyId>:<secretAccessKey>"`.
S3 access is hand-rolled SigV4 (signed GET/PUT/DELETE) — no AWS SDK. `inst/*` bytes stream
from `/catalog/inst/<id>/<format>` with an ETag, gated by lifecycle like any asset.

### Third-party terms

Providers are integrations, not replacements. Every deploy brings its own API tokens and
OAuth apps — none ship in this repo — and provider names appear descriptively only. This
project *includes an integration for* those services and is not affiliated with them.

## Related

- **Per-provider setup (admin/owner):** [providers/](providers/) — one guide per platform
  (Brandfolder, S3/MinIO, Optimizely CMP, Image Relay, Acquia/Widen, git, Dropbox, Google Drive, M365).
- Restricting tools and inputs: [governance](governance.md)
- Serving and sharing what the catalog holds: [sharing](sharing.md)
- Where provenance for federated assets comes from: [sharing](sharing.md#provenance) and
  [c2pa](c2pa.md)
